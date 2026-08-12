---
name: Central Department calendar access
description: Permission rule for Department Account sessions on the Service Calendar
---
All /api/calendar/* endpoints use requireCalendarAccess() instead of plain requireAuth.
Rule: unbound (legacy admin/Firebase) sessions keep full access; bound Department Account
sessions require status ACTIVE, an active department, and departmentType CENTRAL
(else 403 ACCOUNT_SUSPENDED / 410 DEPARTMENT_INACTIVE / 403 CALENDAR_NOT_ALLOWED).
**Why:** Central Departments needed the calendar without exposing it to STANDARD workstation
accounts or weakening tenant isolation; company always comes from the verified token.
**How to apply:** any new calendar endpoint must call requireCalendarAccess; client nav for
CENTRAL is gated on GET /api/service/department (server-resolved type), never client data.
Calendar page fixes for service sessions: 401 redirects and logout via WsAuth.getLoginDestination(),
back button rewired to department.html?id=<own dept>.
