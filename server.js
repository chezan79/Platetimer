const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const speech = require('@google-cloud/speech');
// Stripe temporaneamente disabilitato - abbonamenti in standby
// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const server = http.createServer(app);

// Configura il WebSocket Server
const wss = new WebSocket.Server({ 
    server,
    path: '/ws' // Percorso per le connessioni WebSocket
});

// Serve i file statici dalla directory "public"
app.use(express.static('public'));

// Middleware per parsing JSON
app.use(express.json());

// Configura Google Cloud Speech
let speechClient = null;
try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
        const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
        speechClient = new speech.SpeechClient({
            projectId: credentials.project_id,
            credentials: credentials
        });
        console.log('✅ Google Cloud Speech configurato correttamente');
    } else {
        console.log('⚠️ Credenziali Google Cloud Speech non trovate');
    }
} catch (error) {
    console.error('❌ Errore configurazione Google Cloud Speech:', error.message);
}

// Configura Agora.io
const agoraAppId = process.env.AGORA_APP_ID || 'demo-app-id';
console.log('📞 Agora App ID configurato:', agoraAppId ? 'Sì' : 'No');

// Store per le chiamate attive
const activeCalls = new Map();

// Endpoint per salvare messaggi vocali
app.post('/api/voice-message', (req, res) => {
    try {
        const { audioData, messageId, destination, from } = req.body;

        if (!audioData || !messageId || !destination) {
            return res.status(400).json({ error: 'Dati mancanti' });
        }

        // Salva temporaneamente i dati audio in memoria
        // In produzione si potrebbe usare un database o storage
        console.log(`🎤 Messaggio vocale ricevuto: ID ${messageId}, Da: ${from}, Per: ${destination}`);

        res.json({ 
            success: true, 
            messageId: messageId,
            destination: destination 
        });

    } catch (error) {
        console.error('❌ Errore salvataggio messaggio vocale:', error);
        res.status(500).json({ error: 'Errore interno server' });
    }
});

// Endpoint Stripe temporaneamente disabilitato - abbonamenti in standby
/*
app.post('/api/create-checkout-session', async (req, res) => {
    // Endpoint disabilitato per test senza abbonamenti
    res.status(503).json({ error: 'Abbonamenti temporaneamente disabilitati' });
});
*/

// Webhook Stripe temporaneamente disabilitato - abbonamenti in standby
/*
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), (req, res) => {
    // Webhook disabilitato per test senza abbonamenti
    res.status(503).json({ error: 'Abbonamenti temporaneamente disabilitati' });
});
*/

// Endpoint per ottenere configurazione Agora
app.get('/api/agora-config', (req, res) => {
    res.json({
        appId: agoraAppId,
        serverUrl: `${req.protocol}://${req.get('host')}`
    });
});

// Endpoint per iniziare una chiamata
app.post('/api/start-call', (req, res) => {
    try {
        const { from, to, callId } = req.body;
        
        if (!from || !to || !callId) {
            return res.status(400).json({ error: 'Dati chiamata mancanti' });
        }

        // Solo la cucina può iniziare chiamate
        if (from !== 'cucina') {
            return res.status(403).json({ error: 'Solo la cucina può iniziare chiamate' });
        }

        // Salva la chiamata attiva
        activeCalls.set(callId, {
            from,
            to,
            startTime: Date.now(),
            status: 'calling'
        });

        console.log(`📞 Chiamata iniziata: ${from} → ${to} (ID: ${callId})`);
        
        res.json({ 
            success: true, 
            callId,
            appId: agoraAppId,
            channel: `call-${callId}`
        });

    } catch (error) {
        console.error('❌ Errore avvio chiamata:', error);
        res.status(500).json({ error: 'Errore interno server' });
    }
});

// Endpoint per terminare una chiamata
app.post('/api/end-call', (req, res) => {
    try {
        const { callId } = req.body;
        
        if (!callId) {
            return res.status(400).json({ error: 'ID chiamata mancante' });
        }

        const call = activeCalls.get(callId);
        if (call) {
            activeCalls.delete(callId);
            console.log(`📞 Chiamata terminata: ID ${callId}`);
        }

        res.json({ success: true });

    } catch (error) {
        console.error('❌ Errore termine chiamata:', error);
        res.status(500).json({ error: 'Errore interno server' });
    }
});

