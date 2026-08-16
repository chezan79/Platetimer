# Mex Step 1 — Architecture Audit

Technical report for safely replacing the Intercom/PTT feature with **Mex**, a real-time text messaging feature, in later steps. No functional changes were made in this step; this document is analysis only.

---

## A. Files involved

Files likely to be touched by later Mex steps:

| File | Role for Mex |
|---|---|
| `public/department.html` | Add Mex tab + section; wire send UI + incoming cards; later remove PTT tab/section/glue |
| `public/sala.html` | Add Mex panel for the Floor (virtual `__sala__` participant) |
| `public/js/ptt-voice.js` | **Removal target** (Intercom-only; delete in final step, do not modify before) |
| `public/js/ws-auth.js` | Reused as-is (session token, `joinRoom`, error handling) — no changes expected |
| `public/js/countdowns.js` | Reused as-is; possibly add an `onMexMessage` callback hook mirroring `onVoiceMessage` |
| `public/js/i18n.js` | Reused as-is |
| `public/i18n/it.json`, `fr.json`, `en.json` | Add `mex.*` keys (later step) |
| `server.js` | New Mex REST endpoints + WS handlers (`mexMessage`, `mexAck`, `mexClose`); later remove PTT signaling block |
| `data/` (new file, e.g. `data/mex-conversations.json`) | New file-persisted store following existing pattern |
| `data/departments.json` | Read-only reference (recipient validation) — not modified |

---

## B. Intercom dependency map

### Intercom-only symbols (safe to remove in the final Mex step)

**Client — `public/js/ptt-voice.js` (entire file, 319 lines):**
- `PttVoice` IIFE module: `VOICE_ROOM = 'main'`, `_peers` WebRTC peer map, `join`, `leave`, `startTalking`, `stopTalking`, `handleSignal`, `onWsReconnect`.
- Its microphone acquisition (`getUserMedia`) is internal to the module and **separate** from Voice Messages' own recording code — deleting the file does not affect Voice Messages.

**Client — `public/department.html`:**
- PTT CSS block (lines ~185–209).
- `#tab-ptt` button in the tab strip (631–635) and the `'ptt'` entry in `showTab()`'s tab array (~1108).
- PTT section `#section-ptt` (762–784): `#ptt-join-btn`, `#ptt-btn`, `#ptt-status`, `#ptt-talking-ind`.
- `<script src="js/ptt-voice.js">` (line 849).
- PTT glue functions (1408–1458): `pttSetStatus`, `pttSetTalkingInd`, `pttToggleCall`, `pttPress`, `pttRelease`.

**Server — `server.js`:**
- WS signaling handlers ~5826–6000: `joinVoice`, `leaveVoice`, `offer`, `answer`, `ice-candidate`, `talkingStart`, `talkingStop`, plus outbound `voicePeers` / `voicePeerJoined` / `voicePeerLeft`.
- The `isVoiceMessage` **rate-limit exemption** list naming those seven actions (~5087–5095). Note: this is *not* an authentication allowlist — it only exempts WebRTC signaling from the 400ms/5-message rate limiter. Authentication is enforced separately by the `PUBLIC_ACTIONS` gate (`['ping','pong','joinRoom']`, ~5139–5140): any other action from an unauthenticated socket is rejected; once authenticated, arbitrary actions reach the dispatcher without per-action allowlisting.
- Any PTT voice-room bookkeeping referenced only by those handlers.

### Shared with Voice Messages (must be preserved)

- `public/department.html`: `SALA_ID` const (~1120), `buildVoiceDestList()` (1121–1154), recording/send functions (1179–1300), `handleVoiceMessage` (~1340), `dismissVoice` (~1372), `renderVoiceMessages` (~1381), `#voice-msg-list` / `#voice-msgs-section`.
- `public/sala.html`: voice panel (144–233), `buildVoiceDestList` (431–450), `sendVoiceMsg` (~549), `handleVoiceMessage` (~600), subscription with `onVoiceMessage` callback (744–761).
- `server.js`: `POST /api/voice-message` REST handler (~5563), WS `voiceMessage` / `deleteVoiceMessage` handlers (~5585–5678), `GET /api/voice-recipients` (~926–953).

