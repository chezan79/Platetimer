# Service Execution Targeting Architecture and Security Audit

**Audit date:** 2026-09-15  
**Scope:** Read-only audit of Operations → Service task targeting before DEPARTMENT, ROLE, or PERSON targets are implemented.  
**Production behavior/data changes:** None. This document does not change schemas, APIs, UI, authorization, persistence, Firestore rules, migrations, or tests.

## Executive decision

**Operations assignment and Service execution targeting must remain separate concepts.**

`assigneeId` is the stable identifier of an Operations user who owns or is supervised for an Operations task. It is embedded in Operations hierarchy authorization, visibility, completion, progress, workload, performance, escalation, notifications, recurring templates, deletion dependencies, filtering, and presentation. It is not a Service worker identity, Service department membership, or proof that a person at a shared Service device may execute work.

The current Service entitlement is independently defined by:

1. a verified signed session;
2. an active Department Account and active department resolved by the server;
3. an explicitly published canonical Operations task;
4. exact `serviceDepartmentId` equality;
5. an active task status;
6. for lifecycle writes, a short-lived verified `workerId`, live worker and membership checks, and transactional claim/lease/revision rules.

Reusing or overloading `assigneeId` would create ambiguous authority and privilege-escalation paths between two permission namespaces. The safest backward-compatible model is a separate typed Service execution target:

```text
executionTarget {
  type: "DEPARTMENT" | "ROLE" | "PERSON",
  departmentId: "dept_…",
  roleId: "svcrole_…" | null,
  workerId: "worker_…" | null
}
```

The target is company-scoped, server-validated, and independent of:

- `assigneeId` / `defaultAssigneeId`;
- display names;
- Operations roles;
- Department Account IDs;
- current claim and completion attribution.

DEPARTMENT and PERSON targeting are architecturally feasible with the existing canonical department, worker, membership, proof, and lifecycle primitives. ROLE is not: until a canonical Service role registry and worker-role memberships exist, ROLE must remain an open product and architecture decision, not an alias for an Operations role.

## 1. Current canonical model

### 1.1 Canonical task record

Manual and recurring Operations tasks persist the same canonical record shape in the company-keyed Operations task store:

| Concern | Persisted fields | Meaning |
|---|---|---|
| Identity/tenant | `id`, `companyId` | Immutable task and tenant keys |
| Content | `title`, `description`, `notes`, `priority`, legacy `department` | `department` is display text, never entitlement |
| Operations responsibility | `assigneeId`, `assigneeName` | Stable Operations-user join plus display snapshot |
| Provenance | `createdBy`, `createdByName`, timestamps | Server-authored Operations identity |
| Lifecycle | `status`, `completionPercent`, `startedAt`, `completedAt` | Canonical Operations/Service lifecycle |
| Service publication | `publishToService`, `serviceDepartmentId`, `serviceDepartmentName` | Explicit consent, stable department key, display snapshot |
| Collaboration/audit | attachments, comments, history | Internal Operations data; not in safe Service projection |
| Recurrence | `templateId`, `occurrenceKey` | Generated occurrence provenance and deduplication |
| Reminder/escalation | reminder and escalation fields | Operations notification behavior |
| Service action state | claim, lease, attribution, `serviceActionRevision` | Transactional Service lifecycle overlay |

Persisted statuses are `OPEN`, `IN_PROGRESS`, `COMPLETED`, and `CANCELLED`. `OVERDUE` is computed for Operations responses and is not a persisted status.

Evidence:

- manual creation, validation, and persistence: `server.js` task-create routes and task constructors;
- generated constructor: `operations/ops-recurring.js:320-391`;
- lifecycle transaction record: `service/task-action-repository.js:126-170`;
- safe Service projection: `service/task-action-repository.js:194-224`;
- prior schema audit: `docs/service-daily-tasks-architecture-audit.md:42-76`.

### 1.2 Manual creation

The Operations server resolves the authenticated Operations actor and company. The requested assignee must be a same-company Operations user whose legacy `active` flag is not false and must pass `canAssignTaskTo`; task creation does not consistently require lifecycle `status === "ACTIVE"`. The server persists `assigneeId` and a name snapshot. Service publication is a separate opt-in: a supplied Service department ID is checked against an active department in the actor's company, its name is server-derived, and publication is not inferred from the assignee.

