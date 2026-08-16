#!/usr/bin/env node
/**
 * Mex Step 5 — Floor ↔ Department: Security & Delivery Tests
 *
 * Plain Node.js (no Jest) — same pattern as mex-step3-ws.test.js.
 * Direct token signing (no Firebase mock auth needed for setup).
 *
 * Covers all mandatory scenarios from spec §10:
 *  1.  Dept → Floor allowed
 *  2.  Floor → active Dept allowed
 *  3.  Floor cannot spoof another company
 *  4.  Dept cannot spoof Floor sender (client from: field ignored)
 *  5.  Unbound socket cannot act as Floor (no isFloorPrincipal)
 *  6.  Cross-company Dept target rejected
 *  7.  Inactive Dept target rejected
 *  8.  Unrelated dept does NOT receive Floor message
 *  9.  Unrelated Floor socket of another company does NOT receive Dept message
 * 10.  Sender does NOT receive self incoming-alert event
 * 11.  GET /api/sala/token requires auth
 * 12.  GET /api/sala/token issues a floor-scoped token (role:'floor' in payload)
 * 13.  GET /api/service/mex/floor-inbox requires floor principal (not plain admin)
 * 14.  GET /api/service/mex/floor-inbox returns Floor conversations (backfill)
 */

'use strict';

const crypto    = require('crypto');
const path      = require('path');
const os        = require('os');
const fs        = require('fs');
const { spawn } = require('child_process');
const WS        = require('ws');

const SECRET   = 'test-mex-step5-ws-secret';
const PORT     = 4448;
const BASE     = `http://127.0.0.1:${PORT}`;
const WS_URL   = `ws://127.0.0.1:${PORT}/ws`;

// ─── token helpers ────────────────────────────────────────────────────────────
// Must match server.js signSessionToken() exactly.
function sign(uid, companyName, role = null) {
    const obj = { uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000 };
    if (role) obj.role = role;
    const payload = Buffer.from(JSON.stringify(obj)).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}
function signFloor(uid, company) { return sign(uid, company, 'floor'); }

