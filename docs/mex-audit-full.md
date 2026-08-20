# Mex Messaging — Full Diagnostic Audit

**Date:** 2026-08-19  
**Scope:** Read-only. No code, tests, Firestore data, or account bindings were modified.  
**Target company examined:** pizzeria molino molard  

---

## A — Current Mex Architecture

### Files and Roles

| File | Role |
|------|------|
| `server.js` | WS handlers (`mexSend`, `mexReply`, `mexClose`, `joinRoom`); REST `/api/service/mex/inbox`, `/api/service/mex/floor-inbox`, `/api/sala/token`; recipient validation via `getCompanyDepts()` |
| `service/mex-store.js` | Per-company in-memory + Firestore conversation store; serialised per-company write queue; `createAndSend`, `addReply`, `closeConversation`, `getInboxForDept` |
| `service/department-accounts.js` | Account lookup; `findDepartmentAccountById`, `findDepartmentAccountByUid`, `bindFirebaseUid`, `getDepartmentType` |
| `public/department.html` | Dept side: compose (3-step QM picker), `sendMexMessage()`, `handleMexSendAck()`, `buildMexRecipientList()`, `insertMexCdCard()`, reply/close handlers |
| `public/sala.html` | Floor side: `sendMexFromFloor()`, `handleMexFloorSendAck()`, `buildMexFloorRecipientList()`, `handleMexIncoming()`, reply/close handlers |
| `public/js/countdowns.js` | Shared WS client; `connectWS()` reconnect loop; dispatch callbacks for all Mex events: `mexIncoming`, `mexSendAck`, `mexReplyAck`, `mexReplyIncoming`, `mexCloseAck`, `mexClosed` |
| `public/js/mex-qm.js` | Client-side QM template definitions, `validateTableNum()`, `renderBody()`, `buttonLabel()` |
| `public/js/mex-qr.js` | Client-side QR (reply) type definitions, `renderBody()`, `buttonLabel()` |
| `public/js/ws-auth.js` | `joinRoom()`, `handleServerError()`, `isServiceSession()`, `getLoginDestination()`, `exchangeFirebaseToken()` |

### Complete Call-Path Map

#### Dept → Dept or Dept → Floor (department.html)

```
1. Operator selects QM type (dept.html mexDeptSelectQm)
     → if table template: step 2 (table number input)
     → if CUSTOM: step 3 (textarea)
2. mexDeptGoToSendStep() — validates table number client-side (MexQM.validateTableNum),
     pre-fills body, shows read-only preview
3. Operator selects recipient (buildMexRecipientList → /api/voice-recipients)
4. sendMexMessage() — client-side pre-validation (empty, length, WS open)
     → ws.send({ action:'mexSend', to, body [, templateType, tableNumber] })
     [sender 'from' intentionally omitted — server derives it]

5. server.js mexSend handler:
     a. MEX_NOT_BOUND check: mexSender = ws.boundDepartmentId || (isFloorPrincipal ? '__sala__' : null)
     b. MEX_NO_ROOM check: ws.companyRoom must be set
     c. QM metadata extraction (mexTemplateTypeSafe, mexTableNumberSafe) — sanitised; table-type validates range
     d. Body validation: MEX_EMPTY_BODY, MEX_BODY_TOO_LONG (>300)
     e. Recipient validation: MEX_NO_RECIPIENT, MEX_SELF_SEND, MEX_INVALID_RECIPIENT
        - Floor (__sala__) valid only if sender is a real dept (not floor-to-floor)
        - Real depts validated live against getCompanyDepts(companyId).filter(d=>d.active)
     f. mexStoreModule.createAndSend({ companyId, senderDeptId, recipientDeptId, body, templateType, tableNumber })
        → returns Promise<{ conversation, message }>

6. mex-store.js createAndSend:
     - Enqueued per-company (queues[companyId]) — serialises concurrent writes
     - Loads/initialises store if needed
     - Firestore transaction with rev precondition (multi-instance safe)
     - Returns { conversation, message }

7. server.js on .then():
     - mexSendAck(success:true) → sender socket
     - mexIncoming → participant sockets only (participant-only predicate):
         clientPrincipal = client.boundDepartmentId || (isFloorPrincipal ? '__sala__' : null)
         delivered only if clientPrincipal ∈ conversation.participants AND client ≠ ws (no echo to sender)

8. dept.html handleMexSendAck:
     - success: show ok status, reset compose after 1500 ms (mexDeptResetCompose)
     - failure: show error code text, re-enable send button

9. Recipient dept.html handleMexIncoming:
     - Resolves fromName from departmentMap (or '__sala__' label)
     - insertMexCdCard(msg, true) — adds card to #cd-list
     - playMexSound() — Web Audio API two-note tone
```

#### Floor → Dept (sala.html)

```
1. sala.html loadDepartments() → GET /api/departments (with floor token)
     → departmentMap populated with all active depts (floor token is non-bound)
2. buildMexFloorRecipientList() → from Object.values(departmentMap).filter(d=>d.active)
     (no __sala__ row added — floor cannot message floor)
3. Operator selects QM type → buildMexFloorQmButtons() / table-number step
4. sendMexFromFloor() → ws.send({ action:'mexSend', to, body [, templateType, tableNumber] })
     [sender derived server-side from ws.isFloorPrincipal=true → '__sala__']
5. Server handler (same as above, steps 5–7)
6. sala.html handleMexFloorSendAck:
     - success: status ok, reset compose after 1500 ms
     - failure: show error code, re-enable button
7. Recipient dept.html handleMexIncoming (same as above)
```

#### Reply flow (mexReply)

