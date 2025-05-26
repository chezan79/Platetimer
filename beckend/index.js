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

// Gestisci le connessioni WebSocket
wss.on('connection', (ws) => {
    console.log('Nuova connessione WebSocket');

    // Quando un messaggio viene ricevuto
    ws.on('message', (message) => {
        const messageStr = message.toString();
        console.log('Messaggio ricevuto:', messageStr);

        // Invia il messaggio a tutti i client connessi
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageStr);
            }
        });
    });
});

// Avvia il server
const PORT = 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server avviato su http://0.0.0.0:${PORT}`);
});
