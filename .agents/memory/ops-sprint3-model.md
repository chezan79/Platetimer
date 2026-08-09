---
name: Operations Sprint 3 model
description: Recurring tasks, reminder engine, escalation, preferences — architecture and key constraints.
---

# Sprint 3 architecture

## Store shapes (server.js)
- `opsTemplatesStore = { [companyId]: [template, …] }` — persisted to `data/ops-templates.json`
- `opsPrefsStore = { [companyId]: { defaults: {…}, users: { [userId]: {…} } } }` — persisted to `data/ops-prefs.json`

## Template schema (key fields)
- `id, companyId, title, description, priority, department, frequency, interval, daysOfWeek[], dayOfMonth, startDate, endDate, maxOccurrences, workSchedule[], defaultAssigneeId, defaultReminderDays, defaultEscalation, createdBy, createdByName, active, generatedCount, lastGeneratedAt, createdAt, updatedAt`
- Supported frequencies: `DAILY, WEEKLY, MONTHLY, EVERY_X_DAYS, EVERY_X_WEEKS, EVERY_X_MONTHS`

## Task extended fields (Sprint 3 additions)
- `templateId` (null for manual tasks), `occurrenceKey` (`${templateId}_${YYYY-MM-DD}` dedup guard), `reminderDays`, `reminderSentAt`, `escalation: {enabled, waitHoursAfterDue, waitHoursBetweenLevels}`, `escalationLevel`, `escalationSentAt`, `escalationNotified[]`

## Occurrence dedup
- `occurrenceKey = templateId_YYYY-MM-DD` stored on each generated task
- Before generating, collect all existing occurrenceKeys for the company into a Set; skip any dates already present
- Idempotent on server restart and repeated generate-now calls

## Escalation chain (ops-auth.js ESCALATION_CHAIN constant)
- CdB → [ADJOINT, DIRECTOR]
- SousChef → [CHEF_CUISINE, DIRECTOR]
- ChefCuisine → [DIRECTOR]
- Adjoint → [DIRECTOR]
- Director → [] (no escalation)
- Notification-only — never changes permissions

## Scheduler (ops-scheduler.js)
- Factory: `createScheduler(getStores, getSavers, email, addHistoryFn)`
- Phases exported individually for unit testing: `processRecurring`, `processReminders`, `processEscalation`, `processDailyDigest`
- All phase functions accept `(stores, savers, email, now)` for injectable time in tests
- Runs every 5 minutes via setInterval in server.js

## Preferences
- `DEFAULT_PREFS()` returns `{ emailReminders:true, taskAssignment:true, escalationEmails:true, dailyDigest:false }`
- User pref overrides company default; company default overrides system default
- `getUserPrefs(prefsStore, companyId, userId)` merges layers

## API endpoints added
- `GET/POST /api/operations/templates` — Director only
- `GET/PATCH/DELETE /api/operations/templates/:id` — Director only
- `POST /api/operations/templates/:id/generate-now` — Director, force generate
- `PATCH /api/operations/tasks/:id/reminder` — set/clear reminderDays
- `PATCH /api/operations/tasks/:id/escalation` — configure escalation
- `GET/PATCH /api/operations/preferences` — per-user prefs
- `GET/PATCH /api/operations/company-preferences` — Director: company defaults
- `GET /api/operations/escalation-status` — Director: dashboard

## Test counts (Sprint 3 complete)
- Sprint 3: 94/94
- Sprint 2 regression: 54/54
- Sprint 1.1 regression: 22/22
- Sprint 1 regression: 36/36
- Total: 206/206

## **Why:**
Recurring engine needed idempotency guarantee across server restarts — occurrenceKey solves this without needing a DB transaction. Escalation is notification-only by design (changing task permissions mid-lifecycle is a security risk). Scheduler phases are pure functions to enable deterministic unit testing without mocks.

## **How to apply:**
When adding new recurring or escalation logic, test via direct phase function calls with injectable `now`. Never trust client-supplied `companyId` or `templateId` — always resolve from session.
