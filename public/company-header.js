

// Script per gestire l'intestazione con il nome dell'azienda
document.addEventListener('DOMContentLoaded', function() {
    // Funzione per aggiornare il nome dell'azienda
    function updateCompanyName() {
        const companyName = localStorage.getItem('userCompany');
        const companyElement = document.getElementById('company-name');
        
        if (companyElement) {
            if (companyName && companyName.trim() !== '') {
                companyElement.textContent = companyName;
            } else {
                // Fallback: mostra un nome predefinito invece di nascondere
                companyElement.textContent = 'La Mia Pizzeria';
            }
            
            // Assicurati che l'header sia sempre visibile
            const companyHeader = document.getElementById('company-header');
            if (companyHeader) {
                companyHeader.style.display = 'block';
            }
        }
        
        // Debug: mostra il valore nel localStorage
        console.log('Nome azienda dal localStorage:', companyName);
    }

    // Aggiorna immediatamente
    updateCompanyName();
    
    // Ascolta i cambiamenti nel localStorage
    window.addEventListener('storage', function(e) {
        if (e.key === 'userCompany') {
            updateCompanyName();
        }
    });
});

// Funzione per impostare manualmente il nome dell'azienda (per test)
function setCompanyName(name) {
    localStorage.setItem('userCompany', name);
    const companyElement = document.getElementById('company-name');
    if (companyElement) {
        companyElement.textContent = name;
    }
    console.log('Nome azienda impostato:', name);
}

