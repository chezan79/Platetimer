const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servire i file statici
app.use(express.static(path.join(__dirname, 'public')));

// Gestire le connessioni WebSocket
wss.on('connection', (ws) => {
    console.log('Nuova connessione WebSocket');

    ws.on('message', (message) => {
        console.log('Messaggio ricevuto:', message);

        // Invia un messaggio a tutti i client
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });

    ws.on('close', () => {
        console.log('Connessione WebSocket chiusa');
    });
});

// Avviare il server
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server in esecuzione su http://localhost:${PORT}`);
});
