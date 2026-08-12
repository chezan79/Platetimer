// tests/service-calendar-central.test.js — Task 33: Central Department calendar access
//
// Verifies:
//  • CENTRAL Department Account (service login) can list/view/create calendar events
//  • Company scoping: CENTRAL of Company A never sees Company B data
//  • STANDARD Department Accounts are refused (403 CALENDAR_NOT_ALLOWED)
//  • SUSPENDED accounts are refused (403 ACCOUNT_SUSPENDED)
//  • Unbound legacy/admin sessions keep full calendar access (unchanged)
//
// Run: node tests/service-calendar-central.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET   = 'test-secret-for-t33-suite';
const PORT     = 5090;
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 't33test-'));

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
        method, headers, body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ' — got: ' + JSON.stringify(extra) : ''}`); }
}

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
            if (d.toString().includes('avviato')) { clearTimeout(t); resolve(server); }
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

async function serviceLogin(loginIdentifier, password) {
    const r = await api(null, 'POST', '/api/service/login', { loginIdentifier, password });
    return r;
}

const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running T33 checks…\n');

    try {
        const tokAdminA = sign('uid-admin-a', 'ristorante');
        const tokAdminB = sign('uid-admin-b', 'other-co');

        // ── Setup ────────────────────────────────────────────────────────────
        console.log('  — setup —\n');
        let r = await api(tokAdminA, 'POST', '/api/departments', { name: 'Centrale' });
        const centralDeptId = r.data?.department?.id;
        r = await api(tokAdminA, 'POST', '/api/departments', { name: 'Kitchen' });
        const kitchenDeptId = r.data?.department?.id;
        r = await api(tokAdminA, 'POST', '/api/departments', { name: 'Bar' });
        const barDeptId = r.data?.department?.id;
        check('Setup: three depts created', !!centralDeptId && !!kitchenDeptId && !!barDeptId);

        r = await api(tokAdminA, 'PUT', `/api/departments/${centralDeptId}/type`, { departmentType: 'CENTRAL' });
        check('Setup: central dept typed CENTRAL', r.status === 200, r);

        r = await api(tokAdminA, 'POST', '/api/department-accounts', {
            departmentId: centralDeptId, displayName: 'Centrale', loginIdentifier: 'central.t33', password: 'pw-central'
        });
        const centralAcct = r.data?.account;
        r = await api(tokAdminA, 'POST', '/api/department-accounts', {
            departmentId: kitchenDeptId, displayName: 'Kitchen', loginIdentifier: 'kitchen.t33', password: 'pw-kitchen'
        });
        const kitchenAcct = r.data?.account;
        r = await api(tokAdminA, 'POST', '/api/department-accounts', {
            departmentId: barDeptId, displayName: 'Bar', loginIdentifier: 'bar.t33', password: 'pw-bar'
        });
        const barAcct = r.data?.account;
        check('Setup: three accounts created', !!centralAcct?.id && !!kitchenAcct?.id && !!barAcct?.id);

        // Company B: central dept + account + one event
        r = await api(tokAdminB, 'POST', '/api/departments', { name: 'CentraleB' });
        const centralBDeptId = r.data?.department?.id;
        r = await api(tokAdminB, 'PUT', `/api/departments/${centralBDeptId}/type`, { departmentType: 'CENTRAL' });
        r = await api(tokAdminB, 'POST', '/api/department-accounts', {
            departmentId: centralBDeptId, displayName: 'CentraleB', loginIdentifier: 'centralb.t33', password: 'pw-centralb'
        });
        r = await api(tokAdminB, 'POST', '/api/calendar/events', {
            title: 'B Company Secret Event', date: TODAY, startTime: '12:00', eventType: 'other'
        });
        const eventB = r.data?.event;
        check('Setup: company B event created by admin B', r.status === 201 && !!eventB?.id, r);

        // ── 1. Service login as CENTRAL account ─────────────────────────────
        console.log('\n  — 1. CENTRAL service login + identity —\n');
        r = await serviceLogin('central.t33', 'pw-central');
        check('T33-1.  central service login 200', r.status === 200 && !!r.data.token, r);
        const tokCentral = r.data.token;

        r = await api(tokCentral, 'GET', '/api/service/department');
        check('T33-2.  /api/service/department → CENTRAL', r.data.departmentType === 'CENTRAL', r.data);

        // ── 2. CENTRAL can use calendar ──────────────────────────────────────
        console.log('\n  — 2. CENTRAL calendar access —\n');
        r = await api(tokCentral, 'GET', '/api/calendar/events');
        check('T33-3.  list events 200', r.status === 200 && r.data.success === true, r);
        check('T33-4.  list does NOT contain company B event',
            !(r.data.events || []).some(e => e.title === 'B Company Secret Event'), r.data.events);

        r = await api(tokCentral, 'POST', '/api/calendar/events', {
            title: 'Central Created Event', date: TODAY, startTime: '18:00', eventType: 'other'
        });
        check('T33-5.  create event 201', r.status === 201 && !!r.data.event?.id, r);
        const eventA = r.data.event;

        r = await api(tokCentral, 'GET', `/api/calendar/events/${eventA.id}`);
        check('T33-6.  view own event 200', r.status === 200 && r.data.event?.id === eventA.id, r);

        r = await api(tokCentral, 'PUT', `/api/calendar/events/${eventA.id}`, { title: 'Central Edited Event' });
        check('T33-7.  edit own event 200', r.status === 200 && r.data.event?.title === 'Central Edited Event', r);

        r = await api(tokCentral, 'GET', '/api/calendar/events/upcoming');
        check('T33-8.  upcoming 200', r.status === 200 && r.data.success === true, r.status);

        r = await api(tokCentral, 'GET', '/api/calendar/notifications');
        check('T33-9.  notifications 200', r.status === 200 && r.data.success === true, r.status);

        // ── 3. Cross-company isolation ───────────────────────────────────────
        console.log('\n  — 3. cross-company isolation —\n');
        r = await api(tokCentral, 'GET', `/api/calendar/events/${eventB.id}`);
        check('T33-10. direct GET of B event → 404', r.status === 404, r.status);
        r = await api(tokCentral, 'PUT', `/api/calendar/events/${eventB.id}`, { title: 'hacked' });
        check('T33-11. PUT B event → 404', r.status === 404, r.status);
        r = await api(tokCentral, 'DELETE', `/api/calendar/events/${eventB.id}`);
        check('T33-12. DELETE B event → 404', r.status === 404, r.status);

        // Company B central still sees ONLY its own event
        r = await serviceLogin('centralb.t33', 'pw-centralb');
        const tokCentralB = r.data.token;
        r = await api(tokCentralB, 'GET', '/api/calendar/events');
        check('T33-13. central B sees own event only',
            (r.data.events || []).some(e => e.title === 'B Company Secret Event') &&
            !(r.data.events || []).some(e => e.title === 'Central Edited Event'), r.data.events);

        // Forged company query param has no effect
        r = await api(tokCentral, 'GET', '/api/calendar/events?company=other-co');
        check('T33-14. forged company query ignored',
            !(r.data.events || []).some(e => e.title === 'B Company Secret Event'), r.data.events);

        // ── 4. STANDARD account refused ──────────────────────────────────────
        console.log('\n  — 4. STANDARD account refused —\n');
        r = await serviceLogin('kitchen.t33', 'pw-kitchen');
        const tokKitchen = r.data.token;
        check('T33-15. kitchen login ok', !!tokKitchen);
        r = await api(tokKitchen, 'GET', '/api/calendar/events');
        check('T33-16. STANDARD list → 403 CALENDAR_NOT_ALLOWED', r.status === 403 && r.data.code === 'CALENDAR_NOT_ALLOWED', r);
        r = await api(tokKitchen, 'POST', '/api/calendar/events', { title: 'x', date: TODAY, eventType: 'other' });
        check('T33-17. STANDARD create → 403', r.status === 403, r.status);
        r = await api(tokKitchen, 'GET', '/api/calendar/notifications');
        check('T33-18. STANDARD notifications → 403', r.status === 403, r.status);

        // ── 5. SUSPENDED account refused ─────────────────────────────────────
        console.log('\n  — 5. SUSPENDED account refused —\n');
        r = await serviceLogin('bar.t33', 'pw-bar');
        const tokBar = r.data.token; // login while ACTIVE, then suspend
        r = await api(tokAdminA, 'PUT', `/api/department-accounts/${barAcct.id}/status`, { status: 'SUSPENDED' });
        check('T33-19. bar account suspended', r.data.success === true, r.data);
        r = await api(tokBar, 'GET', '/api/calendar/events');
        check('T33-20. SUSPENDED list → 403 ACCOUNT_SUSPENDED', r.status === 403 && r.data.code === 'ACCOUNT_SUSPENDED', r);

        // ── 6. Unbound admin/legacy sessions unchanged ───────────────────────
        console.log('\n  — 6. legacy sessions unchanged —\n');
        r = await api(tokAdminA, 'GET', '/api/calendar/events');
        check('T33-21. admin list 200', r.status === 200 && r.data.success === true, r.status);
        r = await api(tokAdminA, 'POST', '/api/calendar/events', { title: 'Admin Event', date: TODAY, eventType: 'other' });
        check('T33-22. admin create 201', r.status === 201, r.status);
        r = await api(null, 'GET', '/api/calendar/events');
        check('T33-23. no token → 401', r.status === 401, r.status);

        // CENTRAL deletes its own event — still allowed
        r = await api(tokCentral, 'DELETE', `/api/calendar/events/${eventA.id}`);
        check('T33-24. central delete own event 200', r.status === 200, r.status);

    } catch (err) {
        failed++;
        console.error('FATAL:', err);
    } finally {
        await stopServer(server);
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main();
