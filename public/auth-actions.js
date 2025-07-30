
// Includi Firebase Authentication
import { getAuth, applyActionCode, confirmPasswordReset } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

// Configurazione Firebase
const firebaseConfig = {
    apiKey: "AIzaSyDZ0FdjenO-ngblcuXKdwWwvRV5liiR18I",
    authDomain: "app-dati-tavoli.firebaseapp.com",
    projectId: "app-dati-tavoli",
    storageBucket: "app-dati-tavoli.appspot.com",
    messagingSenderId: "267339065819",
    appId: "1:267339065819:web:1e74647f740bdf1d725ffe",
    measurementId: "G-F79QERTN6C"
};

// Inizializza Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Ottieni i parametri dal link
const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get('mode');
const oobCode = urlParams.get('oobCode');

if (mode === 'verifyEmail') {
    // Gestisci la verifica dell'email
    applyActionCode(auth, oobCode)
        .then(() => {
            alert("Email verificata con successo!");
        })
        .catch((error) => {
            console.error("Errore durante la verifica dell'email:", error);
        });
} else if (mode === 'resetPassword') {
    // Gestisci il reset della password
    const newPassword = prompt("Inserisci la nuova password:");
    confirmPasswordReset(auth, oobCode, newPassword)
        .then(() => {
            alert("Password reimpostata con successo!");
        })
        .catch((error) => {
            console.error("Errore durante il reset della password:", error);
        });
} else {
    console.error("Azione non riconosciuta:", mode);
}
