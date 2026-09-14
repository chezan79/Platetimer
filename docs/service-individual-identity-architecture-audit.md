# Service Individual Identity Architecture Audit

## Scope and decision

This is a read-only architecture audit for adding individual staff identification, task claiming, task start, and individual completion to the Service workspace. It verifies the current trust boundaries and persisted models, compares four identity approaches for shared restaurant devices, and recommends a phased target model. It changes no production behavior.

### Executive decision

**Service cannot identify a human safely today.**

The current Service principal is a Department Account: one shared account bound to one company and one department. It authorizes a workstation or department context. It does not identify which employee is using that workstation. No stable, authorization-safe relationship currently joins:

- a Department Account to a person;
- a Department Account to an Operations user;
- a Service session to an employee;
- an Operations task acknowledgement to an individual.

`displayName`, employee-looking labels, email text, `assigneeName`, browser state, URL parameters, and client-supplied names are display data, not identity proofs. The optional Firebase UID on a Department Account identifies the account binding used by a legacy login path; it does not establish that every action under the shared department principal was performed by one human.

The recommended target is:

> Keep the Department Account as the device/workspace authorization boundary and add a separate, company-scoped operational worker identity selected and verified inside that workspace.

Use a new stable `workerId` for individual Service attribution. A worker may optionally link to an Operations user, but that link must not be required for Service coverage and must not import Operations roles or permissions into Service. Require short-lived worker proof for task lifecycle actions while allowing existing countdown and Mex flows to continue under the department principal.

## 1. Current identity classes

| Context | Current principal | Stable server identifier | What it proves |
|---|---|---|---|
| Direct Service login | Department Account | `depacct_…` | Access to one active company department |
| Legacy Firebase Service login | Firebase UID bound to a Department Account | Firebase UID resolved to `depacct_…` | Access to the bound Department Account |
| Operations | Operations user | `opsu_…`, bound to Firebase UID after activation | One Operations member in one company with one Operations role |
| Floor WebSocket | Signed session role | signed `role: "floor"` | Floor channel authority, not a general employee identity |
| Browser routing | Token payload, URL, local/session storage hints | none authoritative | Navigation only |

The application therefore already contains individual identity in Operations, but not in Service.

## 2. Service authentication and trust boundaries

### 2.1 Firebase session exchange

The Firebase path starts with a Firebase-authenticated browser:

1. The browser obtains a Firebase ID token.
2. It sends that token to `POST /api/auth/session`.
3. The server verifies the Firebase account through Firebase's account lookup.
4. The server resolves company membership from server-accessible state. An Operations membership can supply company from the Operations store; otherwise the Service-era Firestore user record supplies it.
5. The server signs an HMAC session containing `uid`, `companyName`, issue time, and expiry.
6. Subsequent HTTP and WebSocket requests use that signed session.

The browser does not send a company directly to the exchange endpoint. However, the fallback Firestore company is not a strong administrative trust root under the current Firestore rules: an authenticated user may write their own `users/{uid}` document. A client-side `userCompany` value may affect display or legacy routing, but neither that value nor a self-managed Firestore company field is sufficient to authorize worker administration, tenant bootstrap, or individual Service actions.

Relevant code: `server.js` session signing and verification, Firebase lookup, Firestore company lookup, and `/api/auth/session`; `public/index.html`; `public/home.html`; `public/js/ws-auth.js`.

### 2.2 Direct Department Account login

The direct Service path is separate from Firebase:

1. `public/service-login.html` posts `loginIdentifier` and password to `POST /api/service/login`.
2. The server resolves the globally unique login identifier.
3. It verifies the PBKDF2 password hash.
4. It rejects a suspended account.
5. It resolves the referenced department inside the account's company and rejects a missing or inactive department.
6. It signs the same HMAC session format, with `uid` set to the Department Account's `depacct_…` ID and company from the account record.
7. The page stores only the signed token and redirects using the server-returned department ID.

The URL department ID is a routing convenience. It is not an entitlement.

### 2.3 Signed-session lifecycle and browser state

The HMAC session:

- is integrity-protected with HMAC-SHA256;
- contains a fixed expiry;
- is rejected if missing, malformed, incorrectly signed, or expired;
- is passed as a Bearer token for protected HTTP routes;
- is passed in the WebSocket `joinRoom` message;
- is stored in `sessionStorage`, not a server-side browser session or HTTP-only cookie.

`WsAuth` also stores `_pt_login_type`, and pages may decode the unsigned token payload in the browser. Both are routing aids only. Decoding proves nothing because a browser can alter its own storage and payload text. Authorization must continue to verify the signature and re-resolve live server records.

### 2.4 Department Account model and persistence

A Department Account contains:

- stable `id`;
- `companyId`;
- one `departmentId`;
- mutable `displayName`;
- globally unique `loginIdentifier`;
- password hash;
- optional `firebaseUid`;
- `ACTIVE` or `SUSPENDED` status;
- creation metadata.

It intentionally contains no person, employee, Operations role, department type, or individual membership fields. Department type comes from the referenced department. The store is company-keyed and persisted through the application's normal Firestore-or-file store mechanism.

The model enforces:

- one account per department;
- same-company, active-department binding at creation;
- globally unique login identifiers;
- globally unique Firebase UID binding;
- suspension when the referenced department is deactivated;
- prevention of department deletion while an account still references it.

This is a strong department entitlement model, but not a person model.

### 2.5 Server-side account and department resolution

`getBoundDepartmentContext()` supports both login paths:

- if signed `uid` starts with `depacct_`, it resolves by Department Account ID;
- otherwise it resolves by the account's bound Firebase UID.

It then requires the account company to match the signed session company. Service bootstrap routes additionally require:

- the account exists;
- account status is `ACTIVE`;
- the assigned department exists in that company;
- the assigned department is active.

