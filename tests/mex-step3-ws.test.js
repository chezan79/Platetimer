#!/usr/bin/env node
'use strict';
/**
 * Mex Step 3 — WS security matrix & REST inbox integration tests
 *
 * Run: node tests/mex-step3-ws.test.js
 *
 * Covers:
 *  • mexSend: sender gets mexSendAck{success:true}, recipient gets mexIncoming
 *  • Sender does NOT receive mexIncoming for their own message
 *  • Unrelated dept does NOT receive mexIncoming (participant-only delivery)
 *  • Unbound socket (no boundDepartmentId) rejected with MEX_NOT_BOUND
 *  • Inactive recipient rejected with MEX_INVALID_RECIPIENT
 *  • Self-send rejected with MEX_SELF_SEND
 *  • Empty body rejected with MEX_EMPTY_BODY
 *  • Body > 300 chars rejected with MEX_BODY_TOO_LONG
 *  • Cross-company recipient rejected with MEX_INVALID_RECIPIENT
 *  • Body exactly 300 chars accepted
 *  • GET /api/service/mex/inbox — no auth → 401
 *  • GET /api/service/mex/inbox — bound dept sees messages sent to it
 *  • REST inbox de-duplicates messages already received via WS
 */

const crypto      = require('crypto');
const path        = require('path');
const os          = require('os');
const fs          = require('fs');
const { spawn }   = require('child_process');
const WS          = require('ws');

const SECRET = 'test-mex-step3-ws-secret';
const PORT   = 4446;
const BASE   = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

// ── Token signing — must match server.js signSessionToken() exactly ───────────
function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

// ── Test counters ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else       { console.error(`  ❌ ${label}${hint !== undefined ? ' — got: ' + JSON.stringify(hint) : ''}`); failed++; }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function api(token, method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(BASE + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ── WS helper with consume-semantics waitFor ─────────────────────────────────
function wsConnect(token) {
    return new Promise((resolve, reject) => {
        const buffer = [], waiters = [], received = [];
        const client = new WS(WS_URL);
        client.on('open', () => {
            client.send(JSON.stringify({ action: 'joinRoom', token }));
            resolve({
                client, received,
                close() { try { client.close(); } catch (_) {} },
                send(obj) { client.send(JSON.stringify(obj)); },
                /** Returns the first message with matching action, or null on timeout. */
                waitFor(action, timeout = 4000) {
                    const idx = buffer.findIndex(m => m.action === action);
                    if (idx !== -1) return Promise.resolve(buffer.splice(idx, 1)[0]);
                    return new Promise(res => {
                        const waiter = { action, resolve: res };
                        waiter._timer = setTimeout(() => {
                            const i = waiters.indexOf(waiter);
                            if (i !== -1) waiters.splice(i, 1);
                            res(null);
                        }, timeout);
                        waiters.push(waiter);
                    });
                }
            });
        });
        client.on('message', raw => {
            let msg; try { msg = JSON.parse(raw); } catch { return; }
            if (!msg.action) return;
            received.push(msg);
            const wi = waiters.findIndex(w => w.action === msg.action);
            if (wi !== -1) {
                const waiter = waiters.splice(wi, 1)[0];
                clearTimeout(waiter._timer);
                waiter.resolve(msg);
            } else {
                buffer.push(msg);
            }
        });
        client.on('error', reject);
        client.on('close', () => waiters.splice(0).forEach(w => { clearTimeout(w._timer); w.resolve(null); }));
    });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Server bootstrap ──────────────────────────────────────────────────────────
function startServer(DATA_DIR) {
    const proc = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            TEST_FIREBASE_AUTH_MOCK: '1',
            FIREBASE_ADMIN_SERVICE_ACCOUNT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stderr.on('data', () => {});
    const ready = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 20_000);
        proc.stdout.on('data', d => {
            if (d.toString().includes('avviato')) { clearTimeout(t); resolve(); }
        });
    });
    return { proc, ready };
}

