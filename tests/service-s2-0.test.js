// tests/service-s2-0.test.js
// Sprint S2.0 — Department Account Management UI
// Verifies new PATCH endpoint, password hashing, admin table API flows.
// Port: 5093

'use strict';

const { spawn } = require('child_process');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const os       = require('os');

const PORT     = 5093;
const SECRET   = 'test-secret-for-s20-suite';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 's20-'));

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

function api(token, method, p, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
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
        setTimeout(() => { if (!ready) reject(new Error('Server did not start')); }, 12000);
    });
}

function stopServer(child) {
    return new Promise(r => {
        child.kill('SIGTERM');
        child.on('exit', r);
        setTimeout(r, 1500);
    });
}

async function main() {
    // premium plan so we can create many depts (value must be a plain string, not an object)
    fs.writeFileSync(
        path.join(DATA_DIR, 'plans.json'),
        JSON.stringify({ tratt: 'premium', brasserie: 'premium' })
    );

    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running S2.0 checks…\n');

    try {
        const tok  = sign('uid-admin', 'tratt');
        const tokB = sign('uid-b',     'brasserie');  // different company

        // ── setup ─────────────────────────────────────────────────────────
        console.log('  — setup —\n');
        const rD1 = await api(tok, 'POST', '/api/departments', { name: 'Cucina S20' });
        const rD2 = await api(tok, 'POST', '/api/departments', { name: 'Bar S20'    });
        const rD3 = await api(tok, 'POST', '/api/departments', { name: 'Sala S20'   });  // no account
        check('Setup: D1 created', rD1.data.success, rD1.data.error);
        check('Setup: D2 created', rD2.data.success, rD2.data.error);
        check('Setup: D3 created (no account)', rD3.data.success, rD3.data.error);
        const d1Id = rD1.data.department?.id;
        const d2Id = rD2.data.department?.id;
        const d3Id = rD3.data.department?.id;

        // Company B dept
        const rDB = await api(tokB, 'POST', '/api/departments', { name: 'Cucina B' });
        check('Setup: Company B D1 created', rDB.data.success, rDB.data.error);
        const dBId = rDB.data.department?.id;

        // ── 1. Create Department Account ──────────────────────────────────
        console.log('\n  — 1. Create Department Account —\n');
        const r1 = await api(tok, 'POST', '/api/department-accounts', {
            departmentId: d1Id,
            loginIdentifier: 'cucina1',
            password: 'pizza'
        });
        check('S20-1.  Create returns 201',          r1.status === 201,                                r1.status);
        check('S20-1b. success true',                r1.data.success,                                 r1.data.error);
        check('S20-1c. loginIdentifier correct',     r1.data.account?.loginIdentifier === 'cucina1',  r1.data.account?.loginIdentifier);
        check('S20-1d. passwordHash NOT exposed',    !r1.data.account?.passwordHash,                  r1.data.account?.passwordHash);
        check('S20-1e. hasPassword true',            r1.data.account?.hasPassword === true,           r1.data.account?.hasPassword);
        check('S20-1f. status ACTIVE',               r1.data.account?.status === 'ACTIVE',            r1.data.account?.status);
        check('S20-1g. departmentId correct',        r1.data.account?.departmentId === d1Id,          r1.data.account?.departmentId);
        const acct1Id = r1.data.account?.id;

        // ── 2. GET /api/department-accounts ───────────────────────────────
        console.log('\n  — 2. GET /api/department-accounts —\n');
        const rGet = await api(tok, 'GET', '/api/department-accounts');
        check('S20-2.  GET returns success',         rGet.data.success,                               rGet.data.error);
        const a1InGet = (rGet.data.accounts || []).find(a => a.departmentId === d1Id);
        const a3InGet = (rGet.data.accounts || []).find(a => a.departmentId === d3Id);
        check('S20-2b. D1 account present',          !!a1InGet,                                       null);
        check('S20-2c. D3 has no account in list',   !a3InGet,                                        a3InGet);
        check('S20-2d. passwordHash absent in GET',  !a1InGet?.passwordHash,                          a1InGet?.passwordHash);
        check('S20-2e. hasPassword true in GET',     a1InGet?.hasPassword === true,                   a1InGet?.hasPassword);

        // ── 3. Edit login (PATCH) ─────────────────────────────────────────
        console.log('\n  — 3. Edit login —\n');
        const r3 = await api(tok, 'PATCH', `/api/department-accounts/${acct1Id}`, {
            loginIdentifier: 'cucina1-updated'
        });
        check('S20-3.  PATCH login success',         r3.data.success,                                 r3.data.error);
        check('S20-3b. loginIdentifier updated',     r3.data.account?.loginIdentifier === 'cucina1-updated', r3.data.account?.loginIdentifier);
        check('S20-3c. passwordHash not leaked',     !r3.data.account?.passwordHash,                  r3.data.account?.passwordHash);

        // Persist check via GET
        const rGet3 = await api(tok, 'GET', '/api/department-accounts');
        const a1v2  = (rGet3.data.accounts || []).find(a => a.id === acct1Id);
        check('S20-3d. Updated login persisted',     a1v2?.loginIdentifier === 'cucina1-updated',     a1v2?.loginIdentifier);

        // ── 4. Edit password (PATCH) ──────────────────────────────────────
        console.log('\n  — 4. Edit password —\n');
        const r4 = await api(tok, 'PATCH', `/api/department-accounts/${acct1Id}`, {
            password: 'kitchen'
        });
        check('S20-4.  PATCH password success',      r4.data.success,                                 r4.data.error);
        check('S20-4b. passwordHash not exposed',    !r4.data.account?.passwordHash,                  r4.data.account?.passwordHash);
        check('S20-4c. hasPassword still true',      r4.data.account?.hasPassword === true,           r4.data.account?.hasPassword);
        // Login unchanged when only password was patched
        check('S20-4d. loginIdentifier unchanged',   r4.data.account?.loginIdentifier === 'cucina1-updated', r4.data.account?.loginIdentifier);

        // ── 5. Suspend ────────────────────────────────────────────────────
        console.log('\n  — 5. Suspend —\n');
        const r5 = await api(tok, 'PUT', `/api/department-accounts/${acct1Id}/status`, { status: 'SUSPENDED' });
        check('S20-5.  Suspend success',             r5.data.success,                                 r5.data.error);
        check('S20-5b. Status is SUSPENDED',         r5.data.account?.status === 'SUSPENDED',         r5.data.account?.status);

        // ── 6. Reactivate ─────────────────────────────────────────────────
        console.log('\n  — 6. Reactivate —\n');
        const r6 = await api(tok, 'PUT', `/api/department-accounts/${acct1Id}/status`, { status: 'ACTIVE' });
        check('S20-6.  Reactivate success',          r6.data.success,                                 r6.data.error);
        check('S20-6b. Status is ACTIVE',            r6.data.account?.status === 'ACTIVE',            r6.data.account?.status);

        // ── 7. Duplicate login rejected ───────────────────────────────────
        console.log('\n  — 7. Duplicate login —\n');
        // Create D2 account first (unique login)
        const r7setup = await api(tok, 'POST', '/api/department-accounts', {
            departmentId: d2Id, loginIdentifier: 'bar1', password: 'service'
        });
        check('S20-7.  D2 account created',          r7setup.data.success,                            r7setup.data.error);
        const acct2Id = r7setup.data.account?.id;

        // Try to create a third account with a taken login
        const r7dup = await api(tok, 'POST', '/api/department-accounts', {
            departmentId: d3Id, loginIdentifier: 'cucina1-updated', password: '1234'
        });
        check('S20-7b. Dup login on create rejected',  !r7dup.data.success && r7dup.status === 409,   r7dup.data.error);

        // Try to update D2 login to D1's login
        const r7patch = await api(tok, 'PATCH', `/api/department-accounts/${acct2Id}`, {
            loginIdentifier: 'cucina1-updated'
        });
        check('S20-7c. Dup login on PATCH rejected',   !r7patch.data.success && r7patch.status === 409, r7patch.data.error);

        // Same login in a different company IS allowed (company-scoped uniqueness)
        const r7b = await api(tokB, 'POST', '/api/department-accounts', {
            departmentId: dBId, loginIdentifier: 'cucina1-updated', password: '1234'
        });
        check('S20-7d. Same login different company ok', r7b.data.success,                            r7b.data.error);

        // ── 8. One account per department ─────────────────────────────────
        console.log('\n  — 8. One account per department —\n');
        const r8 = await api(tok, 'POST', '/api/department-accounts', {
            departmentId: d1Id, loginIdentifier: 'cucina-dup', password: '1234'
        });
        check('S20-8.  Second account for D1 rejected', !r8.data.success && r8.status === 409,        r8.data.error);

        // ── 9. Department without account shows no account ────────────────
        console.log('\n  — 9. Department without account —\n');
        const rGet9 = await api(tok, 'GET', '/api/department-accounts');
        const accts9D3 = (rGet9.data.accounts || []).filter(a => a.departmentId === d3Id);
        check('S20-9.  D3 (no account) absent from list', accts9D3.length === 0,                      accts9D3.length);

        // ── 10. Department with account shows account ──────────────────────
        console.log('\n  — 10. Department with account —\n');
        const accts10D1 = (rGet9.data.accounts || []).filter(a => a.departmentId === d1Id);
        check('S20-10.  D1 has exactly one account',    accts10D1.length === 1,                        accts10D1.length);
        check('S20-10b. Account has loginIdentifier',   !!accts10D1[0]?.loginIdentifier,               null);
        check('S20-10c. hasPassword in account',        accts10D1[0]?.hasPassword === true,             accts10D1[0]?.hasPassword);

        // ── 11. Cross-company isolation ───────────────────────────────────
        console.log('\n  — 11. Company isolation —\n');
        const rGetB = await api(tokB, 'GET', '/api/department-accounts');
        const bAccts = rGet9.data.accounts || [];
        const bOwnAccts = (rGetB.data.accounts || []);
        // Company B sees only its own accounts
        const bSeesTratt = bOwnAccts.some(a => a.companyId === 'tratt');
        check('S20-11. Company B cannot see Company A accounts', !bSeesTratt,                          bOwnAccts.map(a => a.companyId));
        // Company A still sees only its own
        const aSeesB = bAccts.some(a => a.companyId === 'brasserie');
        check('S20-11b. Company A cannot see Company B accounts', !aSeesB,                             bAccts.map(a => a.companyId));

        // ── 12. PATCH unknown account ─────────────────────────────────────
        console.log('\n  — 12. Error handling —\n');
        const r12a = await api(tok, 'PATCH', '/api/department-accounts/nonexistent', { loginIdentifier: 'x' });
        check('S20-12. PATCH unknown account → 404',   r12a.status === 404,                            r12a.status);

        const r12b = await api(tok, 'PATCH', `/api/department-accounts/${acct1Id}`, { loginIdentifier: '' });
        check('S20-12b. PATCH empty login → 400',      r12b.status === 400,                            r12b.status);

        const r12c = await api(tok, 'PATCH', `/api/department-accounts/${acct1Id}`, { password: '' });
        check('S20-12c. PATCH empty password → 400',   r12c.status === 400,                            r12c.status);

        // ── 13. Operations endpoints unchanged ────────────────────────────
        console.log('\n  — 13. Operations unchanged —\n');
        const rOps = await api(tok, 'GET', '/api/operations/me');
        check('S20-13. Operations /me reachable',      rOps.status === 200 || rOps.status === 403,     rOps.status);

        // ── 14. Regression: create without displayName → auto-derived from dept ──
        // D3 ("Sala S20") has no account yet — use it to verify the auto-derive path.
        // S20-9 already confirmed D3 has no account, so this is the first write to D3.
        console.log('\n  — 14. displayName auto-derive regression —\n');
        const r14 = await api(tok, 'POST', '/api/department-accounts', {
            departmentId: d3Id,
            loginIdentifier: 'sala-login',
            password: 'secret'
            // no displayName field — server must derive it from the dept ("Sala S20")
        });
        check('S20-14.  Create without displayName → 201',          r14.status === 201,                         r14.status);
        check('S20-14b. displayName auto-derived from dept name',    r14.data.account?.displayName === 'Sala S20', r14.data.account?.displayName);
        // Verify via GET that the derived displayName is persisted
        const rGet14 = await api(tok, 'GET', '/api/department-accounts');
        const a14    = (rGet14.data.accounts || []).find(a => a.departmentId === d3Id);
        check('S20-14c. GET also returns derived displayName',       a14?.displayName === 'Sala S20',            a14?.displayName);
        check('S20-14d. passwordHash absent in response',            !r14.data.account?.passwordHash,            r14.data.account?.passwordHash);

    } finally {
        await stopServer(server);
        try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    }

    console.log(`\n${passed + failed} total — ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error in test runner:', err.message);
    process.exit(1);
});
