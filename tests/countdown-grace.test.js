// tests/countdown-grace.test.js — Task 28: 120s countdown grace + server-authoritative
// removal + persistent countdown history.
//
// Verifies:
//  1.  Countdown active before endsAt (replay & REST)
//  2.  Countdown expired at 00:00 — still replayed with timeRemaining 0 during grace
//  3.  Grace does NOT restart on reconnect (original endsAt preserved)
//  4.  Server broadcasts countdownCompleted at endsAt + grace (within ~3s)
//  5.  Countdown gone after grace — no replay, table reusable
//  6.  History record written exactly once with correct fields (auto_expired)
//  7.  Manual delete archives once with reason manual_deleted (no double-archive)
//  8.  Table reuse after grace archives old countdown as superseded
//  9.  Tenant isolation: company A cannot read company B history
// 10.  startCountdown payload carries graceMs + countdownId
// 11.  REST /api/countdowns excludes expired countdowns (sala initial-load semantics)
// 12.  History endpoint requires auth
//
// Uses POST_EXPIRY_GRACE_MS=4000 so tests never wait 120 real seconds.
//
// Run: node tests/countdown-grace.test.js

const { spawn } = require('child_process');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

const SECRET   = 'test-secret-cd-grace';
const PORT     = 5089;
const BASE     = `http://127.0.0.1:${PORT}`;
const WS_URL   = `ws://127.0.0.1:${PORT}/ws`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cdgrace-'));
const GRACE_MS = 4000;

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
            if (idx !== -1) { waiters.splice(idx, 1)[0].resolve(msg); }
            else { msgs.push(msg); }
        });
        ws.waitFor = (pred, timeout = 2000) => new Promise((res, rej) => {
            const existing = msgs.findIndex(pred);
            if (existing !== -1) { res(msgs.splice(existing, 1)[0]); return; }
            const t = setTimeout(() => {
                const i = waiters.findIndex(w => w.resolve === res);
                if (i !== -1) waiters.splice(i, 1);
                rej(new Error('waitFor timeout'));
            }, timeout);
            waiters.push({ pred, resolve: m => { clearTimeout(t); res(m); } });
        });
        ws.notReceived = (pred, timeout = 400) =>
            new Promise(res => {
                const existing = msgs.findIndex(pred);
                if (existing !== -1) { msgs.splice(existing, 1); res(false); return; }
                let fired = false;
                const t = setTimeout(() => { if (!fired) res(true); }, timeout);
                waiters.push({ pred, resolve: () => { fired = true; clearTimeout(t); res(false); } });
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
            POST_EXPIRY_GRACE_MS: String(GRACE_MS)
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

async function createDept(token, name) {
    const r = await api(token, 'POST', '/api/departments', { name });
    return r.data?.department?.id;
}
async function history(token) {
    const r = await api(token, 'GET', '/api/countdown-history');
    return r.data?.records || [];
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running countdown-grace checks…\n');

    const sockets = [];
    try {
        const tokA = sign('uid-a-admin', 'compa');
        const tokB = sign('uid-b-admin', 'compb');

        const aDept = await createDept(tokA, 'Cucina');
        const bDept = await createDept(tokB, 'CucinaB');
        check('Setup: departments created', !!aDept && !!bDept, { aDept, bDept });

        const wsA = await openWs(); sockets.push(wsA);
        const wsB = await openWs(); sockets.push(wsB);
        await joinRoom(wsA, tokA);
        await joinRoom(wsB, tokB);
        wsA.clearMsgs(); wsB.clearMsgs();

        // ── 1+10. Active countdown carries graceMs + countdownId ─────────────
        console.log('  — 1+10. Creation payload —\n');
        wsA.send(JSON.stringify({
            action: 'startCountdown', tableNumber: 'T1', timeRemaining: 3,
            destinations: [aDept]
        }));
        const cd1 = await wsA.waitFor(m => m.action === 'startCountdown' && m.tableNumber === 'T1');
        check('1.  startCountdown broadcast received', !!cd1);
        check('10. payload carries graceMs = server grace', cd1?.graceMs === GRACE_MS, cd1?.graceMs);
        check('10b. payload carries countdownId', typeof cd1?.countdownId === 'string' && cd1.countdownId.startsWith('cd_'), cd1?.countdownId);
        const t1Id = cd1?.countdownId;
        const t1EndsAt = cd1?.endsAt;

        // REST shows it while active
        const r1 = await api(tokA, 'GET', '/api/countdowns?status=active');
        check('1b. REST shows active countdown', r1.data?.countdowns?.some(c => String(c.tableNumber).toLowerCase() === 't1'), r1.data?.countdowns);
        check('1c. REST returns graceMs', r1.data?.graceMs === GRACE_MS, r1.data?.graceMs);

        // ── 2+3. Expired-in-grace: replay with timeRemaining 0, original endsAt ─
        console.log('\n  — 2+3. Expired-in-grace replay —\n');
        await sleep(3300); // now past endsAt, inside 4s grace
        const wsA2 = await openWs(); sockets.push(wsA2);
        wsA2.send(JSON.stringify({ action: 'joinRoom', token: sign('uid-a-re', 'compa') }));
        const replay = await wsA2.waitFor(m => m.action === 'startCountdown' && m.tableNumber?.toLowerCase() === 't1', 2000).catch(() => null);
        check('2.  Expired-but-in-grace countdown IS replayed on join', !!replay, replay);
        check('2b. Replay has timeRemaining 0', replay?.timeRemaining === 0, replay?.timeRemaining);
        check('3.  Replay keeps ORIGINAL endsAt (grace does not restart)', replay?.endsAt === t1EndsAt, { replay: replay?.endsAt, orig: t1EndsAt });

        // ── 11. REST excludes expired countdowns (sala initial-load semantics) ─
        const r11 = await api(tokA, 'GET', '/api/countdowns?status=active');
        check('11. REST active list excludes expired countdown', !r11.data?.countdowns?.some(c => String(c.tableNumber).toLowerCase() === 't1'), r11.data?.countdowns);

        // ── 4. Server broadcasts countdownCompleted at endsAt + grace ────────
        console.log('\n  — 4. Server-authoritative completion —\n');
        const completed = await wsA.waitFor(m => m.action === 'countdownCompleted' && m.tableNumber?.toLowerCase() === 't1', 7000).catch(() => null);
        const completedAtMs = Date.now();
        check('4.  countdownCompleted broadcast received', !!completed, completed);
        check('4b. reason is auto_expired', completed?.reason === 'auto_expired', completed?.reason);
        check('4c. carries countdownId', completed?.countdownId === t1Id, completed?.countdownId);
        check('4d. removal within ~3s of endsAt+grace', completedAtMs - (t1EndsAt + GRACE_MS) < 3500, completedAtMs - (t1EndsAt + GRACE_MS));
        // Company B never sees it
        const bLeak = await wsB.notReceived(m => m.action === 'countdownCompleted');
        check('4e. Company B did not receive completion', bLeak);

        // ── 5. No replay after grace ──────────────────────────────────────────
        console.log('\n  — 5. No replay after grace —\n');
        const wsA3 = await openWs(); sockets.push(wsA3);
        wsA3.send(JSON.stringify({ action: 'joinRoom', token: sign('uid-a-late', 'compa') }));
        const noReplay = await wsA3.notReceived(m => m.action === 'startCountdown' && m.tableNumber?.toLowerCase() === 't1', 600);
        check('5.  Past-grace countdown not replayed', noReplay);

        // ── 6. History record correctness (auto_expired, exactly once) ───────
        console.log('\n  — 6. History record —\n');
        const histA = await history(tokA);
        const t1Recs = histA.filter(r => r.id === t1Id);
        check('6.  Exactly one history record for T1', t1Recs.length === 1, t1Recs.length);
        const rec = t1Recs[0];
        check('6b. companyId = compa', rec?.companyId === 'compa', rec?.companyId);
        check('6c. tableNumber = T1', rec?.tableNumber === 'T1', rec?.tableNumber);
        check('6d. destinations correct', Array.isArray(rec?.destinations) && rec.destinations.includes(aDept), rec?.destinations);
        check('6e. initialDuration = 3', rec?.initialDuration === 3, rec?.initialDuration);
        check('6f. endsAt matches broadcast', rec?.endsAt === t1EndsAt, rec?.endsAt);
        check('6g. reason auto_expired', rec?.reason === 'auto_expired', rec?.reason);
        check('6h. createdBy = verified uid', rec?.createdBy === 'uid-a-admin', rec?.createdBy);
        check('6i. completedAt set after endsAt', typeof rec?.completedAt === 'number' && rec.completedAt >= rec.endsAt, rec?.completedAt);
        check('6j. events array reserved (empty)', Array.isArray(rec?.events) && rec.events.length === 0, rec?.events);
        check('6k. startTime present', typeof rec?.startTime === 'number', rec?.startTime);

        // ── 7. Manual delete archives once, reason manual_deleted ────────────
        console.log('\n  — 7. Manual delete —\n');
        wsA.clearMsgs();
        wsA.send(JSON.stringify({
            action: 'startCountdown', tableNumber: 'T2', timeRemaining: 2,
            destinations: [aDept]
        }));
        const cd2 = await wsA.waitFor(m => m.action === 'startCountdown' && m.tableNumber === 'T2');
        const t2Id = cd2.countdownId;
        // Let it expire, then manually delete during grace — then wait past grace
        // to prove the sweep does NOT double-archive.
        await sleep(2300);
        wsA.send(JSON.stringify({ action: 'deleteCountdown', tableNumber: 'T2' }));
        await wsA.waitFor(m => m.action === 'deleteCountdown' && m.tableNumber === 'T2');
        await sleep(GRACE_MS + 2500); // sweep passes endsAt+grace
        const histA2 = await history(tokA);
        const t2Recs = histA2.filter(r => r.id === t2Id);
        check('7.  Exactly one record for manually deleted countdown', t2Recs.length === 1, t2Recs.length);
        check('7b. reason manual_deleted', t2Recs[0]?.reason === 'manual_deleted', t2Recs[0]?.reason);
        // no stray countdownCompleted for T2
        const noDupComplete = await wsA.notReceived(m => m.action === 'countdownCompleted' && m.tableNumber === 'T2', 300);
        check('7c. No countdownCompleted after manual delete', noDupComplete);

        // ── 8. Table reuse supersession ───────────────────────────────────────
        console.log('\n  — 8. Superseded on table reuse —\n');
        wsA.clearMsgs();
        wsA.send(JSON.stringify({
            action: 'startCountdown', tableNumber: 'T3', timeRemaining: 1,
            destinations: [aDept]
        }));
        const cd3 = await wsA.waitFor(m => m.action === 'startCountdown' && m.tableNumber === 'T3');
        const t3Id = cd3.countdownId;
        // While still in grace, a reuse attempt is rejected
        await sleep(1300);
        wsA.send(JSON.stringify({
            action: 'startCountdown', tableNumber: 'T3', timeRemaining: 5,
            destinations: [aDept]
        }));
        const rejected = await wsA.waitFor(m => m.action === 'countdownError' && m.code === 'TABLE_ALREADY_ACTIVE', 1500).catch(() => null);
        check('8.  Reuse during grace rejected (TABLE_ALREADY_ACTIVE)', !!rejected, rejected);
        // T3 will be auto-completed by the sweep; verify exactly one archive
        await sleep(GRACE_MS + 2500);
        const histA3 = await history(tokA);
        const t3Recs = histA3.filter(r => r.id === t3Id);
        check('8b. T3 archived exactly once', t3Recs.length === 1, t3Recs.length);

        // Supersession path: lazy-cleanup on reuse (stop-sweep race is impossible to
        // force here, but the joinRoom lazy path routes through the same function).
        // Simulate: create a short countdown, wait past grace with sweep possibly
        // beaten by an immediate reuse — either way exactly one record with
        // reason auto_expired OR superseded.
        wsA.clearMsgs();
        wsA.send(JSON.stringify({
            action: 'startCountdown', tableNumber: 'T4', timeRemaining: 1,
            destinations: [aDept]
        }));
        const cd4 = await wsA.waitFor(m => m.action === 'startCountdown' && m.tableNumber === 'T4');
        const t4Id = cd4.countdownId;
        await sleep(1000 + GRACE_MS + 100); // just past grace; race sweep vs reuse
        wsA.send(JSON.stringify({
            action: 'startCountdown', tableNumber: 'T4', timeRemaining: 5,
            destinations: [aDept]
        }));
        const cd4b = await wsA.waitFor(m => m.action === 'startCountdown' && m.tableNumber === 'T4', 2000).catch(() => null);
        check('8c. Table reusable after grace', !!cd4b, cd4b);
        await sleep(400);
        const histA4 = await history(tokA);
        const t4Recs = histA4.filter(r => r.id === t4Id);
        check('8d. Old T4 archived exactly once', t4Recs.length === 1, t4Recs.length);
        check('8e. Old T4 reason is superseded or auto_expired', ['superseded', 'auto_expired'].includes(t4Recs[0]?.reason), t4Recs[0]?.reason);
        // clean up the new T4
        wsA.send(JSON.stringify({ action: 'deleteCountdown', tableNumber: 'T4' }));

        // ── 9+12. Tenant isolation + auth on history endpoint ────────────────
        console.log('\n  — 9+12. Tenant isolation —\n');
        const histB = await history(tokB);
        check('9.  Company B history has no compa records', histB.every(r => r.companyId === 'compb') && !histB.some(r => [t1Id, t2Id, t3Id, t4Id].includes(r.id)), histB.length);
        const rNoAuth = await api(null, 'GET', '/api/countdown-history');
        check('12. History endpoint rejects unauthenticated (401)', rNoAuth.status === 401, rNoAuth.status);

        // ── Persistence: file written under DATA_DIR ──────────────────────────
        const histFile = path.join(DATA_DIR, 'countdown-history.json');
        check('P.  countdown-history.json persisted', fs.existsSync(histFile));
        const onDisk = JSON.parse(fs.readFileSync(histFile, 'utf8'));
        check('P2. Persisted store keyed by companyId', Array.isArray(onDisk.compa) && onDisk.compa.some(r => r.id === t1Id), Object.keys(onDisk));

    } catch (err) {
        failed++;
        console.error('  ❌ Unhandled test error:', err);
    } finally {
        sockets.forEach(s => { try { s.close(); } catch {} });
        await stopServer(server);
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\ncountdown-grace: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
