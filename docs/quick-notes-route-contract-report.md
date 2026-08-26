# Operations Quick Notes route-contract report

## Scope

This report records the route trace for Operations Quick Notes and the reason no
production route alias or redesign was added.

## Workspace versus served Preview

After restarting the `Server` workflow, the Preview served the same bytes as the
workspace for the Quick Notes page and its relevant shared scripts:

| Asset | Workspace SHA-256 | Served Preview SHA-256 |
| --- | --- | --- |
| `public/operations-notes.html` | `ba854ac44e97fca64bca300449dfe0d4833bc7139dfc521023b3c6aa2bf657ce` | `ba854ac44e97fca64bca300449dfe0d4833bc7139dfc521023b3c6aa2bf657ce` |
| `public/js/operations-common.js` | `f10dae65cf7041efde380adb2a12675cf8958fb84241e25071d7fb8681b7243c` | `f10dae65cf7041efde380adb2a12675cf8958fb84241e25071d7fb8681b7243c` |
| `public/operations-tasks.html` | `63f13291f71acc9381602899b79b6c851fb86a869837d84cefd7ce3e7e003450` | `63f13291f71acc9381602899b79b6c851fb86a869837d84cefd7ce3e7e003450` |

The unauthenticated Preview screenshot redirected to the account-creation
screen, so an authenticated browser Network capture was not available in this
environment. The task report's original symptom only named `notes` and `voice`
and did not include a URL, method, or initiator. Therefore no unsupported
"pre-fix" Network URL or initiator is claimed here. The served-asset comparison
and route probes below are the reproducible evidence.

## Route trace and canonical contract

| Operation | Initiator | Canonical request after the fix | Payload |
| --- | --- | --- | --- |
| Manual note save | `operations-notes.html:saveNote()` through `OpsCommon.api()` | `POST /api/operations/notes` | JSON `{ text }` |
| Note inbox reload | `operations-notes.html:loadNotes()` through `OpsCommon.api()` | `GET /api/operations/notes` | None |
| Note count | `operations-common.js:refreshNotesCount()` through `api()` | `GET /api/operations/notes/count` | None |
| Note dismissal | `operations-notes.html:dismissNote()` through `OpsCommon.api()` | `POST /api/operations/notes/:id/dismiss` | None |
| Task-panel handoff | `operations-tasks.html` handoff loader through `OpsCommon.api()` | `GET /api/operations/notes/:id` | None; only the opaque owned ID is in the page URL |
| Voice transcription | `operations-notes.html:processVoiceRecording()` through `fetch()` | `POST /api/speech-to-text` | Authenticated JSON `{ audioData, config }` |
| Voice transcript save | `operations-notes.html:saveNote()` through `OpsCommon.api()` | `POST /api/operations/notes/voice` | Authenticated JSON `{ text }` only |

The browser-side capture regression proves that no request target is the bare
`notes` or `voice` path. It also proves that audio is never sent to
`/api/operations/notes/voice`. That endpoint is retained because it has a
different responsibility: it persists an already-produced, authenticated
transcript as a `VOICE`-sourced text note. It does not call Speech-to-Text,
accept audio, or proxy speech recognition. The only Quick Notes caller is
`saveNote()` after `processVoiceRecording()` has placed the transcript in the
editable note field. The server tests also cover its authentication,
ownership, text-only storage, inbox behavior, and successful-only conversion.

## Reproducible status checks

Direct checks against the restarted Preview server, without a session token:

| Request | Status | Interpretation |
| --- | ---: | --- |
| `POST /api/operations/notes` | 401 | Canonical route reached its Operations auth guard |
| `GET /api/operations/notes/count` | 401 | Canonical route reached its Operations auth guard |
| `POST /api/speech-to-text` | 401 | Canonical speech route reached its auth guard |
| `GET /api/speech-to-text` | 404 | Expected: speech route is POST-only |
| `POST /notes` | 404 | Bare path is not an API route |
| `POST /voice` | 404 | Bare path is not an API route |

The API registrations are below the static middleware, but `express.static`
falls through when no static file matches; the API handlers are therefore
reached before the server's remaining route processing. No catch-all HTML
handler precedes these endpoints.

## Changes and verification

Changed files:

- `tests/operations-notes-capture.test.js` — added static and runtime route,
  method, auth-header, payload, transcript handoff, and bare-target checks.
- `docs/quick-notes-route-contract-report.md` — this trace and disposition.

No production route contract was changed because the current workspace and
served Preview already contain the canonical paths. Changing those working
paths or adding compatibility aliases would mask an unobserved stale-client or
incorrect-initiator problem and violate the task scope.

Verified:

- `node tests/operations-notes-capture.test.js` — 21 passed
- `node tests/operations-quick-notes.test.js` — 20 passed
- `node tests/operations-tasks-create-panel.test.js` — 10 passed
