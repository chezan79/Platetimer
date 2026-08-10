---
name: Service S1.5 WebSocket Department Locking
description: Per-socket Department Account context stored on WS join; countdown/voice/PTT delivery filtered server-side; suspended accounts rejected at joinRoom.
---

# New Socket Metadata (set in joinRoom after HMAC session verification)

| Property | Source | Notes |
|---|---|---|
| `ws.boundDepartmentId` | `account.departmentId` (server record) | null for unbound legacy |
| `ws.departmentAccountId` | `account.id` | null for unbound |
| `ws.departmentAccountStatus` | `account.status` | null for unbound |
| `ws.boundDepartmentName` | dept record name | used in PTT deptName override |

`ws.pageType` is pre-locked to `boundDepartmentId` in `joinRoom` before the countdown sync, so `joinPage` cannot override it for bound accounts.

# New Helper

`wsSocketMatchesDest(socket, destinations)` — returns true if socket should receive a message. Returns true unconditionally for unbound sockets (backward compat). For bound sockets, returns true iff `destinations.includes(socket.boundDepartmentId)`.

# Suspended Account Behavior

SUSPENDED bound accounts at joinRoom → error `{ action: 'error', code: 'ACCOUNT_SUSPENDED' }` + `ws.close()`.  Socket is never added to companyRooms.

# Handler Changes

| Handler | Change |
|---|---|
| `joinRoom` countdown sync | `wsSocketMatchesDest` filter before send |
| `joinPage` | bound accounts: `ws.pageType = ws.boundDepartmentId`; countdown sync filtered |
| `startCountdown` validation | bound accounts must have `boundDepartmentId` in destinations or rejected (`DEPT_NOT_IN_DESTINATIONS`) |
| `startCountdown` broadcast | `wsSocketMatchesDest(client, destinations)` filter per client |
| `deleteCountdown` | save `deletedDestinations` before deleting; filter broadcast same way; **key uses `normalizeTableNumber()` not `.toString()`** (pre-existing bug fixed) |
| `voiceMessage` | source = `ws.boundDepartmentId \|\| ws.pageType \|\| data.from`; deliver only if client's bound dept in destinations OR is source |
| `joinVoice` | bound: `ws.voiceRoom = ws.boundDepartmentId`; unbound: `data.room.toLowerCase()` |
| `talkingStart` | outgoing deptName = `ws.boundDepartmentName \|\| data.deptName` |

# Untouched (company-wide operational signals)

`pausaCucina`, `annullaPausaCucina`, `pausaInsalata`, `annullaPausaInsalata`, `deleteVoiceMessage`, WebRTC signaling (`offer`/`answer`/`ice-candidate`/`leaveVoice`), OPS_* events — all unchanged.

# Key Gotcha: deleteCountdown key normalization

`normalizeTableNumber` lowercases alphanumeric table keys (e.g. `'T-SYNC'` → `'t-sync'`).  `startCountdown` stored the countdown under the normalized key, but the original `deleteCountdown` looked up with `.toString()` (no normalization) — never found → destinations were null → no filter.  **Both lookup and broadcast must use `normalizeTableNumber()`.**

# Test File

`tests/service-s1-5.test.js` — 43 tests, port 5094.  Uses `openWs()` helper with a message-queue/waitFor pattern.  Voice locking test uses fresh depts D4/D5 (D1/D2 already have their one active account each — creating a second returns 409).

# Key WS Test Constraint

`notReceived(pred, timeout)` waits `timeout` ms and returns true if nothing matches.  For timing-sensitive negative assertions, keep timeout short (300–400 ms) to avoid making the test suite slow; increase if the server is CPU-bound during test setup.
