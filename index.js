
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    path: '/ws'
});

app.use(express.static('public'));

wss.on('connection', (ws) => {
    console.log('Nouvelle connexion WebSocket');

    ws.on('message', (message) => {
        const messageStr = message.toString();
        console.log('Message reçu:', messageStr);
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(messageStr);
            }
        });
    });
});

server.listen(5000, '0.0.0.0', () => {
    console.log('Serveur démarré sur http://0.0.0.0:5000');
});
