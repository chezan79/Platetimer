
// Script per gestire l'intestazione con il nome dell'azienda
document.addEventListener('DOMContentLoaded', function() {
    // Recupera il nome dell'azienda dal localStorage
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
});
