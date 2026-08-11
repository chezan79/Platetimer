---
name: Countdown lifecycle & history
description: 120s post-expiry grace, server-authoritative completion, persistent countdown history
---
- POST_EXPIRY_GRACE_MS (default 120000, env-overridable for tests) is the single grace constant; delivered to clients as `graceMs` in every startCountdown/replay payload and in the REST /api/countdowns response — clients must never hardcode their own value.
- All countdown endings (auto-expiry sweep, lazy join cleanup, manual delete, table-reuse supersession) route through `completeCountdown()` → `archiveCountdown()` (idempotent by countdown id) so exactly one history record exists per countdown. Never delete from activeCountdowns directly.
- A 2s sweep (not per-countdown timers) broadcasts `countdownCompleted` at endsAt+grace; clients treat it like deleteCountdown and keep a local endsAt+grace fallback for dropped sockets.
- Grace is anchored to the original `endsAt` — replay on reconnect sends timeRemaining 0 with the original endsAt so grace never restarts.
- History store: countdown-history.json / Firestore doc `countdown_history`, keyed by verified companyId only; reasons: auto_expired, manual_deleted, superseded (reserved: manual_completed, cancelled); records carry an empty `events` array for a future event timeline.
- **Why:** duplicate archives or client-side removal decisions caused screens to desync; the single-path rule prevents both.
- **How to apply:** any new countdown-ending code path must call completeCountdown, and any new payload field for clients goes into both the live broadcast and the join replay.
