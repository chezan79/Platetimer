---
name: Calendar module
description: Architecture decisions for the PlateTimer operational calendar feature.
---

## Storage
- `data/calendar-events.json` — `{ [companyId]: CalendarEvent[] }` (local, ephemeral on Railway)
- `data/calendar-notif.json` — `{ [companyId]: CalendarNotification[] }` (local, ephemeral on Railway)
- Same `loadJSON`/`saveJSON` pattern as departments.
- `saveJSON` now also fire-and-forgets to Firestore (`platetimer_stores` collection) when `db` is available.

## companyId isolation
All calendar endpoints use `requireAuth` → `session.companyName` as the companyId. The client can never supply or override it.

## broadcastCalendarEvent ordering
`broadcastCalendarEvent()` is defined in the calendar module block (inserted before `const companyRooms = new Map()`). It references `companyRooms` which is declared later in the file. This works because the function is only ever *called* during live HTTP request handlers — by that time all synchronous startup code (including `const companyRooms`) has already run. Do not move the call inside `runNotificationGeneration()` or any startup-time code.

## Recurrence
Rules are stored on the base event (`recurrence.type`, `.interval`, `.weekdays`, `.endDate`). Occurrences are expanded on-the-fly in `expandRecurrence()` for the requested date range — no separate rows generated per occurrence. Recurring events return occurrences with `id = baseId + '_' + dateStr` and `baseId = event.id`.

## Notifications
Generated lazily: `generatePendingNotifications()` runs on every `/api/calendar/notifications` GET and also in a 1-minute `setInterval`. Notifications are only created once per `(eventId, offsetMinutes)` pair. Per-user read/dismiss state stored in `readBy[]`/`dismissedBy[]` arrays inside each notification document.

## Timezone
`CALENDAR_TZ = 'Europe/Zurich'`. `todayZurich()` uses `Intl.DateTimeFormat('en-CA')` for YYYY-MM-DD. `zurichLocalToMs()` tries +02:00 then +01:00 and picks the offset whose Zurich date repr matches — handles DST correctly without external libraries.

## Delete permission
Only the event creator (`createdBy === session.uid`) can delete. All authenticated company members can create, edit, and change status. No separate role system — consistent with the existing app which has no per-user roles.

## Why
- File-based JSON is consistent with the rest of the server (departments, plans).
- Lazy notification generation avoids a background scheduler that could miss events after server restart.
- On-the-fly recurrence expansion avoids database bloat while keeping the data model clean.
