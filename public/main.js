const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

// Funzione per avviare un countdown
function avviaCountdown(tavolo, durataMinuti) {
    const countdownDiv = document.createElement('div');
    countdownDiv.id = `countdown-${tavolo}`;
    document.getElementById('tavoli').appendChild(countdownDiv);

    let secondiRimasti = durataMinuti * 60;

    const interval = setInterval(() => {
        const minuti = Math.floor(secondiRimasti / 60);
        const secondi = secondiRimasti % 60;
        countdownDiv.textContent = `Tavolo ${tavolo}: ${minuti}:${secondi < 10 ? '0' : ''}${secondi} rimanenti`;

        if (secondiRimasti <= 0) {
            clearInterval(interval);
            countdownDiv.textContent = `Tavolo ${tavolo}: Countdown scaduto!`;
        }

        secondiRimasti--;
    }, 1000);
}

// Gestione dei messaggi WebSocket
ws.onmessage = (event) => {
    try {
        const data = JSON.parse(event.data);
        if (data.action === 'startCountdown') {
            avviaCountdown(data.tableNumber, data.timeRemaining / 60); // Converti secondi in minuti
        }
    } catch (error) {
        console.error('Errore nel parsing del messaggio:', error);
    }
};

// Invio del messaggio per avviare un countdown
document.getElementById('avviaCountdown')?.addEventListener('click', () => {
    const tableNumber = document.getElementById('numeroTavolo').value;
    const durataButton = document.querySelector('.duration-button.selected');
    const durata = parseInt(durataButton?.dataset.minutes);

    if (tableNumber && durata) {
        const timeRemaining = durata * 60; // Converti minuti in secondi
        ws.send(JSON.stringify({ 
            action: 'startCountdown', 
            tableNumber: tableNumber, 
            timeRemaining: timeRemaining 
        }));
    }
});
