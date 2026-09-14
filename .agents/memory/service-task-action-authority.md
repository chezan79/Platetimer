---
name: Service task action authority
description: Durable transaction and reconciliation rules for verified Service worker task actions.
---

Service task claims, department acknowledgements, lease transitions, idempotency results, history, and the full recoverable task record must share one transaction-addressable authority. Legacy whole-store Operations persistence is a projection/cache, not the conflict boundary.

**Why:** Separate claim/ack or Service/Operations writes allow both sides of a race to succeed, stale instances to restore old publication, or a restart to lose a committed completion.

**How to apply:** Route every Service action and Operations mutation through the task-action repository before success or realtime emission. Reconcile HTTP/startup state from its full record, transactionally materialize expired leases during reads, index active leases for revocation, and require revision plus exact lease ID for overrides.