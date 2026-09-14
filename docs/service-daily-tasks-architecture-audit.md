# Service Daily Tasks Architecture Audit

## Scope and recommendation

Service can support a daily Operations-task view without a new identity model or access to general Operations/calendar data. The smallest safe extension is a server-computed view over the canonical Operations task store, using the same authenticated, active, department-bound Service principal and safe projection already used by `GET /api/service/ops-tasks`.

The recommended endpoint is:

`GET /api/service/ops-tasks/today`

It should return only active, explicitly Service-published canonical tasks for the caller's server-resolved company and active department whose due date falls on the current Europe/Zurich business date, excluding tasks already acknowledged by that department.

This audit changes no production behavior.

## 1. Current Service architecture

### Identity and company isolation

- A Firebase user can exchange a verified Firebase ID token at `POST /api/auth/session`. The server resolves the company from Firestore and signs an HMAC session; the client does not choose the company.
- A direct Service login at `POST /api/service/login` authenticates a Department Account and issues the same kind of signed session, with `uid` set to the `depacct_…` account ID.
- Department Accounts bind exactly one identity to one company and one department. Their only statuses are `ACTIVE` and `SUSPENDED`; department type is read from the department record, not copied into the account.
- `getBoundDepartmentContext()` resolves either a direct Service account ID or a legacy Firebase UID binding, then requires the account company to match the signed session company.
- `GET /api/service/department` is the authoritative Service bootstrap endpoint. It rejects unbound sessions, suspended accounts, and missing/inactive departments, and returns only the assigned department.
- Company and department authorization values are therefore available entirely from verified server-side state. A daily-task API must not accept `companyId`, `departmentId`, assignment, role, or visibility filters from the client.

### Landing and routing

- `public/index.html` provides the normal Firebase login and a separate link to `public/service-login.html`.
- Direct Service login stores only the signed token, then redirects to `department.html`; the department ID in the URL is a routing convenience, not an authorization input.
- `public/home.html` exchanges Firebase identity with the server, routes non-Director Operations users to Operations, and uses Service identity resolution for bound department accounts.
- `public/department.html` is the department execution screen. It loads the bound department, establishes WebSocket service, and renders countdown, voice, Mex, and published Operations task cards.
- Client helpers decode token payloads only for routing. API and WebSocket authorization remains server-side.

### WebSocket and Mex

- `public/js/ws-auth.js` stores the signed token and sends it in `joinRoom`; it never sends an authoritative company value.
- On room join, the server binds a Department Account socket to its verified department. Department-targeted delivery is filtered server-side.
- The department page maintains heartbeat/reconnect behavior and multiplexes countdown, voice, Mex, and safe Operations events on the existing WebSocket.
- Mex is a separate per-company conversation store. Sender identity is server-derived, inbox reads are participant-filtered, and only participant sockets receive messages.
- A daily-task view does not require changes to Mex, countdowns, room joining, or the WebSocket protocol. Existing Operations events can continue to update a client-side task map, followed by normal HTTP reconciliation on page load/reconnect.

## 2. Canonical Operations task model

### Core task fields

Current manually-created tasks include:

- identity/tenancy: `id`, `companyId`
- content: `title`, `description`, `notes`, `priority`, legacy display `department`
- Operations assignment: `assigneeId`, `assigneeName`
- provenance: `createdBy`, `createdByName`, `createdAt`, `updatedAt`
- lifecycle: `status`, `completionPercent`, `startedAt`, `completedAt`, `dueDate`
- Service publication: `serviceDepartmentId`, `serviceDepartmentName`, `publishToService`
- collaboration/audit: `attachments`, `comments`, `history`
- recurrence: `templateId`, `occurrenceKey`
- reminders/escalation and Quick Note provenance

The canonical persisted statuses are `OPEN`, `IN_PROGRESS`, `COMPLETED`, and `CANCELLED`. `OVERDUE` is computed for Operations responses; it is not a persisted lifecycle state.

### Assignment dimensions: existing support and gaps