// Endpoint per il riconoscimento vocale
app.post('/api/speech-to-text', async (req, res) => {
    try {
        if (!speechClient) {
            return res.status(500).json({ 
                error: 'Google Cloud Speech non configurato',
                details: 'Controlla le credenziali nei Secrets'
            });
        }

        const { audioData, config = {} } = req.body;

        if (!audioData) {
            return res.status(400).json({ error: 'Audio data richiesto' });
        }

        // Configurazione per il riconoscimento
        const request = {
            audio: {
                content: audioData
            },
            config: {
                encoding: config.encoding || 'WEBM_OPUS',
                sampleRateHertz: config.sampleRateHertz || 48000,
                languageCode: config.languageCode || 'it-IT',
                model: 'command_and_search',
                useEnhanced: true,
                ...config
            }
        };

        // Effettua il riconoscimento
        const [response] = await speechClient.recognize(request);
        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join('\n');

        console.log('🎤 Trascrizione:', transcription);

        res.json({
            transcription: transcription,
            confidence: response.results[0]?.alternatives[0]?.confidence || 0
        });

    } catch (error) {
        console.error('❌ Errore Speech-to-Text:', error);
        res.status(500).json({ 
            error: 'Errore nel riconoscimento vocale',
            details: error.message
        });
    }
});

// Store per le room delle aziende
const companyRooms = new Map();