Company, account, department, account status, and department status are authoritative server values. They must be rechecked when authorizing future claim/start/complete actions; copying them into a worker credential is not sufficient by itself.

### 2.6 HTTP authorization

Protected routes first verify the signed session. Service-specific routes then narrow authority to the bound Department Account and live department.

The current published-task read boundary is:

**valid signed session → bound active Department Account → active department → same-company canonical task → explicit Service publication → exact Service department → active lifecycle → safe projection**

No client company, department, role, employee name, or assignee filter participates in that decision.

### 2.7 WebSocket binding

Before `joinRoom`, a socket has no application identity. On join:

1. the server verifies the signed token;
2. derives company and UID from it;
3. resolves the live Department Account;
4. rejects and closes suspended account sessions;
5. binds active Department Account sockets to the account's department;
6. applies department-based delivery filters.

Client `companyName`, `from`, `pageType`, URL department, and “is Service” flags are not safe identity sources. Mex already uses stricter server-derived participants. Existing countdown and task event delivery use the bound department, not a person.

### 2.8 What one Service login means

A current Service login means:

> “This browser possesses a valid credential for this active Department Account and may act within its active department.”

It does not mean:

> “This named employee is present,” “this employee claimed the task,” or “this employee completed the task.”

The normal restaurant usage is best classified as a **shared department login**. It is not an individual login. It also is not yet a **department-authenticated device plus verified in-workspace individual**, because no worker profile or second proof exists.

### 2.9 Verified current security limitations

The future design must not assume that every current server-resolved value already has the required administrative provenance.

- `firestore-rules.txt` permits an authenticated user to write their own user document. The Firebase fallback company in `/api/auth/session` is therefore server-fetched but user-influenceable. It is adequate to describe current behavior, not a safe root for provisioning workers or bootstrapping new tenant-wide authority.
- The first Operations Director bootstrap inherits the signed session company. If that company came from the self-writable fallback profile, tenant bootstrap depends on that weaker trust source.
- Department Account create, update, status, and bind routes currently require a valid signed session, but are not consistently restricted to a Director or other explicit administrator. Binding uses the verified session UID but knowledge of the login identifier rather than the Department Account password. These transitional routes must not be reused as the worker-administration authorization pattern.
- One Firebase UID can participate in separate Operations and Department Account lookup paths. That does not create a canonical Operations-user-to-Department-Account person link.
- `GET /api/sala/token` can mint a signed Floor-role token for a generally authenticated session. The current Floor principal is therefore a channel role, not evidence of an employee or a model to reuse for worker verification.
- WebSocket account and department state are checked incompletely over a connection's lifetime. A suspended account is rejected when joining, but an already-connected socket is not necessarily closed immediately after later suspension. Task projection rechecks department activity, but not every delivery path rechecks current Department Account status.

These are current-state findings, not production changes in this audit. Before individual writes are enabled, worker administration must use a stronger tenant administrator source, Department Account administration must have an explicit management guard, and write authorization must recheck live state independently of WebSocket connection state.

## 3. Operations individual identity and attribution

### 3.1 Canonical Operations user

Operations users are separate company-keyed records with:

- stable internal `opsu_…` ID;
- `companyId`;
- optional/activated Firebase `uid`;
- name and normalized email;
- one Operations role;
- active/lifecycle state;
- invitation and activation metadata.

The internal `opsu_…` ID is the canonical Operations identity used in tasks and audit records. Firebase UID is the authentication binding. Names and email are mutable attributes and snapshots, not canonical actor identifiers.

### 3.2 Creation and activation

The first eligible authenticated user in a company can be bootstrapped as Director. Later users are Director-created invitations:

- the server derives the company and inviter from the authenticated Director;
- the invited record starts with no Firebase UID and `INVITED` status;
- a random, single-use invite code is issued;
- activation verifies the Firebase account and email match;
- successful activation binds Firebase UID, changes status to `ACTIVE`, removes the invite code, and records activation time;
- duplicate UID binding is rejected except for safe idempotent retry.

An email match is a secondary activation check. Email text alone is not used as an identity join elsewhere and cannot safely link a Service actor to an Operations user.

### 3.3 Roles, scope, and membership

Operations users belong to one company. Current Operations records do not establish a canonical Service-department membership for the person. A task can have a Service publication department, but that is a task visibility target, not the Operations user's employment assignment.

Roles are:

- `DIRECTOR`;
- `CHEF_CUISINE`;
- `ADJOINT`;
- `SOUS_CHEF`;
- `CHEF_DE_BRIGADE`.

The centralized hierarchy controls assignment, visibility, editing, completion, user management, and related actions. These are Operations permissions only. A future Service worker must not inherit them merely because it links to an Operations user.

### 3.4 Lifecycle and revocation

Operations authentication resolves the user by verified Firebase UID and rechecks current state. Suspended, archived, or inactive users cannot authenticate. Dependency checks block deletion for non-archived users, but the current route can permanently delete an already archived user even when historical dependencies remain. Task/history IDs and name snapshots remain, but their canonical Operations user record may then be unresolvable. A future worker model should preserve historical resolvability more strictly.

This provides an important precedent: disable authentication and new actions without rewriting historical actor IDs.

### 3.5 Task assignment and server-authored attribution

Canonical Operations tasks use:

- `assigneeId` and `createdBy` as stable Operations user joins;
- `assigneeName` and `createdByName` as display snapshots;
- history entries with stable `actorId` plus `actorName` snapshot;
- comments with server-derived author identity.

Creation, assignment, reassignment, progress, completion, cancellation, and comments derive the actor from the authenticated Operations context. Client-supplied actor IDs or names are not trusted. Completion is currently authorized to the Operations assignee.

Historical IDs remain meaningful when a user's name changes or the user becomes inactive. That pattern should be reused for Service worker attribution.

## 4. Existing relationships and task seams

