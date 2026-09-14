---
name: Operations → Service task sync
description: Authorization model for projecting Ops tasks onto Service department pages and why removal is a dedicated event
---

# Operations → Service task sync

**Rule 1 — removal is an explicit server event.** Service department pages must never infer loss of entitlement from an updated task payload (they may not even receive it). Every revocation path (dept move, unpublish, complete, cancel, delete) snapshots the previous publication state BEFORE mutating and emits a dedicated removal event afterwards. Any new task-mutation endpoint must follow the same snapshot-then-signal pattern.

**Rule 2 — bound Service sockets never get raw Ops payloads.** The company-room ops broadcast filters per socket: department-account sockets receive only a safe projection (same shape as the Service HTTP endpoint) when currently entitled, or the minimal removal event when previously entitled; everything else is withheld. Any new ops broadcast type must be explicitly classified in that filter — the default is withheld.

**Rule 3 — live authorization, not join-time.** Both the Service HTTP read and the WS delivery re-check that the bound department is still ACTIVE at request/delivery time; deactivating a department (which also auto-suspends its account → 403 ACCOUNT_SUSPENDED wins over 410 DEPARTMENT_INACTIVE) revokes access immediately.

**Rule 4 — the Service daily UI reconciles, it does not merge.** Realtime changes and reconnects invalidate the current daily view and refresh it from the canonical daily source. Realtime payloads must not determine daily membership.

**Why:** delivery filtering is a security boundary, while daily membership depends on several mutable fields and the current business date. A canonical refresh preserves both authorization and consistency.

**How to apply:** preserve explicit revocation signals for secure delivery, but treat entitled task changes as refresh signals in daily Service views. Never calculate recurrence or daily membership in the browser.