| Dimension | Existing support | Relevance to Service today view |
|---|---|---|
| Operations user | Canonical tasks have `assigneeId`; Operations hierarchy controls visibility and mutation. | Service has no user identity. Do not filter by `assigneeId`; exposing it would imply unsupported per-user authorization. |
| Operations role | `ops-auth.js` defines role hierarchy for Operations users. | Department Accounts have no Operations role. Do not reuse Operations role visibility for Service. |
| Legacy display department | Tasks may have a free-text `department`. | Not an authorization key; names are mutable and historical values are incomplete. |
| Service department | `serviceDepartmentId` is validated against an active department in the task's company; name is a server-derived snapshot. | This is the only supported Service assignment/visibility dimension. |
| Publication consent | `publishToService` must be explicitly true. | Required. A department match alone must never publish a task. |

### Recurring/generated tasks

- Recurring templates generate canonical task records with deterministic `occurrenceKey` values.
- Generated tasks copy Service department and publication fields from the template.
- Generated due dates are currently date-only `YYYY-MM-DD`; manually created and older tasks may contain ISO instants.
- Once generated, the task record—not the template or a planned calendar occurrence—is the Service authorization and display source.
- Planned but not-yet-generated recurring occurrences must not appear in the Service today endpoint. They are projections, not actionable canonical tasks.

### Operations API and authorization boundary

Operations task list/detail/create/update/start/progress/complete/reassign/cancel/comment/attachment/delete routes require an Operations user resolved from the verified session. Visibility uses `canViewTask`; mutations have action-specific hierarchy checks.

A Department Account is not an Operations user and cannot mutate tasks through these routes. The proposed daily view must remain read-only and must not expose comments, notes, attachments, history, internal IDs, reminder/escalation fields, or mutation URLs.

## 3. Reusable Service Operations projection

### Existing HTTP projection

`GET /api/service/ops-tasks` already implements the required baseline:

1. Verify signed session.
2. Resolve a bound Department Account.
3. Require the account to be active.
4. Resolve company and department from that account.
5. Re-check that the assigned department still exists and is active.
6. Read canonical tasks only from that company.
7. Require `publishToService === true`.
8. Require exact `serviceDepartmentId` match.
9. Require `OPEN` or `IN_PROGRESS`.
10. Exclude acknowledgements for the same company/task/department.
11. Return a safe projection.

The projection contains `id`, title/description, due date, priority, persisted status, assignee display name, Service department ID/name, source, and timestamps. It omits company, Operations user IDs, creator data, notes, comments, history, and attachments.

### Acknowledgement semantics

- `POST /api/service/ops-tasks/:taskId/acknowledge` repeats the same session, account, department-activity, publication, department-match, and active-status checks.
- Acknowledgement is idempotent and stored separately as `(companyId, taskId, serviceDepartmentId, acknowledgedAt)`.
- It does not complete, cancel, update, or otherwise mutate the canonical Operations task.
- It persists across refresh/restart, survives unpublish/republish, and still applies if a task moves away and later returns to the same department.
- Different departments acknowledge independently.

For the today view, acknowledgement should retain this exact meaning: “hide this published task from this department's Service queue,” not “the Operations task is complete.”

### Realtime and reconciliation

- Bound Service sockets receive only safe projected task create/update/reassign/progress events while the task remains published, active, and assigned to their department.
- Loss of entitlement is signaled explicitly by `OPS_TASK_SERVICE_REMOVED`; clients do not infer removal from a payload.
- The department page performs an initial HTTP fetch and replaces its local map, which provides reconciliation after missed best-effort WebSocket events.

The daily endpoint can use the same projected payload. A future UI may either refetch `/today` when task events arrive or apply the same business-date predicate client-side and periodically/reconnect-time reconcile. Server output remains authoritative.

## 4. “Visible to me today” semantics

### Authorization predicate

A task is visible if and only if all conditions hold:

