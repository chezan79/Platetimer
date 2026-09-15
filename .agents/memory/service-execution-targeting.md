---
name: Service execution targeting
description: Durable separation and compatibility rules for future DEPARTMENT, ROLE, and PERSON task targets.
---

Operations supervisory assignment and Service execution eligibility are separate permission namespaces. Never overload `assigneeId` or infer Service authority from Operations roles or optional worker links.

**Why:** Operations assignment drives hierarchy, visibility, completion, analytics, notifications, templates, and Service revision reconciliation. Reusing it would alter existing authorization and exclude Service-only workers.

**How to apply:** Use a typed Service target with a mandatory canonical department boundary. PERSON uses a verified canonical worker and live membership. ROLE must fail closed until a separate canonical Service role registry and governance model exist. During transition, normalize legacy-only and typed writes server-side and serialize mixed writers with revisions. Every writer must participate, including metadata-only edits, schedulers, recurring generation, and cross-store commits; stale metadata may merge onto the authoritative target, but may never restore an older target or publication state. Explicit typed null or typed/legacy disagreement fails closed.