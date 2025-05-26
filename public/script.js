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

// URL dello script Google Apps Script
const scriptURL = "https://script.google.com/macros/s/AKfycbz6_z2E5c0P1eel6E6HhuOXcGF9XFIaBiFnTYCs71E8uBvwQjm-FQLLubwMnKi23G0h8Q/exec";

// Aggiunta di un evento di submit al modulo di registrazione
form.addEventListener('submit', async (event) => {
    event.preventDefault(); // Previene il comportamento predefinito del form (invio)

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

    // Validazione email (semplice regex)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert('Inserisci un indirizzo email valido.');
        return;
    }

    // Controllo che la password sia abbastanza sicura (almeno 6 caratteri)
    if (password.length < 6) {
        passwordError.textContent = 'La password deve contenere almeno 6 caratteri.';
        passwordError.style.display = 'block';
        return;
    }

    // Controllo che la password e la conferma corrispondano
    if (password !== confirmPassword) {
        confirmPasswordError.textContent = 'Le password non corrispondono.';
        confirmPasswordError.style.display = 'block';
        return;
    }

    // Se tutti i controlli passano, invia i dati al Google Apps Script
    try {
        const response = await fetch(scriptURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                firstname: firstName,
                lastname: lastName,
                company: company,
                email: email,
                password: password,
            }),
        });

        const data = await response.json();
        if (data.status === "success") {
            alert('Registrazione completata con successo!');
            form.reset(); // Resetta il modulo
            // Reindirizza l'utente alla pagina "home.html"
            window.location.href = '/home.html';
        } else {
            alert(`Errore durante la registrazione: ${data.message}`);
        }
    } catch (error) {
        console.error('Errore durante l\'invio dei dati:', error);
        alert('Si è verificato un errore durante l\'invio dei dati. Riprova più tardi.');
    }
});
