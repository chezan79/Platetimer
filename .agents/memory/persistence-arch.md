---
name: Persistence architecture
description: How PlateTimer stores data, what survives restarts vs. deploys, and how to fix Railway data loss.
---

## Storage model (Firestore = single source of truth)

**When `FIREBASE_ADMIN_SERVICE_ACCOUNT` is set (production):**
- Firestore is the ONLY persistent store — `saveJSON()` never writes local files when `db` is connected.
- On startup: `initializeDataStores()` reads each store from Firestore before `server.listen()`.
- If Firestore has data → use it, ignore local files completely.
- If Firestore is empty → one-time migration from local JSON file → write to Firestore → done.
- Per-store Firestore errors → emergency fallback to local file for THAT store, loud warning logged.

**When `FIREBASE_ADMIN_SERVICE_ACCOUNT` is NOT set (local dev):**
- Falls back to local JSON files in `DATA_DIR` with a loud startup warning banner.
- `saveJSON()` writes local files only.
- Data is ephemeral on Railway in this mode.

**In-memory stores** (`departmentsStore`, `plansStore`, `calendarEventsStore`, `calendarNotifStore`):
- Initialize as `{}` at module evaluation time (NOT from `loadJSON`).
- Populated exclusively by `initializeDataStores()` before the server accepts requests.
- Runtime working copy; every mutation persisted immediately via `saveJSON()`.

## Data stores

| File | Firestore doc | Contents |
|------|---------------|---------|
| `data/departments.json` | `departments` | Company departments, keyed by companyId |
| `data/plans.json` | `plans` | Company plan (base/medium/premium), keyed by companyId |
| `data/calendar-events.json` | `calendar_events` | Calendar events, keyed by companyId |
| `data/calendar-notif.json` | `calendar_notifs` | Calendar notifications, keyed by companyId |

Firestore collection: `platetimer_stores`, one document per store name above.

## In-memory (transient — always lost on restart, by design)

- `activeCountdowns` — Map of active countdown timers. Intentionally transient; countdowns last minutes not hours.
- `companyRooms` — WebSocket connection rooms. Transient by design.
- `authenticatedSessions`, `rateLimiter` — Runtime state.

## Credential separation (HARD RULE — do not mix)

| Secret | Project | Purpose |
|--------|---------|---------|
| `FIREBASE_ADMIN_SERVICE_ACCOUNT` | `app-dati-tavoli` | Firestore Admin SDK only |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | `feisty-coder-461119-r0` | Google Cloud Speech only |

`initFirestoreAdmin()` reads ONLY `FIREBASE_ADMIN_SERVICE_ACCOUNT`. It hard-validates that `svcAccount.project_id === 'app-dati-tavoli'` before calling `initializeApp()`. If the var is missing, invalid JSON, or wrong project, `db` stays `null` and Firestore is skipped entirely — no fallback to the Speech credential.

**Why:** Using the Speech SA (`feisty-coder-461119-r0`) for Firestore fails with PERMISSION_DENIED because that project has Firestore API disabled and the SA has no IAM role on `app-dati-tavoli`. This was the root cause of all Firestore failures.

## Setup instructions for Railway persistence

**Option A — Firestore (primary, recommended):**
1. Firebase Console → `app-dati-tavoli` → Project Settings → Service Accounts → Generate new private key → download JSON
2. Railway: add secret `FIREBASE_ADMIN_SERVICE_ACCOUNT` = full contents of that JSON file
3. On next deploy `initializeDataStores()` migrates any existing local data to Firestore automatically.
4. All subsequent writes go to Firestore only — survives unlimited deployments.

**Option B — Railway Volume (zero-credential alternative):**
1. Railway Dashboard → your service → Volumes → Add Volume → Mount path: `/data`
2. Add env var: `DATA_DIR=/data`
3. Files in `/data` survive every future deployment.
4. No Firestore needed, but data is only on that one Railway region's disk.

## Why firebase-admin v14 needs submodule imports

`admin.credential`, `admin.apps` are `undefined` in v14. Correct usage:
```javascript
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
```
