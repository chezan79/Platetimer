# Diagnosi invio Mex tra reparti (28 settembre 2026)

## Evidenza locale e intervento

Nel compose di `public/department.html` il clic sul radio selezionava il valore
HTML ma chiamava solo `event.stopPropagation()`. L'handler della riga, unico
responsabile di `mexUpdateSendBtn()`, non veniva eseguito: **Invia restava
disabilitato**. Il test `node tests/mex-dept-compose.test.js` riproduce il
difetto con la precedente versione dell'handler, poi verifica nella versione
corretta i clic su radio, etichetta e riga, oltre al destinatario Sala.

La modifica chiama la stessa funzione di selezione dal radio. Non cambia la
risoluzione dell'identità, la lista autenticata dei destinatari o la
persistenza. Un ACK di successo significa che il salvataggio sullo store è
terminato; **non è una ricevuta di lettura né garantisce una consegna WebSocket
in tempo reale**. Il testo del client ora lo distingue. Se la connessione
cade prima dell'ACK, il corpo rimane e l'interfaccia segnala esito incerto
senza reinviare automaticamente: il messaggio potrebbe essere già salvato.

`node tests/mex-step3-ws.test.js` verifica localmente join autenticato,
ACK, ricezione sulla connessione del reparto destinatario, inbox dopo
riconnessione, destinatario invalido, reparto terzo e altra azienda.
`node tests/mex-rate-limit.test.js` verifica il rifiuto con ACK e il retry
esplicito dopo il limite. Questi test usano un solo processo Node e uno
store temporaneo: non simulano la topologia Railway.

## Limiti e verifica operativa ancora necessaria

Non è disponibile qui il commit effettivamente pubblicato su Railway, né
accesso ai suoi log o al numero delle repliche: il diff tra versione live e
ultima versione funzionante e la causa **del singolo episodio in produzione**
non sono verificabili. I log di un'eventuale pubblicazione Replit non sono
log Railway. Non sono stati interrogati account/dati di produzione o inviati
Mex ai reparti reali.

Con autorizzazione dell'operatore, durante una prova concordata tra due
reparti verificare separatamente:

1. Nel browser mittente: il radio e l'etichetta abilitano Invia? Il WebSocket
   riceve `joinedRoom` prima di `mexSend`? Quale `mexSendAck` (`success`/`code`)
   arriva? In caso di nessun ACK, controllare la chiusura della connessione.
2. Nei log Railway dello stesso intervallo: `joinRoom result`, `MEX Send error`
   e il log `[MEX] conv=...` (non copiare corpi dei messaggi). Confrontare
   l'identificativo della replica mittente/destinataria e il commit pubblicato.
   Controllare anche che il reparto associato all'account mittente esista
   ancora e sia attivo: una precedente indagine
   (`docs/mex-carne-pesce-audit-report.md`) aveva rilevato associazioni
   orfane. Non assumere che quei dati descrivano lo stato attuale.
3. Nel browser destinatario: arriva `mexIncoming`? Se no, dopo una nuova
   connessione l'inbox autenticata contiene la conversazione? **ACK sì /
   mexIncoming no / inbox sì** indica persistenza senza consegna immediata;
   **ACK no** indica blocco/rifiuto prima della conferma; **ACK sì / inbox no**
   richiede indagine sullo store e sulle repliche.

Le room e la cache Mex sono locali al processo. Con più repliche un mittente
può ricevere un ACK mentre il destinatario è collegato a un altro processo:
la consegna live non attraversa automaticamente le repliche. Anche la cache
per azienda del negozio Mex può non ricaricare i nuovi messaggi scritti da
un'altra replica. Non è stato introdotto un broker o modificata la topologia
senza una conferma di questo scenario in Railway. Non esporre conversazioni
tramite API di diagnostica non filtrate: l'inbox resta limitata ai partecipanti.