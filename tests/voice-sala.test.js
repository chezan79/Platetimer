// tests/voice-sala.test.js — Department → Floor (Sala) voice messages
//
// Verifies:
//  1. Department → __sala__ voice message (HTTP) is delivered to a Sala socket in the same company
//  2. Department → __sala__ voice message (WS action) is delivered to a Sala socket in the same company
//  3. __sala__ destination is accepted while an invalid/foreign destination is rejected (HTTP + WS)
//  4. A socket authenticated for a DIFFERENT company never receives the message
//  5. Existing department → department voice flow still works
//  6. Invalid `from` (foreign dept) rejected on HTTP endpoint
//
// Run: node tests/voice-sala.test.js

const { spawn } = require('child_process');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

const SECRET   = 'test-secret-voice-sala';
const PORT     = 5090;
const BASE     = `http://127.0.0.1:${PORT}`;
const WS_URL   = `ws://127.0.0.1:${PORT}/ws`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vsala-'));
const SALA_ID  = '__sala__';

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
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

async function joinRoom(ws, token) {
    ws.send(JSON.stringify({ action: 'joinRoom', token }));
    await new Promise(r => setTimeout(r, 100));
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

async function createDept(token, name) {
    const r = await api(token, 'POST', '/api/departments', { name });
    return r.data?.department?.id;
}

const AUDIO = Buffer.from('fake-audio-bytes').toString('base64');

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running voice→sala checks…\n');

    const sockets = [];
    try {
        const tokA  = sign('uid-a-admin', 'compA');
        const tokB  = sign('uid-b-admin', 'compB');

        // Setup departments
        const aCucina = await createDept(tokA, 'Cucina');
        const aBar    = await createDept(tokA, 'Bar');
        const bDept   = await createDept(tokB, 'CucinaB');
        check('Setup: company A depts created', !!aCucina && !!aBar, { aCucina, aBar });
        check('Setup: company B dept created', !!bDept, bDept);

        // Sockets: sala A (unbound, company A), sala B (unbound, company B), sender A
        const wsSalaA  = await openWs(); sockets.push(wsSalaA);
        const wsSalaB  = await openWs(); sockets.push(wsSalaB);
        const wsSender = await openWs(); sockets.push(wsSender);
        const wsBarA   = await openWs(); sockets.push(wsBarA);
        await joinRoom(wsSalaA,  sign('uid-a-sala', 'compA'));
        await joinRoom(wsSalaB,  sign('uid-b-sala', 'compB'));
        await joinRoom(wsSender, sign('uid-a-dept', 'compA'));
        await joinRoom(wsBarA,   sign('uid-a-bar',  'compA'));

        // ── 1. HTTP: department → Floor delivery within same company ─────────
        const r1 = await api(sign('uid-a-dept', 'compA'), 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-http-sala',
            destinations: [SALA_ID], from: aCucina
        });
        check('1. HTTP dept→__sala__ accepted', r1.status === 200 && r1.data.success === true, r1);
        const m1 = await wsSalaA.waitFor(m => m.action === 'voiceMessage' && m.messageId === 'vm-http-sala').catch(() => null);
        check('1. Sala socket (same company) received message', !!m1, m1);
        check('1. Message carries sender dept id', m1?.from === aCucina && m1?.sourceDepartmentId === aCucina, m1?.from);
        check('1. Message destinations include __sala__', Array.isArray(m1?.destinations) && m1.destinations.includes(SALA_ID), m1?.destinations);
        check('1. Message has audio + timestamp', m1?.hasAudio === true && !!m1?.timestamp, { hasAudio: m1?.hasAudio, ts: m1?.timestamp });

        // Cross-company isolation: sala B must NOT receive it
        const leak1 = await wsSalaB.waitFor(m => m.action === 'voiceMessage' && m.messageId === 'vm-http-sala', 600).catch(() => null);
        check('1. Foreign-company Sala socket did NOT receive it', leak1 === null, leak1);

        // ── 2. WS action: department → Floor ─────────────────────────────────
        wsSender.send(JSON.stringify({
            action: 'voiceMessage', messageId: 'vm-ws-sala',
            destinations: [SALA_ID], from: aCucina,
            audioData: AUDIO, hasAudio: true
        }));
        const m2 = await wsSalaA.waitFor(m => m.action === 'voiceMessage' && m.messageId === 'vm-ws-sala').catch(() => null);
        check('2. WS dept→__sala__ delivered to same-company Sala socket', !!m2, m2);
        check('2. WS destinations include __sala__', Array.isArray(m2?.destinations) && m2.destinations.includes(SALA_ID), m2?.destinations);
        const leak2 = await wsSalaB.waitFor(m => m.action === 'voiceMessage' && m.messageId === 'vm-ws-sala', 600).catch(() => null);
        check('2. Foreign-company Sala socket did NOT receive WS message', leak2 === null, leak2);

        // ── 3. Invalid / foreign destinations rejected ────────────────────────
        const r3a = await api(sign('uid-a-dept', 'compA'), 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-bad-dest',
            destinations: ['nonexistent-dept'], from: aCucina
        });
        check('3. HTTP invalid destination rejected (400)', r3a.status === 400, r3a.status);
        const r3b = await api(sign('uid-a-dept', 'compA'), 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-foreign-dest',
            destinations: [bDept], from: aCucina
        });
        check('3. HTTP foreign-company destination rejected (400)', r3b.status === 400, r3b.status);
        const r3c = await api(sign('uid-a-dept', 'compA'), 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-mixed',
            destinations: [SALA_ID, 'nonexistent-dept'], from: aCucina
        });
        check('3. HTTP mixed valid+invalid destinations rejected (400)', r3c.status === 400, r3c.status);
        // WS: invalid destination silently rejected with error, no broadcast
        wsSender.send(JSON.stringify({
            action: 'voiceMessage', messageId: 'vm-ws-bad',
            destinations: [bDept], audioData: AUDIO, hasAudio: true
        }));
        const leak3 = await wsSalaA.waitFor(m => m.action === 'voiceMessage' && m.messageId === 'vm-ws-bad', 600).catch(() => null);
        check('3. WS foreign destination not broadcast', leak3 === null, leak3);

        // ── 4. Invalid `from` rejected on HTTP endpoint ───────────────────────
        const r4 = await api(sign('uid-a-dept', 'compA'), 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-bad-from',
            destinations: [SALA_ID], from: bDept
        });
        check('4. HTTP foreign `from` rejected (400)', r4.status === 400, r4.status);

        // ── 5. Existing dept → dept flow unchanged ────────────────────────────
        const r5 = await api(sign('uid-a-dept', 'compA'), 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-d2d',
            destinations: [aBar], from: aCucina
        });
        check('5. HTTP dept→dept still accepted', r5.status === 200 && r5.data.success === true, r5);
        const m5 = await wsBarA.waitFor(m => m.action === 'voiceMessage' && m.messageId === 'vm-d2d').catch(() => null);
        check('5. dept→dept message delivered in-room', !!m5 && m5.destinations.includes(aBar), m5?.destinations);
        const leak5 = await wsSalaB.waitFor(m => m.action === 'voiceMessage' && m.messageId === 'vm-d2d', 600).catch(() => null);
        check('5. dept→dept not leaked cross-company', leak5 === null, leak5);

        // ── 6. Unauthenticated HTTP rejected ─────────────────────────────────
        const r6 = await api(null, 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-noauth', destinations: [SALA_ID]
        });
        check('6. HTTP without token rejected (401)', r6.status === 401, r6.status);

    } catch (err) {
        failed++;
        console.error('  ❌ Unhandled test error:', err);
    } finally {
        sockets.forEach(s => { try { s.close(); } catch {} });
        await stopServer(server);
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\nvoice-sala: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