### 4.1 Relationship inventory

| Relationship | Exists? | Safe for authorization? |
|---|---:|---:|
| Department Account → company | Yes, canonical | Yes |
| Department Account → department | Yes, canonical | Yes |
| Department Account → Firebase UID | Optional, one-to-one binding | Yes for account login binding; no for action-level human attribution on a shared login |
| Operations user → company | Yes, canonical | Yes |
| Operations user → Firebase UID | Yes after activation | Yes for Operations authentication |
| Operations user → Service department membership | No canonical relationship | No |
| Department Account → Operations user | No | No |
| Department Account → employee/person | No | No |
| Service session → current human | No | No |
| Display name/email match across models | Text may coincide | No |

### 4.2 Explicit conclusion

There is **no stable, authorization-safe Service-account-to-person or Service-account-to-Operations-user relationship**.

Do not infer one from:

- equal names;
- equal email strings;
- Department Account `displayName`;
- task `assigneeName`;
- Firestore profile display fields;
- the person currently standing near the shared tablet;
- a client-submitted profile ID without fresh proof;
- an optional Department Account Firebase binding.

### 4.3 Published task visibility

Service sees a safe projection of canonical Operations tasks only when:

- the Department Account and department are live;
- the task belongs to the same company;
- publication is explicit;
- `serviceDepartmentId` exactly matches the bound department;
- status is `OPEN` or `IN_PROGRESS`;
- the department has not acknowledged it;
- the today endpoint additionally matches the server-computed Zurich business date.

The Service projection deliberately omits Operations actor IDs and internal history. This prevents the display payload from becoming an accidental authorization source.

### 4.4 Acknowledgement

Current acknowledgement:

- is performed by the department principal;
- is independently stored by company, task, and Service department;
- is idempotent;
- hides the published item from that department;
- does not mutate the canonical Operations task;
- does not prove which employee saw or handled the task.

Acknowledgement must not be silently reinterpreted as claim or completion. Existing acknowledgements lack a person proof and must remain department-level historical facts after any future migration.

### 4.5 Operations lifecycle boundary

Only Operations-authenticated users can currently mutate canonical task lifecycle. Service has no claim, start, progress, complete, or reassign authority. Adding those actions would cross two existing boundaries:

1. the safe read projection would become a write path into the canonical Operations task store;
2. a shared department principal would need a separately proven individual actor.

That crossing requires an explicit action contract and cannot be safely implemented by adding a name field to acknowledgement.

### 4.6 Realtime reconciliation

WebSocket task events are safe projections filtered to the entitled department. Entitlement loss is an explicit removal event. HTTP remains the authoritative reconciliation source on load and reconnect.

Future individual actions should follow the same pattern:

- action endpoint commits canonical state first;
- response returns the committed representation;
- realtime event announces the resulting state to entitled Service and Operations clients;
- clients reconcile from HTTP after reconnect or revision gaps;
- no client treats its optimistic state or another client's event payload as proof of authorization.

## 5. Restaurant-service usage constraints

The target must account for:

- a shared tablet or workstation used by several staff during a shift;
- wet/gloved hands and high task-switching frequency;
- urgent actions where a full Firebase sign-in is too slow;
- staff who need Service but do not need Operations;
- short handoffs between workers;
- unattended devices;
- shoulder surfing and shared PIN risk;
- staff moving between allowed departments during a shift;
- continued countdown and Mex operation even when no individual is selected.

A design that requires full logout/login for every worker switch provides strong authentication but is likely to produce credential sharing or leave the previous worker logged in. A design that offers one-tap unauthenticated profile selection is fast but provides weak, easily spoofed audit attribution.

## 6. Candidate identity models

### Option A — Individual Service accounts

Each worker receives a separate Service login account and signs the whole browser into their own account.

**Strengths**

- clear authenticated principal for every request;
- straightforward revocation and session expiry;
- good spoofing resistance when credentials are private;
- audit attribution naturally follows session identity.

**Weaknesses**

- high logout/switch friction on a shared restaurant device;
- likely credential sharing or long-lived sessions under pressure;
- large account and credential population;
- duplicates device/department entitlement across users;
- requires defining multi-department memberships;
- risks coupling countdown and Mex availability to whichever person is logged in;
- may require many Firebase accounts or a new independent credential system.

**Assessment**

Secure in a one-person-per-device setting, but a poor fit for a rapidly shared department workstation unless paired with kiosk/device session support—at which point it converges on Option B or D.

### Option B — Verified profile selection under a Department Account session

The device keeps its Department Account session. A worker selects a company-managed profile and proves possession, for example with a short PIN. The server issues a short-lived worker context scoped to the device account and department.

**Strengths**

- preserves fast shared-device use;
- clean separation between device/department authority and individual action proof;
- includes staff who do not have Operations accounts;
- low Firebase impact;
- can leave countdown/Mex flows unchanged;
- supports short expiry, lockout, handoff, and explicit worker clearing;
- good audit quality if the server verifies proof and authors attribution.

**Weaknesses**

- short PINs are vulnerable to observation and sharing;
- profile-selection UI reveals a roster unless carefully limited;
- requires a new worker store, credential lifecycle, lockout, and management UX;
- stale worker context on an unattended device must be prevented;
- one-tap selection without a secret would be identification only, not strong verification.

**Assessment**

Best fit if the profile is server-verified and the resulting worker proof is short-lived and action-scoped. Weak if selection alone is treated as authentication.

### Option C — Reuse or link Operations identities

Service actions use an Operations user identity, authenticated directly or linked to the current worker.

**Strengths**

- reuses stable `opsu_…` IDs and existing lifecycle;
- strongest cross-workspace attribution for staff already in Operations;
- minimal ambiguity in Operations display and reporting;
- Firebase authentication is already available.

**Weaknesses**