```
dept.html: sendMexReply(convId, replyType) → mexSendReplyWs → ws.send({action:'mexReply', conversationId, replyType, body})
server.js mexReply handler: validates sender (MEX_NOT_BOUND), body, convId
  → mexStoreModule.addReply(companyId, convId, {from, replyType, body})
  → mexReplyAck to sender; mexReplyIncoming to other participant
```

#### Close flow (mexClose)

```
dept.html: closeMexConv(convId) → ws.send({action:'mexClose', conversationId:convId})
server.js mexClose handler: validates closeSender
  → mexStoreModule.closeConversation(companyId, convId, closeSender)
  → mexCloseAck to sender; mexClosed to other participant
Note: mexClose delivery uses `wss.clients` (all WS clients) filtered by companyRoom+principal,
      rather than companyRooms Map — functionally equivalent but less efficient for large deployments.
```

---

## B — Send Failure Points

### Server-side rejections (all return mexSendAck unless noted)

| # | Check location | Condition | Error code | Sent as |
|---|----------------|-----------|-----------|---------|
| 1 | WS auth gate (pre-handler) | Socket not authenticated (no joinRoom) | `UNAUTHENTICATED` (action:'error') | `error` event |
| 2 | Rate limiter (server.js ~5168) | >5 messages in 400 ms window | Silent drop — no WS message sent | *(none)* |
| 3 | mexSend: MEX_NOT_BOUND | `ws.boundDepartmentId` null AND not `isFloorPrincipal` | `MEX_NOT_BOUND` | `error` event (not mexSendAck) |
| 4 | mexSend: MEX_NO_ROOM | `ws.companyRoom` null | `MEX_NO_ROOM` | mexSendAck failure |
| 5 | mexSend: MEX_INVALID_TABLE_NUMBER | templateType is table-type AND tableNumber empty/too long/>8 chars/non-alphanumeric/numeric outside 1–999 | `MEX_INVALID_TABLE_NUMBER` | mexSendAck failure |
| 6 | mexSend: MEX_EMPTY_BODY | body trims to empty | `MEX_EMPTY_BODY` | mexSendAck failure |
| 7 | mexSend: MEX_BODY_TOO_LONG | body.length > 300 | `MEX_BODY_TOO_LONG` | mexSendAck failure |
| 8 | mexSend: MEX_NO_RECIPIENT | `data.to` empty or missing | `MEX_NO_RECIPIENT` | mexSendAck failure |
| 9 | mexSend: MEX_SELF_SEND | `data.to === mexSender` | `MEX_SELF_SEND` | mexSendAck failure |
| 10 | mexSend: MEX_INVALID_RECIPIENT | recipient not in live active-dept list AND recipient ≠ `__sala__` (or floor→floor) | `MEX_INVALID_RECIPIENT` | mexSendAck failure |
| 11 | mexStoreModule.createAndSend | Firestore rev conflict or write error | `MEX_PERSIST_ERROR` (or store-defined code) | mexSendAck failure |

### Client-side blocks (message never sent over WS)

| # | Location | Condition | User feedback |
|---|----------|-----------|---------------|
| C1 | `sendMexMessage()` dept.html | No recipient selected | `dept.mexNoRecipient` i18n status |
| C2 | `sendMexMessage()` dept.html | Empty body | `dept.mexBodyEmpty` status |
| C3 | `sendMexMessage()` dept.html | Body > 300 chars | `dept.mexBodyTooLong` status |
| C4 | `sendMexMessage()` dept.html | WS not open | `dept.mexErrorSend` status |
| C5 | `sendMexFromFloor()` sala.html | Same checks as C1–C4 | equivalent floor status keys |

### Symptom summary

- **Rate limiter (B2)** — most dangerous: client gets **no acknowledgement** on silent drop. The user sees the button re-enable immediately (ack handler never fires); the message is simply gone.
- **MEX_NOT_BOUND (B3)** — emitted as `action:'error'` not `mexSendAck`; `handleServerError()` in ws-auth.js shows an alert and clears token → page redirect. Very disruptive.
- **MEX_INVALID_RECIPIENT (B10)** — error code shown raw; no human-readable translation mapped for it in client i18n files → user sees `MEX_INVALID_RECIPIENT` text.
- **MEX_PERSIST_ERROR (B11)** — error code shown raw similarly.

---

## C — Recipient Discovery

### `/api/voice-recipients` (server.js ~937–957)

- **Auth:** `requireAuth` — accepts both Firebase and service sessions.
- **Company isolation:** `companyId` always extracted from server-verified session.
- **Returns:** all departments for the company where `dept.active === true`, as `{ id, name, active }` objects.
- **Excludes:** no bound-dept filter for any session type. Returns the full company tenant active list.
- **No `__sala__` (Floor) entry** — Floor is added client-side as a hardcoded row.

### `buildMexRecipientList()` — department.html

```
1. GET /api/voice-recipients (with service session token)
   → server returns all active depts for company
2. Merges into departmentMap (so incoming mex fromName resolves)
3. Filters: rec.id !== myDeptId (excludes self)
4. Fallback (only on fetch error): Object.values(departmentMap).filter(d=>d.active!==false && d.id!==myDeptId)
   → departmentMap populated at page load via /api/departments; may be stale for deactivated depts
5. Appends hardcoded Floor row (value='__sala__')
```

**Assessment:** Correct endpoint, company isolation preserved, correct self-exclusion. Fallback is stale-data risk but only reachable on network error.

### `buildMexFloorRecipientList()` — sala.html

