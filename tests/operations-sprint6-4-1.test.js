// tests/operations-sprint6-4-1.test.js
// Sprint S6.4.1 — Real Task Attachments with Firebase Storage (mock mode)
// Port: 5090  (mock-storage server)  — runs first
// Port: 5089  (no-storage server)    — "upload fails, task remains" section

'use strict';

const { spawn } = require('child_process');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const os        = require('os');

const PORT_MOCK = 5090;  // MOCK_FIREBASE_STORAGE=1
const PORT_NONE = 5089;  // no storage

const SECRET   = 'test-secret-s641';
let passed = 0, failed = 0;

function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ` — got: ${JSON.stringify(extra)}` : ''}`); }
}

function sign(uid, company) {
    const payload = Buffer.from(JSON.stringify({ uid, companyName: company, iat: Date.now(), exp: Date.now() + 3_600_000 })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

// JSON API call
function api(port, token, method, p, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port, path: p, method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
            }
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw), headers: res.headers }); } catch { resolve({ status: res.statusCode, data: raw, headers: res.headers }); } });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// Multipart file upload — sends a Buffer as multipart/form-data field 'file'
function uploadFile(port, token, taskId, { buffer, filename, mimetype }) {
    return new Promise((resolve, reject) => {
        const boundary = '----TestBoundary' + crypto.randomBytes(8).toString('hex');
        const disposition = `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`;
        const contentType = `Content-Type: ${mimetype}\r\n`;
        const preamble = Buffer.from(`--${boundary}\r\n${disposition}${contentType}\r\n`);
        const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([preamble, buffer, epilogue]);

        const req = http.request({
            hostname: '127.0.0.1', port,
            path: `/api/operations/tasks/${taskId}/attachments`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, data: raw }); } });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Download an attachment — returns { status, buffer, headers }
function downloadFile(port, token, taskId, attId) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port,
            path: `/api/operations/tasks/${taskId}/attachments/${attId}/download?token=${encodeURIComponent(token)}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
    });
}

function startServer(port, extraEnv) {
    return new Promise((resolve, reject) => {
        const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `s641-${port}-`));
        // Seed plans
        fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({ 'company-a': 'premium', 'company-b': 'base' }));
        const env = {
            ...process.env,
            PORT: String(port),
            DATA_DIR,
            WS_SESSION_SECRET: SECRET,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            ...extraEnv
        };
        const child = spawn('node', ['server.js'], {
            env, cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']
        });
        child._dataDir = DATA_DIR;
        let ready = false;
        const onData = d => {
            if (!ready && String(d).match(/avviato|listening|:\d{4}/)) { ready = true; resolve(child); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        setTimeout(() => { if (!ready) reject(new Error(`Server ${port} did not start`)); }, 15000);
    });
}

// First call to /api/operations/me auto-creates a DIRECTOR for the company.
async function setupDirector(port, company, uid, name) {
    const tok = sign(uid || ('uid-dir-' + company), company);
    const r = await api(port, tok, 'GET', `/api/operations/me?name=${encodeURIComponent(name || 'Dir Test')}`);
    if (!r.data.success) throw new Error('setupDirector failed: ' + JSON.stringify(r.data));
    return { token: tok, userId: r.data.user.id };
}

// Note: activating an invited user requires a real Firebase ID token (not HMAC).
// Non-director user auth is therefore not testable in the unit-test environment.
// A13 (delete authorization) is tested via cross-company isolation instead.

