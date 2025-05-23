const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve i file statici (frontend)
app.use(express.static('public'));

// Gestione connessioni WebSocket
wss.on('connection', (ws) => {
    console.log('Nuova connessione WebSocket');

    ws.on('message', (message) => {
        console.log('Messaggio ricevuto:', message);

        // Invia il messaggio a tutti i client connessi
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

// Avvia il server
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server in esecuzione su http://localhost:${PORT}`);
});