```
1. Uses Object.values(departmentMap).filter(d => d.active) [line 726]
2. departmentMap is populated by loadDepartments() → GET /api/departments
   → For a floor (non-bound) session, /api/departments returns all company depts (no S1.4 lock applied)
3. No __sala__ row added (floor cannot send to floor — consistent with server)
```

**Assessment:** Using `/api/departments` instead of `/api/voice-recipients` is a **design inconsistency** but functionally correct today because the floor token is not a bound-dept session, so `/api/departments` returns the full list. However, this is fragile:
- If `/api/departments` access policy changes for floor sessions, the recipient list silently breaks.
- The list is populated once at `initializePage()` and never refreshed — **stale data risk** if a department is deactivated while the page is open.
- Server-side validation (`mexActiveDepts`) catches stale sends with `MEX_INVALID_RECIPIENT`, but the client shows only the raw code.

### Stale-data edge cases

| Scenario | Client effect | Server effect |
|----------|---------------|---------------|
| Dept deactivated after page load (dept side) | Stale dept still in recipient list | MEX_INVALID_RECIPIENT on send |
| Dept deactivated after page load (floor side) | Stale dept still in recipient list | MEX_INVALID_RECIPIENT on send |
| /api/voice-recipients fetch fails (dept side) | Falls back to departmentMap (stale) | MEX_INVALID_RECIPIENT if deactivated |
| New dept added after page load | Not visible in recipient list | Send to new dept would succeed if user somehow knew the ID |

---

## D — Real Account / Binding State (Molard)

**Company ID (file key):** `pizzeria molino molard`

### Department Accounts (`data/department-accounts.json`)

| Account ID | loginIdentifier | departmentId | firebaseUid | status | Bound dept name |
|------------|----------------|--------------|-------------|--------|-----------------|
| `depacct_1786365506879_74c626` | `cucina` | `dept_1786363470394_6ddd7d` | **null** | ACTIVE | Kitchen |
| `depacct_1786365711510_35da0a` | `pizzeria` | `dept_1786365688486_b2c66c` | **null** | ACTIVE | Pizzeria |
| `depacct_1786365741465_524d95` | `griglia` | `dept_1786365723774_ac46e1` | **null** | ACTIVE | Griglia |

**No Floor account configured** for this company.

### Department Records (`data/departments.json`)

| dept ID | name | active | departmentType |
|---------|------|--------|----------------|
| `dept_1783374131295_910066` | Pasta | **false** | null |
| `dept_1783374141389_c2e727` | Viande et Poisson | **false** | null |
| `dept_1783374146239_6a37c1` | Pizzeria (old) | **false** | null |
| `dept_1786363470394_6ddd7d` | Kitchen | **true** | null |
| `dept_1786365688486_b2c66c` | Pizzeria | **true** | null |
| `dept_1786365723774_ac46e1` | Griglia | **true** | null |

**Notable absence:** There is **no "Carne e Pesce" department** — active or otherwise — in this company. The former "Viande et Poisson" (French for meat and fish) is the closest match but is **INACTIVE**. The task spec's reference to "Cucina/Pizzeria/Carne e Pesce" does not correspond to the current production state; the active third department is "Griglia".

### Binding resolution path (service login)

For service sessions (loginIdentifier + password), the session token `uid` = `account.id` (e.g. `depacct_...`). `getBoundDepartmentContext()` detects the `depacct_` prefix and routes to `findDepartmentAccountById(session.uid)` — so **`firebaseUid` being null is not a problem**. The binding resolves correctly from the account ID alone.

---

## E — WebSocket Binding

### Normal join sequence

```
client connects → server sends connectionConfirmed + ping
client: WsAuth.joinRoom(ws, myDeptId, callback)
  → ws.send({ action:'joinRoom', token:<HMAC-signed session token> })
server: verifySessionToken(token) → extracts companyName, uid, role
  → ws.isAuthenticated = true; ws.isFloorPrincipal = (session.role === 'floor')
  → getBoundDepartmentContext(session):
       if uid starts with 'depacct_': findDepartmentAccountById(uid)
       else: findDepartmentAccountByUid(uid)
  → if account found:
       if status === 'SUSPENDED': send error + ws.close(4003) → STOP
       if status === 'ACTIVE': ws.boundDepartmentId = account.departmentId
  → ws added to companyRooms.get(companyName)
  → server sends { action:'joinedRoom', success:true }
  → active countdowns synced (filtered by wsSocketMatchesDest)
  → callback invoked (on dept.html: loadMexInbox() if service session)
```

### Stale / phantom binding behaviour

`ws.boundDepartmentId` is set **once at joinRoom time** and is **not re-evaluated per message**. Scenarios:

| Event after joinRoom | Server guard | Effect |
|---------------------|--------------|--------|
| Department deactivated | mexSend: `getCompanyDepts().filter(d=>d.active)` rejects deactivated dept as recipient at send time | Sender still "connected", but sending TO deactivated dept fails MEX_INVALID_RECIPIENT |
| Account suspended (own) | No per-message check on ws.boundDepartmentId validity | Socket stays in room. Sends proceed with stale sender identity until socket closes/reconnects |
| WS reconnect | `getBoundDepartmentContext` re-runs fresh → correct binding re-established | ✓ safe |

**Critical gap (phantom sender):** If a service account is suspended _after_ a socket successfully completes joinRoom, that socket's `ws.boundDepartmentId` remains set. The server will process mexSend/mexReply/mexClose from that socket using the stale identity. This is a low-severity issue in practice (requires an admin suspending an account and the suspended user's page remaining open without a reconnect), but it represents an architectural gap.

### Floor principal

