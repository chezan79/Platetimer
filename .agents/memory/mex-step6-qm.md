---
name: Mex Step 6 Quick Messages
description: QM template system — stable keys, stepped compose UI, server validation, persistence.
---

## Stable template keys
`TABLE_DELAY`, `TABLE_STATUS`, `TABLE_URGENT`, `TABLE_HOLD`, `TABLE_SEND`, `CUSTOM`

## Architecture
- `public/js/mex-qm.js` — shared browser module (`window.MexQM`): `TYPES`, `TABLE_TYPES`, `isTableType`, `validateTableNum`, `renderBody`, `buttonLabel`. Loaded before inline script on both pages.
- Client renders body text from i18n template `mex.qm.{KEY}_body` with `{n}` placeholder; server receives already-rendered `body` string + optional `templateType` + `tableNumber` metadata.
- Server re-validates `tableNumber` for table-based templates (alphanumeric, 1–8 chars, integer range 1–999). Returns `MEX_INVALID_TABLE_NUMBER` on failure.
- Unknown `templateType` treated as null (body still sent as free text). Security unchanged.

**Why:** Keeps server i18n-free; QM metadata is analytics-only and never affects auth or delivery.

## i18n keys
Button labels: `mex.qm.{KEY}` (no `_label` suffix — that was a test error, now fixed).
Body templates: `mex.qm.{KEY}_body` — must contain `{n}` placeholder.
UI strings: `mex.qm.title`, `mex.qm.tableLabel`, `mex.qm.continue`, `mex.qm.back`, `mex.qm.tableError`, `mex.qm.CUSTOM`.
All three dictionaries (it/en/fr) are complete.

## Compose UI (both pages)
3-step flow: QM picker → table-number entry → recipient + send.
- `department.html`: step IDs `mex-step-qm`, `mex-step-table`, `mex-step-send`; JS state `_deptMexQmType`, `_deptMexTableNum`; fns `mexDeptShowStep/SelectQm/GoBack/UpdateTablePreview/GoToSendStep/ResetCompose`.
- `sala.html`: prefix `mex-floor-`; JS state `_floorMexQmType`, `_floorMexTableNum`; fns `mexFloor*`.
- CUSTOM skips table step; table types pre-fill body and hide textarea on send step.
- After successful send, compose resets to picker (1.5s delay to show status message).

## mex-store persistence
`createAndSend` signature extended with optional `templateType` / `tableNumber`.
`getInboxForDept` projects these fields (null for legacy messages — backward compat).
`mexSendAck` and `mexIncoming` WS payloads now include both fields.

## Test files
- `tests/mex-step6-qm.test.js` — 94 unit tests (MexQM logic + store persistence + i18n integrity)
- `tests/mex-step6-ws.test.js` — 39 WS integration tests (port 4449)
