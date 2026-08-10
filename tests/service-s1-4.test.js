// tests/service-s1-4.test.js — Sprint S1.4: REST Department Locking
//
// Verifies server-side department access is locked to the bound department
// for Department Account users, while preserving full legacy behaviour
// for unbound Service users.
//
// Run: node tests/service-s1-4.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET   = 'test-secret-for-s14-suite';
const PORT     = 5096;
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 's14test-'));

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
async function createDept(token, name) {
    const r = await api(token, 'POST', '/api/departments', { name });
    return r.data?.department?.id;
}
async function createAccount(token, departmentId, displayName, loginIdentifier) {
    const r = await api(token, 'POST', '/api/department-accounts', {
        departmentId, displayName, loginIdentifier
    });
    return r.data?.account;
}
async function bindAccount(token, loginIdentifier) {
    return api(token, 'POST', '/api/department-accounts/bind', { loginIdentifier });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    // Pre-seed ristorante on the medium plan (limit 5) so test 12 and 14 can
    // create extra departments without hitting the default base-plan cap of 3.
    fs.writeFileSync(
        path.join(DATA_DIR, 'plans.json'),
        JSON.stringify({ ristorante: 'medium' })
    );

    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running S1.4 checks…\n');

    try {
        // ── Actors ───────────────────────────────────────────────────────────
        const tokAdmin   = sign('uid-admin',   'ristorante');   // unbound admin
        const tokBoundD1 = sign('uid-d1',      'ristorante');   // bound to Dept 1
        const tokSusp    = sign('uid-susp',    'ristorante');   // suspended acct
        const tokLegacy  = sign('uid-legacy',  'ristorante');   // unbound legacy
        const tokOther   = sign('uid-other',   'other-co');      // other company

        // ── Setup ─────────────────────────────────────────────────────────────
        console.log('  — setup —\n');
        const dept1Id = await createDept(tokAdmin, 'Kitchen');
        const dept2Id = await createDept(tokAdmin, 'Bar');
        const dept3Id = await createDept(tokAdmin, 'Pastry');
        check('Setup: dept1', !!dept1Id, dept1Id);
        check('Setup: dept2', !!dept2Id, dept2Id);
        check('Setup: dept3', !!dept3Id, dept3Id);

        const acctD1   = await createAccount(tokAdmin, dept1Id, 'Kitchen Display', 'kitchen.s14');
        const acctSusp = await createAccount(tokAdmin, dept2Id, 'Bar Display',     'bar.s14');
        check('Setup: acct d1',   !!acctD1?.id,   acctD1?.id);
        check('Setup: acct susp', !!acctSusp?.id, acctSusp?.id);

        let r = await bindAccount(tokBoundD1, 'kitchen.s14');
        check('Setup: uid-d1 bound to kitchen', r.data.success === true, r.data);

        r = await bindAccount(tokSusp, 'bar.s14');
        check('Setup: uid-susp bound to bar',   r.data.success === true, r.data);
        r = await api(tokAdmin, 'PUT', `/api/department-accounts/${acctSusp.id}/status`, { status: 'SUSPENDED' });
        check('Setup: bar account suspended',   r.data.success === true, r.data);

        // Other company
        const deptOtherId = await createDept(tokOther, 'Lounge');
        const acctOther   = await createAccount(tokOther, deptOtherId, 'Lounge Display', 'lounge.s14');
        r = await bindAccount(tokOther, 'lounge.s14');
        check('Setup: other-co bound', r.data.success === true, r.data);

        // ── 1. Bound D1 → GET /api/departments returns only D1 ───────────────
        console.log('\n  — 1. bound GET /api/departments returns only own dept —\n');
        r = await api(tokBoundD1, 'GET', '/api/departments');
        check('S14-1.  status 200',                        r.status === 200, r.status);
        check('S14-2.  success:true',                      r.data.success === true, r.data);
        check('S14-3.  exactly one department returned',   r.data.departments?.length === 1, r.data.departments?.length);
        check('S14-4.  returned dept is D1',               r.data.departments?.[0]?.id === dept1Id, r.data.departments?.[0]?.id);
        check('S14-5.  D2 not in list',                    !(r.data.departments || []).some(d => d.id === dept2Id), r.data.departments?.map(d=>d.id));
        check('S14-6.  D3 not in list',                    !(r.data.departments || []).some(d => d.id === dept3Id), r.data.departments?.map(d=>d.id));

        // ── 2. Bound D1 cannot obtain D2 ─────────────────────────────────────
        console.log('\n  — 2. bound account cannot reach D2 via dept management —\n');
        // Trying to PUT D2 (update its name) — must be rejected
        r = await api(tokBoundD1, 'PUT', `/api/departments/${dept2Id}`, { name: 'Renamed' });
        check('S14-7.  PUT D2 → 403',                      r.status === 403, r.status);
        check('S14-8.  error message present',             typeof r.data.error === 'string', r.data);

        // ── 3. Bound D1 cannot obtain another company's department ────────────
        console.log('\n  — 3. cross-company isolation —\n');
        // uid-d1 token has companyName=ristorante; other-co departments are invisible
        r = await api(tokBoundD1, 'GET', '/api/departments');
        const allDeptIds = (r.data.departments || []).map(d => d.id);
        check('S14-9.  other-co dept not in list',         !allDeptIds.includes(deptOtherId), allDeptIds);

        // other-co bound account sees only its own dept, not ristorante's
        r = await api(tokOther, 'GET', '/api/departments');
        const otherDeptIds = (r.data.departments || []).map(d => d.id);
        check('S14-10. other-co sees only lounge',         otherDeptIds.includes(deptOtherId) && !otherDeptIds.includes(dept1Id), otherDeptIds);

        // ── 4. Forged departmentId body has no effect ─────────────────────────
        console.log('\n  — 4. forged body departmentId ignored —\n');
        // POST a new department with a forged departmentId in body — still rejected (bound)
        r = await api(tokBoundD1, 'POST', '/api/departments', {
            name: 'Injected',
            departmentId: dept1Id   // even own dept id in body is irrelevant
        });
        check('S14-11. POST with forged body → 403',       r.status === 403, r.status);

        // PUT with own dept id in URL — still rejected (bound accounts can't manage)
        r = await api(tokBoundD1, 'PUT', `/api/departments/${dept1Id}`, { name: 'Own Dept Rename' });
        check('S14-12. PUT own dept → 403 (workstation, not admin)', r.status === 403, r.status);

        // ── 5. Forged company value has no effect ─────────────────────────────
        console.log('\n  — 5. forged company in body/query ignored —\n');
        r = await api(tokBoundD1, 'GET', '/api/departments?company=other-co');
        check('S14-13. query company ignored — still returns ristorante dept', r.data.departments?.[0]?.id === dept1Id, r.data.departments?.[0]?.id);
        check('S14-14. only one dept (not other-co merge)',  r.data.departments?.length === 1, r.data.departments?.length);

        r = await api(tokBoundD1, 'POST', '/api/departments', {
            name: 'Hacked',
            companyId: 'other-co'  // forged company — must be ignored and still 403
        });
        check('S14-15. forged body companyId still 403',   r.status === 403, r.status);

        // ── 6. Bound account cannot POST new department ───────────────────────
        console.log('\n  — 6. bound cannot POST /api/departments —\n');
        r = await api(tokBoundD1, 'POST', '/api/departments', { name: 'New Dept' });
        check('S14-16. POST /api/departments → 403',       r.status === 403, r.status);

        // ── 7. Bound account cannot PUT another department ────────────────────
        console.log('\n  — 7. bound cannot PUT /api/departments/:id —\n');
        r = await api(tokBoundD1, 'PUT', `/api/departments/${dept2Id}`, { name: 'Hacked' });
        check('S14-17. PUT /:id → 403',                    r.status === 403, r.status);
        // Verify D2 name was NOT changed
        r = await api(tokAdmin, 'GET', '/api/departments');
        const d2 = (r.data.departments || []).find(d => d.id === dept2Id);
        check('S14-18. D2 name unchanged',                 d2?.name === 'Bar', d2?.name);

        // ── 8. Bound account cannot DELETE another department ─────────────────
        console.log('\n  — 8. bound cannot DELETE /api/departments/:id —\n');
        r = await api(tokBoundD1, 'DELETE', `/api/departments/${dept3Id}`);
        check('S14-19. DELETE /:id → 403',                 r.status === 403, r.status);
        // Verify D3 still exists
        r = await api(tokAdmin, 'GET', '/api/departments');
        const d3 = (r.data.departments || []).find(d => d.id === dept3Id);
        check('S14-20. D3 still exists',                   !!d3, d3);

        // ── 9. Bound account cannot manage even its own dept through admin CRUD ─
        console.log('\n  — 9. bound cannot manage own dept via CRUD —\n');
        r = await api(tokBoundD1, 'PUT', `/api/departments/${dept1Id}`, { name: 'Renamed' });
        check('S14-21. PUT own dept → 403',                r.status === 403, r.status);
        r = await api(tokBoundD1, 'DELETE', `/api/departments/${dept1Id}`);
        check('S14-22. DELETE own dept → 403',             r.status === 403, r.status);
        r = await api(tokBoundD1, 'PUT', `/api/departments/${dept1Id}/type`, { departmentType: 'CENTRAL' });
        check('S14-23. PUT own dept type → 403',           r.status === 403, r.status);

        // ── 10. Suspended account receives 403 ────────────────────────────────
        console.log('\n  — 10. suspended account → 403 everywhere —\n');
        r = await api(tokSusp, 'GET', '/api/departments');
        check('S14-24. GET /api/departments → 403',        r.status === 403, r.status);
        check('S14-25. suspended error message',           typeof r.data.error === 'string' && r.data.error.toLowerCase().includes('sospeso'), r.data.error);

        r = await api(tokSusp, 'POST', '/api/departments', { name: 'Try' });
        check('S14-26. POST → 403 (suspended)',            r.status === 403, r.status);

        r = await api(tokSusp, 'PUT', `/api/departments/${dept2Id}`, { name: 'Try' });
        check('S14-27. PUT → 403 (suspended)',             r.status === 403, r.status);

        r = await api(tokSusp, 'DELETE', `/api/departments/${dept2Id}`);
        check('S14-28. DELETE → 403 (suspended)',          r.status === 403, r.status);

        // ── 11. Unbound legacy account receives all departments ───────────────
        console.log('\n  — 11. unbound legacy → all departments —\n');
        r = await api(tokLegacy, 'GET', '/api/departments');
        check('S14-29. status 200',                        r.status === 200, r.status);
        check('S14-30. success:true',                      r.data.success === true, r.data);
        const legacyIds = (r.data.departments || []).map(d => d.id);
        check('S14-31. D1 visible',                        legacyIds.includes(dept1Id), legacyIds);
        check('S14-32. D2 visible',                        legacyIds.includes(dept2Id), legacyIds);
        check('S14-33. D3 visible',                        legacyIds.includes(dept3Id), legacyIds);
        check('S14-34. at least 3 departments',            legacyIds.length >= 3, legacyIds.length);

        // ── 12. Unbound legacy department management unchanged ─────────────────
        console.log('\n  — 12. unbound legacy management unchanged —\n');
        // Admin (unbound) can still create
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Drinks' });
        check('S14-35. admin POST → 201',                  r.status === 201, r.status);
        const dept4Id = r.data?.department?.id;
        check('S14-36. new dept id returned',              !!dept4Id, dept4Id);

        // Legacy can update
        r = await api(tokLegacy, 'PUT', `/api/departments/${dept4Id}`, { name: 'Cocktails' });
        check('S14-37. legacy PUT → 200',                  r.status === 200, r.status);
        check('S14-38. name updated',                      r.data.department?.name === 'Cocktails', r.data.department?.name);

        // Legacy can delete (no dept accounts bound, no countdowns)
        r = await api(tokLegacy, 'DELETE', `/api/departments/${dept4Id}`);
        check('S14-39. legacy DELETE → 200',               r.status === 200, r.status);

        // ── 13. S1.3 identity → redirect data still correct ───────────────────
        console.log('\n  — 13. S1.3 regression: identity still resolves for redirect —\n');
        r = await api(tokBoundD1, 'GET', '/api/service/identity');
        check('S14-40. identity → 200',                    r.status === 200, r.status);
        check('S14-41. departmentId matches D1',           r.data.departmentId === dept1Id, r.data.departmentId);
        check('S14-42. departmentAccountStatus ACTIVE',    r.data.departmentAccountStatus === 'ACTIVE', r.data.departmentAccountStatus);
        check('S14-43. departmentType present',            !!r.data.departmentType, r.data.departmentType);

        // ── 14. S1.2 regression: bind still works ────────────────────────────
        console.log('\n  — 14. S1.2 regression: bind endpoint —\n');
        const tokFresh = sign('uid-fresh', 'ristorante');
        // Create a dept (by admin) and account
        const deptFreshId = await createDept(tokAdmin, 'Sushi');
        const acctFresh   = await createAccount(tokAdmin, deptFreshId, 'Sushi Display', 'sushi.s14');
        r = await bindAccount(tokFresh, 'sushi.s14');
        check('S14-44. fresh bind → 200',                  r.status === 200, r.status);
        check('S14-45. firebaseUid set',                   r.data.account?.firebaseUid === 'uid-fresh', r.data.account?.firebaseUid);
        // Newly bound account sees only its own dept
        r = await api(tokFresh, 'GET', '/api/departments');
        check('S14-46. new bound account sees only sushi', r.data.departments?.length === 1 && r.data.departments?.[0]?.id === deptFreshId, r.data.departments?.map(d=>d.id));

        // ── 15. S1.1 management endpoints regression ──────────────────────────
        console.log('\n  — 15. S1.1 regression: dept account management —\n');
        r = await api(tokAdmin, 'GET', '/api/department-accounts');
        check('S14-47. list dept accounts → 200',          r.status === 200, r.status);
        check('S14-48. success:true',                      r.data.success === true, r.data);
        r = await api(tokAdmin, 'POST', '/api/department-accounts', {
            departmentId: dept1Id, displayName: 'K2', loginIdentifier: 'k2.s14'
        });
        // Will fail with 409 (dept already has active account) — expected
        check('S14-49. create account returns ok or 409',  r.status === 201 || r.status === 409, r.status);

        // ── 16. Auth guards ───────────────────────────────────────────────────
        console.log('\n  — 16. auth guards —\n');
        r = await api(null, 'GET', '/api/departments');
        check('S14-50. no token → 401',                    r.status === 401, r.status);
        r = await api(null, 'POST', '/api/departments', { name: 'X' });
        check('S14-51. no token POST → 401',               r.status === 401, r.status);
        r = await api(null, 'PUT', `/api/departments/${dept1Id}`, { name: 'X' });
        check('S14-52. no token PUT → 401',                r.status === 401, r.status);
        r = await api(null, 'DELETE', `/api/departments/${dept1Id}`);
        check('S14-53. no token DELETE → 401',             r.status === 401, r.status);

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