`ws.isFloorPrincipal` set from `session.role === 'floor'` in the HMAC-verified token — client cannot forge this. The floor token is obtained via `GET /api/sala/token` (server-issued, signed). Correct.

---

## F — mexSend Error Matrix

| Code | Condition | Client display | User message quality |
|------|-----------|----------------|---------------------|
| *(none — silent)* | Rate limit exceeded (>5 msgs / 400ms) | Button re-enables silently | **None — invisible failure** |
| `MEX_NOT_BOUND` (action:error) | Sender has no boundDepartmentId and is not Floor | `handleServerError` alert + token clear + redirect | Disruptive — logs out user |
| `MEX_NO_ROOM` | ws.companyRoom null | Raw code in status bar | Poor — raw technical code |
| `MEX_INVALID_TABLE_NUMBER` | QM table type with invalid number | Raw code in status bar | Poor — raw technical code |
| `MEX_EMPTY_BODY` | body trims to empty | Raw code in status bar | Poor (pre-validation should catch client-side first) |
| `MEX_BODY_TOO_LONG` | body > 300 chars | Raw code in status bar | Poor |
| `MEX_NO_RECIPIENT` | data.to empty | Raw code in status bar | Poor |
| `MEX_SELF_SEND` | to === sender | Raw code in status bar | Poor |
| `MEX_INVALID_RECIPIENT` | Dest not in live active list; or floor→floor | Raw code in status bar | **Poor — no human text mapped** |
| `MEX_PERSIST_ERROR` | Firestore/store write failure | Raw code in status bar | Poor |

**Summary:** Only client-side pre-validation codes (C1–C4) are shown with translated user-friendly text. All server-side codes other than the ACCOUNT_SUSPENDED error (which triggers a redirect) are displayed as raw strings. `dept.mexErrorSend` is the only generic fallback shown by `handleMexSendAck` for `data.success===false`.

Actually, correcting the above: `handleMexSendAck` shows `_mt('dept.mexErrorSend')` for any failure, not the raw code. The code is only available in the `data.code` field. The status bar shows the translated generic error message. However the `data.code` is not exposed to the user — no differentiation between "wrong recipient" and "service outage". **Quality: indistinct.**

---

## G — Client Send-State Audit

### department.html

**Button lifecycle:**
```
sendMexMessage() called
→ btn.disabled = true  (before ws.send)
→ mexStatus('dept.mexSending')
→ ws.send(payload)
                     ← handleMexSendAck(data) called
                     → if success: mexStatus('dept.mexSent','ok'), ta.value='', setTimeout 1500ms → mexDeptResetCompose()
                     → if failure: mexStatus('dept.mexErrorSend','err'), btn.disabled = false
```

**Issues:**
1. **Success path:** btn.disabled remains `true` for 1500 ms, then `mexDeptResetCompose()` resets the form including re-enabling via `mexUpdateSendBtn()`. If user opens compose panel again within those 1500 ms, the button is still disabled. Minor UX annoyance, not a data loss risk.
2. **WS not open:** Caught client-side before ws.send, shows error, button not disabled, immediate feedback. ✓
3. **Language switch mid-compose:** QM button labels are rebuilt (`buildMexFloorQmButtons`) but the composed body in `ta` and `prev` is NOT reset. A user who selects "TABLE_DELAY" in Italian then switches to French sees the Italian body text. Since QM bodies are re-rendered only on template re-selection, this is a **stale body risk** after language switch for QM templates.
4. **Back navigation:** `mexDeptGoBack()` from send step to table step resets `_deptMexTableNum` only if returning to QM picker; the body `ta.value` keeps the last-rendered body — harmless since `mexDeptGoToSendStep()` always overwrites it.
5. **Reconnect:** `ws.onclose` triggers `setTimeout(connectWS, 3500)`. During the 3.5 s gap, `mexStatus('dept.mexErrorSend')` is shown if send attempted. On reconnect, no partial state is flushed — compose state persists. If user sends immediately after reconnect before `joinedRoom` ack, the button re-enables and user can send again; the joinRoom callback calls `loadMexInbox()` (backfill only, no compose reset). ✓

### sala.html

**Button lifecycle (floor):**
```
sendMexFromFloor()
→ btn.disabled = true
→ mexFloorStatus('sala.mexSending')
→ ws.send(payload)
                     ← handleMexFloorSendAck(data)
                     → success: status ok, reset compose after 1500ms
                     → failure: status err (generic), btn.disabled = false
```

Pattern is symmetric with dept.html. Same stale-body risk for language switch mid-compose.

---

## H — Quick Message vs CUSTOM Comparison

### Template types defined in `mex-qm.js`

| key | isTableType | body rendered |
|-----|-------------|---------------|
| `TABLE_DELAY` | yes | i18n key `mex.qm.tableDelay` + table number |
| `TABLE_STATUS` | yes | i18n key `mex.qm.tableStatus` + table number |
| `TABLE_URGENT` | yes | i18n key `mex.qm.tableUrgent` + table number |
| `TABLE_HOLD` | yes | i18n key `mex.qm.tableHold` + table number |
| `TABLE_SEND` | yes | i18n key `mex.qm.tableSend` + table number |
| `CUSTOM` | no | free-text textarea |

### Divergence risks

1. **Body vs. templateType mismatch:** The server stores `body` as-is (client-rendered) and `templateType` as metadata. It does **not** re-render the body from the template. If the client renders "Ritardo tavolo 5" (Italian) but sends `templateType: TABLE_DELAY`, the server stores both. If the i18n dictionary changes after the template was rendered but before it was sent, the body may not match what the template would currently produce. **Low risk** (body is the authoritative display text; templateType is analytics-only).