Authority fields such as company, creator, timestamps, history actor, and Service department display name are server-owned. Client values are requests, not trusted facts.

### 1.3 Recurring templates and generation

Templates persist `defaultAssigneeId` independently from `serviceDepartmentId` and `publishToService`. `generateTasksForTemplate` copies:

- `defaultAssigneeId` → task `assigneeId`;
- resolved Operations-user name → task `assigneeName`;
- template Service publication fields → task Service publication fields.

The occurrence key is deterministic. Generated tasks are canonical only after persistence; a projected future occurrence is not executable work.

Current validation generally rejects a missing assignee or a record with `active === false`; it does not consistently require `status === "ACTIVE"`, so an `INVITED` record that is not explicitly inactive can remain assignable. During generation, the task retains `defaultAssigneeId`, and if the referenced user record still exists it also retains a name snapshot even when the user's status is not active. These current behaviors are Operations assignment concerns. They must not silently widen or narrow Service execution eligibility.

Evidence: `operations/ops-recurring.js:55-149,320-391`, template create/patch/generate routes in `server.js`, and `tests/operations-sprint3.test.js`.

### 1.4 Persistence and projections

The Operations store remains the broad canonical task store. The Service task-action repository owns a transaction-addressable copy of Service lifecycle state so claim, lease, revision, idempotency, and attribution commit together.

When Firestore is configured, Service actions use a per-company/task document and transaction. Local file mode uses one process queue and atomic replacement and is not multi-process safe. Stale Operations projections cannot overwrite a newer Service revision.

Derived records are not authorization sources:

- calendar mirrors are asynchronous read-only projections;
- WebSocket events are best-effort notifications;
- `assigneeName` and `serviceDepartmentName` are snapshots;
- browser maps and filters are presentation state;
- planned recurring occurrences are projections.

### 1.5 Querying and mutation

Operations list/detail visibility is determined by `canViewTask`, which uses the authenticated actor, task company, `createdBy`, `assigneeId`, and the assignee's Operations role. Editing, reassignment, progress, completion, cancellation, comments, and attachments use action-specific Operations authorization.

Service list and action routes do not authorize through `assigneeId`. They derive company and department from the signed session and live Department Account, then require explicit publication and exact Service department equality. Lifecycle actions additionally require worker proof and repository checks.

### 1.6 Acknowledgement, claiming, leases, and completion

Acknowledgement and individual execution are distinct:

- department acknowledgement is an idempotent department-level fact;
- it does not identify a person and does not complete the Operations task;
- a claim is a worker-level lease;
- start/renew/release/complete require the active claimant and current lease;
- completion records `completedByWorkerId` and a name snapshot;
- completion never derives the actor from `assigneeId` or claim ownership alone;
- Operations override is an explicit Operations-authorized action, not an implicit assignee power.

The repository checks current publication, target department, active status, worker status, Service enablement, membership, authorization versions, expected revision, lease identity, and proof freshness where required.

Evidence: `service/task-action-repository.js:227-264,306-455`; HTTP integration in `server.js`; `tests/service-task-action-repository.test.js`; `tests/service-task-actions-http.test.js`.

### 1.7 Realtime reconciliation

Service WebSocket delivery is department-filtered and uses safe projections. Loss of entitlement is explicit through `OPS_TASK_SERVICE_REMOVED`. HTTP is authoritative on initial load, reconnect, and conflict recovery. Realtime payloads must never establish target eligibility or worker authority.

## 2. Complete `assigneeId` dependency map

### 2.1 Dependency classification

