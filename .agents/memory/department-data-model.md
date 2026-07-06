---
name: Department data model
description: How configurable departments are stored and enforced server-side in PlateTimer.
---

# Department data model

## Storage
- `data/departments.json` — `{ [companyId]: Department[] }` loaded at startup into `departmentsStore`
- `data/plans.json` — `{ [companyId]: 'base' | 'medium' | 'premium' }` loaded into `plansStore`
- Both are reloaded from disk at startup; mutations call `saveJSON()` immediately (synchronous write)

## Department object shape
```json
{
  "id": "dept_<timestamp>_<3hexbytes>",
  "name": "Cucina",
  "active": true,
  "usedInCountdowns": false,
  "createdAt": 1234567890000
}
```

## Plan limits
```js
const PLAN_LIMITS = { base: 3, medium: 5, premium: 10 };
```

## Key rules
- Plan limit enforced on CREATE and on RE-ACTIVATE; counts only `active === true` departments
- DELETE blocked if `usedInCountdowns === true` or if dept has an active in-memory countdown
- `usedInCountdowns` is set to `true` on first `startCountdown` WS message targeting that dept ID
- `startCountdown` validates destination against `activeDeptIds`; if company has no departments yet (empty array), the check is skipped to avoid breaking existing installs

## REST endpoints
- `GET  /api/departments` — list + plan info
- `POST /api/departments` — create (plan limit)
- `PUT  /api/departments/:id` — rename or toggle active
- `DELETE /api/departments/:id` — hard delete only if never used
- `GET  /api/subscription` — plan name, limit, activeCount

## Frontend routing
- `home.html` — fetches `/api/departments`, renders active depts as links to `department.html?id=<deptId>`
- `department.html` — generic station page; reads `?id=` param; joins WS room with that dept ID
- `admin-departments.html` — full management UI (create, toggle, delete)
- `sala.html` — builds filter buttons dynamically from `/api/departments`

**Why:** Hardcoded cucina/pizzeria/insalata was inflexible; moving to per-company configurable departments with server-enforced plan limits enables multi-tenant SaaS billing.
