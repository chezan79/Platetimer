#!/usr/bin/env node
'use strict';
// tests/operations-realtime-join.test.js — Task 51: realtime task-assignment delivery.
//
// Covers the WS join/delivery chain end-to-end:
//   • joinRoom now returns an explicit { action: 'joinedRoom' } confirmation
//   • invalid/missing token joins return a structured error (no silent failure)
//   • OPS_TASK_CREATED / OPS_TASK_REASSIGNED are broadcast to the assignee's
//     company room, exactly once per event, and never to another company
//   • persisted tasks still load over HTTP (normal-refresh path unchanged)

const http   = require('http');
const crypto = require('crypto');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn } = require('child_process');
const WS     = require('ws');

const SECRET = 'test-t51-secret';
const PORT   = 4459;

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else       { console.error(`  ❌ ${label}${hint !== undefined ? ' — got: ' + JSON.stringify(hint) : ''}`); failed++; }
}

async function api(token, method, p, body) {
    return new Promise((resolve, reject) => {
        const buf = body !== undefined ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...(buf ? { 'Content-Length': Buffer.byteLength(buf) } : {})
            }
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
                catch { resolve({ status: res.statusCode, data: d }); }
            });
        });
        req.on('error', reject);
        if (buf) req.write(buf);
        req.end();
    });
}

