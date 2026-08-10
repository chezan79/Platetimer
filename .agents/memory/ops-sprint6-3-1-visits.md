---
name: Operations Sprint 6.3.1 Last Visit + Risk Deduplication
description: Visit tracking store, new-since-last-visit in intelligence endpoint, risk dedup.
---

# New Files

- `operations/ops-visits.js` — per-company/per-user visit store; `getLastVisit / updateLastVisit / _clearCompanyVisits`; stored in `data/ops-visits.json`; no Firestore sync needed (lightweight state)

# Modified Files

- `operations/ops-assistant.js` — added `deduplicateRisks(risks)` called at end of `detectRisks`; added `buildNewSinceLastVisit({riskWatch, decisions, tasks, previousVisitAt, now})`; both exported
- `server.js` — requires `opsVisits`; intelligence endpoint reads `previousVisitAt` BEFORE computing response, passes to `buildNewSinceLastVisit`, updates `lastVisitAt` AFTER sending response; `?isRealtime=1` suppresses `updateLastVisit`
- All 5 dashboard HTML files — NSV widget rendered via `OpsCommon.renderNewSinceLastVisit`
- `public/js/operations-common.js` — added `renderNewSinceLastVisit(nsv, sectionId, contentId)`; `sectionId` may be null for inline use
- `public/css/operations.css` — NSV CSS block (`.nsv-*` classes)

# Architecture

## Visit tracking

```
Read previousVisitAt          ← always before intelligence computation
→ compute response (including newSinceLastVisit)
→ send response to client
→ update lastVisitAt          ← always after, never before
```

`isRealtime=1` query param (set by WS-triggered refreshes in dashboard JS): skips `updateLastVisit`, so WebSocket reloads never overwrite the session baseline.

## Deduplication keys

- `task:<taskId>` — same task appears at most once in Risk Watch
- `user:<userId>:overload` — same user's overload/busy risk merged
- `department:<dept>:overdue` — same dept overdue cluster merged
- `department:<dept>:urgent` — same dept urgent cluster merged
- `misc:<title>` — everything else by exact title

Winner = highest severity (CRITICAL > HIGH > MEDIUM > LOW). All descriptions merged into `reasons[]`.

## buildNewSinceLastVisit

- First visit (previousVisitAt === null) → `{ previousVisitAt: null, newCount: 0, items: [] }` — no backlog dump
- Item is "new" when event time > previousVisitAt
- Event time for risk items = `task.updatedAt || task.createdAt` (NOT dueDate — avoids false positives for pre-existing overdue tasks)
- Includes: HIGH/CRITICAL risks, HIGH/CRITICAL decisions, new urgent tasks (createdAt > prev), new escalations (escalationSentAt > prev)
- Excludes: LOW/MEDIUM, completed/cancelled tasks

## newSinceLastVisit response shape

```json
{
  "previousVisitAt": 1234567890,
  "newCount": 3,
  "newCritical": 1,
  "newHigh": 2,
  "items": [{ "id", "type", "severity", "title", "description", "linkedTask", "linkedUser", "linkedDept", "createdAt" }]
}
```

**Why event time = updatedAt not dueDate:** If a task went overdue before the last visit, dueDate > prevVisit would wrongly mark it "new" on every subsequent visit. updatedAt correctly represents when the task last changed state.

# Test Counts

- Sprint 6.3.1: 88/88
- All prior: 883/883
- Total: **971/971**
