// Importa i moduli necessari da Firebase
import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, GoogleAuthProvider } from "firebase/auth";
// Importa il modulo di Cloud Firestore
import { getFirestore } from "firebase/firestore"; // <-- Aggiungiamo questo!

// Configurazione Firebase (usa le credenziali del tuo progetto)
const firebaseConfig = {
  apiKey: "AIzaSyDZ0FdjenO-ngblcuXKdwWwvRV5liiR18I",
  authDomain: "app-dati-tavoli.firebaseapp.com",
  projectId: "app-dati-tavoli",
  storageBucket: "app-dati-tavoli.appspot.com",
  messagingSenderId: "267339065819",
  appId: "1:267339065819:web:1e74647f740bdf1d725ffe",
  measurementId: "G-F79QERTN6C",
};

// Inizializza Firebase
const app = initializeApp(firebaseConfig);

// Configura il servizio di autenticazione
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// Inizializza Cloud Firestore e ottieni un riferimento <-- Aggiungiamo questo!
const db = getFirestore(app);


// Funzione per il login con Google
export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    console.log("Utente autenticato:", user);
    return user; // Puoi restituire l'utente per utilizzarlo nell'app
  } catch (error) {
    console.error("Errore durante l'autenticazione:", error.message);
    // Potrebbe essere utile gestire errori specifici qui, ad es. auth/popup-closed-by-user
  }
};

// Esporta auth per usarlo in altre parti dell'app
export { auth, db }; // <-- Esportiamo anche 'db' per accedere a Firestore altrove!
