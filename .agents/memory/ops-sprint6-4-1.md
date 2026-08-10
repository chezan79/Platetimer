---
name: Operations Sprint 6.4.1 — Real Task Attachments
description: Firebase Storage upload/download/delete for ops task attachments; mock mode for tests; multer multipart handling.
---

## What was built
Server-side file upload proxy for ops task attachments. Browser sends `multipart/form-data` to server; server uploads to Firebase Storage via Admin SDK (or mock). Server controls `storagePath` entirely — client cannot influence it.

## Key decisions

**MOCK_FIREBASE_STORAGE=1**: Sets `storageBucket` to a local-filesystem mock (reads/writes under `{DATA_DIR}/mock-storage/`). Exposes the same interface as a real firebase-admin bucket object (`file().save()`, `file().createReadStream()`, `file().delete()`). Enables full upload/download/delete tests without credentials.

**Storage path format**: `operations/{companyId}/tasks/{taskId}/{attachmentId}-{safeFilename}`. Validated against `expectedPrefix = operations/{companyId}/tasks/{taskId}/` on download and delete to prevent cross-company/task path traversal.

**multer**: `multer.memoryStorage()` with `limits.fileSize = 10 MB`. Error handled inline:
```javascript
_multerUpload.single('file')(req, res, err => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413)...
    next();
});
```

**Download auth**: Accepts `Authorization: Bearer` header OR `?token=` query param so `<img src>` and `<a href>` tags work without custom fetch in the browser.

**Limits**: `ATT_MAX_SIZE_BYTES = 10MB`, `ATT_MAX_COUNT = 5`, `ATT_ALLOWED_TYPES = {image/jpeg, image/png, image/webp, application/pdf}`.

**Attachment field names**: `fileName` (not `filename`), `contentType` (not `mimeType`). Old stub used `filename/mimeType` — all new code uses `fileName/contentType`.

**History events**: `ATTACHMENT_ADDED`, `ATTACHMENT_DELETED` — added to `HISTORY_LABELS` in `operations-common.js`.

## Test constraints
- `activate` endpoint requires a real Firebase ID token (calls identitytoolkit.googleapis.com). Cannot create activated non-director users in HMAC-token tests. A13 (delete authorization) tested via cross-company isolation instead.
- Task creation (`POST /api/operations/tasks`) returns **201**, not 200.
- Bootstrap: first `/api/operations/me?name=...` call auto-creates DIRECTOR. Additional users via `POST /api/operations/users`.

## Test file
`tests/operations-sprint6-4-1.test.js` — 37 tests, ports 5090 (mock) + 5089 (no storage).

## Download auth — rev2 (S6.4.1 Final Validation)
`?token=` query-param support removed from both download and upload endpoints.
Frontend replaced `_attDownloadUrl()` with:
- `_fetchBlobUrl(taskId, attId)` — fetch with Authorization header → Blob URL
- `_downloadAttachment(taskId, attId, fileName)` — fetch → Blob → programmatic click
- `_loadDetailImages()` — async batch-loads all `img.att-img-placeholder[data-src]` after render
- Images in `_renderAttachment` use `data-src` + `class="att-img-placeholder"`; `setTimeout(_loadDetailImages, 50)` called after `openPanel()` in `openDetail`.

A21 added to tests: `?token=` query param alone (no Authorization header) → 401.

## Pre-existing time-flaky tests
S62-43 and S63-53 check `/1/.test(briefingText)` — passes/fails depending on whether
the current-time string embedded in the briefing contains the digit "1". Not related to
attachments. These are known fragile tests in Sprint 6.2 and 6.3.

## Real Firebase Storage — bucket name
`FIREBASE_ADMIN_SERVICE_ACCOUNT` is set and initialises correctly (project: `app-dati-tavoli`).
`GOOGLE_APPLICATION_CREDENTIALS_JSON` belongs to `feisty-coder-461119-r0` (Speech API only — never mix).

**CORRECT bucket name: `app-dati-tavoli.firebasestorage.app`**
`app-dati-tavoli.appspot.com` does NOT exist — Firebase uses the new `.firebasestorage.app` format for this project.
The default in server.js (`${FIREBASE_PROJECT_ID}.appspot.com`) is therefore wrong and must be changed.
Set `FIREBASE_STORAGE_BUCKET=app-dati-tavoli.firebasestorage.app` in Secrets, OR update the fallback default in server.js.
Full cycle confirmed: upload → exists:true → delete → exists:false all PASS with the correct bucket name.

## Cumulative test count
**1,442 / 1,442 passing** (1,404 prior + 38 new; 2 pre-existing time-flaky excluded).
