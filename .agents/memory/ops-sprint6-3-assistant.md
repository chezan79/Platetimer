---
name: Operations Sprint 6.3 Executive Assistant
description: ops-assistant.js module; priorityQueue, riskWatch, changesSince, executiveBrief added to intelligence endpoint and all role dashboards.
---

# New Files

- `operations/ops-assistant.js` — 4 pure functions, no side effects

# Module API

- `generatePriorityQueue(decisions)` → ranked items from decisions array; maps severity→priority; no supportingFacts exposed
- `detectRisks(tasks, users, workload)` → CRITICAL/HIGH/MEDIUM/LOW items sorted by level
- `buildChangesSince(trends, yesterdaySnap, summary)` → only IMPROVING/WORSENING fields; STABLE and INSUFFICIENT_DATA suppressed
- `buildExecutiveBrief(role, summary, pq, rw, changes, decisions, trends, myMetrics, nextTask)` → structured Italian text with \n, greeting, numbered priorities

# Risk Detection Rules (key non-obvious ones)

- CRITICAL: urgent+overdue+assignee OVERLOADED, OR urgent+suspended assignee
- HIGH (4 rules): due within 60 min not started; user OVERLOADED; urgent+overdue+non-overloaded; urgent not started at all
- **Critical gap fixed**: urgent+overdue tasks where assignee is BUSY (not OVERLOADED) need their OWN HIGH rule — they fall through all other HIGH checks
- MEDIUM: IN_PROGRESS inactive 4h; recurring overdue; dept 3+ overdue
- LOW: open 48h+ no update; dept 2+ urgent; BUSY user with overdue

**Why:** without the explicit urgent+overdue+non-overloaded HIGH rule, those tasks produce no risk items even though they are clearly risky.

# server.js changes

- `require('./operations/ops-assistant')` added near other ops requires
- In intelligence endpoint, before building response:
  - `priorityQueue = generatePriorityQueue(result.decisions)`
  - `riskWatch = detectRisks(scopedTasks, scopedUsers, result.workload)`
  - `changesSince = buildChangesSince(trends, yesterdaySnap, result.summary)`
  - `executiveBrief = buildExecutiveBrief(actor.role, ...)`
- SC/CDB response includes `priorityQueue` and `riskWatch` (no changesSince — no trends for personal roles)
- All other roles: `priorityQueue`, `riskWatch`, `changesSince`, `executiveBrief` in response

# Director Dashboard

- 3 new sections added before Quick Actions: `#pq-section`, `#rw-section`, `#cs-section`
- `brief-card` upgraded to `exec-brief-card` with `exec-brief-text` (white-space: pre-line)
- `renderIntelligence()` sets display='' on each section when data available
- All 3 sections hidden by default (style="display:none")

# Role Dashboard Changes

- CC/Adjoint: `renderRoleIntel` shows executiveBrief + top-3 priority queue + top-3 risk watch + 2 changes
- SC/CDB: shows executiveBrief + myTasks metrics + top-2 risk watch
- `executiveBrief` preferred over `briefing`; falls back to `briefing` if absent

# Test patterns

- Port 4463, secret 'test-sprint63-secret'
- Set `process.env.DATA_DIR = DATA_DIR` before any require of ops-snapshots
- Seed yesterday snapshot with `_saveSnapshotForDate` to test changesSince presence

# Test counts

- Sprint 6.3: 99/99
- All prior suites: 620/620
- Total: **719/719**
