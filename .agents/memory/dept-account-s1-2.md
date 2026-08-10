---
name: Department Account S1.2 Firebase Binding
description: UID binding flow, session resolution, and identity endpoint for S1.2.
---

# New Functions

- `service/department-accounts.js` — `bindFirebaseUid(companyId, accountId, uid)`: global UID uniqueness check; ACTIVE-only constraint; idempotent re-bind; exported.
- `server.js` — `resolveDeptAccountContext(uid, companyId)`: shared helper used by `/api/auth/session` and `/api/service/identity`; departmentType comes from dept record via `getDepartmentType()` — NEVER from the account.

# New Endpoints

- `POST /api/department-accounts/bind` — binds caller's Firebase UID (from `session.uid`) to a Department Account identified by `loginIdentifier` in the body. Client NEVER submits a uid; the server takes it from the HMAC session which is already Firebase-verified.
- `GET /api/service/identity` — returns dept account context for the current session (or empty if no binding). Testable without real Firebase tokens.

# Security Rules

- UID always from verified HMAC session (`session.uid`) — body `uid` field is silently ignored.
- Cross-company: `loginIdentifier` lookup is global; company isolation enforced by comparing `account.companyId !== session.companyName` → 403.
- One UID per account; one account per UID (any status); SUSPENDED accounts cannot receive a new binding.
- `departmentType` resolved from department record only — absent field treated as STANDARD.

# Session Resolution Shape (added to /api/auth/session response)

```json
{
  "departmentAccountId": "depacct_...",
  "departmentId": "dept_...",
  "departmentType": "STANDARD | CENTRAL",
  "departmentAccountStatus": "ACTIVE | SUSPENDED"
}
```
Fields absent when no Department Account is bound to the uid.

**Why session.uid not body uid:** The HMAC session token is issued after Firebase REST verification in `/api/auth/session`; the embedded uid is already trustworthy. Accepting a uid from the request body would allow any authenticated user to bind to any account they can name.

# Test Counts

- S1.2: 54/54
- S1.1 regression: 38/38