Note: despite the similar naming, "Voice Messages" (recorded audio clips) and "PTT/Intercom" (live WebRTC) share **no code** beyond both living behind tabs in `department.html`. The only overlap risk is human error while deleting.

### Shared with broader Service functionality (must not touch)

- WS infrastructure: `companyRooms` Map (~4814), connection handler (~5016), `joinRoom` auth flow, `joinPage` (~5292), disconnect cleanup (~6012), `wsSocketMatchesDest()` (~475–479), heartbeat/ping.
- `public/js/ws-auth.js` (`WsAuth.joinRoom`, `isServiceSession`, `handleServerError`), `public/js/countdowns.js` (`CountdownsModule` connect/reconnect/dispatch, `getWebSocket()`).
- Auth: `requireAuth`, HMAC token sign/verify, `getBoundDepartmentContext`, `departmentAccessError`, `resolveDeptAccountContext`.
- Countdown, calendar, Operations, and department-account code paths.

---

## C. Floor / `__sala__` representation

The Floor ("sala") is a **virtual recipient with a synthetic identifier**, not a real department record:

- `public/sala.html:297` — `const SALA_ID = '__sala__'` (comment notes it is shared with the server). The page sends voice messages with `from: SALA_ID` and filters incoming by `dests.includes(SALA_ID)`. Its `buildVoiceDestList` (431–450) builds from real departments only and does **not** add `__sala__` to its own list (Floor never messages itself). It subscribes to WS with `pageType: SALA_ID`.
- `public/department.html` — `buildVoiceDestList()` (1121–1154) fetches `/api/voice-recipients`, filters out its own `myDeptId`, then **appends** `{ id: '__sala__', label: Floor }` so departments can address the Floor.
- `server.js` — destination validation in both the REST handler (`SALA_VIRTUAL_ID` block, ~594–606) and WS `voiceMessage` handler (~5602–5615) **always permits `__sala__`** as a destination and as a `from` value, while every other id must be an active department of the authenticated company.
- `__sala__` never appears in `data/departments.json` and has no department-account binding; sala sessions are legacy/unbound sockets (no `boundDepartmentId`).

**Mex implications:** Mex must treat `__sala__` as a first-class conversation participant. Server validation must whitelist it exactly like the voice-message handlers do. As *sender*, a sala socket has no `boundDepartmentId`; the voice handlers currently fall back to `ws.pageType` (client-supplied) — Mex must NOT reuse that fallback. Today **no session field distinguishes a Floor session from any other unbound authenticated session**, so a server-verifiable Floor principal (signed role claim or dedicated Floor account, set as `ws.isFloorPrincipal` during `joinRoom`) is a prerequisite for Mex — see §E.2. Client-side, department.html appends the Floor entry to the recipient list; sala.html excludes itself.

---

## D. Countdown integration point

- `#cd-list` (department.html line ~815) is the countdown card container; `renderCards()` (~2043) fully re-renders it, producing `<div class="cdc ${lv}">` cards with `.cdc-tbl-num`, `.cdc-time`, `.cdc-prog`, `.cdc-meta`.
- **Do not inject Mex cards into `#cd-list`**: `renderCards()` rebuilds its innerHTML on every tick, so any foreign nodes would be wiped.
- Existing precedent: Voice Messages render into their own container `#voice-msg-list` **reusing the `.cdc` card class**, and Task-66 ops tasks use the same `.vm-section` + card pattern (`#ops-tasks-section`). This is the proven, safe approach.

**Recommendation:** give Mex its own section (`#mex-section` with `#mex-list`), styled by reusing the `.cdc` card CSS (plus a small `mex`-specific modifier class), placed alongside `#voice-msgs-section` in the right-hand area. Zero risk to countdown rendering, consistent look and feel.

---

## E. WebSocket strategy

Reuse the existing architecture unchanged:

