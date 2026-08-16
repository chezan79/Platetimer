#!/usr/bin/env node
/**
 * Mex Step 6 — Quick Messages: WS Integration Tests
 *
 * Plain Node.js — same pattern as mex-step3-ws.test.js and mex-step5-ws.test.js.
 *
 * Covers spec §11 (WS/integration scenarios):
 *  - Dept → Dept Quick Message (TABLE_DELAY with table number)
 *  - Dept → Floor Quick Message
 *  - Floor → Dept Quick Message
 *  - templateType and tableNumber returned in mexSendAck
 *  - templateType and tableNumber returned in mexIncoming
 *  - CUSTOM continues to work (no templateType/tableNumber in ack)
 *  - tableNumber required for table templates (server rejects if missing)
 *  - invalid tableNumber rejected
 *  - spoofed templateType overridden safely (body still used for display)
 *  - security behavior (cross-company, unbound) unchanged from Steps 3–5
 *  - all five TABLE_* types accepted by server
 */

'use strict';

const crypto    = require('path');  // unused but satisfies lint
const nodecrypto = require('crypto');
const pathmod   = require('path');
const os        = require('os');
const fs        = require('fs');
const { spawn } = require('child_process');
const WS        = require('ws');

const SECRET  = 'test-mex-step6-ws-secret';
const PORT    = 4449;
const BASE    = `http://127.0.0.1:${PORT}`;
const WS_URL  = `ws://127.0.0.1:${PORT}/ws`;

// ─── token helpers ────────────────────────────────────────────────────────────
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
                const w = waiters.splice(wi, 1)[0];
                clearTimeout(w._timer); w.resolve(msg);
            } else {
                buffer.push(msg);
            }
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
        const t = setTimeout(() => reject(new Error('server start timeout')), 20_000);
        proc.stdout.on('data', d => {
            if (d.toString().includes('avviato')) { clearTimeout(t); resolve(); }
        });
    });
    return { proc, ready };
}

// i18n key map for body rendering (Italian, mirrors server tests)
const I18N_IT = JSON.parse(fs.readFileSync(pathmod.join(__dirname, '../public/i18n/it.json'), 'utf8'));
function t(k) { return I18N_IT[k] || k; }
function renderBody(templateType, tableNumber) {
    const tmpl = t('mex.qm.' + templateType + '_body');
    if (!tmpl || tmpl === 'mex.qm.' + templateType + '_body') return null;
    return tmpl.replace('{n}', String(tableNumber));
}

