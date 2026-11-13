# PlateTimer Voice — configurazione Direzione e condizioni di rilascio

## Decisione confermata
La pianificazione delle chiamate si configura **nella schermata del ristorante dove la Direzione crea/gestisce i reparti**. Non nella singola postazione Cucina/Pizzeria. La Direzione può programmare uno o più intervalli giornalieri in fuso Europe/Zurich e modificare il calendario del proprio ristorante.

## Requisiti applicativi per la fase di produzione
- Impostazione persistente per ristorante, protetta da autenticazione e ruolo Direzione/owner; isolamento tenant.
- Vista nel modulo di amministrazione reparti, con fasce orarie per giorni della settimana, intervalli non sovrapposti, supporto alle pause e alla chiusura; fuso Europe/Zurich.
- Per Molino, valori iniziali da approvare: 12:00–15:00 e 18:30–21:00. Non imporli ad altri ristoranti.
- Il server verifica gli intervalli su ogni creazione/invito e su ogni rilascio/rinnovo di token RTC. Bloccare le chiamate fuori fascia anche se il client tenta di aggirare la UI.
- Allo scadere dell'intervallo, revocare la possibilità di continuare/rinnovare la connessione; il solo timer nel browser non costituisce enforcement sufficiente.
- Ciascun ristorante vede soltanto i propri reparti attivi; invitare reparti sospesi o non assegnati è vietato.
- Chiamata in arrivo di 30 secondi, accetta/rifiuta, barra compatta; possibilità di unirsi successivamente a una conferenza attiva secondo le autorizzazioni.
- Le funzionalità esistenti di countdown, Mex, sessioni e WebSocket devono rimanere invariate.

## Limitazioni dell'attuale prototipo Replit
- Gli inviti sono in-memory su un solo processo, con polling HTTP. Un riavvio cancella gli inviti.
- La suoneria WebAudio è best-effort ed è soggetta alle restrizioni autoplay del browser.
- Il token RTC di test dura fino a un'ora; non esiste ancora enforcement server-side degli orari o chiusura alla scadenza. Non destinato alla produzione.
- Non è ancora presente il coordinamento affidabile di chiamate in corso, gruppi, reconnect e notifica di accettazione al chiamante.

## Gate prima del rilascio
Non attivare PlateTimer Voice sui siti Railway e non presentarlo come pronto all'uso fino a integrazione e test di pianificazione Direzione, blocco orari server-side, revoca/terminazione, segnalazione durevole degli inviti, audit autorizzazioni cross-tenant, multi-device, scenari Replit Preview e regressioni Service.
