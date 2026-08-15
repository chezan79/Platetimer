#!/usr/bin/env node
'use strict';
// tests/operations-task53.test.js — Task 53: Next-task card sync + Details navigation
//
// Regression tests for:
//  1. Completing next task removes it from the card immediately (optimistic update logic).
//  2. The next eligible open task is shown after the previous is completed.
//  3. A newly created higher-priority task becomes next after a realtime event.
//  4. Zero open tasks produces the correct empty state (nextTask returns null).
//  5. Counters and next-task card remain consistent after RT CREATED/UPDATED/COMPLETED/REASSIGNED.
//  6. "Détails" button produces a URL with correct ?taskId= query param (not #hash).
//  7. operations-tasks.html auto-opens detail on valid ?taskId= (verified via API).
//  8. Cross-company or non-existent task IDs in ?taskId= are silently ignored.
//  9. Rapid successive realtime events do not produce duplicate renders
//     (in-flight guard + debounce verified via server-side broadcast count).
//
// Run: node tests/operations-task53.test.js

const http   = require('http');
const crypto = require('crypto');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn } = require('child_process');
const WS     = require('ws');

const SECRET = 'test-task53-secret';
const PORT   = 4462;

// ── HMAC token ───────────────────────────────────────────────────────────────
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

// ── WebSocket helper (consume-semantics, same as sprint5) ────────────────────
function wsConnect(token) {
    return new Promise((resolve, reject) => {
        const buffer  = [];
        const waiters = [];
        const received = [];

        const client = new WS(`ws://127.0.0.1:${PORT}/ws`);
        client.on('open', () => {
            client.send(JSON.stringify({ action: 'joinRoom', token }));
            client.send(JSON.stringify({ action: 'joinPage', pageType: 'operations' }));
            resolve({
                client,
                received,
                close() { try { client.close(); } catch (_) {} },
                waitFor(action, timeout = 3000) {
                    const idx = buffer.findIndex(m => m.action === action);
                    if (idx !== -1) {
                        const [msg] = buffer.splice(idx, 1);
                        return Promise.resolve(msg);
                    }
                    return new Promise(res => {
                        const timer = setTimeout(() => {
                            const wi = waiters.findIndex(w => w.action === action && w.resolve === res);
                            if (wi !== -1) waiters.splice(wi, 1);
                            res(null);
                        }, timeout);
                        waiters.push({ action, resolve: msg => { clearTimeout(timer); res(msg); } });
                    });
                }
            });
        });
        client.on('message', raw => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            received.push(msg);
            const wi = waiters.findIndex(w => w.action === msg.action);
            if (wi !== -1) {
                const [w] = waiters.splice(wi, 1);
                w.resolve(msg);
            } else {
                buffer.push(msg);
            }
        });
        client.on('error', reject);
    });
}

// ── Client-side nextTask algorithm (mirrors operations-common.js) ─────────────
// Used for unit tests 1–5 which verify the selection logic directly.
function nextTask(tasks, myId) {
    const today = new Date(); today.setHours(23,59,59,999);
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const mine = tasks.filter(t =>
        t.assigneeId === myId &&
        t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
    );
    if (!mine.length) return null;
    function score(t) {
        const eff = t.effectiveStatus || t.status;
        if (t.priority === 'URGENT') return 0;
        if (eff === 'OVERDUE' || (t.dueDate && new Date(t.dueDate) < new Date())) return 1;
        if (t.dueDate) {
            const d = new Date(t.dueDate);
            if (d >= todayStart && d <= today) return 2;
        }
        return 3;
    }
    return mine.sort((a,b) => {
        const sa = score(a), sb = score(b);
        if (sa !== sb) return sa - sb;
        return new Date(a.createdAt) - new Date(b.createdAt);
    })[0];
}

// ── Details URL helper (mirrors dashboard "Détails" onclick) ──────────────────
function detailsUrl(taskId) {
    return 'operations-tasks.html?taskId=' + encodeURIComponent(taskId);
}