// Store per i countdown attivi per ogni azienda
const activeCountdowns = new Map();

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
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log(`🔗 Nuova connessione WebSocket da IP: ${clientIp}`);

    ws.companyRoom = null; // Inizialmente non assegnato a nessuna room
    ws.pageType = null; // Tipo di pagina (cucina, pizzeria, insalata)
    ws.lastPing = Date.now();
    ws.lastPong = Date.now();
    ws.isAlive = true;
    ws.clientIp = clientIp;

    // Rate limiting per prevenire spam
    ws.messageCount = 0;
    ws.lastMessageTime = Date.now();

    // Invia un ping iniziale per testare la connessione
    setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
                action: 'connectionConfirmed', 
                timestamp: Date.now(),
                message: 'Connessione WebSocket stabilita con successo'
            }));
            ws.send(JSON.stringify({ action: 'ping', timestamp: Date.now() }));
        }
    }, 500);

    ws.on('message', (message) => {
            try {
                // Validazione messaggio base
                if (!message || message.length === 0) {
                    console.log('⚠️ Messaggio vuoto ignorato');
                    return;
                }

                // Rate limiting più rigoroso: max 5 messaggi per 2 secondi
                const now = Date.now();
                if (now - ws.lastMessageTime < 400) { // 400ms tra messaggi
                    ws.messageCount++;
                    if (ws.messageCount > 5) {
                        console.log('⚠️ Rate limit superato, messaggio scartato');
                        return;
                    }
                } else {
                    ws.messageCount = 0;
                    ws.lastMessageTime = now;
                }

                let data;
                try {
                    data = JSON.parse(message);
                } catch (parseError) {
                    console.error('❌ Errore parsing JSON:', parseError.message);
                    return;
                }

                if (!data || typeof data !== 'object') {
                    console.log('⚠️ Dati messaggio non validi');
                    return;
                }

                console.log('📨 Messaggio ricevuto:', data);

            // Validazione dati rigorosa
            if (!data.action) {
                console.log('⚠️ Messaggio senza action ignorato');
                return;
            }

            // Gestisci ping/pong per heartbeat
            if (data.action === 'ping') {
                ws.lastPing = Date.now();
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ action: 'pong', timestamp: ws.lastPing }));
                }
                return;
            }

            if (data.action === 'pong') {
                // Pong ricevuto, connessione attiva
                ws.lastPong = Date.now();
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

                // Invia tutti i countdown attivi al nuovo client
                if (activeCountdowns.has(companyName)) {
                    const companyCountdowns = activeCountdowns.get(companyName);
                    companyCountdowns.forEach((countdown, tableNumber) => {
                        // Calcola il tempo rimanente attuale
                        const currentTime = Date.now();
                        const elapsed = Math.floor((currentTime - countdown.startTime) / 1000);
                        const remainingTime = Math.max(0, countdown.initialDuration - elapsed);

                        if (remainingTime > 0) {
                            const syncMessage = {
                                action: 'startCountdown',
                                tableNumber: tableNumber,
                                timeRemaining: remainingTime,
                                destination: countdown.destination
                            };
                            ws.send(JSON.stringify(syncMessage));
                            console.log(`📡 Countdown sincronizzato inviato: Tavolo ${tableNumber}, Destinazione: ${countdown.destination}, ${Math.floor(remainingTime/60)}:${(remainingTime%60).toString().padStart(2, '0')}`);
                        } else {
                            // Rimuovi countdown scaduti
                            companyCountdowns.delete(tableNumber);
                        }
                    });
                }

            } else if (data.action === 'joinPage') {
                // Gestisce l'ingresso in una specifica pagina (cucina, pizzeria, insalata)
                if (!data.pageType || typeof data.pageType !== 'string') {
                    console.log('⚠️ Tipo pagina non valido');
                    return;
                }

                const validPageTypes = ['cucina', 'pizzeria', 'insalata'];
                if (!validPageTypes.includes(data.pageType)) {
                    console.log('⚠️ Tipo pagina non supportato');
                    return;
                }

                ws.pageType = data.pageType;

                // Conta quanti utenti sono attualmente sulla stessa pagina
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const samePageClients = Array.from(roomClients).filter(client => 
                        client.pageType === data.pageType && client !== ws
                    );

                    console.log(`📄 Client entrato in pagina ${data.pageType}: ${samePageClients.length} altri utenti già presenti`);

                    // Se ci sono altri utenti sulla stessa pagina, invia un avviso
                    if (samePageClients.length > 0) {
                        const warningMessage = {
                            action: 'pageOccupied',
                            pageType: data.pageType,
                            otherUsersCount: samePageClients.length,
                            message: `⚠️ Attenzione: ${samePageClients.length} altro/i utente/i sta/stanno già utilizzando la pagina ${data.pageType.toUpperCase()}`
                        };

                        ws.send(JSON.stringify(warningMessage));

                        // Informa anche gli altri utenti che qualcuno si è collegato
                        const newUserMessage = {
                            action: 'newUserJoined',
                            pageType: data.pageType,
                            totalUsers: samePageClients.length + 1,
                            message: `👥 Un nuovo utente si è collegato alla pagina ${data.pageType.toUpperCase()} (${samePageClients.length + 1} utenti totali)`
                        };

                        samePageClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify(newUserMessage));
                            }
                        });
                    }
                }

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

                // Validazione destinazione
                const validDestinations = ['cucina', 'pizzeria', 'insalata'];
                const destination = data.destination || 'cucina';
                if (!validDestinations.includes(destination)) {
                    console.log('⚠️ Destinazione non valida');
                    return;
                }

                // Memorizza il countdown attivo
                if (ws.companyRoom) {
                    if (!activeCountdowns.has(ws.companyRoom)) {
                        activeCountdowns.set(ws.companyRoom, new Map());
                    }

                    const companyCountdowns = activeCountdowns.get(ws.companyRoom);
                    companyCountdowns.set(data.tableNumber, {
                        startTime: Date.now(),
                        initialDuration: data.timeRemaining,
                        tableNumber: data.tableNumber,
                        destination: destination
                    });

                    console.log(`💾 Countdown memorizzato per azienda "${ws.companyRoom}": Tavolo ${data.tableNumber}, Destinazione: ${destination}`);
                }

                // Invia solo ai client della stessa room/azienda
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const messageToSend = JSON.stringify({
                        ...data,
                        destination: destination
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(messageToSend);
                            sentCount++;
                        }
                    });

                    console.log(`📡 Countdown inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): Tavolo ${data.tableNumber}, Destinazione: ${destination}, ${Math.floor(data.timeRemaining/60)}:${(data.timeRemaining%60).toString().padStart(2, '0')}`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room');
                }

            } else if (data.action === 'deleteCountdown') {
                // Validazione dati eliminazione
                if (!data.tableNumber) {
                    console.log('⚠️ Numero tavolo mancante per eliminazione');
                    return;
                }

                // Rimuovi il countdown attivo dalla memoria del server
                if (ws.companyRoom && activeCountdowns.has(ws.companyRoom)) {
                    const companyCountdowns = activeCountdowns.get(ws.companyRoom);
                    if (companyCountdowns.has(data.tableNumber)) {
                        companyCountdowns.delete(data.tableNumber);
                        console.log(`🗑️ Countdown rimosso dalla memoria server: Azienda "${ws.companyRoom}", Tavolo ${data.tableNumber}`);
                    }
                }

                // Invia eliminazione a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const deleteMessage = JSON.stringify(data);

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN && client !== ws) { // Non inviare a chi ha eliminato
                            client.send(deleteMessage);
                            sentCount++;
                        }
                    });

                    console.log(`🗑️ Eliminazione inviata alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size-1} client): Tavolo ${data.tableNumber}`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per eliminazione');
                }

            } else if (data.action === 'voiceMessage') {
                // Validazione messaggio vocale
                if (!data.message || typeof data.message !== 'string') {
                    console.log('⚠️ Messaggio vocale non valido');
                    return;
                }

                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio vocale mancante');
                    return;
                }

                // Validazione destinazione
                const validDestinations = ['cucina', 'insalata', 'pizzeria'];
                const destination = data.destination;
                if (!destination || !validDestinations.includes(destination)) {
                    console.log('⚠️ Destinazione messaggio vocale non valida:', destination);
                    return;
                }

                // Invia messaggio vocale solo ai client della destinazione specificata
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const voiceMessage = JSON.stringify({
                        action: 'voiceMessage',
                        message: data.message,
                        messageId: data.messageId,
                        timestamp: new Date().toLocaleTimeString('it-IT'),
                        from: data.from || 'Pizzeria',
                        destination: destination,
                        audioData: data.audioData || null,
                        hasAudio: data.hasAudio || false
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(voiceMessage);
                            sentCount++;
                        }
                    });

                    console.log(`📢 Messaggio vocale inviato alla room "${ws.companyRoom}" per destinazione "${destination}" (${sentCount}/${roomClients.size} client): "${data.message}"`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per messaggio vocale');
                }

            } else if (data.action === 'deleteVoiceMessage') {
                // Validazione eliminazione messaggio vocale
                if (!data.messageId) {
                    console.log('⚠️ ID messaggio vocale mancante per eliminazione');
                    return;
                }

                // Invia eliminazione messaggio vocale a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const deleteMessage = JSON.stringify({
                        action: 'deleteVoiceMessage',
                        messageId: data.messageId
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(deleteMessage);
                            sentCount++;
                        }
                    });

                    console.log(`🗑️ Eliminazione messaggio vocale inviata alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): ID ${data.messageId}`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per eliminazione messaggio vocale');
                }

            } else if (data.action === 'pausaCucina') {
                // Validazione richiesta pausa cucina
                if (!data.durataMinuti || typeof data.durataMinuti !== 'number') {
                    console.log('⚠️ Durata pausa non valida');
                    return;
                }

                if (data.durataMinuti < 1 || data.durataMinuti > 30) {
                    console.log('⚠️ Durata pausa fuori range (1-30 minuti)');
                    return;
                }

                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio pausa mancante');
                    return;
                }

                // Invia messaggio di pausa a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const pausaMessage = JSON.stringify({
                        action: 'pausaCucina',
                        messageId: data.messageId,
                        durataMinuti: data.durataMinuti,
                        from: data.from || 'Pizzeria',
                        timestamp: data.timestamp || new Date().toLocaleTimeString('it-IT')
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(pausaMessage);
                            sentCount++;
                        }
                    });

                    console.log(`⏸️ Messaggio pausa cucina inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): ${data.durataMinuti} minuti`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per pausa cucina');
                }

            } else if (data.action === 'annullaPausaCucina') {
                // Validazione richiesta annullamento pausa cucina
                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio annullamento pausa mancante');
                    return;
                }

                // Invia messaggio di annullamento pausa a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const annullaPausaMessage = JSON.stringify({
                        action: 'annullaPausaCucina',
                        messageId: data.messageId,
                        from: data.from || 'Pizzeria',
                        timestamp: data.timestamp || new Date().toLocaleTimeString('it-IT')
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(annullaPausaMessage);
                            sentCount++;
                        }
                    });

                    console.log(`❌ Messaggio annullamento pausa cucina inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client)`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per annullamento pausa cucina');
                }

            } else if (data.action === 'pausaInsalata') {
                // Validazione richiesta pausa insalata
                if (!data.durataMinuti || typeof data.durataMinuti !== 'number') {
                    console.log('⚠️ Durata pausa insalata non valida');
                    return;
                }

                if (data.durataMinuti < 1 || data.durataMinuti > 30) {
                    console.log('⚠️ Durata pausa insalata fuori range (1-30 minuti)');
                    return;
                }

                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio pausa insalata mancante');
                    return;
                }

                // Invia messaggio di pausa insalata a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const pausaMessage = JSON.stringify({
                        action: 'pausaInsalata',
                        messageId: data.messageId,
                        durataMinuti: data.durataMinuti,
                        from: data.from || 'Insalata',
                        timestamp: data.timestamp || new Date().toLocaleTimeString('it-IT')
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(pausaMessage);
                            sentCount++;
                        }
                    });

                    console.log(`⏸️ Messaggio pausa insalata inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): ${data.durataMinuti} minuti`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per pausa insalata');
                }

            } else if (data.action === 'annullaPausaInsalata') {
                // Validazione richiesta annullamento pausa insalata
                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio annullamento pausa insalata mancante');
                    return;
                }

                // Invia messaggio di annullamento pausa insalata a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const annullaPausaMessage = JSON.stringify({
                        action: 'annullaPausaInsalata',
                        messageId: data.messageId,
                        from: data.from || 'Insalata',
                        timestamp: data.timestamp || new Date().toLocaleTimeString('it-IT')
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(annullaPausaMessage);
                            sentCount++;
                        }
                    });

                    console.log(`❌ Messaggio annullamento pausa insalata inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client)`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per annullamento pausa insalata');
                }

            } else if (data.action === 'startCall') {
                // Gestione chiamata Agora
                if (!data.callId || !data.from || !data.to) {
                    console.log('⚠️ Dati chiamata non validi');
                    return;
                }

                // Solo la cucina può iniziare chiamate
                if (data.from !== 'cucina') {
                    console.log('⚠️ Solo la cucina può iniziare chiamate');
                    return;
                }

                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const callMessage = JSON.stringify({
                        action: 'incomingCall',
                        callId: data.callId,
                        from: data.from,
                        to: data.to,
                        channel: `call-${data.callId}`,
                        appId: agoraAppId
                    });

                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(callMessage);
                        }
                    });

                    console.log(`📞 Chiamata Agora inviata: ${data.from} → ${data.to}`);
                }

            } else if (data.action === 'answerCall' || data.action === 'rejectCall' || data.action === 'endCall') {
                // Gestione risposta/rifiuto/fine chiamata
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const responseMessage = JSON.stringify(data);

                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(responseMessage);
                        }
                    });

                    console.log(`📞 Risposta chiamata: ${data.action} per ID ${data.callId}`);
                }
            }
        }
        } catch (error) {
            console.error('❌ Errore nel parsing del messaggio:', error);
        }
    });

    ws.on('close', (code, reason) => {
            try {
                // Rimuovi il client dalla room quando si disconnette
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const room = companyRooms.get(ws.companyRoom);
                    if (room) {
                        room.delete(ws);
                        if (room.size === 0) {
                            companyRooms.delete(ws.companyRoom);
                            console.log(`🗑️ Room "${ws.companyRoom}" eliminata (vuota)`);
                        } else {
                            console.log(`👋 Client disconnesso dalla room "${ws.companyRoom}" (${room.size} client rimanenti)`);
                        }
                    }
                }

                // Cleanup delle risorse del client
                ws.companyRoom = null;
                ws.pageType = null;
                ws.isAlive = false;

                console.log(`🔌 Connessione WebSocket chiusa - Code: ${code}, Reason: ${reason || 'Non specificato'}`);
            } catch (closeError) {
                console.error('❌ Errore durante cleanup connessione:', closeError.message);
            }
        });

        ws.on('error', (error) => {
            console.error('❌ Errore WebSocket:', error.message || error);

            // Cleanup in caso di errore
            try {
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const room = companyRooms.get(ws.companyRoom);
                    if (room) {
                        room.delete(ws);
                        if (room.size === 0) {
                            companyRooms.delete(ws.companyRoom);
                        }
                    }
                }
                ws.isAlive = false;
            } catch (cleanupError) {
                console.error('❌ Errore cleanup dopo errore WebSocket:', cleanupError.message);
            }
        });
    });