1. **Room join flow** — sockets authenticate via `WsAuth.joinRoom` (signed HMAC session token → server sets `ws.isAuthenticated`, `ws.companyRoom`, and for bound accounts `ws.boundDepartmentId`; server confirms with `{action:'joinedRoom'}`), then `joinPage` sets `ws.pageType` (server re-asserts `boundDepartmentId` for bound accounts, ignoring the client value). **No new room type is needed** — `companyRooms` keyed by company is sufficient.
2. **Authoritative sender — do NOT copy the voice-message fallback chain.** The existing voice pattern `ws.boundDepartmentId || ws.pageType || data.from` is only authoritative for **bound** sockets. For unbound sockets both `pageType` (client-supplied via `joinPage`) and `data.from` are client-controlled, so a legacy or sala socket can impersonate any sender — an existing legacy limitation that Mex must not inherit. Mex sender resolution must be:
   - **Bound department account** (`ws.boundDepartmentId` set): sender = `ws.boundDepartmentId`. Never read a client field.
   - **Floor**: sender = `__sala__` only when `ws.isFloorPrincipal === true`, a server-side flag set exclusively during `joinRoom` from a server-issued claim (see "Floor principal prerequisite" below).
   - **Anything else** (unbound socket, including admin sessions): reject the `mexMessage`. Do not fall back to `data.from` or `ws.pageType`.

   **Floor principal prerequisite (must be built before Mex send works from sala).** No existing session field can establish Floor identity: the HMAC session token payload carries only `uid` and `companyName`; there is no server-side Floor/sala claim, and the client-side `WsAuth.isServiceSession()` (which merely detects the `depacct_` uid prefix) is a routing hint, never an authorization input. `ws.pageType`, `data.from`, and client `isServiceSession()` are therefore **prohibited** as authorization inputs for Mex. Two viable designs, in order of preference:
   1. **Signed role claim** — extend the HMAC session token payload with a server-assigned `role` (e.g. `role: 'floor'`) set at the point the sala session is issued (the sala login/entry flow). During `joinRoom`, after HMAC verification, the server sets `ws.isFloorPrincipal = (session.role === 'floor')`. The claim is inside the signed payload, so it cannot be forged; token issuance must set `role: 'floor'` only on the sala entry path, never on request from the client.
   2. **Dedicated Floor account** — create a first-class Floor principal per company (analogous to a department account but mapped server-side to `__sala__`), so `joinRoom` resolves it like `getBoundDepartmentContext` does and sets `ws.isFloorPrincipal` from the server record.
   The same rule applies to Mex **REST** endpoints: `requireAuth` must yield the role/principal claim, and `from = '__sala__'` is accepted only when the verified session carries the Floor claim; bound accounts always send as their bound department; other sessions are rejected as Mex senders.
   **Required tests:** an authenticated unbound/admin session (no Floor claim, no binding) must be rejected when attempting to send a Mex message as `__sala__` or as any department id, over both WS and REST; a bound account must be unable to send as any id other than its own.
3. **New WS event names** — `mexMessage` (new message in a conversation), `mexAck` (read/acknowledge), `mexClose` (close conversation). No per-action registration is needed for authenticated sockets — the only gate is `PUBLIC_ACTIONS = ['ping','pong','joinRoom']` (~5139), which already blocks unauthenticated clients from any `mex*` action; simply add the new `else if` branches to the dispatcher. Do not add Mex actions to the `isVoiceMessage` rate-limit exemption — the standard rate limiter is appropriate for text messages.
4. **Delivery filtering — Mex needs its own recipient predicate; do NOT reuse `wsSocketMatchesDest` or the voice broadcast rule.** `wsSocketMatchesDest(socket, destinations)` returns `true` for **every unbound socket** (legacy departments, sala, unbound admin sessions) and, for bound sockets, matches destinations only — it does not include the sender. The voice-message broadcast has the same unbound-sockets-receive-everything behaviour. Reusing either for Mex would leak every conversation in the tenant to all unbound authenticated sockets, including a Floor socket that is not a participant. Instead, define a Mex-specific predicate based on the socket's **server-derived effective principal**:
   - effective principal = `ws.boundDepartmentId`, or `__sala__` when `ws.isFloorPrincipal === true`, else **none**;
   - deliver `mexMessage` / `mexAck` / `mexClose` to a socket only when its effective principal is in the conversation's `participants` (sender included, since the sender is a participant);
   - sockets with no effective principal (unbound legacy/admin sessions) receive **nothing** — if admin visibility is ever wanted, it must be a separate, explicitly authorized policy, not a default.
   **Required tests:** an unrelated bound department, an unbound/admin session, and a Floor session that is not a participant must each receive none of `mexMessage`, `mexAck`, or `mexClose` for a conversation they are not part of; participants (including the sender) must receive all three.
