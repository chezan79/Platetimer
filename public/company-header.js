
// Script per gestire l'intestazione con il nome dell'azienda
document.addEventListener('DOMContentLoaded', function() {
    // Recupera il nome dell'azienda dal localStorage
    const companyName = localStorage.getItem('userCompany');
    const companyElement = document.getElementById('company-name');
    
    if (companyName && companyName.trim() !== '' && companyElement) {
        companyElement.textContent = companyName;
    } else if (companyElement) {
        // Se non c'è un nome azienda, nascondi l'intestazione
        const companyHeader = document.getElementById('company-header');
        if (companyHeader) {
            companyHeader.style.display = 'none';
        }
    }
});