| Surface | Current dependency | Classification | Must remain tied to Operations assignment? |
|---|---|---|---:|
| Create/reassign | validates target Operations user and hierarchy | Supervisory + authorizing | Yes |
| Task list/detail | role hierarchy, creator, self, assignee | Authorizing | Yes |
| Edit/progress/complete | current assignee participates in permission checks | Authorizing | Yes |
| “My tasks” and assignee filters | exact Operations user match | Query/presentation | Yes |
| UI cards/forms/PDF | assignee lookup, grouping, labels, buttons | Presentation | Yes |
| Workload/intelligence/performance | counts and profiles by assignee | Supervisory/analytics | Yes |
| Assignment/reminder email | recipient derived from assignee | Notification | Yes |
| Escalation | chain starts from assignee's Operations role | Notification | Yes |
| Recurring templates | `defaultAssigneeId` copied to generated task | Supervisory | Yes |
| User deletion | task/template references block deletion | Referential integrity | Yes |
| Calendar projection | assignee label may be displayed | Presentation only | Yes |
| Service publication | no entitlement from assignee | None | No authorization dependency |
| Service acknowledgement | department-scoped, no assignee check | Execution visibility | No dependency |
| Service claim/lease | verified worker and department entitlement | Execution authority | No dependency |
| Service completion attribution | verified `workerId` | Audit/authority | No dependency |
| Service repository sync | assignment metadata changes increment `serviceActionRevision` | Reconciliation/conflict | Preserve explicitly |

### 2.2 Authorization dependencies

`operations/ops-auth.js` establishes the strongest reason not to reuse the field:

- `canAssignTaskTo` applies the Operations role hierarchy;
- `canViewTask` grants visibility through assignment and assignable subordinate roles;
- `canEditTask` depends on continued authority over the current assignee;
- `canCompleteTask` is Operations-assignee-only;
- `canUpdateProgress` grants the assignee a direct path;
- `hasUserDependencies` treats assignment and template defaults as historical references;
- escalation maps the Operations assignee's role to Operations recipients.

Changing the type or meaning of `assigneeId` would therefore alter existing authorization, not merely presentation.

### 2.3 Server query, analytics, and notification dependencies

The server and Operations modules use assignment for:

- list filters, `my=1`, sort, and search;
- dashboard and workload counts;
- intelligence priority, load, risk, performance, and coaching views;
- reminders and assignment mail;
- escalation recipient lookup;
- user dependency checks and lifecycle administration;
- recurring generation and generated-task ownership;
- history entries for old/new assignment.

These consumers expect an `opsu_…` identifier resolvable in the Operations user map. A department, role, or `worker_…` identifier would either become unresolved or be misinterpreted as an Operations user.

`assigneeId` also has one important non-authorizing Service dependency. `TaskActionRepository.syncTask()` includes it in the metadata comparison used to increment `serviceActionRevision` in both local and Firestore paths (`service/task-action-repository.js:743-813`). Reassignment does not grant or revoke Service entitlement and does not itself invalidate a claim, but it does advance the Service revision so stale actions conflict and clients reconcile the changed task metadata. A future target model must preserve this behavior intentionally or replace it with an equally explicit revision rule.

### 2.4 Client dependencies

Operations pages use `assigneeId` to:

- populate and select Operations assignee controls;
- resolve name/role from the Operations users map;
- group PDF exports by assignee;
- filter “mine” and search;
- decide which Operations start/complete controls to show;
- display reassignment and history.

The browser is not authoritative, but overloading the field would make incorrect controls and disclosures likely even before server enforcement.

Evidence: `public/operations-tasks.html`, `public/operations-templates.html`, `public/js/operations-common.js`.

### 2.5 Tests as contract evidence

Existing tests assert:

- role-based assignment and visibility;
- assignee-only Operations completion;
- creator/assignee edit and progress rules;
- same-company assignee validation using the current legacy `active !== false` rule;
- reassign history and notifications;
- recurring default assignment and inactive assignees;
- assignee filters, dashboard counts, performance, and PDF grouping;
- Service safe projections omit `assigneeId`;
- Service claim/complete uses worker proof rather than assignment.

Material suites include:

- `tests/operations-sprint2.test.js`;
- `tests/operations-sprint3.test.js`;
- Operations calendar, intelligence, performance, user-management, email, and UI tests;
- `tests/ops-service-sync.test.js`;
- `tests/service-today-tasks.test.js`;
- `tests/service-task-actions-http.test.js`;
- `tests/service-worker-identity.test.js`;
- `tests/service-task-action-repository.test.js`.

## 3. Service identity and execution eligibility

### 3.1 Principal separation

