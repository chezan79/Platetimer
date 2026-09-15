# Service Execution Targeting Threat Model

**Date:** 2026-09-15  
**Status:** Read-only design reference; no runtime or data changes.  
**Parent audit:** `docs/service-execution-targeting-architecture-audit.md`

## Scope

This model covers future DEPARTMENT, ROLE, and PERSON execution targets for Operations-published Service tasks. It supplements existing Service identity and lifecycle audits. It does not model unrelated countdown, Mex, voice, calendar, or general Operations features except where they share a trust boundary.

## Assets

- tenant and department task confidentiality;
- integrity of execution targets and publication state;
- worker eligibility and proof;
- claim/lease ownership and task revision;
- completion attribution and history;
- Operations assignment and hierarchy isolation;
- target, worker, role, and membership lifecycle records;
- idempotency and active-lease indexes.

## Principals and trust boundaries

| Boundary | Untrusted side | Trusted decision |
|---|---|---|
| Browser → API | request body, query, storage, decoded token, names | verified session and server records |
| Department device → worker proof | selected profile/PIN/proof header | proof verification plus live worker/membership state |
| Operations → Service | `assigneeId`, Ops role, display labels | explicit publication and typed execution target |
| Service → persistence | action request and expected revision | transactional repository |
| Persistence → realtime | event payload/order | committed revision; HTTP reconciliation |
| Calendar/template projection → task | mirrors/planned occurrences | persisted canonical generated task |

## Threat scenarios and controls

### Spoofed person or role

**Scenario:** A browser submits another `workerId`, role label, Operations user ID, or display name.

**Guarantee:** PERSON and ROLE eligibility comes only from the persisted target, verified worker proof, and live company-scoped membership lookups. Request display fields and optional Operations links are ignored for authority.

### Target tampering

**Scenario:** A client changes `type`, `departmentId`, `roleId`, or `workerId`, or sends conflicting legacy and typed fields.

**Guarantee:** Only authorized Operations endpoints may request target changes. The server resolves stable IDs in the authenticated company, validates exact field combinations, rejects mismatches, and atomically records old/new target and revision.

### Cross-company disclosure

**Scenario:** An attacker guesses a task, worker, role, or department ID from another tenant.

**Guarantee:** Every lookup is rooted in the authenticated company. Responses do not distinguish “exists elsewhere” from “not available here.” No global lookup may be used without a subsequent exact company check.

### Cross-department disclosure or action

**Scenario:** A valid Department Account requests a sibling department's targeted work.

**Guarantee:** The server re-resolves the live Department Account and department and requires exact equality with the target department. A worker's membership in another department does not expand the device's department boundary.

### Operations privilege escalation

**Scenario:** An Operations assignee, Operations role, or worker→Operations link is treated as Service eligibility.

**Guarantee:** Assignment and execution are separate namespaces. `assigneeId` and Operations role never satisfy a Service target. Optional links are reporting-only unless a future permission is explicitly designed and tested.

### Service-to-Operations confused deputy

**Scenario:** A Service action causes a broader Operations mutation because the task has an Operations assignee.

**Guarantee:** Service endpoints expose only explicit lifecycle actions and safe projections. They cannot reassign, edit content, change target, comment, or exercise Operations hierarchy authority.

### Stale worker, role, or membership

**Scenario:** Proof or a lease remains usable after suspension, membership expiry, role removal, account suspension, or department deactivation.

**Guarantee:** Writes recheck live state and authorization versions. Revocation-relevant changes invalidate incompatible active leases transactionally or cause subsequent actions to fail closed.

### Proof replay and unattended devices

**Scenario:** A copied or abandoned proof is reused.

**Guarantee:** Proof is short-lived, inactivity-limited, bound to company/device account/department and verifier version, and cleared at handoff. Sensitive completion requires fresh proof. Rate limits and lockout protect verifier attempts.

### Target change during active work

**Scenario:** A task is retargeted while claimed or after start.

**Guarantee:** Target change, lease invalidation, revision increment, history, and indexes commit atomically. A stale claimant receives a conflict and cannot complete under the old target.

### Multi-server race

**Scenario:** Two workers claim simultaneously or target changes race with claim/complete.

**Guarantee:** Production uses transaction-addressable persistence with compare-and-set revision semantics and first-writer-wins. Local file mode is not considered multi-server safe.

### Idempotency confusion

**Scenario:** A key is replayed with a different worker, target, lease, revision, or payload.

**Guarantee:** Idempotency fingerprints cover company, task, action, worker, department, target-relevant state, lease, and expected revision. Same-key/different-payload requests fail.

### Repudiation

**Scenario:** A worker or manager disputes who targeted, claimed, released, overrode, or completed work.

**Guarantee:** The server authors history with stable actor IDs, actor kind, target IDs, department/device context, verification strength, revision, timestamps, and display snapshots. Clients cannot author actor identity.

### Realtime spoofing or reordering

**Scenario:** A stale or forged browser event makes work visible or actionable.

**Guarantee:** Events follow successful commits, contain monotonic revisions, and never authorize. Entitlement loss has an explicit removal event. Clients reconcile through authenticated HTTP after reconnect or revision gaps.

### Calendar or template confused authority

**Scenario:** A calendar mirror or planned recurring occurrence is treated as executable.

**Guarantee:** Only the persisted canonical task can be listed or acted on. Calendar mirrors and future occurrence projections are presentation data.

### Role-name collision and lifecycle

**Scenario:** A mutable role name collides across departments/companies or a renamed role changes historical meaning.

**Guarantee:** ROLE uses an immutable company-scoped canonical ID and versioned department-scoped membership. Names are snapshots. Referenced roles are archived, not hard-deleted.

## Security acceptance gates

No target type should ship unless tests prove:

- server-derived company and exact device department;
- stable canonical target IDs and strict discriminator validation;
- no authorization from names, Operations roles, links, or browser state;
- live entity and membership checks;
- atomic target/lease/revision/history behavior;
- replay-safe idempotency;
- no cross-tenant or sibling-department existence oracle;
- explicit realtime removals and HTTP reconciliation;
- unchanged Operations assignment and acknowledgement contracts;
- denial of ROLE until a canonical Service role model exists.

## Residual risks and product decisions

- Short PINs can be shared or observed; proof strength and operational friction require product review.
- Department-level visibility of PERSON-targeted content may expose sensitive work; visibility policy must be explicit.
- ROLE semantics are undefined and cannot safely be implemented from current Operations roles.
- Retargeting started work may be operationally undesirable even if technically safe; policy must decide whether to reject or invalidate.
- File fallback cannot provide multi-server guarantees; production action and target writes require transactional persistence.
