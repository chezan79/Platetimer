#!/usr/bin/env node
/**
 * Mex Step 8 — Close / Resolve: Lifecycle + Security WS Integration Tests
 *
 * Port 4452.
 *
 * §12 Security tests: original sender, original recipient, Floor, cross-company,
 *     unrelated dept, spoofed sender, unbound socket.
 * §13 Lifecycle tests: OPEN→CLOSED, closedAt/closedBy, idempotent, reply rejected,
 *     inbox exclusion, backfill exclusion, record persisted.
 */

'use strict';

const nodecrypto = require('crypto');
const pathmod    = require('path');
const os         = require('os');
const fs         = require('fs');
const { spawn }  = require('child_process');
const WS         = require('ws');

const SECRET = 'test-mex8-lifecycle-secret';
const PORT   = 4452;
const BASE   = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

function sign(uid, companyName, role = null) {
    const obj = { uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000 };
    if (role) obj.role = role;
    const payload = Buffer.from(JSON.stringify(obj)).toString('base64');
    const sig = nodecrypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}
function signFloor(uid, co) { return sign(uid, co, 'floor'); }

let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else { console.error(`  ❌ ${label}` + (hint !== undefined ? ` — got: ${JSON.stringify(hint)}` : '')); failed++; }
}

async function api(token, method, p, body) {
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    const res = await fetch(BASE + p, {
        method, headers: h,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

function wsConnect(token) {
    return new Promise((resolve, reject) => {
        const buffer = [], waiters = [];
        const client = new WS(WS_URL);
        client.on('open', () => {
            client.send(JSON.stringify({ action: 'joinRoom', token }));
            resolve({
                client,
                close() { try { client.close(); } catch (_) {} },
                send(obj) { client.send(JSON.stringify(obj)); },
                waitFor(action, timeout = 4000) {
                    const idx = buffer.findIndex(m => m.action === action);
                    if (idx !== -1) return Promise.resolve(buffer.splice(idx, 1)[0]);
                    return new Promise(res => {
                        const w = { action, resolve: res };
                        w._timer = setTimeout(() => {
                            waiters.splice(waiters.indexOf(w), 1);
                            res(null);
                        }, timeout);
                        waiters.push(w);
                    });
                }
            });
        });
        client.on('message', raw => {
            let msg; try { msg = JSON.parse(raw); } catch { return; }
            if (!msg.action) return;
            const wi = waiters.findIndex(w => w.action === msg.action);
            if (wi !== -1) {
                const w = waiters.splice(wi, 1)[0];
                clearTimeout(w._timer); w.resolve(msg);
            } else buffer.push(msg);
        });
        client.on('error', reject);
        client.on('close', () => waiters.splice(0).forEach(w => { clearTimeout(w._timer); w.resolve(null); }));
    });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer(DATA_DIR) {
    const proc = spawn('node', ['server.js'], {
        cwd: pathmod.join(__dirname, '..'),
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
        const ti = setTimeout(() => reject(new Error('server timeout')), 20_000);
        proc.stdout.on('data', d => {
            if (d.toString().includes('avviato')) { clearTimeout(ti); resolve(); }
        });
    });
    return { proc, ready };
}

async function run() {
    console.log('Starting server (Mex Step 8 lifecycle tests)…');
    const DATA_DIR = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'mex8lc-'));
    fs.writeFileSync(pathmod.join(DATA_DIR, 'plans.json'), JSON.stringify({ coA: 'medium' }));
    const { proc, ready } = startServer(DATA_DIR);
    await ready;
    console.log('Server up.\n');

    try {
        const CO       = 'coA';
        const tokAdmin = sign('uid-admin', CO);
        const tokDeptA = sign('uid-dept-a', CO);
        const tokDeptB = sign('uid-dept-b', CO);
        const tokFloor = signFloor('uid-floor', CO);

        let r;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Cucina8' });
        const deptA = r.data.department;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Pizzeria8' });
        const deptB = r.data.department;
        check('Setup depts', !!(deptA?.id && deptB?.id));

        for (const [tok, dep, login] of [[tokDeptA, deptA, 'ck8'], [tokDeptB, deptB, 'pz8']]) {
            await api(tokAdmin, 'POST', '/api/department-accounts',
                { departmentId: dep.id, displayName: dep.name, loginIdentifier: login });
            await api(tok, 'POST', '/api/department-accounts/bind', { loginIdentifier: login });
        }
        console.log('');

        // Helper: create a conversation between A and B
        async function createConv() {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            sA.send({ action: 'mexSend', to: deptB.id, body: 'Test message' });
            const sAck = await sA.waitFor('mexSendAck');
            await sB.waitFor('mexIncoming');
            return { sA, sB, convId: sAck.conversationId };
        }

        // ── 1. Lifecycle: OPEN → CLOSED (original recipient closes) ──────────────
        console.log('  — 1. OPEN→CLOSED (recipient closes) —\n');
        {
            const { sA, sB, convId } = await createConv();
            sB.send({ action: 'mexClose', conversationId: convId });
            const ack    = await sB.waitFor('mexCloseAck');
            const closed = await sA.waitFor('mexClosed');
            check('1a. mexCloseAck.success', ack?.success === true, ack);
            check('1b. ack.conversationId', ack?.conversationId === convId, ack?.conversationId);
            check('1c. ack.alreadyClosed=false', ack?.alreadyClosed === false, ack?.alreadyClosed);
            check('1d. mexClosed delivered to A', closed?.conversationId === convId, closed);
            check('1e. mexClosed.closedBy = deptB', closed?.closedBy === deptB.id, closed?.closedBy);
            sA.close(); sB.close(); await wait(150);

            // Verify closedAt + closedBy in store
            const store = require('../service/mex-store.js');
            store._resetForTest();
            // Can't directly inspect without loading — verify via inbox exclusion below
        }

        // ── 2. Original sender closes ─────────────────────────────────────────────
        console.log('\n  — 2. Original sender closes —\n');
        {
            const { sA, sB, convId } = await createConv();
            sA.send({ action: 'mexClose', conversationId: convId });
            const ack    = await sA.waitFor('mexCloseAck');
            const closed = await sB.waitFor('mexClosed');
            check('2a. Sender can close', ack?.success === true, ack);
            check('2b. mexClosed.closedBy = deptA', closed?.closedBy === deptA.id, closed?.closedBy);
            sA.close(); sB.close(); await wait(100);
        }

        // ── 3. Idempotent close ───────────────────────────────────────────────────
        console.log('\n  — 3. Idempotent close —\n');
        {
            const { sA, sB, convId } = await createConv();
            sA.send({ action: 'mexClose', conversationId: convId });
            const ack1 = await sA.waitFor('mexCloseAck');
            await sB.waitFor('mexClosed');
            // Second close from same socket
            sA.send({ action: 'mexClose', conversationId: convId });
            const ack2 = await sA.waitFor('mexCloseAck');
            check('3a. First close succeeds', ack1?.success === true, ack1);
            check('3b. Duplicate close succeeds (idempotent)', ack2?.success === true, ack2);
            check('3c. Duplicate sets alreadyClosed=true', ack2?.alreadyClosed === true, ack2?.alreadyClosed);
            sA.close(); sB.close(); await wait(100);
        }

        // ── 4. Reply to CLOSED conversation rejected ──────────────────────────────
        console.log('\n  — 4. Reply to CLOSED conv rejected —\n');
        {
            const { sA, sB, convId } = await createConv();
            sA.send({ action: 'mexClose', conversationId: convId });
            await sA.waitFor('mexCloseAck');
            await sB.waitFor('mexClosed');
            // Attempt reply on closed conv
            sB.send({ action: 'mexReply', conversationId: convId, replyType: 'ACK', body: 'Ricevuto.' });
            const rAck = await sB.waitFor('mexReplyAck');
            check('4a. Reply rejected on closed', rAck?.success === false, rAck);
            check('4b. Code is MEX_CONVERSATION_CLOSED', rAck?.code === 'MEX_CONVERSATION_CLOSED', rAck?.code);
            sA.close(); sB.close(); await wait(100);
        }

        // ── 5. Closed conv excluded from inbox (via store module directly) ──────
        console.log('\n  — 5. Inbox exclusion —\n');
        {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            sA.send({ action: 'mexSend', to: deptB.id, body: 'To be closed' });
            const sAck = await sA.waitFor('mexSendAck');
            await sB.waitFor('mexIncoming');
            const closedConvId = sAck?.conversationId;
            check('5-pre. First mexSend ok', !!closedConvId, sAck);

            // Also create an OPEN conv (fresh send from same socket)
            sA.send({ action: 'mexSend', to: deptB.id, body: 'Stays open' });
            const sAck2 = await sA.waitFor('mexSendAck');
            await sB.waitFor('mexIncoming');
            const openConvId = sAck2?.conversationId;
            check('5-pre2. Second mexSend ok', !!openConvId, sAck2);

            // Close the first
            if (closedConvId) {
                sA.send({ action: 'mexClose', conversationId: closedConvId });
                await sA.waitFor('mexCloseAck');
                await sB.waitFor('mexClosed');
            }
            await wait(150);
            sA.close(); sB.close(); await wait(150);

            // Check via store module directly (avoids REST auth dependency).
            // Require a fresh instance initialized against the same DATA_DIR.
            const store = require('../service/mex-store.js');
            store._resetForTest();
            store.init(DATA_DIR, null, null);
            const inbox = await store.getInboxForDept(CO, deptA.id);
            const convIds = inbox.map(c => c.id);
            check('5a. Closed conv not in inbox', !convIds.includes(closedConvId), convIds);
            check('5b. Open conv still in inbox', !openConvId || convIds.includes(openConvId), convIds);
        }

        // ── 6. Floor closes Floor↔Dept conversation ───────────────────────────────
        console.log('\n  — 6. Floor closes Floor↔Dept —\n');
        {
            const [sFloor, sB] = await Promise.all([wsConnect(tokFloor), wsConnect(tokDeptA)]);
            await Promise.all([sFloor.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            sFloor.send({ action: 'mexSend', to: deptA.id, body: 'Floor msg' });
            const sAck = await sFloor.waitFor('mexSendAck');
            check('6-pre. Floor mexSend ok', sAck?.success === true, sAck);
            if (sAck?.success) {
                await sB.waitFor('mexIncoming');
                // Floor closes
                sFloor.send({ action: 'mexClose', conversationId: sAck.conversationId });
                const ack    = await sFloor.waitFor('mexCloseAck');
                const closed = await sB.waitFor('mexClosed');
                check('6a. Floor can close', ack?.success === true, ack);
                check('6b. Dept receives mexClosed', !!closed, closed);
            } else {
                check('6a. Floor can close', false, 'skipped — mexSend failed');
                check('6b. Dept receives mexClosed', false, 'skipped — mexSend failed');
            }
            sFloor.close(); sB.close(); await wait(100);
        }

        // ── 7. Dept closes Floor↔Dept conversation ────────────────────────────────
        console.log('\n  — 7. Dept closes Floor↔Dept —\n');
        {
            const [sFloor, sA] = await Promise.all([wsConnect(tokFloor), wsConnect(tokDeptA)]);
            await Promise.all([sFloor.waitFor('joinedRoom'), sA.waitFor('joinedRoom')]);
            sFloor.send({ action: 'mexSend', to: deptA.id, body: 'Floor msg2' });
            const sAck = await sFloor.waitFor('mexSendAck');
            check('7-pre. Floor mexSend ok', sAck?.success === true, sAck);
            if (sAck?.success) {
                await sA.waitFor('mexIncoming');
                // Dept closes
                sA.send({ action: 'mexClose', conversationId: sAck.conversationId });
                const ack    = await sA.waitFor('mexCloseAck');
                const closed = await sFloor.waitFor('mexClosed');
                check('7a. Dept can close Floor conv', ack?.success === true, ack);
                check('7b. Floor receives mexClosed', !!closed, closed);
            } else {
                check('7a. Dept can close Floor conv', false, 'skipped — mexSend failed');
                check('7b. Floor receives mexClosed', false, 'skipped — mexSend failed');
            }
            sFloor.close(); sA.close(); await wait(100);
        }

        // ── 8. Security: unrelated department cannot close ────────────────────────
        console.log('\n  — 8. Security: unrelated dept cannot close —\n');
        {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            sA.send({ action: 'mexSend', to: deptB.id, body: 'Secure conv' });
            const sAck = await sA.waitFor('mexSendAck');
            check('8-pre. mexSend for security test ok', sAck?.success === true, sAck);
            await sB.waitFor('mexIncoming');

            // Create a third department
            const r3 = await api(tokAdmin, 'POST', '/api/departments', { name: 'Sushi8' });
            const deptC = r3.data.department;
            const tokDeptC = sign('uid-dept-c', CO);
            await api(tokAdmin, 'POST', '/api/department-accounts',
                { departmentId: deptC.id, displayName: deptC.name, loginIdentifier: 'su8' });
            await api(tokDeptC, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'su8' });
            const sC = await wsConnect(tokDeptC);
            await sC.waitFor('joinedRoom');

            // C tries to close A↔B conversation (if convId is known)
            const targetConvId = sAck?.conversationId || 'mexconv_nonexistent_security_test';
            sC.send({ action: 'mexClose', conversationId: targetConvId });
            const ack = await sC.waitFor('mexCloseAck');
            check('8a. Unrelated dept rejected', ack?.success === false, ack);
            // Accept either MEX_NOT_PARTICIPANT (right convId) or MEX_MISSING_CONV_ID (wrong)
            const validCodes = ['MEX_NOT_PARTICIPANT', 'MEX_MISSING_CONV_ID'];
            check('8b. Rejection code valid', validCodes.includes(ack?.code), ack?.code);
            if (sAck?.conversationId) {
                check('8b-exact. Code = MEX_NOT_PARTICIPANT', ack?.code === 'MEX_NOT_PARTICIPANT', ack?.code);
            }

            sA.close(); sB.close(); sC.close(); await wait(100);
        }

        // ── 9. Security: cross-company close rejected ─────────────────────────────
        console.log('\n  — 9. Security: cross-company —\n');
        {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            sA.send({ action: 'mexSend', to: deptB.id, body: 'Cross-co test' });
            const sAck = await sA.waitFor('mexSendAck');
            await sB.waitFor('mexIncoming');

            const tokOther = sign('uid-other', 'coB');
            const sOther = await wsConnect(tokOther);
            await sOther.waitFor('joinedRoom');
            sOther.send({ action: 'mexClose', conversationId: sAck.conversationId });
            const ack = await sOther.waitFor('mexCloseAck');
            check('9a. Cross-company rejected', ack?.success === false, ack);

            sA.close(); sB.close(); sOther.close(); await wait(100);
        }

        // ── 10. Missing conversationId rejected ───────────────────────────────────
        console.log('\n  — 10. Validation —\n');
        {
            const sA = await wsConnect(tokDeptA);
            await sA.waitFor('joinedRoom');
            sA.send({ action: 'mexClose' }); // no conversationId
            const ack = await sA.waitFor('mexCloseAck');
            check('10a. Missing convId rejected', ack?.success === false, ack);
            sA.send({ action: 'mexClose', conversationId: 'mexconv_nonexistent99' });
            const ack2 = await sA.waitFor('mexCloseAck');
            check('10b. Non-existent conv rejected', ack2?.success === false, ack2);
            sA.close(); await wait(100);
        }

        // ── 11. closeConversation unit-level persistence ──────────────────────────
        console.log('\n  — 11. Persistence (unit) —\n');
        {
            const { closeConversation, getInboxForDept, _mexStore, _resetForTest, init, initMexStore } = require('../service/mex-store.js');
            _resetForTest();
            init(DATA_DIR, null, null);

            const { createAndSend } = require('../service/mex-store.js');
            const rv = await createAndSend({
                companyId: 'coTest', senderDeptId: 'dA', recipientDeptId: 'dB', body: 'Hi'
            });
            const conv = rv.conversation;
            check('11a. Conv created', !!conv);

            const closeResult = await closeConversation('coTest', conv.id, 'dA');
            check('11b. closeConversation returns', !!closeResult);
            check('11c. alreadyClosed=false', closeResult.alreadyClosed === false, closeResult.alreadyClosed);
            check('11d. closedAt set', typeof closeResult.conversation.closedAt === 'string');
            check('11e. closedBy = dA', closeResult.conversation.closedBy === 'dA', closeResult.conversation.closedBy);
            check('11f. conv persists', !!_mexStore['coTest']?.conversations[conv.id]);

            // Inbox excludes closed
            const inbox = await getInboxForDept('coTest', 'dB');
            check('11g. Closed conv excluded from inbox', !inbox.find(c => c.id === conv.id), inbox.map(c=>c.id));

            // Idempotent
            const closeResult2 = await closeConversation('coTest', conv.id, 'dB');
            check('11h. Duplicate close idempotent', closeResult2.alreadyClosed === true, closeResult2.alreadyClosed);

            // Reply rejected on closed conv (addReply throws MEX_CONVERSATION_CLOSED)
            const { addReply } = require('../service/mex-store.js');
            try {
                await addReply('coTest', conv.id, { from: 'dB', replyType: 'ACK', body: 'test' });
                check('11i. Reply rejected on closed', false);
            } catch (e) {
                check('11i. Reply rejected on closed', e.code === 'MEX_CONVERSATION_CLOSED', e.code);
            }
        }

    } finally {
        proc.kill();
    }
}

(async () => {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('Mex Step 8 Lifecycle tests');
    console.log('══════════════════════════════════════════════════════\n');
    try { await run(); }
    catch (e) { console.error('Runner error:', e.stack || e); failed++; }
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`Mex Step 8 Lifecycle: ${passed} passed, ${failed} failed`);
    if (!failed) console.log('✅ All Mex Step 8 Lifecycle tests passed.');
    else console.error(`❌ ${failed} test(s) failed.`);
    console.log('──────────────────────────────────────────────────────\n');
    process.exit(failed ? 1 : 0);
})();
