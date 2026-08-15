'use strict';
// ── Regression tests: "Richiede la tua attenzione" task-linked navigation ────
//
// Covers:
//  - URL format: attention cards use ?taskId= (not #hash)
//  - Intel alerts: items with linkedTask are click-eligible; items without are not
//  - encodeURIComponent safety for arbitrary task ID strings
//  - HTTP: cross-company task lookup returns 404 → silent fallback confirmed

const { spawn } = require('child_process');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

let _n = 0, _fail = 0;
function check(label, ok, detail) {
    _n++;
    if (ok) { console.log(`  ✅ AN-${_n}. ${label}`); }
    else    { console.error(`  ❌ FAIL AN-${_n}. ${label}`, detail !== undefined ? JSON.stringify(detail) : ''); _fail++; }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 1 — Pure unit tests (no DOM, no server)
// ─────────────────────────────────────────────────────────────────────────────

// Mirror the URL-building logic from renderAttentionCard() in operations-director.html.
// Any change to that function must be reflected here.
function renderAttentionCardUrl(taskId) {
    return 'operations-tasks.html?taskId=' + encodeURIComponent(taskId);
}

// Mirror the intel-alert click-eligibility logic from the intel attention block.
function intelAlertIsClickable(alert) {
    return Boolean(alert.linkedTask);
}
function intelAlertUrl(alert) {
    if (!alert.linkedTask) return null;
    return 'operations-tasks.html?taskId=' + encodeURIComponent(alert.linkedTask);
}

console.log('\n  — URL format: attention cards use ?taskId= —\n');

// AN-1: basic taskId produces ?taskId= URL
{
    const url = renderAttentionCardUrl('opst_123456_abc');
    check('attention card URL uses ?taskId= param', url.includes('?taskId='));
    check('attention card URL does NOT use hash', !url.includes('#'));
    check('attention card URL contains the task ID', url.includes('opst_123456_abc'));
}

// AN-2: URL starts with operations-tasks.html
{
    const url = renderAttentionCardUrl('opst_999');
    check('URL targets operations-tasks.html', url.startsWith('operations-tasks.html'));
}

// AN-3: taskId is properly encodeURIComponent-encoded (special chars safe)
{
    const url = renderAttentionCardUrl('id with spaces & symbols');
    check('special chars in taskId are encoded', !url.includes(' ') && !url.includes('&'));
    check('encoded URL still targets tasks page', url.startsWith('operations-tasks.html?taskId='));
}

// AN-4: typical real task ID format round-trips cleanly
{
    const id = 'opst_1786515669031_c53d75';
    const url = renderAttentionCardUrl(id);
    const recovered = decodeURIComponent(url.replace('operations-tasks.html?taskId=', ''));
    check('typical task ID round-trips through encodeURIComponent', recovered === id);
}

console.log('\n  — Intel alerts: click-eligibility rules —\n');

// AN-5: alert WITH linkedTask is click-eligible
{
    const alert = { title: 'Urgent', linkedTask: 'opst_abc', linkedUser: null, linkedDept: null, severity: 'HIGH' };
    check('alert with linkedTask → clickable', intelAlertIsClickable(alert) === true);
    const url = intelAlertUrl(alert);
    check('alert with linkedTask → URL contains ?taskId=', url && url.includes('?taskId='));
    check('alert with linkedTask → URL does not use hash', url && !url.includes('#'));
    check('alert with linkedTask → correct task ID in URL', url && url.includes(encodeURIComponent('opst_abc')));
}

// AN-6: alert WITHOUT linkedTask is NOT click-eligible
{
    const alert = { title: 'Generic notice', linkedTask: null, linkedUser: 'u1', severity: 'MEDIUM' };
    check('alert without linkedTask → not clickable', intelAlertIsClickable(alert) === false);
    check('alert without linkedTask → URL is null', intelAlertUrl(alert) === null);
}

// AN-7: alert with linkedTask=undefined is NOT click-eligible
{
    const alert = { title: 'No linkedTask field', severity: 'LOW' };
    check('alert with undefined linkedTask → not clickable', intelAlertIsClickable(alert) === false);
    check('alert with undefined linkedTask → URL is null', intelAlertUrl(alert) === null);
}

// AN-8: alert with linkedTask='' (empty string) is NOT click-eligible
{
    const alert = { title: 'Empty linkedTask', linkedTask: '', severity: 'HIGH' };
    check('alert with empty linkedTask → not clickable', intelAlertIsClickable(alert) === false);
}

// AN-9: alert with linkedTask AND linkedUser — still clickable on task
{
    const alert = { title: 'Overloaded', linkedTask: 'opst_xyz', linkedUser: 'u2', severity: 'HIGH' };
    check('alert with both linkedTask and linkedUser → clickable', intelAlertIsClickable(alert) === true);
    const url = intelAlertUrl(alert);
    check('URL targets the task, not the user', url && url.includes('opst_xyz'));
}

// AN-10: URL constructed for overdue attention card matches tasks page auto-open mechanism
//   The ?taskId= param consumed by operations-tasks.html must be a simple URLSearchParams key
{
    const id = 'opst_overdue_42';
    const url = renderAttentionCardUrl(id);
    const qs = new URLSearchParams(url.replace('operations-tasks.html?', ''));
    check('?taskId= is parseable by URLSearchParams', qs.get('taskId') === id);
}

// AN-11: URL constructed for escalation card is the same format as overdue card
{
    const escalationId = 'opst_esc_77';
    const url = renderAttentionCardUrl(escalationId);
    check('escalation card URL follows same pattern', url === 'operations-tasks.html?taskId=' + encodeURIComponent(escalationId));
}

// AN-12: "no urgency" generic empty-state message must NOT produce a URL
//   (Regression: plain text messages like "Nessuna urgenza operativa" are not task-linked)
{
    const noUrgencyAlert = { title: 'Nessuna urgenza operativa', linkedTask: null, severity: null };
    check('"no urgency" generic message → not clickable', intelAlertIsClickable(noUrgencyAlert) === false);
    check('"no urgency" generic message → no URL', intelAlertUrl(noUrgencyAlert) === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2 — HTTP integration: cross-company isolation → silent fallback
// ─────────────────────────────────────────────────────────────────────────────

const SECRET   = 'test-attention-nav-secret';
const PORT     = 4472;
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-attnav-'));

function sign(uid, company) {
    const payload = Buffer.from(JSON.stringify({ uid, companyName: company, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}
async function api(token, method, p, body) {
    const res = await fetch(BASE + p, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

console.log('\n  — HTTP: cross-company task lookup for silent fallback —\n');

const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
        ...process.env,
        PORT: String(PORT),
        WS_SESSION_SECRET: SECRET,
        DATA_DIR,
        FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', () => {});

async function runHttp() {
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 20000);
        server.stdout.on('data', d => {
            if (d.toString().includes('avviato')) { clearTimeout(t); resolve(); }
        });
        server.on('exit', (code) => reject(new Error(`server exited: ${code}`)));
    });

    const dirA = sign('uid-dirA', 'co-alpha');
    const dirB = sign('uid-dirB', 'co-beta');

    // Bootstrap both directors
    let r = await api(dirA, 'GET', '/api/operations/me?name=AlphaDir');
    check('AN-13. Company A director bootstrapped', r.data.success && r.data.user.role === 'DIRECTOR');
    r = await api(dirB, 'GET', '/api/operations/me?name=BetaDir');
    check('AN-14. Company B director bootstrapped', r.data.success && r.data.user.role === 'DIRECTOR');

    // Company A creates a task
    r = await api(dirA, 'POST', '/api/operations/tasks', {
        title: 'Alpha urgent task', priority: 'URGENT', dueDate: new Date(Date.now() - 3600000).toISOString(),
    });
    check('AN-15. Company A creates a task', r.data.success, r.data);
    const alphaTaskId = r.data.task && r.data.task.id;

    // Company B tries to fetch Company A's task by ID (cross-company isolation)
    // This is exactly what openDetail(?taskId=<cross-company-id>, {silent:true}) triggers.
    r = await api(dirB, 'GET', `/api/operations/tasks/${alphaTaskId}`);
    check('AN-16. Company B cannot fetch Company A task (404)', r.status === 404, r.status);
    check('AN-17. Response does not expose task data', !r.data.task, r.data);

    // Company A can still fetch its own task (confirming it exists)
    r = await api(dirA, 'GET', `/api/operations/tasks/${alphaTaskId}`);
    check('AN-18. Company A can fetch its own task (200)', r.status === 200 && r.data.success, r.status);

    // Company B tries a completely fabricated task ID
    r = await api(dirB, 'GET', '/api/operations/tasks/opst_FAKEID_doesnotexist');
    check('AN-19. Fabricated task ID returns 404', r.status === 404, r.status);

    // Unauthenticated request (the URL ?taskId= link opened without a valid session)
    r = await api('not-a-token', 'GET', `/api/operations/tasks/${alphaTaskId}`);
    check('AN-20. No-token request returns 401', r.status === 401, r.status);

    // Company A can read its task list and the task appears there (confirms visibility rules)
    r = await api(dirA, 'GET', '/api/operations/tasks');
    check('AN-21. Task appears in Company A task list', r.data.tasks && r.data.tasks.some(t => t.id === alphaTaskId));

    // Company B task list does not leak Company A tasks
    r = await api(dirB, 'GET', '/api/operations/tasks');
    check('AN-22. Company A task absent from Company B list', r.data.tasks && !r.data.tasks.some(t => t.id === alphaTaskId));
}

runHttp()
    .catch(err => {
        console.error('  ❌ HTTP test fatal:', err.message);
        _fail++;
    })
    .finally(() => {
        server.kill();
        const total = _n;
        const passed = total - _fail;
        console.log(`\n${total} total — ${passed} passed, ${_fail} failed`);
        if (_fail > 0) process.exit(1);
    });