// ─── test counters ────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else       { console.error(`  ❌ ${label}${hint !== undefined ? ' — got: ' + JSON.stringify(hint) : ''}`); failed++; }
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function api(token, method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(BASE + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ─── WS helper (consume-semantics waitFor, same as Step 3) ───────────────────
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

// ─── server bootstrap ─────────────────────────────────────────────────────────
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

// ─── main runner ──────────────────────────────────────────────────────────────
async function run() {
    console.log('Starting server (Mex Step 5 WS tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mex5-ws-'));
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'),
        JSON.stringify({ coA: 'medium', coB: 'medium' }));

    const { proc, ready } = startServer(DATA_DIR);
    await ready;
    console.log('Server up.\n');

    try {
        // ── Setup ──────────────────────────────────────────────────────────────
        const CO  = 'coA';
        const CO2 = 'coB';

        const tokAdminA  = sign('uid-admin-a',  CO);
        const tokAdminB  = sign('uid-admin-b',  CO2);

        // Admin tokens to bind as dept accounts
        const tokDeptA   = sign('uid-dept-a',  CO);    // will bind to KitchenA
        const tokDeptB   = sign('uid-dept-b',  CO);    // will bind to BarA
        const tokDeptC   = sign('uid-dept-c',  CO);    // will bind to (unrelated) SalaA
        const tokDeptB2  = sign('uid-dept-b2', CO2);   // will bind to KitchenB (other co)
        const tokUnbound = sign('uid-unbound', CO);    // never bound

        // Floor tokens — signed directly with role:'floor' (same as /api/sala/token produces)
        const tokFloorA  = signFloor('uid-floor-a', CO);
        const tokFloorB  = signFloor('uid-floor-b', CO2);

        let r;

        // Company A departments
        r = await api(tokAdminA, 'POST', '/api/departments', { name: 'KitchenA' });
        const deptA = r.data.department;
        r = await api(tokAdminA, 'POST', '/api/departments', { name: 'BarA' });
        const deptB = r.data.department;
        r = await api(tokAdminA, 'POST', '/api/departments', { name: 'SalaA' });
        const deptC = r.data.department;
        check('Setup: 3 company A depts created', !!(deptA?.id && deptB?.id && deptC?.id), r.data);

        // Deactivate deptC — server uses PUT (not PATCH) for department updates
        const rDeact = await api(tokAdminA, 'PUT', `/api/departments/${deptC.id}`, { active: false });
        check('Setup: deptC deactivated', rDeact.data.success === true && rDeact.data.department?.active === false, rDeact.data);

        // Company B department
        r = await api(tokAdminB, 'POST', '/api/departments', { name: 'KitchenB' });
        const deptB2 = r.data.department;
        check('Setup: company B dept created', !!deptB2?.id, r.data);

        // Create and bind dept accounts
        r = await api(tokAdminA, 'POST', '/api/department-accounts',
            { departmentId: deptA.id, displayName: 'KitchenA Acct', loginIdentifier: 'kitchen.a5' });
        check('Setup: acct A created', !!r.data?.account?.id, r.data);
        r = await api(tokDeptA, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'kitchen.a5' });
        check('Setup: acct A bound', r.data.success === true, r.data);

        r = await api(tokAdminA, 'POST', '/api/department-accounts',
            { departmentId: deptB.id, displayName: 'BarA Acct', loginIdentifier: 'bar.a5' });
        check('Setup: acct B created', !!r.data?.account?.id, r.data);
        r = await api(tokDeptB, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'bar.a5' });
        check('Setup: acct B bound', r.data.success === true, r.data);

        // No account for deptC — it is inactive so account creation would be rejected.
        // We only need its id to test the inactive-recipient guard.

        r = await api(tokAdminB, 'POST', '/api/department-accounts',
            { departmentId: deptB2.id, displayName: 'KitchenB Acct', loginIdentifier: 'kitchen.b5' });
        check('Setup: acct B2 created', !!r.data?.account?.id, r.data);
        r = await api(tokDeptB2, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'kitchen.b5' });
        check('Setup: acct B2 bound', r.data.success === true, r.data);

        console.log('');

        // ── 11. /api/sala/token auth guard ────────────────────────────────────
        console.log('  — 11. /api/sala/token auth guard —\n');
        {
            const r1 = await api(null, 'GET', '/api/sala/token');
            check('11a. No token → 401', r1.status === 401, r1);

            const r2 = await api(tokAdminA, 'GET', '/api/sala/token');
            check('11b. Valid admin token → floor token issued', r2.data.success === true && !!r2.data.token, r2.data);
        }

        // ── 12. Floor token contains role:'floor' ─────────────────────────────
        console.log('\n  — 12. Floor token verification —\n');
        {
            const r1 = await api(tokAdminA, 'GET', '/api/sala/token');
            const token = r1.data.token;
            const parts = token.split('.');
            const payload = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
            check('12a. /api/sala/token payload has role:floor', payload.role === 'floor', payload);
            check('12b. /api/sala/token payload has correct company', payload.companyName === CO, payload);
        }

        // ── 13. /api/service/mex/floor-inbox requires floor principal ─────────
        console.log('\n  — 13. Floor inbox auth guard —\n');
        {
            const r1 = await api(null, 'GET', '/api/service/mex/floor-inbox');
            check('13a. No token → 401', r1.status === 401, r1);

            const r2 = await api(tokAdminA, 'GET', '/api/service/mex/floor-inbox');
            check('13b. Plain admin token → 403 NOT_FLOOR', r2.status === 403 && r2.data.code === 'NOT_FLOOR', r2.data);

            const r3 = await api(tokFloorA, 'GET', '/api/service/mex/floor-inbox');
            check('13c. Floor token → 200 success', r3.data.success === true, r3.data);
        }

        // ── 1. Dept → Floor allowed ───────────────────────────────────────────
        console.log('\n  — 1. Dept → Floor —\n');
        {
            const [sessA, sessFloor] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokFloorA)]);
            const [jA, jF] = await Promise.all([sessA.waitFor('joinedRoom'), sessFloor.waitFor('joinedRoom')]);
            check('1. Sessions joined', !!(jA && jF));

            sessA.send({ action: 'mexSend', to: '__sala__', body: 'Hello Floor from Kitchen' });
            const ack      = await sessA.waitFor('mexSendAck');
            const incoming = await sessFloor.waitFor('mexIncoming');

            check('1a. Dept→Floor mexSendAck success', ack?.success === true, ack);
            check('1b. Floor receives mexIncoming', !!incoming, incoming);
            check('1c. incoming.from = deptA.id (server-derived)', incoming?.from === deptA.id, incoming?.from);
            check('1d. incoming.body correct', incoming?.body === 'Hello Floor from Kitchen', incoming?.body);

            sessA.close(); sessFloor.close();
            await wait(100);
        }

        // ── 2. Floor → Dept allowed ───────────────────────────────────────────
        console.log('\n  — 2. Floor → Dept —\n');
        {
            const [sessFloor, sessB] = await Promise.all([wsConnect(tokFloorA), wsConnect(tokDeptB)]);
            const [jF, jB] = await Promise.all([sessFloor.waitFor('joinedRoom'), sessB.waitFor('joinedRoom')]);
            check('2. Sessions joined', !!(jF && jB));

            sessFloor.send({ action: 'mexSend', to: deptB.id, body: 'Hello Bar from Floor' });
            const ack      = await sessFloor.waitFor('mexSendAck');
            const incoming = await sessB.waitFor('mexIncoming');

            check('2a. Floor→Dept mexSendAck success', ack?.success === true, ack);
            check('2b. Dept receives mexIncoming', !!incoming, incoming);
            check('2c. incoming.from = __sala__ (server-derived)', incoming?.from === '__sala__', incoming?.from);
            check('2d. incoming.body correct', incoming?.body === 'Hello Bar from Floor', incoming?.body);

            sessFloor.close(); sessB.close();
            await wait(100);
        }

        // ── 3. Floor cannot spoof another company ─────────────────────────────
        console.log('\n  — 3. Cross-company Floor cannot target company A dept —\n');
        {
            const sessFloorB = await wsConnect(tokFloorB);
            await sessFloorB.waitFor('joinedRoom');

            sessFloorB.send({ action: 'mexSend', to: deptA.id, body: 'cross-company floor attempt' });
            const ack = await sessFloorB.waitFor('mexSendAck');
            check('3a. Company B Floor → Company A dept rejected', ack?.success === false && ack?.code === 'MEX_INVALID_RECIPIENT', ack);

            sessFloorB.close();
            await wait(100);
        }

        // ── 4. Dept cannot spoof Floor sender ─────────────────────────────────
        console.log('\n  — 4. Dept cannot spoof Floor sender (client from: field ignored) —\n');
        {
            const [sessA, sessFloor] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokFloorA)]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessFloor.waitFor('joinedRoom')]);

            // Dept sends with a spoofed from:'__sala__' — server must ignore it
            // The send is still allowed (dept → floor is valid), but from must be deptA.id
            sessA.send({ action: 'mexSend', to: '__sala__', body: 'spoof test', from: '__sala__' });
            const ack      = await sessA.waitFor('mexSendAck');
            const incoming = await sessFloor.waitFor('mexIncoming');

            check('4a. mexSend still succeeds (dept → floor allowed)', ack?.success === true, ack);
            check('4b. incoming.from = deptA.id (not __sala__)', incoming?.from === deptA.id, incoming?.from);

            sessA.close(); sessFloor.close();
            await wait(100);
        }

        // ── 5. Unbound socket cannot act as Floor ─────────────────────────────
        console.log('\n  — 5. Unbound socket cannot send Mex —\n');
        {
            const sessU = await wsConnect(tokUnbound);
            await sessU.waitFor('joinedRoom');

            sessU.send({ action: 'mexSend', to: deptA.id, body: 'unbound test' });
            // Server should send either error{MEX_NOT_BOUND} or mexSendAck{MEX_NOT_BOUND}
            const resp = await sessU.waitFor('error') || await sessU.waitFor('mexSendAck');
            const blocked = (resp?.code === 'MEX_NOT_BOUND') || (!resp?.success && resp?.code === 'MEX_NOT_BOUND');
            check('5a. Unbound socket → MEX_NOT_BOUND', !!blocked, resp);

            sessU.close();
            await wait(100);
        }

        // ── 5b. Floor-token socket with no dept binding but role:floor works ───
        console.log('\n  — 5b. Only role:floor grants Floor principal —\n');
        {
            // A regular admin token (no role:'floor', no boundDeptId) should be blocked
            const sessAdmin = await wsConnect(tokAdminA);
            await sessAdmin.waitFor('joinedRoom');

            sessAdmin.send({ action: 'mexSend', to: deptA.id, body: 'admin floor attempt' });
            const respE = await sessAdmin.waitFor('error');
            const respA = await sessAdmin.waitFor('mexSendAck', 500);
            const adminBlocked = (respE?.code === 'MEX_NOT_BOUND') || (!respA?.success);
            check('5b. Admin token (no role:floor) → MEX_NOT_BOUND', adminBlocked, { respE, respA });

            sessAdmin.close();
            await wait(100);
        }

        // ── 6. Cross-company Dept target rejected ─────────────────────────────
        console.log('\n  — 6. Cross-company dept target —\n');
        {
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');

            sessA.send({ action: 'mexSend', to: deptB2.id, body: 'cross-co dept target' });
            const ack = await sessA.waitFor('mexSendAck');
            check('6a. Cross-company dept target → MEX_INVALID_RECIPIENT', ack?.success === false && ack?.code === 'MEX_INVALID_RECIPIENT', ack);

            sessA.close();
            await wait(100);
        }

        // ── 7. Inactive Dept target rejected ─────────────────────────────────
        console.log('\n  — 7. Inactive dept target —\n');
        {
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');

            sessA.send({ action: 'mexSend', to: deptC.id, body: 'to inactive dept' });
            const ack = await sessA.waitFor('mexSendAck');
            check('7a. Inactive dept → MEX_INVALID_RECIPIENT', ack?.success === false && ack?.code === 'MEX_INVALID_RECIPIENT', ack);

            sessA.close();
            await wait(100);
        }

        // ── 8. Unrelated dept does NOT receive Floor message ──────────────────
        console.log('\n  — 8. Delivery isolation: unrelated dept —\n');
        {
            const [sessFloor, sessTarget, sessOther] = await Promise.all([
                wsConnect(tokFloorA), wsConnect(tokDeptA), wsConnect(tokDeptB)
            ]);
            await Promise.all([
                sessFloor.waitFor('joinedRoom'),
                sessTarget.waitFor('joinedRoom'),
                sessOther.waitFor('joinedRoom')
            ]);

            // Floor → deptA only; deptB should NOT receive it
            sessFloor.send({ action: 'mexSend', to: deptA.id, body: 'private to A only' });
            await sessFloor.waitFor('mexSendAck');
            await wait(300);

            const otherGot = sessOther.received.some(m => m.action === 'mexIncoming');
            check('8a. Unrelated dept B does NOT receive Floor→A message', !otherGot, sessOther.received);

            const targetGot = sessTarget.received.some(m => m.action === 'mexIncoming');
            check('8b. Target dept A does receive the message', targetGot, sessTarget.received);

            sessFloor.close(); sessTarget.close(); sessOther.close();
            await wait(100);
        }

        // ── 9. Unrelated Floor socket (other company) does NOT receive ─────────
        console.log('\n  — 9. Delivery isolation: wrong-company Floor —\n');
        {
            const [sessA, sessFloorA, sessFloorB] = await Promise.all([
                wsConnect(tokDeptA), wsConnect(tokFloorA), wsConnect(tokFloorB)
            ]);
            await Promise.all([
                sessA.waitFor('joinedRoom'),
                sessFloorA.waitFor('joinedRoom'),
                sessFloorB.waitFor('joinedRoom')
            ]);

            // dept A → Floor A; Floor B must NOT receive it
            sessA.send({ action: 'mexSend', to: '__sala__', body: 'for company A floor only' });
            await sessA.waitFor('mexSendAck');
            await wait(300);

            const floorBGot = sessFloorB.received.some(m => m.action === 'mexIncoming');
            check('9a. Company B Floor does NOT receive company A message', !floorBGot, sessFloorB.received);

            const floorAGot = sessFloorA.received.some(m => m.action === 'mexIncoming');
            check('9b. Company A Floor does receive the message', floorAGot, sessFloorA.received);

            sessA.close(); sessFloorA.close(); sessFloorB.close();
            await wait(100);
        }

        // ── 10. Sender does not receive self mexIncoming ──────────────────────
        console.log('\n  — 10. No self echo —\n');
        {
            const [sessFloor, sessA] = await Promise.all([wsConnect(tokFloorA), wsConnect(tokDeptA)]);
            await Promise.all([sessFloor.waitFor('joinedRoom'), sessA.waitFor('joinedRoom')]);

            sessFloor.send({ action: 'mexSend', to: deptA.id, body: 'no self echo' });
            await sessFloor.waitFor('mexSendAck');
            await wait(300);

            const selfEcho = sessFloor.received.some(m => m.action === 'mexIncoming');
            check('10a. Floor sender does NOT receive mexIncoming echo', !selfEcho, sessFloor.received);

            sessFloor.close(); sessA.close();
            await wait(100);
        }

        // ── 14. Floor inbox backfill ───────────────────────────────────────────
        console.log('\n  — 14. Floor inbox backfill (REST) —\n');
        {
            // Send a message from deptA to Floor
            const [sessA, sessFloor] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokFloorA)]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessFloor.waitFor('joinedRoom')]);
            sessA.send({ action: 'mexSend', to: '__sala__', body: 'backfill payload' });
            await sessA.waitFor('mexSendAck');
            sessA.close(); sessFloor.close();
            await wait(200);

            const inbox = await api(tokFloorA, 'GET', '/api/service/mex/floor-inbox');
            check('14a. Floor inbox returns success', inbox.data.success === true, inbox.data);
            const allMsgs = (inbox.data.conversations || []).flatMap(c => c.messages || []);
            const found   = allMsgs.find(m => m.body === 'backfill payload');
            check('14b. Floor inbox contains the sent message', !!found, allMsgs.map(m => m.body));
            check('14c. Message from = deptA.id', found?.from === deptA.id, found?.from);
        }

    } finally {
        proc.kill();
    }
}

// ─── entry ────────────────────────────────────────────────────────────────────
(async () => {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('Mex Step 5 WS tests');
    console.log('══════════════════════════════════════════════════════\n');

    try {
        await run();
    } catch (e) {
        console.error('Test runner error:', e);
        failed++;
    }

    console.log('\n──────────────────────────────────────────────────────');
    console.log(`Mex Step 5 WS tests: ${passed} passed, ${failed} failed`);
    if (!failed) console.log('✅ All Mex Step 5 WS tests passed.');
    else console.error(`❌ ${failed} test(s) failed.`);
    console.log('──────────────────────────────────────────────────────\n');
    process.exit(failed ? 1 : 0);
})();
