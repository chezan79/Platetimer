---
name: WS join confirmation
description: Why joinRoom must be explicitly confirmed and how realtime clients handle rejection
---
The server confirms a successful WS `joinRoom` with `{ action: 'joinedRoom', success: true }`; rejections arrive as `{ action: 'error', code: TOKEN_REQUIRED|TOKEN_INVALID|ACCOUNT_SUSPENDED }`.

**Why:** the Operations realtime client used to ignore all non-`OPS_*` messages, so a rejected join (expired token, WS_SESSION_SECRET rotation) looked identical to a quiet room — users only saw new tasks after a manual refresh. Any new realtime client must handle both messages.

**How to apply:** clients should treat "no joinedRoom within ~5s" as a failed join (close + reconnect), retry a couple of times on auth error with a freshly-read token, then route through the standard re-auth flow. Realtime-triggered dashboard reloads must request intelligence with `isRealtime=1` so they don't clobber last-visit semantics.
