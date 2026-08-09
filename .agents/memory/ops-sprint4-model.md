---
name: Operations Sprint 4 model
description: Role-based dashboards, role router, nextTask algorithm, CSS additions, test patterns.
---

# Sprint 4 architecture

## Role routing
`operations.html` is now a thin role router — it calls `/api/operations/me`, reads `user.role`,
and does `location.replace()` to the appropriate dashboard page. No back-end changes.

## Dashboard files
| Role | File |
|---|---|
| DIRECTOR | `public/operations-director.html` |
| CHEF_CUISINE | `public/operations-cc.html` |
| ADJOINT | `public/operations-adjoint.html` |
| SOUS_CHEF | `public/operations-souschef.html` |
| CHEF_DE_BRIGADE | `public/operations-cdb.html` |

Each dashboard has a role-guard at the top: if the loaded user's role ≠ expected, it redirects back to `operations.html`.

## nextTask algorithm (operations-common.js)
```
Priority: URGENT (score 0) → OVERDUE/past-due (1) → due today (2) → future (3)
Tiebreak within same score: earliest createdAt wins
```
Exported as `OpsCommon.nextTask(tasks, myId)`.

## New helpers in operations-common.js
- `OpsCommon.nextTask(tasks, myId)` — deterministic next task selection
- `OpsCommon.isToday(dateStr)` — local-time today check
- `OpsCommon.isCompletedToday(task)` — completed within today
- `OpsCommon.greeting()` — hour-aware Italian greeting
- `OpsCommon.taskCard(t, users, opts)` — compact task card HTML
- `OpsCommon.renderSection(container, title, tasks, users, emptyMsg)` — append section to container

## Sprint 4 CSS classes (operations.css)
`.brief-card`, `.brief-text`, `.brief-num`, `.qa-grid`, `.qa-btn`, `.qa-btn.qa-primary`,
`.qa-btn.qa-danger`, `.next-task-card`, `.next-task-label`, `.next-task-title`, `.next-task-meta`,
`.next-task-actions`, `.attention-card`, `.workload-member`, `.section-title-sm`, `.task-card`,
`.task-card.overdue-card`, `.task-card.urgent-card`

## Test counts (Sprint 4 complete)
- Sprint 4: 109/109
- Sprint 3 regression: 94/94
- Sprint 2 regression: 54/54
- Sprint 1.1 regression: 22/22
- Sprint 1 regression: 36/36
- Total: **315/315**

## Key constraints
- No back-end changes in Sprint 4 — pure frontend
- Non-director user activation requires real Firebase; test suite uses Director token + opsAuth module-level checks for role validation (matches Sprint 1/2 pattern)
- `stats.overdue` is personal scope (director's own overdue); company-wide overdue comes from task list
- Each dashboard fetches only the APIs it needs (tasks + stats for most, + escalation-status for Director)

## **Why:**
Role routing as a separate thin page (vs. inline conditional render) keeps each dashboard file focused and testable in isolation. The role-guard redirect prevents URL-guessing cross-role access on the client side (server auth remains the real enforcement layer).

## **How to apply:**
When adding a new role, create `public/operations-{role}.html`, add it to ROLE_ROUTES in `operations.html`, and add its role-guard redirect. The `OpsCommon.nextTask` algorithm is the canonical implementation — don't reimplement inline.
