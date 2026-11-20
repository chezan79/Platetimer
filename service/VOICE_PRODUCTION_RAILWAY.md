# PlateTimer — Chiamate Agora in produzione Railway

## Ambito e sicurezza

- Endpoint di produzione separati: `/api/voice-call/*`. Le route `/api/voice-test/*` restano limitate alla Preview Replit.
- `PLATETIMER_VOICE_CALLS_ENABLED=true` è un interruttore esplicito: senza questa variabile, la funzione è disattivata.
- Sono obbligatori Firebase Admin/Firestore, `AGORA_APP_ID` e `AGORA_APP_CERTIFICATE` sul **servizio Railway collegato ad app.platetimer.com**.
- Ogni richiesta verifica il token di sessione e il reparto Service attivo in Firestore; ogni ristorante deve inoltre essere abilitato dall'amministratore centrale nella sezione Voice.
- Canale Agora differente per ogni invito, identificato da un UUID casuale; il server consegna token solo ai reparti chiamante e destinatario, e solo al destinatario dopo l'accettazione.
- Gli inviti sono atomici e condivisi tra repliche via Firestore, scadono entro 30 secondi.
- Le sessioni funzionano soltanto 12:00–14:30 e 18:30–22:00 Europe/Zurich. Il frontend controlla l'orario e l'autorizzazione periodicamente, blocca il microfono quando la pagina va in background e controlla l'eventuale chiusura dall'altra parte. I token Agora sono limitati alla fascia oraria e rinnovati solo dopo una nuova autorizzazione server.
- Per gli archivi `platetimer_voice_invites` e `platetimer_voice_sessions`, configurare in Firestore una policy TTL sul campo `purgeAt` per cancellare automaticamente i dati di signaling dopo la finestra di conservazione. Non vengono registrate conversazioni audio.
- In Firestore Security Rules negare l'accesso diretto dei browser a queste due collection; soltanto il backend Admin SDK deve leggerle.

## Attivazione controllata

1. Eseguire i test locali: `node --test tests/voice-calls-production.test.js tests/voice-calls-frontend.test.js`, poi la suite di regressione delle funzionalità vocali esistenti.
2. Verificare che la Preview Replit mantenga gli endpoint test (nessuna nuova modifica a `.replit`).
3. Su Railway controllare quale tra i servizi GitHub collegati gestisce il dominio `app.platetimer.com`. Non abilitare per errore i due ambienti senza aver verificato variabili Firebase e isolamento.
4. Controllare la presenza dei segreti `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE` e credenziali Firebase Admin **senza stamparne i valori**.
5. Configurare la policy TTL Firestore per entrambe le collection.
6. Solo dopo validazione e merge su `main`, impostare `PLATETIMER_VOICE_CALLS_ENABLED=true` sul servizio Railway corretto (questa modifica richiede un redeploy Railway).
7. Verificare che solo Molino Molard sia autorizzato nella dashboard centrale e aprire due postazioni di reparti distinti sul dominio pubblico durante gli orari previsti.
8. Testare: chiamata, suoneria massimo 30s, accettazione/rifiuto, mute, hangup da entrambi i lati, timeout invito, orario chiuso, revoca amministratore, riavvio di una replica e nessun accesso tra ristoranti.

## Limiti da documentare prima del rollout

- **Non è possibile garantire una disconnessione audio istantanea da remoto** quando un browser è sospeso/offline o non riceve il controllo periodico. I token a scadenza e i controlli client riducono il rischio, ma una vera revoca immediata RTC richiede un meccanismo server-side di terminazione tramite Agora o un'infrastruttura equivalente.
- La suoneria dipende dalle restrizioni audio di Safari/Chrome e richiede un'interazione precedente dell'utente per essere udibile. I messaggi visivi di chiamata in arrivo restano disponibili.
- Gli inviti sono polling (ogni 2s) e non notifiche push native. I reparti devono mantenere PlateTimer attivo.
- Ogni chiamata è punto-a-punto. Una seconda postazione autenticata con lo stesso reparto può condividere il medesimo UID Agora; è necessario testare il comportamento operativo con i dispositivi realmente utilizzati.
- Le chiamate non sono abilitate automaticamente con questo commit: flag e approvazione per ristorante sono necessari.
