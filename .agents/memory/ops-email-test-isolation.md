---
name: Operations email test isolation
description: How to prevent spawned Operations test servers from using configured live email providers.
---

Operations integration tests that copy `process.env` into a spawned server must explicitly clear both SMTP and Resend settings unless they intentionally target a local Resend mock.

**Why:** Workspace secrets can be inherited by test child processes, turning a test assignment notification into a real provider request instead of the expected fallback behavior.

**How to apply:** For fallback tests, set `RESEND_API_KEY` and `RESEND_API_BASE` to empty strings along with the SMTP settings. Only the dedicated Resend mock suite should provide a test key and a loopback API base.