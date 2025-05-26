// Includi Firebase Authentication
import { getAuth, applyActionCode } from "https://www.gstatic.com/firebasejs/9.16.0/firebase-auth.js";

// Ottieni i parametri dal link
const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get('mode');
const oobCode = urlParams.get('oobCode');

// Inizializza Firebase Authentication
const auth = getAuth();

if (mode === 'verifyEmail') {
    // Gestisci la verifica dell'email
    auth.applyActionCode(oobCode)
        .then(() => {
            alert("Email verificata con successo!");
        })
        .catch((error) => {
            console.error("Errore durante la verifica dell'email:", error);
        });
} else if (mode === 'resetPassword') {
    // Gestisci il reset della password
    const newPassword = prompt("Inserisci la nuova password:");
    auth.confirmPasswordReset(oobCode, newPassword)
        .then(() => {
            alert("Password reimpostata con successo!");
        })
        .catch((error) => {
            console.error("Errore durante il reset della password:", error);
        });
} else {
    console.error("Azione non riconosciuta:", mode);
}