1. The request has a valid, unexpired signed session.
2. The session resolves to a Department Account in the same verified company.
3. The account status is `ACTIVE`.
4. The bound department exists in that company and is active at request time.
5. The task belongs to that company.
6. `task.publishToService === true`.
7. `task.serviceDepartmentId === boundAccount.departmentId`.
8. `task.status` is `OPEN` or `IN_PROGRESS`.
9. The task has not been acknowledged by that company/department.
10. The canonical task due date belongs to today's Europe/Zurich business date.

There is no user-, role-, free-text department-, calendar visibility-, or client-filter-based entitlement.

### Business date

Use `Europe/Zurich`, consistent with the application's calendar business timezone.

At request time:

- Compute `businessDate` as `YYYY-MM-DD` in Europe/Zurich.
- Compute the exact UTC instants for Zurich local midnight at the start of that date and local midnight at the start of the next date. Use a half-open interval `[start, nextStart)` so DST-short and DST-long days are correct.
- If `dueDate` is a strict date-only `YYYY-MM-DD`, compare it directly to `businessDate`. This preserves the intended local calendar date of generated recurring tasks and avoids JavaScript's UTC parsing of bare dates.
- Otherwise parse `dueDate` as an instant and include it only when it falls in the Zurich interval.
- Missing or invalid due dates are not “today” and should be excluded, not guessed.

Do not define today as “next 24 hours,” browser-local time, server-local time, or `dueDate.slice(0, 10)` for timestamp values.

### Lifecycle behavior

- `OPEN` and `IN_PROGRESS`: eligible.
- `COMPLETED` and `CANCELLED`: excluded, regardless of due date.
- Overdue tasks from prior business dates: excluded from the literal today view. They remain available through the existing all-active Service projection unless acknowledged.
- Future tasks: excluded.
- Acknowledged tasks: excluded even if still active and due today.
- Tasks with no due date: excluded.

If product requirements later want “today plus overdue,” that should be an explicit, separately named mode; it should not silently change the meaning of today.

### Why the calendar mirror is not an authorization source

Operations tasks may be mirrored into the Service calendar as derived, read-only events. The mirror:

- is written asynchronously and failures are non-fatal;
- can therefore be missing or stale relative to the canonical task;
- reduces due dates to a calendar date and supplies defaults for missing due dates;
- has calendar-specific visibility/status fields that do not define Operations publication entitlement;
- is a duplicate derived record, not the canonical lifecycle source.

The today endpoint must query canonical Operations tasks and use task publication fields directly. Calendar data may render a schedule, but it must never grant Service task visibility.

## 5. Minimal API contract

### Request

`GET /api/service/ops-tasks/today`

Headers:

`Authorization: Bearer <signed session token>`

No query parameters are needed. Unknown visibility/date/department parameters should be ignored or rejected consistently; none may influence authorization.

### Success response

```json
{
  "success": true,
  "businessDate": "2026-09-14",
  "timeZone": "Europe/Zurich",
  "tasks": [
    {
      "id": "opst_...",
      "title": "Prepare station",
      "description": "Complete before service",
      "dueDate": "2026-09-14T08:00:00.000Z",
      "priority": "HIGH",
      "status": "OPEN",
      "assigneeName": "Kitchen lead",
      "serviceDepartmentId": "dept_...",
      "serviceDepartmentName": "Kitchen",
      "source": "OPERATIONS",
      "createdAt": 1789350000000,
      "updatedAt": 1789350000000
    }
  ]
}
```

Return the existing safe task projection unchanged. The envelope adds server-authoritative date context so clients can label and diagnose the view without recomputing “today.”

### Errors

Reuse existing Service errors:

- `401`: missing, invalid, or expired session.
- `403 NOT_BOUND`: no Department Account binding.
- `403 ACCOUNT_SUSPENDED`: bound account suspended.
- `410 DEPARTMENT_INACTIVE`: assigned department missing or inactive.

Do not reveal whether another company's or another department's tasks exist.

### Compatibility alternative

`GET /api/service/ops-tasks?scope=today` could share the same implementation, but a dedicated endpoint is safer:

