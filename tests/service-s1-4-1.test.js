// tests/service-s1-4-1.test.js — Sprint S1.4.1: REST Department Locking Refinements
//
// Verifies:
//  • GET /api/service/department returns correct structured response
//  • departmentType resolved correctly from dept record
//  • inactive assigned dept → 410 + code DEPARTMENT_INACTIVE (not empty array)
//  • structured error payloads include `code` field
//  • legacy GET /api/departments unchanged for unbound users
//  • centralized departmentAccessError() used consistently
//  • full S1.1–S1.4 regression
//
// Run: node tests/service-s1-4-1.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET   = 'test-secret-for-s141-suite';
const PORT     = 5095;
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 's141test-'));

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
async function createDept(token, name, type) {
    const r = await api(token, 'POST', '/api/departments', { name });
    const id = r.data?.department?.id;
    if (id && type === 'CENTRAL') {
        await api(token, 'PUT', `/api/departments/${id}/type`, { departmentType: 'CENTRAL' });
    }
    return id;
}
async function createAccount(token, deptId, displayName, loginId) {
    const r = await api(token, 'POST', '/api/department-accounts', {
        departmentId: deptId, displayName, loginIdentifier: loginId
    });
    return r.data?.account;
}
async function bindAccount(token, loginId) {
    return api(token, 'POST', '/api/department-accounts/bind', { loginIdentifier: loginId });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    // Pre-seed medium plan so we can create >3 departments
    fs.writeFileSync(
        path.join(DATA_DIR, 'plans.json'),
        JSON.stringify({ trattoria: 'medium' })
    );

    // Pre-seed a DEPARTMENT_INACTIVE scenario: an ACTIVE account bound to a
    // department that is already inactive.  This state is unreachable through
    // the public API (deactivating a dept auto-suspends its account via S1.1
    // referential integrity; creating an account for an inactive dept is
    // rejected at validation).  Direct data injection is the only way to cover
    // this defensive code path.
    const PRESEEDED_DEPT_ID  = 'dept_preseeded_inactive';
    const PRESEEDED_ACCT_ID  = 'depacct_preseeded_inactive';
    const PRESEEDED_UID      = 'uid-preseeded-inact';
    fs.writeFileSync(
        path.join(DATA_DIR, 'departments.json'),
        JSON.stringify({
            trattoria: [
                { id: PRESEEDED_DEPT_ID, name: 'Cantina', active: false,
                  usedInCountdowns: false, createdAt: Date.now() }
            ]
        })
    );
    fs.writeFileSync(
        path.join(DATA_DIR, 'department-accounts.json'),
        JSON.stringify({
            trattoria: [
                { id: PRESEEDED_ACCT_ID, companyId: 'trattoria',
                  departmentId: PRESEEDED_DEPT_ID, displayName: 'Cantina Display',
                  loginIdentifier: 'cantina.preseeded', firebaseUid: PRESEEDED_UID,
                  status: 'ACTIVE', createdAt: Date.now(), createdBy: null }
            ]
        })
    );

    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running S1.4.1 checks…\n');

    try {
        // ── Actors ───────────────────────────────────────────────────────────
        const tokAdmin        = sign('uid-admin',   'trattoria');   // unbound
        const tokStd          = sign('uid-std',     'trattoria');   // bound to STANDARD dept
        const tokCentral      = sign('uid-central', 'trattoria');   // bound to CENTRAL dept
        const tokSusp         = sign('uid-susp',    'trattoria');   // suspended
        const tokLegacy       = sign('uid-legacy',  'trattoria');   // unbound legacy
        // Pre-seeded: ACTIVE account → inactive dept (only reachable via data injection)
        const tokPreseededInact = sign(PRESEEDED_UID, 'trattoria');

        // ── Setup ─────────────────────────────────────────────────────────────
        console.log('  — setup —\n');
        const deptStdId  = await createDept(tokAdmin, 'Cucina');
        const deptCentId = await createDept(tokAdmin, 'Centrale', 'CENTRAL');
        const deptBarId  = await createDept(tokAdmin, 'Bar');
        check('Setup: std dept',     !!deptStdId,  deptStdId);
        check('Setup: central dept', !!deptCentId, deptCentId);
        check('Setup: bar dept',     !!deptBarId,  deptBarId);

        const acctStd  = await createAccount(tokAdmin, deptStdId,  'Cucina Display',   'cucina.141');
        const acctCent = await createAccount(tokAdmin, deptCentId, 'Centrale Display', 'centrale.141');
        const acctBar  = await createAccount(tokAdmin, deptBarId,  'Bar Display',      'bar.141');
        check('Setup: std acct',   !!acctStd?.id,   acctStd?.id);
        check('Setup: cent acct',  !!acctCent?.id,  acctCent?.id);
        check('Setup: bar acct',   !!acctBar?.id,   acctBar?.id);

        let r = await bindAccount(tokStd,     'cucina.141');
        check('Setup: std bound',   r.data.success === true, r.data);
        r = await bindAccount(tokCentral, 'centrale.141');
        check('Setup: central bound', r.data.success === true, r.data);
        r = await bindAccount(tokSusp,    'bar.141');
        check('Setup: susp bound',  r.data.success === true, r.data);

        // Suspend bar account
        r = await api(tokAdmin, 'PUT', `/api/department-accounts/${acctBar.id}/status`, { status: 'SUSPENDED' });
        check('Setup: bar suspended', r.data.success === true, r.data);

        // ── 1. GET /api/service/department — correct response ─────────────────
        console.log('\n  — 1. GET /api/service/department (STANDARD dept) —\n');
        r = await api(tokStd, 'GET', '/api/service/department');
        check('S141-1.  status 200',               r.status === 200, r.status);
        check('S141-2.  success:true',             r.data.success === true, r.data);
        check('S141-3.  departmentId correct',     r.data.departmentId === deptStdId, r.data.departmentId);
        check('S141-4.  departmentName correct',   r.data.departmentName === 'Cucina', r.data.departmentName);
        check('S141-5.  status ACTIVE',            r.data.status === 'ACTIVE', r.data.status);
        check('S141-6.  departmentAccountId present', !!r.data.departmentAccountId, r.data.departmentAccountId);

        // ── 2. departmentType resolved correctly ──────────────────────────────
        console.log('\n  — 2. departmentType from dept record —\n');
        check('S141-7.  STANDARD type',            r.data.departmentType === 'STANDARD', r.data.departmentType);

        r = await api(tokCentral, 'GET', '/api/service/department');
        check('S141-8.  central status 200',       r.status === 200, r.status);
        check('S141-9.  CENTRAL type',             r.data.departmentType === 'CENTRAL', r.data.departmentType);
        check('S141-10. central departmentId',     r.data.departmentId === deptCentId, r.data.departmentId);
        check('S141-11. central departmentName',   r.data.departmentName === 'Centrale', r.data.departmentName);

        // ── 3. Inactive assigned dept → explicit 410 (not empty array) ────────
        // Uses the pre-seeded actor: an ACTIVE account pointing at an inactive dept.
        // This state is unreachable via public API because deactivating a dept
        // auto-suspends its account (S1.1 referential integrity).  Direct data
        // injection is the only way to exercise this defensive code path.
        console.log('\n  — 3. inactive dept → 410 DEPARTMENT_INACTIVE (pre-seeded) —\n');
        r = await api(tokPreseededInact, 'GET', '/api/service/department');
        check('S141-12. status 410',               r.status === 410, r.status);
        check('S141-13. error message present',    typeof r.data.error === 'string', r.data);
        check('S141-14. code DEPARTMENT_INACTIVE', r.data.code === 'DEPARTMENT_INACTIVE', r.data.code);
        check('S141-15. NOT an empty array',       !Array.isArray(r.data), r.data);

        // Also verify GET /api/departments returns 410 for inactive dept (not [])
        r = await api(tokPreseededInact, 'GET', '/api/departments');
        check('S141-16. /api/departments 410 for inactive', r.status === 410, r.status);
        check('S141-17. code DEPARTMENT_INACTIVE',          r.data.code === 'DEPARTMENT_INACTIVE', r.data.code);
        check('S141-18. not an empty array response',       !(r.data.departments && r.data.departments.length === 0), r.data);

        // ── 4. Structured error payloads with `code` field ────────────────────
        console.log('\n  — 4. structured error payloads —\n');
        // Suspended → code ACCOUNT_SUSPENDED
        r = await api(tokSusp, 'GET', '/api/service/department');
        check('S141-19. suspended 403',            r.status === 403, r.status);
        check('S141-20. code ACCOUNT_SUSPENDED',   r.data.code === 'ACCOUNT_SUSPENDED', r.data.code);
        check('S141-21. error string present',     typeof r.data.error === 'string', r.data);

        // Suspended on /api/departments → same code
        r = await api(tokSusp, 'GET', '/api/departments');
        check('S141-22. /api/departments susp 403',         r.status === 403, r.status);
        check('S141-23. /api/departments code ACCOUNT_SUSPENDED', r.data.code === 'ACCOUNT_SUSPENDED', r.data.code);

        // Bound active trying to POST → code ACCOUNT_NOT_AUTHORIZED
        r = await api(tokStd, 'POST', '/api/departments', { name: 'Attempt' });
        check('S141-24. POST 403',                 r.status === 403, r.status);
        check('S141-25. code ACCOUNT_NOT_AUTHORIZED', r.data.code === 'ACCOUNT_NOT_AUTHORIZED', r.data.code);

        // Bound active trying to PUT → code ACCOUNT_NOT_AUTHORIZED
        r = await api(tokStd, 'PUT', `/api/departments/${deptStdId}`, { name: 'X' });
        check('S141-26. PUT 403',                  r.status === 403, r.status);
        check('S141-27. code ACCOUNT_NOT_AUTHORIZED', r.data.code === 'ACCOUNT_NOT_AUTHORIZED', r.data.code);

        // Bound active trying to DELETE → code ACCOUNT_NOT_AUTHORIZED
        r = await api(tokStd, 'DELETE', `/api/departments/${deptStdId}`);
        check('S141-28. DELETE 403',               r.status === 403, r.status);
        check('S141-29. code ACCOUNT_NOT_AUTHORIZED', r.data.code === 'ACCOUNT_NOT_AUTHORIZED', r.data.code);

        // Unbound calling /api/service/department → NOT_BOUND
        r = await api(tokLegacy, 'GET', '/api/service/department');
        check('S141-30. unbound /service/department 403', r.status === 403, r.status);
        check('S141-31. code NOT_BOUND',           r.data.code === 'NOT_BOUND', r.data.code);

        // ── 5. Legacy GET /api/departments unchanged ───────────────────────────
        console.log('\n  — 5. legacy /api/departments unchanged —\n');
        r = await api(tokLegacy, 'GET', '/api/departments');
        check('S141-32. legacy 200',               r.status === 200, r.status);
        check('S141-33. success:true',             r.data.success === true, r.data);
        check('S141-34. returns array',            Array.isArray(r.data.departments), r.data);
        const legacyIds = (r.data.departments || []).map(d => d.id);
        check('S141-35. cucina visible',           legacyIds.includes(deptStdId), legacyIds);
        check('S141-36. centrale visible',         legacyIds.includes(deptCentId), legacyIds);
        check('S141-37. plan info present',        typeof r.data.plan === 'string', r.data.plan);
        check('S141-38. limit info present',       typeof r.data.limit === 'number', r.data.limit);

        // Admin (unbound) also sees all depts
        r = await api(tokAdmin, 'GET', '/api/departments');
        check('S141-39. admin 200',                r.status === 200, r.status);
        const adminIds = (r.data.departments || []).map(d => d.id);
        check('S141-40. admin sees cucina',        adminIds.includes(deptStdId), adminIds);
        check('S141-41. admin sees centrale',      adminIds.includes(deptCentId), adminIds);

        // ── 6. Bound account — /api/service/department is source of truth ─────
        console.log('\n  — 6. bound → /api/service/department preferred over /api/departments —\n');
        // Bound active account: /api/departments still returns one dept (backward compat)
        r = await api(tokStd, 'GET', '/api/departments');
        check('S141-42. bound GET /api/departments still 200', r.status === 200, r.status);
        check('S141-43. still returns own dept only', r.data.departments?.length === 1 && r.data.departments[0].id === deptStdId,
            r.data.departments?.map(d => d.id));

        // /api/service/department returns richer shape
        r = await api(tokStd, 'GET', '/api/service/department');
        check('S141-44. /service/department has departmentName',  !!r.data.departmentName, r.data.departmentName);
        check('S141-45. /service/department has departmentType',  !!r.data.departmentType, r.data.departmentType);
        check('S141-46. /service/department has status',          !!r.data.status, r.data.status);
        check('S141-47. /service/department has departmentAccountId', !!r.data.departmentAccountId, r.data.departmentAccountId);

        // ── 7. Auth guards ────────────────────────────────────────────────────
        console.log('\n  — 7. auth guards —\n');
        r = await api(null, 'GET', '/api/service/department');
        check('S141-48. /service/department requires auth', r.status === 401, r.status);

        // ── 8. S1.4 regression: all management blocks still work ──────────────
        console.log('\n  — 8. S1.4 regression —\n');
        r = await api(tokStd, 'POST', '/api/departments', { name: 'X' });
        check('S141-49. POST still 403',  r.status === 403, r.status);
        r = await api(tokSusp, 'PUT', `/api/departments/${deptBarId}`, { name: 'X' });
        check('S141-50. PUT susp 403',    r.status === 403, r.status);
        r = await api(tokStd, 'PUT', `/api/departments/${deptStdId}/type`, { departmentType: 'CENTRAL' });
        check('S141-51. type PUT 403',    r.status === 403, r.status);

        // ── 9. S1.3 regression: identity still resolves ───────────────────────
        console.log('\n  — 9. S1.3 regression —\n');
        r = await api(tokStd, 'GET', '/api/service/identity');
        check('S141-52. identity 200',              r.status === 200, r.status);
        check('S141-53. departmentId present',      r.data.departmentId === deptStdId, r.data.departmentId);
        check('S141-54. departmentAccountStatus',   r.data.departmentAccountStatus === 'ACTIVE', r.data.departmentAccountStatus);

        // ── 10. S1.1 regression: management endpoints ─────────────────────────
        console.log('\n  — 10. S1.1 regression —\n');
        r = await api(tokAdmin, 'GET', '/api/department-accounts');
        check('S141-55. list dept accounts 200', r.status === 200, r.status);
        check('S141-56. success:true',           r.data.success === true, r.data);

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
