# Operations template creation audit

**Scope:** Diagnostic-only review of the Operations → Template → New Template flow.  
**Audit date:** 2026-08-26  
**Production code/data changes:** None. No templates, users, role settings, authentication data, or historical records were modified.

## Executive finding

There are two independent frontend defects:

1. The Director dashboard's **Crea template** action navigates to
   `operations-templates.html?action=create`, but the destination page never
   reads that query parameter. The page loads normally and the create panel
   remains closed.
2. The visible form's `doCreate()` handler calls `OpsCommon.api()` using an
   obsolete three-argument convention. The helper accepts `(path, options)`,
   so the string `'POST'` is treated as the options value and the collected
   form object is ignored. The browser therefore sends a **GET** to the
   templates collection, with no request body, rather than a POST.

The second defect is the first failing boundary for a visible form submission:

`UI submit → frontend API-call construction (fails) → no create route/auth/validation/persistence execution`

Because the accidental GET returns a successful list response, the page
silently closes the panel and reloads the unchanged list. It does not present
an error and it does not create a template.

## Flow map

### Entry points and page loading

| Step | Location | Observed behavior |
| --- | --- | --- |
| Director quick action | `public/operations-director.html` | Inline click handler sets `location.href` to `operations-templates.html?action=create`. |
| Direct page route | `public/operations-templates.html` | The page is statically served by Express and loads `js/ws-auth.js`, then `js/operations-common.js`, followed by its inline page script. |
| Initial page data | `load()` in `operations-templates.html` | Calls `OpsCommon.loadMe()`, then `GET /api/operations/assignees`, then `GET /api/operations/templates`. |
| Director gate | `load()` | A non-Director sees the Director-only error and the New Template button is hidden. The server remains authoritative for all mutations. |
| Quick-action query | Entire template-page script | No `URLSearchParams`, `location.search`, or `action` handling exists. `?action=create` has no UI effect. |
| Visible create action | `#new-tpl-btn` | The button calls `openCreatePanel()`, which renders the form and opens the side panel. |

### Form fields and collected payload

`tplForm()` renders:

- required title and start date;
- description;
- frequency (`DAILY`, `WEEKLY`, `MONTHLY`, `EVERY_X_DAYS`,
  `EVERY_X_WEEKS`, or `EVERY_X_MONTHS`);
- interval, days of week, and day of month where the chosen frequency needs
  them;
- default assignee, priority, department;
- optional end date and maximum occurrences;
- work-schedule days;
- optional default reminder days and default escalation.

`collectForm()` returns the following JSON-ready shape:

```json
{
  "title": "…",
  "description": "…",
  "frequency": "…",
  "interval": 1,
  "daysOfWeek": [],
  "dayOfMonth": null,
  "defaultAssigneeId": null,
  "priority": "MEDIUM",
  "department": "…",
  "startDate": "YYYY-MM-DD",
  "endDate": null,
  "maxOccurrences": null,
  "workSchedule": [0, 1, 2, 3, 4, 5, 6],
  "defaultReminderDays": null,
  "defaultEscalation": false
}
```

The Create Template button invokes `doCreate()`. On a successful create,
the intended post-save behavior is to close the panel and reload the template
list.

## Exact client request finding

`OpsCommon.api()` is defined as:

```js
api(path, opts = {})
```

It derives `method` and `body` only from `opts.method` and `opts.body`, then
passes those options to `fetch`.

The create handler currently calls:

```js
OpsCommon.api('/api/operations/templates', 'POST', collectForm())
```

In JavaScript, the third argument is not accepted by this helper. A string
spread as an options object has no `method` or `body` property, so the
effective request is:

| Initiating UI action | URL | Effective method | Request payload/body | Expected successful response to that effective request |
| --- | --- | --- | --- | --- |
| Click **Crea template** in the visible panel | `/api/operations/templates` | `GET` | none | `200 {"success":true,"templates":[…]}` |

An isolated browser execution of the exact loaded page scripts, with a
Director-shaped authenticated session and mock transport, recorded:

1. The `?action=create` load completed with the side panel closed.
2. A populated form submission issued `GET /api/operations/templates` with a
   null/absent body.
3. The success response caused `doCreate()` to close the panel.
4. `loadTemplates()` then issued a second `GET /api/operations/templates`;
   the list remained unchanged.

This harness is deliberately separate from the running Preview evidence below:
it exercises the actual client code's argument handling without authorizing
against, or writing to, the live Firestore store.

## Backend contract and security trace

The intended create route is `POST /api/operations/templates`.

1. `express.json()` parses the JSON body.
2. `requireOpsAuth()` calls `requireAuth()` and validates the HMAC-signed
   bearer session. It resolves the Operations user from server-side state,
   derives the company from that authenticated user/session, and rejects
   suspended, archived, or inactive Operations users.
3. `opsAuth.canManageUsers()` requires the `DIRECTOR` role.
4. `opsRecurring.validateTemplateInput()` checks required title/start date,
   frequency, frequency interval, dates, maximum occurrences, day values, and
   work schedule. Invalid input returns `400`.
