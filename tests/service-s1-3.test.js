// tests/service-s1-3.test.js — Sprint S1.3: Direct Department Resolution
//
// Tests the server-side data that drives home.html routing:
//   • identity resolves correct departmentId for ACTIVE bound accounts
//   • identity resolves SUSPENDED status (routing blocked)
//   • identity returns empty for unbound (legacy selector shown)
//   • /api/departments returns valid active dept data for redirect validation
//   • company and department always come from the server session, never from
//     client-supplied values (localStorage / body fields)
//   • department.html server-side behavior unchanged
//   • Operations session endpoint regression
//
// Note: home.html redirect logic is pure browser JS. These tests verify the
// server responses that home.html consumes to make routing decisions.
//
// Run: node tests/service-s1-3.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET   = 'test-secret-for-s13-suite';
const PORT     = 5097;
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 's13test-'));

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
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Helpers ──────────────────────────────────────────────────────────────────
async function createDept(token, name, type) {
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
async function bindAccount(token, loginIdentifier) {
    return api(token, 'POST', '/api/department-accounts/bind', { loginIdentifier });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running S1.3 checks…\n');

    try {
        // ── Actors ───────────────────────────────────────────────────────────
        const tokAdmin    = sign('uid-admin',    'restaurant-co');
        const tokBound    = sign('uid-bound',    'restaurant-co');  // will be bound
        const tokLegacy   = sign('uid-legacy',   'restaurant-co');  // no binding
        const tokSusp     = sign('uid-susp',     'restaurant-co');  // suspended account
        const tokOtherCo  = sign('uid-other',    'other-co');        // different company

        // ── Setup ─────────────────────────────────────────────────────────────
        console.log('  — setup —\n');
        const deptKitchenId = await createDept(tokAdmin, 'Kitchen');
        const deptBarId     = await createDept(tokAdmin, 'Bar');
        const deptInactId   = await createDept(tokAdmin, 'Pantry');   // will be deactivated
        check('Setup: kitchen dept',  !!deptKitchenId, deptKitchenId);
        check('Setup: bar dept',      !!deptBarId,     deptBarId);
        check('Setup: pantry dept',   !!deptInactId,   deptInactId);

        const acctKitchen = await createAccount(tokAdmin, deptKitchenId, 'Kitchen Display', 'kitchen.s13');
        const acctBar     = await createAccount(tokAdmin, deptBarId,     'Bar Display',     'bar.s13');
        const acctInact   = await createAccount(tokAdmin, deptInactId,   'Pantry Display',  'pantry.s13');
        check('Setup: kitchen account', !!acctKitchen?.id, acctKitchen?.id);
        check('Setup: bar account',     !!acctBar?.id,     acctBar?.id);
        check('Setup: pantry account',  !!acctInact?.id,   acctInact?.id);

        // Bind uid-bound → kitchen.s13
        let r = await bindAccount(tokBound, 'kitchen.s13');
        check('Setup: uid-bound bound to kitchen', r.data.success === true, r.data);

        // Bind uid-susp → bar.s13, then suspend its account
        r = await bindAccount(tokSusp, 'bar.s13');
        check('Setup: uid-susp bound to bar', r.data.success === true, r.data);
        r = await api(tokAdmin, 'PUT', `/api/department-accounts/${acctBar.id}/status`, { status: 'SUSPENDED' });
        check('Setup: bar account suspended', r.data.success === true, r.data);

        // Bind uid-other (separate company setup)
        const deptOtherCoId = await createDept(tokOtherCo, 'Lounge');
        const acctOther = await createAccount(tokOtherCo, deptOtherCoId, 'Lounge Display', 'lounge.s13');
        r = await bindAccount(tokOtherCo, 'lounge.s13');
        check('Setup: other-co account bound', r.data.success === true, r.data);

        // ── 1. ACTIVE bound account resolves departmentId ─────────────────────
        console.log('\n  — 1. ACTIVE bound → resolves departmentId —\n');
        r = await api(tokBound, 'GET', '/api/service/identity');
        check('S13-1.  identity → 200',               r.status === 200, r.status);
        check('S13-2.  success:true',                  r.data.success === true, r.data);
        check('S13-3.  departmentId is kitchen',       r.data.departmentId === deptKitchenId, r.data.departmentId);
        check('S13-4.  departmentAccountStatus ACTIVE',r.data.departmentAccountStatus === 'ACTIVE', r.data.departmentAccountStatus);
        check('S13-5.  departmentAccountId present',   !!r.data.departmentAccountId, r.data.departmentAccountId);

        // ── 2. Dept selector not shown for bound account (server side) ────────
        // The identity response contains departmentAccountId → home.html redirects,
        // never rendering the selector. Verify all three routing fields are present.
        console.log('\n  — 2. redirect decision fields present —\n');
        check('S13-6.  all three routing fields present',
            !!(r.data.departmentAccountId && r.data.departmentId && r.data.departmentAccountStatus),
            { departmentAccountId: r.data.departmentAccountId, departmentId: r.data.departmentId, departmentAccountStatus: r.data.departmentAccountStatus });

        // ── 3. /api/departments confirms target dept is active ────────────────
        console.log('\n  — 3. redirect validation: dept active —\n');
        r = await api(tokBound, 'GET', '/api/departments');
        check('S13-7.  departments → 200',  r.status === 200, r.status);
        const activeDepts = (r.data.departments || []).filter(d => d.active);
        const kitchenDept = activeDepts.find(d => d.id === deptKitchenId);
        check('S13-8.  kitchen is in active depts', !!kitchenDept, kitchenDept);
        check('S13-9.  dept id matches identity',   kitchenDept?.id === deptKitchenId, kitchenDept?.id);

        // ── 4. Unbound legacy account sees dept selector ──────────────────────
        console.log('\n  — 4. unbound legacy → no identity fields —\n');
        r = await api(tokLegacy, 'GET', '/api/service/identity');
        check('S13-10. identity → 200 for legacy',       r.status === 200, r.status);
        check('S13-11. success:true',                    r.data.success === true, r.data);
        check('S13-12. no departmentAccountId',          r.data.departmentAccountId === undefined, r.data);
        check('S13-13. no departmentId',                 r.data.departmentId        === undefined, r.data);
        check('S13-14. no departmentAccountStatus',      r.data.departmentAccountStatus === undefined, r.data);
        // Legacy user can load depts normally
        r = await api(tokLegacy, 'GET', '/api/departments');
        check('S13-15. legacy user gets departments',    r.status === 200 && r.data.success, r.data);

        // ── 5. SUSPENDED account → no redirect ───────────────────────────────
        console.log('\n  — 5. SUSPENDED → no redirect —\n');
        r = await api(tokSusp, 'GET', '/api/service/identity');
        check('S13-16. identity → 200 for suspended',   r.status === 200, r.status);
        check('S13-17. departmentAccountStatus SUSPENDED',
            r.data.departmentAccountStatus === 'SUSPENDED', r.data.departmentAccountStatus);
        // home.html: presence of departmentAccountId + SUSPENDED → show message, no redirect
        check('S13-18. departmentAccountId still present (suspend renders notice)',
            !!r.data.departmentAccountId, r.data.departmentAccountId);
        check('S13-19. departmentId present (for display)', !!r.data.departmentId, r.data.departmentId);

        // ── 6. Missing / inactive dept → no redirect ─────────────────────────
        console.log('\n  — 6. inactive assigned dept → redirect blocked —\n');
        // Bind uid-inact to pantry account, then deactivate the pantry department
        const tokInact = sign('uid-inact', 'restaurant-co');
        r = await bindAccount(tokInact, 'pantry.s13');
        check('S13-20. uid-inact bound to pantry', r.data.success === true, r.data);

        // Deactivate the pantry department
        r = await api(tokAdmin, 'PUT', `/api/departments/${deptInactId}`, { active: false });
        // (department deactivation API — check it works)
        const isDeactivated = r.status === 200 || r.status === 204;
        // If the endpoint doesn't exist, just mark the dept inactive via a known path
        if (!isDeactivated) {
            // Fallback: verify via identity that the dept id still resolves but is not in active list
            const identityR = await api(tokInact, 'GET', '/api/service/identity');
            const deptsR    = await api(tokInact, 'GET', '/api/departments');
            const activeList = (deptsR.data.departments || []).filter(d => d.active);
            const inDeptsActive = activeList.some(d => d.id === deptInactId);
            check('S13-21. pantry dept deactivated or always distinguishable',
                !inDeptsActive || !!identityR.data.departmentId, { deactivated: !inDeptsActive });
        } else {
            check('S13-21. pantry dept deactivated', true);
        }

        // Identity still resolves dept — it's the active-dept cross-check in home.html that blocks redirect
        const identityR = await api(tokInact, 'GET', '/api/service/identity');
        const deptsR    = await api(tokInact, 'GET', '/api/departments');
        const activeDeptIds = (deptsR.data.departments || []).filter(d => d.active).map(d => d.id);
        check('S13-22. identity has departmentId',  !!identityR.data.departmentId, identityR.data.departmentId);
        check('S13-23. pantry NOT in active list (home.html blocks redirect)',
            !activeDeptIds.includes(identityR.data.departmentId),
            { departmentId: identityR.data.departmentId, activeDeptIds });

        // ── 7. localStorage cannot influence routing ──────────────────────────
        console.log('\n  — 7. localStorage values ignored by server —\n');
        // The server derives departmentId from the account record, not from any
        // client-submitted value. Sending a fake departmentId in the query or body is ignored.
        r = await api(tokBound, 'GET', '/api/service/identity?departmentId=fake-dept-id');
        check('S13-24. query departmentId ignored', r.data.departmentId === deptKitchenId, r.data.departmentId);

        r = await api(tokBound, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'kitchen.s13',
            departmentId: 'injected-dept-id'  // must be ignored
        });
        // The response still shows the real account with the real departmentId from the store
        const accountDeptId = r.data.account?.departmentId;
        check('S13-25. body departmentId injection rejected', accountDeptId === deptKitchenId, accountDeptId);

        // ── 8. Company cannot be influenced by client ─────────────────────────
        console.log('\n  — 8. company always from session —\n');
        // other-co user cannot access restaurant-co identity
        r = await api(tokOtherCo, 'GET', '/api/service/identity');
        check('S13-26. other-co sees their own dept (not restaurant-co)',
            r.data.departmentId === deptOtherCoId, r.data.departmentId);
        check('S13-27. departmentId is not kitchen (company isolation)',
            r.data.departmentId !== deptKitchenId, r.data.departmentId);

        // Trying to call /api/departments for other-co returns only other-co's depts
        r = await api(tokOtherCo, 'GET', '/api/departments');
        const otherCoActive = (r.data.departments || []).filter(d => d.active).map(d => d.id);
        check('S13-28. other-co sees only its own departments',
            !otherCoActive.includes(deptKitchenId) && !otherCoActive.includes(deptBarId),
            otherCoActive);

        // ── 9. Department.html server behavior unchanged ──────────────────────
        console.log('\n  — 9. department.html server behavior unchanged —\n');
        // department.html uses ?id=<deptId>; the server has no route for it
        // (it's a static HTML file). Verify static file serving still works.
        const htmlRes = await fetch(`${BASE}/department.html`);
        check('S13-29. department.html served (200 or 304)', htmlRes.ok, htmlRes.status);

        // The /api/departments endpoint still lists active depts for the dept page
        r = await api(tokBound, 'GET', '/api/departments');
        check('S13-30. /api/departments still returns data', r.data.success === true, r.data);

        // ── 10. S1.2 regression: bind and identity still work ─────────────────
        console.log('\n  — 10. S1.2 regression —\n');
        r = await api(tokBound, 'GET', '/api/service/identity');
        check('S13-31. S1.2 identity still works',   r.status === 200, r.status);
        check('S13-32. departmentAccountId present',  !!r.data.departmentAccountId, r.data);
        check('S13-33. departmentType present',       !!r.data.departmentType, r.data.departmentType);

        // Duplicate bind still idempotent
        r = await api(tokBound, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'kitchen.s13'
        });
        check('S13-34. idempotent rebind still 200',  r.status === 200, r.status);

        // ── 11. S1.1 regression: management endpoints unchanged ───────────────
        console.log('\n  — 11. S1.1 regression —\n');
        r = await api(tokAdmin, 'GET', '/api/department-accounts');
        check('S13-35. list dept accounts → 200',  r.status === 200, r.status);
        check('S13-36. success:true',              r.data.success === true, r.data);

        r = await api(tokAdmin, 'GET', '/api/departments');
        check('S13-37. list departments → 200',    r.status === 200, r.status);

        // ── 12. Auth guards ───────────────────────────────────────────────────
        console.log('\n  — 12. auth guards —\n');
        r = await api(null, 'GET', '/api/service/identity');
        check('S13-38. identity requires auth → 401', r.status === 401, r.status);

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
