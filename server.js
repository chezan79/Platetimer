
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Memorizza i countdown attivi
const activeCountdowns = new Map();

// Servire i file statici
app.use(express.static(path.join(__dirname, 'public')));

// Gestire le connessioni WebSocket
wss.on('connection', (ws) => {
    console.log('Nuova connessione WebSocket');

    // Invia tutti i countdown attivi al nuovo client
    activeCountdowns.forEach((countdown, tableNumber) => {
        const now = Date.now();
        const timeRemaining = Math.max(0, Math.floor((countdown.endTime - now) / 1000));
        
        if (timeRemaining > 0) {
            ws.send(JSON.stringify({
                action: 'startCountdown',
                tableNumber: tableNumber,
                timeRemaining: timeRemaining
            }));
        } else {
            // Rimuovi countdown scaduti
            activeCountdowns.delete(tableNumber);
        }
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Messaggio ricevuto:', data);

            if (data.action === 'startCountdown') {
                // Calcola il tempo di fine
                const endTime = Date.now() + (data.timeRemaining * 1000);
                
                // Memorizza il countdown
                activeCountdowns.set(data.tableNumber, {
                    endTime: endTime,
                    originalDuration: data.timeRemaining
                });

                // Invia a tutti i client connessi
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            action: 'startCountdown',
                            tableNumber: data.tableNumber,
                            timeRemaining: data.timeRemaining
                        }));
                    }
                });
            }
        } catch (error) {
            console.error('Errore nel parsing del messaggio:', error);
        }
    });

    ws.on('close', () => {
        console.log('Connessione WebSocket chiusa');
    });
});

// Pulizia periodica dei countdown scaduti
setInterval(() => {
    const now = Date.now();
    for (const [tableNumber, countdown] of activeCountdowns.entries()) {
        if (countdown.endTime <= now) {
            activeCountdowns.delete(tableNumber);
        }
    }
}, 60000); // Controlla ogni minuto

// Avviare il server
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server avviato su http://0.0.0.0:${PORT}`);
});
