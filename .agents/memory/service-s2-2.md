---
name: Service S2.2 — Department Session Hardening & Login UX
description: Home button hiding, auth-error redirect, routing hint (no document.referrer), in-memory rate limiter for POST /api/service/login.
---

## Rule: isServiceSession() and getLoginDestination() live in ws-auth.js (S2.2+)

S2.1 defined `_decodeTokenPayload()` and `isServiceSession()` as local functions in
`department.html`. S2.2 moved them into the `WsAuth` IIFE (ws-auth.js) and exported them.
`department.html` now calls `WsAuth.isServiceSession()` and `WsAuth.getLoginDestination()`.

**Why:** All pages share ws-auth.js. Centralising here ensures auth-error redirects
(`joinRoom`, `handleServerError`) and no-token guards always use consistent logic.

**How to apply:** Any new page needing session-type detection must use `WsAuth.isServiceSession()`
and `WsAuth.getLoginDestination()` — do not re-implement the `depacct_` check locally.

## Rule: Routing hint `_pt_login_type` in sessionStorage

`WsAuth.storeToken()` decodes the token payload and writes `_pt_login_type = 'service'|'admin'`
to sessionStorage. `WsAuth.clearToken()` removes it alongside `ws_session_token`.
`WsAuth.getLoginDestination()` prefers the live token; falls back to the hint when no token.

**Why:** Eliminates `document.referrer` dependency in no-token guards. Referrer is absent in
private mode and across some browser transitions.

**Security boundary:** `_pt_login_type` is ONLY used for login-page routing.
Never used for authorization, company/dept resolution, API access, or WebSocket access.
Server-side session is always authoritative.

## Rule: Rate limiter is in-memory, keyed by `${normalizedLogin}:${clientIP}`

Max 5 failures per 5-minute window. `_getLoginRateKey` uses `x-forwarded-for` header first,
then `req.socket.remoteAddress`. Successful login clears the key. Server restart resets all counters.

**Failure counting:** wrong password and unknown login both increment.
Suspended account and inactive dept do NOT increment (credentials are valid).

**What NOT to build:** CAPTCHA, Redis, account lockout, email alerts.

**Scope:** Rate limiter applies ONLY to `POST /api/service/login`.
`/api/auth/session` (Firebase) and Operations routes are completely unaffected.

## Home button hiding

`department.html`: button has `id="btn-home"`. An IIFE `applySessionUI()` runs synchronously
at the top of the inline script, before any async code, and sets `display:none` for service sessions.
Admin sessions see the button unchanged.