2. **CUSTOM path bypasses templateType:** When `_deptMexQmType === 'CUSTOM'`, client sends no `templateType` and no `tableNumber`. Body is free-text. Server: if no `templateType` in payload, `mexTemplateTypeSafe = null` — stored with templateType null. Consistent. ✓

3. **Table number bypass:** If a user edits the DOM to submit `templateType: TABLE_DELAY` without a `tableNumber`, the server validates: `rawTn` would be empty → `MEX_INVALID_TABLE_NUMBER` rejection. Server-side table number validation is robust. ✓

4. **QM body rendered at template-select time (not send time):** The body is frozen when the user hits "Continue" from the table step. If the locale changes between "Continue" and "Send", the body stays in the language it was rendered in. `templateType` stored alongside let analytics tools know which template was used, but the localised body text is whatever was frozen. This is by design but may cause confusion in multilingual environments.

5. **Read-only preview vs. editable textarea:** For QM templates the textarea is hidden and the preview div shows the body. The preview div is not an `<input>`, so the user cannot edit the body. The `ta.value` is set by `mexDeptGoToSendStep()`. `sendMexMessage()` reads `ta.value` — not the preview div — so the pre-filled `ta.value` is what gets sent. Consistent. ✓

---

## I — Persistence / Queue Audit

### `mex-store.js` queue structure

```js
// Per-company queue — guarantees ordering within a single process
const queues = {};
// Each operation: queues[companyId] = queues[companyId].catch(()=>{}).then(async () => { ... })
```

**Queue entry points:**

| Function | Queue chaining pattern | .catch coverage |
|----------|----------------------|-----------------|
| `createAndSend` | `queues[cid] = getQueue(cid).catch(()=>{}).then(...)` | ✓ prior rejection swallowed before chain |
| `addReply` | `prev = (queues[cid] || Promise.resolve()).catch(()=>{}); queues[cid] = prev.then(...)` | ✓ |
| `closeConversation` | same pattern as addReply | ✓ |
| `getInboxForDept` | `await (queues[cid] || Promise.resolve()).catch(()=>{})` | ✓ (read waits for queue, swallows) |

**Promise chain poisoning risk:** All three write operations prepend `.catch(()=>{})` before chaining. A failed previous operation **does not** poison subsequent ones. Queue resilience is sound.

**Firestore write failure path:**  
`createAndSend` writes to Firestore via a transaction. On failure, the thrown error propagates out of the `.then()` body, rejects the queue entry, is caught by `.catch(e => { ... code ... ws.send(mexSendAck failure) })` in the server handler. **The in-memory store update (`mexStore[companyId].conversations[conv.id] = conv`) happens before the Firestore write.** If Firestore fails, the conversation exists in memory but is not persisted. On server restart, that conversation is lost. This is an **at-most-once** persistence guarantee, not at-least-once.

**Cap enforcement:**  
`MEX_MAX_BODY_LENGTH = 300` enforced at server handler level (not just store). `MEX_CONV_CAP` and `MEX_MSG_CAP` constants were not found in the store — no hard cap on conversation count per company; storage growth is unbounded unless pruned externally.

---

## J — Reconnect / Reload Audit

### `department.html` WS lifecycle

```
ws.onclose → setTimeout(connectWS, 3500)
ws.onerror → ws.close()
connectWS(): new WebSocket → onopen → WsAuth.joinRoom(ws, myDeptId, callback)
  → callback: if isServiceSession(): loadMexInbox() (backfill from /api/service/mex/inbox)
```

**`boundDepartmentId` on reconnect:** `joinRoom` always calls `getBoundDepartmentContext(session)` fresh from the current account store. If the account was suspended since the last join, the server rejects with `ACCOUNT_SUSPENDED` and closes the socket (code 4003). If the account is still active, binding is re-established correctly. **No stale boundDepartmentId across reconnects.** ✓

**Backfill correctness:** `loadMexInbox()` fetches all open conversations for this dept and re-populates `mexInboxMessages` and `mexCdCards`. Cards already present are skipped (`mexCdCards.has(cardKey)` guard). ✓

**Session token expiry:** The HMAC token is used for joinRoom. If the session cookie/token expires during the page session, the next reconnect's joinRoom will fail with `TOKEN_INVALID` → `handleServerError` alerts + redirects. The 3.5 s reconnect loop does not perform session refresh before retrying joinRoom. This means after token expiry, the client will loop: reconnect → joinRoom → TOKEN_INVALID → redirect. One loop iteration at most. ✓

**Compose state on reconnect:** Not cleared. Unsent in-flight message (button disabled) will stay disabled until the button is explicitly reset. Since the WS closed before the ack arrived, `handleMexSendAck` will never fire for that message. The button stays disabled and the user is stuck. **UX gap**: no timeout/reset path for a send that was in-flight when WS dropped.

**sala.html WS lifecycle:** Same pattern (sala uses countdowns.js shared WS; reconnect via `ws.onclose → setTimeout(connectWS, 3500)` in countdowns.js). Floor inbox backfill via `GET /api/service/mex/floor-inbox`. ✓

---

## K — Real Department Diagnostic Matrix (Molard)

Company: `pizzeria molino molard`  
Active departments: Kitchen (cucina), Pizzeria (pizzeria), Griglia (griglia)  
Active Floor (sala): **none configured**

