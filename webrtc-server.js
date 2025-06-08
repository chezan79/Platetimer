
console.log('🚀 Inizializzazione moduli server WebRTC...');

const express = require('express');
const http = require('http');
const WebSocket = require('ws');

console.log('✅ Moduli caricati con successo');
console.log('🚀 Avvio server WebRTC...');

const app = express();
const server = http.createServer(app);

// WebSocket Server per WebRTC signaling
const wss = new WebSocket.Server({ 
    server,
    path: '/webrtc-ws'
});

// Store per le connessioni WebRTC
const webrtcConnections = new Map();
const activeRooms = new Map();

console.log('🎤 Server WebRTC avviato per chiamate vocali');

wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log(`📞 Nuova connessione WebRTC da IP: ${clientIp}`);

    ws.companyRoom = null;
    ws.pageType = null;
    ws.userId = null;
    ws.isAlive = true;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📞 Messaggio WebRTC ricevuto:', data);

            if (data.action === 'join-webrtc-room') {
                // Join room WebRTC
                const { companyName, pageType, userId } = data;
                
                if (!companyName || !pageType || !userId) {
                    console.log('⚠️ Dati join room WebRTC incompleti');
                    return;
                }

                ws.companyRoom = companyName;
                ws.pageType = pageType;
                ws.userId = userId;

                if (!activeRooms.has(companyName)) {
                    activeRooms.set(companyName, new Map());
                }

                const room = activeRooms.get(companyName);
                room.set(userId, { ws, pageType });

                webrtcConnections.set(ws, { companyName, pageType, userId });

                console.log(`✅ WebRTC: ${pageType} entrato in room ${companyName} come ${userId}`);

                // Informa il client del successo
                ws.send(JSON.stringify({
                    action: 'joined-webrtc-room',
                    success: true,
                    companyName,
                    pageType,
                    userId
                }));

            } else if (data.action === 'webrtc-offer') {
                // Offer per avviare chiamata (solo da cucina)
                if (ws.pageType !== 'cucina') {
                    console.log('⚠️ Tentativo di offer da pagina non autorizzata:', ws.pageType);
                    return;
                }

                const { targetPageType, offer, callId } = data;
                
                if (!targetPageType || !offer || !callId) {
                    console.log('⚠️ Dati offer WebRTC incompleti');
                    return;
                }

                // Trova il target nella stessa room
                if (ws.companyRoom && activeRooms.has(ws.companyRoom)) {
                    const room = activeRooms.get(ws.companyRoom);
                    let targetWs = null;

                    // Cerca il primo client del tipo target
                    for (const [userId, client] of room.entries()) {
                        if (client.pageType === targetPageType && client.ws.readyState === WebSocket.OPEN) {
                            targetWs = client.ws;
                            break;
                        }
                    }

                    if (targetWs) {
                        const offerMessage = {
                            action: 'webrtc-offer',
                            offer: offer,
                            callId: callId,
                            from: ws.pageType,
                            fromUserId: ws.userId
                        };

                        targetWs.send(JSON.stringify(offerMessage));
                        console.log(`📞 Offer inviato da ${ws.pageType} a ${targetPageType} per call ${callId}`);
                    } else {
                        // Target non trovato
                        ws.send(JSON.stringify({
                            action: 'webrtc-error',
                            error: `${targetPageType} non disponibile`,
                            callId: callId
                        }));
                        console.log(`❌ Target ${targetPageType} non trovato per call ${callId}`);
                    }
                }

            } else if (data.action === 'webrtc-answer') {
                // Answer per accettare chiamata (solo da pizzeria)
                if (ws.pageType !== 'pizzeria') {
                    console.log('⚠️ Tentativo di answer da pagina non autorizzata:', ws.pageType);
                    return;
                }

                const { answer, callId, targetUserId } = data;
                
                if (!answer || !callId) {
                    console.log('⚠️ Dati answer WebRTC incompleti');
                    return;
                }

                // Trova il chiamante (cucina)
                if (ws.companyRoom && activeRooms.has(ws.companyRoom)) {
                    const room = activeRooms.get(ws.companyRoom);
                    let callerWs = null;

                    for (const [userId, client] of room.entries()) {
                        if (client.pageType === 'cucina' && client.ws.readyState === WebSocket.OPEN) {
                            callerWs = client.ws;
                            break;
                        }
                    }

                    if (callerWs) {
                        const answerMessage = {
                            action: 'webrtc-answer',
                            answer: answer,
                            callId: callId,
                            from: ws.pageType,
                            fromUserId: ws.userId
                        };

                        callerWs.send(JSON.stringify(answerMessage));
                        console.log(`📞 Answer inviato da ${ws.pageType} a cucina per call ${callId}`);
                    }
                }

            } else if (data.action === 'webrtc-ice-candidate') {
                // Scambio ICE candidates
                const { candidate, callId, targetPageType } = data;
                
                if (!candidate || !callId) {
                    console.log('⚠️ Dati ICE candidate incompleti');
                    return;
                }

                // Trova il target
                if (ws.companyRoom && activeRooms.has(ws.companyRoom)) {
                    const room = activeRooms.get(ws.companyRoom);
                    let targetWs = null;

                    if (targetPageType) {
                        // Target specifico
                        for (const [userId, client] of room.entries()) {
                            if (client.pageType === targetPageType && client.ws.readyState === WebSocket.OPEN) {
                                targetWs = client.ws;
                                break;
                            }
                        }
                    }

                    if (targetWs) {
                        const candidateMessage = {
                            action: 'webrtc-ice-candidate',
                            candidate: candidate,
                            callId: callId,
                            from: ws.pageType,
                            fromUserId: ws.userId
                        };

                        targetWs.send(JSON.stringify(candidateMessage));
                        console.log(`🧊 ICE candidate inviato da ${ws.pageType} a ${targetPageType}`);
                    }
                }

            } else if (data.action === 'webrtc-hangup') {
                // Termina chiamata
                const { callId, targetPageType } = data;
                
                console.log(`📞 Hangup ricevuto da ${ws.pageType} per call ${callId}`);

                // Notifica il target
                if (ws.companyRoom && activeRooms.has(ws.companyRoom)) {
                    const room = activeRooms.get(ws.companyRoom);
                    
                    room.forEach((client, userId) => {
                        if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify({
                                action: 'webrtc-hangup',
                                callId: callId,
                                from: ws.pageType
                            }));
                        }
                    });
                }

            } else if (data.action === 'ping') {
                // Heartbeat
                ws.send(JSON.stringify({ action: 'pong', timestamp: Date.now() }));
            }

        } catch (error) {
            console.error('❌ Errore messaggio WebRTC:', error);
        }
    });

    ws.on('close', () => {
        console.log(`📞 Connessione WebRTC chiusa: ${ws.pageType || 'unknown'}`);
        
        // Cleanup
        if (ws.companyRoom && activeRooms.has(ws.companyRoom)) {
            const room = activeRooms.get(ws.companyRoom);
            if (ws.userId) {
                room.delete(ws.userId);
            }
            
            if (room.size === 0) {
                activeRooms.delete(ws.companyRoom);
                console.log(`🗑️ Room WebRTC "${ws.companyRoom}" eliminata (vuota)`);
            }
        }

        webrtcConnections.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('❌ Errore WebSocket WebRTC:', error);
    });
});