- not all Service staff necessarily have or should have Operations accounts;
- Operations roles are managerial authorization and must not leak into Service;
- full Firebase switching is too slow for a shared workstation;
- automatically linking by email/name is unsafe;
- forcing every Service worker into Operations grows privileged account population;
- a suspended Operations account may need different treatment from employment status in Service.

**Assessment**

Useful as an optional explicit link, not as the canonical Service identity or mandatory population source.

### Option D — Separate operational employee identity

Create a company-scoped worker/employee identity distinct from both Department Accounts and Operations users. It can have department memberships, Service eligibility, lifecycle state, an action-verification method, and an optional one-to-one Operations user link.

**Strengths**

- covers all Service staff without granting Operations access;
- cleanest permission separation;
- supports multiple departments and employment lifecycle;
- can use fast verification under a Department Account session;
- optional Operations link provides unified display where appropriate;
- best long-term audit semantics.

**Weaknesses**

- new canonical model and administration workflow;
- migration and duplicate-resolution work;
- credentials/PIN security must be designed;
- optional linking adds referential and lifecycle rules.

**Assessment**

Best canonical model. Combine it with Option B's shared-device verification UX. Treat Option C only as an optional link.

### Comparison matrix

| Criterion | Individual Service account | Verified profile under department session | Reuse Operations identity | Separate worker identity |
|---|---|---|---|---|
| Spoofing resistance | High with private credentials | Medium–high with PIN, lockout, short expiry | High with Firebase | Depends on verification; medium–high recommended |
| Shared-device speed | Low | High | Low with full login | High when used with profile verification |
| Logout/handoff friction | High | Low | High | Low |
| Staff coverage | High if provisioned | High | Potentially incomplete | High |
| Permission separation | Medium | High | Low unless explicitly separated | High |
| Migration effort | High | Medium | Medium | Medium–high |
| Credential growth | One account per worker | One verifier per worker | One Firebase account per worker | One lightweight verifier per worker |
| Firebase impact | Potentially high | None required | High/required | Optional |
| Revocation | Direct | Worker + device + department checks | Operations lifecycle | Independent worker lifecycle plus device checks |
| Audit quality | High | High if proof is server-verified | High | Highest flexibility |
| Countdown/Mex compatibility | Risk of coupling | Excellent | Risk of coupling | Excellent |

## 7. Recommended target architecture

### 7.1 Canonical worker record

Introduce a separate company-scoped worker record. Suggested conceptual schema:

```text
worker {
  id: "worker_…",                 // immutable canonical person identifier
  companyId: string,              // immutable tenant boundary
  displayName: string,            // mutable display attribute
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED",
  serviceEnabled: boolean,
  authorizationVersion: number,    // incremented on worker-wide revocation
  departmentMemberships: [
    { departmentId, status, authorizationVersion, validFrom?, validUntil? }
  ],
  operationsUserId: "opsu_…" | null,
  verifier: {
    type: "PIN" | future method,
    secretHash,
    version,
    failedAttempts,
    lockedUntil,
    changedAt
  },
  createdAt,
  createdBy,
  updatedAt,
  updatedBy
}
```

This is a conceptual contract, not an implementation instruction. The persisted secret must be hashed and never projected to clients. A worker is not a Department Account and is not automatically an Operations user.

### 7.2 Canonical identifier and optional Operations link

`workerId` is the canonical Service person identifier. All Service claims and lifecycle attribution use it.

An optional `operationsUserId` link:

- must be created through an explicit administrator action;
- must require same company;
- should be unique in both directions unless product requirements explicitly support multiple worker records per Operations user;
- must not be inferred from name or email;
- must not import Operations role permissions into Service;
- may be used for unified display, reporting, or narrowly defined assignment mapping.

Historical records retain `workerId` even if the optional link later changes.

### 7.3 Department memberships

A worker may act only where all of these are true:

- worker belongs to the session company;
- worker is `ACTIVE` and Service-enabled;
- Department Account is `ACTIVE`;
- device-bound department exists and is active;
- worker has an active membership in that exact department;
- any membership validity window includes the action time.

Membership should be by canonical department ID, never name. Multiple memberships are allowed if product policy permits cross-trained staff. A company-wide worker without explicit membership should fail closed.

### 7.4 Verification strength

Use two nested proofs:

1. **Department session proof** — existing signed Department Account session establishes company/device department.
2. **Worker proof** — worker selection plus server-verified PIN or equivalent establishes the individual for a short period.

Recommended worker proof properties:

- server-issued, integrity-protected token or server-side nonce;
- binds `workerId`, `companyId`, `departmentAccountId`, `departmentId`, verification method/version, issue time, and expiry;
- five-minute default maximum inactivity window, subject to product confirmation;
- absolute maximum lifetime per verification;
- invalidated on explicit handoff/logout, account suspension, department deactivation, worker suspension, membership removal, PIN reset, or verifier version change;
- never stored as a durable local preference;
- never accepted from a plain client `workerId`;
- rechecked against live server state on every write.

For stronger non-repudiation, claim may use the current worker proof while completion can require a fresh PIN if the previous proof is older than a configurable threshold. This is a product choice; the architecture must support action-level freshness.

### 7.5 Server-derived actor context

Each write endpoint should resolve:

```text
deviceContext = verified session
  → live Department Account
  → live company and department

workerContext = verified worker proof
  → live worker
  → live same-company membership in device department
```

The server then authors actor fields. Request bodies must not control company, department, account, worker name, Operations user link, role, verification strength, or verification time.

### 7.6 Authorization rules

#### Claim

Allow only when:

- task is currently entitled to the device department under the existing Service publication predicate;
- task is `OPEN` or in an explicitly claimable state;
- caller has valid device and worker contexts;
- worker is eligible for that department;
- task is unclaimed, or already claimed by the same worker for an idempotent retry.

