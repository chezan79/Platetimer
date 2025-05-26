const express = require('express');
const http = require('http');
const WebSocket = require('ws');

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

// Gestisci le connessioni WebSocket
wss.on('connection', (ws) => {
    console.log('Nuova connessione WebSocket');

    // Quando un messaggio viene ricevuto
    ws.on('message', (message) => {
        const messageStr = message.toString();
        console.log('Messaggio ricevuto:', messageStr);

        try {
            const data = JSON.parse(messageStr);

            // Se è un messaggio di registrazione alla room
            if (data.action === 'joinRoom') {
                const companyName = data.companyName;
                ws.companyName = companyName;

                // Aggiungi il client alla room dell'azienda
                if (!companyRooms.has(companyName)) {
                    companyRooms.set(companyName, new Set());
                }
                companyRooms.get(companyName).add(ws);

                console.log(`Client unito alla room: ${companyName}`);
                return;
            }

            // Se è un countdown, invia solo ai client della stessa azienda
            if (data.action === 'startCountdown' && ws.companyName) {
                const companyClients = companyRooms.get(ws.companyName);
                if (companyClients) {
                    companyClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(messageStr);
                        }
                    });
                }
                console.log(`Countdown inviato alla room: ${ws.companyName}`);
            }
        } catch (error) {
            console.error('Errore nel parsing del messaggio:', error);
        }
    });

    // Rimuovi il client quando si disconnette
    ws.on('close', () => {
        if (ws.companyName) {
            const companyClients = companyRooms.get(ws.companyName);
            if (companyClients) {
                companyClients.delete(ws);
                if (companyClients.size === 0) {
                    companyRooms.delete(ws.companyName);
                }
            }
            console.log(`Client rimosso dalla room: ${ws.companyName}`);
        }
    });
});

// Avvia il server
const PORT = 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server avviato su http://0.0.0.0:${PORT}`);
});