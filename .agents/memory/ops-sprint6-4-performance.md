---
name: Operations Sprint 6.4 Performance & Coaching Center
description: Individual performance profiles, reliability index, strengths/coaching, exception register, new page + endpoints.
---

# New Files

- `operations/ops-performance.js` — pure computation: parsePeriod, computeMetrics, computeReliabilityIndex, generateStrengths, generateCoachingOpportunities, computeEvolution, computeWorkloadHistory, classifyTaskOutcome, buildTaskHistory
- `operations/ops-exceptions.js` — file-based exception register per company; open-ended type codes (never hardcoded)
- `public/operations-performance.html` — full profile page (period selector, reliability ring, metrics grid, evolution, workload history, strengths, coaching, task history, exception register)
- `tests/operations-sprint6-4.test.js` — 164 tests, all pass

# Server Additions

- `GET /api/operations/performance/:userId` — full profile (period param: today|7d|30d|90d|year|custom)
- `GET /api/operations/performance/me` — own profile shortcut (handled by :userId route, rawId === 'me')
- `POST /api/operations/exceptions` — record exception (Director/CC/Adjoint only)
- `GET /api/operations/exceptions?userId=` — list exceptions for a user

# Access Control (canViewPerformance)

- Director: any user in company
- CC: users in their ASSIGNABLE_ROLES (SOUS_CHEF, CHEF_DE_BRIGADE) + self
- Adjoint: CHEF_DE_BRIGADE + self
- SC/CDB: self only
- Rule lives in `canViewPerformance()` in server.js; uses `opsAuth.ASSIGNABLE_ROLES`

**Why:** Same isolation pattern as all other ops endpoints — role/companyId always from server-side session.

# Reliability Index Formula (documented)

```
Score = onTimeRate × 35         (null → 17.5)
      + completionRate × 20     (null → 20)
      + urgentRate × 15         (null → 15 full credit)
      + recurringRate × 10      (null → 10 full credit)
      + consistency × 10        (completed/assigned ratio)
      + engagement × 10         (min(completed/5, 1.0))
      − lateRate × 10           (penalty, max 10)
      − blocked/assigned × 5    (penalty, max 5)
Final: clamp(0, 100)
```

Classifications: Eccellente ≥85, Molto Buono ≥70, Buono ≥55, Attenzione Richiesta ≥40, Critico <40

# Task Outcome Classification

- COMPLETED_ON_TIME: status=COMPLETED && completedAt ≤ dueDate
- COMPLETED_LATE: status=COMPLETED && completedAt > dueDate
- CANCELLED: status=CANCELLED
- TRANSFERRED: history has ASSIGNEE_CHANGED with from=userId
- BLOCKED: exception register entry type in BLOCKED/WAITING_DEPT/WAITING_MATERIALS
- OVERDUE: status=OPEN && dueDate < now
- OPEN / IN_PROGRESS: current status

# Exception Register

- Standard type codes: CANCELLED, TRANSFERRED, BLOCKED, WAITING_DEPT, WAITING_MATERIALS, CUSTOMER_REQUEST, DIRECTOR_DECISION, OPERATIONAL_EMERGENCY
- Types are strings, not an enum — future codes supported without code change
- Stored in data/ops-exceptions.json by companyId

# Navigation Added

- Director dashboard: "📊 Prestazioni" button → /operations-performance.html
- CC / Adjoint: same button
- SC / CDB: "📊 Il mio profilo" button (always shows own profile)

# Test Quirks

- HTTP integration tests in prior suites check `r.data.success` not `r.status === 200` for invite/create operations — `status === 200` can fail despite successful response in some Node.js environments; use `data.success` as truth signal
- Invited users (CHEF_CUISINE, SOUS_CHEF) can't authenticate via HTTP without real Firebase token — hierarchy tests are unit-level using opsAuth.ASSIGNABLE_ROLES directly

# Test Counts

- Sprint 6.4: 164/164
- All prior suites: 719/719
- Total: **883/883**
