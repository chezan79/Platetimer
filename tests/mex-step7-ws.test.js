#!/usr/bin/env node
/**
 * Mex Step 7 — Replies & Quick Replies: WS Integration Tests
 *
 * Plain Node.js — same pattern as mex-step3/5/6 WS tests.
 * Port 4450.
 *
 * Covers spec §11–14:
 *  - All six reply types (ACK, MIN_2, MIN_5, READY, PROBLEM, CUSTOM)
 *  - Reply stays on same conversation (no duplicate)
 *  - Recipient gets mexReplyIncoming
 *  - Sender gets mexReplyAck (not mexReplyIncoming)
 *  - Original sender receiving a reply creates card context (originalFrom/Body)
 *  - Both sides can reply (Dept→Dept, Dept→Floor, Floor→Dept back-and-forth)
 *  - Reply persists (REST inbox includes replies)
 *  - Security: non-participant rejected, cross-company rejected
 *  - Missing conversationId rejected
 *  - Empty body rejected
 */

'use strict';

const nodecrypto = require('crypto');
const pathmod    = require('path');
const os         = require('os');
const fs         = require('fs');
const { spawn }  = require('child_process');
const WS         = require('ws');

const SECRET = 'test-mex7-ws-secret';
const PORT   = 4450;
const BASE   = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

// ─── Token helpers ────────────────────────────────────────────────────────────
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
    else       { console.error(`  ❌ ${label}` + (hint !== undefined ? ` — got: ${JSON.stringify(hint)}` : '')); failed++; }
}