| Principal | Stable identifier | Authority |
|---|---|---|
| Operations user | `opsu_…` | Operations hierarchy and supervision |
| Department Account | `depacct_…` | Shared device/workspace access to one department |
| Service worker | `worker_…` | Verified individual attribution and eligible memberships |
| Service department | `dept_…` | Publication and workspace boundary |

A worker may optionally link to an Operations user, but that link is attribution/reporting metadata. `operations/ops-auth.js` explicitly states that linking does not import the Operations role.

### 3.2 Worker eligibility

The worker store provides:

- immutable `workerId` and `companyId`;
- status and `serviceEnabled`;
- active department memberships with authorization versions and optional validity windows;
- a server-held PIN verifier;
- optional same-company Operations link;
- safe projections that exclude verifier secrets;
- worker and membership version increments on revocation-relevant changes.

The browser stores only short-lived proof in `sessionStorage`. It sends proof separately from the Department Account session. The server must resolve all authority from the proof and live records; client-selected worker IDs and names are not authority.

Evidence: `service/service-workers.js`, `public/js/service-worker-identity.js`, `tests/service-worker-identity.test.js`.

### 3.3 Target-type feasibility

#### DEPARTMENT

Stable key: canonical `dept_…`.

Eligibility:

- task and department belong to the same company;
- department is active;
- publication is explicit;
- device is bound to that department;
- worker has a current active membership in that department for writes.

This is the current supported targeting dimension. The existing `serviceDepartmentId` already carries it, though it is coupled to publication and should be normalized into the typed target only through a backward-compatible transition.

#### PERSON

Stable key: canonical `worker_…`, never name, email, Operations user ID, or browser profile.

Eligibility:

- same company as task and target department;
- worker active and Service-enabled;
- active, time-valid membership in target department;
- valid worker proof on the current active Department Account;
- exact target-worker match at claim/action time;
- live authorization-version checks.

A multi-department worker must still act from a device whose bound department equals the task's target department. A PERSON target cannot bypass the department workspace boundary.

#### ROLE

No canonical Service role model currently exists.

Operations roles are managerial hierarchy roles, not Service execution qualifications. Worker memberships currently express departments only. A safe ROLE target requires a new company-scoped Service role registry with stable immutable IDs, lifecycle, governance, worker-role memberships (normally scoped to a department), authorization versions, and explicit assignment-management policy.

Open product decisions:

- Are roles company-global or department-scoped?
- Who creates, renames, deactivates, and assigns them?
- Can one worker hold several roles in one department?
- Are roles qualifications, shift positions, or permission grants?
- What happens to active claims when a role membership changes?

Until answered, ROLE must fail closed and must not be inferred from Operations roles or display text.

## 4. Recommended canonical target model

### 4.1 Conceptual schema

For tasks:

```text
serviceExecutionTarget {
  type: "DEPARTMENT" | "ROLE" | "PERSON",
  departmentId: string,
  roleId: string | null,
  workerId: string | null
}
serviceExecutionTargetVersion: integer
```

For recurring templates:

```text
defaultServiceExecutionTarget {
  type,
  departmentId,
  roleId,
  workerId
}
```

Optional display snapshots may be stored or projected separately:

```text
serviceExecutionTargetDisplay {
  departmentName?,
  roleName?,
  workerName?
}
```

Snapshots never authorize.

### 4.2 Invariants

1. `assigneeId` always refers only to an Operations user.
2. `defaultAssigneeId` always refers only to an Operations user.
3. An execution target always belongs to the task's company.
4. Every target includes one canonical department boundary.
5. DEPARTMENT requires no role or worker ID.
6. ROLE requires a canonical Service role ID valid for that department.
7. PERSON requires a canonical worker ID with a valid membership in that department.
8. Publication is explicit; target presence alone never publishes.
9. Device department must equal target department for every Service read/write.
10. Person/role eligibility is rechecked from live server state at each lifecycle action.
11. Names, Operations links, browser state, request company, and request department never grant access.
12. Target changes increment the Service action revision and invalidate incompatible active claims atomically.
13. Historical claim/completion actor IDs and target snapshots are not rewritten after later lifecycle changes.
14. Acknowledgement remains a department-level fact unless a new, explicitly versioned acknowledgement contract is introduced.