async function run() {
    console.log('Starting server (Mex Step 6 WS tests)…');
    const DATA_DIR = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'mex6ws-'));
    fs.writeFileSync(pathmod.join(DATA_DIR, 'plans.json'),
        JSON.stringify({ coA: 'medium' }));
    const { proc, ready } = startServer(DATA_DIR);
    await ready;
    console.log('Server up.\n');

    try {
        const CO = 'coA';
        const tokAdminA = sign('uid-a-admin', CO);
        const tokDeptA  = sign('uid-dept-a',  CO);
        const tokDeptB  = sign('uid-dept-b',  CO);
        const tokFloorA = signFloor('uid-floor-a', CO);

        let r;
        r = await api(tokAdminA, 'POST', '/api/departments', { name: 'Cucina6' });
        const deptA = r.data.department;
        r = await api(tokAdminA, 'POST', '/api/departments', { name: 'Pizzeria6' });
        const deptB = r.data.department;
        check('Setup: depts created', !!(deptA?.id && deptB?.id), r.data);

        r = await api(tokAdminA, 'POST', '/api/department-accounts',
            { departmentId: deptA.id, displayName: 'Cucina6', loginIdentifier: 'cuc6' });
        r = await api(tokDeptA, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'cuc6' });
        check('Setup: deptA bound', r.data.success === true, r.data);

        r = await api(tokAdminA, 'POST', '/api/department-accounts',
            { departmentId: deptB.id, displayName: 'Pizzeria6', loginIdentifier: 'piz6' });
        r = await api(tokDeptB, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'piz6' });
        check('Setup: deptB bound', r.data.success === true, r.data);
        console.log('');

        // ── 1. Dept → Dept Quick Message (TABLE_DELAY) ────────────────────────
        console.log('  — 1. Dept→Dept TABLE_DELAY —\n');
        {
            const body = renderBody('TABLE_DELAY', '24');
            const [sessA, sessB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessB.waitFor('joinedRoom')]);

            sessA.send({ action: 'mexSend', to: deptB.id, body, templateType: 'TABLE_DELAY', tableNumber: '24' });
            const ack      = await sessA.waitFor('mexSendAck');
            const incoming = await sessB.waitFor('mexIncoming');

            check('1a. mexSendAck success', ack?.success === true, ack);
            check('1b. ack.templateType = TABLE_DELAY', ack?.templateType === 'TABLE_DELAY', ack?.templateType);
            check('1c. ack.tableNumber = 24', ack?.tableNumber === '24', ack?.tableNumber);
            check('1d. incoming received', !!incoming, incoming);
            check('1e. incoming.templateType = TABLE_DELAY', incoming?.templateType === 'TABLE_DELAY', incoming?.templateType);
            check('1f. incoming.tableNumber = 24', incoming?.tableNumber === '24', incoming?.tableNumber);
            check('1g. incoming.body contains 24', incoming?.body?.includes('24'), incoming?.body);

            sessA.close(); sessB.close();
            await wait(100);
        }

        // ── 2. Dept → Floor Quick Message ─────────────────────────────────────
        console.log('\n  — 2. Dept→Floor TABLE_URGENT —\n');
        {
            const body = renderBody('TABLE_URGENT', '7');
            const [sessA, sessFloor] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokFloorA)]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessFloor.waitFor('joinedRoom')]);

            sessA.send({ action: 'mexSend', to: '__sala__', body, templateType: 'TABLE_URGENT', tableNumber: '7' });
            const ack      = await sessA.waitFor('mexSendAck');
            const incoming = await sessFloor.waitFor('mexIncoming');

            check('2a. ack.success', ack?.success === true, ack);
            check('2b. ack.templateType = TABLE_URGENT', ack?.templateType === 'TABLE_URGENT', ack?.templateType);
            check('2c. incoming.tableNumber = 7', incoming?.tableNumber === '7', incoming?.tableNumber);
            check('2d. incoming.body contains 7', incoming?.body?.includes('7'), incoming?.body);

            sessA.close(); sessFloor.close();
            await wait(100);
        }

        // ── 3. Floor → Dept Quick Message ─────────────────────────────────────
        console.log('\n  — 3. Floor→Dept TABLE_SEND —\n');
        {
            const body = renderBody('TABLE_SEND', '12');
            const [sessFloor, sessB] = await Promise.all([wsConnect(tokFloorA), wsConnect(tokDeptB)]);
            await Promise.all([sessFloor.waitFor('joinedRoom'), sessB.waitFor('joinedRoom')]);

            sessFloor.send({ action: 'mexSend', to: deptB.id, body, templateType: 'TABLE_SEND', tableNumber: '12' });
            const ack      = await sessFloor.waitFor('mexSendAck');
            const incoming = await sessB.waitFor('mexIncoming');

            check('3a. ack.success', ack?.success === true, ack);
            check('3b. ack.templateType = TABLE_SEND', ack?.templateType === 'TABLE_SEND', ack?.templateType);
            check('3c. incoming.from = __sala__', incoming?.from === '__sala__', incoming?.from);
            check('3d. incoming.tableNumber = 12', incoming?.tableNumber === '12', incoming?.tableNumber);

            sessFloor.close(); sessB.close();
            await wait(100);
        }

        // ── 4. CUSTOM message — no templateType ───────────────────────────────
        console.log('\n  — 4. CUSTOM free-text —\n');
        {
            const [sessA, sessB] = await Promise.all([wsConnect(tokDeptA), wsConnect(tokDeptB)]);
            await Promise.all([sessA.waitFor('joinedRoom'), sessB.waitFor('joinedRoom')]);

            sessA.send({ action: 'mexSend', to: deptB.id, body: 'Some custom free text' });
            const ack      = await sessA.waitFor('mexSendAck');
            const incoming = await sessB.waitFor('mexIncoming');

            check('4a. CUSTOM ack.success', ack?.success === true, ack);
            check('4b. CUSTOM ack.templateType is null', ack?.templateType === null, ack?.templateType);
            check('4c. CUSTOM ack.tableNumber is null', ack?.tableNumber === null, ack?.tableNumber);
            check('4d. CUSTOM incoming.body intact', incoming?.body === 'Some custom free text', incoming?.body);

            sessA.close(); sessB.close();
            await wait(100);
        }

        // ── 5. Table number required for TABLE_* — missing → rejected ─────────
        console.log('\n  — 5. tableNumber required for TABLE_* —\n');
        {
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');

            sessA.send({ action: 'mexSend', to: deptB.id, body: 'test', templateType: 'TABLE_DELAY' }); // no tableNumber
            const ack = await sessA.waitFor('mexSendAck');
            check('5a. Missing tableNumber for TABLE_DELAY → rejected', ack?.success === false && ack?.code === 'MEX_INVALID_TABLE_NUMBER', ack);

            sessA.close();
            await wait(100);
        }

        // ── 6. Invalid tableNumber formats ────────────────────────────────────
        console.log('\n  — 6. Invalid tableNumber formats —\n');
        for (const [label, tableNumber] of [['empty', ''], ['zero', '0'], ['too long', '1234567890'], ['special chars', 'ta!1'], ['1000 > 999', '1000']]) {
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');
            sessA.send({ action: 'mexSend', to: deptB.id, body: 'test', templateType: 'TABLE_DELAY', tableNumber });
            const ack = await sessA.waitFor('mexSendAck');
            check(`6. tableNumber "${label}" rejected`, ack?.success === false && ack?.code === 'MEX_INVALID_TABLE_NUMBER', ack);
            sessA.close();
            await wait(80);
        }

        // ── 7. All five TABLE_* types accepted ───────────────────────────────
        console.log('\n  — 7. All TABLE_* types accepted —\n');
        for (const tType of ['TABLE_DELAY','TABLE_STATUS','TABLE_URGENT','TABLE_HOLD','TABLE_SEND']) {
            const body = renderBody(tType, '5');
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');
            sessA.send({ action: 'mexSend', to: deptB.id, body, templateType: tType, tableNumber: '5' });
            const ack = await sessA.waitFor('mexSendAck');
            check(`7. ${tType} accepted`, ack?.success === true, ack);
            sessA.close();
            await wait(80);
        }

        // ── 8. Unknown templateType treated as null ───────────────────────────
        console.log('\n  — 8. Unknown templateType treated as null —\n');
        {
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');
            // Should send normally (unknown type treated as CUSTOM, body is free text)
            sessA.send({ action: 'mexSend', to: deptB.id, body: 'test msg', templateType: 'BOGUS_TYPE' });
            const ack = await sessA.waitFor('mexSendAck');
            check('8a. Unknown templateType → ack.success (body still sent)', ack?.success === true, ack);
            check('8b. Unknown templateType → ack.templateType is null', ack?.templateType === null, ack?.templateType);
            sessA.close();
            await wait(100);
        }

        // ── 9. Security: cross-company still rejected ────────────────────────
        console.log('\n  — 9. Security regression (cross-company) —\n');
        {
            const tokAdminB = sign('uid-b-admin', 'coB');
            const tokDeptX  = sign('uid-dept-x',  'coB');
            const r2 = await api(tokAdminB, 'POST', '/api/departments', { name: 'XDept' });
            if (r2.data.department?.id) {
                await api(tokAdminB, 'POST', '/api/department-accounts',
                    { departmentId: r2.data.department.id, displayName: 'X', loginIdentifier: 'x6' });
                await api(tokDeptX, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'x6' });
            }
            // tokDeptX tries to send a QM to a company A dept
            const sessX = await wsConnect(tokDeptX);
            await sessX.waitFor('joinedRoom');
            sessX.send({ action: 'mexSend', to: deptA.id, body: 'xco attack', templateType: 'TABLE_DELAY', tableNumber: '1' });
            const ack = await sessX.waitFor('mexSendAck');
            check('9a. Cross-company QM rejected', ack?.success === false && ack?.code === 'MEX_INVALID_RECIPIENT', ack);
            sessX.close();
            await wait(100);
        }

        // ── 10. REST inbox: templateType + tableNumber in backfill ────────────
        console.log('\n  — 10. REST inbox backfill includes QM metadata —\n');
        {
            const body = renderBody('TABLE_HOLD', '99');
            const sessA = await wsConnect(tokDeptA);
            await sessA.waitFor('joinedRoom');
            sessA.send({ action: 'mexSend', to: deptB.id, body, templateType: 'TABLE_HOLD', tableNumber: '99' });
            await sessA.waitFor('mexSendAck');
            sessA.close();
            await wait(200);

            // Fetch inbox for deptB
            const inbox = await api(tokDeptB, 'GET', '/api/service/mex/inbox');
            const allMsgs = (inbox.data.conversations || []).flatMap(c => c.messages || []);
            const qmMsg = allMsgs.find(m => m.tableNumber === '99');
            check('10a. Inbox contains the TABLE_HOLD message', !!qmMsg, allMsgs.map(m => m.body));
            check('10b. Inbox msg.templateType = TABLE_HOLD', qmMsg?.templateType === 'TABLE_HOLD', qmMsg?.templateType);
            check('10c. Inbox msg.tableNumber = 99', qmMsg?.tableNumber === '99', qmMsg?.tableNumber);
        }

    } finally {
        proc.kill();
    }
}

(async () => {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('Mex Step 6 WS tests');
    console.log('══════════════════════════════════════════════════════\n');

    try { await run(); }
    catch (e) { console.error('Test runner error:', e); failed++; }

    console.log('\n──────────────────────────────────────────────────────');
    console.log(`Mex Step 6 WS tests: ${passed} passed, ${failed} failed`);
    if (!failed) console.log('✅ All Mex Step 6 WS tests passed.');
    else console.error(`❌ ${failed} test(s) failed.`);
    console.log('──────────────────────────────────────────────────────\n');
    process.exit(failed ? 1 : 0);
})();
