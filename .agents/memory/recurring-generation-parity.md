---
name: Recurring generation parity
description: Durable rules for department identity and realtime lifecycle ordering when recurring templates generate Operations tasks.
---

Recurring templates use the same optional, single active Service department identity as manual Operations tasks. Keep legacy free-text department values readable, but never treat them as canonical identity.

**Why:** Existing templates may contain historical or deactivated department references. Unrelated edits must not silently clear them, while a newly selected department must still be active and company-isolated.

**How to apply:** Preserve unchanged legacy selections, validate explicit changes server-side, and do not migrate templates or rewrite already-generated tasks.

Recurring task creation lifecycle events must be emitted only after the generated tasks and matching template counters are durably committed together.

**Why:** Emitting before persistence can make open calendars refresh for tasks that were not saved; partial persistence can also prevent a later retry.

**How to apply:** Treat generated tasks and their template bookkeeping as one recoverable commit, and publish lifecycle events only after it succeeds.

Recurring-template panels must preflight the required start date before POSTing, because the dynamic panel is not submitted as a native HTML form.

**Why:** An asterisk and date input alone allowed an empty string to reach the server and produce a live Preview 400; focusing the required date and showing the matching contract error was confirmed to restore the authenticated flow.

**How to apply:** Keep server validation authoritative, but block an empty start date in the create panel before calling the API; preserve backend error rendering for every other rejection.