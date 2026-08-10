---
name: Operations Sprint 6.0 Intelligence Engine
description: Rule-based intelligence engine architecture, API, alert rules, load score formula, and test patterns.
---

# Module

`operations/ops-intelligence.js` — pure analysis module, no I/O, no external APIs.
Exported: `analyzeIntelligence(companyId, { tasks, users }) → { attention, workload, suggestions, summary }`.
Also exports `_computeLoadScore`, `_loadStatus`, `_LOAD_BUSY`, `_LOAD_OVERLOADED` for unit tests.

# effectiveStatus

Computed internally in the module (mirrors server.js `opsTaskWithComputedStatus`).
Raw tasks from `getOpsTasks()` are passed in — the module maps them through `withEffectiveStatus()` itself.

# Load score formula

`score = assigned×1 + overdue×3 + urgent×2`

Thresholds: NORMAL < 5, BUSY 5–9, OVERLOADED ≥ 10.

# Alert rules (attention)

| Severity | Trigger |
|---|---|
| HIGH | Task overdue ≥ 30 min (`OVERDUE_HIGH_MIN = 30`) |
| HIGH | URGENT task with status OPEN (not started) |
| HIGH | SUSPENDED user still has OPEN/IN_PROGRESS tasks |
| MEDIUM | Active user with `currentLoadScore ≥ 10` (OVERLOADED) |
| MEDIUM | ≥ 2 URGENT tasks in same department (`URGENT_DEPT_THRESHOLD = 2`) |
| LOW | IN_PROGRESS task not updated for > 4 hours (`INACTIVE_HRS = 4`) |

Sorted HIGH → MEDIUM → LOW in output.

# Suggestion types

`REASSIGN_BALANCE` — overloaded user, movable task, normal candidate.
`REASSIGN_SUSPENDED` — suspended user with active tasks.
`REVIEW_DEPT` — department with ≥ 2 urgent tasks.
`COMPLETE_RECURRING` — overdue recurring task (has templateId).

# API endpoint

`GET /api/operations/intelligence` — Director only (`canManageUsers`).
Passes raw `getOpsTasks()` and `getOpsUsers()` to the engine; no Firestore writes.

# Dashboard (director)

Added to `public/operations-director.html`: section with 4 sub-panels (Allerta, Riepilogo, Carico, Suggerimenti).
CSS in `public/css/operations.css` (`.intel-section`, `.intel-alert`, `.intel-wl-row`, `.intel-sum-grid`, `.intel-sug`).
Added 4th call to the `load()` Promise.all → `renderIntelligence(intelRes)`.

# Test patterns (Sprint 6)

- Port 4460, SECRET `test-sprint6-secret`.
- Director-only 403 test: use a UID not in the ops store while company already has users → `requireOpsAuth` returns 403. No Firebase needed.
- Suspended user test: invite user (INVITED status) → assign tasks → call suspend endpoint (works on non-ACTIVE users too). No Firebase needed.
- Module-level role check: `require('../operations/ops-intelligence')._loadStatus(score)` for formula verification.

**Why:** The `activate` endpoint requires a real Firebase ID token and calls the Google Identity Toolkit API. Tests cannot simulate it without credentials. Use invite-only flows and ghost-UID tokens for role/access checks.

# Test counts

- Sprint 6: 52/52
- All prior suites: 418/418
- Total: **470/470**
