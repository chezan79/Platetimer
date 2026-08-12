/**
 * tests/department-type.test.js
 * Department type (STANDARD ↔ CENTRAL) configuration.
 * Covers all 11 required scenarios from the task spec.
 */
'use strict';

const { spawn } = require('child_process');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const SECRET   = 'test-secret-dept-type-suite';
const PORT     = 5085;
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'depttype-'));

// ── HMAC session token ────────────────────────────────────────────────────────
function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

// Service-login token (uid = depacct_…)
function signService(acctId, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid: acctId, companyName, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function api(token, method, p, body) {
    const res = await fetch(BASE + p, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body != null ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else       { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

// ── Server lifecycle ──────────────────────────────────────────────────────────
function startServer(extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const s = spawn('node', ['server.js'], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                PORT: String(PORT),
                WS_SESSION_SECRET: SECRET,
                DATA_DIR,
                FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
                SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
                MOCK_FIREBASE_STORAGE: '1',
                ...extraEnv,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        s.stderr.on('data', () => {});
        const t = setTimeout(() => reject(new Error('server start timeout')), 20_000);
        s.stdout.on('data', d => {
            if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(s); }
        });
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('Starting server (department-type tests)…');
    const server = await startServer();
    console.log('Server up. Running checks…\n');

    try {
        const adminA = sign('uid-dta-adminA', 'depttype-co-a');
        const adminB = sign('uid-dta-adminB', 'depttype-co-b');

        // ── Bootstrap ─────────────────────────────────────────────────────────
        // Load departments for company A (bootstraps via /api/departments)
        let r;

        // Create two departments in company A
        r = await api(adminA, 'POST', '/api/departments', { name: 'Cucina' });
        const deptCucinaId = r.data.department && r.data.department.id;
        check('Setup: Cucina created', r.status === 201 && deptCucinaId, r);

        r = await api(adminA, 'POST', '/api/departments', { name: 'Pizzeria' });
        const deptPizzeriaId = r.data.department && r.data.department.id;
        check('Setup: Pizzeria created', r.status === 201 && deptPizzeriaId, r);

        // Create department account for Cucina (to test service-session restriction)
        r = await api(adminA, 'POST', '/api/department-accounts', {
            departmentId: deptCucinaId, loginIdentifier: 'cucina', password: 'cucina123'
        });
        const cucinaAcctId = r.data.account && r.data.account.id;
        check('Setup: Cucina account created', r.status === 201 && cucinaAcctId, r);

        // Create one department in company B
        r = await api(adminB, 'POST', '/api/departments', { name: 'Bar' });
        const deptBarId = r.data.department && r.data.department.id;
        check('Setup: Bar (co-B) created', r.status === 201 && deptBarId, r);

        // ─────────────────────────────────────────────────────────────────────
        // T1. Admin can promote own-company department STANDARD → CENTRAL
        // ─────────────────────────────────────────────────────────────────────
        r = await api(adminA, 'PUT', `/api/departments/${deptCucinaId}/type`, { departmentType: 'CENTRAL' });
        check('T1. Admin promotes Cucina to CENTRAL (200)',
            r.status === 200 && r.data.success, { status: r.status, data: r.data });
        check('T1b. Response contains departmentType CENTRAL',
            r.data.department && r.data.department.departmentType === 'CENTRAL',
            r.data.department && r.data.department.departmentType);

        // ─────────────────────────────────────────────────────────────────────
        // T2. Persisted department returns CENTRAL on subsequent GET
        // ─────────────────────────────────────────────────────────────────────
        r = await api(adminA, 'GET', '/api/departments');
        const cucina = (r.data.departments || []).find(d => d.id === deptCucinaId);
        check('T2. GET /api/departments reflects CENTRAL',
            cucina && cucina.departmentType === 'CENTRAL',
            cucina && cucina.departmentType);

        // ─────────────────────────────────────────────────────────────────────
        // T3. Bound service account then receives departmentType CENTRAL
        // ─────────────────────────────────────────────────────────────────────
        const serviceToken = signService(cucinaAcctId, 'depttype-co-a');
        r = await api(serviceToken, 'GET', '/api/service/department');
        check('T3. GET /api/service/department returns CENTRAL for bound account',
            r.status === 200 && r.data.success && r.data.departmentType === 'CENTRAL',
            { status: r.status, type: r.data.departmentType });

        // ─────────────────────────────────────────────────────────────────────
        // T4. CENTRAL account gains Calendar API access
        // ─────────────────────────────────────────────────────────────────────
        r = await api(serviceToken, 'GET', '/api/calendar/events');
        check('T4. Calendar API allows CENTRAL account (200)',
            r.status === 200, { status: r.status, data: r.data });

        // ─────────────────────────────────────────────────────────────────────
        // T5. Admin can demote CENTRAL → STANDARD
        // ─────────────────────────────────────────────────────────────────────
        r = await api(adminA, 'PUT', `/api/departments/${deptCucinaId}/type`, { departmentType: 'STANDARD' });
        check('T5. Admin demotes Cucina to STANDARD (200)',
            r.status === 200 && r.data.success, { status: r.status });
        check('T5b. Response contains departmentType STANDARD',
            r.data.department && r.data.department.departmentType === 'STANDARD',
            r.data.department && r.data.department.departmentType);

        // ─────────────────────────────────────────────────────────────────────
        // T6. Demoted service account loses Calendar access
        // ─────────────────────────────────────────────────────────────────────
        r = await api(serviceToken, 'GET', '/api/calendar/events');
        check('T6. Calendar API rejects STANDARD account (403)',
            r.status === 403 && r.data.code === 'CALENDAR_NOT_ALLOWED',
            { status: r.status, code: r.data.code });

        // Also verify GET /api/service/department now returns STANDARD
        r = await api(serviceToken, 'GET', '/api/service/department');
        check('T6b. GET /api/service/department returns STANDARD after demotion',
            r.status === 200 && r.data.departmentType === 'STANDARD',
            { type: r.data.departmentType });

        // ─────────────────────────────────────────────────────────────────────
        // T7. Department service account cannot change its own type
        // ─────────────────────────────────────────────────────────────────────
        r = await api(serviceToken, 'PUT', `/api/departments/${deptCucinaId}/type`, { departmentType: 'CENTRAL' });
        check('T7. Service account gets 403 on type change',
            r.status === 403, { status: r.status });
        // Cucina must still be STANDARD
        const list7 = await api(adminA, 'GET', '/api/departments');
        const cucina7 = (list7.data.departments || []).find(d => d.id === deptCucinaId);
        check('T7b. Cucina remains STANDARD after rejected service-account attempt',
            cucina7 && (cucina7.departmentType === 'STANDARD' || !cucina7.departmentType),
            cucina7 && cucina7.departmentType);

        // ─────────────────────────────────────────────────────────────────────
        // T8. Company A admin cannot modify Company B department type
        // ─────────────────────────────────────────────────────────────────────
        r = await api(adminA, 'PUT', `/api/departments/${deptBarId}/type`, { departmentType: 'CENTRAL' });
        check('T8. Company A admin cannot set type on Company B dept (404)',
            r.status === 404, { status: r.status, data: r.data });
        // Bar must still be STANDARD in company B
        const listB = await api(adminB, 'GET', '/api/departments');
        const bar = (listB.data.departments || []).find(d => d.id === deptBarId);
        check('T8b. Bar remains STANDARD in Company B',
            bar && (bar.departmentType === 'STANDARD' || !bar.departmentType),
            bar && bar.departmentType);

        // ─────────────────────────────────────────────────────────────────────
        // T9. Missing departmentType defaults to STANDARD
        // ─────────────────────────────────────────────────────────────────────
        // Pizzeria was never explicitly typed — it should default to STANDARD
        const listDef = await api(adminA, 'GET', '/api/departments');
        const pizzeria = (listDef.data.departments || []).find(d => d.id === deptPizzeriaId);
        check('T9. Pizzeria (never typed) defaults to STANDARD',
            pizzeria && (pizzeria.departmentType === 'STANDARD' || !pizzeria.departmentType),
            pizzeria && pizzeria.departmentType);

        // ─────────────────────────────────────────────────────────────────────
        // T10a. Central uniqueness: only one CENTRAL per company
        // ─────────────────────────────────────────────────────────────────────
        // Promote Cucina to CENTRAL
        await api(adminA, 'PUT', `/api/departments/${deptCucinaId}/type`, { departmentType: 'CENTRAL' });
        // Try to promote Pizzeria to CENTRAL while Cucina is already CENTRAL
        r = await api(adminA, 'PUT', `/api/departments/${deptPizzeriaId}/type`, { departmentType: 'CENTRAL' });
        check('T10a. Promoting second dept to CENTRAL returns 409',
            r.status === 409, { status: r.status, error: r.data.error });

        // Cucina must still be the CENTRAL
        const list10 = await api(adminA, 'GET', '/api/departments');
        const cucina10  = (list10.data.departments || []).find(d => d.id === deptCucinaId);
        const pizzeria10 = (list10.data.departments || []).find(d => d.id === deptPizzeriaId);
        check('T10b. Cucina remains CENTRAL after rejected Pizzeria promotion',
            cucina10 && cucina10.departmentType === 'CENTRAL',
            cucina10 && cucina10.departmentType);
        check('T10c. Pizzeria remains STANDARD after rejected promotion',
            pizzeria10 && (pizzeria10.departmentType === 'STANDARD' || !pizzeria10.departmentType),
            pizzeria10 && pizzeria10.departmentType);

        // T10d. Replacement flow: demote Cucina first, then promote Pizzeria
        await api(adminA, 'PUT', `/api/departments/${deptCucinaId}/type`, { departmentType: 'STANDARD' });
        r = await api(adminA, 'PUT', `/api/departments/${deptPizzeriaId}/type`, { departmentType: 'CENTRAL' });
        check('T10d. After demotion, Pizzeria can become CENTRAL (200)',
            r.status === 200 && r.data.success, { status: r.status });

        const list10d = await api(adminA, 'GET', '/api/departments');
        const cucina10d   = (list10d.data.departments || []).find(d => d.id === deptCucinaId);
        const pizzeria10d = (list10d.data.departments || []).find(d => d.id === deptPizzeriaId);
        check('T10e. Cucina is STANDARD after replacement',
            cucina10d && (cucina10d.departmentType === 'STANDARD' || !cucina10d.departmentType),
            cucina10d && cucina10d.departmentType);
        check('T10f. Pizzeria is now CENTRAL',
            pizzeria10d && pizzeria10d.departmentType === 'CENTRAL',
            pizzeria10d && pizzeria10d.departmentType);

        // ─────────────────────────────────────────────────────────────────────
        // T11. Change survives server restart (persistence)
        // ─────────────────────────────────────────────────────────────────────
        server.kill();
        await new Promise(r => setTimeout(r, 1_200));

        const server2 = await startServer();
        const list11 = await api(adminA, 'GET', '/api/departments');
        const pizzeria11 = (list11.data.departments || []).find(d => d.id === deptPizzeriaId);
        const cucina11   = (list11.data.departments || []).find(d => d.id === deptCucinaId);
        check('T11a. Pizzeria still CENTRAL after server restart',
            pizzeria11 && pizzeria11.departmentType === 'CENTRAL',
            pizzeria11 && pizzeria11.departmentType);
        check('T11b. Cucina still STANDARD after server restart',
            cucina11 && (cucina11.departmentType === 'STANDARD' || !cucina11.departmentType),
            cucina11 && cucina11.departmentType);
        server2.kill();

    } catch (err) {
        console.error('Fatal error:', err);
        failed++;
    } finally {
        try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    }

    console.log(`\ndepartment-type tests: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
