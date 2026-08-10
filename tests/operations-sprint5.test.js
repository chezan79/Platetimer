#!/usr/bin/env node
'use strict';
// tests/operations-sprint5.test.js — Sprint 5: real-time WebSocket broadcast tests.
//
// Verifies that every Operations mutation emits the correct OPS_* event
// to all authenticated clients in the same company room, with correct
// company isolation (other companies receive nothing).
//
// Uses the `ws` npm package (already in package.json) to open real WS connections.
// All HTTP calls use the Director token; WS connections join via the same HMAC mechanism.

const http   = require('http');
const crypto = require('crypto');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn } = require('child_process');
const WS     = require('ws');

const SECRET = 'test-sprint5-secret';
const PORT   = 4458;

// ── HMAC token helper ────────────────────────────────────────────────────────
function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

// ── Result tracking ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else       { console.error(`  ❌ ${label}${hint !== undefined ? ' — got: ' + JSON.stringify(hint) : ''}`); failed++; }
}

// ── HTTP helper ──────────────────────────────────────────────────────────────
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

// ── WebSocket helper ──────────────────────────────────────────────────────────
// Opens a WS connection, authenticates with joinRoom, and returns a subscription
// object with: received[] array and waitFor(action, timeout) promise helper.
//
// waitFor() uses CONSUME semantics: the first matching buffered message is
// removed from the buffer and returned. This prevents stale events from an
// earlier operation from satisfying a later waitFor() for the same action type.
function wsConnect(token) {
    return new Promise((resolve, reject) => {
        // buffer: unmatched messages waiting for a waitFor() call
        const buffer  = [];
        // waiters: pending waitFor() calls waiting for a not-yet-arrived message
        const waiters = [];
        // allReceived: never shrinks — used for assertions about overall counts
        const received = [];

        const client = new WS(`ws://127.0.0.1:${PORT}/ws`);

        client.on('open', () => {
            client.send(JSON.stringify({ action: 'joinRoom', token }));
            client.send(JSON.stringify({ action: 'joinPage', pageType: 'operations' }));
            resolve({
                client,
                received,       // full history, never consumed
                close() { try { client.close(); } catch (_) {} },

                // Wait for the NEXT occurrence of `action` (skips already-consumed messages).
                // Resolves with the message, or null on timeout.
                waitFor(action, timeout = 3000) {
                    // Look in buffer for an unconsumed matching message
                    const idx = buffer.findIndex(m => m.action === action);
                    if (idx !== -1) {
                        const [msg] = buffer.splice(idx, 1); // consume it
                        return Promise.resolve(msg);
                    }
                    // Not yet arrived — register a waiter
                    return new Promise(res => {
                        const waiter = { action, resolve: res };
                        const t = setTimeout(() => {
                            const i = waiters.indexOf(waiter);
                            if (i !== -1) waiters.splice(i, 1);
                            res(null);
                        }, timeout);
                        waiter._timer = t;
                        waiters.push(waiter);
                    });
                }
            });
        });

        client.on('message', data => {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }
            if (!msg.action) return;
            received.push(msg); // always keep full history

            // Route: if a waiter is pending for this action, deliver directly (consume)
            const wi = waiters.findIndex(w => w.action === msg.action);
            if (wi !== -1) {
                const waiter = waiters.splice(wi, 1)[0];
                clearTimeout(waiter._timer);
                waiter.resolve(msg);
            } else {
                // No waiter yet — buffer for a future waitFor()
                buffer.push(msg);
            }
        });

        client.on('error', reject);
        client.on('close', () => {
            waiters.splice(0).forEach(w => { clearTimeout(w._timer); w.resolve(null); });
        });
    });
}

