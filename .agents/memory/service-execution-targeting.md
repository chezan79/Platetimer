---
name: Service execution targeting
description: Durable separation and compatibility rules for future DEPARTMENT, ROLE, and PERSON task targets.
---

Operations supervisory assignment and Service execution eligibility are separate permission namespaces. Never overload `assigneeId` or infer Service authority from Operations roles or optional worker links.

**Why:** Operations assignment drives hierarchy, visibility, completion, analytics, notifications, templates, and Service revision reconciliation. Reusing it would alter existing authorization and exclude Service-only workers.

**How to apply:** Use a typed Service target with a mandatory canonical department boundary. PERSON uses a verified canonical worker and live membership. ROLE must fail closed until a separate canonical Service role registry and governance model exist. During transition, normalize legacy-only and typed writes server-side and serialize mixed writers with revisions. Every writer must participate, including metadata-only edits, schedulers, recurring generation, and cross-store commits; stale metadata may merge onto the authoritative target, but may never restore an older target or publication state. Explicit typed null or typed/legacy disagreement fails closed.

Worker authorization changes must advance an authoritative fence in the same transaction domain used by Service actions; actions validate the fence before revision or idempotency responses, and incompatible active leases are invalidated with the fence.

**Why:** Resolving a proof before the task transaction leaves a suspension, membership change, PIN reset, or proof revocation race where a stale action can still commit. Checking revisions first can also disclose PERSON task details.

**How to apply:** Keep worker and membership authorization versions plus proof revocation epoch in the action repository's transactional authority. Materialize time-based membership expiry on the next authoritative read/action. Refresh both canonical worker and department state before selector reads, manual target writes, and recurring generation; startup-loaded department state can become stale while Firestore remains authoritative.