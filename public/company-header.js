
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
    appId: "1:267339065819:web:1e74647f740bdf1d725ffe"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Configurazione pagine di default (fallback)
const defaultPages = [
    { name: 'Cucina', url: 'cucina.html' },
    { name: 'Pizzeria', url: 'pizzeria.html' },
    { name: 'Insalata', url: 'insalata.html' }
];

// Funzione per caricare la configurazione dell'azienda
async function loadCompanyConfig(companyName) {
    try {
        const configDoc = await getDoc(doc(db, "company_configs", companyName));
        if (configDoc.exists()) {
            const config = configDoc.data();
            console.log('✅ Configurazione caricata:', config);
            return config;
        } else {
            console.log('⚠️ Nessuna configurazione trovata, uso default');
            return { pages: defaultPages };
        }
    } catch (error) {
        console.error('❌ Errore caricamento configurazione:', error);
        return { pages: defaultPages };
    }
}

// Funzione per creare l'header con navigazione dinamica
async function createCompanyHeader() {
    const companyName = localStorage.getItem('userCompany');
    if (!companyName) {
        console.log('⚠️ Nome azienda non trovato');
        return;
    }

    // Carica configurazione
    const config = await loadCompanyConfig(companyName);
    const pages = config.pages || defaultPages;

    // Crea l'header
    const header = document.createElement('header');
    header.className = 'company-header';
    header.innerHTML = `
        <div class="header-content">
            <div class="company-info">
                <img src="mealmaster-logo.jpg" alt="MealMaster" class="logo">
                <h1 id="company-name">${companyName}</h1>
            </div>
            <nav class="main-navigation">
                <a href="home.html" class="nav-link">🏠 Home</a>
                <a href="sala.html" class="nav-link">🏢 Sala</a>
                ${pages.map(page => `
                    <a href="${page.url}" class="nav-link">${page.name}</a>
                `).join('')}
            </nav>
            <div class="user-controls">
                <button id="logout-btn" class="logout-btn">Logout</button>
            </div>
        </div>
    `;

    // Inserisci l'header all'inizio del body
    document.body.insertBefore(header, document.body.firstChild);

    // Aggiungi stili se non esistono
    if (!document.getElementById('header-styles')) {
        const style = document.createElement('style');
        style.id = 'header-styles';
        style.textContent = `
            .company-header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 1rem 0;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                position: sticky;
                top: 0;
                z-index: 1000;
            }
            .header-content {
                max-width: 1200px;
                margin: 0 auto;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 0 1rem;
            }
            .company-info {
                display: flex;
                align-items: center;
                gap: 1rem;
            }
            .logo {
                width: 40px;
                height: 40px;
                border-radius: 50%;
            }
            .main-navigation {
                display: flex;
                gap: 1rem;
                align-items: center;
            }
            .nav-link {
                color: white;
                text-decoration: none;
                padding: 0.5rem 1rem;
                border-radius: 5px;
                transition: background-color 0.3s;
            }
            .nav-link:hover {
                background-color: rgba(255,255,255,0.2);
            }
            .logout-btn {
                background-color: #ff4757;
                color: white;
                border: none;
                padding: 0.5rem 1rem;
                border-radius: 5px;
                cursor: pointer;
            }
            .logout-btn:hover {
                background-color: #ff3742;
            }
            @media (max-width: 768px) {
                .header-content {
                    flex-direction: column;
                    gap: 1rem;
                }
                .main-navigation {
                    flex-wrap: wrap;
                    justify-content: center;
                }
            }
        `;
        document.head.appendChild(style);
    }

    // Gestisci logout
    document.getElementById('logout-btn').addEventListener('click', () => {
        localStorage.removeItem('userCompany');
        window.location.href = 'index.html';
    });

    console.log('✅ Header creato con configurazione dinamica');
}

// Funzione per verificare autenticazione e caricare header
onAuthStateChanged(auth, async (user) => {
    if (user) {
        try {
            const userDoc = await getDoc(doc(db, "users", user.uid));
            if (userDoc.exists()) {
                const userData = userDoc.data();
                if (userData.company && userData.company.trim() !== '') {
                    localStorage.setItem('userCompany', userData.company);
                    await createCompanyHeader();
                }
            }
        } catch (error) {
            console.error('Errore nel recupero dei dati utente:', error);
        }
    } else {
        localStorage.removeItem('userCompany');
    }
});

// Esporta la funzione per uso manuale se necessario
window.createCompanyHeader = createCompanyHeader;
