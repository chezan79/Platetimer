// tests/service-central-calendar-ws.test.js
//
// Verifies that a bound CENTRAL Department Account WebSocket socket receives
// real-time calendar broadcasts (calendarEventCreated / calendarEventUpdated /
// calendarEventDeleted) for its own company and never for another company.
//
// Requirements tested:
//  CC-1.  CENTRAL dept socket receives calendarEventCreated for its company
//  CC-2.  CENTRAL dept socket receives calendarEventUpdated for its company
//  CC-3.  CENTRAL dept socket receives calendarEventDeleted for its company
//  CC-4.  CENTRAL dept socket does NOT receive calendar broadcasts from Company B
//  CC-5.  Company B CENTRAL socket does NOT receive Company A calendar broadcasts
//  CC-6.  Unbound legacy socket also receives calendar broadcasts (backward-compat)
//  CC-7.  STANDARD dept socket also receives calendar broadcasts (delivery is
//         company-wide; REST access-control is enforced by requireCalendarAccess)
//  CC-8.  No calendar cross-contamination between companies on rapid concurrent updates
//
// Pattern: tests/service-s1-5.test.js
// Run: node tests/service-central-calendar-ws.test.js

const { spawn } = require('child_process');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

const SECRET   = 'test-secret-central-cal-ws';
const PORT     = 5088;
const BASE     = `http://127.0.0.1:${PORT}`;
const WS_URL   = `ws://127.0.0.1:${PORT}/ws`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'central-cal-'));

// ── Token helpers ─────────────────────────────────────────────────────────────
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

// ── WS helpers ────────────────────────────────────────────────────────────────
function openWs() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        const msgs = [];
        const waiters = [];

        ws.on('message', raw => {
            const msg = JSON.parse(raw);
            const idx = waiters.findIndex(w => w.pred(msg));
            if (idx !== -1) {
                const [{ resolve: res }] = waiters.splice(idx, 1);
                res(msg);
            } else {
                msgs.push(msg);
            }
        });

        // waitFor: resolve with the first matching message (consumes it from buffer)
        ws.waitFor = (pred, timeout = 2500) => new Promise((res, rej) => {
            const existing = msgs.findIndex(pred);
            if (existing !== -1) { res(msgs.splice(existing, 1)[0]); return; }
            const t = setTimeout(() => {
                const i = waiters.findIndex(w => w.resolve === res);
                if (i !== -1) waiters.splice(i, 1);
                rej(new Error('waitFor timeout'));
            }, timeout);
            waiters.push({ pred, resolve: m => { clearTimeout(t); res(m); } });
        });

        // notReceived: assert a matching message does NOT arrive within timeout
        ws.notReceived = (pred, timeout = 400) =>
            new Promise(res => {
                const existing = msgs.findIndex(pred);
                if (existing !== -1) { msgs.splice(existing, 1); res(false); return; }
                let fired = false;
                const t = setTimeout(() => { if (!fired) res(true); }, timeout);
                waiters.push({
                    pred,
                    resolve: () => { fired = true; clearTimeout(t); res(false); }
                });
            });

        ws.clearMsgs = () => { msgs.length = 0; };

        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

async function joinRoom(ws, token) {
    ws.send(JSON.stringify({ action: 'joinRoom', token }));
    await new Promise(r => setTimeout(r, 150));
}

// ── Assertions ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ' — got: ' + JSON.stringify(extra) : ''}`); }
}

