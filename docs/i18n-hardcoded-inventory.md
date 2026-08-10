# I18N-2 Inventory — Hardcoded Operations Texts & Email Templates

Prepared during I18N-1 (IT/FR/EN foundation). **Nothing below was changed** — this is
the catalogue of remaining hardcoded (Italian) generated texts for the next i18n sprint.

## Server-side generated texts

### `operations/ops-intelligence.js`
- Attention alerts: titles/descriptions/recommendedAction strings (e.g. "Compito in ritardo",
  "Compito urgente non avviato", "Utente sospeso con compiti assegnati", "Membro del team
  sovraccarico", "Concentrazione urgenze nel reparto…", "Compito inattivo da tempo").
- Suggestions: titles/descriptions for REASSIGN_BALANCE, REASSIGN_SUSPENDED, REVIEW_DEPT,
  COMPLETE_RECURRING.
- Decision cards (`generateDecisions`): all `title`, `reason`, `recommendedAction`,
  `supportingFacts` strings and quickAction labels ("Apri Team", etc.); helpers `fmtSince`
  ("min fa", "mai"), `fmtAvg` ("n/d").

### `operations/ops-assistant.js`
- Risk Watch (`detectRisks`): every risk `title`/`description` (CRITICAL→LOW rules).
- New-since-last-visit items: "Nuovo compito urgente…", "Escalation: …".
- Changes-since sentences (`buildChangesSince`) and the executive brief
  (`buildExecutiveBrief`) — explicitly generate Italian sentences.

### `operations/ops-trends.js` / `ops-snapshots.js`
- Any trend/briefing sentence fragments consumed by the intelligence endpoint.

### `operations/ops-email.js` — email templates (all Italian)
- `sendTaskAssignmentEmail`, `sendInvitationEmail`, `sendReminderEmail`,
  `sendEscalationEmail`, `sendDailyDigestEmail`: subjects ("[PlateTimer Operations] …"),
  greeting/body copy, table labels (Titolo, Descrizione, Priorità, Scadenza, Assegnatario),
  button labels ("Apri i miei compiti", "Attiva il mio account", "Vai ai compiti"),
  footer ("messaggio automatico. Non rispondere…"), day labels ("OGGI", "SCADUTO … fa").

## Client-side hardcoded texts

### `public/js/operations-common.js`
- `ROLE_LABELS`, `PRIORITY_LABELS`, `STATUS_LABELS`, `HISTORY_LABELS` maps.
- `greeting()` ("Buongiorno/Buon pomeriggio/Buonasera"), `fmtDue` ("Nessuna scadenza"),
  session-expired alerts, `historyLine()` fragments, `renderTaskList` empty state
  ("Nessun compito."), buttons ("✓ Completa", "▶ Inizia"),
  `renderNewSinceLastVisit` ("Prima visita", "oggi/ieri alle…", "Nessuna nuova criticità…").
- Locale-fixed date formatting: `toLocaleString('it-IT', …)` throughout.

### Role dashboard pages (all static Italian markup + inline JS strings)
- `operations-director.html`, `operations-cc.html`, `operations-adjoint.html`,
  `operations-souschef.html`, `operations-cdb.html`
- Supporting pages: `operations-tasks.html`, `operations-team.html`,
  `operations-templates.html`, `operations-performance.html`, `operations-activate.html`

### `operations-performance.html`
- Performance/coaching labels (reliability, strengths/coaching copy, exception register UI).

## Notes for I18N-2
- Server-generated texts need a server-side i18n strategy (either translate at generation
  time using a per-user/company language, or emit structured codes + params and translate
  client-side). Emails need the recipient's language, not the viewer's.
- Do not translate user-created content (department names, task titles, comments, filenames).