### 4.3 Compatibility default

Legacy tasks without `serviceExecutionTarget` retain current behavior:

```text
if publishToService === true and serviceDepartmentId is valid:
    effective target = DEPARTMENT(serviceDepartmentId)
else:
    no Service execution target
```

This is a read-time compatibility rule, not an immediate backfill. It preserves current Service visibility and action behavior.

During transition:

- existing fields remain readable and legacy-only writes remain accepted;
- every server write first normalizes the request against the persisted record;
- if a legacy writer changes only `serviceDepartmentId` or `publishToService`, the server derives and writes the corresponding DEPARTMENT target in the same transaction;
- if a target-aware writer supplies the typed target, the server derives and writes matching legacy department fields in the same transaction;
- if one request explicitly supplies both representations and they disagree, the server rejects it;
- compare-and-set revision checks serialize old/new writer races; the losing writer must reload rather than silently overwrite either representation;
- reads project one effective target;
- migration/backfill is deferred and separately approved;
- removing legacy fields occurs only after telemetry and compatibility gates show no old writers.

### 4.4 Validation ownership

Only the server validates and resolves targets.

Operations write endpoints:

- derive company and actor from authenticated Operations state;
- apply a new explicit target-management permission;
- resolve department/role/worker by stable ID in that company;
- require active entities and valid membership for new targets;
- persist snapshots only after canonical lookup.

Service read/action endpoints:

- derive company and device department from signed session and live Department Account;
- derive worker from verified proof;
- evaluate the persisted effective target;
- never accept an authorization-changing company, department, role, worker, or target type from the browser.

Persistence:

- commits target changes, claim invalidation, revision increment, history, and indexes atomically;
- rejects stale revisions and incompatible idempotency replay;
- emits realtime only after commit.

### 4.5 Read/write authorization matrix

| Action | Operations authority | Service device | Worker proof | Target predicate |
|---|---|---|---|---|
| View/edit Operations assignment | Existing hierarchy | No | No | None |
| Create/change Service target | Explicit future Ops permission | No | No | Same-company valid target |
| View Service task | No | Active exact department | Not required | Effective target potentially includes department |
| Acknowledge | No | Active exact department | Current semantics: not required | Department-level entitlement |
| Claim DEPARTMENT | No | Active exact department | Required | Active membership |
| Claim ROLE | No | Active exact department | Required | Active department + role membership |
| Claim PERSON | No | Active exact department | Required | Exact worker + active membership |
| Start/renew/release/complete | No | Active exact department | Required | Target still valid + active lease ownership |
| Override active claim | Explicit Operations authority | No | No | Lease/revision match |

Whether a non-matching worker may *see* a PERSON- or ROLE-targeted card is a product decision. The privacy-preserving default is:

- department device may receive a minimal queue item;
- only an eligible verified worker receives actionable details and controls;
- if task content itself is sensitive, require proof before returning the item at all.

### 4.6 Inactive and changed entities

| Change | New claims | Existing claim | History |
|---|---|---|---|
| Department inactive | Deny and remove from Service | Invalidate atomically | Preserve IDs/snapshots |
| Role inactive/deleted | Deny | Invalidate if role required | Preserve role ID/snapshot |
| Worker suspended/archived/disabled | Deny | Invalidate | Preserve worker attribution |
| Membership removed/expired | Deny in that department | Invalidate | Preserve membership/version evidence |
| Person target changed | Only new person eligible | Invalidate old claim | Record old/new target |
| Role membership changed | Re-evaluate live | Invalidate incompatible claim | Preserve original claim context |
| Operations assignee changed | No Service eligibility effect | No claim effect | Existing assignment history |

Hard deletion of referenced target entities should be prevented. Archive/deactivate instead so historical IDs remain resolvable.

## 5. Alternatives considered and rejected

### A. Reuse `assigneeId`

Rejected.

- changes Operations authorization semantics;
- cannot represent Service-only workers;
- conflates supervision with execution;
- makes Operations roles accidental Service roles;
- breaks user lookup, analytics, notifications, and templates;
- can leak Operations visibility or allow Service action through an unrelated Operations link;
- cannot cleanly represent department-wide or role-wide eligibility.

