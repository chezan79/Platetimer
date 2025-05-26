
// Utilità per la gestione dell'autenticazione e dei dati utente
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

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
const db = getFirestore(app);

// Funzione per verificare l'autenticazione e recuperare i dati utente
export function initializeUserData() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            try {
                // Recupera i dati dell'utente da Firestore
                const userDoc = await getDoc(doc(db, "users", user.uid));
                if (userDoc.exists()) {
                    const userData = userDoc.data();
                    // Aggiorna il localStorage con i dati più recenti
                    if (userData.company && userData.company.trim() !== '') {
                        localStorage.setItem('userCompany', userData.company);
                        // Aggiorna l'intestazione se esiste
                        const companyElement = document.getElementById('company-name');
                        if (companyElement) {
                            companyElement.textContent = userData.company;
                        }
                    }
                }
            } catch (error) {
                console.error('Errore nel recupero dei dati utente:', error);
            }
        } else {
            // Utente non autenticato, pulisci i dati
            localStorage.removeItem('userCompany');
        }
    });
}

export { auth, db };