Claiming must not grant visibility to otherwise unpublished tasks.

#### Start

Allow only when:

- caller is the current canonical claimant;
- all device/worker/department/task checks still pass;
- task is in the allowed pre-start state;
- an exact duplicate request returns the already-started result.

Whether a manager may override a claim belongs to a separate Operations permission contract, not implicit Service authority.

#### Complete

Allow only when:

- caller is the current canonical claimant;
- task is in an allowed active state;
- worker proof meets completion freshness requirements;
- live worker, membership, Department Account, department, publication, and company checks still pass;
- completion is committed atomically with attribution/history.

If publication is removed or the task moves departments before completion, fail closed. Do not allow a stale card to complete a no-longer-entitled task.

#### Reassignment and release

Service should initially support self-release only if required. Reassigning from one worker to another should require either:

- the new worker to claim after a release; or
- a separately authorized Operations action.

Do not derive reassignment permission from an Operations role linked to the worker unless an explicit cross-workspace policy is designed and tested.

### 7.7 Concurrent claim semantics

Claim must be an atomic compare-and-set against canonical task revision/state:

- first valid claim wins;
- same worker plus same idempotency key returns the same success;
- same worker retry after response loss is harmless;
- different worker receives `409 ALREADY_CLAIMED` with only the safe display information product allows;
- stale expected revision receives `409 TASK_VERSION_CONFLICT`;
- terminal, unpublished, or moved tasks return a stable non-success code without mutation.

The current persistence abstraction is not sufficient for this operation. Tasks are held in a company-wide in-memory array and persisted through a whole-store asynchronous Firestore `set()` or local JSON write. That does not provide a cross-process compare-and-set and can acknowledge success before durable persistence completes.

Before claim endpoints exist, introduce a transactional task-action repository. The production implementation should store task state/revision at a transaction-addressable granularity and commit task state, idempotency result, and history in one Firestore transaction (or an equivalent database transaction). Local-file mode may support tests and single-process development with a process mutex plus atomic file replacement, but must not be presented as multi-instance safe. If the transactional commit fails, return failure and publish no realtime event. Deployment must either use the transactional repository or enforce and document a single-writer topology; silent fallback to the current fire-and-forget store is prohibited for lifecycle writes.

### 7.8 Idempotency

Every lifecycle request should include a client-generated idempotency key. Scope it to:

`companyId + taskId + action + workerId + idempotencyKey`

Persist the resulting action outcome long enough to cover mobile/tablet retries. Reuse returns the original result. Reusing the key with a different payload must fail. Idempotency does not bypass current authorization: revocation should prevent a new action, while retrieval of an already-committed result must not create a second mutation.

### 7.9 Canonical task attribution

Recommended canonical fields:

```text
claimedByWorkerId
claimedByWorkerName
claimedAt
claimDepartmentId
claimDepartmentName
claimLeaseId
claimLeaseExpiresAt
claimLeaseStatus              // ACTIVE | RELEASED | EXPIRED | INVALIDATED | COMPLETED
claimLeaseClosedAt
claimLeaseCloseReason
claimWorkerAuthorizationVersion
claimMembershipAuthorizationVersion

startedByWorkerId
startedByWorkerName
startedAt

completedByWorkerId
completedByWorkerName
completedAt

serviceActionRevision
```

The stable IDs authorize and join. Names and department names are immutable event-time snapshots for historical readability.

Task history entries should include:

```text
type: "SERVICE_CLAIMED" | "SERVICE_STARTED" | "SERVICE_RELEASED" | "SERVICE_COMPLETED"
actorKind: "SERVICE_WORKER"
actorId: workerId
actorName: event-time snapshot
departmentAccountId
departmentId
departmentName
verificationStrength
at
fromStatus
toStatus
idempotencyKey or safe request correlation ID
```

Lease lifecycle adds server-authored history types:

- `SERVICE_CLAIM_RENEWED`, with previous and new expiry;
- `SERVICE_CLAIM_EXPIRED`, when an atomic action observes and closes an elapsed lease;
- `SERVICE_CLAIM_INVALIDATED`, with reason such as unpublish, department move, worker revocation, or terminal Operations mutation;
- `SERVICE_CLAIM_OVERRIDE_RELEASED`, with the authorized Operations actor ID/name and reason.

Expiry must be evaluated against server time inside the same transaction that renews, reclaims, starts, or completes. A background cleanup may materialize expired status for reporting, but correctness cannot depend on the scheduler running. Reconnect projections expose the current lease ID/status/expiry through a safe view so clients can reconcile deterministically.

Worker and membership revocation use version checks for immediate correctness:

1. suspending/archiving a worker increments the worker authorization version; removing/suspending a membership increments that membership version;
2. every lifecycle action compares the lease-captured versions with the live records, so an old lease is unusable immediately even before cleanup;
3. an indexed active-lease lookup by company/worker and company/worker/department identifies affected claims;
4. the revocation operation transactionally marks the identity/membership inactive and records a revocation event, then closes each indexed lease with compare-and-set, `SERVICE_CLAIM_INVALIDATED` history, reason, revision, and realtime update;
5. if lease materialization is delayed or retried, version mismatch still fails closed and the idempotent invalidation worker finishes the historical state later.

The index must be maintained atomically with claim creation/closure. A full task-store scan is not an acceptable revocation mechanism.

Do not overwrite Operations `assigneeId` with `workerId`; they belong to different identity namespaces. If product later maps a linked worker to the Operations assignee, that must be an explicit rule and separate audit event.

### 7.10 Selected task lifecycle contract

The recommended model makes Service completion an explicit, newly authorized way to complete the **canonical Operations task**, not a separate “department done” shadow state. This keeps one source of lifecycle truth. The existing Operations assignee-only rule remains unchanged for Operations endpoints; the Service endpoint has a separate authorization rule requiring publication to the exact department, current claim ownership, and verified worker context.

