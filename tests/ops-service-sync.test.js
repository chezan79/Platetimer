#!/usr/bin/env node
'use strict';
// tests/ops-service-sync.test.js — Task 66: Operations → Service task sync.
//
// Covers:
//   • Service-facing GET /api/service/ops-tasks visibility & isolation
//   • serviceDepartmentId validation (cross-company / missing / inactive → 400)
//   • Propagation of edits to the Service projection
//   • Explicit OPS_TASK_SERVICE_REMOVED broadcasts (move / unpublish /
//     complete / cancel / delete) and their absence for unpublished tasks
//   • Read-only projection shape (no companyId/assigneeId/createdBy)
//
// Run: node tests/ops-service-sync.test.js

const crypto = require('crypto');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn } = require('child_process');
const WS     = require('ws');

const SECRET = 'test-ops-service-sync-secret';
const PORT   = 4450;
const BASE   = `http://127.0.0.1:${PORT}`;

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

// WS helper with consume-semantics waitFor (same pattern as sprint 5 suite)
function wsConnect(token) {
    return new Promise((resolve, reject) => {
        const buffer = [], waiters = [], received = [];
        const client = new WS(`ws://127.0.0.1:${PORT}/ws`);
        client.on('open', () => {
            client.send(JSON.stringify({ action: 'joinRoom', token }));
            resolve({
                client, received,
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
        client.on('close', () => waiters.splice(0).forEach(w => { clearTimeout(w._timer); w.resolve(null); }));
    });
}

async function run() {
    console.log('Starting server (Task 66 ops→service sync tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-svc-sync-'));
    // medium plan → 5 active departments allowed
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({ ristorante: 'medium' }));

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
        // ── Setup ────────────────────────────────────────────────────────────
        const tokDir      = sign('uid-director', 'ristorante');   // ops Director (bootstraps)
        const tokAdmin    = sign('uid-admin',    'ristorante');   // unbound Service admin
        const tokDeptA    = sign('uid-dept-a',   'ristorante');   // bound → Cucina
        const tokDeptB    = sign('uid-dept-b',   'ristorante');   // bound → Pizzeria
        const tokOtherDir = sign('uid-o-dir',    'other-co');     // other company ops Director
        const tokOtherAdm = sign('uid-o-adm',    'other-co');
        const tokOtherDpt = sign('uid-o-dept',   'other-co');

        console.log('  — setup —\n');
        let r = await api(tokDir, 'GET', '/api/operations/me?name=Direttore');
        check('Setup: ops Director bootstrapped', r.data.success === true, r.data);
        const directorId = r.data.user.id;

        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Cucina' });
        const deptA = r.data.department;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Pizzeria' });
        const deptB = r.data.department;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Magazzino' });
        const deptC = r.data.department;
        check('Setup: departments created', !!(deptA?.id && deptB?.id && deptC?.id));
        r = await api(tokAdmin, 'PUT', `/api/departments/${deptC.id}`, { active: false });
        check('Setup: Magazzino deactivated', r.data.success === true, r.data);

        r = await api(tokAdmin, 'POST', '/api/department-accounts', { departmentId: deptA.id, displayName: 'Cucina Display', loginIdentifier: 'cucina.t66' });
        check('Setup: acct A', !!r.data?.account?.id, r.data);
        r = await api(tokAdmin, 'POST', '/api/department-accounts', { departmentId: deptB.id, displayName: 'Pizzeria Display', loginIdentifier: 'pizzeria.t66' });
        check('Setup: acct B', !!r.data?.account?.id, r.data);
        r = await api(tokDeptA, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'cucina.t66' });
        check('Setup: bind A', r.data.success === true, r.data);
        r = await api(tokDeptB, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'pizzeria.t66' });
        check('Setup: bind B', r.data.success === true, r.data);

        // other company
        r = await api(tokOtherDir, 'GET', '/api/operations/me?name=OtherDir');
        check('Setup: other-co ops Director', r.data.success === true, r.data);
        r = await api(tokOtherAdm, 'POST', '/api/departments', { name: 'Lounge' });
        const deptOther = r.data.department;
        r = await api(tokOtherAdm, 'POST', '/api/department-accounts', { departmentId: deptOther.id, displayName: 'Lounge Display', loginIdentifier: 'lounge.t66' });
        r = await api(tokOtherDpt, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'lounge.t66' });
        check('Setup: other-co dept bound', r.data.success === true, r.data);

        const svcTasks = async tok => (await api(tok, 'GET', '/api/service/ops-tasks')).data.tasks || [];

        // ── Endpoint: service-departments dropdown source ─────────────────────
        console.log('\n  — service-departments endpoint —\n');
        r = await api(tokDir, 'GET', '/api/operations/service-departments');
        check('service-departments: lists active only, sorted', r.data.success === true &&
            r.data.departments.length === 2 &&
            r.data.departments[0].name === 'Cucina' && r.data.departments[1].name === 'Pizzeria' &&
            r.data.departments.every(d => d.id && d.name && Object.keys(d).length === 2), r.data);
        r = await api(tokDeptA, 'GET', '/api/operations/service-departments');
        check('service-departments: rejected for non-ops session', r.status === 403 || r.status === 401, r.status);

        // ── 1–5: visibility & isolation ───────────────────────────────────────
        console.log('\n  — visibility & isolation —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', { title: 'No dept task' });
        const tPlain = r.data.task;
        check('1. task without serviceDepartmentId → not in Service GET',
            (await svcTasks(tokDeptA)).length === 0);

        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Unpublished', serviceDepartmentId: deptA.id, publishToService: false });
        check('2. dept set but publishToService=false → not returned',
            r.data.success === true && (await svcTasks(tokDeptA)).length === 0, r.data);

        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Prep cucina', description: 'Mise en place', priority: 'HIGH',
            dueDate: '2030-01-01T10:00', serviceDepartmentId: deptA.id, publishToService: true });
        const tPub = r.data.task;
        check('Create: task fields persisted', tPub && tPub.serviceDepartmentId === deptA.id &&
            tPub.publishToService === true && tPub.serviceDepartmentName === 'Cucina', tPub);
        let listA = await svcTasks(tokDeptA);
        check('3. published task returned to correct department',
            listA.length === 1 && listA[0].id === tPub.id && listA[0].title === 'Prep cucina', listA);
        check('4. other department of same company → empty', (await svcTasks(tokDeptB)).length === 0);
        check('5. other company department → empty', (await svcTasks(tokOtherDpt)).length === 0);

        // ── 6–8: serviceDepartmentId validation ──────────────────────────────
        console.log('\n  — serviceDepartmentId validation —\n');
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { serviceDepartmentId: deptOther.id, publishToService: true });
        check('6. other company dept ID in PATCH → 400', r.status === 400, r.status);
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { serviceDepartmentId: 'dept_nope_123' });
        check('7. non-existent dept ID → 400', r.status === 400, r.status);
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { serviceDepartmentId: deptC.id });
        check('8. inactive dept ID → 400', r.status === 400, r.status);
        r = await api(tokDir, 'POST', '/api/operations/tasks', { title: 'bad', serviceDepartmentId: deptOther.id, publishToService: true });
        check('Create with foreign dept ID → 400', r.status === 400, r.status);

        // ── 9–12: propagation ─────────────────────────────────────────────────
        console.log('\n  — propagation of edits —\n');
        await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { title: 'Prep cucina v2' });
        listA = await svcTasks(tokDeptA);
        check('9. title update propagates', listA[0]?.title === 'Prep cucina v2', listA);
        await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { description: 'Nuova descrizione' });
        listA = await svcTasks(tokDeptA);
        check('10. description update propagates', listA[0]?.description === 'Nuova descrizione', listA);
        await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { dueDate: '2031-05-05T12:00' });
        listA = await svcTasks(tokDeptA);
        check('11. due date update propagates', listA[0]?.dueDate === '2031-05-05T12:00', listA);
        await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { priority: 'URGENT' });
        listA = await svcTasks(tokDeptA);
        check('12. priority update propagates', listA[0]?.priority === 'URGENT', listA);

        // ── 13: department move A → B ────────────────────────────────────────
        console.log('\n  — move / publish toggles / lifecycle —\n');
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { serviceDepartmentId: deptB.id });
        check('13. move A→B: A empty, B has task',
            r.data.success === true &&
            (await svcTasks(tokDeptA)).length === 0 &&
            (await svcTasks(tokDeptB)).some(t => t.id === tPub.id), r.data);

        // ── 14/15: publish toggles ────────────────────────────────────────────
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { publishToService: false });
        check('14. publish true→false removes from Service GET',
            r.data.success === true && (await svcTasks(tokDeptB)).length === 0, r.data);
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tPub.id}`, { publishToService: true });
        check('15. publish false→true re-appears in Service GET',
            r.data.success === true && (await svcTasks(tokDeptB)).length === 1, r.data);

        // ── 16–18: lifecycle removals ─────────────────────────────────────────
        r = await api(tokDir, 'POST', `/api/operations/tasks/${tPub.id}/complete`);
        check('16. completion removes from Service GET',
            r.data.success === true && (await svcTasks(tokDeptB)).length === 0, r.data);

        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Da cancellare', serviceDepartmentId: deptB.id, publishToService: true });
        const tCanc = r.data.task;
        check('16b. new published task visible', (await svcTasks(tokDeptB)).length === 1);
        r = await api(tokDir, 'POST', `/api/operations/tasks/${tCanc.id}/cancel`, { reason: 'test' });
        check('17. cancellation removes from Service GET',
            r.data.success === true && (await svcTasks(tokDeptB)).length === 0, r.data);

        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Da eliminare', serviceDepartmentId: deptB.id, publishToService: true });
        const tDel = r.data.task;
        r = await api(tokDir, 'DELETE', `/api/operations/tasks/${tDel.id}`);
        check('18. deletion removes from Service GET',
            r.data.success === true && (await svcTasks(tokDeptB)).length === 0, r.data);

        // ── 19: canonical record retains fields ───────────────────────────────
        r = await api(tokDir, 'GET', `/api/operations/tasks/${tPub.id}`);
        const canonical = r.data.task;
        check('19. canonical ops record retains all fields after mutations',
            canonical && canonical.serviceDepartmentId === deptB.id &&
            canonical.publishToService === true &&
            canonical.serviceDepartmentName === 'Pizzeria' &&
            canonical.status === 'COMPLETED' && canonical.title === 'Prep cucina v2' &&
            canonical.companyId === 'ristorante' && canonical.assigneeId === directorId, canonical);

        // ── 20: projection omits internal fields ─────────────────────────────
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Proiezione', description: 'x', serviceDepartmentId: deptA.id, publishToService: true });
        const tProj = r.data.task;
        listA = await svcTasks(tokDeptA);
        const proj = listA.find(t => t.id === tProj.id);
        check('20. projection omits internal fields & has safe shape',
            proj && proj.source === 'OPERATIONS' &&
            proj.serviceDepartmentName === 'Cucina' &&
            proj.assigneeName !== undefined &&
            proj.companyId === undefined && proj.assigneeId === undefined &&
            proj.createdBy === undefined && proj.history === undefined &&
            proj.comments === undefined && proj.attachments === undefined &&
            proj.escalation === undefined, proj);

        // ── WS: explicit removal events ───────────────────────────────────────
        console.log('\n  — WebSocket explicit removal events —\n');
        const sub = await wsConnect(tokDir);
        const subOther = await wsConnect(tokOtherDir);
        await new Promise(res => setTimeout(res, 300));

        // 21. dept move A → B
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'WS move', serviceDepartmentId: deptA.id, publishToService: true });
        const wsT = r.data.task;
        await sub.waitFor('OPS_TASK_CREATED');
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${wsT.id}`, { serviceDepartmentId: deptB.id });
        let evUpd = await sub.waitFor('OPS_TASK_UPDATED');
        let evRem = await sub.waitFor('OPS_TASK_SERVICE_REMOVED');
        check('21a. move: OPS_TASK_SERVICE_REMOVED with prev dept A',
            evRem && evRem.taskId === wsT.id && evRem.prevServiceDepartmentId === deptA.id, evRem);
        check('21b. move: OPS_TASK_UPDATED carries new dept B',
            evUpd && evUpd.task.id === wsT.id && evUpd.task.serviceDepartmentId === deptB.id &&
            evUpd.task.publishToService === true, evUpd && evUpd.task);

        // 22. unpublish
        await api(tokDir, 'PATCH', `/api/operations/tasks/${wsT.id}`, { publishToService: false });
        await sub.waitFor('OPS_TASK_UPDATED');
        evRem = await sub.waitFor('OPS_TASK_SERVICE_REMOVED');
        check('22. unpublish: OPS_TASK_SERVICE_REMOVED with prev dept B',
            evRem && evRem.taskId === wsT.id && evRem.prevServiceDepartmentId === deptB.id, evRem);

        // 23. completion
        await api(tokDir, 'PATCH', `/api/operations/tasks/${wsT.id}`, { publishToService: true });
        await sub.waitFor('OPS_TASK_UPDATED');
        await api(tokDir, 'POST', `/api/operations/tasks/${wsT.id}/complete`);
        await sub.waitFor('OPS_TASK_COMPLETED');
        evRem = await sub.waitFor('OPS_TASK_SERVICE_REMOVED');
        check('23. completion: OPS_TASK_SERVICE_REMOVED emitted',
            evRem && evRem.taskId === wsT.id && evRem.prevServiceDepartmentId === deptB.id, evRem);

        // 24. cancellation
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'WS cancel', serviceDepartmentId: deptB.id, publishToService: true });
        const wsT2 = r.data.task;
        await sub.waitFor('OPS_TASK_CREATED');
        await api(tokDir, 'POST', `/api/operations/tasks/${wsT2.id}/cancel`, { reason: 'ws' });
        await sub.waitFor('OPS_TASK_UPDATED');
        evRem = await sub.waitFor('OPS_TASK_SERVICE_REMOVED');
        check('24. cancellation: OPS_TASK_SERVICE_REMOVED emitted',
            evRem && evRem.taskId === wsT2.id && evRem.prevServiceDepartmentId === deptB.id, evRem);

        // 25. deletion
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'WS delete', serviceDepartmentId: deptA.id, publishToService: true });
        const wsT3 = r.data.task;
        await sub.waitFor('OPS_TASK_CREATED');
        await api(tokDir, 'DELETE', `/api/operations/tasks/${wsT3.id}`);
        const evDel = await sub.waitFor('OPS_TASK_DELETED');
        evRem = await sub.waitFor('OPS_TASK_SERVICE_REMOVED');
        check('25a. deletion: OPS_TASK_DELETED still emitted', evDel && evDel.taskId === wsT3.id, evDel);
        check('25b. deletion: OPS_TASK_SERVICE_REMOVED emitted with prev dept A',
            evRem && evRem.taskId === wsT3.id && evRem.prevServiceDepartmentId === deptA.id, evRem);

        // 26. never-published task: no removal on complete/delete
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Never published', serviceDepartmentId: deptA.id, publishToService: false });
        const wsT4 = r.data.task;
        await sub.waitFor('OPS_TASK_CREATED');
        await api(tokDir, 'POST', `/api/operations/tasks/${wsT4.id}/complete`);
        await sub.waitFor('OPS_TASK_COMPLETED');
        let noRem = await sub.waitFor('OPS_TASK_SERVICE_REMOVED', 800);
        check('26a. unpublished complete: NO OPS_TASK_SERVICE_REMOVED', noRem === null, noRem);
        await api(tokDir, 'DELETE', `/api/operations/tasks/${wsT4.id}`);
        await sub.waitFor('OPS_TASK_DELETED');
        noRem = await sub.waitFor('OPS_TASK_SERVICE_REMOVED', 800);
        check('26b. unpublished delete: NO OPS_TASK_SERVICE_REMOVED', noRem === null, noRem);

        // 27. plain ops task (no dept) — behaviour unchanged, no removal event
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tPlain.id}`, { title: 'Plain v2' });
        const evPlain = await sub.waitFor('OPS_TASK_UPDATED');
        check('27a. plain task update event unchanged',
            evPlain && evPlain.task.id === tPlain.id && evPlain.task.title === 'Plain v2' &&
            evPlain.task.serviceDepartmentId === null && evPlain.task.publishToService === false, evPlain && evPlain.task);
        noRem = await sub.waitFor('OPS_TASK_SERVICE_REMOVED', 800);
        check('27b. plain task update: NO OPS_TASK_SERVICE_REMOVED', noRem === null, noRem);

        // 28. existing CRUD events still fire with expected fields + reassign consistency signal
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'CRUD check', serviceDepartmentId: deptA.id, publishToService: true, priority: 'LOW' });
        const wsT5 = r.data.task;
        const evCr = await sub.waitFor('OPS_TASK_CREATED');
        check('28a. OPS_TASK_CREATED carries service fields',
            evCr && evCr.task.id === wsT5.id && evCr.task.serviceDepartmentId === deptA.id &&
            evCr.task.publishToService === true && evCr.task.serviceDepartmentName === 'Cucina' &&
            evCr.task.priority === 'LOW' && evCr.task.effectiveStatus !== undefined, evCr && evCr.task);
        r = await api(tokDir, 'POST', `/api/operations/tasks/${wsT5.id}/reassign`, { assigneeId: directorId });
        const evRe = await sub.waitFor('OPS_TASK_REASSIGNED');
        evRem = await sub.waitFor('OPS_TASK_SERVICE_REMOVED');
        check('28b. reassign: OPS_TASK_REASSIGNED + consistency removal signal',
            evRe && evRe.task.id === wsT5.id &&
            evRem && evRem.taskId === wsT5.id && evRem.prevServiceDepartmentId === deptA.id, { evRe, evRem });

        // ── WS: bound Service department socket filtering ─────────────────────
        console.log('\n  — bound department socket filtering —\n');
        const subA = await wsConnect(tokDeptA);   // bound → Cucina
        const subB = await wsConnect(tokDeptB);   // bound → Pizzeria
        await new Promise(res => setTimeout(res, 400));
        subA.received.length = 0; subB.received.length = 0;

        // 29. published-to-A task: A gets safe projection, B gets nothing
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Bound WS', description: 'segreto no', serviceDepartmentId: deptA.id,
            publishToService: true, priority: 'HIGH' });
        const bT = r.data.task;
        await sub.waitFor('OPS_TASK_CREATED');
        const evA = await subA.waitFor('OPS_TASK_CREATED');
        check('29a. entitled dept socket receives safe projection',
            evA && evA.task.id === bT.id && evA.task.title === 'Bound WS' &&
            evA.task.source === 'OPERATIONS' && evA.task.serviceDepartmentId === deptA.id, evA);
        check('29b. projection over WS omits internal fields',
            evA && evA.task.companyId === undefined && evA.task.assigneeId === undefined &&
            evA.task.createdBy === undefined && evA.task.history === undefined &&
            evA.task.comments === undefined && evA.task.notes === undefined, evA && evA.task);
        const evBnone = await subB.waitFor('OPS_TASK_CREATED', 800);
        check('29c. unrelated dept socket receives NO task event', evBnone === null, evBnone);

        // 30. unpublished task in same company: neither bound socket receives anything
        await api(tokDir, 'POST', '/api/operations/tasks', { title: 'Interno', serviceDepartmentId: deptB.id, publishToService: false });
        await sub.waitFor('OPS_TASK_CREATED');
        check('30. unpublished task: no bound socket receives it',
            (await subA.waitFor('OPS_TASK_CREATED', 700)) === null &&
            (await subB.waitFor('OPS_TASK_CREATED', 300)) === null);

        // 31. move A→B over bound sockets: A gets only removal, B gets projection
        subA.received.length = 0; subB.received.length = 0;
        await api(tokDir, 'PATCH', `/api/operations/tasks/${bT.id}`, { serviceDepartmentId: deptB.id });
        await sub.waitFor('OPS_TASK_UPDATED'); await sub.waitFor('OPS_TASK_SERVICE_REMOVED');
        const remA = await subA.waitFor('OPS_TASK_SERVICE_REMOVED');
        const updB = await subB.waitFor('OPS_TASK_UPDATED');
        check('31a. move: prior dept gets minimal removal event only',
            remA && remA.taskId === bT.id && remA.prevServiceDepartmentId === deptA.id &&
            remA.task === undefined &&
            subA.received.filter(m => m.action.startsWith('OPS_') && m.action !== 'OPS_TASK_SERVICE_REMOVED').length === 0,
            { remA, other: subA.received });
        check('31b. move: new dept gets safe projection, no removal',
            updB && updB.task.id === bT.id && updB.task.serviceDepartmentId === deptB.id &&
            updB.task.companyId === undefined &&
            (await subB.waitFor('OPS_TASK_SERVICE_REMOVED', 500)) === null, updB);

        // 32. completion: entitled dept gets removal, NOT the full COMPLETED payload
        subB.received.length = 0;
        await api(tokDir, 'POST', `/api/operations/tasks/${bT.id}/complete`);
        await sub.waitFor('OPS_TASK_COMPLETED'); await sub.waitFor('OPS_TASK_SERVICE_REMOVED');
        const remB = await subB.waitFor('OPS_TASK_SERVICE_REMOVED');
        check('32. completion: bound socket gets removal only, no full task payload',
            remB && remB.taskId === bT.id && remB.prevServiceDepartmentId === deptB.id &&
            subB.received.filter(m => m.action === 'OPS_TASK_COMPLETED').length === 0,
            { remB, other: subB.received });

        // 33. bound sockets never see unrelated OPS traffic (plain-task update)
        subA.received.length = 0; subB.received.length = 0;
        await api(tokDir, 'PATCH', `/api/operations/tasks/${tPlain.id}`, { title: 'Plain v3' });
        await sub.waitFor('OPS_TASK_UPDATED');
        await new Promise(res => setTimeout(res, 500));
        check('33. plain-task update: zero OPS events on bound sockets',
            subA.received.filter(m => m.action.startsWith('OPS_')).length === 0 &&
            subB.received.filter(m => m.action.startsWith('OPS_')).length === 0,
            { a: subA.received, b: subB.received });

        // 34. department deactivated AFTER publication: access revoked immediately
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Pre-deactivation', serviceDepartmentId: deptA.id, publishToService: true });
        const dT = r.data.task;
        await sub.waitFor('OPS_TASK_CREATED');
        await subA.waitFor('OPS_TASK_CREATED');
        r = await api(tokAdmin, 'PUT', `/api/departments/${deptA.id}`, { active: false });
        check('34a. setup: dept A deactivated post-publication', r.data.success === true, r.data);
        r = await api(tokDeptA, 'GET', '/api/service/ops-tasks');
        // Deactivating a department auto-suspends its account, so the account
        // guard (403 ACCOUNT_SUSPENDED) may fire before the live-department
        // check (410 DEPARTMENT_INACTIVE). Either way, access is revoked.
        check('34b. HTTP: post-deactivation access revoked (403 suspended or 410 inactive)',
            (r.status === 403 && r.data.code === 'ACCOUNT_SUSPENDED') ||
            (r.status === 410 && r.data.code === 'DEPARTMENT_INACTIVE'), r);
        subA.received.length = 0;
        await api(tokDir, 'PATCH', `/api/operations/tasks/${dT.id}`, { title: 'Post-deactivation edit' });
        await sub.waitFor('OPS_TASK_UPDATED');
        await new Promise(res => setTimeout(res, 600));
        check('34c. WS: inactive bound dept receives NO ops events',
            subA.received.filter(m => m.action.startsWith('OPS_')).length === 0, subA.received);
        // reactivate for any later checks
        await api(tokAdmin, 'PUT', `/api/departments/${deptA.id}`, { active: true });

        subA.close(); subB.close();

        // Company isolation on WS: other company never saw ristorante events
        check('WS isolation: other company received no ristorante OPS events',
            subOther.received.filter(m => m.action && m.action.startsWith('OPS_')).length === 0,
            subOther.received.filter(m => m.action && m.action.startsWith('OPS_')));

        sub.close(); subOther.close();
    } catch (e) {
        failed++;
        console.error('❌ Test run error:', e);
    } finally {
        proc.kill('SIGTERM');
        await new Promise(res => { proc.on('exit', res); setTimeout(res, 3000); });
    }

    console.log(`\n═══ Task 66 ops→service sync: ${passed} passed, ${failed} failed ═══`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
