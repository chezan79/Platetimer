// tests/operations-invite-resend.test.js — Task 47: Operations invitations via Resend.
//
// Runs the server with RESEND_API_KEY set and RESEND_API_BASE pointed at a local
// mock of the Resend REST API, capturing every /emails request. Covers the 12
// required regression points: sender address, token in link, APP_BASE_URL usage,
// cross-tenant rejection, role validation, duplicate handling, Resend failure
// resilience (user persisted, PROVIDER_ERROR reported), single-use invite code,
// INVITED→ACTIVE transition, already-active resend rejection, missing-config
// reporting, and no change to non-invitation (Service/task) email behavior.
//
// Run: node tests/operations-invite-resend.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SECRET = 'test-secret-resend-suite';
const PORT = 5089;
const MOCK_PORT = 5088;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'opsresend-'));
const EXPECTED_FROM = 'PlateTimer Operations <operations@notifications.platetimer.com>';
const APP_BASE = 'https://ops.platetimer.example';

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({ uid, companyName, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}
function mockFb(user) {
    return 'mockfb.' + Buffer.from(JSON.stringify(user)).toString('base64');
}
async function api(token, method, p, body) {
    const res = await fetch(BASE + p, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

// ── Mock Resend API ───────────────────────────────────────────────────────────
const captured = [];        // { auth, body } for each /emails POST
let mockMode = 'ok';        // 'ok' | 'fail500'
const mockServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/emails') {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => {
            captured.push({ auth: req.headers['authorization'] || '', body: JSON.parse(raw) });
            if (mockMode === 'fail500') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'internal error' }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: 'mock-email-' + captured.length }));
            }
        });
        return;
    }
    res.writeHead(404); res.end('{}');
});

function spawnServer(extraEnv) {
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            TEST_FIREBASE_AUTH_MOCK: '1',
            SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
            APP_BASE_URL: APP_BASE,
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    const up = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
        server.stdout.on('data', d => { if (d.toString().includes('avviato')) { clearTimeout(t); resolve(); } });
    });
    return { server, up };
}

