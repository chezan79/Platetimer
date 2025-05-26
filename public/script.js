
// Import Firebase modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.16.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.16.0/firebase-auth.js";
import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/9.16.0/firebase-firestore.js";

// Configurazione Firebase
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
const auth = getAuth(app);
const db = getFirestore(app);

// Selezione del modulo e dei campi
const registrationForm = document.getElementById('form-register');
const firstNameInput = document.getElementById('register-firstname');
const lastNameInput = document.getElementById('register-lastname');
const companyInput = document.getElementById('register-company');
const emailInput = document.getElementById('register-email');
const passwordInput = document.getElementById('register-password');
const confirmPasswordInput = document.getElementById('confirm-password');

// Selezione dei messaggi di errore
const passwordError = document.getElementById('password-error');
const confirmPasswordError = document.getElementById('confirm-password-error');

// Verifica che il form esista prima di aggiungere l'event listener
if (registrationForm) {
    registrationForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        // Reset dei messaggi di errore
        if (passwordError) passwordError.style.display = 'none';
        if (confirmPasswordError) confirmPasswordError.style.display = 'none';

        // Validazione dei campi
        const firstName = firstNameInput?.value.trim() || '';
        const lastName = lastNameInput?.value.trim() || '';
        const company = companyInput?.value.trim() || '';
        const email = emailInput?.value.trim() || '';
        const password = passwordInput?.value.trim() || '';
        const confirmPassword = confirmPasswordInput?.value.trim() || '';

        // Controllo che tutti i campi siano compilati
        if (!firstName || !lastName || !company || !email || !password || !confirmPassword) {
            alert('Per favore, compila tutti i campi.');
            return;
        }

        // Validazione email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            alert('Inserisci un indirizzo email valido.');
            return;
        }

        // Controllo password
        if (password.length < 6) {
            if (passwordError) {
                passwordError.textContent = 'La password deve contenere almeno 6 caratteri.';
                passwordError.style.display = 'block';
            }
            return;
        }

        // Controllo corrispondenza password
        if (password !== confirmPassword) {
            if (confirmPasswordError) {
                confirmPasswordError.textContent = 'Le password non corrispondono.';
                confirmPasswordError.style.display = 'block';
            }
            return;
        }

        try {
            // Crea utente con Firebase Auth
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // Salva dati aggiuntivi in Firestore
            await setDoc(doc(db, 'users', user.uid), {
                firstName: firstName,
                lastName: lastName,
                company: company,
                email: email,
                createdAt: new Date()
            });

            alert('Registrazione completata con successo!');
            registrationForm.reset();
            window.location.href = '/home.html';

        } catch (error) {
            console.error('Errore durante la registrazione:', error);
            
            // Gestisci errori specifici di Firebase
            let errorMessage = 'Si è verificato un errore durante la registrazione.';
            if (error.code === 'auth/email-already-in-use') {
                errorMessage = 'Questo indirizzo email è già registrato.';
            } else if (error.code === 'auth/weak-password') {
                errorMessage = 'La password è troppo debole.';
            } else if (error.code === 'auth/invalid-email') {
                errorMessage = 'Indirizzo email non valido.';
            }
            
            alert(errorMessage);
        }
    });
}