Recommended transition table:

| Current canonical state | Service action | Result | Required actor |
|---|---|---|---|
| `OPEN`, unclaimed, unacknowledged | claim | `OPEN`, active worker claim lease | eligible verified worker |
| `OPEN`, claimed by same worker | claim retry | unchanged, original result | same worker + idempotency |
| `OPEN`, claimed by another live worker | claim | `409 ALREADY_CLAIMED` | none |
| `OPEN`, claimed by current worker | start | `IN_PROGRESS`, claim retained | claimant |
| `IN_PROGRESS`, claimed by current worker | complete | `COMPLETED`, claim closed into history | claimant with fresh-enough proof |
| `OPEN` or `IN_PROGRESS`, unclaimed | complete | deny | none |
| `COMPLETED` or `CANCELLED` | any new Service action | deny, except exact idempotent replay | none |

Claim is a bounded lease, recommended initially at 15 minutes with an explicit renewal action while worker proof remains valid. Expiry does not erase history; it closes the old claim as expired and permits an atomic new claim. Manual self-release closes the lease. Operations may override/release under a separate explicit permission.

Acknowledgement remains separate:

- an existing acknowledgement makes an unclaimed task ineligible for Service claim and returns `409 TASK_ACKNOWLEDGED`;
- claim does not create an acknowledgement;
- an active claimed task remains visible through the future action projection even if a later acknowledgement record exists, so a hide action cannot orphan the claimant;
- acknowledgement must be disabled for actively claimed tasks unless product adds an explicit “hide without releasing” behavior;
- legacy acknowledged tasks remain hidden and are not backfilled or auto-claimed.

Operations mutation interaction:

| Operations mutation while claimed | Claim result |
|---|---|
| title, description, priority, due date, or Operations assignee changes | preserve claim; increment task revision; Service client reconciles |
| Service department changes | atomically close claim as invalidated, retain history, send removal to old department |
| unpublish from Service | atomically close claim as invalidated, retain history, send removal |
| Operations completes or cancels | terminal mutation wins; atomically close claim and retain both actor events |
| Operations explicitly overrides/releases | close claim with Operations actor attribution |

An abandoned claim is resolved by lease expiry or explicit Operations override. No mutation silently transfers the claim to another worker.

### 7.11 Operations visibility

Operations may read Service attribution for tasks visible under existing Operations rules:

- worker display snapshot;
- current claim/start/completion state;
- timestamps and department;
- whether a worker is linked to an Operations user, if useful and authorized.

Operations responses should expose canonical worker IDs only where needed for management or investigation. General dashboards can use safe display projections. Historical events remain visible after worker suspension or archival.

Service must not receive broader Operations history, comments, attachments, roles, or user directories merely to show the current worker/task state.

### 7.12 Realtime contract

Add resulting-state events, not client commands as facts:

- `OPS_TASK_SERVICE_CLAIMED`;
- `OPS_TASK_SERVICE_STARTED`;
- `OPS_TASK_SERVICE_RELEASED`;
- normal update/completion/removal events with worker-safe fields.

Events should include task ID, monotonic revision, safe worker display snapshot, state, and timestamps. Department-bound Service sockets receive only events they remain entitled to receive. Operations sockets use existing task visibility rules.

Clients:

- ignore older revisions;
- refetch after gaps, reconnect, unknown worker state, or conflict;
- clear stale action controls when entitlement is lost;
- never authorize from an event.

### 7.13 Revocation and inactive states

| Inactive entity | New actions | Existing worker proof | Existing claim/history |
|---|---|---|---|
| Worker suspended/archived | Deny | Invalidate by authorization-version mismatch | Immediately unusable; indexed active leases close as `INVALIDATED`, attribution retained |
| Membership removed/expired | Deny in that department | Invalidate for that department by membership-version mismatch | Immediately unusable in that department; indexed leases close as `INVALIDATED`, history retained |
| Department Account suspended | Deny all Service writes | Invalidate | Retain |
| Department inactive/missing | Deny | Invalidate | Retain |
| Task unpublished/moved | Deny from old department | No longer sufficient | Send removal; retain history |
| Task completed/cancelled | Deny further lifecycle actions except idempotent replay | Irrelevant to task | Retain |
| PIN reset/verifier changed | Deny old proof | Invalidate by verifier version | Retain |
| Linked Operations user suspended | Product decision | Do not automatically infer worker suspension unless policy says so | Retain both IDs/snapshots |

Revocation must be checked at write time, not only when the worker proof was issued.

### 7.14 Fail-closed behavior

Deny without mutation when:

- any token or proof is absent, invalid, expired, or mismatched;
- account, worker, department, membership, task, or publication record is missing;
- company IDs do not all match;
- client worker ID differs from verified worker proof;
- task state/revision is stale;
- worker is not the claimant for start/complete;
- realtime state and canonical HTTP state disagree;
- persistence cannot complete the task and audit event atomically.

Do not fall back from failed worker proof to department-only individual attribution. The UI may still allow existing department-level countdown and Mex actions, but must disable individual task writes.

## 8. Compatibility with existing Service features

### Countdown

Countdown authority remains the Department Account/department principal. Worker selection should not be required unless product separately decides to attribute countdown actions. No current countdown history may be backfilled to people.

### Mex

Mex participant and sender resolution remains department/Floor based. A worker display name may later be an optional, non-authoritative annotation, but must not alter participant authorization or delivery.

### Voice and calendar

They remain under their current account/department guards. A selected worker must not grant calendar access to a Standard department or broaden recipients.

### Published task acknowledgement

Keep existing acknowledgements as department-level hide/seen records. Do not migrate them into claims or completions. Under the selected contract, an acknowledged unclaimed task cannot be claimed from Service, claim never implicitly acknowledges, and an active claim cannot be hidden by a new acknowledgement.

