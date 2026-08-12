// tests/countdown-destinations.test.js — Task 39: Restore countdown destination
// selection for department accounts.
//
// The countdown launcher on department.html now builds its destination list from
// GET /api/voice-recipients (all ACTIVE company departments, server-resolved company)
// instead of the S1.4-locked GET /api/departments. This test verifies the full
// server-side contract behind that flow:
//
//  1. STANDARD bound account: /api/voice-recipients lists all other active depts
//  2. CENTRAL bound account: same
//  3. Inactive departments excluded; cross-company isolation (A never sees B)
//  4. startCountdown (WS) from a bound account accepts sibling active departments
//     as multi-destination and broadcasts to each selected destination screen
//     (respecting ws.boundDepartmentId delivery filtering)
//  5. startCountdown still rejects foreign/inactive destinations and still
//     requires the bound department to be included (S1.5 unchanged)
//  6. S1.4 locking unchanged: bound /api/departments returns only own dept
//
// Run: node tests/countdown-destinations.test.js

const { spawn } = require('child_process');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

const SECRET   = 'test-secret-countdown-dests';
const PORT     = 5090;
const BASE     = `http://127.0.0.1:${PORT}`;
const WS_URL   = `ws://127.0.0.1:${PORT}/ws`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cddest-'));

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

// ── WS helpers (same consume-semantics pattern as service-s1-5) ──────────────
function openWs() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        const msgs = [];
        const waiters = [];
        ws.on('message', raw => {
            const msg = JSON.parse(raw);
            const idx = waiters.findIndex(w => w.pred(msg));
            if (idx !== -1) waiters.splice(idx, 1)[0].resolve(msg);
            else msgs.push(msg);
        });
        ws.waitFor = (pred, timeout = 2000) => new Promise((res, rej) => {
            const existing = msgs.findIndex(pred);
            if (existing !== -1) { res(msgs.splice(existing, 1)[0]); return; }
            const t = setTimeout(() => rej(new Error('waitFor timeout')), timeout);
            waiters.push({ pred, resolve: m => { clearTimeout(t); res(m); } });
        });
        ws.notReceived = (pred, timeout = 400) => new Promise(res => {
            const existing = msgs.findIndex(pred);
            if (existing !== -1) { msgs.splice(existing, 1); res(false); return; }
            let fired = false;
            const t = setTimeout(() => { if (!fired) res(true); }, timeout);
            waiters.push({ pred, resolve: () => { fired = true; clearTimeout(t); res(false); } });
        });
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

