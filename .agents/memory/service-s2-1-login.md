---
name: Service S2.1 — Department Account Login
description: Session architecture for department operator login; global loginIdentifier uniqueness; service-login.html; logout routing.
---

## Rule: Service session uid = account.id ('depacct_…')

POST /api/service/login issues `signSessionToken(account.id, account.companyId)`.
The uid is the department account's own record ID, NOT a Firebase UID.

**Why:** Firebase UIDs are not available for department-only operators. Using account.id
avoids binding to Firebase entirely while reusing the existing HMAC token machinery.

**How to apply:** `getBoundDepartmentContext` detects `session.uid.startsWith('depacct_')`
and routes to `findDepartmentAccountById(session.uid)` instead of `findDepartmentAccountByUid`.
Any new endpoint that needs to distinguish session types should use the same prefix check.

## Rule: loginIdentifier globally unique (S2.1+)

S2.0 was company-scoped; S2.1 tightened to global.
`createDepartmentAccount` and `updateDepartmentAccount` now check ALL companies.

**Why:** POST /api/service/login receives only loginIdentifier+password (no company context).
Company-scoped uniqueness would leave ambiguity at login time.

**How to apply:** Do NOT revert to company-scoped. Any new admin UI that rejects duplicates
should show "loginIdentifier already in use." (same message, same 409).

## S2.0 test S20-7d updated

Was: "Same login different company ok" (asserted success).
Now: "Same login different company rejected (global uniqueness, S2.1)" (asserts 409).
No downstream S2.0 tests depend on the company-b account that was blocked.

## Test timing: seed plans.json BEFORE startServer()

The server loads plans.json at startup via initializeDataStores(). Writing it after
startServer() has no effect on the already-loaded in-memory store.
Always `fs.writeFileSync(plansPath, ...)` before `await startServer()`.

## Logout routing in department.html

`doLogout()` decodes the token payload client-side (base64, no secret needed — routing only).
If `uid.startsWith('depacct_')` → clear token → redirect to `service-login.html`.
Otherwise → clear token → redirect to `index.html`.
`WsAuth.clearToken()` is the canonical logout mechanism.
