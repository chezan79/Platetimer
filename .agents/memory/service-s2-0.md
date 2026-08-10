---
name: Service S2.0 Department Account Admin UI
description: Password management + inline edit UI for Department Accounts in admin-departments.html; behavioral changes that required S1.1/S1.2 test updates.
---

## Rule: one account per department (any status)
S2.0 tightened from "one ACTIVE account per dept" to "one account per dept regardless of status". A suspended account still occupies the slot — you edit it via PATCH rather than creating a new one. S1.1 tests 15/16/28/29 were updated to reflect this.

**Why:** The admin UI shows either [Crea Account] or [Modifica] per row — never both. Allowing multiple accounts (one suspended, one active) would break that UX model.

**How to apply:** `createDepartmentAccount` checks for ANY existing account for the dept (not just ACTIVE ones). Return 409 ACCOUNT_ALREADY_EXISTS.

## Rule: login uniqueness is company-scoped
S2.0 changed login uniqueness from global to per-company. Two different companies can use the same `loginIdentifier`. S1.1 test 8 was updated to test same-company duplication instead of cross-company.

**Why:** Each company's Service tablets log in independently; there's no collision risk across tenants.

**Exception:** `findDepartmentAccountByLoginIdentifier` (used by the `/bind` endpoint) still searches globally — intentional, because bind looks up by login without knowing the company in advance. The company check happens after lookup.

## safeAccount() — mandatory for all HTTP responses
`safeAccount(a)` strips `passwordHash` and adds `hasPassword: bool`. Must be applied to every account object in every HTTP response (GET list, POST create, PATCH edit, PUT status). Never return raw store objects.

## PATCH /api/department-accounts/:id
Accepts `{ loginIdentifier?, password? }`. Blank string is treated as "unchanged" (validated to reject explicit empty strings). Company-scoped login uniqueness enforced excluding self. Returns `safeAccount`.

## Test bootstrap fix
The S2.0 test used `SESSION_SECRET` (wrong) and `base64url` encoding (wrong) for the startup env + token signing. Correct pattern (matching all other service tests):
- Env key: `WS_SESSION_SECRET`
- Token: `Buffer.from(JSON.stringify({uid, companyName, iat, exp})).toString('base64')` + HMAC hex
- Startup detection: look for `'avviato'` OR `'listening'` OR `String(PORT)` in stdout

## S1.2 test fix for S12-32
S12-32 tested binding to a SUSPENDED account by creating a second account for the same dept (after suspending the first). S2.0 blocks that. Fix: create a fresh dept (`deptForSusp = await createDept(...)`) for the suspended-account test, and pre-seed `plans.json` with `medium` plan so company-a can hold 5 active depts.

## Cumulative test count
43 new tests (port 5093). Cumulative total: **1325 passing**.
