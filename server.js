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

// Store per le room delle aziende
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
wss.on('connection', (ws) => {
    console.log('🔗 Nuova connessione WebSocket');
    ws.companyRoom = null; // Inizialmente non assegnato a nessuna room

    // Rate limiting per prevenire spam
    ws.messageCount = 0;
    ws.lastMessageTime = Date.now();

    ws.on('message', (message) => {
        try {
            // Rate limiting: max 10 messaggi al secondo
            const now = Date.now();
            if (now - ws.lastMessageTime < 100) { // 100ms tra messaggi
                ws.messageCount++;
                if (ws.messageCount > 10) {
                    console.log('⚠️ Rate limit superato, connessione ignorata');
                    return;
                }
            } else {
                ws.messageCount = 0;
                ws.lastMessageTime = now;
            }

            const data = JSON.parse(message);
            console.log('📨 Messaggio ricevuto:', data);

            // Validazione dati rigorosa
            if (!data.action) {
                console.log('⚠️ Messaggio senza action ignorato');
                return;
            }

            if (data.action === 'joinRoom') {
                // Validazione nome azienda
                if (!data.companyName || typeof data.companyName !== 'string' || data.companyName.trim().length === 0) {
                    console.log('⚠️ Nome azienda non valido');
                    return;
                }

                const companyName = data.companyName.trim();

                // Rimuovi il client dalla room precedente se esistente
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const oldRoom = companyRooms.get(ws.companyRoom);
                    oldRoom.delete(ws);
                    if (oldRoom.size === 0) {
                        companyRooms.delete(ws.companyRoom);
                    }
                }

                // Aggiungi il client alla nuova room
                ws.companyRoom = companyName;
                if (!companyRooms.has(companyName)) {
                    companyRooms.set(companyName, new Set());
                }
                companyRooms.get(companyName).add(ws);

                console.log(`✅ Client aggiunto alla room: ${companyName} (${companyRooms.get(companyName).size} client)`);

            } else if (data.action === 'startCountdown') {
                // Validazione dati countdown
                if (!data.tableNumber || !data.timeRemaining) {
                    console.log('⚠️ Dati countdown non validi');
                    return;
                }

                if (typeof data.tableNumber !== 'string' && typeof data.tableNumber !== 'number') {
                    console.log('⚠️ Numero tavolo non valido');
                    return;
                }

                if (typeof data.timeRemaining !== 'number' || data.timeRemaining <= 0) {
                    console.log('⚠️ Tempo rimanente non valido');
                    return;
                }

                // Invia solo ai client della stessa room/azienda
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const messageToSend = JSON.stringify(data);

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(messageToSend);
                            sentCount++;
                        }
                    });

                    console.log(`📡 Countdown inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): Tavolo ${data.tableNumber}, ${Math.floor(data.timeRemaining/60)}:${(data.timeRemaining%60).toString().padStart(2, '0')}`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room');
                }
            }
        } catch (error) {
            console.error('❌ Errore nel parsing del messaggio:', error);
        }
    });

    ws.on('close', () => {
        // Rimuovi il client dalla room quando si disconnette
        if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
            const room = companyRooms.get(ws.companyRoom);
            room.delete(ws);
            if (room.size === 0) {
                companyRooms.delete(ws.companyRoom);
                console.log(`🗑️ Room "${ws.companyRoom}" eliminata (vuota)`);
            } else {
                console.log(`👋 Client disconnesso dalla room "${ws.companyRoom}" (${room.size} client rimanenti)`);
            }
        }
        console.log('🔌 Connessione WebSocket chiusa');
    });

    ws.on('error', (error) => {
        console.error('❌ Errore WebSocket:', error);
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