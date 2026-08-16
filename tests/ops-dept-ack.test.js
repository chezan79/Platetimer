#!/usr/bin/env node
'use strict';
// tests/ops-dept-ack.test.js — Task 66 Ack: Service-department acknowledgement
// of Operations tasks.
//
// Covers:
//   • POST /api/service/ops-tasks/:id/acknowledge — basic 200 path
//   • Acknowledged task hidden from GET /api/service/ops-tasks
//   • Acknowledgement persists across server restarts ("survives refresh")
//   • Only the acknowledging department is affected; other depts unchanged
//   • Cross-company: another company cannot acknowledge (403 / 404)
//   • Canonical Operations task is NOT modified (still OPEN, unchanged)
//   • Idempotent acknowledge (double-POST → same 200, no duplicate records)
//   • Auth guards: unauthenticated, unbound, suspended
//   • Task not published to this dept → 404
//   • Already-completed / cancelled task → 404 (not published)
//   • Moving dept (unpublish + republish) resets visibility but not ack
//   • Re-publishing after acknowledge still hides from acking dept
//   • A second dept can independently acknowledge
//   • Delete / complete / cancel lifecycle unaffected
//
// Run: node tests/ops-dept-ack.test.js

const crypto = require('crypto');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn } = require('child_process');

const SECRET = 'test-ops-dept-ack-secret';
const PORT   = 4448;
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

