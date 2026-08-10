---
name: Operations Sprint 6.2 Trends & Role Intelligence
description: Snapshot store, trend engine, role-scoped intelligence, briefing, dept health, and test patterns.
---

# New Files

- `operations/ops-snapshots.js` — daily snapshot store (file-based, DATA_DIR aware)
- `operations/ops-trends.js` — trend engine: IMPROVING/WORSENING/STABLE/INSUFFICIENT_DATA

# ops-snapshots.js

- File: `data/ops-snapshots.json` (structure: `{ [companyId]: { [YYYY-MM-DD]: snapshot } }`)
- `DATA_DIR` read from `process.env.DATA_DIR` at module evaluation time (module-level const)
- `generateSnapshot(companyId, { tasks, users, workload })` — idempotent: skips if today's exists
- `getYesterdaySnapshot(companyId)` — returns snapshot for prior calendar day or null
- `getRecentSnapshots(companyId, days)` — last N days, newest first, excludes today
- Test helpers: `_saveSnapshotForDate(companyId, date, snapshot)`, `_clearCompanySnapshots(companyId)`
- **Snapshot triggered by Director GET /api/operations/intelligence** (idempotent; no scheduler needed)

# ops-trends.js

- `computeTrend(current, previous, opts)` → `{ currentValue, previousValue, delta, direction, interpretation }`
- `analyzeTrends(summary, yesterdaySnapshot, recentSnapshots)` → `{ overdue, completionRate, urgentTasks, workload, averageCompletionTime }`
- IMPROVING: lower overdue/urgent/workload; higher completionRate
- STABLE: delta === 0
- INSUFFICIENT_DATA: no previous value
- 7-day avg added as `sevenDayAvg` + `sevenDayInterpretation` fields when data available

# ops-intelligence.js additions

- `generateBriefing(role, data)` — role-specific Italian text from structured facts; never generic
- `getDepartmentHealth(scopedTasks, yesterdaySnapshot)` — per-dept: open/overdue/urgent/completedToday/trend
- `_isToday` now exported for test use

# server.js intelligence endpoint

- Now supports ALL active ops roles (removed Director-only guard)
- Role, companyId, scope NEVER accepted from request
- `getScopedTasks(actor, allTasks, allUsers)` — uses `opsAuth.ASSIGNABLE_ROLES` matrix
- `getScopedUsers(actor, allUsers)` — same matrix
- Director: full view + trends + departmentHealth + snapshot generation
- CC/Adjoint: scoped view + departmentHealth
- SC/CDB: `{ briefing, myTasks, nextTask }` — personal only

# Test patterns (Sprint 6.2 — CRITICAL)

- **Must set `process.env.DATA_DIR = DATA_DIR` before requiring ops-snapshots** in test file.
  `ops-snapshots.js` computes `SNAPSHOTS_FILE` at module load time; if DATA_DIR isn't set first,
  the test process and server process write to different files.
- Port 4462, SECRET 'test-sprint62-secret'
- Historical snapshot seeding uses `_saveSnapshotForDate()` with yesterday's date string

**Why:** ops-snapshots uses module-level constants; test process env must match server env before require.

# Test counts

- Sprint 6.2: 88/88
- All prior suites: 532/532
- Total: **620/620**
