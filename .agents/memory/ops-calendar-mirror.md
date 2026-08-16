---
name: Task 66 Rework — Operations calendar mirror
description: How published ops tasks appear as read-only events in the Service calendar, including the mirror ID scheme, mutation guards, and frontend read-only treatment.
---

## Rule
When an Operations task has `publishToService === true`, an active `serviceDepartmentId`, and status `OPEN` or `IN_PROGRESS`, a mirror calendar event is upserted in `calendarEventsStore` with `id = 'opsmirror_' + task.id`. Any other state removes the mirror.

**Why:** The spec required the task to appear in `calendar.html` (not just `department.html`), reusing the existing calendar store/broadcast architecture without a second editable record.

**How to apply:**
- `syncOpsTaskToCalendar(companyId, task)` is the single async function. Call it fire-and-forget (`.catch()`) after every ops task mutation (create, PATCH, PUT, complete, cancel, progress, reassign, delete).
- Mirror fields: `source: 'OPERATIONS'`, `operationsTaskId`, `assigneeName`, `priority` mapped via `mapOpsPriorityToCalendar()` (URGENT→urgent, HIGH→high, MEDIUM→normal, LOW→low), `date` from `task.dueDate.slice(0,10)`.
- Calendar REST endpoints (PUT, PATCH status, DELETE, duplicate) check `event.source === 'OPERATIONS'` and return 403.
- DELETE ops task uses an inline block (not `syncOpsTaskToCalendar`) because the task is already removed from the store by that point.
- `broadcastCalendarEvent()` fires `calendarEventCreated` / `calendarEventUpdated` / `calendarEventDeleted` — no new WS architecture.
- `calendar.html`: `source === 'OPERATIONS'` events show `.ops-source-badge`, suppress all mutating footer buttons, and show assigneeName in the detail modal.
- i18n keys: `cal.ops.badge`, `cal.ops.readonly`, `cal.ops.assignee` in both en.json and fr.json.
- Test suite: `tests/ops-calendar-sync.test.js` — 60 tests covering full lifecycle + WS realtime + isolation + priority mapping.