| Flow | Sender account | Sender dept | Recipient | Evidence | Status |
|------|---------------|-------------|-----------|----------|--------|
| cucina → pizzeria | `depacct_…74c626` ACTIVE | `dept_…6ddd7d` Kitchen ACTIVE | `dept_…b2c66c` Pizzeria ACTIVE | Both account and both depts ACTIVE; binding resolves via findDepartmentAccountById | **PASS** |
| cucina → griglia | same | Kitchen ACTIVE | `dept_…ac46e1` Griglia ACTIVE | Same logic | **PASS** |
| cucina → Floor | same | Kitchen ACTIVE | `__sala__` | No sala.html session token configured for Molard (no floor account exists) | **UNKNOWN** — Floor page not usable without sala token setup |
| pizzeria → cucina | `depacct_…35da0a` ACTIVE | Pizzeria ACTIVE | Kitchen ACTIVE | All valid | **PASS** |
| pizzeria → griglia | same | Pizzeria ACTIVE | Griglia ACTIVE | All valid | **PASS** |
| pizzeria → Floor | same | Pizzeria ACTIVE | `__sala__` | Same: no Floor session | **UNKNOWN** |
| griglia → cucina | `depacct_…524d95` ACTIVE | Griglia ACTIVE | Kitchen ACTIVE | All valid | **PASS** |
| griglia → pizzeria | same | Griglia ACTIVE | Pizzeria ACTIVE | All valid | **PASS** |
| griglia → Floor | same | Griglia ACTIVE | `__sala__` | No Floor session | **UNKNOWN** |
| Floor → cucina | N/A | `__sala__` | Kitchen | No floor account → sala.html cannot authenticate | **UNKNOWN** |
| Floor → pizzeria | N/A | `__sala__` | Pizzeria | same | **UNKNOWN** |
| Floor → griglia | N/A | `__sala__` | Griglia | same | **UNKNOWN** |
| "Carne e Pesce" → any | N/A | Does not exist | any | No active dept by this name; old "Viande et Poisson" is INACTIVE | **FAIL** — dept/account absent |

**Summary:** All 6 Dept→Dept flows are PASS. All 6 Floor-related flows are UNKNOWN (no sala session configured for Molard). The "Carne e Pesce" mapping in the task spec is incorrect — that department is absent; the active third dept is "Griglia".

---

## L — Existing Test Coverage Gaps

### Test files reviewed

| File | Lines | What it proves |
|------|-------|---------------|
| `mex-step3.test.js` | 128 | Unit: store `createAndSend` happy path, cap, Firestore mock |
| `mex-step3-ws.test.js` | 429 | WS integration: mexSend → mexSendAck + mexIncoming; invalid body; invalid recipient; floor→floor rejection; participant-only delivery |
| `mex-step4-render.test.js` | ~200 | DOM: `insertMexCdCard`, `renderMexInbox` for dept and sala |
| `mex-step5-render.test.js` | ~150 | DOM: Floor compose flow rendering |
| `mex-step5-ws.test.js` | 493 | WS: Floor sender token, Dept→Floor, Floor→Dept, participant-only, non-participant exclusion |
| `mex-step6-qm.test.js` | 195 | QM template validation, tableNumber server-side check, metadata stored |
| `mex-step7-ws.test.js` | 367 | WS: mexReply, mexReplyAck, mexReplyIncoming, participant-only delivery |
| `mex-step7-qr.test.js` | ~120 | DOM: QR (reply) button rendering |
| `mex-step8-lifecycle.test.js` | 425 | WS: mexClose, mexCloseAck, mexClosed, alreadyClosed idempotency |
| `mex-step8-render.test.js` | ~150 | DOM: close button state changes |
| `mex-recipients.test.js` | 252 | REST: `/api/voice-recipients` auth, company isolation, active filter |
| `mex-qm-labels.test.js` | ~80 | QM i18n label resolution |

### Coverage gaps

| Gap | Risk | Notes |
|-----|------|-------|
| **Rate-limiter + mexSend interaction** | High | No test verifies that a mexSend dropped by the rate limiter sends no client response (silent failure). No test for the UX regression this causes. |
| **Stale boundDepartmentId (account suspended mid-session)** | Medium | No test: socket joinRoom succeeds, then account is suspended, then mexSend is attempted. Current code would process the send with the stale identity. |
| **Dept deactivated between joinRoom and mexSend (recipient)** | Medium | Tests cover recipient validation live, but not the scenario where a recipient was valid at page-load and becomes invalid later (no test for the client-side stale `mex-recipient-list` showing deactivated dept). |
| **sala.html buildMexFloorRecipientList using /api/departments** | Medium | No test verifies that the floor recipient list is correct vs. what `/api/voice-recipients` would return, nor that a stale dept appears in the list after deactivation. |
| **In-flight message on WS disconnect** | Medium | No test: button stays disabled permanently when WS drops during an in-flight mexSend with no ack. |
| **mexClose using wss.clients vs. companyRooms** | Low | No cross-company test for mexClose fanout. `wss.clients` filtered by `client.companyRoom !== closeCompanyId` should be safe, but it is O(total_connections) not O(company_connections). |
| **No "Carne e Pesce" / Molard Floor account scenarios** | Informational | Tests use synthetic accounts. No test covers a company where the floor is fully unconfigured. |
| **MEX_PERSIST_ERROR Firestore rev conflict** | Medium | `createAndSend` handles Firestore transaction failure and sends mexSendAck(false, code). No integration test for rev conflict under concurrent write. |
| **Backfill after reconnect with existing cards** | Low | `loadMexInbox` after reconnect: `mexCdCards.has` guard tested in render tests but not in a full reconnect-cycle WS integration test. |

---

## M — Logging Adequacy

### What is logged