5b. **Authorization matrix — every inbound operation, WS and REST alike, must resolve the caller's server-derived effective principal (§E.2), look up the conversation only within the session's verified company, and verify participant membership before mutating.** Delivery filtering alone is insufficient: without these checks a bound department could ack or close any same-tenant conversation by guessing its ID.

   | Operation | Precondition (after `requireAuth` / authenticated WS) |
   |---|---|
   | **create** | caller has an effective principal (bound dept or Floor); server **forces** the caller's principal into `participants` regardless of client payload; every other participant validated as active dept of the session company or `__sala__` |
   | **send** (`mexMessage` / POST message) | conversation exists in caller's company AND caller's principal ∈ `participants` AND conversation not closed; `from` always overwritten with caller's principal |
   | **ack** (`mexAck` / POST ack) | conversation exists in caller's company AND caller's principal ∈ `participants`; `readBy` keyed by caller's principal only |
   | **close** (`mexClose` / POST close) | conversation exists in caller's company AND caller's principal ∈ `participants` |
   | **list / fetch** | returns only conversations of caller's company where caller's principal ∈ `participants`; principals-less sessions get an empty list or 403 |

   Wrong-company lookups and non-participant callers must fail identically (404/403 without leaking existence). **Required negative tests:** bound dept A cannot send/ack/close/fetch a conversation between depts B and C in the same company (WS and REST); a session with no principal cannot perform any Mex mutation; create with a spoofed `participants` list still records the caller's true principal as a participant.
5. **Reconnect** — `CountdownsModule` reconnects every 3s and re-runs `WsAuth.joinRoom`; since Mex delivery is room+participant based (not subscription based), a reconnected socket automatically resumes receiving. The client should re-fetch open conversations via REST after `joinedRoom` to fill any gap.

---

## F. Persistence recommendation

Follow the established pattern's *interface* (in-memory object + `DATA_DIR` JSON file for local dev + Firestore in production), but with one deliberate deviation: **Mex persistence must be partitioned per company from the outset** — one Firestore document per company (`mex_conversations_<companyId>` in `STORE_COLLECTION`), not the shared single-document model the other stores use. Rationale: message stores grow with usage in a way config stores do not; a single shared document has an unbounded tenant dimension and would inevitably hit Firestore's 1 MiB document limit, after which `saveJSON`'s fire-and-forget `.catch(log)` would silently drop every Mex write platform-wide. Per-company partitioning makes the byte budget enforceable per tenant (see below) and confines any overflow to one company.

In local-dev mode (no `db`), keep a single `data/mex-conversations.json` file holding the company-keyed map — file size is not constrained locally.

**Wiring (deviates from the shared-store registration).** Because Mex uses per-company documents, it must NOT be routed through `getStoreNameForFile` / the shared `stores` array in `initializeDataStores` (those map one file → one document). Instead the Mex store module provides its own two functions mirroring the existing semantics:
- `saveMexCompany(companyId)` — with `db`: write the company document (canonical schema and key below); without `db`: rewrite `data/mex-conversations.json` (whole company-keyed map).
- `initMexStore()` / `loadMexCompany(companyId)` — with `db`: lazy-load each company's document on first access (avoids listing all documents at boot); without `db`: `loadJSON(MEX_CONVERSATIONS_FILE)` at startup from the `initializeDataStores().then(...)` chain.

