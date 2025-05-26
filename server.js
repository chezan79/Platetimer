const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Configura il WebSocket Server
const wss = new WebSocket.Server({ 
    server,
    path: '/ws' // Percorso per le connessioni WebSocket
});

// Serve i file statici dalla directory "public"
app.use(express.static('public'));

// Mappa per tenere traccia delle connessioni per azienda
const companyRooms = new Map();

// Mappa per sessioni autenticate
const authenticatedSessions = new Map();

// Rate limiting per prevenire spam
const rateLimiter = new Map();

// Funzione per validare il nome dell'azienda
function isValidCompanyName(companyName) {
    if (!companyName || typeof companyName !== 'string') return false;
    if (companyName.length < 2 || companyName.length > 50) return false;
    // Solo caratteri alfanumerici, spazi e alcuni caratteri speciali
    return /^[a-zA-Z0-9\s\-_àáâãäåçèéêëìíîïðñòóôõöùúûüýÿ]+$/i.test(companyName);
}

// Funzione per validare il numero del tavolo
function isValidTableNumber(tableNumber) {
    const num = parseInt(tableNumber);
    return !isNaN(num) && num > 0 && num <= 999;
}

// Funzione per validare il tempo
function isValidTime(timeRemaining) {
    const time = parseInt(timeRemaining);
    return !isNaN(time) && time > 0 && time <= 7200; // Max 2 ore
}

// Funzione per il rate limiting
function checkRateLimit(clientId) {
    const now = Date.now();
    const limit = rateLimiter.get(clientId) || { count: 0, resetTime: now + 60000 };
    
    if (now > limit.resetTime) {
        limit.count = 1;
        limit.resetTime = now + 60000;
    } else {
        limit.count++;
    }
    
    rateLimiter.set(clientId, limit);
    return limit.count <= 10; // Max 10 richieste per minuto
}

// Gestisci le connessioni WebSocket
wss.on('connection', (ws, req) => {
    console.log('Nuova connessione WebSocket');
    
    // Genera un ID unico per questa connessione
    ws.clientId = crypto.randomUUID();
    ws.isAuthenticated = false;
    ws.connectionTime = Date.now();
    
    // Timeout per l'autenticazione (30 secondi)
    const authTimeout = setTimeout(() => {
        if (!ws.isAuthenticated) {
            console.log('Timeout autenticazione per client:', ws.clientId);
            ws.close(1008, 'Authentication timeout');
        }
    }, 30000);

    // Quando un messaggio viene ricevuto
    ws.on('message', (message) => {
        try {
            // Check rate limiting
            if (!checkRateLimit(ws.clientId)) {
                ws.send(JSON.stringify({
                    error: 'Rate limit exceeded',
                    code: 'RATE_LIMIT'
                }));
                return;
            }

            const messageStr = message.toString();
            console.log('Messaggio ricevuto da:', ws.clientId, messageStr);

            // Limita la dimensione del messaggio
            if (messageStr.length > 1000) {
                ws.send(JSON.stringify({
                    error: 'Message too large',
                    code: 'MESSAGE_TOO_LARGE'
                }));
                return;
            }

            const data = JSON.parse(messageStr);

            // Valida la struttura del messaggio
            if (!data.action || typeof data.action !== 'string') {
                ws.send(JSON.stringify({
                    error: 'Invalid message format',
                    code: 'INVALID_FORMAT'
                }));
                return;
            }

            // Se è un messaggio di registrazione alla room
            if (data.action === 'joinRoom') {
                clearTimeout(authTimeout);
                
                const companyName = data.companyName;
                
                // Valida il nome dell'azienda
                if (!isValidCompanyName(companyName)) {
                    ws.send(JSON.stringify({
                        error: 'Invalid company name',
                        code: 'INVALID_COMPANY'
                    }));
                    return;
                }

                ws.companyName = companyName.trim();
                ws.isAuthenticated = true;

                // Aggiungi il client alla room dell'azienda
                if (!companyRooms.has(ws.companyName)) {
                    companyRooms.set(ws.companyName, new Set());
                }
                companyRooms.get(ws.companyName).add(ws);

                // Conferma l'autenticazione
                ws.send(JSON.stringify({
                    action: 'authenticated',
                    companyName: ws.companyName,
                    clientId: ws.clientId
                }));

                console.log(`Client ${ws.clientId} unito alla room: ${ws.companyName}`);
                return;
            }

            // Verifica che il client sia autenticato per altre azioni
            if (!ws.isAuthenticated) {
                ws.send(JSON.stringify({
                    error: 'Not authenticated',
                    code: 'NOT_AUTHENTICATED'
                }));
                return;
            }

            // Se è un countdown, valida e invia solo ai client della stessa azienda
            if (data.action === 'startCountdown') {
                // Valida i dati del countdown
                if (!isValidTableNumber(data.tableNumber)) {
                    ws.send(JSON.stringify({
                        error: 'Invalid table number',
                        code: 'INVALID_TABLE'
                    }));
                    return;
                }

                if (!isValidTime(data.timeRemaining)) {
                    ws.send(JSON.stringify({
                        error: 'Invalid time value',
                        code: 'INVALID_TIME'
                    }));
                    return;
                }

                // Crea un messaggio sicuro
                const safeMessage = {
                    action: 'startCountdown',
                    tableNumber: parseInt(data.tableNumber),
                    timeRemaining: parseInt(data.timeRemaining),
                    timestamp: Date.now()
                };

                const companyClients = companyRooms.get(ws.companyName);
                if (companyClients) {
                    const messageStr = JSON.stringify(safeMessage);
                    companyClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(messageStr);
                        }
                    });
                }
                console.log(`Countdown sicuro inviato alla room: ${ws.companyName}`);
            }

        } catch (error) {
            console.error('Errore nel parsing del messaggio:', error);
            ws.send(JSON.stringify({
                error: 'Invalid JSON',
                code: 'INVALID_JSON'
            }));
        }
    });

    // Rimuovi il client quando si disconnette
    ws.on('close', () => {
        if (ws.companyName && companyRooms.has(ws.companyName)) {
            const companyClients = companyRooms.get(ws.companyName);
            if (companyClients) {
                companyClients.delete(ws);
                if (companyClients.size === 0) {
                    companyRooms.delete(ws.companyName);
                }
            }
            console.log(`Client ${ws.clientId} rimosso dalla room: ${ws.companyName}`);
        }
        
        // Pulisci i dati del rate limiting
        rateLimiter.delete(ws.clientId);
    });

    // Gestisci errori WebSocket
    ws.on('error', (error) => {
        console.error('Errore WebSocket per client', ws.clientId, ':', error);
    });
});

// Pulizia periodica delle risorse
setInterval(() => {
    const now = Date.now();
    
    // Pulisci rate limiter scaduti
    for (const [clientId, limit] of rateLimiter.entries()) {
        if (now > limit.resetTime + 300000) { // 5 minuti di grazia
            rateLimiter.delete(clientId);
        }
    }
    
    console.log(`Risorse pulite - Rate limiter: ${rateLimiter.size}, Rooms: ${companyRooms.size}`);
}, 300000); // Ogni 5 minuti

// Avvia il server
const PORT = 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🛡️ Server sicuro avviato su http://0.0.0.0:${PORT}`);
    console.log('✅ Autenticazione WebSocket attiva');
    console.log('✅ Validazione dati attiva');
    console.log('✅ Rate limiting attivo');
});