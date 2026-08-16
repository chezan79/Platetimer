---
name: Mex Step 5 — Floor ↔ Department messaging
description: Floor principal (__sala__) can send/receive Mex messages with departments; architecture, token flow, and delivery rules.
---

## Summary
Floor is a virtual principal identified by `__sala__`. It can exchange Mex messages with real departments bidirectionally.

## Token Flow
- `GET /api/sala/token` (auth required) issues a new signed token with `role:'floor'` via `signSessionToken(uid, companyName, 'floor')`.
- sala.html calls this at startup via `exchangeForFloorToken()` and stores the result with `WsAuth.storeToken()` **before** `subscribeToUpdates()` is called (so `joinRoom` carries the floor-scoped token).
- On the WS server, `joinRoom` sets `ws.isFloorPrincipal = (session.role === 'floor')`.
- `GET /api/service/mex/floor-inbox` returns 403 `NOT_FLOOR` if `session.role !== 'floor'`.

## Sender Resolution (mexSend handler)
```js
const mexSender = ws.boundDepartmentId || (ws.isFloorPrincipal ? '__sala__' : null);
```
- Unbound + non-floor → `MEX_NOT_BOUND` error.
- Client-supplied `from` field is always ignored (security).

## Recipient Validation
- Dept sender → valid target is any active real dept in same company OR `__sala__`.
- Floor sender → valid target is any active real dept in same company only (floor cannot message floor → `MEX_SELF_SEND`).
- Cross-company or inactive → `MEX_INVALID_RECIPIENT`.

## Delivery Predicate
```js
const clientPrincipal = client.boundDepartmentId || (client.isFloorPrincipal ? '__sala__' : null);
```
Only sockets whose `clientPrincipal` matches sender or recipient receive the message. Sender's socket excluded to prevent self-echo.

## countdowns.js Changes
Added `onMexSendAck` to config destructure and dispatch, alongside `onMexIncoming`.

## sala.html Changes
- CSS: `.mex-panel`, `.mex-cd-card`, `.mex-msgs-section` classes.
- HTML: `#mex-panel` compose drawer, `#mex-msgs-section` inbox section.
- JS state: `mexCdCards` (Map, card dedup), `mexFloorMessages` (array, inbox).
- Functions: `exchangeForFloorToken`, `buildMexFloorRecipientList`, `sendMexFromFloor`, `handleMexIncoming`, `handleMexFloorSendAck`, `renderMexFloorInbox`, `loadMexFloorInbox`, `insertMexCdCard`, `playMexSound`, `toggleMexPanel`, `mexFloorUpdateCharCount`.
- `renderCountdowns()` coexistence fix: removes only non-`.mex-cd-card` children.
- `subscribeToUpdates()`: adds `onMexIncoming` and `onMexSendAck` callbacks.
- `initializePage()` changed to `async`; awaits `exchangeForFloorToken()` before WS connect.

## department.html Changes (Step 5 additions)
- `buildMexRecipientList()`: appends `__sala__` / Floor option.
- `handleMexIncoming()` + `loadMexInbox()`: shows `_mt('dept.floorDest')` when `from === '__sala__'`.

## Test Files
- `tests/mex-step5-ws.test.js` — 41 plain-Node.js WS/REST security tests, port 4448.
- `tests/mex-step5-render.test.js` — 11 jsdom rendering tests.

**Why:** Floor virtual principal uses a server-side signed role claim (never a client-supplied field) — this prevents any department socket from spoofing the Floor identity.

**How to apply:** Any future feature that adds a new virtual principal (e.g., Kitchen display) should follow the same pattern: server-side role claim in signed token, `ws.isFooBar` set in `joinRoom`, delivery predicate updated accordingly.
