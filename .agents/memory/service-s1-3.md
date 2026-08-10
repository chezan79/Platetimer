---
name: Service S1.3 Direct Department Resolution
description: home.html routing logic added in S1.3 — identity-first redirect flow.
---

# What changed

- `public/home.html` — added `resolveIdentityAndRoute()` function; wrapped Reparti section in `#dept-section` (hidden by default); added `#suspended-msg` and `#dept-error-msg` state divs; early eager-load and pageshow now call `resolveIdentityAndRoute()` instead of `loadDepartmentsGrid()` directly; `loadDepartmentsGrid()` now reveals `#dept-section`.

# Routing flow

```
Page loads
├── dept-section hidden (no flash)
├── resolveIdentityAndRoute() called immediately (stored token) or after Firebase auth
│   ├── no token → loadDepartmentsGrid() (shows dept-section + legacy selector)
│   └── GET /api/service/identity
│       ├── departmentAccountId + ACTIVE + valid dept → redirect department.html?id=<departmentId>
│       ├── departmentAccountId + ACTIVE + dept inactive/missing → show #dept-error-msg
│       ├── departmentAccountId + SUSPENDED → show #suspended-msg
│       └── no departmentAccountId (unbound) → loadDepartmentsGrid() (shows dept-section)
```

# Guard flag

`_identityResolved = false` (module-scope) prevents double resolution when both the early stored-token path and Firebase `onAuthStateChanged` fire in the same page load. Reset to `false` on `pageshow` so back/forward navigation re-routes correctly.

# Key invariants

- `departmentId` for redirect ALWAYS comes from `/api/service/identity` (server-resolved, session-verified) — NEVER from `localStorage`, URL params, or client-supplied fields.
- Cross-check: before redirecting, `GET /api/departments` confirms the assigned dept is still in the active list. If not → `#dept-error-msg` shown, no redirect.
- Dept-section revealed only when `loadDepartmentsGrid()` is called → bound accounts never see a flash of the selector.
- `#suspended-msg` and `#dept-error-msg` are static HTML with inline `style="display:none"` removed by JS — no flicker.

# Test file

`tests/service-s1-3.test.js` — 48 tests, port 5097.

**Why dept-section hidden by default:** If it were visible, a bound account would briefly see all department cards before the identity call redirected. Hiding it eliminates the flash entirely; unbound/legacy users see it revealed by `loadDepartmentsGrid()`.