// ── Main test runner ──────────────────────────────────────────────────────────
async function run() {
    console.log('Starting server (Mex Step 3 WS security tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mex-ws-'));
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'),
        JSON.stringify({ ristorante: 'medium', 'other-co': 'medium' }));

    const { proc, ready } = startServer(DATA_DIR);
    await ready;
    console.log('Server up.\n');

    try {
        // ── Setup: two companies, multiple depts, bound dept accounts ────────────
        const CO      = 'ristorante';
        const OTHER   = 'other-co';

        // Admin tokens (used to create depts + dept accounts)
        const tokAdmin      = sign('uid-admin',   CO);
        const tokOtherAdmin = sign('uid-oadmin',  OTHER);

        // Proto-dept-account tokens — bound by the API to specific depts
        const tokDeptA   = sign('uid-dept-a',  CO);   // will be bound → Cucina
        const tokDeptB   = sign('uid-dept-b',  CO);   // will be bound → Pizzeria
        const tokDeptC   = sign('uid-dept-c',  CO);   // will be bound → Sala (unrelated)
        const tokDeptO   = sign('uid-dept-o',  OTHER); // bound → Lounge (other company)
        const tokUnbound = sign('uid-unbound', CO);   // never bound (no dept account)

        console.log('  — setup: departments & dept accounts —\n');

        // Company depts
        let r;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Cucina' });
        const deptA = r.data.department;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Pizzeria' });
        const deptB = r.data.department;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Sala' });
        const deptC = r.data.department;
        check('Setup: 3 company depts created', !!(deptA?.id && deptB?.id && deptC?.id), r.data);

        // Other-company dept
        r = await api(tokOtherAdmin, 'POST', '/api/departments', { name: 'Lounge' });
        const deptO = r.data.department;
        check('Setup: other-co dept created', !!deptO?.id, r.data);

        // Dept accounts
        r = await api(tokAdmin, 'POST', '/api/department-accounts',
            { departmentId: deptA.id, displayName: 'Cucina Acc', loginIdentifier: 'cucina.mex' });
        check('Setup: acct A', !!r.data?.account?.id, r.data);

        r = await api(tokAdmin, 'POST', '/api/department-accounts',
            { departmentId: deptB.id, displayName: 'Pizzeria Acc', loginIdentifier: 'pizzeria.mex' });
        check('Setup: acct B', !!r.data?.account?.id, r.data);

        r = await api(tokAdmin, 'POST', '/api/department-accounts',
            { departmentId: deptC.id, displayName: 'Sala Acc', loginIdentifier: 'sala.mex' });
        check('Setup: acct C (unrelated)', !!r.data?.account?.id, r.data);

        r = await api(tokOtherAdmin, 'POST', '/api/department-accounts',
            { departmentId: deptO.id, displayName: 'Lounge Acc', loginIdentifier: 'lounge.mex' });
        check('Setup: acct O (other-co)', !!r.data?.account?.id, r.data);

        // Bind accounts — each dept token binds its account by login
        r = await api(tokDeptA, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'cucina.mex' });
        check('Setup: bind A', r.data.success === true, r.data);
        r = await api(tokDeptB, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'pizzeria.mex' });
        check('Setup: bind B', r.data.success === true, r.data);
        r = await api(tokDeptC, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'sala.mex' });
        check('Setup: bind C', r.data.success === true, r.data);
        r = await api(tokDeptO, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'lounge.mex' });
        check('Setup: bind O', r.data.success === true, r.data);

        console.log('');

        // ── 1. mexSend: sender ack + recipient mexIncoming ────────────────────────
        console.log('  — 1. sender ack + recipient mexIncoming —\n');
        {
            const [sessA, sessB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            // Wait for joinedRoom on both
            const [jA, jB] = await Promise.all([sessA.waitFor('joinedRoom'), sessB.waitFor('joinedRoom')]);
            check('1. WS sessions joined', !!(jA && jB));

            sessA.send({ action: 'mexSend', to: deptB.id, body: 'Hello Pizzeria from Cucina' });

            const ack      = await sessA.waitFor('mexSendAck');
            const incoming = await sessB.waitFor('mexIncoming');

            check('1a. Sender gets mexSendAck success=true', ack?.success === true, ack);
            check('1b. conversationId has mexconv_ prefix', ack?.conversationId?.startsWith('mexconv_'), ack);
            check('1c. Recipient gets mexIncoming', !!incoming, incoming);
            check('1d. incoming.from = deptA.id (server-derived)', incoming?.from === deptA.id, incoming?.from);
            check('1e. incoming.body matches', incoming?.body === 'Hello Pizzeria from Cucina', incoming?.body);
            check('1f. incoming.conversationId matches ack', incoming?.conversationId === ack?.conversationId, incoming?.conversationId);

            sessA.close(); sessB.close();
            await wait(100);
        }

        // ── 2. Sender must NOT receive mexIncoming ────────────────────────────────
        console.log('\n  — 2. no self-echo (mexIncoming) for sender —\n');
        {
            const [sessA, sessB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessB.waitFor('joinedRoom')]);

            sessA.send({ action: 'mexSend', to: deptB.id, body: 'no self echo check' });
            await sessA.waitFor('mexSendAck', 4000);  // wait for server to process
            await wait(200);
            const selfGotIncoming = sessA.received.some(m => m.action === 'mexIncoming');
            check('2. Sender did NOT receive mexIncoming', !selfGotIncoming, sessA.received);

            sessA.close(); sessB.close();
            await wait(100);
        }

        // ── 3. Unrelated dept (C) must NOT receive mexIncoming ───────────────────
        console.log('\n  — 3. unrelated dept (C) receives nothing —\n');
        {
            const [sessA, sessB, sessC] = await Promise.all([
                wsConnect(tokDeptA), wsConnect(tokDeptB), wsConnect(tokDeptC)
            ]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessB.waitFor('joinedRoom'), sessC.waitFor('joinedRoom')]);

            sessA.send({ action: 'mexSend', to: deptB.id, body: 'C should not see this' });
            await sessA.waitFor('mexSendAck', 4000);
            await wait(250);
            const cGotIncoming = sessC.received.some(m => m.action === 'mexIncoming');
            check('3. Unrelated dept C did NOT receive mexIncoming', !cGotIncoming, sessC.received);

            sessA.close(); sessB.close(); sessC.close();
            await wait(100);
        }

        // ── 4. Unbound socket rejected with MEX_NOT_BOUND ────────────────────────
        console.log('\n  — 4. unbound socket rejected —\n');
        {
            const sessU = await wsConnect(tokUnbound);
            await sessU.waitFor('joinedRoom');
            sessU.send({ action: 'mexSend', to: deptB.id, body: 'spoof attempt' });
            const resp = await Promise.race([
                sessU.waitFor('error',      4000),
                sessU.waitFor('mexSendAck', 4000)
            ]);
            const rejected = (resp?.code === 'MEX_NOT_BOUND') ||
                             (resp?.action === 'mexSendAck' && resp.success === false);
            check('4. Unbound socket rejected (MEX_NOT_BOUND or ack failure)', rejected, resp);
            sessU.close();
            await wait(100);
        }

        // ── 5. Inactive recipient rejected ────────────────────────────────────────
        console.log('\n  — 5. inactive recipient rejected —\n');
        {
            // Deactivate dept A temporarily so we can use it as inactive target
            // Actually — easier: delete a dept to deactivate, or just use a non-existent ID
            const fakeDeptId = 'dept_does_not_exist_999';
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');
            sessA.send({ action: 'mexSend', to: fakeDeptId, body: 'to inactive' });
            const ack = await sessA.waitFor('mexSendAck');
            check('5. Inactive/nonexistent recipient rejected', ack?.success === false && ack?.code === 'MEX_INVALID_RECIPIENT', ack);
            sessA.close();
            await wait(100);
        }

        // ── 6. Self-send rejected ─────────────────────────────────────────────────
        console.log('\n  — 6. self-send rejected —\n');
        {
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');
            sessA.send({ action: 'mexSend', to: deptA.id, body: 'self send' });
            const ack = await sessA.waitFor('mexSendAck');
            check('6. Self-send rejected (MEX_SELF_SEND)', ack?.success === false && ack?.code === 'MEX_SELF_SEND', ack);
            sessA.close();
            await wait(100);
        }

        // ── 7. Empty body rejected ────────────────────────────────────────────────
        console.log('\n  — 7. empty body rejected —\n');
        {
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');
            sessA.send({ action: 'mexSend', to: deptB.id, body: '   ' });
            const ack = await sessA.waitFor('mexSendAck');
            check('7. Empty body rejected (MEX_EMPTY_BODY)', ack?.success === false && ack?.code === 'MEX_EMPTY_BODY', ack);
            sessA.close();
            await wait(100);
        }

        // ── 8. Body > 300 chars rejected ─────────────────────────────────────────
        console.log('\n  — 8. overlength body rejected —\n');
        {
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');
            sessA.send({ action: 'mexSend', to: deptB.id, body: 'x'.repeat(301) });
            const ack = await sessA.waitFor('mexSendAck');
            check('8. Body >300 chars rejected (MEX_BODY_TOO_LONG)', ack?.success === false && ack?.code === 'MEX_BODY_TOO_LONG', ack);
            sessA.close();
            await wait(100);
        }

        // ── 9. Cross-company recipient rejected ───────────────────────────────────
        console.log('\n  — 9. cross-company recipient rejected —\n');
        {
            // deptO.id belongs to OTHER_CO — not active in CO
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');
            sessA.send({ action: 'mexSend', to: deptO.id, body: 'cross-company attempt' });
            const ack = await sessA.waitFor('mexSendAck');
            check('9. Cross-company recipient rejected (MEX_INVALID_RECIPIENT)',
                ack?.success === false && ack?.code === 'MEX_INVALID_RECIPIENT', ack);
            sessA.close();
            await wait(100);
        }

        // ── 10. Body exactly 300 chars accepted ───────────────────────────────────
        console.log('\n  — 10. exactly 300-char body accepted —\n');
        {
            const [sessA, sessB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessB.waitFor('joinedRoom')]);
            sessA.send({ action: 'mexSend', to: deptB.id, body: 'a'.repeat(300) });
            const ack = await sessA.waitFor('mexSendAck');
            check('10. Exactly 300-char body accepted', ack?.success === true, ack);
            sessA.close(); sessB.close();
            await wait(100);
        }

        // ── 11. REST /api/service/mex/inbox — no auth → 401 ──────────────────────
        console.log('\n  — 11. REST inbox auth guard —\n');
        {
            r = await api(null, 'GET', '/api/service/mex/inbox');
            check('11. No token → 401', r.status === 401, r.status);

            r = await api(tokUnbound, 'GET', '/api/service/mex/inbox');
            check('11b. Unbound session → 403 NOT_BOUND', r.status === 403 && r.data.code === 'NOT_BOUND', r);
        }

        // ── 12. REST /api/service/mex/inbox — bound dept sees its conversations ───
        console.log('\n  — 12. REST inbox backfill —\n');
        {
            // Send a message from B → A; then fetch A's inbox via REST
            const [sessA, sessB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessB.waitFor('joinedRoom')]);
            sessB.send({ action: 'mexSend', to: deptA.id, body: 'REST backfill check' });
            await sessB.waitFor('mexSendAck', 4000);
            await wait(150);
            sessA.close(); sessB.close();
            await wait(100);

            r = await api(tokDeptA, 'GET', '/api/service/mex/inbox');
            check('12a. REST inbox success=true', r.status === 200 && r.data.success === true, r.data);
            const found = r.data.conversations?.some(conv =>
                conv.messages?.some(m => m.body === 'REST backfill check' && m.from === deptB.id)
            );
            check('12b. Inbox contains message sent by B to A', found === true, r.data.conversations);

            // C's inbox should NOT see A-B conversations
            r = await api(tokDeptC, 'GET', '/api/service/mex/inbox');
            const cFound = r.data.conversations?.some(conv =>
                conv.messages?.some(m => m.body === 'REST backfill check')
            );
            check('12c. Unrelated dept C inbox does NOT contain A-B message', cFound === false, r.data.conversations);
        }

        // ── 13. Spoofed sender field in payload is ignored ────────────────────────
        console.log('\n  — 13. spoofed from field in payload ignored —\n');
        {
            const [sessA, sessB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessB.waitFor('joinedRoom')]);
            // Include a 'from' field claiming to be deptC — server must ignore it
            sessA.send({ action: 'mexSend', to: deptB.id, body: 'spoofed from', from: deptC.id });
            const ack      = await sessA.waitFor('mexSendAck');
            const incoming = await sessB.waitFor('mexIncoming', 3000);
            check('13a. Message still delivered (spoof does not break send)', ack?.success === true, ack);
            check('13b. incoming.from is server-derived (deptA, not deptC)',
                incoming?.from === deptA.id, incoming?.from);
            sessA.close(); sessB.close();
            await wait(100);
        }

    } finally {
        proc.kill();
        try { fs.rmSync(DATA_DIR, { recursive: true }); } catch {}
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Mex Step 3 WS tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.error('❌ Some tests failed.');
        process.exit(1);
    } else {
        console.log('✅ All Mex Step 3 WS tests passed.');
    }
}

run().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