async function main() {
    await new Promise(r => mockServer.listen(MOCK_PORT, '127.0.0.1', r));
    console.log('Mock Resend up. Starting server (Resend configured)…');
    let { server, up } = spawnServer({
        RESEND_API_KEY: 'test-resend-key-not-real',
        RESEND_API_BASE: `http://127.0.0.1:${MOCK_PORT}`
    });
    await up;
    console.log('Server up. Running checks…\n');

    try {
        const dirA = sign('uid-rdirA', 'resend-co-a');
        const dirB = sign('uid-rdirB', 'resend-co-b');
        await api(dirA, 'GET', '/api/operations/me?name=Rita%20Dir');
        const meA = await api(dirA, 'GET', '/api/operations/me');
        const dirAId = meA.data.user.id;
        await api(dirB, 'GET', '/api/operations/me?name=Remo%20Dir');

        // ── R1. Invite sends via Resend with exact sender address ────────────
        let r = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Invitee Uno', email: 'invitee1@example.com', role: 'SOUS_CHEF'
        });
        check('R1. Invite created and emailResult SENT via Resend',
            r.status === 201 && r.data.emailResult === 'SENT' && r.data.emailStatus === 'SENT', r.data);
        const inviteCode1 = r.data.user && r.data.user.inviteCode;
        const userId1 = r.data.user && r.data.user.id;
        const mail1 = captured[captured.length - 1];
        check('R1b. Resend request received by provider mock', !!mail1, captured.length);
        check('R1c. Sender is exactly the verified-domain address',
            mail1 && mail1.body.from === EXPECTED_FROM, mail1 && mail1.body.from);
        check('R1d. Recipient matches invitee', mail1 && mail1.body.to[0] === 'invitee1@example.com', mail1 && mail1.body.to);
        check('R1e. API key sent as Bearer auth (not in body)',
            mail1 && mail1.auth === 'Bearer test-resend-key-not-real' && !JSON.stringify(mail1.body).includes('test-resend-key-not-real'));

        // ── R2. Activation link: token present, built from APP_BASE_URL ──────
        check('R2. Email contains the invite code (token) in the link',
            mail1 && mail1.body.html.includes(`code=${inviteCode1}`) && mail1.body.text.includes(`code=${inviteCode1}`));
        check('R2b. Activation URL built from APP_BASE_URL',
            mail1 && mail1.body.html.includes(`${APP_BASE}/operations-activate.html?code=`), APP_BASE);
        check('R2c. Response activationUrl stays a relative path (no host leak)',
            r.data.activationUrl && r.data.activationUrl.startsWith('/operations-activate.html'), r.data.activationUrl);
        check('R2d. Email content includes role and invitee name and personal-link note',
            mail1 && mail1.body.html.includes('SOUS_CHEF') && mail1.body.html.includes('Invitee Uno') && mail1.body.text.includes('personale'));

        // ── R3. Duplicate invitation rejected, no email sent ─────────────────
        const nBefore = captured.length;
        r = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Dup', email: 'invitee1@example.com', role: 'CHEF_DE_BRIGADE'
        });
        check('R3. Duplicate email rejected with 409', r.status === 409, r.status);
        check('R3b. No email sent on duplicate', captured.length === nBefore);

        // ── R4. Invalid role rejected (no role escalation via invite) ────────
        r = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Bad Role', email: 'badrole@example.com', role: 'SUPER_ADMIN'
        });
        check('R4. Invalid role rejected with 400 and no email',
            r.status === 400 && captured.length === nBefore, r.data);

        // ── R5. Cross-tenant resend rejected ─────────────────────────────────
        r = await api(dirB, 'POST', `/api/operations/users/${userId1}/resend-invite`);
        check('R5. Director of other company cannot resend (404)', r.status === 404, r.status);
        check('R5b. No email sent on cross-tenant attempt', captured.length === nBefore);

        // ── R6. Non-director invite rejected ─────────────────────────────────
        const noAuth = await fetch(`${BASE}/api/operations/users`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'X', email: 'x@example.com', role: 'SOUS_CHEF' })
        });
        check('R6. Unauthenticated invite rejected (401)', noAuth.status === 401, noAuth.status);

        // ── R7. Resend-invite goes through Resend with same token ────────────
        r = await api(dirA, 'POST', `/api/operations/users/${userId1}/resend-invite`);
        const mail2 = captured[captured.length - 1];
        check('R7. Resend-invite returns SENT and sends via Resend',
            r.status === 200 && r.data.emailResult === 'SENT' && captured.length === nBefore + 1, r.data);
        check('R7b. Resent email reuses the SAME invite code (no new token)',
            mail2 && mail2.body.html.includes(`code=${inviteCode1}`));
        check('R7c. Resent email sender unchanged', mail2 && mail2.body.from === EXPECTED_FROM);

        // ── R8. Provider failure: user persisted, PROVIDER_ERROR reported ────
        mockMode = 'fail500';
        r = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Fail Case', email: 'failcase@example.com', role: 'CHEF_DE_BRIGADE'
        });
        check('R8. User created (201) despite Resend 500',
            r.status === 201 && r.data.success && r.data.user && r.data.user.id, r.data);
        check('R8b. emailResult FAILED and emailStatus PROVIDER_ERROR',
            r.data.emailResult === 'FAILED' && r.data.emailStatus === 'PROVIDER_ERROR', r.data);
        check('R8c. Activation link still returned so Director can share manually',
            r.data.activationUrl && r.data.activationUrl.includes('code='), r.data.activationUrl);
        const invCheck = await fetch(`${BASE}/api/operations/invitations/${r.data.user.inviteCode}`).then(x => x.json());
        check('R8d. Invitation record intact after provider failure',
            invCheck.success && invCheck.invitation.email === 'failcase@example.com', invCheck);
        mockMode = 'ok';

        // ── R9. Activation: INVITED → ACTIVE, single-use token ───────────────
        const fbTok = mockFb({ localId: 'uid-invitee1', email: 'invitee1@example.com', emailVerified: false });
        r = await api(fbTok, 'POST', '/api/operations/activate', { code: inviteCode1 });
        check('R9. Activation succeeds and binds to inviting company',
            r.status === 200 && r.data.success && r.data.companyId === 'resend-co-a' && r.data.role === 'SOUS_CHEF', r.data);
        const list = await api(dirA, 'GET', '/api/operations/users');
        const activated = list.data.users.find(u => u.id === userId1);
        check('R9b. User transitioned INVITED → ACTIVE', activated && activated.status === 'ACTIVE', activated);

        // ── R10. Invite code is single-use ───────────────────────────────────
        const reuse = await api(mockFb({ localId: 'uid-thief', email: 'invitee1@example.com', emailVerified: true }),
            'POST', '/api/operations/activate', { code: inviteCode1 });
        check('R10. Used invite code cannot be reused (not 200)', reuse.status !== 200, reuse.status);
        const lookupUsed = await fetch(`${BASE}/api/operations/invitations/${inviteCode1}`);
        check('R10b. Used invite code no longer resolvable (404)', lookupUsed.status === 404, lookupUsed.status);
        const resendActive = await api(dirA, 'POST', `/api/operations/users/${userId1}/resend-invite`);
        check('R10c. Resend for already-active user rejected (400)', resendActive.status === 400, resendActive.data);

        // ── R11. Non-invitation emails do NOT go through Resend ──────────────
        // Task assignment must keep the existing transport (logging here, since no SMTP).
        const nBeforeTask = captured.length;
        r = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Task no resend', assigneeId: userId1
        });
        check('R11. Task created; notification NOT routed through Resend',
            r.status === 201 && captured.length === nBeforeTask,
            { status: r.status, captured: captured.length - nBeforeTask });
        check('R11b. Task notificationResult still uses legacy transport result',
            r.data.notificationResult === 'FAILED' || r.data.notificationResult === 'SKIPPED', r.data.notificationResult);

        // ── R12. Service unaffected: dept endpoints still respond normally ───
        const svc = await fetch(`${BASE}/api/voice-recipients`, { headers: { 'Authorization': `Bearer ${sign('uid-svc', 'resend-co-a')}` } });
        check('R12. Service endpoint unaffected (voice-recipients responds 200)', svc.status === 200, svc.status);
    } finally {
        server.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 400));
    }

    // ── R13. Missing configuration: no Resend, no SMTP → MISSING_EMAIL_CONFIG ──
    console.log('\nRestarting server WITHOUT any email provider…');
    ({ server, up } = spawnServer({ RESEND_API_KEY: '', RESEND_API_BASE: '' }));
    await up;
    try {
        const dirA = sign('uid-rdirA', 'resend-co-a');
        const nBefore = captured.length;
        const r = await api(dirA, 'POST', '/api/operations/users', {
            name: 'No Config', email: 'noconfig@example.com', role: 'CHEF_DE_BRIGADE'
        });
        check('R13. User created without email provider (201)', r.status === 201 && r.data.success, r.data);
        check('R13b. emailStatus is MISSING_EMAIL_CONFIG', r.data.emailStatus === 'MISSING_EMAIL_CONFIG', r.data.emailStatus);
        check('R13c. emailNote tells Director to share the link manually',
            typeof r.data.emailNote === 'string' && r.data.emailNote.length > 0, r.data.emailNote);
        check('R13d. No request hit the Resend mock', captured.length === nBefore);
    } finally {
        server.kill('SIGTERM');
        mockServer.close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
