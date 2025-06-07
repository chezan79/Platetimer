
const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);

// WebSocket Server dedicato per le chiamate vocali
const voiceWss = new WebSocket.Server({ 
    server,
    path: '/voice-ws'
});

// Store per le chiamate attive
const activeCalls = new Map();
const voiceClients = new Map();

console.log('🎤 Voice Server avviato - Porta 5001');

voiceWss.on('connection', (ws, req) => {
    const clientId = Date.now() + Math.random();
    console.log(`🎤 Nuova connessione voice: ${clientId}`);
    
    ws.clientId = clientId;
    ws.companyRoom = null;
    ws.pageType = null;
    ws.isAlive = true;
    
    voiceClients.set(clientId, ws);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`🎤 Voice message da ${clientId}:`, data.action);

            if (data.action === 'joinVoiceRoom') {
                ws.companyRoom = data.companyName;
                ws.pageType = data.pageType;
                console.log(`🎤 Client ${clientId} entrato in voice room: ${data.companyName}/${data.pageType}`);

            } else if (data.action === 'startCall') {
                const callId = data.callId;
                activeCalls.set(callId, {
                    id: callId,
                    caller: clientId,
                    target: data.targetPage,
                    company: ws.companyRoom,
                    startTime: Date.now(),
                    status: 'ringing'
                });

                // Invia chiamata ai target nella stessa company
                voiceClients.forEach((client, id) => {
                    if (client.readyState === WebSocket.OPEN && 
                        client.companyRoom === ws.companyRoom && 
                        client.pageType === data.targetPage &&
                        id !== clientId) {
                        
                        client.send(JSON.stringify({
                            action: 'incomingCall',
                            callId: callId,
                            from: ws.pageType,
                            timestamp: Date.now()
                        }));
                    }
                });

                console.log(`📞 Chiamata ${callId} avviata da ${ws.pageType} a ${data.targetPage}`);

            } else if (data.action === 'acceptCall') {
                const call = activeCalls.get(data.callId);
                if (call) {
                    call.status = 'active';
                    call.acceptedBy = clientId;
                    call.acceptTime = Date.now();

                    // Notifica tutti i partecipanti
                    [call.caller, call.acceptedBy].forEach(participantId => {
                        const client = voiceClients.get(participantId);
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                action: 'callAccepted',
                                callId: data.callId,
                                participants: [call.caller, call.acceptedBy]
                            }));
                        }
                    });

                    console.log(`✅ Chiamata ${data.callId} accettata`);
                }

            } else if (data.action === 'rejectCall') {
                const call = activeCalls.get(data.callId);
                if (call) {
                    const caller = voiceClients.get(call.caller);
                    if (caller && caller.readyState === WebSocket.OPEN) {
                        caller.send(JSON.stringify({
                            action: 'callRejected',
                            callId: data.callId
                        }));
                    }
                    activeCalls.delete(data.callId);
                    console.log(`❌ Chiamata ${data.callId} rifiutata`);
                }

            } else if (data.action === 'endCall') {
                const call = activeCalls.get(data.callId);
                if (call) {
                    // Notifica tutti i partecipanti
                    [call.caller, call.acceptedBy].forEach(participantId => {
                        if (participantId) {
                            const client = voiceClients.get(participantId);
                            if (client && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    action: 'callEnded',
                                    callId: data.callId
                                }));
                            }
                        }
                    });
                    activeCalls.delete(data.callId);
                    console.log(`📞 Chiamata ${data.callId} terminata`);
                }

            } else if (data.action === 'callAudio') {
                const call = activeCalls.get(data.callId);
                if (call && call.status === 'active') {
                    // Inoltra l'audio all'altro partecipante
                    const otherParticipant = call.caller === clientId ? call.acceptedBy : call.caller;
                    const otherClient = voiceClients.get(otherParticipant);
                    
                    if (otherClient && otherClient.readyState === WebSocket.OPEN) {
                        otherClient.send(JSON.stringify({
                            action: 'callAudio',
                            callId: data.callId,
                            audioData: data.audioData
                        }));
                    }
                }

            } else if (data.action === 'ping') {
                ws.send(JSON.stringify({ action: 'pong', timestamp: Date.now() }));
            }

        } catch (error) {
            console.error('❌ Errore voice message:', error);
        }
    });

    ws.on('close', () => {
        voiceClients.delete(clientId);
        console.log(`🎤 Voice client ${clientId} disconnesso`);
    });

    ws.on('error', (error) => {
        console.error(`❌ Errore voice client ${clientId}:`, error);
        voiceClients.delete(clientId);
    });
});

// Heartbeat per voice server
setInterval(() => {
    voiceClients.forEach((ws, clientId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'ping', timestamp: Date.now() }));
        } else {
            voiceClients.delete(clientId);
        }
    });
}, 30000);

// Cleanup chiamate scadute
setInterval(() => {
    const now = Date.now();
    activeCalls.forEach((call, callId) => {
        if (call.status === 'ringing' && (now - call.startTime) > 30000) {
            console.log(`🗑️ Chiamata ${callId} scaduta (timeout)`);
            activeCalls.delete(callId);
        }
    });
}, 10000);

const PORT = 5001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎤 Voice Server avviato su porta ${PORT}`);
});