async function joinRoom(ws, token, pageType) {
    ws.send(JSON.stringify({ action: 'joinRoom', token }));
    await new Promise(r => setTimeout(r, 100));
    if (pageType) {
        ws.send(JSON.stringify({ action: 'joinPage', pageType }));
        await new Promise(r => setTimeout(r, 100));
    }
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

async function createDept(token, name) {
    const r = await api(token, 'POST', '/api/departments', { name });
    return r.data?.department?.id;
}

async function main() {
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({ ristorante: 'medium' }));

    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running countdown-destinations checks…\n');
    const sockets = [];

    try {
        const tokAdmin   = sign('uid-admin',   'ristorante');
        const tokPizza   = sign('uid-pizza',   'ristorante');  // STANDARD bound
        const tokCentral = sign('uid-central', 'ristorante');  // CENTRAL bound
        const tokAdminB  = sign('uid-adminB',  'other-co');
        const tokLegacyB = sign('uid-legacyB', 'other-co');

        // ── Setup ─────────────────────────────────────────────────────────────
        const cucina   = await createDept(tokAdmin, 'Cucina');
        const pizzeria = await createDept(tokAdmin, 'Pizzeria');
        const bar      = await createDept(tokAdmin, 'Bar');
        const passe    = await createDept(tokAdmin, 'Passe');      // becomes CENTRAL
        const doomed   = await createDept(tokAdmin, 'Doomed');     // deactivated below
        const foreignD = await createDept(tokAdminB, 'ForeignDept');
        check('Setup: departments created', !!(cucina && pizzeria && bar && passe && doomed && foreignD));

        let r = await api(tokAdmin, 'PUT', `/api/departments/${passe}/type`, { departmentType: 'CENTRAL' });
        check('Setup: Passe set CENTRAL', r.data.success === true, r.data);

        r = await api(tokAdmin, 'POST', '/api/department-accounts', {
            departmentId: pizzeria, displayName: 'Pizza Acct', loginIdentifier: 'pizza.cdd' });
        check('Setup: STANDARD account created', r.data?.account?.id != null, r.data);
        r = await api(tokAdmin, 'POST', '/api/department-accounts', {
            departmentId: passe, displayName: 'Passe Acct', loginIdentifier: 'passe.cdd' });
        check('Setup: CENTRAL account created', r.data?.account?.id != null, r.data);

        r = await api(tokPizza, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'pizza.cdd' });
        check('Setup: pizza bound', r.data.success === true, r.data);
        r = await api(tokCentral, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'passe.cdd' });
        check('Setup: central bound', r.data.success === true, r.data);

        r = await api(tokAdmin, 'PUT', `/api/departments/${doomed}`, { active: false });
        check('Setup: Doomed deactivated', r.data.success === true, r.data);

        // ── 1. STANDARD bound account sees sibling active departments ────────
        r = await api(tokPizza, 'GET', '/api/voice-recipients');
        let ids = (r.data.recipients || []).map(x => x.id);
        check('1. STANDARD bound: 200 + success', r.status === 200 && r.data.success === true, r);
        check('1. Lists all active company depts', [cucina, pizzeria, bar, passe].every(id => ids.includes(id)), ids);
        check('1. Excludes inactive dept', !ids.includes(doomed), ids);
        check('1. Excludes foreign dept', !ids.includes(foreignD), ids);
        check('1. Excluding self leaves 3 destinations',
            ids.filter(id => id !== pizzeria).length === 3, ids);

        // ── 2. CENTRAL bound account likewise ────────────────────────────────
        r = await api(tokCentral, 'GET', '/api/voice-recipients');
        ids = (r.data.recipients || []).map(x => x.id);
        check('2. CENTRAL bound: 200 + success', r.status === 200 && r.data.success === true, r);
        check('2. Lists all active company depts', [cucina, pizzeria, bar, passe].every(id => ids.includes(id)), ids);
        check('2. Excludes inactive + foreign', !ids.includes(doomed) && !ids.includes(foreignD), ids);

        // ── 3. Cross-company isolation from Company B side ────────────────────
        r = await api(tokLegacyB, 'GET', '/api/voice-recipients');
        ids = (r.data.recipients || []).map(x => x.id);
        check('3. Company B never sees Company A depts',
            ids.includes(foreignD) && ![cucina, pizzeria, bar, passe, doomed].some(id => ids.includes(id)), ids);

        // ── 4. Multi-destination startCountdown from bound STANDARD account ──
        const wsPizza   = await openWs(); sockets.push(wsPizza);
        const wsCucina  = await openWs(); sockets.push(wsCucina);
        const wsBar     = await openWs(); sockets.push(wsBar);
        const wsForeign = await openWs(); sockets.push(wsForeign);
        await joinRoom(wsPizza, tokPizza);                    // bound → auto-locked to pizzeria
        await joinRoom(wsCucina, sign('uid-legacy1', 'ristorante'), cucina);
        await joinRoom(wsBar,    sign('uid-legacy2', 'ristorante'), bar);
        await joinRoom(wsForeign, tokLegacyB, foreignD);

        wsPizza.send(JSON.stringify({
            action: 'startCountdown', tableNumber: '7', timeRemaining: 300,
            destinations: [cucina, bar, pizzeria]
        }));
        let m = await wsPizza.waitFor(x => x.action === 'startCountdown' && x.tableNumber === '7');
        check('4. Sender (bound) receives echo', !!m, m);
        m = await wsCucina.waitFor(x => x.action === 'startCountdown' && x.tableNumber === '7');
        check('4. Destination Cucina receives countdown', Array.isArray(m.destinations) && m.destinations.includes(cucina), m);
        m = await wsBar.waitFor(x => x.action === 'startCountdown' && x.tableNumber === '7');
        check('4. Destination Bar receives countdown', !!m, m);
        check('4. Company B socket does NOT receive it',
            await wsForeign.notReceived(x => x.action === 'startCountdown' && x.tableNumber === '7'));

        // CENTRAL bound account can also start a sibling-destination countdown
        const wsCentral = await openWs(); sockets.push(wsCentral);
        await joinRoom(wsCentral, tokCentral);
        wsCentral.send(JSON.stringify({
            action: 'startCountdown', tableNumber: '8', timeRemaining: 240,
            destinations: [cucina, passe]
        }));
        m = await wsCucina.waitFor(x => x.action === 'startCountdown' && x.tableNumber === '8');
        check('4. CENTRAL bound multi-dest reaches sibling dept', !!m, m);

        // ── 5. Invalid destinations still rejected ────────────────────────────
        wsPizza.send(JSON.stringify({
            action: 'startCountdown', tableNumber: '9', timeRemaining: 300,
            destinations: [foreignD, pizzeria]
        }));
        m = await wsPizza.waitFor(x => x.action === 'error', 1500);
        check('5. Foreign destination rejected', !!m, m);
        wsPizza.send(JSON.stringify({
            action: 'startCountdown', tableNumber: '10', timeRemaining: 300,
            destinations: [doomed, pizzeria]
        }));
        m = await wsPizza.waitFor(x => x.action === 'error', 1500);
        check('5. Inactive destination rejected', !!m, m);
        wsPizza.send(JSON.stringify({
            action: 'startCountdown', tableNumber: '11', timeRemaining: 300,
            destinations: [cucina]   // own dept missing
        }));
        m = await wsPizza.waitFor(x => x.action === 'error' && x.code === 'DEPT_NOT_IN_DESTINATIONS', 1500);
        check('5. Bound dept must be included (S1.5 unchanged)', !!m, m);

        // ── 6. S1.4 /api/departments locking unchanged ────────────────────────
        r = await api(tokPizza, 'GET', '/api/departments');
        check('6. Bound /api/departments returns ONLY own dept',
            r.status === 200 && r.data.departments?.length === 1 &&
            r.data.departments[0].id === pizzeria, r.data.departments);

    } catch (err) {
        failed++;
        console.error('  ❌ Unhandled test error:', err);
    } finally {
        sockets.forEach(s => { try { s.close(); } catch {} });
        await stopServer(server);
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\ncountdown-destinations: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
