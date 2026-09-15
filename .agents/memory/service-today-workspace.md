---
name: Service Today workspace
description: Canonical classification and safe worker attribution rules for the Service daily execution view.
---

Classify active tasks by both canonical status and active claim state. Any `OPEN` or `IN_PROGRESS` task without an active claim remains reclaimable in To do; active claims belong in In progress.

**Why:** Releasing or expiring a claim preserves `IN_PROGRESS`, so status-only classification can silently hide valid work.

**How to apply:** Keep HTTP canonical state authoritative. Use current verified-worker identity only for ownership ordering and controls, and use only the canonical completion worker name for completion attribution—never infer it from the former claimant.

Worker identity verification, handoff, clear, expiry, and server invalidation must immediately rerender task controls from the current in-memory workspace.

**Why:** Tasks can load before a worker is selected, and stale controls after identity changes either remain hidden or predictably fail authorization.

**How to apply:** Subscribe the workspace to the identity module's safe state-change notification; do not require an unrelated HTTP or realtime task refresh.

Lease countdowns are display-only. The browser may schedule and format time from the projected canonical expiry, but reaching zero must trigger one canonical HTTP reconciliation rather than locally expiring or reclassifying the claim.

**Why:** Client clocks and delayed tabs cannot authoritatively determine a claim lifecycle transition.

**How to apply:** Remove stale warnings immediately on identity or realtime invalidation, consume successful action responses, and let the next canonical read determine whether a claim renewed, expired, released, or completed.

The optional personal view is presentation-only and defaults to the complete department workspace. It may show only active canonical claims owned by the currently verified worker, and must return to the complete view when worker verification is lost.

**Why:** A shared Service device can change hands, while filtering must never become authorization or leave another worker's personal view exposed after proof expiry.

**How to apply:** Derive the personal subset from the in-memory canonical response and current verified proof; never change the endpoint, canonical task map, or action authorization based on the selected view.