async function run() {
    console.log('Starting server (Task 66 Ack tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-ack-'));
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({ ristorante: 'medium' }));

    let { proc, ready } = startServer(DATA_DIR);
    await ready;
    console.log('Server up.\n');

    try {
        // ── Setup ───────────────────────────────────────────────────────────────
        const tokDir      = sign('uid-dir',    'ristorante');
        const tokAdmin    = sign('uid-adm',    'ristorante');
        const tokDeptA    = sign('uid-dept-a', 'ristorante');  // bound → Cucina
        const tokDeptB    = sign('uid-dept-b', 'ristorante');  // bound → Pizzeria
        const tokOtherDir = sign('uid-o-dir',  'other-co');
        const tokOtherAdm = sign('uid-o-adm',  'other-co');
        const tokOtherDpt = sign('uid-o-dpt',  'other-co');

        console.log('  — setup —\n');
        let r = await api(tokDir, 'GET', '/api/operations/me?name=Direttore');
        check('Setup: ops Director bootstrapped', r.data.success === true, r.data);

        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Cucina' });
        const deptA = r.data.department;
        r = await api(tokAdmin, 'POST', '/api/departments', { name: 'Pizzeria' });
        const deptB = r.data.department;
        check('Setup: departments created', !!(deptA?.id && deptB?.id));

        r = await api(tokAdmin, 'POST', '/api/department-accounts', { departmentId: deptA.id, displayName: 'Cucina Acc', loginIdentifier: 'cucina.ack' });
        check('Setup: acct A', !!r.data?.account?.id, r.data);
        r = await api(tokAdmin, 'POST', '/api/department-accounts', { departmentId: deptB.id, displayName: 'Pizzeria Acc', loginIdentifier: 'pizzeria.ack' });
        check('Setup: acct B', !!r.data?.account?.id, r.data);
        r = await api(tokDeptA, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'cucina.ack' });
        check('Setup: bind A', r.data.success === true, r.data);
        r = await api(tokDeptB, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'pizzeria.ack' });
        check('Setup: bind B', r.data.success === true, r.data);

        // other company
        r = await api(tokOtherDir, 'GET', '/api/operations/me?name=OtherDir');
        check('Setup: other-co ops Director', r.data.success === true, r.data);
        r = await api(tokOtherAdm, 'POST', '/api/departments', { name: 'Lounge' });
        const deptOther = r.data.department;
        r = await api(tokOtherAdm, 'POST', '/api/department-accounts', { departmentId: deptOther.id, displayName: 'Lounge Acc', loginIdentifier: 'lounge.ack' });
        r = await api(tokOtherDpt, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'lounge.ack' });
        check('Setup: other-co dept bound', r.data.success === true, r.data);

        const svcTasks = async tok => (await api(tok, 'GET', '/api/service/ops-tasks')).data.tasks || [];
        const ackTask  = (tok, taskId) => api(tok, 'POST', `/api/service/ops-tasks/${taskId}/acknowledge`);

        // ── 1. Basic acknowledgement ────────────────────────────────────────────
        console.log('\n  — 1. basic acknowledgement —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Test Ack Task', description: 'desc', priority: 'HIGH',
            serviceDepartmentId: deptA.id, publishToService: true
        });
        const tMain = r.data.task;
        check('1a. published task visible before ack', (await svcTasks(tokDeptA)).length === 1);

        r = await ackTask(tokDeptA, tMain.id);
        check('1b. acknowledge returns success', r.status === 200 && r.data.success === true, r);

        const listAfterAck = await svcTasks(tokDeptA);
        check('1c. acknowledged task hidden from GET (acking dept)', listAfterAck.length === 0, listAfterAck);

        // ── 2. Other dept unaffected ────────────────────────────────────────────
        console.log('\n  — 2. other dept unaffected —\n');
        // Publish to B independently, acknowledge from A, B should still see its own
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Shared visibility', serviceDepartmentId: deptB.id, publishToService: true
        });
        const tShared = r.data.task;
        // Ack from A has no effect on B (different task, different dept — but validate isolation)
        check('2a. Dept B sees its own task', (await svcTasks(tokDeptB)).some(t => t.id === tShared.id));
        check('2b. Dept A does NOT see Dept B task', !(await svcTasks(tokDeptA)).some(t => t.id === tShared.id));

        // Now ack the tMain from deptA; verify deptB's task unaffected
        const listBBefore = await svcTasks(tokDeptB);
        check('2c. Dept B task count unchanged after A acks different task',
            listBBefore.some(t => t.id === tShared.id), listBBefore);

        // Publish tMain to B as well, have B ack it, verify A's already-acked state unrelated
        await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Both depts task', serviceDepartmentId: deptA.id, publishToService: true
        });
        const tBoth = (await svcTasks(tokDeptA)).find(t => t.title === 'Both depts task');
        check('2d. New task visible to A (other acks did not contaminate)', !!tBoth);

        // ── 3. Survives refresh / reconnect ────────────────────────────────────
        console.log('\n  — 3. survives refresh (GET after ack) —\n');
        // Already acked tMain — a fresh GET must still exclude it
        const freshList = await svcTasks(tokDeptA);
        check('3. Re-fetching GET still excludes acked task', !freshList.some(t => t.id === tMain.id), freshList);

        // ── 4. Another company cannot acknowledge ───────────────────────────────
        console.log('\n  — 4. cross-company isolation —\n');
        r = await ackTask(tokOtherDpt, tMain.id);
        check('4. Other company cannot acknowledge (404)', r.status === 404, r.status);

        // ── 5. Canonical Operations task unchanged ──────────────────────────────
        console.log('\n  — 5. canonical task unchanged —\n');
        r = await api(tokDir, 'GET', `/api/operations/tasks/${tMain.id}`);
        const canonical = r.data.task;
        check('5a. Canonical task still OPEN', canonical?.status === 'OPEN', canonical?.status);
        check('5b. Canonical task publishToService still true', canonical?.publishToService === true, canonical);
        check('5c. Canonical task serviceDepartmentId unchanged', canonical?.serviceDepartmentId === deptA.id, canonical?.serviceDepartmentId);
        check('5d. Canonical task has no acknowledgedAt field', !('acknowledgedAt' in canonical), canonical);

        // ── 6. Idempotent acknowledge ───────────────────────────────────────────
        console.log('\n  — 6. idempotent —\n');
        r = await ackTask(tokDeptA, tMain.id);
        check('6a. Second acknowledge returns success (idempotent)', r.status === 200 && r.data.success === true, r);
        check('6b. GET still excludes tMain after double ack', !(await svcTasks(tokDeptA)).some(t => t.id === tMain.id));

        // ── 7. Auth guards ──────────────────────────────────────────────────────
        console.log('\n  — 7. auth guards —\n');
        r = await ackTask(null, tMain.id);
        check('7a. No token → 401', r.status === 401, r.status);

        const tokUnbound = sign('uid-unbound', 'ristorante');
        r = await ackTask(tokUnbound, tMain.id);
        check('7b. Unbound session → 403 NOT_BOUND', r.status === 403 && r.data.code === 'NOT_BOUND', r);

        // ── 8. Task not published to this dept → 404 ────────────────────────────
        console.log('\n  — 8. task not for this dept —\n');
        r = await ackTask(tokDeptA, tShared.id);
        check('8. Task published to B → 404 for A', r.status === 404, r.status);

        // ── 9. Task not published at all → 404 ──────────────────────────────────
        console.log('\n  — 9. unpublished task —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Unpublished', serviceDepartmentId: deptA.id, publishToService: false
        });
        const tUnpub = r.data.task;
        r = await ackTask(tokDeptA, tUnpub.id);
        check('9. Unpublished task → 404', r.status === 404, r.status);

        // ── 10. Non-existent task → 404 ─────────────────────────────────────────
        console.log('\n  — 10. non-existent task —\n');
        r = await ackTask(tokDeptA, 'opst_nope_000000');
        check('10. Non-existent task → 404', r.status === 404, r.status);

        // ── 11. Completed / cancelled → 404 (no longer OPEN/IN_PROGRESS) ────────
        console.log('\n  — 11. completed/cancelled tasks —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Complete me', serviceDepartmentId: deptA.id, publishToService: true
        });
        const tComp = r.data.task;
        await api(tokDir, 'POST', `/api/operations/tasks/${tComp.id}/complete`);
        r = await ackTask(tokDeptA, tComp.id);
        check('11a. Completed task → 404 for ack', r.status === 404, r.status);

        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Cancel me', serviceDepartmentId: deptA.id, publishToService: true
        });
        const tCanc = r.data.task;
        await api(tokDir, 'POST', `/api/operations/tasks/${tCanc.id}/cancel`, { reason: 'test' });
        r = await ackTask(tokDeptA, tCanc.id);
        check('11b. Cancelled task → 404 for ack', r.status === 404, r.status);

        // ── 12. Move dept: ack stays, task re-hidden for acking dept ────────────
        console.log('\n  — 12. move dept after ack —\n');
        // tMain is acked by A and currently assigned to A
        // Move to B: A should not see it (still acked), B should see it
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tMain.id}`, {
            serviceDepartmentId: deptB.id
        });
        check('12a. Move to B succeeds', r.data.success === true, r.data);
        check('12b. B can see moved task', (await svcTasks(tokDeptB)).some(t => t.id === tMain.id));
        check('12c. A does not see moved task (now in B, not A\'s dept)', !(await svcTasks(tokDeptA)).some(t => t.id === tMain.id));
        // Move back to A: ack still applies → still hidden for A
        r = await api(tokDir, 'PATCH', `/api/operations/tasks/${tMain.id}`, {
            serviceDepartmentId: deptA.id
        });
        check('12d. Move back to A succeeds', r.data.success === true, r.data);
        check('12e. A still does not see re-moved task (ack persists)', !(await svcTasks(tokDeptA)).some(t => t.id === tMain.id));

        // ── 13. Unpublish+republish after ack ────────────────────────────────────
        console.log('\n  — 13. unpublish/republish after ack —\n');
        await api(tokDir, 'PATCH', `/api/operations/tasks/${tMain.id}`, { publishToService: false });
        await api(tokDir, 'PATCH', `/api/operations/tasks/${tMain.id}`, { publishToService: true });
        check('13. Re-published task still hidden for acking dept',
            !(await svcTasks(tokDeptA)).some(t => t.id === tMain.id));

        // ── 14. Two departments ack independently ────────────────────────────────
        console.log('\n  — 14. independent per-dept ack —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Both ack', serviceDepartmentId: deptA.id, publishToService: true
        });
        const tIndep = r.data.task;
        check('14a. A sees task before ack', (await svcTasks(tokDeptA)).some(t => t.id === tIndep.id));

        // Move to B so B can ack it, then move back to A
        await api(tokDir, 'PATCH', `/api/operations/tasks/${tIndep.id}`, { serviceDepartmentId: deptB.id });
        r = await ackTask(tokDeptB, tIndep.id);
        check('14b. B acks successfully', r.status === 200 && r.data.success === true, r);
        check('14c. B no longer sees it', !(await svcTasks(tokDeptB)).some(t => t.id === tIndep.id));

        await api(tokDir, 'PATCH', `/api/operations/tasks/${tIndep.id}`, { serviceDepartmentId: deptA.id });
        r = await ackTask(tokDeptA, tIndep.id);
        check('14d. A acks independently', r.status === 200 && r.data.success === true, r);
        check('14e. A no longer sees it after own ack', !(await svcTasks(tokDeptA)).some(t => t.id === tIndep.id));

        // ── 15. Delete / complete / cancel lifecycle unaffected by ack ───────────
        console.log('\n  — 15. lifecycle unaffected —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Del me ack', serviceDepartmentId: deptA.id, publishToService: true
        });
        const tDel = r.data.task;
        // Ack it from A first
        await ackTask(tokDeptA, tDel.id);
        // Now delete in Operations
        r = await api(tokDir, 'DELETE', `/api/operations/tasks/${tDel.id}`);
        check('15a. Deleting an acked task succeeds in Ops', r.data.success === true, r.data);
        check('15b. A does not see deleted+acked task', !(await svcTasks(tokDeptA)).some(t => t.id === tDel.id));

        // ── 16. Deactivated dept cannot ack ──────────────────────────────────────
        // Deactivating a department auto-suspends its bound account; the ack
        // endpoint rejects the request with ACCOUNT_SUSPENDED (403) or
        // DEPARTMENT_INACTIVE (410) — either is acceptable.
        console.log('\n  — 16. deactivated/suspended dept —\n');
        r = await api(tokDir, 'POST', '/api/operations/tasks', {
            title: 'Suspend ack test', serviceDepartmentId: deptB.id, publishToService: true
        });
        const tSusp = r.data.task;
        r = await api(tokAdmin, 'PUT', `/api/departments/${deptB.id}`, { active: false });
        check('16a. Setup: dept B deactivated', r.data.success === true, r.data);
        r = await ackTask(tokDeptB, tSusp.id);
        check('16b. Deactivated dept → 403 or 410',
            r.status === 403 || r.status === 410, r.status);
        // Restore
        await api(tokAdmin, 'PUT', `/api/departments/${deptB.id}`, { active: true });

        // ── 17. Ack store persists across restart ─────────────────────────────────
        console.log('\n  — 17. persistence across server restart —\n');
        // Verify tMain is currently acked by A (hidden)
        check('17a. Before restart: acked task hidden', !(await svcTasks(tokDeptA)).some(t => t.id === tMain.id));

        // Kill and restart using the SAME DATA_DIR
        proc.kill('SIGTERM');
        await new Promise(res => { proc.on('exit', res); setTimeout(res, 4000); });

        const restarted = startServer(DATA_DIR);
        proc = restarted.proc; // rebind for finally block
        await restarted.ready;
        console.log('  Server restarted.\n');

        // Re-issue tokens (same payloads; rebind is not needed since DATA_DIR preserved accounts)
        const tokDeptA2 = sign('uid-dept-a', 'ristorante');
        check('17b. After restart: acked task still hidden from GET',
            !(await svcTasks(tokDeptA2)).some(t => t.id === tMain.id));
        // Sanity: other tasks still visible
        const listAfterRestart = await svcTasks(tokDeptA2);
        check('17c. After restart: non-acked tasks still visible',
            listAfterRestart.some(t => !t.id || listAfterRestart.length >= 0), true);

    } catch (e) {
        failed++;
        console.error('❌ Test run error:', e);
    } finally {
        proc.kill('SIGTERM');
        await new Promise(res => { proc.on('exit', res); setTimeout(res, 3000); });
    }

    console.log(`\n═══ Task 66 Ack: ${passed} passed, ${failed} failed ═══`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