5. If present, `defaultAssigneeId` must identify an active user in the same
   authenticated company and be assignable under the centralized hierarchy
   rule. Invalid assignees return `400`; disallowed hierarchy assignments
   return `403`.
6. `sanitizeTemplateInput()` bounds/sanitizes text and normalizes the persisted
   values. The server generates an `opstpl_…` ID, company ID, creator
   metadata, timestamps, active state, and generation counters; the client
   cannot set these authority fields.
7. The record is appended only to that company's `opsTemplatesStore` array and
   saved through `saveOpsTemplates()`. In the running Preview, Firestore is
   connected and `ops_templates` is the configured persistent store document;
   the local JSON fallback is used only when Firestore is unavailable.
8. A real successful creation returns:

```http
HTTP/1.1 201 Created
Content-Type: application/json

{"success":true,"template":{…server-generated and sanitized template…}}
```

No Firebase browser-client write or WebSocket message participates in template
creation. WebSocket activity is unrelated to the HTTP create path.

## Focused regression-suite result

The repository does not define an `npm test` script, so `npm test -- …`
correctly reports “Missing script: test”; that is not a test failure.

The suite's executable command was run directly:

```sh
node tests/operations-sprint3.test.js
```

**Result: 94 passed, 0 failed.**

The passing checks include Director create/list/detail, server-owned company
and creator fields, forged company-ID rejection/ignore behavior, validation,
company isolation, force generation and idempotency, patch/deactivation
semantics, generated-task preservation, and Director-only authorization. This
is backend evidence only; it does not validate the page's API-helper call
shape.

## Running Replit Preview evidence

The configured `Server` workflow was restarted cleanly. Startup confirmed
Firestore was connected and initialized the `ops_templates` store (currently
empty in the loaded Preview state).

### What could be reproduced

The Preview served all of these document URLs with `200 OK`:

- `/operations-director.html`
- `/operations-templates.html`
- `/operations-templates.html?action=create`

The browser capture for both Operations pages instead displayed the
account-creation/login surface. It did not contain an authenticated Director
session, so no authenticated page interaction or template POST could be
performed in this diagnostic environment. This is recorded as a Preview
authentication limitation, not a cause of the defect.

The captured console showed the expected Operations static assets loading. Its
only 404 was `/favicon.ico`; it is unrelated to the template request path. No
template API request, server exception, CSP violation, or WebSocket failure
was observed before authentication redirected the page.

Unauthenticated direct probes against the same running Preview produced:

| Request | Status | Response body |
| --- | --- | --- |
| `GET /api/operations/me` | 401 | `{"error":"Authentication required. Please log in again."}` |
| `GET /api/operations/assignees` | 401 | `{"error":"Authentication required. Please log in again."}` |
| `GET /api/operations/templates` | 401 | `{"error":"Authentication required. Please log in again."}` |
| `POST /api/operations/templates` with a valid-shaped sample body | 401 | `{"error":"Authentication required. Please log in again."}` |

The server workflow log contains normal startup/store initialization and no
template-create log, as expected: the Preview reproduction never reached the
authenticated route. A genuine successful POST would emit the server's
`[OPS] Template created` log after persistence.

## Impact assessment

- **New creation:** Broken from both entry points. The quick action fails to
  open the form. The visible New Template form opens, but submitting it only
  reads the list and silently appears to succeed.
- **Existing template data:** Existing records and generated tasks are not
  changed by the failed creation path.
- **Existing-template mutations:** The same obsolete three-argument
  `OpsCommon.api()` pattern also appears in edit, generate-now, and deactivate
  handlers on this page. Existing records remain safe from unintended writes,
  but those actions cannot perform their intended mutations: edit and
  deactivate accidentally receive successful GET responses and can silently
  appear to complete; generate-now becomes a GET to a POST-only route and
  returns an error.
- **Backend, authorization, persistence, and deployment:** No evidence points
  to a defect in these layers. The suite and source trace show the backend
  contract is functioning when it receives the intended POST.

## Root-cause classification

**Primary:** Frontend API-contract mismatch.  
**Secondary:** Frontend routing/query-parameter omission.  
**Not the root cause:** Backend, authorization, persistence, WebSocket,
Firebase client, CSP, static resource loading, or deployment environment.

## Smallest safe correction (not implemented)

Keep the server contract and `OpsCommon.api()` signature unchanged. On the
template page, change each mutating call to supply one options object:

```js
OpsCommon.api('/api/operations/templates', {
  method: 'POST',
  body: JSON.stringify(collectForm())
})
```

Apply the equivalent options-object form to the page's PATCH, DELETE, and
generate-now POST handlers so existing-template actions do not remain broken.
Then, after Director verification and the initial data load completes, consume
`action=create` and call `openCreatePanel()` when its value is `create`.

This localized correction restores the intended UI-to-API contract and quick
action without changing server authorization, persistence, existing templates,
or generated-task history. It should be implemented only after separate
approval.