// ── Wait helper for async test state ─────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main test runner ─────────────────────────────────────────────────────────
async function run() {
    console.log('Starting server (Sprint 5 real-time tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstest-s5-'));
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
    console.log('Server up. Running Sprint 5 real-time checks…\n');

    // Two companies for isolation tests
    const coA  = 'RT_A_' + crypto.randomBytes(3).toString('hex');
    const coB  = 'RT_B_' + crypto.randomBytes(3).toString('hex');
    const dirA = sign('rt-dir-a', coA);
    const dirB = sign('rt-dir-b', coB);

    // Bootstrap directors via HTTP (creates their ops records)
    let r = await api(dirA, 'GET', '/api/operations/me');
    check('S5-0. Director A bootstrapped', r.data.success);
    const dirAId = r.data.user.id;

    r = await api(dirB, 'GET', '/api/operations/me');
    check('S5-1. Director B bootstrapped (isolation company)', r.data.success);

    // ── Open WebSocket connections ────────────────────────────────────────────
    // Two tabs for company A (multi-tab sync test), one for company B (isolation)
    const wsA1 = await wsConnect(dirA);  // company A, tab 1
    const wsA2 = await wsConnect(dirA);  // company A, tab 2
    const wsB  = await wsConnect(dirB);  // company B (should receive nothing from A)
    await sleep(200); // let joinRoom propagate

    // ── Invite a team member → OPS_USER_CREATED ─────────────────────────────
    const [evtCreated1, evtCreated2] = await Promise.all([
        wsA1.waitFor('OPS_USER_CREATED'),
        wsA2.waitFor('OPS_USER_CREATED'),
        api(dirA, 'POST', '/api/operations/users', {
            name: 'SC Test RT', email: `sc_rt_${crypto.randomBytes(2).toString('hex')}@rt.it`, role: 'SOUS_CHEF'
        })
    ]);
    check('S5-2. OPS_USER_CREATED received by tab 1', !!evtCreated1, evtCreated1);
    check('S5-3. OPS_USER_CREATED received by tab 2 (multi-tab sync)', !!evtCreated2, evtCreated2);
    check('S5-4. OPS_USER_CREATED not received by company B (isolation)',
        !wsB.received.some(m => m.action === 'OPS_USER_CREATED'));

    const invitedUserId = evtCreated1 && evtCreated1.user && evtCreated1.user.id;
    check('S5-5. OPS_USER_CREATED carries user object', !!invitedUserId);

    // ── Edit user → OPS_USER_UPDATED ─────────────────────────────────────────
    if (invitedUserId) {
        const [evtUpdated] = await Promise.all([
            wsA1.waitFor('OPS_USER_UPDATED'),
            api(dirA, 'PUT', `/api/operations/users/${invitedUserId}`, { name: 'SC Test RT v2' })
        ]);
        check('S5-6. OPS_USER_UPDATED received after PUT user', !!evtUpdated, evtUpdated);
        check('S5-7. OPS_USER_UPDATED carries updated name', evtUpdated && evtUpdated.user && evtUpdated.user.name === 'SC Test RT v2');
    }

    // Invite a second user to use as suspend/archive target
    r = await api(dirA, 'POST', '/api/operations/users', {
        name: 'CdB Target', email: `cdb_${crypto.randomBytes(2).toString('hex')}@rt.it`, role: 'CHEF_DE_BRIGADE'
    });
    const targetId = r.data.user && r.data.user.id;
    check('S5-8. Second test user invited', !!targetId);
    // drain the OPS_USER_CREATED event
    await wsA1.waitFor('OPS_USER_CREATED');

    // ── Suspend → OPS_USER_SUSPENDED ─────────────────────────────────────────
    if (targetId) {
        const [evtSuspended] = await Promise.all([
            wsA1.waitFor('OPS_USER_SUSPENDED'),
            api(dirA, 'POST', `/api/operations/users/${targetId}/suspend`, {})
        ]);
        check('S5-9. OPS_USER_SUSPENDED received', !!evtSuspended, evtSuspended);
        check('S5-10. OPS_USER_SUSPENDED carries SUSPENDED status',
            evtSuspended && evtSuspended.user && evtSuspended.user.status === 'SUSPENDED');

        // ── Reactivate → OPS_USER_RESTORED ───────────────────────────────────
        const [evtRestored] = await Promise.all([
            wsA1.waitFor('OPS_USER_RESTORED'),
            api(dirA, 'POST', `/api/operations/users/${targetId}/reactivate`, {})
        ]);
        check('S5-11. OPS_USER_RESTORED received after reactivate', !!evtRestored, evtRestored);
        check('S5-12. OPS_USER_RESTORED carries ACTIVE status',
            evtRestored && evtRestored.user && evtRestored.user.status === 'ACTIVE');

        // ── Archive → OPS_USER_ARCHIVED ──────────────────────────────────────
        const [evtArchived] = await Promise.all([
            wsA1.waitFor('OPS_USER_ARCHIVED'),
            api(dirA, 'POST', `/api/operations/users/${targetId}/archive`, {})
        ]);
        check('S5-13. OPS_USER_ARCHIVED received', !!evtArchived, evtArchived);

        // ── Restore from archive → OPS_USER_RESTORED ─────────────────────────
        const [evtRestoredFromArchive] = await Promise.all([
            wsA1.waitFor('OPS_USER_RESTORED'),
            api(dirA, 'POST', `/api/operations/users/${targetId}/restore`, {})
        ]);
        check('S5-14. OPS_USER_RESTORED received after restore from archive', !!evtRestoredFromArchive, evtRestoredFromArchive);

        // ── Delete → OPS_USER_DELETED ─────────────────────────────────────────
        // Target has no tasks, so deletion is allowed
        const wsA1snap = wsA1.received.length;
        const [evtDeleted] = await Promise.all([
            wsA1.waitFor('OPS_USER_DELETED'),
            api(dirA, 'DELETE', `/api/operations/users/${targetId}`)
        ]);
        check('S5-15. OPS_USER_DELETED received', !!evtDeleted, evtDeleted);
        check('S5-16. OPS_USER_DELETED carries userId', evtDeleted && evtDeleted.userId === targetId);
    }

    // ── Create task → OPS_TASK_CREATED ────────────────────────────────────────
    const [evtTaskCreated] = await Promise.all([
        wsA1.waitFor('OPS_TASK_CREATED'),
        api(dirA, 'POST', '/api/operations/tasks', {
            title: 'RT Task Alpha', assigneeId: dirAId,
            priority: 'MEDIUM', dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
        })
    ]);
    check('S5-17. OPS_TASK_CREATED received', !!evtTaskCreated, evtTaskCreated);
    check('S5-18. OPS_TASK_CREATED carries task object', evtTaskCreated && !!evtTaskCreated.task);
    const taskId = evtTaskCreated && evtTaskCreated.task && evtTaskCreated.task.id;
    check('S5-19. OPS_TASK_CREATED not received by company B', !wsB.received.some(m => m.action === 'OPS_TASK_CREATED'));

    if (taskId) {
        // ── Start task → OPS_TASK_UPDATED (status=IN_PROGRESS) ───────────────
        const [evtStarted] = await Promise.all([
            wsA1.waitFor('OPS_TASK_UPDATED'),
            api(dirA, 'POST', `/api/operations/tasks/${taskId}/start`, {})
        ]);
        check('S5-20. OPS_TASK_UPDATED received on start', !!evtStarted, evtStarted);
        check('S5-21. task.status = IN_PROGRESS after start',
            evtStarted && evtStarted.task && evtStarted.task.status === 'IN_PROGRESS');

        // ── Progress update → OPS_TASK_PROGRESS ──────────────────────────────
        const [evtProgress] = await Promise.all([
            wsA1.waitFor('OPS_TASK_PROGRESS'),
            api(dirA, 'POST', `/api/operations/tasks/${taskId}/progress`, { completionPercent: 50 })
        ]);
        check('S5-22. OPS_TASK_PROGRESS received', !!evtProgress, evtProgress);
        check('S5-23. task.completionPercent = 50', evtProgress && evtProgress.task && evtProgress.task.completionPercent === 50);

        // ── Complete task → OPS_TASK_COMPLETED ───────────────────────────────
        const [evtCompleted1, evtCompleted2] = await Promise.all([
            wsA1.waitFor('OPS_TASK_COMPLETED'),
            wsA2.waitFor('OPS_TASK_COMPLETED'),
            api(dirA, 'POST', `/api/operations/tasks/${taskId}/complete`, {})
        ]);
        check('S5-24. OPS_TASK_COMPLETED received by tab 1', !!evtCompleted1, evtCompleted1);
        check('S5-25. OPS_TASK_COMPLETED received by tab 2 (multi-tab)', !!evtCompleted2, evtCompleted2);
        check('S5-26. task.status = COMPLETED', evtCompleted1 && evtCompleted1.task && evtCompleted1.task.status === 'COMPLETED');
        check('S5-27. OPS_TASK_COMPLETED not received by company B', !wsB.received.some(m => m.action === 'OPS_TASK_COMPLETED'));
    }

    // ── Create second task for comment + reassign + cancel tests ─────────────
    r = await api(dirA, 'POST', '/api/operations/tasks', {
        title: 'RT Task Beta', assigneeId: dirAId,
        priority: 'HIGH', dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    });
    const taskB = r.data.task && r.data.task.id;
    await wsA1.waitFor('OPS_TASK_CREATED'); // drain
    check('S5-28. Second test task created', !!taskB);

    if (taskB) {
        // ── PATCH task (edit) → OPS_TASK_UPDATED ─────────────────────────────
        const [evtPatched] = await Promise.all([
            wsA1.waitFor('OPS_TASK_UPDATED'),
            api(dirA, 'PATCH', `/api/operations/tasks/${taskB}`, { priority: 'URGENT' })
        ]);
        check('S5-29. OPS_TASK_UPDATED received on PATCH', !!evtPatched, evtPatched);
        check('S5-30. task.priority = URGENT after PATCH',
            evtPatched && evtPatched.task && evtPatched.task.priority === 'URGENT');

        // ── Add comment → OPS_COMMENT_ADDED ──────────────────────────────────
        const [evtComment] = await Promise.all([
            wsA1.waitFor('OPS_COMMENT_ADDED'),
            api(dirA, 'POST', `/api/operations/tasks/${taskB}/comments`, { text: 'Real-time comment test' })
        ]);
        check('S5-31. OPS_COMMENT_ADDED received', !!evtComment, evtComment);
        check('S5-32. OPS_COMMENT_ADDED carries comment object',
            evtComment && evtComment.comment && evtComment.comment.text === 'Real-time comment test');
        check('S5-33. OPS_COMMENT_ADDED carries taskId', evtComment && evtComment.taskId === taskB);

        // ── Cancel task → OPS_TASK_UPDATED (status=CANCELLED) ────────────────
        const [evtCancelled] = await Promise.all([
            wsA1.waitFor('OPS_TASK_UPDATED'),
            api(dirA, 'POST', `/api/operations/tasks/${taskB}/cancel`, { reason: 'test' })
        ]);
        check('S5-34. OPS_TASK_UPDATED received on cancel', !!evtCancelled, evtCancelled);
        check('S5-35. task.status = CANCELLED',
            evtCancelled && evtCancelled.task && evtCancelled.task.status === 'CANCELLED');
    }

    // ── Reassign → OPS_TASK_REASSIGNED ───────────────────────────────────────
    // Invite a third user to reassign to
    r = await api(dirA, 'POST', '/api/operations/users', {
        name: 'Adjoint RT', email: `adj_${crypto.randomBytes(2).toString('hex')}@rt.it`, role: 'ADJOINT'
    });
    await wsA1.waitFor('OPS_USER_CREATED'); // drain
    const adjId = r.data.user && r.data.user.id;

    r = await api(dirA, 'POST', '/api/operations/tasks', {
        title: 'RT Task Gamma', assigneeId: dirAId,
        priority: 'LOW', dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    });
    await wsA1.waitFor('OPS_TASK_CREATED'); // drain
    const taskC = r.data.task && r.data.task.id;

    if (taskC && adjId) {
        const [evtReassigned] = await Promise.all([
            wsA1.waitFor('OPS_TASK_REASSIGNED'),
            api(dirA, 'POST', `/api/operations/tasks/${taskC}/reassign`, { assigneeId: adjId })
        ]);
        check('S5-36. OPS_TASK_REASSIGNED received', !!evtReassigned, evtReassigned);
        check('S5-37. OPS_TASK_REASSIGNED carries new assigneeId',
            evtReassigned && evtReassigned.task && evtReassigned.task.assigneeId === adjId);
        check('S5-38. OPS_TASK_REASSIGNED carries prevAssigneeId',
            evtReassigned && evtReassigned.prevAssigneeId === dirAId);
    }

    // ── Progress at 100% → OPS_TASK_COMPLETED (not OPS_TASK_PROGRESS) ────────
    r = await api(dirA, 'POST', '/api/operations/tasks', {
        title: 'RT Task Delta', assigneeId: dirAId,
        priority: 'LOW', dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    });
    await wsA1.waitFor('OPS_TASK_CREATED'); // drain
    const taskD = r.data.task && r.data.task.id;

    if (taskD) {
        await api(dirA, 'POST', `/api/operations/tasks/${taskD}/start`, {});
        await wsA1.waitFor('OPS_TASK_UPDATED');

        const [evtProgressComplete] = await Promise.all([
            wsA1.waitFor('OPS_TASK_COMPLETED'),
            api(dirA, 'POST', `/api/operations/tasks/${taskD}/progress`, { completionPercent: 100 })
        ]);
        check('S5-39. Progress at 100% emits OPS_TASK_COMPLETED (not OPS_TASK_PROGRESS)',
            !!evtProgressComplete, evtProgressComplete);
        check('S5-40. No duplicate OPS_TASK_PROGRESS emitted alongside OPS_TASK_COMPLETED',
            !wsA1.received.some(m => m.action === 'OPS_TASK_PROGRESS' && m.task && m.task.id === taskD));
    }

    // ── Multi-user sync: company A tab 2 sees same events as tab 1 ────────────
    const bothSameEvents = wsA1.received.filter(m => m.action.startsWith('OPS_'))
        .every(m => wsA2.received.some(m2 => m2.action === m.action));
    check('S5-41. Multi-user sync: all OPS events received by both tabs', bothSameEvents);

    // ── Company isolation: company B received no OPS events ───────────────────
    const bHasOps = wsB.received.some(m => m.action && m.action.startsWith('OPS_'));
    check('S5-42. Company isolation: company B received zero OPS events', !bHasOps, wsB.received.map(m => m.action));

    // ── No duplicate broadcasts on single operation ────────────────────────────
    // Count how many OPS_TASK_CREATED events arrived for the first task
    const createdCount = wsA1.received.filter(m => m.action === 'OPS_TASK_CREATED' && m.task && m.task.title === 'RT Task Alpha').length;
    check('S5-43. No duplicate OPS_TASK_CREATED broadcast', createdCount === 1, createdCount);

    // ── Statistics refresh: director stats API reflects completed task ─────────
    r = await api(dirA, 'GET', '/api/operations/stats');
    check('S5-44. Stats API returns completed count > 0',
        r.data.stats && r.data.stats.completed > 0, r.data.stats);

    // ── OPS_INVITATION_ACCEPTED — activate endpoint broadcasts ────────────────
    // We can't fully test activation (requires Firebase ID token), but we verify
    // the broadcastOps call is reachable by checking the server handles the route.
    r = await api(dirA, 'GET', '/api/operations/invitations/nonexistent-code');
    check('S5-45. Activation route reachable (404 for unknown code)', r.status === 404);

    // ── Cleanup ────────────────────────────────────────────────────────────────
    wsA1.close();
    wsA2.close();
    wsB.close();
    await sleep(200);

    console.log(`\n${passed} passed, ${failed} failed`);
    proc.kill();
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