// Heartbeat ottimizzato - meno frequente per ridurre carico
setInterval(() => {
    const now = Date.now();
    let activeClients = 0;

    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            // Solo se non ha fatto pong negli ultimi 45 secondi
            if (now - ws.lastPong > 45000) {
                ws.send(JSON.stringify({ action: 'ping', timestamp: now }));
                ws.lastPing = now;
            }
            activeClients++;
        }
    });

    if (activeClients > 0) {
        console.log(`💓 Heartbeat per ${activeClients} client attivi`);
    }
}, 30000); // Ogni 30 secondi

// Pulizia periodica ottimizzata- più frequente per evitare accumulo
setInterval(() => {
    const now = Date.now();

    // Pulisci connessioni WebSocket morte (nessun pong per più di 60 secondi)
    let deadConnections = 0;
    wss.clients.forEach((ws) => {
        if (now - ws.lastPong > 60000) { // 60 secondi senza pong
            console.log(`🗑️ Connessione morta rilevata, terminazione...`);
            ws.terminate();
            deadConnections++;
        }
    });

    // Pulisci rate limiter scaduti
    for (const [clientId, limit] of rateLimiter.entries()) {
        if (now > limit.resetTime + 120000) { // 2 minuti di grazia
            rateLimiter.delete(clientId);
        }
    }

    // Pulisci countdown scaduti
    let totalActiveCountdowns = 0;
    activeCountdowns.forEach((companyCountdowns, companyName) => {
        companyCountdowns.forEach((countdown, tableNumber) => {
            const elapsed = Math.floor((now - countdown.startTime) / 1000);
            const remainingTime = countdown.initialDuration - elapsed;

            if (remainingTime <= -30) { // 30 secondi dopo la scadenza
                companyCountdowns.delete(tableNumber);
                console.log(`🗑️ Countdown scaduto rimosso: Azienda "${companyName}", Tavolo ${tableNumber}`);
            } else {
                totalActiveCountdowns++;
            }
        });

        if (companyCountdowns.size === 0) {
            activeCountdowns.delete(companyName);
        }
    });

    if (deadConnections > 0 || totalActiveCountdowns > 20) {
        console.log(`🧹 Cleanup: ${deadConnections} conn. morte, ${rateLimiter.size} rate limits, ${totalActiveCountdowns} countdown, ${wss.clients.size} client`);
    }
}, 60000); // Ogni 1 minuto