## 9. Phased delivery roadmap

### Phase 0 — Resolve product policy

Before code:

- define who creates and manages workers;
- decide worker verification method and minimum PIN length;
- define inactivity and absolute expiry;
- decide multiple-department membership rules;
- decide whether completion requires fresh proof;
- decide override/release authority;
- decide effects of linked Operations user suspension.

### Phase 1 — Worker data model and administration

- establish a tenant-administrator guard that does not rely on the self-writable Firebase company field;
- restrict worker and Department Account management to that explicit authority;
- add company-scoped worker store and stable IDs;
- add lifecycle and department memberships;
- add hashed verifier and lockout metadata;
- add optional explicit Operations link with same-company uniqueness;
- add safe projections;
- add create/update/suspend/archive/reset-verifier administration;
- record server-authored administration audit events;
- do not expose worker secrets or raw hashes.
- introduce the transactional task-action repository and deployment precondition before any lifecycle write route is enabled.

No task behavior changes in this phase.

### Phase 2 — Shared-device worker verification

- add roster/profile selection limited to workers eligible for the bound department;
- verify PIN server-side with a memory-hard password KDF such as Argon2id or scrypt; use a server-side pepper from managed secrets in addition to per-worker salts;
- store attempt/lockout state separately from the worker profile so roster-wide denial-of-service controls can be applied by worker, device account, and network without rewriting identity records;
- make throttling shared across application instances, return generic discovery-resistant failures, cap lock duration, and audit resets/unlocks;
- issue short-lived worker proof bound to the Department Account and department;
- implement handoff, clear-worker, inactivity expiry, and verifier-version invalidation;
- show clear “department device” and “current worker” states;
- leave countdown, Mex, voice, and calendar behavior unchanged.

No canonical task mutation is required yet.

### Phase 3 — Claim and release

- add action-specific claim contract with idempotency key and expected revision;
- atomically persist claim, snapshots, and history;
- implement first-writer-wins conflicts;
- expose safe claim state in Service and Operations projections;
- send revisioned realtime events;
- reconcile over HTTP on conflict/reconnect.

### Phase 4 — Start, progress, and complete

- add explicit lifecycle transition table;
- enforce claimant and proof freshness;
- atomically write task state and Service actor history;
- preserve Operations assignment separately;
- define cancellation and Operations override interactions;
- add idempotent responses and stable errors.

### Phase 5 — Optional Operations linking

- add administrator-managed worker-to-Operations links;
- show unified attribution where authorized;
- define lifecycle interaction without permission leakage;
- add duplicate detection and unlink rules;
- do not auto-link historical records by name/email.

### Phase 6 — Migration and operational hardening

- introduce feature flags by company/department;
- enable worker identification before enabling writes;
- add audit/search tooling and conflict metrics;
- review lockout, handoff, abandoned claim, and stale-device behavior;
- roll out gradually with a documented rollback path.

## 10. Migration and backward compatibility

- Existing Department Accounts remain unchanged and continue to authenticate devices/departments.
- Existing Firebase bindings remain account bindings, not person records.
- Existing Operations users remain canonical Operations identities.
- Existing tasks without Service worker fields remain valid and unclaimed.
- Existing `assigneeId` remains an Operations user ID.
- Existing acknowledgements remain department-level and are not person-attributed.
- Existing task history is not backfilled with inferred workers.
- Existing countdown and Mex records are not attributed retroactively.
- New fields must be optional for old records and fail safely when absent.
- During rollout, read-only Service task views may remain available without worker proof; claim/start/complete require it.
- Companies that do not enable individual Service actions see no behavior change.

Avoid a migration that creates workers by deduplicating free-text names. If administrators choose to seed workers from Operations users, create explicit new worker IDs and explicit links while preserving namespace separation.

## 11. Abuse cases and mitigations

| Abuse or failure | Risk | Required mitigation |
|---|---|---|
| Worker taps another profile | False attribution | Require server-verified PIN or stronger proof |
| PIN observed/shared | Impersonation | Minimum strength, lockout/backoff, short expiry, easy reset, audit failed attempts |
| Unattended selected worker | Next employee acts as prior worker | Inactivity expiry, explicit handoff, visible current-worker banner, fresh proof for sensitive actions |
| Client submits another `workerId` | Cross-person action | Ignore body identity; derive from verified worker proof |
| Cross-company worker/profile ID | Tenant breach | Same-company checks at proof issuance and every write |
| Worker from sibling department acts | Permission breach | Require live exact department membership |
| Stale card completes moved/unpublished task | Unauthorized lifecycle mutation | Recheck canonical publication/department/status/revision atomically |
| Two workers claim together | Lost update/false owner | Transaction or compare-and-set; first writer wins; `409` conflict |
| Retry duplicates completion | Duplicate history/notifications | Persisted idempotency key and original-result replay |
| Realtime event arrives out of order | Incorrect controls/state | Monotonic revisions and HTTP reconciliation |
| Worker suspended after proof issued | Revoked user acts | Live lifecycle check and proof revocation/versioning |
| Device account suspended | Shared device continues writes | Live Department Account check on every action |
| Operations link grants role powers | Privilege escalation | Separate permission namespaces; no implicit role inheritance |
| Name/email auto-link collision | Wrong person attribution | Explicit administrator link by canonical IDs only |
| Brute-force profile PIN | Account takeover | Per-device, per-worker, and network-aware throttling; lockout and monitoring |
| Roster reveals all employees | Privacy exposure | Department-limited safe roster projection; no email/role/internal metadata |
| Partial task/history persistence | State without audit or audit without state | Atomic commit or fail without mutation |

## 12. Concrete test boundaries

### Worker model and administration