### B. Overload `serviceDepartmentId`

Rejected as the final model.

It safely represents the department boundary today, but cannot encode role/person type without companion ambiguity. Keep it as the legacy compatibility field while introducing a typed object.

### C. Use display names or free-text `department`

Rejected.

Names are mutable, non-unique, cross-company-colliding, localization-sensitive, and client-influenceable. They are presentation only.

### D. Derive Service roles from Operations roles

Rejected.

Operations roles encode supervisory hierarchy. They do not prove Service qualification, shift position, department membership, or worker proof. Optional worker→Operations links are explicitly permission-neutral.

### E. Derive PERSON from the Operations assignee

Rejected.

Not every Operations user is a Service worker, not every Service worker has an Operations account, and the optional link may change. This would turn supervisory assignment into execution authority without proof.

### F. Store separate nullable fields without a discriminator

Rejected.

Combinations such as department + role + worker become ambiguous: intersection, fallback, preference, or stale residue. A required type with exact field rules is easier to validate and audit.

## 6. Threat analysis and required guarantees

The focused threat model is in `docs/service-execution-targeting-threat-model.md`.

Principal guarantees:

1. **Tenant isolation:** every target and actor is resolved inside the authenticated company.
2. **Department isolation:** the device's live bound department must equal the target department.
3. **Namespace separation:** Operations assignment never grants Service execution.
4. **Proof binding:** worker eligibility requires server-verified, short-lived proof bound to the current device/account/department context.
5. **Live revocation:** worker, membership, department, role, and account state are rechecked for lifecycle writes.
6. **Atomicity:** target, lease, revision, history, and invalidation changes commit together.
7. **Replay safety:** idempotency keys bind to the complete action and target-relevant fingerprint.
8. **Fail-closed clients:** events and browser state never authorize; HTTP/repository state is canonical.
9. **Auditability:** stable IDs and server-authored actor/target snapshots support repudiation review.
10. **No existence oracle:** cross-company and sibling-department failures do not disclose target/task existence.

## 7. Complete impact map for later implementation

| Area | Future work |
|---|---|
| Task schema | typed target, version, compatibility resolver |
| Template schema | typed default target and generation parity |
| Operations auth | explicit target-management permission separate from assignment |
| Operations APIs | create/patch/detail/list contracts and mismatch rejection |
| Service APIs | target-aware list/today/detail/action predicates |
| Worker model | PERSON eligibility; role memberships if ROLE is approved |
| Role model | new registry, lifecycle, memberships, governance |
| Repository | atomic target change + lease invalidation + revision/history |
| Repository synchronization | preserve assignment metadata revision increments while adding target-aware revision/invalidation |
| Acknowledgement | retain department semantics or version explicitly |
| Realtime | eligible delivery, explicit removals, revision ordering |
| HTTP reconciliation | effective-target projection and conflict recovery |
| Calendar | display target only; never authorize from mirror |
| Notifications | decide whether target adds Service notifications; preserve Ops assignee mail |
| Intelligence/performance | keep Operations assignment metrics separate; add explicit execution metrics |
| User/worker deletion | dependency checks for target and history references |
| UI | separate “Operations owner” and “Service execution target” controls |
| History | distinct assignment-changed and execution-target-changed events |
| Persistence/indexes | company/department/type/role/worker indexes; multi-server transactions |
| Firestore rules | remain deny-by-default to clients; Admin server owns writes |
| Tests | matrix below plus unchanged Operations contracts |

## 8. Phased roadmap and acceptance gates

### Phase 0 — Product decisions

- define Service role semantics and governance;
- define PERSON/ROLE visibility before worker verification;
- define who may change targets and when;
- define target-change behavior for acknowledged tasks;
- define whether claimed work can be retargeted or must first be released.

Gate: written policy with no reuse of Operations roles by implication.

### Phase 1 — Contract and compatibility resolver

- add typed conceptual contracts and strict validators;
- implement effective DEPARTMENT fallback from legacy fields;
- add server-side normalization for legacy-only and target-aware writes;
- add read-only projections and persisted mismatch diagnostics;
- no behavior change.