**Document key — never use the raw company name.** Company names are arbitrary user-facing strings and may contain `/` or other characters invalid in Firestore document IDs; a raw-name key would make persistence fail for those tenants. Use a deterministic encoding: `docId = 'mex_' + crypto.createHash('sha256').update(companyId).digest('hex').slice(0, 32)`, and store the verified `companyId` **inside** the document for auditability/recovery.

**Canonical persisted schema (one shape, byte accounting measures exactly this):**
```js
// Firestore doc STORE_COLLECTION/mex_<sha256(companyId)[0:32]>
{
  companyId: '<verified company name>',
  rev: <integer, incremented on every save>,
  updatedAt: <epoch ms>,
  conversations: { [conversationId]: Conversation }   // === mexStore[companyId].conversations
}
```
`MEX_MAX_COMPANY_BYTES` is measured in **UTF-8 bytes** as `Buffer.byteLength(JSON.stringify(<this whole document object>), 'utf8')` before each save — never `String.prototype.length`, which counts UTF-16 code units and undercounts non-ASCII/emoji content, admitting documents that exceed Firestore's real byte limit.

**Serialized per-company persistence protocol (fire-and-forget is NOT acceptable here).** The generic `saveJSON` is fire-and-forget with last-writer-wins; for a messaging store two successive `set()` calls can complete at Firestore out of order, letting an older snapshot overwrite a newer message/ack/close. Mex must instead keep a **per-company async queue** (a promise chain, e.g. `queues[companyId] = queues[companyId].then(op)`):
1. *Load*: the first operation for a company enqueues the lazy load; all subsequent operations for that company await the same queue, so no handler ever runs against missing/stale state and no double-load races occur.
2. *Mutate + save*: each mutation runs on the queue as `mutate in memory → enforce caps → increment rev → await Firestore write`. The local promise queue guarantees ordering **only within one Node process**. Since the deployment target (Railway) can run more than one instance, the awaited write must be a **Firestore transaction with a revision precondition**: read the document's current `rev` inside the transaction, abort if it does not equal the expected previous `rev`, otherwise write `rev+1`; on precondition failure, re-load the remote document, re-apply the mutation on top of it, and retry (bounded retries, then surface the persistence error per the failure policy). A plain `set()` is acceptable only if the deployment is provably single-instance — the transaction path is the required default.
3. *Failure policy*: if the awaited write fails, the handler must NOT report success or broadcast the WS event — respond with an explicit persistence error (REST 503 / WS `error` action) and roll back or mark the in-memory mutation dirty for retry on the next operation. Success responses and `mexMessage`/`mexAck`/`mexClose` broadcasts are emitted **only after** the write resolves.

If a later implementer prefers the shared-document model anyway, that is **rejected by this audit** — the failure mode (permanent, silent, platform-wide write loss at 1 MiB) is not acceptable for a messaging feature.

**Store shape (single, authoritative — no alternatives):** in-memory `mexStore = { [companyId]: { conversations: { [conversationId]: Conversation } } }`, with `messages` embedded as an array inside each Conversation. One company ↔ one Firestore document whose `conversations` field is exactly `mexStore[companyId].conversations` (canonical persisted schema above).

**Hard caps (constants, enforced at write time in the store module):**

| Constant | Value |
|---|---|
| `MEX_MAX_OPEN_CONVERSATIONS` (per company) | 30 |
| `MEX_MAX_CLOSED_RETAINED` (per company) | 50 |
| `MEX_MAX_MESSAGES_PER_CONVERSATION` | 200 (oldest evicted) |
| `MEX_MAX_BODY_LENGTH` | 500 chars (rejected, not truncated) |
| `MEX_AUTO_CLOSE_HOURS` (open conversations) | 24 h |
| `MEX_CLOSED_TTL_DAYS` (then deleted) | 7 days |

