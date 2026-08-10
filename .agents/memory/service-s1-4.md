---
name: Service S1.4 + S1.4.1 REST Department Locking
description: Server-side department access restriction for bound Department Account users; S1.4.1 adds centralized errors, GET /api/service/department, and explicit inactive-dept code.
---

# New Helper

`getBoundDepartmentContext(session)` — looks up the Department Account bound to `session.uid` within `session.companyName`. Returns the raw account record or `null` if unbound. Company isolation is structural (mismatch → null). Called before any department-scoped logic in the endpoints below.

# Modified Endpoints

All five department endpoints now call `getBoundDepartmentContext(session)` right after `requireAuth`:

| Endpoint | Bound ACTIVE | Bound SUSPENDED | Unbound |
|---|---|---|---|
| `GET /api/departments` | Returns only assigned dept (active only) | 403 | All depts (unchanged) |
| `POST /api/departments` | 403 | 403 | Unchanged |
| `PUT /api/departments/:id` | 403 | 403 | Unchanged |
| `DELETE /api/departments/:id` | 403 | 403 | Unchanged |
| `PUT /api/departments/:id/type` | 403 | 403 | Unchanged |

Error strings: SUSPENDED → `"Account reparto sospeso."` / ACTIVE bound → `"Account reparto non autorizzato a gestire i reparti."`

# Security invariants

- `departmentId` for the restricted GET always comes from `account.departmentId` (server-side record) — never from query string, URL param, body, or localStorage.
- Bound accounts cannot manage even their own department via CRUD (workstation ≠ admin).
- Cross-company isolation is unchanged (company always from HMAC session).
- `PUT /api/departments/:id/type` also blocked (CENTRAL designation is admin-only).

# Test file

`tests/service-s1-4.test.js` — 62 tests, port 5096.  
Pre-seeded `plans.json` gives `ristorante` a `medium` plan (limit 5) so test 12 and 14 can create additional departments beyond the default base-plan cap of 3.

**Why pre-seed plans:** Tests that create > 3 departments for `ristorante` hit the base plan limit (3) before reaching the management assertions, producing false 403 errors from the plan guard instead of the bound-account guard. Pattern: write `{ "<company>": "medium" }` to `DATA_DIR/plans.json` before `startServer()` when a test needs more than 3 active departments.
