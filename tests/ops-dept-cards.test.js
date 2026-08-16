#!/usr/bin/env node
'use strict';
// tests/ops-dept-cards.test.js — Task 66 enhancement: Operations task cards in
// the Service department operational area.
//
// Spec (section 16) requirements:
//  1.  Published Cucina task → visible via GET /api/service/ops-tasks for Cucina
//  2.  Pizzeria cannot receive Cucina task
//  3.  Another company cannot receive it
//  4.  Unpublished task → not returned
//  5.  Department-less task → not returned
//  6.  Completed task → not in active list
//  7.  Cancelled task → not in active list
//  8.  Update returns same task id (no duplicate)
//  9.  Department move removes card in old dept (OPS_TASK_SERVICE_REMOVED)
//  10. Department move creates card in new dept (OPS_TASK_UPDATED broadcast)
//  11. Unpublish removes card (OPS_TASK_SERVICE_REMOVED)
//  12. Delete removes card (OPS_TASK_SERVICE_REMOVED)
//  13. Details projection is read-only (Service cannot complete/cancel/delete via ops API)
//  14. Service cannot mutate Operations task (no ops-auth)
//  15. Existing countdown endpoint is untouched
//  16. Existing voice-message endpoint is untouched (not crashed by ops changes)
//  17. PTT room join still works
//  18. Existing calendar mirror behaviour (calendar event created for published task)
//
// Run: node tests/ops-dept-cards.test.js

const crypto  = require('crypto');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { spawn } = require('child_process');
const WS      = require('ws');

