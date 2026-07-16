---
name: Persistence architecture
description: How PlateTimer stores data, what survives restarts vs. deploys, and how to fix Railway data loss.
---

## Storage layers (in priority order)

1. **Firestore Admin SDK** (`platetimer_stores` collection, `firebase-admin` v14 submodule API)
   - Requires `FIREBASE_ADMIN_SERVICE_ACCOUNT` env var (Firebase Console → Project Settings → Service Accounts → Generate new key)
   - Falls back gracefully to local files if unavailable
   - Every `saveJSON()` call fires a Firestore write (fire-and-forget)
   - On startup: `initializeDataStores()` loads from Firestore and merges local files → migrates data up automatically

2. **Local JSON files** (`DATA_DIR`, default `./data/`)
   - Always written synchronously on every save (fast, synchronous backup)
   - Ephemeral on Railway (container replaced on each deploy)
   - Configurable via `DATA_DIR` env var → supports Railway Volumes

## Data stores

| File | Firestore doc | Contents |
|------|---------------|---------|
| `data/departments.json` | `departments` | Company departments, keyed by companyId |
| `data/plans.json` | `plans` | Company plan (base/medium/premium), keyed by companyId |
| `data/calendar-events.json` | `calendar_events` | Calendar events, keyed by companyId |
| `data/calendar-notif.json` | `calendar_notifs` | Calendar notifications, keyed by companyId |

## In-memory (transient — always lost on restart)

- `activeCountdowns` — Map of active countdown timers. Intentionally transient; countdowns last minutes not hours.
- `companyRooms` — WebSocket connection rooms. Transient by design.
- `authenticatedSessions`, `rateLimiter` — Runtime state.

## Credential situation

- `GOOGLE_APPLICATION_CREDENTIALS_JSON` — service account from project `feisty-coder-461119-r0` (used for Google Cloud Speech API). This project does NOT have Firestore API enabled. Do NOT use this for Firestore.
- `FIREBASE_ADMIN_SERVICE_ACCOUNT` — the correct credential to set for Firestore persistence. Must be from the Firebase project (`app-dati-tavoli`).

## To fix Railway data loss

**Option A — Railway Volumes (zero dependencies, recommended first step):**
1. Railway Dashboard → your service → Volumes → Add Volume → Mount path: `/data`
2. Add env var: `DATA_DIR=/data`
3. Done. Files in `/data` survive every future deployment.

**Option B — Firestore (cross-environment persistence, backup for volumes):**
1. Firebase Console → `app-dati-tavoli` → Project Settings → Service Accounts → Generate new private key → download JSON
2. In Railway: add secret `FIREBASE_ADMIN_SERVICE_ACCOUNT` = contents of that JSON file
3. On next deploy, `initializeDataStores()` loads all data from Firestore automatically.

## Why firebase-admin v14 needs submodule imports

`admin.credential`, `admin.apps` are `undefined` in v14. Correct usage:
```javascript
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
```
