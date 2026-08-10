---
name: Operations Sprint 5 realtime
description: WebSocket broadcast architecture, broadcastOps() placement, OpsRealtime.js client, and test waitFor() consume semantics.
---

# broadcastOps() placement

`companyRooms` is declared at line ~2965 (after the ops module ends at ~2960).
`broadcastOps()` is a `function` declaration placed right after `companyRooms`.
The ops HTTP endpoints (lines ~1625–2960) call `broadcastOps()` from route-handler callbacks — callbacks only execute after all top-level code runs, so `companyRooms` is always initialized by then. No hoisting issue.

**Why:** ops endpoints must be defined before `companyRooms` (by file structure); function declarations are hoisted but `const` is not — the reference inside the callback (not at definition time) is what matters.

# broadcastOps() behavior

- Reads `companyRooms.get(companyId)` — company isolation is server-side, never client-supplied.
- Skips rooms with 0 clients (no-op, no log).
- Logs `📡 [OPS-RT] <action> → "<companyId>" (N clients)` only when ≥1 client receives.
- Silent per-client send errors — WS delivery is best-effort; HTTP is source of truth.

# Events emitted per endpoint

| Endpoint | Event |
|---|---|
| POST /users (invite) | OPS_USER_CREATED |
| PUT /users/:id | OPS_USER_UPDATED |
| POST /users/:id/suspend | OPS_USER_SUSPENDED |
| POST /users/:id/reactivate | OPS_USER_RESTORED |
| POST /users/:id/archive | OPS_USER_ARCHIVED |
| POST /users/:id/restore | OPS_USER_RESTORED |
| DELETE /users/:id | OPS_USER_DELETED (carries userId only, not full user) |
| POST /activate | OPS_INVITATION_ACCEPTED |
| POST /tasks | OPS_TASK_CREATED |
| PUT /tasks/:id | OPS_TASK_UPDATED |
| PATCH /tasks/:id | OPS_TASK_UPDATED |
| POST /tasks/:id/start | OPS_TASK_UPDATED |
| POST /tasks/:id/progress (pct<100) | OPS_TASK_PROGRESS |
| POST /tasks/:id/progress (pct=100) | OPS_TASK_COMPLETED |
| POST /tasks/:id/complete | OPS_TASK_COMPLETED |
| POST /tasks/:id/reassign | OPS_TASK_REASSIGNED (+ prevAssigneeId) |
| POST /tasks/:id/cancel | OPS_TASK_UPDATED |
| POST /tasks/:id/comments | OPS_COMMENT_ADDED (+ taskId + comment) |

# OpsRealtime.js (public/js/operations-realtime.js)

IIFE module, window.OpsRealtime. API:
- `init()` — starts WS; retries up to 30×500ms waiting for token in sessionStorage.
- `reconnect()` — force reconnect after token update.
- `on(action, fn)` / `off(action, fn)` — subscribe to OPS_* events. Use '*' for all.
- `toast(msg, type)` — toast with types: ok/warn/info/danger. Auto-dismiss at 4.2s.
- `highlight(el)` — brief indigo flash on a DOM element.

All pages include it after ws-auth.js and operations-common.js. Each page calls `OpsRealtime.init()` and wires `rtReload(delay)` debounce to re-run their existing `load()` / `loadTasks()` / `loadUsers()` function.

# Test waitFor() consume semantics

The test's `wsConnect()` helper uses a CONSUME model:
- `buffer[]`: unmatched incoming messages (shrinks when consumed by waitFor).
- `received[]`: full history, never shrinks — used for count/isolation assertions.
- `waitFor(action)` first checks `buffer` for matching message and SPLICES it out.
  If not found, registers a waiter. When message arrives, direct-deliver to waiter (not buffered).

**Why:** Without consume semantics, a `waitFor('OPS_TASK_UPDATED')` call finds the stale buffered event from an earlier operation (e.g., start → IN_PROGRESS) instead of waiting for the new one (e.g., PATCH → URGENT). This caused false negatives in S5-30 and S5-35.

# Test counts

- Sprint 5: 46/46
- All prior suites: 372/372
- Total: **418/418**
