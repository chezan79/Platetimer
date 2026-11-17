# PlateTimer Monitor — Fase 1 (isolated foundation)

## Implemented
- Separate `platform-monitor/` directory; **no import, route, change or dependency** in production `server.js`, `public/department.html`, countdown, Mex or Voice.
- Local-only optional Node server, disabled by default; binding `127.0.0.1:5090` only when enabled.
- Firebase Admin ID token verification with revocation check, mandatory allowlisted UID, and authoritative verified owner email `chezan79@gmail.com`.
- Deny-by-default, returns only own role and email. No company information, registry, messages or other data is exposed.
- Unit tests for unconfigured, incorrect UID, email, disabled user, unverified email and revoked tokens.

## Before activating
1. Identify the correct Firebase Authentication UID for `chezan79@gmail.com` in the **same Firebase project used by PlateTimer**. Never assume UID from an email typed in a form.
2. Store `PLATETIMER_PLATFORM_ADMIN_UID` in private Replit Secrets, never GitHub.
3. Keep `PLATETIMER_PLATFORM_MONITOR_ENABLED` unset/false until explicitly testing; do not expose port 5090 publicly.
4. Ensure the original PlateTimer Service runs independently. Do not reconfigure `.replit`, Railway, server.js or deployed URLs for this module.
5. Run `node --test tests/platform-monitor-auth.test.js` in Replit to validate static authorization logic.

## Next stages (not implemented)
- Operator-only dashboard and a separately authenticated read-only service, deliberately deployed behind a distinct restricted entry point.
- Current online presence per restaurant from the live server would require a secure **aggregation-only** mechanism; an independent process cannot read `companyRooms` directly. Do not copy or leak raw WebSocket sessions.
- Company registry and countdown-history summaries; historical activity must be measured prospectively.
- Consistent presence across server instances, heartbeat/reconnect semantics, privacy and retention.
- Explicit negative authorization tests: no restaurant Director, department or other UID may access global data.
- No access to Mex content or Agora audio.