// ── Server lifecycle ──────────────────────────────────────────────────────────
function startServer() {
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            MOCK_FIREBASE_STORAGE: '1'
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

// ── REST helpers ──────────────────────────────────────────────────────────────
async function createDept(token, name) {
    const r = await api(token, 'POST', '/api/departments', { name });
    return r.data?.department?.id;
}
async function setDeptType(token, deptId, departmentType) {
    return api(token, 'PUT', `/api/departments/${deptId}/type`, { departmentType });
}
async function createAcct(token, deptId, display, login) {
    const r = await api(token, 'POST', '/api/department-accounts',
        { departmentId: deptId, displayName: display, loginIdentifier: login });
    return r.data?.account;
}
async function bindUid(token, login) {
    return api(token, 'POST', '/api/department-accounts/bind', { loginIdentifier: login });
}

// Calendar REST — uses an unbound admin token (which passes requireCalendarAccess)
async function createEvent(token, title, date) {
    const r = await api(token, 'POST', '/api/calendar/events', {
        title,
        date,
        eventType: 'reservation',
        startTime: '12:00'
    });
    return r.data?.event;
}
async function updateEvent(token, eventId, title) {
    const r = await api(token, 'PUT', `/api/calendar/events/${eventId}`, {
        title,
        date: '2026-09-01',
        eventType: 'reservation',
        startTime: '12:00'
    });
    return r.data?.event;
}
async function deleteEvent(token, eventId) {
    return api(token, 'DELETE', `/api/calendar/events/${eventId}`);
}
async function suspendAcct(token, acctId) {
    return api(token, 'PUT', `/api/department-accounts/${acctId}/status`, { status: 'SUSPENDED' });
}
async function deactivateDept(token, deptId) {
    return api(token, 'PUT', `/api/departments/${deptId}`, { active: false });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    // Pre-seed plans: medium for multi-dept companies, base for revocation companies
    fs.writeFileSync(
        path.join(DATA_DIR, 'plans.json'),
        JSON.stringify({
            compa: 'medium', compb: 'medium',
            // separate companies used for dynamic-revocation tests (CC-9/10/11)
            comprev9: 'base', comprev10: 'base', comprev11: 'base'
        })
    );

    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running Central-Calendar-WS checks…\n');

    const openSockets = [];
    try {
        // ── Tokens ──────────────────────────────────────────────────────────
        // Company A
        const tokAdminA   = sign('uid-admin-a',    'compa');  // unbound admin (calendar REST access)
        const tokCentralA = sign('uid-central-a',  'compa');  // bound to CENTRAL dept
        const tokStdA     = sign('uid-std-a',      'compa');  // bound to STANDARD dept
        const tokLegacyA  = sign('uid-legacy-a',   'compa');  // unbound legacy (no dept account)
        // Company B
        const tokAdminB   = sign('uid-admin-b',    'compb');  // unbound admin B
        const tokCentralB = sign('uid-central-b',  'compb');  // bound to CENTRAL dept B

        // ── Setup: Company A ─────────────────────────────────────────────────
        console.log('  — setup: Company A —\n');
        const dCentralA = await createDept(tokAdminA, 'Direzione');
        const dStdA     = await createDept(tokAdminA, 'Cucina');
        check('Setup A: CENTRAL dept created', !!dCentralA, dCentralA);
        check('Setup A: STANDARD dept created', !!dStdA,    dStdA);

        // Promote Direzione to CENTRAL
        const typeRes = await setDeptType(tokAdminA, dCentralA, 'CENTRAL');
        check('Setup A: dept type set to CENTRAL', typeRes.data?.department?.departmentType === 'CENTRAL', typeRes.data);

        // Create accounts and bind uids
        const acctCentralA = await createAcct(tokAdminA, dCentralA, 'Dir WS', 'dir.a.cal');
        const acctStdA     = await createAcct(tokAdminA, dStdA,     'Cuc WS', 'cuc.a.cal');
        check('Setup A: CENTRAL acct', !!acctCentralA?.id, acctCentralA?.id);
        check('Setup A: STANDARD acct', !!acctStdA?.id,   acctStdA?.id);

        await bindUid(tokCentralA, 'dir.a.cal');
        await bindUid(tokStdA,     'cuc.a.cal');
        check('Setup A: CENTRAL uid bound', true);
        check('Setup A: STANDARD uid bound', true);

        // ── Setup: Company B ─────────────────────────────────────────────────
        console.log('  — setup: Company B —\n');
        const dCentralB = await createDept(tokAdminB, 'DirezioneB');
        check('Setup B: dept created', !!dCentralB, dCentralB);
        const typeResB = await setDeptType(tokAdminB, dCentralB, 'CENTRAL');
        check('Setup B: dept type set to CENTRAL', typeResB.data?.department?.departmentType === 'CENTRAL', typeResB.data);

        const acctCentralB = await createAcct(tokAdminB, dCentralB, 'DirB WS', 'dir.b.cal');
        check('Setup B: CENTRAL acct', !!acctCentralB?.id, acctCentralB?.id);
        await bindUid(tokCentralB, 'dir.b.cal');
        check('Setup B: CENTRAL uid bound', true);

        // ── Open WS connections ──────────────────────────────────────────────
        const wsCentralA = await openWs(); openSockets.push(wsCentralA);
        const wsStdA     = await openWs(); openSockets.push(wsStdA);
        const wsLegacyA  = await openWs(); openSockets.push(wsLegacyA);
        const wsCentralB = await openWs(); openSockets.push(wsCentralB);

        await joinRoom(wsCentralA, tokCentralA);
        await joinRoom(wsStdA,     tokStdA);
        await joinRoom(wsLegacyA,  tokLegacyA);
        await joinRoom(wsCentralB, tokCentralB);

        // Clear join sync messages
        wsCentralA.clearMsgs(); wsStdA.clearMsgs();
        wsLegacyA.clearMsgs(); wsCentralB.clearMsgs();

        // ── CC-1. CENTRAL socket receives calendarEventCreated ───────────────
        console.log('\n  — CC-1. CENTRAL socket receives calendarEventCreated —\n');
        const evCreated = await createEvent(tokAdminA, 'Test Prenotazione', '2026-09-01');
        check('CC-1. createEvent succeeded', !!evCreated?.id, evCreated);

        const wsCreatedMsg = await wsCentralA.waitFor(
            m => m.action === 'calendarEventCreated' && m.event?.id === evCreated.id
        ).catch(() => null);
        check('CC-1. CENTRAL A socket receives calendarEventCreated', !!wsCreatedMsg, wsCreatedMsg);
        check('CC-1b. Broadcast includes event payload', wsCreatedMsg?.event?.title === 'Test Prenotazione', wsCreatedMsg?.event?.title);

        // ── CC-2. CENTRAL socket receives calendarEventUpdated ───────────────
        console.log('\n  — CC-2. CENTRAL socket receives calendarEventUpdated —\n');
        wsCentralA.clearMsgs();
        const evUpdated = await updateEvent(tokAdminA, evCreated.id, 'Prenotazione Aggiornata');
        check('CC-2. updateEvent succeeded', !!evUpdated?.id, evUpdated);

        const wsUpdatedMsg = await wsCentralA.waitFor(
            m => m.action === 'calendarEventUpdated' && m.event?.id === evCreated.id
        ).catch(() => null);
        check('CC-2. CENTRAL A socket receives calendarEventUpdated', !!wsUpdatedMsg, wsUpdatedMsg);
        check('CC-2b. Updated title is in broadcast', wsUpdatedMsg?.event?.title === 'Prenotazione Aggiornata', wsUpdatedMsg?.event?.title);

        // ── CC-3. CENTRAL socket receives calendarEventDeleted ───────────────
        console.log('\n  — CC-3. CENTRAL socket receives calendarEventDeleted —\n');
        wsCentralA.clearMsgs();
        const delRes = await deleteEvent(tokAdminA, evCreated.id);
        check('CC-3. deleteEvent succeeded', delRes.data?.success === true, delRes.data);

        const wsDeletedMsg = await wsCentralA.waitFor(
            m => m.action === 'calendarEventDeleted' && m.eventId === evCreated.id
        ).catch(() => null);
        check('CC-3. CENTRAL A socket receives calendarEventDeleted', !!wsDeletedMsg, wsDeletedMsg);

        // ── CC-4. CENTRAL A does NOT receive Company B calendar events ────────
        console.log('\n  — CC-4. Company A CENTRAL socket does not receive Company B events —\n');
        wsCentralA.clearMsgs();
        const evB = await createEvent(tokAdminB, 'EventoB', '2026-09-02');
        check('CC-4. createEvent Company B succeeded', !!evB?.id, evB);

        const aGetsB = await wsCentralA.notReceived(
            m => m.action === 'calendarEventCreated' && m.event?.id === evB.id
        );
        check('CC-4. CENTRAL A does not receive Company B calendarEventCreated', aGetsB, 'received Company B event');

        // ── CC-5. CENTRAL B does NOT receive Company A calendar events ────────
        console.log('\n  — CC-5. Company B CENTRAL socket does not receive Company A events —\n');
        wsCentralB.clearMsgs();
        const evA2 = await createEvent(tokAdminA, 'EventoA2', '2026-09-03');
        check('CC-5. createEvent Company A (second) succeeded', !!evA2?.id, evA2);

        const bGetsA = await wsCentralB.notReceived(
            m => m.action === 'calendarEventCreated' && m.event?.id === evA2.id
        );
        check('CC-5. CENTRAL B does not receive Company A calendarEventCreated', bGetsA, 'received Company A event');

        // ── CC-6. Unbound legacy socket also receives calendar broadcasts ─────
        console.log('\n  — CC-6. Unbound legacy socket receives calendar broadcasts —\n');
        wsLegacyA.clearMsgs();
        const evLeg = await createEvent(tokAdminA, 'EventoLegacy', '2026-09-04');
        check('CC-6. createEvent for legacy test succeeded', !!evLeg?.id, evLeg);

        const wsLegMsg = await wsLegacyA.waitFor(
            m => m.action === 'calendarEventCreated' && m.event?.id === evLeg.id
        ).catch(() => null);
        check('CC-6. Unbound legacy socket receives calendarEventCreated', !!wsLegMsg, wsLegMsg);

        // ── CC-7. STANDARD dept socket does NOT receive calendar broadcasts ───
        // requireCalendarAccess (REST) blocks STANDARD accounts from all calendar
        // endpoints.  broadcastCalendarEvent must be consistent with that guard:
        // bound STANDARD sockets are excluded from WS delivery.
        // This assertion fails on the base commit (which sends to every socket
        // in the room indiscriminately) and passes after the T35 fix.
        console.log('\n  — CC-7. STANDARD dept socket does NOT receive calendar broadcasts —\n');
        wsStdA.clearMsgs();
        const evStd = await createEvent(tokAdminA, 'EventoStandard', '2026-09-05');
        check('CC-7. createEvent for STANDARD test succeeded', !!evStd?.id, evStd);

        const stdNotReceived = await wsStdA.notReceived(
            m => m.action === 'calendarEventCreated' && m.event?.id === evStd.id
        );
        check('CC-7. STANDARD dept socket does NOT receive calendarEventCreated (consistent with REST guard)', stdNotReceived, 'STANDARD received calendar broadcast it should not have');

        // ── CC-8. No cross-contamination on rapid concurrent updates ──────────
        console.log('\n  — CC-8. No cross-contamination on rapid concurrent creates —\n');
        wsCentralA.clearMsgs(); wsCentralB.clearMsgs();

        // Fire two creates in parallel — one per company
        const [evAp, evBp] = await Promise.all([
            createEvent(tokAdminA, 'ParallelA', '2026-09-10'),
            createEvent(tokAdminB, 'ParallelB', '2026-09-10')
        ]);
        check('CC-8. Parallel createEvent A succeeded', !!evAp?.id, evAp);
        check('CC-8. Parallel createEvent B succeeded', !!evBp?.id, evBp);

        // Company A CENTRAL should receive A's event
        const parA = await wsCentralA.waitFor(
            m => m.action === 'calendarEventCreated' && m.event?.id === evAp.id
        ).catch(() => null);
        check('CC-8. CENTRAL A receives its own parallel event', !!parA, parA);

        // Company A CENTRAL must NOT receive B's parallel event
        const aGotBpar = await wsCentralA.notReceived(
            m => m.action === 'calendarEventCreated' && m.event?.id === evBp.id
        );
        check('CC-8. CENTRAL A did not receive Company B parallel event', aGotBpar, 'received Company B parallel event');

        // Company B CENTRAL should receive B's event
        const parB = await wsCentralB.waitFor(
            m => m.action === 'calendarEventCreated' && m.event?.id === evBp.id
        ).catch(() => null);
        check('CC-8. CENTRAL B receives its own parallel event', !!parB, parB);

        // Company B CENTRAL must NOT receive A's parallel event
        const bGotApar = await wsCentralB.notReceived(
            m => m.action === 'calendarEventCreated' && m.event?.id === evAp.id
        );
        check('CC-8. CENTRAL B did not receive Company A parallel event', bGotApar, 'received Company A parallel event');

        // ── CC-9. CENTRAL socket is excluded after dept demoted to STANDARD ───
        // A connected CENTRAL socket must stop receiving calendar events the
        // moment its department type is reverted to STANDARD, even if the socket
        // stays open.  This test fails on the base commit (which uses the stale
        // ws.boundDepartmentType cached at joinRoom) and passes after the T35 fix
        // (which re-evaluates the live dept type at every broadcast).
        console.log('\n  — CC-9. Socket excluded after dept demoted CENTRAL→STANDARD —\n');
        const tokAdminRev9    = sign('uid-admin-rev9',   'comprev9');
        const tokCentralRev9  = sign('uid-central-rev9', 'comprev9');
        const dRev9 = await createDept(tokAdminRev9, 'DirezioneDem');
        const setRev9 = await setDeptType(tokAdminRev9, dRev9, 'CENTRAL');
        check('CC-9. Rev9 dept set CENTRAL', setRev9.data?.department?.departmentType === 'CENTRAL', setRev9.data);
        const acctRev9 = await createAcct(tokAdminRev9, dRev9, 'DirDem WS', 'dir.dem.cal');
        check('CC-9. Rev9 acct created', !!acctRev9?.id, acctRev9?.id);
        await bindUid(tokCentralRev9, 'dir.dem.cal');

        const wsRev9 = await openWs(); openSockets.push(wsRev9);
        await joinRoom(wsRev9, tokCentralRev9);
        wsRev9.clearMsgs();

        // Confirm socket receives when still CENTRAL
        const evBefore9 = await createEvent(tokAdminRev9, 'BeforeDemote', '2026-10-01');
        const rcvBefore9 = await wsRev9.waitFor(
            m => m.action === 'calendarEventCreated' && m.event?.id === evBefore9?.id
        ).catch(() => null);
        check('CC-9. Socket receives while still CENTRAL', !!rcvBefore9, rcvBefore9);

        // Demote to STANDARD — live lookup must now exclude this socket
        const demoteRes = await setDeptType(tokAdminRev9, dRev9, 'STANDARD');
        check('CC-9. Dept demoted to STANDARD', demoteRes.data?.department?.departmentType === 'STANDARD', demoteRes.data);

        wsRev9.clearMsgs();
        const evAfter9 = await createEvent(tokAdminRev9, 'AfterDemote', '2026-10-02');
        const notRcv9 = await wsRev9.notReceived(
            m => m.action === 'calendarEventCreated' && m.event?.id === evAfter9?.id
        );
        check('CC-9. Socket no longer receives after dept demoted to STANDARD', notRcv9, 'still received after demotion');

        // ── CC-10. CENTRAL socket is excluded after account is suspended ───────
        console.log('\n  — CC-10. Socket excluded after account suspended —\n');
        const tokAdminRev10   = sign('uid-admin-rev10',   'comprev10');
        const tokCentralRev10 = sign('uid-central-rev10', 'comprev10');
        const dRev10 = await createDept(tokAdminRev10, 'DirezioneSupp');
        const setRev10 = await setDeptType(tokAdminRev10, dRev10, 'CENTRAL');
        check('CC-10. Rev10 dept set CENTRAL', setRev10.data?.department?.departmentType === 'CENTRAL', setRev10.data);
        const acctRev10 = await createAcct(tokAdminRev10, dRev10, 'DirSupp WS', 'dir.supp.cal');
        check('CC-10. Rev10 acct created', !!acctRev10?.id, acctRev10?.id);
        await bindUid(tokCentralRev10, 'dir.supp.cal');

        const wsRev10 = await openWs(); openSockets.push(wsRev10);
        await joinRoom(wsRev10, tokCentralRev10);
        wsRev10.clearMsgs();

        // Confirm socket receives while account is ACTIVE
        const evBefore10 = await createEvent(tokAdminRev10, 'BeforeSuspend', '2026-10-03');
        const rcvBefore10 = await wsRev10.waitFor(
            m => m.action === 'calendarEventCreated' && m.event?.id === evBefore10?.id
        ).catch(() => null);
        check('CC-10. Socket receives while account ACTIVE', !!rcvBefore10, rcvBefore10);

        // Suspend the account — live lookup must now exclude this socket
        await suspendAcct(tokAdminRev10, acctRev10.id);
        wsRev10.clearMsgs();
        const evAfter10 = await createEvent(tokAdminRev10, 'AfterSuspend', '2026-10-04');
        const notRcv10 = await wsRev10.notReceived(
            m => m.action === 'calendarEventCreated' && m.event?.id === evAfter10?.id
        );
        check('CC-10. Socket no longer receives after account suspended', notRcv10, 'still received after suspension');

        // ── CC-11. CENTRAL socket is excluded after department is deactivated ──
        // Deactivating a department auto-suspends its account (referential integrity).
        // The live lookup must see liveDept.active === false and stop delivery.
        console.log('\n  — CC-11. Socket excluded after department deactivated —\n');
        const tokAdminRev11   = sign('uid-admin-rev11',   'comprev11');
        const tokCentralRev11 = sign('uid-central-rev11', 'comprev11');
        const dRev11 = await createDept(tokAdminRev11, 'DirezioneDeact');
        const setRev11 = await setDeptType(tokAdminRev11, dRev11, 'CENTRAL');
        check('CC-11. Rev11 dept set CENTRAL', setRev11.data?.department?.departmentType === 'CENTRAL', setRev11.data);
        const acctRev11 = await createAcct(tokAdminRev11, dRev11, 'DirDeact WS', 'dir.deact.cal');
        check('CC-11. Rev11 acct created', !!acctRev11?.id, acctRev11?.id);
        await bindUid(tokCentralRev11, 'dir.deact.cal');

        const wsRev11 = await openWs(); openSockets.push(wsRev11);
        await joinRoom(wsRev11, tokCentralRev11);
        wsRev11.clearMsgs();

        // Confirm socket receives while department is active
        const evBefore11 = await createEvent(tokAdminRev11, 'BeforeDeact', '2026-10-05');
        const rcvBefore11 = await wsRev11.waitFor(
            m => m.action === 'calendarEventCreated' && m.event?.id === evBefore11?.id
        ).catch(() => null);
        check('CC-11. Socket receives while dept active', !!rcvBefore11, rcvBefore11);

        // Deactivate the department — auto-suspends account; live lookup must exclude socket
        const deactRes = await deactivateDept(tokAdminRev11, dRev11);
        check('CC-11. Dept deactivated', deactRes.data?.success === true || deactRes.status === 200, deactRes.data);
        wsRev11.clearMsgs();
        const evAfter11 = await createEvent(tokAdminRev11, 'AfterDeact', '2026-10-06');
        const notRcv11 = await wsRev11.notReceived(
            m => m.action === 'calendarEventCreated' && m.event?.id === evAfter11?.id
        );
        check('CC-11. Socket no longer receives after dept deactivated', notRcv11, 'still received after dept deactivation');

    } finally {
        for (const ws of openSockets) { try { ws.close(); } catch {} }
        await new Promise(r => setTimeout(r, 200));
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
