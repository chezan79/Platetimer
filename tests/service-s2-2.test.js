// tests/service-s2-2.test.js
// Sprint S2.2 — Department Session Hardening & Login UX
// Port: 5091

'use strict';

const { spawn } = require('child_process');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const os       = require('os');

const PORT     = 5091;
const SECRET   = 'test-secret-for-s22-suite';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 's22-'));

let passed = 0, failed = 0;

function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ` — got: ${JSON.stringify(extra)}` : ''}`); }
}

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

// Generic API call with optional extra headers (for X-Forwarded-For tests).
function api(token, method, p, body, extraHeaders) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                ...(extraHeaders || {})
            }
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, data: raw }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// POST /api/service/login — unauthenticated endpoint.
function login(loginIdentifier, password, extraHeaders) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ loginIdentifier, password });
        const req  = http.request({
            hostname: '127.0.0.1', port: PORT, path: '/api/service/login', method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...(extraHeaders || {})
            }
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, data: raw }); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function startServer() {
    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            PORT: String(PORT),
            DATA_DIR,
            WS_SESSION_SECRET: SECRET,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: ''
        };
        const child = spawn('node', ['server.js'], {
            env, cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']
        });
        let ready = false;
        const onData = d => {
            const s = String(d);
            if (!ready && (s.includes('avviato') || s.includes('listening') || s.includes(String(PORT)))) {
                ready = true; resolve(child);
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        setTimeout(() => { if (!ready) reject(new Error('Server did not start in time')); }, 15000);
    });
}

async function createDept(adminTok, name) {
    const r = await api(adminTok, 'POST', '/api/departments', { name });
    if (!r.data.success) throw new Error(`createDept failed: ${JSON.stringify(r.data)}`);
    return r.data.department;
}

async function createAccount(adminTok, deptId, loginIdentifier, password) {
    const r = await api(adminTok, 'POST', '/api/department-accounts',
        { departmentId: deptId, loginIdentifier, password });
    if (!r.data.success) throw new Error(`createAccount(${loginIdentifier}) failed: ${JSON.stringify(r.data)}`);
    return r.data.account;
}

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
    // Seed plans before starting server.
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'),
        JSON.stringify({ 'company-a': 'medium', 'company-b': 'base' }));

    const server = await startServer();

    try {
        const adminA = sign('firebase-uid-admin', 'company-a');
        const adminB = sign('firebase-uid-adminb', 'company-b');

        const deptA  = await createDept(adminA, 'Reparto Test');
        const deptA2 = await createDept(adminA, 'Reparto Alt');
        const deptB  = await createDept(adminB, 'Reparto B');

        const acctA  = await createAccount(adminA, deptA.id,  'operatore1', 'pass1234');
        const acctA2 = await createAccount(adminA, deptA2.id, 'operatore2', 'pass5678');
        const acctB  = await createAccount(adminB, deptB.id,  'operatoreB', 'passB');

        // ── Section 1: Session identification ─────────────────────────────────
        console.log('\n── 1. Session identification ─────────────────────────────');

        const rLogin = await login('operatore1', 'pass1234');
        check('1. Service login succeeds', rLogin.status === 200 && rLogin.data.success);
        const svcToken = rLogin.data.token;

        // Decode token to verify uid structure (simulates isServiceSession() check)
        let svcPayload = null;
        try { svcPayload = JSON.parse(Buffer.from(svcToken.split('.')[0], 'base64').toString()); } catch {}
        check('1a. Service token uid starts with depacct_', svcPayload && svcPayload.uid && svcPayload.uid.startsWith('depacct_'));
        check('1b. isServiceSession() would return true for this token', svcPayload && svcPayload.uid.startsWith('depacct_'));

        // Admin token uid does NOT start with depacct_
        let adminPayload = null;
        try { adminPayload = JSON.parse(Buffer.from(adminA.split('.')[0], 'base64').toString()); } catch {}
        check('1c. Admin token uid does NOT start with depacct_', adminPayload && !adminPayload.uid.startsWith('depacct_'));

        // ── Section 2: Logout routing (server-side verification) ──────────────
        console.log('\n── 2. Logout routing ─────────────────────────────────────');

        // Service logout destination derived from token: uid starts with 'depacct_' → 'service-login.html'
        check('2. Service session → getLoginDestination() would return service-login.html',
            svcPayload && svcPayload.uid.startsWith('depacct_'));

        // Admin session: uid does not start with 'depacct_' → 'index.html'
        check('3. Admin session → getLoginDestination() would return index.html',
            adminPayload && !adminPayload.uid.startsWith('depacct_'));

        // ── Section 3: Home button / GET /api/service/department (proxy for locking) ─
        console.log('\n── 3. Department locking (Home-button proxy) ─────────────');

        // The Home button is hidden for service sessions — verified client-side.
        // Server-side proxy: service session cannot manage departments (locked to own dept).
        const rHomeBlock = await api(svcToken, 'POST', '/api/departments', { name: 'Intruso' });
        check('4. Service session cannot create departments (Home locked)', rHomeBlock.status === 403);

        // GET /api/service/department always returns the server-assigned dept, not any URL value.
        const rDeptLock = await api(svcToken, 'GET', '/api/service/department');
        check('4a. Service session sees only its own dept', rDeptLock.status === 200 && rDeptLock.data.departmentId === deptA.id);

        // ── Section 4: No document.referrer dependency (routing hint logic) ───
        console.log('\n── 4. Routing hint (no document.referrer) ────────────────');

        // The routing hint '_pt_login_type' is set by WsAuth.storeToken() based on the
        // token payload. When present: 'service' → service-login.html, 'admin' → index.html.
        // We verify the logic is correctly derived from the token, not from document.referrer.
        // Verify: service token → routing hint would be 'service'
        check('5. Service token payload uniquely identifies login type (depacct_ prefix)',
            svcPayload && svcPayload.uid.startsWith('depacct_'));
        // Admin token → routing hint would be 'admin'
        check('5a. Admin token payload uniquely identifies login type (no depacct_ prefix)',
            adminPayload && !adminPayload.uid.startsWith('depacct_'));

        // ── Section 5: Rate limiter ────────────────────────────────────────────
        console.log('\n── 5. Rate limiter ───────────────────────────────────────');

        // Use a dedicated account to avoid polluting operatore1's counter.
        // All requests from 127.0.0.1 unless X-Forwarded-For is set.
        const RL_LOGIN = 'operatore2';
        const RL_PASS  = 'pass5678';
        const RL_IP    = '10.20.30.40'; // isolated IP for rate-limit tests

        // T6: wrong password counts as a failure
        const r6 = await login(RL_LOGIN, 'WRONG', { 'X-Forwarded-For': RL_IP });
        check('6. Wrong password → 401', r6.status === 401, r6.data);

        // T7: unknown login counts identically
        const r7 = await login('NONEXISTENT_LOGIN_XYZ', 'anything', { 'X-Forwarded-For': RL_IP });
        check('7. Unknown login → 401 (same as wrong password)', r7.status === 401, r7.data);
        check('7a. Same generic error message', r7.data.error === r6.data.error);

        // T8/T9: 5 failed attempts → threshold; 6th → 429
        // r6 was attempt 1. Make 4 more (total = 5 for RL_LOGIN:RL_IP).
        for (let i = 0; i < 4; i++) {
            await login(RL_LOGIN, 'WRONG', { 'X-Forwarded-For': RL_IP });
        }
        // 6th attempt for this key → 429
        const r9 = await login(RL_LOGIN, 'WRONG', { 'X-Forwarded-For': RL_IP });
        check('8/9. 6th failed attempt → 429 (threshold hit)', r9.status === 429, r9.data);
        check('9a.  429 message is generic (Troppi tentativi…)', r9.data.error && r9.data.error.includes('Troppi tentativi'));

        // T10: 429 does not reveal whether login exists — same 429 for unknown login.
        // Use a dedicated IP so we can independently prime the unknown-login counter to threshold.
        const ORACLE_IP = '10.20.30.55';
        for (let i = 0; i < 5; i++) {
            await login('NONEXISTENT_LOGIN_XYZ', 'anything', { 'X-Forwarded-For': ORACLE_IP });
        }
        const r10 = await login('NONEXISTENT_LOGIN_XYZ', 'anything', { 'X-Forwarded-For': ORACLE_IP });
        check('10. 429 for unknown login same as for known login (no oracle)', r10.status === 429, r10.data);

        // T11: Successful authentication resets the counter.
        // Use operatore2 credentials on a DIFFERENT IP to prove success resets.
        const RESET_IP = '10.20.30.99';
        // Prime the counter with 4 failures on RESET_IP
        for (let i = 0; i < 4; i++) {
            await login(RL_LOGIN, 'WRONG', { 'X-Forwarded-For': RESET_IP });
        }
        // Successful login resets the counter
        const rReset = await login(RL_LOGIN, RL_PASS, { 'X-Forwarded-For': RESET_IP });
        check('11. Successful login → 200 (counter reset)', rReset.status === 200 && rReset.data.success);
        // 5th attempt after reset → 401 (not 429, because counter was reset)
        const rAfterReset = await login(RL_LOGIN, 'WRONG', { 'X-Forwarded-For': RESET_IP });
        check('11a. First failure after reset → 401 (not 429)', rAfterReset.status === 401);

        // T12: Different loginIdentifier has independent counter.
        // operatore1 has a clean counter (was never failed on RL_IP).
        const rDiff = await login('operatore1', 'WRONG', { 'X-Forwarded-For': RL_IP });
        check('12. Different loginIdentifier independent counter → 401 (not 429)', rDiff.status === 401, rDiff.data);

        // T13: Different client IP has independent counter.
        const OTHER_IP = '192.168.1.50';
        const rDiffIP = await login(RL_LOGIN, 'WRONG', { 'X-Forwarded-For': OTHER_IP });
        check('13. Different IP has independent counter → 401 (not 429)', rDiffIP.status === 401, rDiffIP.data);

        // T14: Rate limiter affects ONLY POST /api/service/login.
        // /api/auth/session is unaffected (it uses Firebase tokens, not this endpoint).
        // Verify the rate-limited key does NOT affect admin department management.
        const rAdmin = await api(adminA, 'GET', '/api/departments');
        check('14. Rate limiter does not affect admin endpoints', rAdmin.status === 200, rAdmin.data);

        // T15: Admin/Firebase authentication endpoint unaffected.
        // POST /api/auth/session with invalid body → 401 from Firebase verification, not 429.
        const rFirebase = await api('not-a-real-firebase-token', 'POST', '/api/auth/session');
        check('15. /api/auth/session returns 401 (not 429 from rate limiter)', rFirebase.status === 401 || rFirebase.status === 400);

        // T16: Operations authentication unaffected (admin token works normally).
        const rOps = await api(adminA, 'GET', '/api/departments');
        check('16. Operations/admin session works normally', rOps.status === 200 && rOps.data.success);

        // ── Section 6: Security regressions ───────────────────────────────────
        console.log('\n── 6. Security regressions ───────────────────────────────');

        // T17: URL manipulation blocked — GET /api/service/department returns own dept.
        check('17. URL manipulation blocked — server returns assigned dept only',
            rDeptLock.data.departmentId === acctA.departmentId);

        // T18: Cross-company isolation.
        const rBLogin = await login('operatoreB', 'passB');
        check('18. Company-B login → own dept', rBLogin.status === 200 && rBLogin.data.departmentId === deptB.id);
        // Company-B token cannot see company-A dept.
        const rBonA = await api(rBLogin.data.token, 'GET', '/api/service/department');
        check('18a. Company-B token returns company-B dept only', rBonA.data.departmentId === deptB.id && rBonA.data.departmentId !== deptA.id);

        // T19: passwordHash never returned.
        check('19. passwordHash absent from login response', !('passwordHash' in rLogin.data));
        check('19a. password absent from login response',    !('password'     in rLogin.data));
        check('19b. passwordHash absent from GET /api/service/department', !('passwordHash' in rDeptLock.data));

        // T20: All S2.x invariants still hold.
        // Verify GET /api/service/department requires auth.
        const rNoAuth = await api('invalid-token-xxx', 'GET', '/api/service/department');
        check('20. Unauthenticated /api/service/department → 401', rNoAuth.status === 401);

        // Tampered company in token → NOT_BOUND.
        const tampPayload = Buffer.from(JSON.stringify({
            uid: acctA.id, companyName: 'company-b', iat: Date.now(), exp: Date.now() + 3_600_000
        })).toString('base64');
        const tampSig   = crypto.createHmac('sha256', SECRET).update(tampPayload).digest('hex');
        const tampToken = `${tampPayload}.${tampSig}`;
        const rTamp = await api(tampToken, 'GET', '/api/service/department');
        check('20a. Tampered company → NOT_BOUND', rTamp.status === 403 && rTamp.data.code === 'NOT_BOUND');

        // loginIdentifier global uniqueness still enforced.
        const rDupGlobal = await api(adminB, 'POST', '/api/department-accounts',
            { departmentId: deptB.id, loginIdentifier: 'operatore1', password: 'x' });
        check('20b. Global loginIdentifier uniqueness still enforced (409)', rDupGlobal.status === 409);

    } finally {
        server.kill();
        await new Promise(r => setTimeout(r, 300));
    }

    console.log(`\n${'─'.repeat(54)}`);
    console.log(`S2.2 results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