- company isolation for every create/read/update/status/link operation;
- stable IDs remain unchanged after name edits;
- exact department membership uses IDs, not names;
- inactive/missing departments rejected;
- duplicate Operations links rejected;
- cross-company Operations links rejected;
- secret hashes never appear in projections or logs;
- suspended/archived workers excluded from selectable roster;
- historical references block unsafe hard deletion.

### Verification and device binding

- missing/invalid/expired Department Account session rejected;
- suspended account and inactive department rejected;
- wrong-company and sibling-department worker rejected;
- correct PIN issues proof bound to account and department;
- wrong PIN produces generic error and increments throttling;
- lockout, reset, and verifier-version invalidation;
- proof replay on another Department Account or department rejected;
- inactivity and absolute expiry;
- explicit handoff clears local and server-recognized context;
- browser-supplied worker name/ID cannot change actor context.

### Claim conflicts and idempotency

- first concurrent claimant wins atomically;
- second worker receives stable conflict;
- same worker/same key receives original success;
- same key/different payload rejected;
- stale expected revision rejected;
- response-loss retry creates one history entry;
- missing persistence atomicity fails without partial state.
- start and complete after lease expiry are denied;
- an expired lease is closed and reclaimed atomically by one competing worker;
- renewal requires the current claimant, live worker proof, and matching lease/revision;
- renewal cannot extend beyond the configured maximum absolute claim lifetime;
- renewal-versus-reclaim race has exactly one committed winner;
- self-release closes the lease once and permits a later atomic claim;
- worker suspension and membership removal immediately fail version checks and idempotently materialize claim invalidation;
- an indexed revocation lookup cannot omit an active lease created in the same persistence system.

### Lifecycle authorization

- only current claimant can start/complete;
- worker, membership, account, and department lifecycle rechecked;
- moved, unpublished, completed, cancelled, or wrong-company task denied;
- exact allowed transition table enforced;
- completion freshness rule enforced;
- Service worker cannot use linked Operations role to override;
- authorized Operations override is separately tested if introduced.

### Attribution and history

- canonical `workerId` stored with event-time name snapshot;
- name change does not alter historical snapshot or joins;
- Operations assignee and Service worker fields remain separate;
- all actor fields are server-authored;
- worker archival retains readable history;
- no legacy acknowledgement is represented as a person claim/completion.

### Realtime and reconciliation

- only entitled department sockets receive Service worker events;
- Operations recipients still obey `canViewTask`;
- explicit removal on move/unpublish/terminal transition;
- out-of-order revision ignored;
- reconnect HTTP state replaces stale local state;
- action conflict triggers refetch;
- no event grants authorization.
- reconnect projection includes lease ID, status, expiry, claimant-safe display, and task revision;
- Operations department move or unpublish invalidates the claim and removes the old department view;
- Operations completion/cancellation closes the claim with both lifecycle events retained;
- authorized Operations override records the Operations actor and invalidation reason;
- acknowledgement during an active claim is rejected and cannot hide the claimant's task;
- Operations mutation-versus-Service renewal/complete races resolve through one canonical transaction/revision.

### Existing-feature regression boundaries

- direct Service and legacy Firebase login remain unchanged;
- Service department locking remains unchanged;
- current today/all-active task reads remain safe;
- acknowledgement remains idempotent and department-level;
- countdown create/cancel/replay remains department-scoped;
- Mex sender/participant delivery remains server-derived;
- Standard department calendar restriction remains unchanged;
- Operations task hierarchy and assignee-only completion remain unchanged until an explicit Service transition contract is enabled.

### Security and usability exercises

- shoulder-surfing and shared-PIN scenarios;
- rapid handoff during a busy service;
- device sleep/wake after proof expiry;
- offline/reconnect with an attempted lifecycle action;
- employee moves between departments mid-shift;
- abandoned claim when worker leaves;
- lockout recovery without exposing whether a profile exists;
- full task action flow with gloved/touch input and no accidental double submission.

## 13. Open product decisions

Implementation must not begin until the decisions that affect authorization are explicit:

1. What verification strength is acceptable: PIN, badge/QR, passkey, manager approval, or a combination?
2. What are worker-proof inactivity and absolute expiry values?
3. Must completion always require freshly re-entered proof, or is a sufficiently recent worker proof acceptable?
4. Can one worker belong to multiple departments, and can the worker switch without re-verification?
5. Who may create, suspend, archive, reset, and assign department memberships?
6. Which Operations roles may release or override another worker's claim?
7. Should worker or membership suspension immediately invalidate an open claim, or leave it blocked pending Operations override? The selected safety default is immediate invalidation.
8. Does linking an Operations user affect worker lifecycle, or is it display/reporting only?
9. Should the Service roster expose all department workers or require entering an identifier first?
10. Are PINs individual secrets under workplace policy, and what recovery process is acceptable during service?
11. How long must idempotency outcomes and worker audit events be retained?
12. Which companies/departments receive the feature first, and what is the rollback behavior?

## 14. Final recommendation

Adopt **a separate operational worker identity combined with verified profile selection under the existing Department Account session**.

The resulting trust chain should be:

**verified Department Account session → live company/account/department → server-verified short-lived worker proof → live worker and exact department membership → canonical task entitlement and revision → atomic lifecycle transition → server-authored worker attribution/history → revisioned realtime event → HTTP reconciliation**

Keep these namespaces and permissions separate:

- Department Account: device and department access;
- worker: individual Service attribution and Service action eligibility;
- Operations user: Operations authentication, hierarchy, and assignment;
- task Service department: publication and department visibility.

Optional worker-to-Operations linking can improve reporting, but it must be explicit, same-company, and permission-neutral. Existing display names, emails, account labels, acknowledgements, and browser state must never be promoted into identity proof.

This is the smallest architecture that preserves shared-device usability, covers workers without Operations accounts, avoids expanding Firebase and Operations privilege populations, keeps countdown and Mex behavior stable, and provides authorization-safe individual task attribution.