async function createTask(port, dirToken) {
    const me = await api(port, dirToken, 'GET', '/api/operations/me');
    const myId = me.data.user.id;
    const r = await api(port, dirToken, 'POST', '/api/operations/tasks', {
        title: 'Test Task', assigneeId: myId, priority: 'MEDIUM'
    });
    if (!r.data.success) throw new Error('createTask failed: ' + JSON.stringify(r.data));
    return r.data.task;
}

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
    // ── Section A: Mock Storage server — all upload/download/delete tests ──────
    console.log('\n── A. Mock Storage (MOCK_FIREBASE_STORAGE=1) ─────────────────');
    const serverM = await startServer(PORT_MOCK, { MOCK_FIREBASE_STORAGE: '1' });

    try {
        const { token: dirTok } = await setupDirector(PORT_MOCK, 'company-a', 'uid-dir-a', 'Dir Test');
        const { token: dirB   } = await setupDirector(PORT_MOCK, 'company-b', 'uid-dir-b', 'Dir B');

        const task = await createTask(PORT_MOCK, dirTok);
        const taskId = task.id;

        // ── A1: JPEG upload ─
        const jpegBuf = Buffer.alloc(256, 0xFF); // fake JPEG payload
        const rJpeg = await uploadFile(PORT_MOCK, dirTok, taskId, { buffer: jpegBuf, filename: 'photo.jpg', mimetype: 'image/jpeg' });
        check('A1. JPEG upload → 200', rJpeg.status === 200 && rJpeg.data.success, rJpeg.data);
        check('A1a. attachment.fileName correct', rJpeg.data.attachment && rJpeg.data.attachment.fileName === 'photo.jpg');
        check('A1b. contentType correct', rJpeg.data.attachment && rJpeg.data.attachment.contentType === 'image/jpeg');
        check('A1c. size stored correctly', rJpeg.data.attachment && rJpeg.data.attachment.size === jpegBuf.length);
        const attJpeg = rJpeg.data.attachment;

        // ── A2: PNG upload ─
        const pngBuf = Buffer.alloc(128, 0x89);
        const rPng = await uploadFile(PORT_MOCK, dirTok, taskId, { buffer: pngBuf, filename: 'image.png', mimetype: 'image/png' });
        check('A2. PNG upload → 200', rPng.status === 200 && rPng.data.success, rPng.data);

        // ── A3: PDF upload ─
        const pdfBuf = Buffer.from('%PDF-1.4 test content');
        const rPdf = await uploadFile(PORT_MOCK, dirTok, taskId, { buffer: pdfBuf, filename: 'manual.pdf', mimetype: 'application/pdf' });
        check('A3. PDF upload → 200', rPdf.status === 200 && rPdf.data.success, rPdf.data);

        // ── A4: invalid MIME rejected ─
        const rBad = await uploadFile(PORT_MOCK, dirTok, taskId, { buffer: Buffer.alloc(10), filename: 'script.js', mimetype: 'text/javascript' });
        check('A4. Invalid MIME → 415', rBad.status === 415, rBad.data);

        // ── A5: oversized file rejected ─
        const bigBuf = Buffer.alloc(11 * 1024 * 1024); // 11 MB > 10 MB limit
        const rBig = await uploadFile(PORT_MOCK, dirTok, taskId, { buffer: bigBuf, filename: 'big.jpg', mimetype: 'image/jpeg' });
        check('A5. Oversized → 413', rBig.status === 413, rBig.data);

        // ── A6: >5 attachments rejected ─
        // Already have 3 (JPEG + PNG + PDF). Add 2 more to reach 5.
        const task2 = await createTask(PORT_MOCK, dirTok);
        for (let i = 0; i < 5; i++) {
            await uploadFile(PORT_MOCK, dirTok, task2.id, { buffer: Buffer.alloc(16), filename: `f${i}.jpg`, mimetype: 'image/jpeg' });
        }
        const rOver = await uploadFile(PORT_MOCK, dirTok, task2.id, { buffer: Buffer.alloc(16), filename: 'extra.jpg', mimetype: 'image/jpeg' });
        check('A6. >5 attachments → 422', rOver.status === 422, rOver.data);

        // ── A7: metadata stored correctly ─
        const rGet = await api(PORT_MOCK, dirTok, 'GET', `/api/operations/tasks/${taskId}`);
        const storedAtts = rGet.data.task.attachments || [];
        check('A7. Metadata stored (3 attachments on task)', storedAtts.length === 3, storedAtts.length);
        check('A7a. uploadedByName present', storedAtts[0] && storedAtts[0].uploadedByName === 'Dir Test');
        check('A7b. uploadedAt present',    storedAtts[0] && storedAtts[0].uploadedAt > 0);

        // ── A8: storagePath server-generated (matches expected pattern) ─
        const expectedPrefix = `operations/company-a/tasks/${taskId}/`;
        check('A8. storagePath server-generated and correctly prefixed',
            storedAtts[0] && storedAtts[0].storagePath && storedAtts[0].storagePath.startsWith(expectedPrefix),
            storedAtts[0] && storedAtts[0].storagePath);
        check('A8a. storagePath contains attachmentId prefix', storedAtts[0] && storedAtts[0].storagePath.includes(storedAtts[0].id));

        // ── A9: download authenticated ─
        const dlJpeg = await downloadFile(PORT_MOCK, dirTok, taskId, attJpeg.id);
        check('A9. Download JPEG → 200', dlJpeg.status === 200, dlJpeg.status);
        check('A9a. Content-Type correct', dlJpeg.headers['content-type'] === 'image/jpeg', dlJpeg.headers['content-type']);
        check('A9b. Body matches original', dlJpeg.buffer.equals(jpegBuf));

        // ── A10: unauthorized task access rejected ─
        // Use assignee token for cross-company test
        const taskB = await createTask(PORT_MOCK, dirB);
        const rDlB = await downloadFile(PORT_MOCK, dirTok, taskB.id, 'fake-id');
        check('A10. Cross-company download → 404 or 403',
            rDlB.status === 403 || rDlB.status === 404, rDlB.status);

        // ── A11: cross-company attachment access impossible ─
        // Upload to taskB (company-b), try to download with company-a token
        const rAttB = await uploadFile(PORT_MOCK, dirB, taskB.id, { buffer: Buffer.alloc(8), filename: 'secret.jpg', mimetype: 'image/jpeg' });
        if (rAttB.data.success) {
            const stolen = await downloadFile(PORT_MOCK, dirTok, taskB.id, rAttB.data.attachment.id);
            check('A11. Cross-company attachment download blocked (403/404)', stolen.status === 403 || stolen.status === 404, stolen.status);
        } else {
            check('A11. Cross-company attachment access impossible (upload itself blocked)', false, 'upload failed unexpectedly');
        }

        // ── A12: delete removes metadata ─
        const preDelete = (await api(PORT_MOCK, dirTok, 'GET', `/api/operations/tasks/${taskId}`)).data.task.attachments || [];
        const toDelete = preDelete[0];
        const rDel = await api(PORT_MOCK, dirTok, 'DELETE', `/api/operations/tasks/${taskId}/attachments/${toDelete.id}`);
        check('A12. Delete → 200', rDel.status === 200 && rDel.data.success, rDel.data);
        const postDelete = (await api(PORT_MOCK, dirTok, 'GET', `/api/operations/tasks/${taskId}`)).data.task.attachments || [];
        check('A12a. Attachment removed from task', postDelete.length === preDelete.length - 1, postDelete.length);
        check('A12b. Deleted attachment no longer in list', !postDelete.find(a => a.id === toDelete.id));

        // ── A13: delete authorization (cross-company isolation) ─
        // Company-B Director cannot delete an attachment from a Company-A task.
        // (requireOpsTask returns 404 for tasks outside the actor's company.)
        const remainingAtt = postDelete[0];
        if (remainingAtt) {
            const rDelCross = await api(PORT_MOCK, dirB, 'DELETE', `/api/operations/tasks/${taskId}/attachments/${remainingAtt.id}`);
            check('A13. Cross-company actor cannot delete attachment (403/404)', rDelCross.status === 403 || rDelCross.status === 404, rDelCross.data);
        } else {
            check('A13. Cross-company delete blocked (no remaining att — skip)', true);
        }

        // ── A14: delete history event recorded ─
        const rHist = await api(PORT_MOCK, dirTok, 'GET', `/api/operations/tasks/${taskId}`);
        const hist = rHist.data.task.history || [];
        check('A14. ATTACHMENT_DELETED history event recorded', hist.some(h => h.type === 'ATTACHMENT_DELETED'));
        check('A14a. ATTACHMENT_ADDED history events recorded', hist.some(h => h.type === 'ATTACHMENT_ADDED'));

        // ── A15: deleted attachment download returns 404 ─
        const rDlDeleted = await downloadFile(PORT_MOCK, dirTok, taskId, toDelete.id);
        check('A15. Download of deleted attachment → 404', rDlDeleted.status === 404, rDlDeleted.status);

        // ── A16: WEBP upload ─
        const rWebp = await uploadFile(PORT_MOCK, dirTok, taskId, { buffer: Buffer.alloc(32), filename: 'photo.webp', mimetype: 'image/webp' });
        check('A16. WEBP upload → 200', rWebp.status === 200, rWebp.data);

        // ── A17: filename sanitisation — path traversal attempt ─
        const rTraversal = await uploadFile(PORT_MOCK, dirTok, taskId, {
            buffer: Buffer.alloc(8), filename: '../../etc/passwd.jpg', mimetype: 'image/jpeg'
        });
        if (rTraversal.status === 200 && rTraversal.data.attachment) {
            const sp = rTraversal.data.attachment.storagePath;
            check('A17. Path-traversal stripped from storagePath', !sp.includes('..') && !sp.includes('etc'), sp);
        } else {
            check('A17. Path-traversal rejected (upload blocked)', rTraversal.status === 400 || rTraversal.status === 415, rTraversal.status);
        }

        // ── A18: existing task creation still works without attachments ─
        const rPlain = await api(PORT_MOCK, dirTok, 'POST', '/api/operations/tasks', {
            title: 'Plain Task', assigneeId: (await api(PORT_MOCK, dirTok, 'GET', '/api/operations/me')).data.user.id, priority: 'LOW'
        });
        check('A18. Task creation without attachments still works', (rPlain.status === 200 || rPlain.status === 201) && rPlain.data.success, rPlain.data);
        check('A18a. Task has empty attachments array', Array.isArray(rPlain.data.task.attachments) && rPlain.data.task.attachments.length === 0);

        // ── A19: upload endpoint requires auth ─
        const rNoAuth = await uploadFile(PORT_MOCK, '', taskId, { buffer: Buffer.alloc(8), filename: 'x.jpg', mimetype: 'image/jpeg' });
        check('A19. Upload without auth → 401', rNoAuth.status === 401, rNoAuth.status);

        // ── A20: download endpoint requires auth ─
        // Use raw HTTP without token
        const rDlNoAuth = await new Promise((res) => {
            const req = http.request({ hostname: '127.0.0.1', port: PORT_MOCK, path: `/api/operations/tasks/${taskId}/attachments/nonexistent/download`, method: 'GET' },
                r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode })); });
            req.on('error', () => res({ status: 0 }));
            req.end();
        });
        check('A20. Download without auth → 401', rDlNoAuth.status === 401, rDlNoAuth.status);

    } finally {
        serverM.kill();
        await new Promise(r => setTimeout(r, 400));
    }

    // ── Section B: No-storage server — "upload fails, task remains" ────────────
    console.log('\n── B. No Storage server — upload failure resilience ─────────');
    const serverN = await startServer(PORT_NONE, {}); // no MOCK_FIREBASE_STORAGE

    try {
        const { token: dirTokN } = await setupDirector(PORT_NONE, 'company-a', 'uid-dir-none', 'Dir None');
        const taskN = await createTask(PORT_NONE, dirTokN);

        // Task was created — verify it exists before any upload attempt.
        const rTask = await api(PORT_NONE, dirTokN, 'GET', `/api/operations/tasks/${taskN.id}`);
        check('B1. Task created successfully (no storage)', rTask.status === 200 && rTask.data.success, rTask.data);

        // Attempt to upload — must return 503 (storage not configured).
        const rUp = await uploadFile(PORT_NONE, dirTokN, taskN.id, { buffer: Buffer.alloc(64), filename: 'test.jpg', mimetype: 'image/jpeg' });
        check('B2. Upload attempt → 503 (storage not configured)', rUp.status === 503, rUp.data);

        // Task still exists and has 0 attachments — not rolled back.
        const rAfter = await api(PORT_NONE, dirTokN, 'GET', `/api/operations/tasks/${taskN.id}`);
        check('B3. Task remains after failed upload', rAfter.status === 200 && rAfter.data.success);
        check('B4. Task has 0 attachments (no partial state)', (rAfter.data.task.attachments || []).length === 0);

        // File type and size validation still works even without Storage.
        const rBadType = await uploadFile(PORT_NONE, dirTokN, taskN.id, { buffer: Buffer.alloc(8), filename: 'x.exe', mimetype: 'application/x-msdownload' });
        check('B5. Invalid MIME rejected even without storage (415)', rBadType.status === 415, rBadType.data);

    } finally {
        serverN.kill();
        await new Promise(r => setTimeout(r, 400));
    }

    console.log(`\n${'─'.repeat(56)}`);
    console.log(`S6.4.1 results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