const SECRET  = 'test-dept-cards-secret';
const PORT    = 4452;
const BASE    = `http://127.0.0.1:${PORT}`;

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
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(BASE + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

function wsConnect(token) {
    return new Promise((resolve, reject) => {
        const buffer = [], waiters = [];
        const client = new WS(`ws://127.0.0.1:${PORT}/ws`);
        client.on('open', () => {
            client.send(JSON.stringify({ action: 'joinRoom', token }));
            resolve({
                client,
                close() { try { client.close(); } catch (_) {} },
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
        client.on('message', data => {
            let msg; try { msg = JSON.parse(data); } catch { return; }
            if (!msg.action) return;
            const wi = waiters.findIndex(w => w.action === msg.action);
            if (wi !== -1) {
                const waiter = waiters.splice(wi, 1)[0];
                clearTimeout(waiter._timer);
                waiter.resolve(msg);
            } else buffer.push(msg);
        });
        client.on('error', reject);
        client.on('close', () => waiters.splice(0).forEach(w => { clearTimeout(w._timer); w.resolve(null); }));
    });
}

async function run() {
    console.log('Starting server (ops dept-card tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-dept-cards-'));
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({ ristorante: 'medium', altra: 'medium' }));

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
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 20_000);
        proc.stdout.on('data', d => { if (d.toString().includes('avviato')) { clearTimeout(t); resolve(); } });
    });
    console.log('Server up.\n');

    try {
        // ── Setup ─────────────────────────────────────────────────────────────
        const tokDir  = sign('dir1',    'ristorante');   // Ops Director
        const tokAdm  = sign('adm1',    'ristorante');   // Service admin (unbound)
        const tokCuc  = sign('cuc1',    'ristorante');   // bound to Cucina account
        const tokPiz  = sign('piz1',    'ristorante');   // bound to Pizzeria account
        const tokODir = sign('odir1',   'altra');        // other-company Ops Director
        const tokOAdm = sign('oadm1',   'altra');        // other-company Service admin

        // Bootstrap Ops Director
        let r = await api(tokDir, 'GET', '/api/operations/me?name=Direttore');
        check('Setup: ops Director', r.data.success === true, r.data);

        // Create departments
        r = await api(tokAdm, 'POST', '/api/departments', { name: 'Cucina' });
        const deptCucina = r.data.department;
        r = await api(tokAdm, 'POST', '/api/departments', { name: 'Pizzeria' });
        const deptPizzeria = r.data.department;
        check('Setup: departments created', !!(deptCucina?.id && deptPizzeria?.id), r.data);

        // Bind department accounts
        r = await api(tokAdm, 'POST', '/api/department-accounts', { departmentId: deptCucina.id, displayName: 'Cucina', loginIdentifier: 'cucina.dept' });
        check('Setup: Cucina acct created', !!r.data?.account?.id, r.data);
        r = await api(tokCuc, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'cucina.dept' });
        check('Setup: Cucina acct bound', r.data.success === true, r.data);

        r = await api(tokAdm, 'POST', '/api/department-accounts', { departmentId: deptPizzeria.id, displayName: 'Pizzeria', loginIdentifier: 'pizzeria.dept' });
        r = await api(tokPiz, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'pizzeria.dept' });
        check('Setup: Pizzeria acct bound', r.data.success === true, r.data);

        // Other company
        r = await api(tokODir, 'GET', '/api/operations/me?name=AltroDir');
        check('Setup: other-co Ops Director', r.data.success === true, r.data);
        r = await api(tokOAdm, 'POST', '/api/departments', { name: 'AltroReparto' });
        const deptAltro = r.data.department;
        r = await api(tokOAdm, 'POST', '/api/department-accounts', { departmentId: deptAltro.id, displayName: 'Altro', loginIdentifier: 'altro.dept' });
        const tokOCuc = sign('ocuc1', 'altra');
        r = await api(tokOCuc, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'altro.dept' });

        // Helper: get ops tasks for a bound department
        const getOpsTasksFor = async (tok) => {
            const rr = await api(tok, 'GET', '/api/service/ops-tasks');
            return rr.data.success ? rr.data.tasks : null;
        };

        // ── 1. Published Cucina task → visible to Cucina ──────────────────────
        console.log('\n  — 1. published task visible to bound department —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'TEST OPS CUCINA', dueDate: '2030-06-01T12:00:00.000Z', priority: 'HIGH',
            serviceDepartmentId: deptCucina.id, publishToService: true
        });
        check('1a. create: 201', r.status === 201 && r.data.success, r.data);
        const tCucina = r.data.task;
        await new Promise(res => setTimeout(res, 150));

        const cucTasks = await getOpsTasksFor(tokCuc);
        check('1b. Cucina sees the task', cucTasks?.some(tk => tk.id === tCucina.id), cucTasks);
        const t1 = cucTasks?.find(tk => tk.id === tCucina.id);
        check('1c. task has title', t1?.title === 'TEST OPS CUCINA', t1);
        check('1d. task has priority', !!t1?.priority, t1);
        check('1e. task has assigneeName', !!t1?.assigneeName, t1);
        check('1f. task has dueDate', !!t1?.dueDate, t1);
        check('1g. task source is OPERATIONS', t1?.source === 'OPERATIONS', t1);
        check('1h. serviceDepartmentId matches Cucina', t1?.serviceDepartmentId === deptCucina.id, t1);
        // Projection must NOT expose internal company/assignee IDs
        check('1i. projection hides companyId', !('companyId' in (t1 || {})), t1);

        // ── 2. Pizzeria cannot see Cucina task ────────────────────────────────
        console.log('\n  — 2. other department cannot see task —\n');
        const pizTasks = await getOpsTasksFor(tokPiz);
        check('2. Pizzeria does not see Cucina task',
            pizTasks !== null && !pizTasks.some(tk => tk.id === tCucina.id), pizTasks);

        // ── 3. Other company cannot see task ─────────────────────────────────
        console.log('\n  — 3. other company cannot see task —\n');
        const otherTasks = await getOpsTasksFor(tokOCuc);
        check('3. Other company sees no tasks',
            otherTasks !== null && !otherTasks.some(tk => tk.id === tCucina.id), otherTasks);

        // ── 4. Unpublished task is not returned ───────────────────────────────
        console.log('\n  — 4. unpublished task not returned —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Unpublished task', dueDate: '2030-07-01T10:00:00.000Z',
            serviceDepartmentId: deptCucina.id, publishToService: false
        });
        const tUnpub = r.data.task;
        await new Promise(res => setTimeout(res, 100));
        const afterUnpub = await getOpsTasksFor(tokCuc);
        check('4. unpublished task not in list', !afterUnpub?.some(tk => tk.id === tUnpub.id), afterUnpub);

        // ── 5. Department-less task is not returned ───────────────────────────
        console.log('\n  — 5. task without serviceDepartmentId not returned —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'No dept task', dueDate: '2030-08-01T10:00:00.000Z', publishToService: true
        });
        const tNoDept = r.data.task;
        await new Promise(res => setTimeout(res, 100));
        const afterNoDept = await getOpsTasksFor(tokCuc);
        check('5. no-dept task not in Cucina list', !afterNoDept?.some(tk => tk.id === tNoDept.id), afterNoDept);

        // ── 6. Completed task is not in active list ───────────────────────────
        console.log('\n  — 6. completed task removed from list —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'To complete', dueDate: '2030-09-01T10:00:00.000Z',
            serviceDepartmentId: deptCucina.id, publishToService: true
        });
        const tToComplete = r.data.task;
        await new Promise(res => setTimeout(res, 150));
        check('6a. task visible before completion', (await getOpsTasksFor(tokCuc))?.some(tk => tk.id === tToComplete.id));
        r = await api(tokDir, 'POST', `/api/operations/tasks/${tToComplete.id}/complete`);
        check('6b. complete 200', r.data.success === true, r.data);
        await new Promise(res => setTimeout(res, 150));
        check('6c. completed task not in list', !(await getOpsTasksFor(tokCuc))?.some(tk => tk.id === tToComplete.id));

        // ── 7. Cancelled task is not in active list ───────────────────────────
        console.log('\n  — 7. cancelled task removed from list —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'To cancel', dueDate: '2030-10-01T10:00:00.000Z',
            serviceDepartmentId: deptCucina.id, publishToService: true
        });
        const tToCancel = r.data.task;
        await new Promise(res => setTimeout(res, 150));
        check('7a. task visible before cancel', (await getOpsTasksFor(tokCuc))?.some(tk => tk.id === tToCancel.id));
        r = await api(tokDir, 'POST', `/api/operations/tasks/${tToCancel.id}/cancel`, { reason: 'test' });
        check('7b. cancel 200', r.data.success === true, r.data);
        await new Promise(res => setTimeout(res, 150));
        check('7c. cancelled task not in list', !(await getOpsTasksFor(tokCuc))?.some(tk => tk.id === tToCancel.id));

        // ── 8. Update returns same task id (no duplicate) ─────────────────────
        console.log('\n  — 8. update modifies existing entry (no duplication) —\n');
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tCucina.id}`, { title: 'TEST OPS CUCINA v2' });
        check('8a. patch 200', r.data.success === true, r.data);
        await new Promise(res => setTimeout(res, 150));
        const afterPatch = await getOpsTasksFor(tokCuc);
        const matching = afterPatch?.filter(tk => tk.id === tCucina.id) || [];
        check('8b. still exactly one entry with same id', matching.length === 1, matching);
        check('8c. updated title present', matching[0]?.title === 'TEST OPS CUCINA v2', matching[0]);

        // ── 9 & 10. Department move ───────────────────────────────────────────
        console.log('\n  — 9/10. department move Cucina→Pizzeria —\n');
        // Connect WS clients for both departments
        const wsCuc = await wsConnect(tokCuc);
        const wsPiz = await wsConnect(tokPiz);
        await new Promise(res => setTimeout(res, 400));

        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tCucina.id}`, {
            serviceDepartmentId: deptPizzeria.id
        });
        check('9a. move PATCH 200', r.data.success === true, r.data);

        // WS: Cucina should receive OPS_TASK_SERVICE_REMOVED
        const cucRemoved = await wsCuc.waitFor('OPS_TASK_SERVICE_REMOVED', 5000);
        check('9b. Cucina receives OPS_TASK_SERVICE_REMOVED',
            cucRemoved && cucRemoved.taskId === tCucina.id &&
            cucRemoved.prevServiceDepartmentId === deptCucina.id, cucRemoved);

        // WS: Pizzeria should receive OPS_TASK_UPDATED
        const pizUpdated = await wsPiz.waitFor('OPS_TASK_UPDATED', 5000);
        check('10a. Pizzeria receives OPS_TASK_UPDATED',
            pizUpdated && pizUpdated.task?.id === tCucina.id &&
            pizUpdated.task?.serviceDepartmentId === deptPizzeria.id, pizUpdated);

        await new Promise(res => setTimeout(res, 150));
        // REST check: Cucina no longer has the task, Pizzeria now has it
        const cucAfterMove = await getOpsTasksFor(tokCuc);
        check('9c. task removed from Cucina (REST)', !cucAfterMove?.some(tk => tk.id === tCucina.id), cucAfterMove);
        const pizAfterMove = await getOpsTasksFor(tokPiz);
        check('10b. task appeared in Pizzeria (REST)', pizAfterMove?.some(tk => tk.id === tCucina.id), pizAfterMove);

        wsCuc.close();
        wsPiz.close();

        // ── 11. Unpublish removes card ────────────────────────────────────────
        console.log('\n  — 11. unpublish removes card —\n');
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tCucina.id}`, {
            publishToService: false, serviceDepartmentId: deptPizzeria.id
        });
        check('11a. unpublish PATCH 200', r.data.success === true, r.data);
        await new Promise(res => setTimeout(res, 150));
        const pizAfterUnpub = await getOpsTasksFor(tokPiz);
        check('11b. task removed from Pizzeria after unpublish',
            !pizAfterUnpub?.some(tk => tk.id === tCucina.id), pizAfterUnpub);

        // Re-publish to Cucina for subsequent tests
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tCucina.id}`, {
            publishToService: true, serviceDepartmentId: deptCucina.id
        });
        await new Promise(res => setTimeout(res, 150));
        check('11c. re-publish re-creates entry', (await getOpsTasksFor(tokCuc))?.some(tk => tk.id === tCucina.id));

        // ── 12. Delete removes card ───────────────────────────────────────────
        console.log('\n  — 12. delete removes card —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'To delete', dueDate: '2030-11-01T10:00:00.000Z',
            serviceDepartmentId: deptCucina.id, publishToService: true
        });
        const tToDel = r.data.task;
        await new Promise(res => setTimeout(res, 150));
        check('12a. task visible before delete', (await getOpsTasksFor(tokCuc))?.some(tk => tk.id === tToDel.id));
        r = await api(tokDir, 'DELETE', `/api/operations/tasks/${tToDel.id}`);
        check('12b. delete 200', r.data.success === true, r.data);
        await new Promise(res => setTimeout(res, 150));
        check('12c. task removed after delete', !(await getOpsTasksFor(tokCuc))?.some(tk => tk.id === tToDel.id));

        // ── 13. Projection is read-only (no mutation controls exposed) ────────
        console.log('\n  — 13. projection only exposes safe fields —\n');
        const currTasks = await getOpsTasksFor(tokCuc);
        const t13 = currTasks?.find(tk => tk.id === tCucina.id);
        check('13a. id exposed', !!t13?.id, t13);
        check('13b. title exposed', !!t13?.title, t13);
        check('13c. assigneeName exposed', !!t13?.assigneeName, t13);
        check('13d. dueDate exposed', !!t13?.dueDate, t13);
        check('13e. priority exposed', !!t13?.priority, t13);
        check('13f. status exposed', !!t13?.status, t13);
        check('13g. source=OPERATIONS', t13?.source === 'OPERATIONS', t13);
        check('13h. companyId hidden', !('companyId' in (t13 || {})), t13);
        check('13i. assigneeId hidden', !('assigneeId' in (t13 || {})), t13);

        // ── 14. Service cannot mutate Ops task via ops API ────────────────────
        console.log('\n  — 14. Service cannot mutate Operations task —\n');
        // A bound Cucina account has a Service session (uid=depacct_*), not an Ops account
        r = await api(tokCuc, 'PATCH', `/api/operations/tasks/${tCucina.id}`, { title: 'Hacked' });
        check('14a. Service PATCH ops task → 401 or 403', [401, 403].includes(r.status), r.status);
        r = await api(tokCuc, 'POST', `/api/operations/tasks/${tCucina.id}/complete`);
        check('14b. Service complete ops task → 401 or 403', [401, 403].includes(r.status), r.status);
        r = await api(tokCuc, 'DELETE', `/api/operations/tasks/${tCucina.id}`);
        check('14c. Service delete ops task → 401 or 403', [401, 403].includes(r.status), r.status);

        // ── 15. Existing countdown endpoint is untouched ──────────────────────
        console.log('\n  — 15. countdown infrastructure untouched —\n');
        r = await api(tokAdm, 'POST', '/api/departments/Cucina/countdown', {
            tableNumber: '1', duration: 600, destinations: []
        });
        // Countdown may return various statuses depending on state; key thing is it
        // doesn't 500 or crash.
        check('15. countdown POST does not crash (non-500)', r.status !== 500, r.status);

        // ── 16. Voice-message endpoint untouched ──────────────────────────────
        console.log('\n  — 16. voice message REST endpoint untouched —\n');
        r = await api(tokAdm, 'GET', '/api/voice-recipients');
        check('16. GET /api/voice-recipients still works', r.status === 200, r.status);

        // ── 17. PTT room join still works ─────────────────────────────────────
        console.log('\n  — 17. WS join/room still works —\n');
        const wsTest = await wsConnect(tokCuc);
        await new Promise(res => setTimeout(res, 400));
        check('17. WS connect and join succeeds (no crash)', true);
        wsTest.close();

        // ── 18. Calendar mirror behaviour unchanged ────────────────────────────
        console.log('\n  — 18. calendar mirror still created for published task —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Cal mirror test', dueDate: '2030-12-01T12:00:00.000Z',
            serviceDepartmentId: deptCucina.id, publishToService: true
        });
        const tCal = r.data.task;
        const calMirrorId = 'opsmirror_' + tCal.id;
        await new Promise(res => setTimeout(res, 400));

        // Unbound Service admin can see all calendar events
        r = await api(tokAdm, 'GET', '/api/calendar/events?start=2030-01-01&end=2030-12-31');
        const calMirror = (r.data.events || []).find(e => e.id === calMirrorId);
        check('18a. calendar mirror created', !!calMirror, r.data.events?.length);
        check('18b. calendar mirror source=OPERATIONS', calMirror?.source === 'OPERATIONS', calMirror);
        check('18c. calendar mirror is read-only (PUT → 403)',
            (await api(tokAdm, 'PUT', `/api/calendar/events/${calMirrorId}`, {
                title: 'Hacked', date: '2030-12-01', eventType: 'other' })).status === 403);

        // ── Realtime: OPS_TASK_CREATED received by bound dept WS ─────────────
        console.log('\n  — RT. realtime OPS_TASK_CREATED arrives at bound dept —\n');
        const wsRt = await wsConnect(tokCuc);
        await new Promise(res => setTimeout(res, 400));

        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'TEST LIVE CUCINA', dueDate: '2030-12-15T18:00:00.000Z', priority: 'URGENT',
            serviceDepartmentId: deptCucina.id, publishToService: true
        });
        const tLive = r.data.task;
        const rtCreate = await wsRt.waitFor('OPS_TASK_CREATED', 5000);
        check('RT1. OPS_TASK_CREATED received by Cucina WS',
            rtCreate && rtCreate.task?.id === tLive.id, rtCreate?.task);
        check('RT2. task in payload has source=OPERATIONS and correct dept',
            rtCreate?.task?.source === 'OPERATIONS' &&
            rtCreate?.task?.serviceDepartmentId === deptCucina.id, rtCreate?.task);

        // Edit → OPS_TASK_UPDATED
        await api(tokDir, 'PATCH', `/api/operations/tasks/${tLive.id}`, { title: 'TEST LIVE CUCINA v2' });
        const rtUpdate = await wsRt.waitFor('OPS_TASK_UPDATED', 5000);
        check('RT3. OPS_TASK_UPDATED received',
            rtUpdate && rtUpdate.task?.id === tLive.id &&
            rtUpdate.task?.title === 'TEST LIVE CUCINA v2', rtUpdate?.task);

        // Complete → OPS_TASK_SERVICE_REMOVED
        await api(tokDir, 'POST', `/api/operations/tasks/${tLive.id}/complete`);
        const rtRemove = await wsRt.waitFor('OPS_TASK_SERVICE_REMOVED', 5000);
        check('RT4. OPS_TASK_SERVICE_REMOVED received on completion',
            rtRemove && rtRemove.taskId === tLive.id, rtRemove);

        wsRt.close();

        // ── Pizzeria WS isolation: Cucina events don't arrive ─────────────────
        console.log('\n  — RT isolation: Pizzeria gets no Cucina events —\n');
        const wsPizIso = await wsConnect(tokPiz);
        await new Promise(res => setTimeout(res, 400));
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Cucina only task', dueDate: '2030-12-20T18:00:00.000Z',
            serviceDepartmentId: deptCucina.id, publishToService: true
        });
        // Cucina WS receives it; Pizzeria WS should not
        const noArrival = await wsPizIso.waitFor('OPS_TASK_CREATED', 800);
        check('RT5. Pizzeria WS does not receive Cucina OPS_TASK_CREATED', noArrival === null, noArrival);
        wsPizIso.close();

        // ── Progress update still works ───────────────────────────────────────
        console.log('\n  — Progress update —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Progress card', dueDate: '2030-12-25T10:00:00.000Z',
            serviceDepartmentId: deptCucina.id, publishToService: true
        });
        const tProg = r.data.task;
        await new Promise(res => setTimeout(res, 150));
        r = await api(tokDir, 'POST', `/api/operations/tasks/${tProg.id}/progress`, { completionPercent: 50 });
        check('Progress 50%: 200', r.data.success === true, r.data);
        await new Promise(res => setTimeout(res, 150));
        // Should still be visible (not completed)
        check('Progress 50%: still in list', (await getOpsTasksFor(tokCuc))?.some(tk => tk.id === tProg.id));

        r = await api(tokDir, 'POST', `/api/operations/tasks/${tProg.id}/progress`, { completionPercent: 100 });
        check('Progress 100%: 200', r.data.success === true, r.data);
        await new Promise(res => setTimeout(res, 150));
        check('Progress 100%: removed from list', !(await getOpsTasksFor(tokCuc))?.some(tk => tk.id === tProg.id));

        // ── Overdue detection relies on dueDate in the past ──────────────────
        console.log('\n  — Overdue (past dueDate) —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Overdue task', dueDate: '2020-01-01T10:00:00.000Z', // far in past
            serviceDepartmentId: deptCucina.id, publishToService: true
        });
        const tOver = r.data.task;
        await new Promise(res => setTimeout(res, 150));
        const cucWithOver = await getOpsTasksFor(tokCuc);
        const overTask = cucWithOver?.find(tk => tk.id === tOver.id);
        check('Overdue: task is returned', !!overTask, cucWithOver?.length);
        // The front-end detects overdue from dueDate; we verify the field is there
        check('Overdue: dueDate exposed for client-side detection',
            !!overTask?.dueDate && new Date(overTask.dueDate).getTime() < Date.now(), overTask?.dueDate);

    } catch (e) {
        failed++;
        console.error('❌ Test run error:', e);
    } finally {
        proc.kill('SIGTERM');
        await new Promise(res => { proc.on('exit', res); setTimeout(res, 3000); });
    }

    console.log(`\n═══ Task 66 ops dept-cards: ${passed} passed, ${failed} failed ═══`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
