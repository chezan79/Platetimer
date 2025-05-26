
// Import Firebase modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.16.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/9.16.0/firebase-auth.js";
import { getFirestore, doc, setDoc } from "https://www.gstatic.com/firebasejs/9.16.0/firebase-firestore.js";

// Configurazione Firebase
const firebaseConfig = {
    // Inserisci qui la tua configurazione Firebase
    apiKey: "your-api-key",
    authDomain: "your-project.firebaseapp.com",
    projectId: "your-project-id",
    storageBucket: "your-project.appspot.com",
    messagingSenderId: "123456789",
    appId: "your-app-id"
};

// Inizializza Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Selezione del modulo e dei campi
const form = document.getElementById('form-register');
const firstNameInput = document.getElementById('register-firstname');
const lastNameInput = document.getElementById('register-lastname');
const companyInput = document.getElementById('register-company');
const emailInput = document.getElementById('register-email');
const passwordInput = document.getElementById('register-password');
const confirmPasswordInput = document.getElementById('confirm-password');

// Selezione dei messaggi di errore
const passwordError = document.getElementById('password-error');
const confirmPasswordError = document.getElementById('confirm-password-error');

// Aggiunta di un evento di submit al modulo di registrazione
form.addEventListener('submit', async (event) => {
    event.preventDefault();

    // Reset dei messaggi di errore
    passwordError.style.display = 'none';
    confirmPasswordError.style.display = 'none';

    // Validazione dei campi
    const firstName = firstNameInput.value.trim();
    const lastName = lastNameInput.value.trim();
    const company = companyInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
    const confirmPassword = confirmPasswordInput.value.trim();

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
        passwordError.textContent = 'La password deve contenere almeno 6 caratteri.';
        passwordError.style.display = 'block';
        return;
    }

    // Controllo conferma password
    if (password !== confirmPassword) {
        confirmPasswordError.textContent = 'Le password non corrispondono.';
        confirmPasswordError.style.display = 'block';
        return;
    }

    try {
        // Crea l'utente con Firebase Auth
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        // Salva i dati aggiuntivi in Firestore
        await setDoc(doc(db, "users", user.uid), {
            firstName: firstName,
            lastName: lastName,
            company: company,
            email: email,
            createdAt: new Date()
        });

        alert('Registrazione completata con successo!');
        form.reset();
        window.location.href = '/home.html';
    } catch (error) {
        console.error('Errore durante la registrazione:', error);
        alert(`Errore durante la registrazione: ${error.message}`);
    }
});
