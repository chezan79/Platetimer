# PlateTimer Platform Monitor — modulo isolato

## Scopo
Dashboard centrale read-only, riservata all'UID Firebase configurato in
`PLATETIMER_PLATFORM_ADMIN_UID`. Non attribuisce l'amministratore a nessun
ristorante e non permette di leggere messaggi o ascoltare audio.

## File nuovi
- `admin-monitor/monitor-api.js`: API con lettura dei WebSocket già autenticati e countdown.
- `public/platform-monitor.html`: pagina monitor con aggiornamento ogni 5 secondi.
- `tests/platform-monitor.test.js`: test sicurezza e filtro presenza.

## Integrazione sul branch feature/platform-live-monitor
L'API è montata da `server.js` appena dopo l'inizializzazione di
`activeCountdowns`, usando WebSocket e stato countdown già esistenti.
La pagina `platform-admin.html` ora contiene il link al monitor.
Questo aggiornamento non è pubblicato su `main` o Railway. Il collegamento è:

```js
require('./admin-monitor/monitor-api').mountPlatformMonitor(app, {
  wss,
  lookupFirebaseAccount,
  getCompanies: () => Object.entries(departmentsStore).map(([companyId, depts]) => ({
    companyId, departments: Array.isArray(depts) ? depts.length : 0
  })),
  getCountdowns: companyId => activeCountdowns.get(companyId)?.size || 0
});
```

**Nota:** la funzione `lookupFirebaseAccount` verifica un Firebase ID Token;
non autorizzare via email, `userCompany` o sessioni di ristoranti.

Per il monitor, `Online` indica almeno un WebSocket autenticato e con pong
negli ultimi 90 secondi: non indica attività umana effettiva.
L'endpoint non include identità dei dipendenti, IP, audio, comunicazioni o messaggi.

## Test
`node --test tests/platform-monitor.test.js`

## Vincoli
Solo due file esistenti sono stati modificati in modo additivo: `server.js` (montaggio rotta)
e `public/platform-admin.html` (link). Nessuna modifica ai meccanismi
WebSocket, countdown o Agora. Nessun deploy: occorrono ancora test in Replit
Preview, verifica permessi Firebase e revisione prima di produzione.
