
#!/bin/bash

# Script per push automatico notturno su GitHub
cd ~/workspace

# Verifica se ci sono modifiche da committare
if [[ -n $(git status -s) ]]; then
    echo "📝 Modifiche rilevate, eseguo commit e push..."
    git add -A
    git commit -m "Aggiornamento automatico notturno $(date '+%Y-%m-%d %H:%M:%S')"
    git push origin main
    echo "✅ Push completato con successo"
else
    echo "ℹ️ Nessuna modifica da committare"
fi

exit 0