**Byte budget:** worst case per message ≈ 2.2 KB in UTF-8 (500 chars can be up to ~2,000 UTF-8 bytes when fully non-ASCII/emoji, JSON-escaped, plus ~200 bytes of ids/metadata). Worst case per conversation ≈ 200 × 2.2 KB + ~1 KB envelope ≈ 441 KB — far above any per-count guarantee, so the count caps alone cannot bound the document. The authoritative bound is the **per-company byte cap**: `MEX_MAX_COMPANY_BYTES = 700 KB`, measured in UTF-8 bytes as `Buffer.byteLength(JSON.stringify(<canonical persisted document object>), 'utf8')` before each save. When a mutation would exceed it, evict oldest closed conversations first, then oldest messages of the oldest open conversation; if still over (pathological), reject the mutation with an explicit error. 700 KB leaves ≥ 300 KB headroom under Firestore's 1 MiB limit for Firestore field-name/encoding metadata overhead.

**Concurrency/atomicity:** Node's single thread makes the *in-memory* mutate-and-enforce-caps step atomic, but that alone is insufficient. Within a process, ordering comes from the per-company promise queue; across processes, ordering comes from the mandatory Firestore transaction with `rev` precondition + rebase-and-retry (protocol step 2). Success responses and broadcasts happen only after the transaction commits.

**Overflow behavior:** hitting `MEX_MAX_OPEN_CONVERSATIONS` or the byte-cap rejection returns an explicit error to the caller (surfaced in UI); never silently truncate.