| Event | Log message | Sufficient? |
|-------|-------------|-------------|
| joinRoom token missing | `⛔ [SECURITY] joinRoom rejected — no session token` | ✓ |
| joinRoom token invalid | `⛔ [SECURITY] joinRoom rejected — invalid or expired token` | ✓ |
| joinRoom token valid | `🔑 [SECURITY] joinRoom authenticated: uid=..., company=...` | ✓ |
| joinRoom dept-bound | `🔒 [S1.5] WS socket locked to dept "..." (...)` | ✓ |
| mexSend invalid recipient | `⛔ [MEX] mexSend rejected — invalid/inactive recipient "..." for company "..."` | ✓ |
| mexSend success | `[MEX] conv=... from=... to=... company=...` | ✓ |
| mexSend persist error | `[MEX] Send error (code): message` | ✓ |
| mexReply success | `[MEX-REPLY] conv=... reply=... from=... to=... company=...` | ✓ |
| mexClose success | `[MEX-CLOSE] conv=... by=... company=... alreadyClosed=...` | ✓ |
| Rate limit exceeded | `⚠️ Rate limit superato, messaggio scartato` | **Partial** — no WS message, no indication of which action was dropped |
| mexSend MEX_SELF_SEND | *(no log)* | **Missing** |
| mexSend MEX_EMPTY_BODY | *(no log)* | **Missing** |
| mexSend MEX_NO_RECIPIENT | *(no log)* | **Missing** |
| mexSend MEX_BODY_TOO_LONG | *(no log)* | **Missing** |
| mexSend MEX_INVALID_TABLE_NUMBER | *(no log)* | **Missing** |
| mexSend MEX_NOT_BOUND | *(no log — inline error only)* | **Missing** |

### Diagnosability assessment

**Can a failed production send be diagnosed from logs alone?**

- If it reaches the server and fails with `MEX_INVALID_RECIPIENT`: **Yes** — logged with company and recipient.
- If it fails with `MEX_PERSIST_ERROR`: **Yes** — error details logged.
- If it is silently dropped by the rate limiter: **Partial** — "rate limit exceeded" appears in server log but with no action type, company, or session identity. Cannot determine if the dropped message was a mexSend.
- If the send never reaches the server (client pre-validation, WS not open): **No** — only browser console logs; no server-side trace.
- If MEX_EMPTY_BODY / MEX_SELF_SEND / other early rejections: **No** — not logged server-side.

**Recommendation for a future task (not implemented here):** Add a single-line log at the top of the mexSend handler: `[MEX] mexSend attempt: sender=... to=... company=... templateType=...` and add brief log lines for each early rejection code. This would make any failed send fully diagnosable from server logs alone.

---

## N — Exact Root Causes Found (Evidence-Backed)

### N1. Silent failure on rate limiter hit during mexSend

**Evidence:** server.js lines 5164–5175: when `ws.messageCount > 5` within 400 ms, the message handler returns immediately with only `console.log('⚠️ Rate limit superato, messaggio scartato')`. No WS frame is sent back. The client's `handleMexSendAck` is never invoked. The send button stays disabled. The message is irretrievably lost from the user's perspective.

**Triggering condition:** Any operator who clicks "Send" more than 5 times within 400 ms (e.g., repeated rapid taps or a stuck-key event). Not common, but the failure mode is completely invisible.

### N2. "Carne e Pesce" department does not exist for Molard

**Evidence:** `data/departments.json` for company `pizzeria molino molard` lists no "Carne e Pesce" department, active or inactive. The former "Viande et Poisson" (`dept_1783374141389_c2e727`, French for the same concept) is `active: false`. The task specification's mention of "Carne e Pesce" does not correspond to any current entity. The active third department is "Griglia" (`dept_1786365723774_ac46e1`), with a bound account (`griglia`/`depacct_…524d95`).

### N3. Floor messaging flows are fully unconfigured for Molard

**Evidence:** No Floor (sala) session is possible without a user authenticating to sala.html, which requires a Firebase account that then obtains a floor token via `/api/sala/token`. No floor-role account or session binding exists in the production data for this company. All 6 Floor-related flows are UNKNOWN. This is not a bug — the floor feature may simply not have been set up for this restaurant.

### N4. Stale compose body after language switch (QM templates)

**Evidence:** department.html `mexDeptGoToSendStep()` renders the body at "Continue" time and stores it in `ta.value`. The i18n lang-switch listener (`document.click` on `.i18n-lang-btn`) only calls `buildMexFloorQmButtons()` (sala.html) or rebuilds the QM picker (dept.html), but does **not** re-render a body already frozen in `ta.value`. If an operator selects TABLE_DELAY in Italian (body: "Ritardo tavolo 5"), then switches to French before sending, the Italian body is sent.

**Severity:** Low — body is the display text; both parties see the sent body regardless of locale. No data loss, no security impact.

### N5. Phantom sender socket after mid-session account suspension

**Evidence:** server.js: `ws.boundDepartmentId` set at joinRoom time (line 5280) is never re-verified per message. `mexSend` handler derives `mexSender = ws.boundDepartmentId` without a live account lookup. If an admin suspends the account after the socket's joinRoom succeeds, that socket continues to send mex messages attributed to the (now-suspended) account until it reconnects.

**Severity:** Medium. Impacts access control for account suspension semantics. Mitigated by the calendar broadcast's live-authorization pattern (lines 1867–1873) which was not applied to Mex.

### N6. In-flight send leaves button permanently disabled on WS drop

**Evidence:** `sendMexMessage()` sets `btn.disabled = true` before `ws.send()`. If the WS closes at that moment, `handleMexSendAck` is never called, and `btn.disabled` is never reset to `false`. The form is stuck. Reconnect (`onopen → WsAuth.joinRoom → loadMexInbox`) does not reset compose state.