// Heartbeat per connessioni WebRTC
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'ping', timestamp: Date.now() }));
        }
    });
}, 30000);

// Statistiche WebRTC
setInterval(() => {
    const stats = {
        connections: wss.clients.size,
        rooms: activeRooms.size,
        totalUsers: Array.from(activeRooms.values()).reduce((sum, room) => sum + room.size, 0)
    };
    
    if (stats.connections > 0) {
        console.log(`📊 WebRTC Stats: ${stats.connections} conn, ${stats.rooms} rooms, ${stats.totalUsers} users`);
    }
}, 300000); // Ogni 5 minuti

// Avvia server WebRTC su porta 5001
const WEBRTC_PORT = 5001;

console.log(`📞 Tentativo di avvio server WebRTC su porta ${WEBRTC_PORT}...`);

server.listen(WEBRTC_PORT, '0.0.0.0', () => {
    console.log(`📞 🎤 Server WebRTC avviato con successo su http://0.0.0.0:${WEBRTC_PORT}`);
    console.log('✅ WebRTC signaling attivo per chiamate vocali');
    console.log('🍳 Cucina: può effettuare chiamate');
    console.log('🍕 Pizzeria: può solo ricevere chiamate');
    console.log(`📊 WebSocket Server WebRTC in ascolto su percorso: /webrtc-ws`);
}).on('error', (error) => {
    console.error('❌ ERRORE CRITICO avvio server WebRTC:', error);
    console.error('📍 Porta:', WEBRTC_PORT);
    console.error('📍 Indirizzo:', '0.0.0.0');
    console.error('📍 Stack trace:', error.stack);
    process.exit(1);
});