// Gestione errori globali per prevenire crash
process.on('uncaughtException', (error) => {
    console.error('❌ Errore non gestito:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rifiutata non gestita:', reason);
});

// Monitoraggio carico ogni 5 minuti
setInterval(() => {
    const stats = {
        clients: wss.clients.size,
        rooms: companyRooms.size,
        countdowns: Array.from(activeCountdowns.values()).reduce((sum, map) => sum + map.size, 0),
        rateLimits: rateLimiter.size,
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    };

    console.log(`📊 Stats: ${stats.clients} client, ${stats.rooms} rooms, ${stats.countdowns} countdown, ${stats.memoryUsage}MB RAM`);

    // Alert se troppo carico
    if (stats.clients > 50 || stats.memoryUsage > 100) {
        console.warn(`⚠️ SOVRACCARICO: ${stats.clients} client, ${stats.memoryUsage}MB RAM`);
    }
}, 300000); // Ogni 5 minuti

// Avvia il server
const PORT = 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🛡️ Server sicuro avviato su http://0.0.0.0:${PORT}`);
    console.log('✅ Autenticazione WebSocket attiva');
    console.log('✅ Validazione dati attiva');
    console.log('✅ Rate limiting ottimizzato');
}).on('error', (error) => {
    console.error('❌ Errore avvio server:', error);
});