- existing callers keep their current all-active behavior;
- date-specific response metadata can evolve without changing the original envelope;
- accidental client query handling cannot weaken the base authorization filter;
- tests can cover the new contract independently.

## 6. Implementation path

### Phase 1: server predicate and endpoint

- Extract or reuse one Department Account authorization helper matching the existing Service task routes.
- Add a pure due-date-to-business-date predicate that handles both date-only values and instants in Europe/Zurich.
- Filter the canonical company task store with the existing publication/status/acknowledgement predicate plus the today predicate.
- Return the existing safe projection and the date/timezone envelope.
- Do not change the existing list or acknowledgement endpoint.

No data migration is required. Legacy tasks with missing/invalid due dates or missing Service publication fields safely fail closed.

### Phase 2: department UI

- Add a separate “Today” section or replace the initial all-active request only after product confirmation.
- Keep acknowledgement behavior unchanged.
- Reconcile from HTTP on initial load and reconnect. For realtime events, refetch the today endpoint when eligibility may change rather than inventing a second authorization model in the browser.
- Keep Mex, countdown, voice, and calendar rendering independent.

### Phase 3: optional hardening

- Centralize the repeated Service task authorization predicate so list, today, acknowledgement, and bound-socket filtering cannot drift.
- Add bounded cleanup of orphaned acknowledgement records only as maintenance; cleanup is not required for correctness.
- Define a future data normalization strategy for due dates, but preserve mixed historical formats until explicitly migrated.

## 7. Test boundaries

Add endpoint tests without modifying unrelated behavior:

- no token, invalid token, unbound session, suspended account, and inactive department;
- company and sibling-department isolation;
- explicit publication required;
- only `OPEN`/`IN_PROGRESS`;
- acknowledged task excluded and canonical task unchanged;
- date-only due today included;
- ISO instant just inside/outside Zurich day bounds;
- DST transition dates;
- invalid/missing due date excluded;
- prior-day overdue and next-day future tasks excluded;
- generated canonical task included, planned ungenerated occurrence excluded;
- safe projection omits internal fields;
- existing `/api/service/ops-tasks`, acknowledgement, WebSocket, Mex, and calendar behavior remains unchanged.

## 8. Principal risks and mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Mixed due-date formats | Date-only recurring tasks or timestamp tasks appear on the wrong day. | Branch explicitly between strict date-only values and instants; use Zurich bounds. |
| DST/server timezone | “Today” changes at the wrong time or spans a fixed 24 hours. | Use Europe/Zurich calendar boundaries, not process/browser local time. |
| Legacy/unbound sessions | Broad legacy users gain department task access. | Require a bound, active Department Account; do not preserve unbound fallback for this endpoint. |
| Acknowledgement confused with completion | Service action changes Operations lifecycle or tasks unexpectedly reappear. | Keep the separate per-department acknowledgement store and current persistent semantics. |
| Stale calendar mirror | Missing/stale derived events grant or deny task access. | Read only canonical Operations tasks for authorization and filtering. |
| Incomplete historical fields | Old tasks lack due date, publication, department, status, or arrays. | Fail closed: require explicit publication, exact department, active status, and valid due date; projection tolerates absent optional display fields. |
| Client-supplied filtering | A caller requests another company/department/user/role. | Accept no authorization filters; derive company and department exclusively from verified server state. |
| HTTP/WS drift | UI shows an event that no longer belongs in today's queue. | Treat HTTP as reconciliation source; keep explicit removal events and refetch after relevant realtime changes. |
| Planned recurrence treated as work | Service sees tasks that do not yet exist and cannot be acted on. | Return generated canonical tasks only. |

## Decision

Build the daily Service view as a narrow extension of the existing authenticated Service projection, not as a calendar query and not as an Operations role view. The security boundary is:

**verified session → active bound Department Account → canonical company tasks → explicit Service publication → exact active department → active lifecycle → unacknowledged → Zurich business date → safe projection.**