const ws = new WebSocket('ws://localhost:3000');

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
    const data = JSON.parse(event.data);
    if (data.action === 'startCountdown') {
        avviaCountdown(data.tavolo, data.durata);
    }
};

// Invio del messaggio per avviare un countdown
document.getElementById('avviaCountdown')?.addEventListener('click', () => {
    const tavolo = document.getElementById('numeroTavolo').value;
    const durataButton = document.querySelector('.duration-button[data-minutes]');
    const durata = parseInt(durataButton?.dataset.minutes);

    if (tavolo && durata) {
        ws.send(JSON.stringify({ action: 'startCountdown', tavolo, durata }));
    }
});
