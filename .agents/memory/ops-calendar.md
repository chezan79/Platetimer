---
name: Operations planning calendar
description: Day/Week/Month ops calendar page — timezone contract and shared window logic
---

The Operations calendar shares its Day/Week/Month window/grouping logic with tests through a shared browser/Node module. Do not fork the logic.

**Timezone contract:** the dedicated Operations Calendar read endpoint accepts authoritative date-only bounds and interprets them as Europe/Zurich days. Persisted Tasks receive a server-derived Zurich calendar date; planned recurrence dates remain date-only strings.

**Why:** browser-local grouping can put a returned Task on the wrong day outside Zurich, while parsing recurrence dates as UTC shifts planned entries. Explicit Zurich bounds and server grouping keys keep both collections aligned across DST.

**How to apply:** keep real Tasks and planned occurrences separate. Planned reads must never generate or persist Tasks, publish to Service, or emit lifecycle events. Bound recurrence projection work and use occurrence metadata only for in-memory deduplication.

Visibility must be applied with the same task authorization rules before either collection is returned; date filtering must never widen access.