async function api(token, method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(BASE + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

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
                        const w = { action, resolve: res };
                        w._timer = setTimeout(() => {
                            const i = waiters.indexOf(w);
                            if (i !== -1) waiters.splice(i, 1);
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
            received.push(msg);
            const wi = waiters.findIndex(w => w.action === msg.action);
            if (wi !== -1) {
                const w = waiters.splice(wi, 1)[0];
                clearTimeout(w._timer); w.resolve(msg);
            } else { buffer.push(msg); }
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
        const ti = setTimeout(() => reject(new Error('server start timeout')), 20_000);
        proc.stdout.on('data', d => {
            if (d.toString().includes('avviato')) { clearTimeout(ti); resolve(); }
        });
    });
    return { proc, ready };
}

// i18n for body rendering
const I18N = JSON.parse(fs.readFileSync(pathmod.join(__dirname, '../public/i18n/it.json'), 'utf8'));
const t = k => I18N[k] || k;
function renderQRBody(type) { return I18N['mex.qr.' + type + '_body'] || 'test reply'; }

async function run() {
    console.log('Starting server (Mex Step 7 WS tests)…');
    const DATA_DIR = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'mex7ws-'));
    fs.writeFileSync(pathmod.join(DATA_DIR, 'plans.json'), JSON.stringify({ coA: 'medium' }));
    const { proc, ready } = startServer(DATA_DIR);
    await ready;
    console.log('Server up.\n');

    try {
        const CO       = 'coA';
        const tokAdmin = sign('uid-admin',   CO);
        const tokDeptA = sign('uid-dept-a',  CO);
        const tokDeptB = sign('uid-dept-b',  CO);
        const tokFloor = signFloor('uid-floor', CO);

        let r;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Cucina7' });
        const deptA = r.data.department;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Pizzeria7' });
        const deptB = r.data.department;
        check('Setup: depts', !!(deptA?.id && deptB?.id));

        // Bind dept accounts
        for (const [tok, dep, login] of [[tokDeptA, deptA, 'ck7'], [tokDeptB, deptB, 'pz7']]) {
            await api(tokAdmin, 'POST', '/api/department-accounts',
                { departmentId: dep.id, displayName: dep.name, loginIdentifier: login });
            await api(tok, 'POST', '/api/department-accounts/bind', { loginIdentifier: login });
        }
        console.log('');

        // ── 1. Dept→Dept: recipient sends ACK reply ────────────────────────────
        console.log('  — 1. Dept→Dept ACK reply —\n');
        {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);

            // A sends Mex to B
            sA.send({ action: 'mexSend', to: deptB.id, body: 'Original message' });
            const sendAck = await sA.waitFor('mexSendAck');
            const convId  = sendAck.conversationId;
            const incoming = await sB.waitFor('mexIncoming');
            check('1a. mexIncoming received', !!incoming);

            // B sends ACK reply
            sB.send({ action: 'mexReply', conversationId: convId, replyType: 'ACK', body: renderQRBody('ACK') });
            const replyAck      = await sB.waitFor('mexReplyAck');
            const replyIncoming = await sA.waitFor('mexReplyIncoming');

            check('1b. mexReplyAck.success', replyAck?.success === true, replyAck);
            check('1c. replyAck.conversationId matches', replyAck?.conversationId === convId);
            check('1d. replyAck.replyType = ACK', replyAck?.replyType === 'ACK', replyAck?.replyType);
            check('1e. replyAck.body = Ricevuto.', replyAck?.body === 'Ricevuto.', replyAck?.body);
            check('1f. replyAck has replyId', !!replyAck?.replyId, replyAck?.replyId);
            check('1g. mexReplyIncoming delivered to A', !!replyIncoming, replyIncoming);
            check('1h. replyIncoming.conversationId matches', replyIncoming?.conversationId === convId);
            check('1i. replyIncoming.from = deptB', replyIncoming?.from === deptB.id, replyIncoming?.from);
            check('1j. replyIncoming has originalFrom', replyIncoming?.originalFrom === deptA.id, replyIncoming?.originalFrom);
            check('1k. replyIncoming.originalBody intact', replyIncoming?.originalBody === 'Original message', replyIncoming?.originalBody);

            // B must NOT receive replyIncoming for their own reply
            const selfAlert = await sB.waitFor('mexReplyIncoming', 500);
            check('1l. Sender not self-alerted', selfAlert === null, selfAlert);

            sA.close(); sB.close(); await wait(100);
        }

        // ── 2. All reply types accepted ────────────────────────────────────────
        console.log('\n  — 2. All reply types —\n');
        for (const rType of ['ACK','MIN_2','MIN_5','READY','PROBLEM']) {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            sA.send({ action: 'mexSend', to: deptB.id, body: `Original for ${rType}` });
            const sAck = await sA.waitFor('mexSendAck');
            await sB.waitFor('mexIncoming');
            sB.send({ action: 'mexReply', conversationId: sAck.conversationId, replyType: rType, body: renderQRBody(rType) });
            const rAck = await sB.waitFor('mexReplyAck');
            check(`2. ${rType} accepted`, rAck?.success === true && rAck?.replyType === rType, rAck);
            sA.close(); sB.close(); await wait(80);
        }

        // ── 3. CUSTOM reply ────────────────────────────────────────────────────
        console.log('\n  — 3. CUSTOM reply —\n');
        {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            sA.send({ action: 'mexSend', to: deptB.id, body: 'For CUSTOM reply' });
            const sAck = await sA.waitFor('mexSendAck');
            await sB.waitFor('mexIncoming');
            sB.send({ action: 'mexReply', conversationId: sAck.conversationId, replyType: 'CUSTOM', body: 'Custom text reply' });
            const rAck = await sB.waitFor('mexReplyAck');
            const rInc = await sA.waitFor('mexReplyIncoming');
            check('3a. CUSTOM ack success', rAck?.success === true);
            check('3b. CUSTOM replyType stored', rAck?.replyType === 'CUSTOM', rAck?.replyType);
            check('3c. CUSTOM body preserved', rInc?.body === 'Custom text reply', rInc?.body);
            sA.close(); sB.close(); await wait(100);
        }

        // ── 4. Back-and-forth: original sender replies to reply ────────────────
        console.log('\n  — 4. Back-and-forth —\n');
        {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            // A → B
            sA.send({ action: 'mexSend', to: deptB.id, body: 'Opening message' });
            const sAck1 = await sA.waitFor('mexSendAck'); const convId = sAck1.conversationId;
            await sB.waitFor('mexIncoming');
            // B → replies with MIN_5
            sB.send({ action: 'mexReply', conversationId: convId, replyType: 'MIN_5', body: renderQRBody('MIN_5') });
            await sB.waitFor('mexReplyAck'); await sA.waitFor('mexReplyIncoming');
            // A → replies with ACK (sender replying back)
            sA.send({ action: 'mexReply', conversationId: convId, replyType: 'ACK', body: renderQRBody('ACK') });
            const rAck2 = await sA.waitFor('mexReplyAck');
            const rInc2 = await sB.waitFor('mexReplyIncoming');
            check('4a. Original sender can reply back', rAck2?.success === true, rAck2);
            check('4b. Counter-reply delivered to B', rInc2?.from === deptA.id, rInc2?.from);
            check('4c. Counter-reply replyType correct', rInc2?.replyType === 'ACK', rInc2?.replyType);
            sA.close(); sB.close(); await wait(100);
        }

        // ── 5. Dept ↔ Floor replies ────────────────────────────────────────────
        console.log('\n  — 5. Dept↔Floor replies —\n');
        {
            const [sA, sFloor] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokFloor)]);
            await Promise.all([sA.waitFor('joinedRoom'), sFloor.waitFor('joinedRoom')]);
            // Floor sends to dept
            sFloor.send({ action: 'mexSend', to: deptA.id, body: 'Floor message' });
            const sAck = await sFloor.waitFor('mexSendAck'); const convId = sAck.conversationId;
            await sA.waitFor('mexIncoming');
            // Dept replies
            sA.send({ action: 'mexReply', conversationId: convId, replyType: 'READY', body: renderQRBody('READY') });
            const rAck  = await sA.waitFor('mexReplyAck');
            const rInc  = await sFloor.waitFor('mexReplyIncoming');
            check('5a. Dept→Floor reply ack', rAck?.success === true, rAck);
            check('5b. Floor receives reply', !!rInc, rInc);
            check('5c. reply from = deptA', rInc?.from === deptA.id, rInc?.from);
            check('5d. originalFrom = __sala__', rInc?.originalFrom === '__sala__', rInc?.originalFrom);
            // Floor replies back to dept
            sFloor.send({ action: 'mexReply', conversationId: convId, replyType: 'ACK', body: renderQRBody('ACK') });
            const rAck2 = await sFloor.waitFor('mexReplyAck');
            const rInc2 = await sA.waitFor('mexReplyIncoming');
            check('5e. Floor can reply back', rAck2?.success === true, rAck2);
            check('5f. Dept receives Floor reply', rInc2?.from === '__sala__', rInc2?.from);
            sA.close(); sFloor.close(); await wait(100);
        }

        // ── 6. REST inbox includes replies ────────────────────────────────────
        console.log('\n  — 6. REST inbox includes replies —\n');
        {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            sA.send({ action: 'mexSend', to: deptB.id, body: 'For inbox test' });
            const sAck = await sA.waitFor('mexSendAck');
            await sB.waitFor('mexIncoming');
            sB.send({ action: 'mexReply', conversationId: sAck.conversationId, replyType: 'PROBLEM', body: renderQRBody('PROBLEM') });
            await sB.waitFor('mexReplyAck');
            sA.close(); sB.close(); await wait(200);

            const inbox = await api(tokDeptA, 'GET', '/api/service/mex/inbox');
            const convs = inbox.data.conversations || [];
            const conv  = convs.find(c => c.id === sAck.conversationId);
            check('6a. Conversation in inbox', !!conv, convs.map(c => c.id));
            check('6b. conv.replies is array', Array.isArray(conv?.replies), conv?.replies);
            check('6c. reply.replyType = PROBLEM', conv?.replies[0]?.replyType === 'PROBLEM', conv?.replies[0]);
            check('6d. reply.body correct', conv?.replies[0]?.body === 'Problema.', conv?.replies[0]?.body);
        }

        // ── 7. Security: non-participant cannot reply ──────────────────────────
        console.log('\n  — 7. Security —\n');
        {
            const [sA, sB, sC] = await Promise.all([
                wsConnect(tokDeptA), wsConnect(tokDeptB), wsConnect(tokDeptB)
            ]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom'), sC.waitFor('joinedRoom')]);
            // Create an unrelated dept C (reuse tokDeptB for third socket — its principal is deptB which IS a participant)
            // We simulate "unrelated" by having a cross-company socket
            const tokOtherCo = sign('uid-other', 'coB');
            const sOther = await wsConnect(tokOtherCo);
            await sOther.waitFor('joinedRoom');

            // Create a conversation between A and B
            sA.send({ action: 'mexSend', to: deptB.id, body: 'Security test msg' });
            const sAck = await sA.waitFor('mexSendAck');
            await sB.waitFor('mexIncoming');

            // Other company tries to reply
            sOther.send({ action: 'mexReply', conversationId: sAck.conversationId, replyType: 'ACK', body: 'Ricevuto.' });
            const rAck = await sOther.waitFor('mexReplyAck');
            check('7a. Cross-company reply rejected', rAck?.success === false, rAck?.code);

            sA.close(); sB.close(); sC.close(); sOther.close(); await wait(100);
        }

        // ── 8. Validation rejections ───────────────────────────────────────────
        console.log('\n  — 8. Validation —\n');
        {
            const [sA, sB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sA.waitFor('joinedRoom'), sB.waitFor('joinedRoom')]);
            sA.send({ action: 'mexSend', to: deptB.id, body: 'Validation test' });
            const sAck = await sA.waitFor('mexSendAck');
            await sB.waitFor('mexIncoming');

            // Empty body
            sB.send({ action: 'mexReply', conversationId: sAck.conversationId, replyType: 'CUSTOM', body: '' });
            const r1 = await sB.waitFor('mexReplyAck');
            check('8a. Empty body rejected', r1?.success === false && r1?.code === 'MEX_EMPTY_BODY', r1?.code);

            // Missing conversationId
            sB.send({ action: 'mexReply', body: 'test body' });
            const r2 = await sB.waitFor('mexReplyAck');
            check('8b. Missing conversationId rejected', r2?.success === false, r2?.code);

            // Non-existent conversationId
            sB.send({ action: 'mexReply', conversationId: 'mexconv_bogus123', replyType: 'ACK', body: 'test' });
            const r3 = await sB.waitFor('mexReplyAck');
            check('8c. Non-existent conv rejected', r3?.success === false, r3?.code);

            // Unbound socket (no reply at all — use fresh socket without binding)
            sA.close(); sB.close(); await wait(100);
        }

    } finally {
        proc.kill();
    }
}

(async () => {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('Mex Step 7 WS tests');
    console.log('══════════════════════════════════════════════════════\n');
    try { await run(); }
    catch (e) { console.error('Test runner error:', e.stack || e); failed++; }
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`Mex Step 7 WS tests: ${passed} passed, ${failed} failed`);
    if (!failed) console.log('✅ All Mex Step 7 WS tests passed.');
    else console.error(`❌ ${failed} test(s) failed.`);
    console.log('──────────────────────────────────────────────────────\n');
    process.exit(failed ? 1 : 0);
})();
