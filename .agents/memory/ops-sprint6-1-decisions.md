---
name: Operations Sprint 6.1 Decision Support Engine
description: Decision card architecture, 8 decision types, confidence rules, quick actions, and test patterns.
---

# Function

`generateDecisions(companyId, { tasks, users, workload, now, generatedAt })` in `operations/ops-intelligence.js`.
Called at the end of `analyzeIntelligence()`; result added as `decisions` field in the response.
Exported as `module.exports.generateDecisions` for unit tests.

# Decision Card Schema

`{ id, type, severity, title, reason, recommendedAction, confidence, supportingFacts, linkedTask, linkedUser, department, quickAction, generatedAt }`

`quickAction: { label, url }` — navigation only, no mutations.

# 8 Decision Types

| Type | Severity | Confidence | Trigger |
|---|---|---|---|
| OVERLOADED_USER | HIGH | 70/80/90 | workload score ≥ LOAD_OVERLOADED (10) |
| SUSPENDED_USER_WITH_TASKS | HIGH | 95 | SUSPENDED user has open/in-progress tasks |
| OPENING_NOT_STARTED | HIGH | 60/75/90 | URGENT + OPEN task |
| URGENT_DEPARTMENT | MEDIUM | 80 | ≥ URGENT_DEPT_THRESHOLD urgent open tasks in same dept |
| CHECK_DEPARTMENT | MEDIUM | 80 | ≥ OVERDUE_DEPT_THRESHOLD (2) overdue tasks in same dept |
| REASSIGN_TASK | MEDIUM | 75 | OVERLOADED user has movable (non-urgent OPEN) task AND NORMAL candidate exists |
| REVIEW_RECURRING | MEDIUM | 85 | Overdue task with templateId set |
| UNDERUSED_USER | LOW | 70 | ACTIVE user with assigned=0, completedToday=0, team has overdue tasks |

# Confidence Rules for OVERLOADED_USER

- 90: overdue ≥ 1 AND urgent ≥ 1 AND no recent completion (< 30 min ago)
- 80: overdue ≥ 1 OR urgent ≥ 1
- 70: workload score ≥ 10 with no overdue/urgent

# Confidence Rules for OPENING_NOT_STARTED

- 90: task is OVERDUE (effectiveStatus)
- 75: not overdue but due within 120 minutes
- 60: due far out or no due date

# MIN_CONFIDENCE

Cards with confidence < 50 are suppressed (not included in output).
Currently, the lowest possible is 60 (OPENING_NOT_STARTED with far-future due).

# Reason field requirement

Must use actual data values — never generic text.
Pattern: "Based on [source]: [Name] has [N] [thing]."
Italian text: "Basato sul carico attuale:", "Basato sui compiti urgenti:", etc.

# Sort order

HIGH → MEDIUM → LOW, then confidence descending, then generatedAt ascending.

# Dashboard (director)

Suggestions section replaced with "🎯 Decisioni consigliate" section.
Card renders: severity badge (colored), confidence pill (colored), type label, title, reason, supporting facts bullets, recommended action, quick action button.
CSS: `.dec-card`, `.dec-sev-badge`, `.dec-conf-badge`, `.dec-type`, `.dec-title`, `.dec-reason`, `.dec-facts`, `.dec-fact`, `.dec-action`, `.dec-qa-btn`.

# Backward Compatibility

`attention`, `workload`, `suggestions`, `summary` unchanged in API response.
`decisions` is a new additional field.

# Test patterns (Sprint 6.1)

- Port 4461, SECRET 'test-sprint61-secret'.
- HTTP tests cover OVERLOADED_USER, OPENING_NOT_STARTED, URGENT_DEPARTMENT, CHECK_DEPARTMENT, SUSPENDED_USER_WITH_TASKS, isolation, Director-only.
- Module-level tests (direct `analyzeIntelligence()` call with synthetic users/tasks) cover REVIEW_RECURRING (requires templateId on task), REASSIGN_TASK (requires 2 active users), UNDERUSED_USER, confidence formula variants.
- REVIEW_RECURRING requires `templateId` on the task object — can only be set synthetically or by the recurring scheduler, not via the task creation HTTP endpoint.

**Why:** Firebase-dependent activation makes it impossible to create real ACTIVE users in tests without credentials. Use synthetic data for multi-user and special-field scenarios.

# Test counts

- Sprint 6.1: 62/62
- All prior suites: 470/470
- Total: **532/532**
