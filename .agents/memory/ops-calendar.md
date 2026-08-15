---
name: Operations planning calendar
description: Day/Week/Month ops calendar page — timezone contract and shared window logic
---

The Operations calendar (operations-calendar.html) shares its Day/Week/Month window/grouping logic with tests via `public/js/operations-calendar-core.js` (UMD: `OpsCalCore` in browser, `module.exports` in Node). Do not fork the logic — tests require the real module.

**Timezone contract:** the client builds windows in LOCAL time with calendar-date constructors (never fixed 86400000 ms steps — DST-unsafe) and queries `GET /api/operations/tasks?start=&end=` with offset-bearing ISO instants (`toISOString()`). The server compares instants; bare `YYYY-MM-DD` params are still accepted with UTC semantics (end extended to end-of-day) for API convenience.

**Why:** a completion review rejected bare-date queries — `Date.parse('YYYY-MM-DD')` is UTC, so a task due 00:30 local in a UTC+ zone vanished from its local day; ms-based week math breaks across DST.

**How to apply:** any new date-window feature (ops or service) should send instants and do calendar math via `OpsCalCore.addDays`/`calWindow`. Regression tests run the test process under `TZ=Pacific/Auckland` with the spawned server under `TZ=UTC` (tests/operations-calendar.test.js, port 5089) — reuse that pattern for TZ coverage.

The `start`/`end` filter is applied after `canViewTask` visibility in the tasks list endpoint, so it can never widen access.
