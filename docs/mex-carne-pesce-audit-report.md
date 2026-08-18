# Mex Audit — "Carne e Pesce" Send/Receive Failure (pizzeria molino molard)

**Task 96 · Read-only diagnostic · 2026-08-18**
No code, data, or Firestore records were modified. Firestore was queried read-only via the Admin SDK.

---

## Critical discovery: local JSON ≠ production Firestore

Firestore (`platetimer_stores`, project `app-dati-tavoli`) is the authoritative store in production
(`FIREBASE_ADMIN_SERVICE_ACCOUNT` present → `db` initialised → local files never read).
The workspace's `data/*.json` files are **stale dev-fallback copies and describe a different department set**.

| Source | Departments (active) |
|---|---|
| Local `data/departments.json` | Kitchen `dept_1786363470394_6ddd7d`, Pizzeria `dept_1786365688486_b2c66c`, Griglia `dept_1786365723774_ac46e1` |
| **Firestore `departments` doc (production)** | **Cucina `dept_1784278620048_3d142d` (CENTRAL), Pizzeria `dept_1784278626582_fe0814`, Carne pesce `dept_1784278637201_e53d6c`** |

The plan's pre-finding ("is it Griglia or Viande et Poisson?") is resolved: **neither**. The real
production department is **"Carne pesce" = `dept_1784278637201_e53d6c`**, which exists only in Firestore.
None of the three local-JSON department IDs exist in the production departments store.

---

## A — Actual Carne e Pesce identity (production / Firestore)

| Field | Value |
|---|---|
| Department id | `dept_1784278637201_e53d6c` |
| Name | `Carne pesce` |
| active | `true` |
| departmentType | STANDARD (no `departmentType` field → default) |
| Account id | `depacct_1786457198496_4f11e0` |
| Account displayName | `Carne pesce` |
| loginIdentifier | **`cucina2`** |
| firebaseUid | `null` (service-login only, S2.1 `depacct_` session) |
| Account status | `ACTIVE` |
| companyId | `pizzeria molino molard` |

Nothing in this record is broken: department active, account ACTIVE, binding intact.

## B — Working control departments (production)

| Field | Cucina | Pizzeria |
|---|---|---|
| Dept id | `dept_1784278620048_3d142d` (active, CENTRAL) | `dept_1784278626582_fe0814` (active) |
| Account | `depacct_1786457165515_c9dd87` | `depacct_1786457180841_3e341f` |
| loginIdentifier | `cucina1` | `pizzeria1` |
| firebaseUid / status | null / ACTIVE | null / ACTIVE |

**Trap discovered:** the Firestore `department_accounts` store contains **6 accounts** — the three
working ones above plus three **stale accounts** (`cucina`, `pizzeria`, `griglia` →
`depacct_1786365506879_74c626`, `depacct_1786365711510_35da0a`, `depacct_1786365741465_524d95`)
whose `departmentId`s (`dept_17863…`) **do not exist in the production departments store at all**.
These are the accounts mirrored in the stale local JSON. Any device logged in with one of them is
bound to a phantom department.

## C — Recipient discovery (`/api/voice-recipients`, server.js:937)

- Endpoint returns `getCompanyDepts(companyId).filter(d => d.active)` → in production:
  Cucina, Pizzeria, **Carne pesce** — all three present. **PASS** for any session.
- Guard at line 952: if the session's bound account's `departmentId` is not in the active list →
  **410 `DEPARTMENT_INACTIVE`**. A device logged in with a stale account (`cucina`/`pizzeria`/`griglia`)
  hits this 410 → the Mex recipient selector fails to populate at all (matches "cannot send" symptom).
- A device logged in as `cucina2` would receive all three recipients correctly.

## D — Send trace: Carne e Pesce → siblings

For a socket correctly bound to `dept_1784278637201_e53d6c` (login `cucina2`):

1. `mexSender = ws.boundDepartmentId` → set (gate 5766) — PASS
2. Recipient validation: Cucina and Pizzeria are in `mexActiveDepts` — PASS
3. `createAndSend` — no cap issues (13 conversations, well under 30 open / 700 KB) — PASS
4. Participant delivery predicate — PASS structurally.

**Evidence of actual behaviour:** the Firestore Mex doc (rev 27) contains **zero conversations ever
created by `dept_1784278637201_e53d6c`** (`createdBy` never equals it). Carne e Pesce has **never
successfully sent** a Mex message. Cucina and Pizzeria have many (all from `dept_17842…` IDs, proving
those devices use `cucina1`/`pizzeria1`).

## E — Receive trace: siblings → Carne e Pesce

- Cucina's selector shows Carne pesce (§C) — PASS.
- Send validation passes (dept active) — PASS, **proven**: `mexconv_99b8db9d9aec5eed`
  (Cucina → Carne pesce, "❓ A che punto è il tavolo 33?", 2026-08-18T17:02Z) is **persisted and still open/unanswered**.
- Delivery predicate requires a recipient socket with `boundDepartmentId === dept_1784278637201_e53d6c`.
  If the Carne e Pesce device is logged in with the stale `griglia` account, its socket is bound to
  the phantom `dept_1786365723774_ac46e1` → predicate fails → `mexIncoming` never delivered. **FAIL (inferred)**.
- REST backfill `/api/service/mex/inbox` uses the same bound dept id → returns empty for a
  stale-bound session. Same failure point.

## F — Floor ↔ Carne e Pesce

- Floor → Carne pesce: identical to §E — send/persist would succeed; delivery depends on correct binding.
  Firestore shows Floor conversations only with Cucina/Pizzeria — none with Carne pesce.