Gate: legacy fixtures produce identical Service visibility; malformed/mismatched targets fail closed; old-only, new-only, and mixed-version concurrent writes have deterministic revision-checked outcomes.

### Phase 2 — DEPARTMENT typed target

- dual-write legacy and typed department target;
- add target-specific history/revision semantics;
- keep current acknowledgement and worker action behavior.

Gate: company/department isolation, recurring parity, inactive department handling, calendar non-authority, HTTP/WS reconciliation.

### Phase 3 — PERSON target

- validate canonical workers and memberships;
- apply exact-person claim eligibility;
- atomically invalidate incompatible claims after target/membership changes;
- preserve optional Operations links as permission-neutral.

Gate: proof replay, stale membership, worker revocation, multi-department worker, target change, lease race, attribution, and privacy tests pass.

### Phase 4 — ROLE foundation and target

- only after role product decisions;
- add canonical Service role registry and versioned department-scoped memberships;
- add ROLE eligibility and lifecycle invalidation.

Gate: role rename/deactivation, membership changes, multiple roles, company/department isolation, and no Operations-role inheritance.

### Phase 5 — Migration and retirement

- audit stored tasks/templates for legacy combinations;
- backfill in a separately approved, idempotent migration;
- monitor old-client writes;
- retire legacy fields only after all readers/writers use the typed contract.

Gate: reversible migration plan, sampled reconciliation, no unresolved IDs, no active lease corruption.

### Required test matrix

- task/template schema validation and legacy fallback;
- legacy-only write normalization, target-aware dual-write, explicit mismatch rejection, and old/new writer races;
- same-company stable-ID resolution for all target types;
- cross-company and sibling-department non-disclosure;
- inactive department/role/worker and expired membership;
- multi-department worker from correct and incorrect devices;
- forged client company/department/role/worker/name/Operations link;
- acknowledgement semantics unchanged;
- first-claim wins across concurrent servers;
- stale revision, lease expiry, renewal, release, override, and retarget races;
- proof expiry/replay/handoff and fresh completion proof;
- target change after claim and after start;
- exact completion attribution independent of Operations assignee;
- Operations reassignment continues to advance Service action revision without changing execution eligibility or invalidating a compatible claim;
- recurring generation parity and inactive target policy;
- HTTP reconciliation after missed/out-of-order realtime events;
- explicit removal on entitlement loss;
- no failed persistence event;
- Operations assignment, hierarchy, notifications, analytics, calendar, and deletion tests unchanged.

## 9. Evidence index

Primary code:

- `server.js`
- `operations/ops-auth.js`
- `operations/ops-recurring.js`
- `operations/ops-scheduler.js`
- `operations/ops-intelligence.js`
- `operations/ops-assistant.js`
- `service/service-workers.js`
- `service/task-action-repository.js`
- `public/operations-tasks.html`
- `public/operations-templates.html`
- `public/js/operations-common.js`
- `public/js/service-worker-identity.js`
- `firestore-rules.txt`

Architecture context:

- `docs/service-daily-tasks-architecture-audit.md`
- `docs/service-individual-identity-architecture-audit.md`
- `docs/operations-template-creation-audit.md`

Contract tests:

- `tests/operations-sprint2.test.js`
- `tests/operations-sprint3.test.js`
- `tests/ops-service-sync.test.js`
- `tests/service-today-tasks.test.js`
- `tests/service-task-actions-http.test.js`
- `tests/service-task-action-repository.test.js`
- `tests/service-worker-identity.test.js`

## Final recommendation

Preserve `assigneeId` as Operations supervisory responsibility. Introduce a separate typed Service execution target with a mandatory department boundary and optional canonical Service role or worker identity according to the discriminator. Treat legacy `publishToService + serviceDepartmentId` as DEPARTMENT targeting during transition. Implement PERSON only through verified `workerId` and live membership checks. Do not implement ROLE until a canonical Service role model and governance policy exist.

The authorization chain for future execution must remain:

**verified session → live active Department Account → exact active target department → explicitly published canonical task → typed target eligibility → fresh verified worker proof → live worker/membership/role state → transactional lease/revision commit → safe realtime notification → HTTP reconciliation.**