// WS helper with consume-semantics waitFor() (same pattern as sprint5 tests).
function wsConnect(token, { sendJoin = true } = {}) {
    return new Promise((resolve, reject) => {
        const buffer  = [];
        const waiters = [];
        const received = [];
        const client = new WS(`ws://127.0.0.1:${PORT}/ws`);

        client.on('open', () => {
            if (sendJoin) {
                client.send(JSON.stringify({ action: 'joinRoom', token }));
                client.send(JSON.stringify({ action: 'joinPage', pageType: 'operations' }));
            }
            resolve({
                client, received,
                send(obj) { client.send(JSON.stringify(obj)); },
                close() { try { client.close(); } catch (_) {} },
                waitFor(action, timeout = 3000) {
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

        client.on('message', data => {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }
            if (!msg.action) return;
            received.push(msg);
            const wi = waiters.findIndex(w => w.action === msg.action);
            if (wi !== -1) {
                const waiter = waiters.splice(wi, 1)[0];
                clearTimeout(waiter._timer);
                waiter.resolve(msg);
            } else buffer.push(msg);
        });

        client.on('error', reject);
        client.on('close', () => {
            waiters.splice(0).forEach(w => { clearTimeout(w._timer); w.resolve(null); });
        });
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
    console.log('Starting server (Task 51 realtime join tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstest-t51-'));
    const proc = spawn('node', ['server.js'], {
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
    proc.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 20_000);
        proc.stdout.on('data', d => {
            if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(); }
        });
        proc.on('exit', code => { clearTimeout(t); reject(new Error(`Server exited: ${code}`)); });
    });
    console.log('Server up.\n');

    try {
        const coA  = 'T51_A_' + crypto.randomBytes(3).toString('hex');
        const coB  = 'T51_B_' + crypto.randomBytes(3).toString('hex');
        const dirA = sign('t51-dir-a', coA);
        const asgA = sign('t51-asg-a', coA);   // assignee in company A
        const dirB = sign('t51-dir-b', coB);

        // Bootstrap ops records
        let r = await api(dirA, 'GET', '/api/operations/me');
        check('T51-0. Director A bootstrapped', r.data.success);
        const dirAId = r.data.user.id;

        // Create the assignee as a team member of company A
        r = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Assignee One', email: 'asg@t51.test', role: 'SOUS_CHEF'
        });
        check('T51-1. Assignee user created', r.data.success, r.data);
        const asgId = r.data.user && r.data.user.id;

        r = await api(dirB, 'GET', '/api/operations/me');
        check('T51-2. Director B bootstrapped (other company)', r.data.success);

        // ── 1. Join confirmation ─────────────────────────────────────────────
        const wsAsg = await wsConnect(dirA); // assignee-company client
        const joinedMsg = await wsAsg.waitFor('joinedRoom');
        check('T51-3. Server sends explicit joinedRoom confirmation', !!joinedMsg, joinedMsg);
        check('T51-4. joinedRoom carries success:true', joinedMsg && joinedMsg.success === true);

        const wsB = await wsConnect(dirB);
        await wsB.waitFor('joinedRoom');
        await sleep(150);

        // ── 2. Rejected join is NOT silent ───────────────────────────────────
        const wsBad = await wsConnect('not-a-valid-token');
        const errMsg = await wsBad.waitFor('error');
        check('T51-5. Invalid token join returns structured error', !!errMsg, errMsg);
        check('T51-6. Error code is TOKEN_INVALID', errMsg && errMsg.code === 'TOKEN_INVALID');
        check('T51-7. No joinedRoom sent to rejected client',
            !wsBad.received.some(m => m.action === 'joinedRoom'));
        wsBad.close();

        const wsNoTok = await wsConnect(null, { sendJoin: false });
        wsNoTok.send({ action: 'joinRoom' });
        const errMsg2 = await wsNoTok.waitFor('error');
        check('T51-8. Missing token join returns TOKEN_REQUIRED',
            errMsg2 && errMsg2.code === 'TOKEN_REQUIRED', errMsg2);
        wsNoTok.close();

        // ── 3. Assignment broadcast reaches assignee's company, not company B ─
        const [evtCreated] = await Promise.all([
            wsAsg.waitFor('OPS_TASK_CREATED'),
            api(dirA, 'POST', '/api/operations/tasks', {
                title: 'T51 Assignment', assigneeId: asgId,
                priority: 'HIGH', dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
            })
        ]);
        check('T51-9. OPS_TASK_CREATED received in assignee company', !!evtCreated, evtCreated);
        check('T51-10. Event carries the task with correct assignee',
            evtCreated && evtCreated.task && evtCreated.task.assigneeId === asgId);
        const taskId = evtCreated && evtCreated.task && evtCreated.task.id;

        // ── 4. Reassignment broadcast ────────────────────────────────────────
        const [evtReassigned] = await Promise.all([
            wsAsg.waitFor('OPS_TASK_REASSIGNED'),
            api(dirA, 'POST', `/api/operations/tasks/${taskId}/reassign`, { assigneeId: dirAId })
        ]);
        check('T51-11. OPS_TASK_REASSIGNED received', !!evtReassigned, evtReassigned);
        check('T51-12. Reassign event carries prevAssigneeId',
            evtReassigned && evtReassigned.prevAssigneeId === asgId);

        await sleep(300);
        // ── 5. Company isolation ─────────────────────────────────────────────
        check('T51-13. Company B received zero OPS events',
            !wsB.received.some(m => m.action && m.action.startsWith('OPS_')),
            wsB.received.map(m => m.action));

        // ── 6. No duplicate broadcasts per event ─────────────────────────────
        const createdCount = wsAsg.received.filter(m => m.action === 'OPS_TASK_CREATED').length;
        const reassignedCount = wsAsg.received.filter(m => m.action === 'OPS_TASK_REASSIGNED').length;
        check('T51-14. Exactly one OPS_TASK_CREATED broadcast', createdCount === 1, createdCount);
        check('T51-15. Exactly one OPS_TASK_REASSIGNED broadcast', reassignedCount === 1, reassignedCount);

        // ── 7. Re-join (reconnect) still confirmed and delivers events ───────
        wsAsg.close();
        await sleep(100);
        const wsAsg2 = await wsConnect(dirA);
        const rejoin = await wsAsg2.waitFor('joinedRoom');
        check('T51-16. Reconnect re-join confirmed', !!rejoin);
        const [evtCreated2] = await Promise.all([
            wsAsg2.waitFor('OPS_TASK_CREATED'),
            api(dirA, 'POST', '/api/operations/tasks', {
                title: 'T51 Second', assigneeId: asgId,
                priority: 'LOW', dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
            })
        ]);
        check('T51-17. Events delivered after reconnect', !!evtCreated2);

        // ── 8. HTTP path unchanged: persisted tasks load on normal refresh ───
        r = await api(dirA, 'GET', '/api/operations/tasks');
        check('T51-18. HTTP task list still loads', r.data.success === true);
        const titles = (r.data.tasks || []).map(t => t.title);
        check('T51-19. Both tasks persisted and returned',
            titles.includes('T51 Assignment') && titles.includes('T51 Second'), titles);
        check('T51-20. No duplicate task records over HTTP',
            titles.filter(t => t === 'T51 Assignment').length === 1, titles);

        wsAsg2.close(); wsB.close();
    } finally {
        proc.kill();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