Capacity/concurrency tests are mandatory in the persistence step: cap enforcement, oldest-eviction order, auto-close, byte-cap eviction then rejection **including multi-byte (emoji/non-ASCII) bodies verifying UTF-8 accounting**, interleaved send/ack on the same conversation preserving message order and caps, and a cross-writer conflict test (stale `rev` → transaction precondition failure → rebase-and-retry preserves both writers' mutations).

Minimum data structures:

```js
// Conversation
{
  id: 'mexconv_<random>',
  companyId: '<companyName>',            // always from verified session
  participants: ['dept_a', '__sala__'],  // dept ids and/or '__sala__'
  createdAt: '<ISO>',
  createdBy: '<server-derived sender id>',
  closedAt: null | '<ISO>',              // state
  readBy: { '<participantId>': '<ISO of last read>' }
}

// Message
{
  id: 'mexmsg_<random>',
  conversationId: 'mexconv_…',
  from: '<server-derived sender id>',
  body: '<text>' ,
  templateKey: null | 'mex.tpl.<key>',   // for canned/i18n-templated messages
  timestamp: '<ISO>'
}
```

Messages are embedded in the Conversation (`messages: [Message]`) per the authoritative store shape above; retention/caps are enforced at write time per the table above (not merely at load time).

---

## G. Risk list

1. **PTT removal collateral** — `ptt-voice.js` is Intercom-only, but Voice Messages code sits interleaved in the same `department.html`. When removing the PTT tab/section/glue, do not touch `buildVoiceDestList`, recording/send, `handleVoiceMessage`, or `renderVoiceMessages`; do not modify `ptt-voice.js` before the final removal step.
2. **`myDeptId` from URL / client-controlled sender** — department.html reads `myDeptId = params.get('id')` from the query string (~894). This must **never** be trusted as the Mex sender. Moreover, the existing voice-message fallback (`ws.boundDepartmentId || ws.pageType || data.from`) is itself impersonable for unbound sockets (see §E.2) — Mex must use only `ws.boundDepartmentId` or the server-verified `ws.isFloorPrincipal` flag, and reject all other senders. `ws.pageType`, `data.from`, and client-side `isServiceSession()` are prohibited as authorization inputs; the Floor principal (signed role claim or dedicated account) must exist before sala can send Mex messages.
3. **`__sala__` must remain a permitted destination/sender** — Mex validation must replicate the `SALA_VIRTUAL_ID` whitelist in both REST and WS handlers; treating it as an unknown department would break the Floor.
4. **WS reconnect** — after `countdowns.js` reconnects and `joinedRoom` fires, the Mex client must re-fetch open conversations (REST) to recover messages missed while offline; room delivery alone does not backfill.
5. **Tenant isolation & delivery scope** — all Mex broadcasts must iterate only `companyRooms.get(ws.companyRoom)` and apply the Mex-specific effective-principal participant predicate from §E.4. `wsSocketMatchesDest` must NOT be reused: it delivers to all unbound sockets and ignores the sender, which would leak conversations tenant-wide. `companyId` must always come from the HMAC-verified session, never the client payload.
6. **Bound-account lockdown parity** — SUSPENDED accounts and inactive departments must get the same 403/410 (`departmentAccessError`) treatment on Mex endpoints as `/api/voice-recipients` (S1.4/S1.5) enforces.
7. **`renderCards()` innerHTML rebuild** — Mex cards must live in their own container, never inside `#cd-list` (see §D).
8. **WS gates** — the only authentication gate is `PUBLIC_ACTIONS` (~5139); `mex*` actions are automatically blocked for unauthenticated sockets and need no registration there. The seven-action list at ~5087–5095 is a rate-limit exemption only; Mex actions should stay under the normal rate limiter.
9. **Firestore persistence wiring** — Mex must NOT rely on the generic `saveJSON` path: with Firestore active, an unregistered file gets a `null` store name and is silently persisted nowhere (the `db` branch never falls back to local files), and unregistered stores are never loaded at startup. Mex uses its own per-company-document save/load functions with byte-budget enforcement (§F); the shared single-document model is explicitly rejected for Mex.
10. **i18n dictionary integrity** — the three `public/i18n/*.json` files are easily corrupted by appending after the closing brace; JSON-validate all three after adding `mex.*` keys.

---

## H. Proposed implementation sequence

Small, independently shippable steps:

1. **UI shell** — add Mex tab + empty `#mex-section` (with `#mex-list`) to `department.html` and an empty Mex panel to `sala.html`; extend `showTab()`; no behavior.
1b. **Floor principal** — implement the server-verifiable Floor identity (§E.2): signed `role: 'floor'` claim in the sala session token (or dedicated Floor account), `ws.isFloorPrincipal` set in `joinRoom`, plus tests that non-Floor unbound/admin sessions cannot claim `__sala__`. Prerequisite for steps 2–4.
2. **Persistence + REST** — Mex store module with per-company Firestore documents (`saveMexCompany`/`initMexStore`), hard caps, byte budget, and retention exactly per §F (this storage decision is fixed before any endpoint work); endpoints: create conversation, list open conversations, post message, ack, close — each enforcing the §E.5b authorization matrix (company-scoped lookup, participant membership, caller principal forced into `participants`/`from`), S1.4 lockdown parity; §E.5b negative-authorization tests plus §F capacity/concurrency tests are mandatory in this step, before Step 3.
3. **WS handlers** — `mexMessage`, `mexAck`, `mexClose` dispatcher branches with company-room broadcast filtered by the Mex-specific effective-principal participant predicate (§E.4 — not `wsSocketMatchesDest`); sender resolved per §E.2 (bound dept id or server-verified Floor, otherwise reject); normal rate limiter applies; delivery-scoping tests from §E.4 included.
4. **Send UI** — recipient picker built from `/api/voice-recipients` (+ `__sala__` on department.html), template/free-text composer, wire to REST/WS.
5. **Incoming rendering** — Mex cards in `#mex-list` reusing `.cdc` CSS; live updates via a `onMexMessage`-style callback in `countdowns.js` dispatch; re-fetch on `joinedRoom` (reconnect backfill).
6. **i18n** — add `mex.*` keys to `it/fr/en.json`, `data-i18n` attributes on all new markup; validate JSON.
7. **Sound alert** — audible notification on incoming Mex message (respecting existing sound conventions).
8. **Remove PTT** — delete `ptt-voice.js`, PTT tab/section/CSS/glue in `department.html`, server signaling handlers (~5826–6000) and their rate-limit exemption entries (~5087–5095); run full test suite to confirm Voice Messages untouched.
