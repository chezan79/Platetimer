// tests/department-accounts-s1-2.test.js — Sprint S1.2: Firebase Binding
// for Department Accounts.
//
// Spawns the real server with known WS_SESSION_SECRET + isolated DATA_DIR,
// signs HMAC session tokens directly (same scheme as the server), and exercises:
//   • binding a verified UID to a Department Account
//   • rejection of arbitrary/duplicate/cross-company bindings
//   • /api/service/identity session resolution (departmentAccountId, departmentId,
//     departmentType, departmentAccountStatus)
//   • SUSPENDED status in identity context
//   • legacy Service session users unaffected
//
// Run: node tests/department-accounts-s1-2.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = 'test-secret-for-s12-suite';
const PORT   = 5098;
const BASE   = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 's12test-'));
// Pre-seed medium plan so company-a can create 5 active departments (needed by S12-32 fix)
fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({ 'company-a': 'medium', 'company-b': 'medium' }));

// ── Token helpers ────────────────────────────────────────────────────────────
function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

async function api(token, method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(BASE + p, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ── Assertions ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ' — got: ' + JSON.stringify(extra) : ''}`); }
}

// ── Server lifecycle ─────────────────────────────────────────────────────────
function startServer() {
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
        server.stdout.on('data', d => {
            if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(server); }
        });
    });
}
function stopServer(srv) {
    return new Promise(resolve => {
        srv.on('exit', resolve);
        srv.kill('SIGTERM');
        setTimeout(resolve, 3000);
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function createDept(token, name, type = 'STANDARD') {
    const r = await api(token, 'POST', '/api/departments', { name });
    const deptId = r.data?.department?.id;
    if (deptId && type === 'CENTRAL') {
        await api(token, 'PUT', `/api/departments/${deptId}/type`, { departmentType: 'CENTRAL' });
    }
    return deptId;
}

async function createAccount(token, departmentId, displayName, loginIdentifier) {
    const r = await api(token, 'POST', '/api/department-accounts', {
        departmentId, displayName, loginIdentifier
    });
    return r.data?.account;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running S1.2 checks…\n');

    try {
        // ── Actors ───────────────────────────────────────────────────────────
        // Company A: admin + two regular users + one cross-company user (Company B)
        const tokAdminA   = sign('uid-admin-a',   'company-a');
        const tokUserA1   = sign('uid-user-a1',   'company-a');  // will bind to account
        const tokUserA2   = sign('uid-user-a2',   'company-a');  // second user (dup test)
        const tokLegacy   = sign('uid-legacy',    'company-a');  // no dept account
        const tokAdminB   = sign('uid-admin-b',   'company-b');
        const tokUserB1   = sign('uid-user-b1',   'company-b');  // cross-company test

        // ── Setup: departments ────────────────────────────────────────────────
        console.log('  — setup —\n');
        const deptStdId   = await createDept(tokAdminA, 'Kitchen');
        const deptCentId  = await createDept(tokAdminA, 'Central Hub', 'CENTRAL');
        const deptBId     = await createDept(tokAdminB, 'Bar');
        check('Setup: dept std created',  !!deptStdId,  deptStdId);
        check('Setup: dept central created', !!deptCentId, deptCentId);
        check('Setup: dept B created',    !!deptBId,    deptBId);

        // ── Setup: department accounts ────────────────────────────────────────
        const acctStd  = await createAccount(tokAdminA, deptStdId,  'Kitchen Display', 'kitchen.display');
        const acctCent = await createAccount(tokAdminA, deptCentId, 'Central Display', 'central.display');
        const acctB    = await createAccount(tokAdminB, deptBId,    'Bar Display',     'bar.display');
        check('Setup: account standard created', !!acctStd,  acctStd?.id);
        check('Setup: account central created',  !!acctCent, acctCent?.id);
        check('Setup: account B created',        !!acctB,    acctB?.id);

        // ── 1. Verified UID binds to Department Account ───────────────────────
        console.log('\n  — 1. binding —\n');
        let r = await api(tokUserA1, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'kitchen.display'
        });
        check('S12-1. bind returns 200', r.status === 200, r.status);
        check('S12-2. bind success:true', r.data.success === true, r.data);
        check('S12-3. account returned',  !!r.data.account, r.data);
        check('S12-4. firebaseUid set',   r.data.account?.firebaseUid === 'uid-user-a1', r.data.account?.firebaseUid);
        check('S12-5. account id correct', r.data.account?.id === acctStd.id, r.data.account?.id);

        // ── 2. Arbitrary client UID rejected (body uid ignored) ───────────────
        console.log('\n  — 2. arbitrary uid rejected —\n');
        // uid-user-a2 tries to bind by sending a fake uid in the body — server must use session uid
        r = await api(tokUserA2, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'kitchen.display',  // already bound to uid-user-a1
            uid: 'uid-user-a1'                   // attempt to forge identity — must be ignored
        });
        // kitchen.display is already bound to uid-user-a1; uid-user-a2's session uid ≠ uid-user-a1
        // → should fail with 409 (UID already bound), not succeed
        check('S12-6. body uid ignored, real session uid used', r.status === 409, r.status);
        check('S12-7. error message present', typeof r.data.error === 'string', r.data);

        // ── 3. Duplicate UID binding rejected ────────────────────────────────
        console.log('\n  — 3. duplicate uid —\n');
        // uid-user-a1 is already bound to kitchen.display; bind again to central.display
        r = await api(tokUserA1, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'central.display'
        });
        check('S12-8. duplicate uid → 409',   r.status === 409, r.status);
        check('S12-9. error message present',  typeof r.data.error === 'string', r.data);

        // idempotent re-bind to SAME account must succeed
        r = await api(tokUserA1, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'kitchen.display'
        });
        check('S12-10. idempotent rebind → 200', r.status === 200, r.status);
        check('S12-11. success:true',            r.data.success === true, r.data);

        // ── 4. Cross-company binding rejected ────────────────────────────────
        console.log('\n  — 4. cross-company —\n');
        // uid-user-b1 (company-b) tries to bind to kitchen.display (company-a)
        r = await api(tokUserB1, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'kitchen.display'
        });
        check('S12-12. cross-company → 403',  r.status === 403, r.status);
        check('S12-13. error message present', typeof r.data.error === 'string', r.data);

        // uid-user-b1 can bind to bar.display (company-b) — correct
        r = await api(tokUserB1, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'bar.display'
        });
        check('S12-14. same-company bind → 200', r.status === 200, r.status);
        check('S12-15. success:true',            r.data.success === true, r.data);

        // ── 5. Session resolves departmentAccountId ───────────────────────────
        console.log('\n  — 5. session resolution (standard dept) —\n');
        r = await api(tokUserA1, 'GET', '/api/service/identity');
        check('S12-16. identity → 200',              r.status === 200, r.status);
        check('S12-17. success:true',                r.data.success === true, r.data);
        check('S12-18. departmentAccountId correct', r.data.departmentAccountId === acctStd.id, r.data.departmentAccountId);

        // ── 6. Session resolves departmentId ─────────────────────────────────
        check('S12-19. departmentId correct', r.data.departmentId === deptStdId, r.data.departmentId);

        // ── 7. Session resolves departmentType from department ────────────────
        check('S12-20. departmentType is STANDARD', r.data.departmentType === 'STANDARD', r.data.departmentType);

        // ── 7b. CENTRAL type resolves correctly ───────────────────────────────
        console.log('\n  — 7b. central type resolution —\n');
        // Bind uid-user-a2 to central.display
        r = await api(tokUserA2, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'central.display'
        });
        check('S12-21. bind uid-a2 to central → 200', r.status === 200, r.status);

        r = await api(tokUserA2, 'GET', '/api/service/identity');
        check('S12-22. identity → 200',             r.status === 200, r.status);
        check('S12-23. departmentType is CENTRAL',  r.data.departmentType === 'CENTRAL', r.data.departmentType);
        check('S12-24. departmentAccountId correct', r.data.departmentAccountId === acctCent.id, r.data.departmentAccountId);
        check('S12-25. departmentId correct',        r.data.departmentId === deptCentId, r.data.departmentId);

        // ── 8. SUSPENDED status resolves correctly ────────────────────────────
        console.log('\n  — 8. suspended status —\n');
        // Suspend kitchen.display account
        r = await api(tokAdminA, 'PUT', `/api/department-accounts/${acctStd.id}/status`, {
            status: 'SUSPENDED'
        });
        check('S12-26. suspend account → success', r.data.success === true, r.data);

        r = await api(tokUserA1, 'GET', '/api/service/identity');
        check('S12-27. identity still resolves for suspended', r.status === 200, r.status);
        check('S12-28. departmentAccountStatus = SUSPENDED',
            r.data.departmentAccountStatus === 'SUSPENDED', r.data.departmentAccountStatus);
        check('S12-29. departmentAccountId still present', !!r.data.departmentAccountId, r.data);
        check('S12-30. departmentId still present',        !!r.data.departmentId,        r.data);
        check('S12-31. departmentType still present',      !!r.data.departmentType,       r.data);

        // Binding to a SUSPENDED account must be rejected.
        // S2.0: one account per dept (any status) — cannot create a second account for deptStdId
        // (which already has acctStd, now suspended). Use a fresh dept for this test instead.
        const deptForSusp = await createDept(tokAdminA, 'Pantry');
        const acctSusp2Id = (await createAccount(tokAdminA, deptForSusp, 'KD2', 'kitchen.display2'))?.id;
        // Suspend immediately so we can test bind-to-suspended rejection
        await api(tokAdminA, 'PUT', `/api/department-accounts/${acctSusp2Id}/status`, { status: 'SUSPENDED' });
        const tokFresh = sign('uid-fresh', 'company-a');
        r = await api(tokFresh, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'kitchen.display2'
        });
        check('S12-32. bind to SUSPENDED account → 409', r.status === 409, r.status);

        // ── 9. Legacy Service user unaffected ────────────────────────────────
        console.log('\n  — 9. legacy Service user (no dept account) —\n');
        r = await api(tokLegacy, 'GET', '/api/service/identity');
        check('S12-33. identity → 200 for legacy user',      r.status === 200, r.status);
        check('S12-34. success:true',                        r.data.success === true, r.data);
        check('S12-35. no departmentAccountId',              r.data.departmentAccountId === undefined, r.data);
        check('S12-36. no departmentId',                     r.data.departmentId === undefined, r.data);
        check('S12-37. no departmentType',                   r.data.departmentType === undefined, r.data);
        check('S12-38. no departmentAccountStatus',          r.data.departmentAccountStatus === undefined, r.data);

        // ── 10. Auth guards ───────────────────────────────────────────────────
        console.log('\n  — 10. auth guards —\n');
        r = await api(null, 'GET', '/api/service/identity');
        check('S12-39. identity requires auth → 401', r.status === 401, r.status);

        r = await api(null, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'kitchen.display' });
        check('S12-40. bind requires auth → 401', r.status === 401, r.status);

        // ── 11. Bind validation ───────────────────────────────────────────────
        console.log('\n  — 11. bind validation —\n');
        const tokFresh2 = sign('uid-fresh2', 'company-a');
        r = await api(tokFresh2, 'POST', '/api/department-accounts/bind', {});
        check('S12-41. missing loginIdentifier → 400', r.status === 400, r.status);

        r = await api(tokFresh2, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'nonexistent.display'
        });
        check('S12-42. unknown loginIdentifier → 404', r.status === 404, r.status);

        // ── 12. Existing S1.1 management endpoints unaffected ─────────────────
        console.log('\n  — 12. S1.1 regression —\n');
        r = await api(tokAdminA, 'GET', '/api/department-accounts');
        check('S12-43. list accounts → 200',     r.status === 200, r.status);
        check('S12-44. success:true',            r.data.success === true, r.data);
        check('S12-45. returns array',           Array.isArray(r.data.accounts), r.data);

        r = await api(tokAdminA, 'GET', '/api/departments');
        check('S12-46. list departments → 200',  r.status === 200, r.status);

        // Create a new account (S1.1 create flow still works)
        const deptStd2 = await createDept(tokAdminA, 'Pastry');
        const newAcct  = await createAccount(tokAdminA, deptStd2, 'Pastry Display', 'pastry.display');
        check('S12-47. S1.1 create still works', !!newAcct?.id, newAcct);
        check('S12-48. firebaseUid starts null', newAcct?.firebaseUid === null, newAcct?.firebaseUid);

    } finally {
        await stopServer(server);
        // Cleanup temp dir
        try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log(`\n${passed + failed} total — ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error in test runner:', err.message);
    process.exit(1);
});