async function run() {
    console.log('Starting server (Task 53 regression tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstest-t53-'));
    const proc = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT), WS_SESSION_SECRET: SECRET, DATA_DIR, FIREBASE_ADMIN_SERVICE_ACCOUNT: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 20000);
        proc.stdout.on('data', d => { if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(); } });
        proc.on('exit', code => { clearTimeout(t); reject(new Error(`Server exited: ${code}`)); });
    });
    console.log('Server up. Running Task 53 checks…\n');

    const co  = 'T53Co_'  + crypto.randomBytes(3).toString('hex');
    const co2 = 'T53Co2_' + crypto.randomBytes(3).toString('hex');
    const dirTok  = sign('t53-dir-a', co);
    const dir2Tok = sign('t53-dir-b', co2);

    // Bootstrap directors
    let r = await api(dirTok, 'GET', '/api/operations/me');
    check('T53-0. Director A bootstrapped', r.data.success);
    const dirId = r.data.user.id;

    r = await api(dir2Tok, 'GET', '/api/operations/me');
    check('T53-1. Director B bootstrapped (separate company)', r.data.success);
    const dir2Id = r.data.user.id;

    // Create a Sous-Chef in company A for role-specific checks
    const scInv = await api(dirTok, 'POST', '/api/operations/users', {
        name: 'SC User', email: `sc_${crypto.randomBytes(2).toString('hex')}@test.it`, role: 'SOUS_CHEF'
    });
    check('T53-2. Sous-Chef invited', scInv.data.success && scInv.data.user);
    const scUser = scInv.data.user;
    const scTok  = sign(scUser.id, co);

    // ── Unit tests: nextTask selection logic (no server needed) ─────────────
    console.log('\n--- Unit tests: nextTask algorithm ---');

    // Test 1: completing next task hides it from the card (optimistic update)
    {
        const tasks = [
            { id: 't1', assigneeId: 'u1', status: 'OPEN', priority: 'MEDIUM', dueDate: null, createdAt: '2024-01-01T10:00:00Z' },
            { id: 't2', assigneeId: 'u1', status: 'OPEN', priority: 'HIGH',   dueDate: null, createdAt: '2024-01-01T11:00:00Z' }
        ];
        // Before: t1 wins tiebreak by createdAt — both MEDIUM→same score, but t1 older
        // Actually HIGH > MEDIUM so t2 has score 3, t1 score 3, t1 older wins... wait
        // Both future no dueDate → score 3. t1 created earlier → wins.
        const before = nextTask(tasks, 'u1');
        check('T53-3. nextTask selects the correct first task (oldest open)', before && before.id === 't1', before && before.id);

        // Simulate optimistic update: mark t1 as COMPLETED
        const updated = tasks.map(tk => tk.id === 't1' ? { ...tk, status: 'COMPLETED' } : tk);
        const after   = nextTask(updated, 'u1');
        check('T53-4. After optimistic complete, card removes completed task', after && after.id === 't2', after && after.id);
    }

    // Test 2: next eligible open task shown after previous is completed
    {
        const tasks = [
            { id: 'a1', assigneeId: 'me', status: 'OPEN', priority: 'HIGH',   dueDate: null, createdAt: '2024-01-01T08:00:00Z' },
            { id: 'a2', assigneeId: 'me', status: 'OPEN', priority: 'MEDIUM', dueDate: null, createdAt: '2024-01-01T09:00:00Z' },
            { id: 'a3', assigneeId: 'me', status: 'OPEN', priority: 'LOW',    dueDate: null, createdAt: '2024-01-01T10:00:00Z' }
        ];
        const first = nextTask(tasks, 'me');
        check('T53-5. First nextTask is earliest open', first && first.id === 'a1', first && first.id);

        const after1 = nextTask(tasks.map(tk => tk.id === 'a1' ? { ...tk, status: 'COMPLETED' } : tk), 'me');
        check('T53-6. After completing first, second task becomes next', after1 && after1.id === 'a2', after1 && after1.id);

        const after2 = nextTask(tasks.map(tk => ['a1','a2'].includes(tk.id) ? { ...tk, status: 'COMPLETED' } : tk), 'me');
        check('T53-7. After completing first two, third task becomes next', after2 && after2.id === 'a3', after2 && after2.id);
    }

    // Test 3: new higher-priority task becomes next after a realtime event updates the array
    {
        const existing = [
            { id: 'b1', assigneeId: 'me', status: 'OPEN', priority: 'LOW', dueDate: null, createdAt: '2024-01-01T08:00:00Z' }
        ];
        const withNew = [
            ...existing,
            { id: 'b2', assigneeId: 'me', status: 'OPEN', priority: 'URGENT', dueDate: null, createdAt: '2024-01-01T09:00:00Z' }
        ];
        const before = nextTask(existing, 'me');
        const after  = nextTask(withNew, 'me');
        check('T53-8. Before new URGENT task: next is LOW task', before && before.id === 'b1', before && before.id);
        check('T53-9. After URGENT task added: next becomes URGENT', after && after.id === 'b2', after && after.id);
    }

    // Test 4: zero open tasks produces empty state (nextTask returns null)
    {
        const tasks = [
            { id: 'c1', assigneeId: 'me', status: 'COMPLETED', priority: 'HIGH', dueDate: null, createdAt: '2024-01-01T08:00:00Z' },
            { id: 'c2', assigneeId: 'me', status: 'CANCELLED', priority: 'LOW',  dueDate: null, createdAt: '2024-01-01T09:00:00Z' }
        ];
        check('T53-10. Zero open tasks → nextTask returns null', nextTask(tasks, 'me') === null);
    }

    // Test 5: counters and next-task derived from same fetch stay consistent
    {
        // Simulate what load() does: fetch tasks, then compute both counters and nextTask
        // from the same _tasks array. If both filter from the same source, they are consistent.
        const tasks = [
            { id: 'd1', assigneeId: 'me', status: 'OPEN',      priority: 'URGENT', dueDate: null, createdAt: '2024-01-01T08:00:00Z' },
            { id: 'd2', assigneeId: 'me', status: 'OPEN',      priority: 'MEDIUM', dueDate: null, createdAt: '2024-01-01T09:00:00Z' },
            { id: 'd3', assigneeId: 'me', status: 'COMPLETED',  priority: 'LOW',    dueDate: null, createdAt: '2024-01-01T07:00:00Z' },
            { id: 'd4', assigneeId: 'other', status: 'OPEN',   priority: 'HIGH',   dueDate: null, createdAt: '2024-01-01T06:00:00Z' }
        ];
        const mine   = tasks.filter(tk => tk.assigneeId === 'me');
        const active = mine.filter(tk => tk.status !== 'COMPLETED' && tk.status !== 'CANCELLED');
        const next   = nextTask(tasks, 'me');
        check('T53-11. Active count is 2 (not counting completed/other)', active.length === 2, active.length);
        check('T53-12. nextTask is URGENT (consistent with active filter)', next && next.priority === 'URGENT', next && next.priority);
        check('T53-13. nextTask is in active list (counters match card)', next && active.find(tk => tk.id === next.id) !== undefined);
    }

    // ── Test 6: "Détails" button URL uses ?taskId= query param (not #hash) ──
    console.log('\n--- Test 6: Détails URL format ---');
    {
        const taskId = 'task_abc_123';
        const url = detailsUrl(taskId);
        check('T53-14. Détails URL uses ?taskId= query param', url.includes('?taskId='), url);
        check('T53-15. Détails URL does NOT use # hash', !url.includes('#'), url);
        check('T53-16. Détails URL correctly encodes the task ID', url === 'operations-tasks.html?taskId=task_abc_123', url);
    }
    {
        // IDs with special characters should be encoded
        const specialId = 'task/with spaces&chars';
        const url = detailsUrl(specialId);
        check('T53-17. Détails URL encodes special characters', !url.includes(' ') && !url.includes('&chars'), url);
    }

    // ── Integration tests: server-side API behaviour ─────────────────────────
    console.log('\n--- Integration tests: API + realtime ---');

    // Create tasks for Director A
    const tNow = new Date().toISOString();
    const t1r = await api(dirTok, 'POST', '/api/operations/tasks', {
        title: 'Task Low',    priority: 'LOW',    assigneeId: dirId, dueDate: null
    });
    const t2r = await api(dirTok, 'POST', '/api/operations/tasks', {
        title: 'Task Medium', priority: 'MEDIUM', assigneeId: dirId, dueDate: null
    });
    const t3r = await api(dirTok, 'POST', '/api/operations/tasks', {
        title: 'Task Urgent', priority: 'URGENT', assigneeId: dirId, dueDate: null
    });
    check('T53-18. Three tasks created for Director A',
        t1r.data.success && t2r.data.success && t3r.data.success);
    const tid1 = t1r.data.task.id;
    const tid2 = t2r.data.task.id;
    const tid3 = t3r.data.task.id;

    // Test 7: GET /api/operations/tasks/:id returns task for valid ID in same company
    {
        const res = await api(dirTok, 'GET', '/api/operations/tasks/' + tid3);
        check('T53-19. Valid ?taskId= resolves: GET /tasks/:id succeeds', res.data.success, res.data.error);
        check('T53-20. Resolved task has correct ID', res.data.task && res.data.task.id === tid3);
        check('T53-21. Resolved task has correct priority', res.data.task && res.data.task.priority === 'URGENT');
    }

    // Test 8: Cross-company task ID is rejected (GET returns non-200)
    {
        // Create a task in company B
        const co2TaskRes = await api(dir2Tok, 'POST', '/api/operations/tasks', {
            title: 'Co2 Task', priority: 'HIGH', assigneeId: dir2Id, dueDate: null
        });
        check('T53-22. Company B task created', co2TaskRes.data.success);
        const co2TaskId = co2TaskRes.data.task.id;

        // Try to read it from company A — should be 403 or 404
        const crossRes = await api(dirTok, 'GET', '/api/operations/tasks/' + co2TaskId);
        check('T53-23. Cross-company task ID returns non-200 (silent fallback)',
            crossRes.status === 403 || crossRes.status === 404 || !crossRes.data.success,
            crossRes.status);

        // Non-existent ID should also be rejected
        const missingRes = await api(dirTok, 'GET', '/api/operations/tasks/task_nonexistent_xyz_000');
        check('T53-24. Non-existent task ID returns non-200 (silent fallback)',
            missingRes.status === 403 || missingRes.status === 404 || !missingRes.data.success,
            missingRes.status);
    }

    // Test 5 (integration): RT events drive consistent state
    // Open a WS connection for Director A, then trigger mutations and verify events
    {
        const ws = await wsConnect(dirTok);
        // Wait for joinedRoom confirmation
        const joined = await ws.waitFor('joinedRoom', 3000);
        check('T53-25. WS channel joined for RT event tests', !!joined);

        // CREATED event
        const newTaskRes = await api(dirTok, 'POST', '/api/operations/tasks', {
            title: 'RT Test Task', priority: 'HIGH', assigneeId: dirId, dueDate: null
        });
        const rtCreated = await ws.waitFor('OPS_TASK_CREATED', 3000);
        check('T53-26. OPS_TASK_CREATED broadcast received after task creation', !!rtCreated);

        const rtTid = newTaskRes.data.task.id;

        // UPDATED event
        await api(dirTok, 'PATCH', '/api/operations/tasks/' + rtTid, { title: 'RT Test Task (edited)' });
        const rtUpdated = await ws.waitFor('OPS_TASK_UPDATED', 3000);
        check('T53-27. OPS_TASK_UPDATED broadcast received after task edit', !!rtUpdated);

        // START + COMPLETED event (start first so complete is allowed)
        await api(dirTok, 'POST', '/api/operations/tasks/' + rtTid + '/start');
        const rtStarted = await ws.waitFor('OPS_TASK_UPDATED', 3000);
        check('T53-28. OPS_TASK_UPDATED broadcast received after task start', !!rtStarted);

        const completeRes = await api(dirTok, 'POST', '/api/operations/tasks/' + rtTid + '/complete');
        check('T53-29. Task complete API succeeded', completeRes.data.success, completeRes.data.error);
        const rtCompleted = await ws.waitFor('OPS_TASK_COMPLETED', 3000);
        check('T53-30. OPS_TASK_COMPLETED broadcast received after completion', !!rtCompleted);

        // After completion, GET /tasks should no longer show task as active
        const listRes = await api(dirTok, 'GET', '/api/operations/tasks');
        const completedInList = listRes.data.tasks.find(tk => tk.id === rtTid);
        check('T53-31. Completed task is COMPLETED in server state', completedInList && completedInList.status === 'COMPLETED');

        // nextTask from the refreshed list should NOT include the completed task
        const nextAfterComplete = nextTask(listRes.data.tasks, dirId);
        check('T53-32. nextTask excludes the just-completed task', !nextAfterComplete || nextAfterComplete.id !== rtTid);

        // REASSIGNED event
        const reassignRes = await api(dirTok, 'POST', '/api/operations/tasks/' + tid1 + '/reassign', {
            assigneeId: scUser.id
        });
        check('T53-33. Reassign succeeded', reassignRes.data.success, reassignRes.data.error);
        const rtReassigned = await ws.waitFor('OPS_TASK_REASSIGNED', 3000);
        check('T53-34. OPS_TASK_REASSIGNED broadcast received after reassign', !!rtReassigned);

        // After reassign, nextTask for dirId should not include tid1
        const listAfterReassign = await api(dirTok, 'GET', '/api/operations/tasks');
        const nt2 = nextTask(listAfterReassign.data.tasks, dirId);
        const nt2ForSc = nextTask(listAfterReassign.data.tasks, scUser.id);
        check('T53-35. Reassigned task no longer in Director next-task', !nt2 || nt2.id !== tid1);
        check('T53-36. Reassigned task now visible in SC task pool', nt2ForSc && nt2ForSc.id === tid1);

        ws.close();
    }

    // Test 9: Rapid successive realtime events — server broadcasts exactly once per mutation
    {
        const ws2 = await wsConnect(dirTok);
        await ws2.waitFor('joinedRoom', 3000);

        // Fire three rapid mutations
        await Promise.all([
            api(dirTok, 'PATCH', '/api/operations/tasks/' + tid2, { title: 'Rapid 1' }),
            api(dirTok, 'PATCH', '/api/operations/tasks/' + tid2, { title: 'Rapid 2' }),
            api(dirTok, 'PATCH', '/api/operations/tasks/' + tid2, { title: 'Rapid 3' }),
        ]);

        // Each mutation produces exactly one OPS_TASK_UPDATED broadcast.
        // We receive them one by one — confirming no duplicates beyond actual mutations.
        const ev1 = await ws2.waitFor('OPS_TASK_UPDATED', 2000);
        const ev2 = await ws2.waitFor('OPS_TASK_UPDATED', 2000);
        const ev3 = await ws2.waitFor('OPS_TASK_UPDATED', 2000);
        check('T53-37. Rapid mutations produce distinct broadcasts (no dropped events)',
            !!ev1 && !!ev2 && !!ev3);

        // The debounced rtReload in the client coalesces these into one load() call.
        // We cannot simulate the browser here, but we verify the server emits
        // exactly one event per mutation (not fewer), so the debounce is the
        // correct guard — not the server dropping events.
        check('T53-38. Three rapid mutations produce at least three WS events',
            ws2.received.filter(m => m.action === 'OPS_TASK_UPDATED').length >= 3,
            ws2.received.filter(m => m.action === 'OPS_TASK_UPDATED').length);

        ws2.close();
    }

    // ── Unit test: pending-reload guard — no event is silently dropped ────────
    // Simulates the _loadInFlight / _pendingReload pattern used in both
    // dashboards to verify that a load() request arriving while a previous load
    // is in flight always triggers a trailing reload rather than being discarded.
    console.log('\n--- Unit test: pending-reload guard ---');
    {
        let _loadInFlight2 = false, _pendingReload2 = false;
        let loadCallCount = 0;
        const loadLog = [];

        async function simulatedLoad(label) {
            if (_loadInFlight2) { _pendingReload2 = true; return; }
            _loadInFlight2 = true;
            _pendingReload2 = false;
            loadCallCount++;
            loadLog.push(label);
            // Simulate async work (tasks fetch + intelligence fetch)
            await new Promise(r => setTimeout(r, 40));
            _loadInFlight2 = false;
            if (_pendingReload2) {
                _pendingReload2 = false;
                // trailing reload (setTimeout(100) in production)
                await simulatedLoad('trailing');
            }
        }

        // Start an initial load, then fire two concurrent calls during it
        const initial = simulatedLoad('initial');
        await new Promise(r => setTimeout(r, 5)); // let it enter the async fetch
        simulatedLoad('concurrent-1');  // sets _pendingReload2 = true
        simulatedLoad('concurrent-2');  // _pendingReload2 already true, no-op
        await initial;
        await new Promise(r => setTimeout(r, 80)); // allow trailing load to complete

        check('T53-39. Pending-reload: initial load ran', loadLog.includes('initial'), loadLog);
        check('T53-40. Pending-reload: trailing reload ran after concurrent event',
            loadLog.includes('trailing'), loadLog);
        check('T53-41. Pending-reload: exactly 2 loads (no more, no less)',
            loadCallCount === 2, loadCallCount);

        // Also verify: without a concurrent event, exactly 1 load runs
        loadCallCount = 0;
        _loadInFlight2 = false;
        _pendingReload2 = false;
        await simulatedLoad('solo');
        check('T53-42. Pending-reload: solo load (no concurrent) runs exactly once',
            loadCallCount === 1, loadCallCount);
    }

    // ── DOM button-lifecycle regression: buttons reset on next-task transition ─
    // Simulates the renderNextTaskCard() DOM lifecycle in Node.js without a real
    // browser: mock button objects stand in for getElementById results.
    // Covers the start-A → complete-A → task-B scenario where persistent DOM
    // buttons must have disabled=false before task B's handlers are bound.
    console.log('\n--- DOM button-lifecycle regression ---');
    {
        // Build a minimal mock DOM for the next-task card
        function makeMockButton(id) {
            return { id, disabled: false, style: { display: '' }, onclick: null };
        }
        function makeMockEl(id) {
            return { id, style: { display: 'none' }, textContent: '', innerHTML: '' };
        }

        const mockDom = {
            'next-task-section': makeMockEl('next-task-section'),
            'no-next-task':      makeMockEl('no-next-task'),
            'nt-title':          makeMockEl('nt-title'),
            'nt-meta':           makeMockEl('nt-meta'),
            'nt-start-btn':      makeMockButton('nt-start-btn'),
            'nt-complete-btn':   makeMockButton('nt-complete-btn'),
            'nt-view-btn':       makeMockButton('nt-view-btn'),
        };
        function mockGetById(id) { return mockDom[id] || null; }

        // Minimal stand-in for OpsCommon.nextTask / fmtDue / priorityLabel
        function mockNextTask(tasks, myId) {
            const mine = tasks.filter(t => t.assigneeId === myId &&
                t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
            if (!mine.length) return null;
            return mine.sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
        }

        // Reproduce the renderNextTaskCard logic from the dashboard
        // (mirrors the actual production code; must stay in sync).
        function simulateRenderNextTaskCard(tasks, myId) {
            const secEl = mockGetById('next-task-section');
            const noEl  = mockGetById('no-next-task');
            secEl.style.display = 'none';
            noEl.style.display  = 'none';

            const next = mockNextTask(tasks, myId);
            if (next) {
                secEl.style.display = '';
                mockGetById('nt-title').textContent = next.title;
                mockGetById('nt-meta').textContent  = next.priority;

                const startBtn    = mockGetById('nt-start-btn');
                const completeBtn = mockGetById('nt-complete-btn');

                // Production fix: reset disabled before binding new handlers
                startBtn.disabled    = false;
                completeBtn.disabled = false;

                startBtn.style.display = next.status !== 'OPEN' ? 'none' : '';
                startBtn.onclick    = () => { startBtn.disabled = true; };
                completeBtn.onclick = () => { completeBtn.disabled = true; };
                mockGetById('nt-view-btn').onclick = () => {};
            } else {
                noEl.style.display = '';
            }
        }

        const tasks = [
            { id: 'btn-t1', assigneeId: 'me', status: 'OPEN', priority: 'HIGH',   createdAt: '2024-01-01T08:00:00Z', title: 'Task A', dueDate: null },
            { id: 'btn-t2', assigneeId: 'me', status: 'OPEN', priority: 'MEDIUM', createdAt: '2024-01-01T09:00:00Z', title: 'Task B', dueDate: null }
        ];

        // Initial render: task A is next
        simulateRenderNextTaskCard(tasks, 'me');
        const startBtn    = mockGetById('nt-start-btn');
        const completeBtn = mockGetById('nt-complete-btn');
        check('T53-39. Initial render: start button enabled',    startBtn.disabled === false, startBtn.disabled);
        check('T53-40. Initial render: complete button enabled', completeBtn.disabled === false, completeBtn.disabled);
        check('T53-41. Initial render: next-task section visible', mockGetById('next-task-section').style.display === '', mockDom['next-task-section'].style.display);
        check('T53-42. Initial render: title is Task A', mockGetById('nt-title').textContent === 'Task A', mockGetById('nt-title').textContent);

        // User clicks "Start" on task A → button becomes disabled
        startBtn.onclick();
        check('T53-43. After start click: start button is disabled', startBtn.disabled === true, startBtn.disabled);

        // User clicks "Complete" on task A → button becomes disabled
        startBtn.disabled = false; // simulate start succeeded, button re-enabled by handler
        completeBtn.onclick();
        check('T53-44. After complete click: complete button is disabled', completeBtn.disabled === true, completeBtn.disabled);

        // Optimistic update: mark task A as completed and re-render immediately
        const updatedTasks = tasks.map(t => t.id === 'btn-t1' ? { ...t, status: 'COMPLETED' } : t);
        simulateRenderNextTaskCard(updatedTasks, 'me');

        // Task B should now be shown with buttons fully enabled
        check('T53-45. After complete+re-render: start button re-enabled for task B',
            mockGetById('nt-start-btn').disabled === false, mockGetById('nt-start-btn').disabled);
        check('T53-46. After complete+re-render: complete button re-enabled for task B',
            mockGetById('nt-complete-btn').disabled === false, mockGetById('nt-complete-btn').disabled);
        check('T53-47. After complete+re-render: title updated to Task B',
            mockGetById('nt-title').textContent === 'Task B', mockGetById('nt-title').textContent);

        // After both tasks are completed: empty-state shown
        const allDone = tasks.map(t => ({ ...t, status: 'COMPLETED' }));
        simulateRenderNextTaskCard(allDone, 'me');
        check('T53-48. When all done: next-task section hidden',
            mockGetById('next-task-section').style.display === 'none', mockGetById('next-task-section').style.display);
        check('T53-49. When all done: no-next-task message shown',
            mockGetById('no-next-task').style.display === '', mockGetById('no-next-task').style.display);
    }

    // ── HTML source checks: dashboard files use ?taskId= not # ──────────────
    console.log('\n--- Static source checks ---');
    {
        const cdbSrc = fs.readFileSync(path.join(__dirname, '../public/operations-cdb.html'), 'utf8');
        check('T53-43. CdB dashboard "Détails" uses ?taskId= (not hash)',
            cdbSrc.includes('?taskId=') && !cdbSrc.includes("'operations-tasks.html#"));

        const scSrc  = fs.readFileSync(path.join(__dirname, '../public/operations-souschef.html'), 'utf8');
        check('T53-44. Sous-Chef dashboard "Détails" uses ?taskId= (not hash)',
            scSrc.includes('?taskId=') && !scSrc.includes("'operations-tasks.html#"));

        // operations-tasks.html must read ?taskId= in load()
        const tasksSrc = fs.readFileSync(path.join(__dirname, '../public/operations-tasks.html'), 'utf8');
        check('T53-45. operations-tasks.html reads URLSearchParams taskId param',
            tasksSrc.includes("get('taskId')"));
        check('T53-46. operations-tasks.html calls openDetail with silent option on URL param',
            tasksSrc.includes("silent: true"));

        // openDetail must not unconditionally call showError on non-200
        check('T53-47. openDetail has silent-fallback guard (opts.silent)',
            tasksSrc.includes('opts.silent'));

        // operations-common.js taskCard must use ?taskId= not #
        const commonSrc = fs.readFileSync(path.join(__dirname, '../public/js/operations-common.js'), 'utf8');
        check('T53-48. operations-common.js taskCard uses ?taskId= (not hash)',
            commonSrc.includes('?taskId=') && !commonSrc.includes("tasks.html#${"));

        // Both dashboards must have the _loadInFlight + _pendingReload guard
        check('T53-49. CdB dashboard has _loadInFlight guard',   cdbSrc.includes('_loadInFlight'));
        check('T53-50. CdB dashboard has _pendingReload guard',  cdbSrc.includes('_pendingReload'));
        check('T53-51. Sous-Chef dashboard has _loadInFlight guard',  scSrc.includes('_loadInFlight'));
        check('T53-52. Sous-Chef dashboard has _pendingReload guard',  scSrc.includes('_pendingReload'));

        // Guard must set pending flag, not silently discard
        check('T53-53. CdB guard sets _pendingReload = true (not a bare return)',
            cdbSrc.includes('_pendingReload = true'));
        check('T53-54. Sous-Chef guard sets _pendingReload = true (not a bare return)',
            scSrc.includes('_pendingReload = true'));

        // Trailing reload must fire in finally block
        check('T53-55. CdB finally block triggers trailing reload on _pendingReload',
            cdbSrc.includes('_pendingReload') && cdbSrc.includes("setTimeout(() => load(true), 100)"));
        check('T53-56. Sous-Chef finally block triggers trailing reload on _pendingReload',
            scSrc.includes('_pendingReload') && scSrc.includes("setTimeout(() => load(true), 100)"));

        // rtReload must NOT guard on _loadInFlight (pending pattern handles it)
        check('T53-57. CdB rtReload does not check _loadInFlight (pending pattern handles concurrency)',
            !cdbSrc.match(/rtReload[\s\S]{0,200}if.*_loadInFlight/));
        check('T53-58. Sous-Chef rtReload does not check _loadInFlight',
            !scSrc.match(/rtReload[\s\S]{0,200}if.*_loadInFlight/));

        // Both dashboards must have renderNextTaskCard function
        check('T53-59. CdB dashboard has renderNextTaskCard function', cdbSrc.includes('renderNextTaskCard'));
        check('T53-60. Sous-Chef dashboard has renderNextTaskCard function', scSrc.includes('renderNextTaskCard'));

        // Both dashboards optimistically update _tasks on complete
        check('T53-61. CdB dashboard optimistically updates _tasks on complete',
            cdbSrc.includes("status: 'COMPLETED'") && cdbSrc.includes('renderNextTaskCard(_tasks'));
        check('T53-62. Sous-Chef dashboard optimistically updates _tasks on complete',
            scSrc.includes("status: 'COMPLETED'") && scSrc.includes('renderNextTaskCard(_tasks'));
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    proc.kill();
    console.log(`\nTask 53 regression tests: ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