**Severity:** Low-medium. Affects UX only; no data corruption. Operator must reload the page.

---

## O — Safest Minimal Fix Recommendations

### O1. Rate limiter: send mexSendAck failure instead of silent drop

When `ws.messageCount > 5` and the dropped action is `mexSend`, send:
```json
{ "action": "mexSendAck", "success": false, "code": "RATE_LIMITED" }
```
before returning. This unblocks the send button and surfaces the error to the user. One-line change in the rate limiter block after determining `data.action`.

### O2. Add server-side log for all mexSend early rejections

After each early `ws.send(mexSendAck failure)` + return in the mexSend handler, add a `console.log('[MEX-REJECT] code=... sender=... company=...')` line. Enables production diagnosis from server logs alone.

### O3. Reset compose button if WS closes during in-flight send

In `ws.onclose` (department.html and sala.html), add:
```js
const btn = document.getElementById('mex-send-btn');
if (btn && btn.disabled) { btn.disabled = false; mexStatus('', ''); }
```
This unblocks the UI on disconnect without data loss.

### O4. sala.html: use `/api/voice-recipients` for floor recipient list

Change `buildMexFloorRecipientList()` to fetch `/api/voice-recipients` (same endpoint as dept.html) instead of relying on the potentially-stale `departmentMap`. This is a one-function change that aligns Floor with Department behaviour.

### O5. Live-verify boundDepartmentId on mexSend (address phantom sender)

In the mexSend handler, after deriving `mexSender`, add a live account check:
```js
if (ws.departmentAccountId) {
  const liveAcct = departmentAccounts.findDepartmentAccountById(ws.departmentAccountId);
  if (!liveAcct || liveAcct.status !== 'ACTIVE') {
    ws.send(JSON.stringify({ action: 'mexSendAck', success: false, code: 'ACCOUNT_SUSPENDED' }));
    ws.close(4003, 'ACCOUNT_SUSPENDED');
    return;
  }
}
```
Mirrors the calendar broadcast live-auth pattern already in the codebase (lines 1867–1873).

---

## P — Files / Data That Would Need Modification

| Item | Change needed | Sections |
|------|---------------|---------|
| `server.js` | Rate limiter: send mexSendAck failure on rate-limited mexSend; add mexSend rejection logs; optional: live-verify boundDepartmentId | O1, O2, O5 |
| `public/department.html` | WS onclose: reset send button if disabled | O3 |
| `public/sala.html` | `buildMexFloorRecipientList()`: use `/api/voice-recipients` | O4 |
| *(data)* | If Floor flows are wanted: configure a Firebase user + `/api/sala/token` for Molard | K |
| *(data)* | "Carne e Pesce" dept: if needed, create new dept + account under Molard | K, N2 |

---

## Q — Regression Tests Required for Each Proposed Fix

### For O1 (rate limiter sends mexSendAck on mexSend)
- `mexSend` sent as the 6th message within 400 ms → `mexSendAck(success:false, code:'RATE_LIMITED')` received by sender
- Earlier mexSends (≤5) within 400 ms → processed normally
- mexSend after rate limit window resets → processed normally
- Non-mexSend actions rate-limited → no mexSendAck (different handler)

### For O2 (rejection logs)
- Static code analysis / test that all early-return paths in mexSend handler produce a `console.log` or equivalent
- *(No runtime regression test needed)*

### For O3 (button reset on WS close)
- Send button disabled (btn.disabled=true), then ws.onclose fires → btn.disabled becomes false and status clears
- Normal send (WS stays open) → btn not prematurely re-enabled during in-flight wait

### For O4 (sala floor recipient list uses /api/voice-recipients)
- Floor session: `buildMexFloorRecipientList()` calls `/api/voice-recipients`, not `/api/departments`
- Floor session: deactivated dept removed from recipient list after deactivation (live fetch on next compose panel open)
- Floor session: recipient list excludes `__sala__` (floor cannot message floor)
- Floor session: all active sibling depts appear in the list

### For O5 (live-verify sender on mexSend)
- Account ACTIVE at joinRoom, still ACTIVE at mexSend → proceed normally
- Account ACTIVE at joinRoom, suspended before mexSend → `mexSendAck(false, 'ACCOUNT_SUSPENDED')` + ws.close(4003)
- Floor principal → live check skipped (no departmentAccountId) → proceed

---

## Appendix: Observation Notes

- **`mexClose` delivery uses `wss.clients`** (global set) instead of `companyRooms.get(companyId)`. It guards with `client.companyRoom !== closeCompanyId` so cross-company leakage is blocked. However, the O(total_connections) scan is less efficient than O(company_connections). This is not a correctness bug but a scalability concern for future note.

- **`/api/voice-recipients` is the correct, stable endpoint** for any session type needing the full active-dept directory. The decision to use it in `buildMexRecipientList()` (dept.html) and not in `buildMexFloorRecipientList()` (sala.html) is an inconsistency introduced at different sprint stages.

- **All Molard dept accounts have `firebaseUid: null`.** This is expected — they use service login (`loginIdentifier` + password). The `getBoundDepartmentContext` function correctly routes via `findDepartmentAccountById` for `depacct_` prefix UIDs. No binding issue.

- **`departmentType: null` for all Molard depts.** `getDepartmentType()` would return null/undefined. This only matters for calendar access (`requireCalendarAccess` requires `CENTRAL` type). Mex messaging does not gate on departmentType. No impact on Mex flows.

- **No active conversation data was read** (out of scope for this audit — we examined only the store code, not live conversation contents).
