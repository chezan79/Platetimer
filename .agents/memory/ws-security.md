---
name: WebSocket Security Architecture
description: How WebSocket authentication and restaurant isolation are enforced in PlateTimer
---

## Rule
All WebSocket clients must authenticate via a server-signed HMAC-SHA256 session token before any room or data action is processed. The server never trusts a `companyName` sent directly by the client.

## How it works
1. After Firebase login, `index.html` calls `POST /api/auth/session` with the Firebase ID token.
2. The server verifies the ID token via the Firebase REST API (`identitytoolkit.googleapis.com`) — no Admin SDK needed.
3. The server fetches the user's company from Firestore using the user's own token (authoritative source).
4. The server returns a short-lived HMAC-signed session token: `base64(payload).hmac_hex`.
5. Token is stored in `sessionStorage` as `ws_session_token`.
6. All station pages use `WsAuth.joinRoom(ws, pageType)` from `public/js/ws-auth.js` to send the token.
7. The server verifies the token in `joinRoom`, sets `ws.isAuthenticated = true`, and extracts company from the token.
8. All non-ping/pong/joinRoom actions are blocked if `ws.isAuthenticated` is false.
9. `/api/countdowns` now requires a company filter — never returns all companies' data.

## Key env var
`WS_SESSION_SECRET` — set in Secrets for production so tokens survive server restarts. If missing, a random key is generated on startup (tokens invalidated on restart).

**Why:** The previous system trusted `data.companyName` from the client, allowing any anonymous WebSocket client to join any restaurant's room. This is a complete bypass of company isolation.

**How to apply:** Any new WebSocket action must check `ws.isAuthenticated` before processing. New REST endpoints that return per-company data must require a company filter.
