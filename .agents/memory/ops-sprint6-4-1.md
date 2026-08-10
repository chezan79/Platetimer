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

## Cumulative test count
**1,441 / 1,441 passing** (1,404 prior + 37 new).
