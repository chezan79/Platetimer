const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const speech = require('@google-cloud/speech');

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

            // Gestisci ping/pong per heartbeat
            if (data.action === 'ping') {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ action: 'pong' }));
                }
                return;
            }
            
            if (data.action === 'pong') {
                // Pong ricevuto, connessione attiva
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

                // Invia messaggio vocale a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const voiceMessage = JSON.stringify({
                        action: 'voiceMessage',
                        message: data.message,
                        messageId: data.messageId,
                        timestamp: new Date().toLocaleTimeString('it-IT'),
                        from: data.from || 'Pizzeria'
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(voiceMessage);
                            sentCount++;
                        }
                    });

                    console.log(`📢 Messaggio vocale inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): "${data.message}"`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per messaggio vocale');
                }

            } else if (data.action === 'audioMessage') {
                // Validazione messaggio audio
                if (!data.audioData || typeof data.audioData !== 'string') {
                    console.log('⚠️ Dati audio non validi');
                    return;
                }

                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio audio mancante');
                    return;
                }

                // Validazione dimensione audio (max 10MB in base64)
                if (data.audioData.length > 13333333) { // ~10MB in base64
                    console.log('⚠️ Messaggio audio troppo grande');
                    return;
                }

                // Validazione destinazione
                const validDestinations = ['cucina', 'pizzeria', 'insalata', 'all'];
                const destination = data.destination || 'all';
                if (!validDestinations.includes(destination)) {
                    console.log('⚠️ Destinazione audio non valida:', destination);
                    return;
                }

                // Invia messaggio audio a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const audioMessage = JSON.stringify({
                        action: 'audioMessage',
                        audioData: data.audioData,
                        mimeType: data.mimeType || 'audio/webm;codecs=opus',
                        messageId: data.messageId,
                        timestamp: data.timestamp || new Date().toLocaleTimeString('it-IT'),
                        from: data.from || 'Sconosciuto',
                        destination: destination // Includi la destinazione nel messaggio
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(audioMessage);
                            sentCount++;
                        }
                    });

                    const destinationText = destination === 'all' ? 'Tutti' : destination.charAt(0).toUpperCase() + destination.slice(1);
                    console.log(`🔊 Messaggio audio inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): ID ${data.messageId}, Da: ${data.from}, Destinazione: ${destinationText}, Dimensione: ${Math.round(data.audioData.length / 1024)}KB`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per messaggio audio');
                }

            } else if (data.action === 'deleteVoiceMessage' || data.action === 'deleteAudioMessage') {
                // Validazione eliminazione messaggio vocale/audio
                if (!data.messageId) {
                    console.log('⚠️ ID messaggio mancante per eliminazione');
                    return;
                }

                // Invia eliminazione messaggio a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const deleteMessage = JSON.stringify({
                        action: data.action, // Mantieni l'azione originale
                        messageId: data.messageId
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(deleteMessage);
                            sentCount++;
                        }
                    });

                    console.log(`🗑️ Eliminazione messaggio inviata alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): ID ${data.messageId}`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per eliminazione messaggio');
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

    // Pulisci countdown scaduti
    let totalActiveCountdowns = 0;
    activeCountdowns.forEach((companyCountdowns, companyName) => {
        companyCountdowns.forEach((countdown, tableNumber) => {
            const elapsed = Math.floor((now - countdown.startTime) / 1000);
            const remainingTime = countdown.initialDuration - elapsed;
            
            if (remainingTime <= -45) { // 45 secondi dopo la scadenza
                companyCountdowns.delete(tableNumber);
                console.log(`🗑️ Countdown scaduto rimosso: Azienda "${companyName}", Tavolo ${tableNumber}`);
            } else {
                totalActiveCountdowns++;
            }
        });
        
        // Rimuovi aziende senza countdown attivi
        if (companyCountdowns.size === 0) {
            activeCountdowns.delete(companyName);
        }
    });

    console.log(`🧹 Risorse pulite - Rate limiter: ${rateLimiter.size}, Rooms: ${companyRooms.size}, Countdown attivi: ${totalActiveCountdowns}`);
}, 300000); // Ogni 5 minuti

// Gestione errori globali per prevenire crash
process.on('uncaughtException', (error) => {
    console.error('❌ Errore non gestito:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rifiutata non gestita:', reason);
});

// Avvia il server
const PORT = 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🛡️ Server sicuro avviato su http://0.0.0.0:${PORT}`);
    console.log('✅ Autenticazione WebSocket attiva');
    console.log('✅ Validazione dati attiva');
    console.log('✅ Rate limiting attivo');
}).on('error', (error) => {
    console.error('❌ Errore avvio server:', error);
});