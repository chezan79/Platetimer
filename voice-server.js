
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// WebSocket Server dedicato solo per chiamate vocali
const wss = new WebSocket.Server({ 
    server,
    path: '/voice-ws'
});

// Store per le chiamate attive
const activeCalls = new Map();
const callParticipants = new Map();

// Rate limiting specifico per audio
const audioRateLimiter = new Map();

console.log('🎤 Voice Server avviato - gestisce solo chiamate vocali');

wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log(`🔗 Nuova connessione Voice WebSocket da IP: ${clientIp}`);

    ws.companyRoom = null;
    ws.pageType = null;
    ws.isAlive = true;
    ws.clientIp = clientIp;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const now = Date.now();

            // Rate limiting per audio (max 10 al minuto)
            const audioLimit = audioRateLimiter.get(ws.clientIp) || { count: 0, resetTime: now + 60000 };
            if (now > audioLimit.resetTime) {
                audioLimit.count = 1;
                audioLimit.resetTime = now + 60000;
            } else {
                audioLimit.count++;
            }
            audioRateLimiter.set(ws.clientIp, audioLimit);
            
            if (audioLimit.count > 10) {
                console.log('⚠️ Rate limit audio voice server superato');
                return;
            }

            if (data.action === 'joinVoiceRoom') {
                ws.companyRoom = data.companyName;
                ws.pageType = data.pageType;
                console.log(`🎤 Client voice connesso: ${data.companyName} - ${data.pageType}`);
            } else if (data.action === 'startCall') {
                handleStartCall(ws, data);
            } else if (data.action === 'acceptCall') {
                handleAcceptCall(ws, data);
            } else if (data.action === 'rejectCall') {
                handleRejectCall(ws, data);
            } else if (data.action === 'endCall') {
                handleEndCall(ws, data);
            } else if (data.action === 'callAudio') {
                handleCallAudio(ws, data);
            }
        } catch (error) {
            console.error('❌ Errore Voice Server:', error);
        }
    });

    ws.on('close', () => {
        console.log('🔌 Voice WebSocket disconnesso');
        // Cleanup chiamate attive
        cleanupUserCalls(ws);
    });

    ws.on('error', (error) => {
        console.error('❌ Errore Voice WebSocket:', error);
        cleanupUserCalls(ws);
    });
});

function handleStartCall(ws, data) {
    const callId = data.callId;
    activeCalls.set(callId, {
        id: callId,
        from: ws,
        targetPage: data.targetPage,
        startTime: Date.now()
    });

    // Trova destinatari
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && 
            client.companyRoom === ws.companyRoom && 
            client.pageType === data.targetPage && 
            client !== ws) {
            
            client.send(JSON.stringify({
                action: 'incomingCall',
                callId: callId,
                from: ws.pageType,
                targetPage: data.targetPage
            }));
        }
    });

    console.log(`📞 Voice Server: Chiamata ${callId} da ${ws.pageType} a ${data.targetPage}`);
}

function handleAcceptCall(ws, data) {
    const call = activeCalls.get(data.callId);
    if (call) {
        callParticipants.set(data.callId, [call.from, ws]);
        
        // Notifica entrambi i partecipanti
        [call.from, ws].forEach(participant => {
            if (participant.readyState === WebSocket.OPEN) {
                participant.send(JSON.stringify({
                    action: 'callAccepted',
                    callId: data.callId
                }));
            }
        });
        
        console.log(`✅ Voice Server: Chiamata ${data.callId} accettata`);
    }
}

function handleRejectCall(ws, data) {
    const call = activeCalls.get(data.callId);
    if (call && call.from.readyState === WebSocket.OPEN) {
        call.from.send(JSON.stringify({
            action: 'callRejected',
            callId: data.callId
        }));
    }
    
    activeCalls.delete(data.callId);
    console.log(`❌ Voice Server: Chiamata ${data.callId} rifiutata`);
}

function handleEndCall(ws, data) {
    const participants = callParticipants.get(data.callId);
    if (participants) {
        participants.forEach(participant => {
            if (participant.readyState === WebSocket.OPEN) {
                participant.send(JSON.stringify({
                    action: 'callEnded',
                    callId: data.callId
                }));
            }
        });
    }
    
    activeCalls.delete(data.callId);
    callParticipants.delete(data.callId);
    console.log(`📞 Voice Server: Chiamata ${data.callId} terminata`);
}

function handleCallAudio(ws, data) {
    const participants = callParticipants.get(data.callId);
    if (participants) {
        participants.forEach(participant => {
            if (participant !== ws && participant.readyState === WebSocket.OPEN) {
                participant.send(JSON.stringify({
                    action: 'callAudio',
                    callId: data.callId,
                    audioData: data.audioData
                }));
            }
        });
    }
}

function cleanupUserCalls(ws) {
    // Rimuovi dalle chiamate attive
    for (const [callId, call] of activeCalls.entries()) {
        if (call.from === ws) {
            activeCalls.delete(callId);
            callParticipants.delete(callId);
        }
    }
    
    // Rimuovi dai partecipanti
    for (const [callId, participants] of callParticipants.entries()) {
        if (participants.includes(ws)) {
            const otherParticipants = participants.filter(p => p !== ws);
            if (otherParticipants.length === 0) {
                activeCalls.delete(callId);
                callParticipants.delete(callId);
            } else {
                callParticipants.set(callId, otherParticipants);
            }
        }
    }
}

// Pulizia periodica
setInterval(() => {
    const now = Date.now();
    
    // Rimuovi chiamate scadute (più di 5 minuti)
    for (const [callId, call] of activeCalls.entries()) {
        if (now - call.startTime > 300000) {
            activeCalls.delete(callId);
            callParticipants.delete(callId);
            console.log(`🧹 Voice Server: Chiamata scaduta rimossa ${callId}`);
        }
    }
    
    // Pulisci rate limiter
    for (const [clientId, limit] of audioRateLimiter.entries()) {
        if (now > limit.resetTime + 120000) {
            audioRateLimiter.delete(clientId);
        }
    }
}, 60000);

const PORT = 5001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎤 Voice Server avviato su porta ${PORT}`);
    console.log('✅ Dedicato esclusivamente alle chiamate vocali');
});