- Carne pesce → Floor (`__sala__`): would pass all gates (recipient `__sala__` whitelisted for dept
  senders) **if** the device could reach the compose UI; with a 410 on `/api/voice-recipients` the
  selector never renders. No such conversation exists in the store.
- Floor delivery uses `client.isFloorPrincipal` (role:'floor' in signed token), independent of the bug — unaffected.

## G — WebSocket binding lifecycle (joinRoom, server.js:5253–5295)

- `ws.boundDepartmentId = wsBoundAcct.departmentId` (5280) is set from the **account record without
  verifying the department exists/is active**. For a stale account, the socket is silently bound to a
  phantom dept id; `wsBoundDept` lookup (5283) returns `undefined`, only affecting
  `boundDepartmentName` (null) and type (default STANDARD). Log line `[WS-DIAG] joinRoom dept-bound … found=false`
  would confirm this at runtime.
- Reconnect repeats the same resolution — the stale binding persists across reconnects.
- For the correct `cucina2` account the binding is fully healthy.

## H — Persistence / inbox

- No local `data/mex-conversations.json` exists; Firestore Mex doc `mex_<sha256>` is the store (rev 27).
- **Case B of the brief confirmed:** messages TO Carne pesce ARE persisted (`mexconv_99b8db9d9aec5eed`,
  open, 0 replies) even though they were evidently never seen. Persistence layer: PASS.

## I — Client rendering

`department.html`: `mexIncoming` → `handleMexIncoming` (2810) → `insertMexCdCard` (2739) → `#cd-list`.
- No client-side filtering by department id or name; unknown `from` falls back to the raw id string.
- Dedup key is `msg.convId || msg.id` — correct, cannot drop a first delivery.
- `sala.html` mirrors the same logic. **Rendering layer: PASS (no defect found).**

## J — Diagnostic matrix

| # | Flow | Verdict | Evidence |
|---|---|---|---|
| 1 | CP identity/data record valid | PASS | Firestore dept active + account ACTIVE (§A) |
| 2 | CP appears in siblings' recipient list | PASS | §C endpoint logic + Firestore active list |
| 3 | Sibling → CP send validation | PASS | Persisted conv `mexconv_99b8db9d9aec5eed` |
| 4 | Sibling → CP persistence | PASS | Same conversation, open in store |
| 5 | Sibling → CP real-time delivery | FAIL (inferred) | Message open/unanswered; requires correctly-bound socket |
| 6 | CP inbox backfill (REST) | FAIL (inferred) | Same bound-dept dependency; message unseen |
| 7 | CP → sibling send | FAIL | Zero conversations ever created by CP dept id in store |
| 8 | CP recipient discovery on device | FAIL (inferred) | Stale binding → 410 DEPARTMENT_INACTIVE (§C) |
| 9 | Floor ↔ CP | FAIL (inferred) | No Floor–CP conversation exists; same binding dependency |
| 10 | Client rendering (dept + sala) | PASS | No filtering; dedup safe (§I) |

UNKNOWN (needs runtime evidence): which loginIdentifier the physical Carne e Pesce device actually
uses. Production logs (`[WS-DIAG] joinRoom dept-bound … found=false`, or `⛔ [MEX]` lines) or asking
the operator would confirm.

## K — Root cause

**Account/session mismatch, not a code defect.** All evidence converges: the production data is
healthy; sends *to* Carne pesce validate and persist but are never delivered/read, and Carne pesce has
never sent. The only mechanism consistent with all observations is that the Carne e Pesce device is
**logged in with one of the three stale department accounts (most plausibly `griglia`), whose
`departmentId` does not exist in the production departments store**, while the working devices use the
new `cucina1`/`pizzeria1` accounts. The stale binding causes: 410 on recipient discovery (can't send),
participant-predicate miss on delivery (can't receive live), and empty inbox backfill (can't receive
at all). Final confirmation of the device's login remains UNKNOWN (see §J) — everything else is proven.

## L — Safest minimal fix (recommendation only)

1. **Zero-code fix:** log the Carne e Pesce device out and log in with `cucina2` (the account bound to
   the real production department). Verify with a test message both directions.
2. **Hygiene (low-risk data change):** archive/delete the three orphaned accounts
   (`cucina`, `pizzeria`, `griglia`) whose departments no longer exist, so no device can bind to a phantom dept.
3. **Defensive hardening (small code change, optional):** in joinRoom, when
   `wsBoundDept` is not found/active, reject the session (or emit a structured error) instead of
   silently binding to a phantom department — mirroring the existing 410 behaviour of the REST layer.

## M — Files / data that a fix would touch

- Data only (options 1–2): Firestore `platetimer_stores/department_accounts` (remove/suspend 3 orphaned accounts). No files.
- Option 3: `server.js` joinRoom block (~5266–5295) + a note in `docs/mex-architecture-audit.md`.
- Local `data/departments.json` / `data/department-accounts.json` are stale dev fixtures — consider refreshing or clearly marking them, but they play no role in production.

## N — Regression tests required for a future fix

1. **Orphan-binding test:** account whose `departmentId` is absent from the departments store →
   joinRoom must not produce a deliverable Mex principal; `/api/voice-recipients` → 410; `mexSend` blocked with a structured code.
2. **Recovery test:** after re-login with the correct account, both send and receive succeed and the
   REST inbox backfills previously persisted conversations (e.g. the still-open Cucina → CP message).
3. **Coverage gap (confirmed):** all Mex tests (`mex-step3/5/6/7/8`, `mex-recipients`) create synthetic
   companies (`ristorante`, `coA`/`coB`) with freshly created, always-consistent dept/account pairs.
   None exercises an account→department dangling reference, which is exactly the production failure mode.
   Add a fixture with an orphaned account to the recipients + WS suites.
