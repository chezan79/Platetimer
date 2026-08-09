// tests/operations-sprint2.test.js — Sprint 2 security & lifecycle tests.
//
// Validates: task lifecycle, progress, editing, reassignment, comments,
// audit history, role hierarchy enforcement, cross-company isolation.
//
// Run: node tests/operations-sprint2.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = 'test-secret-sprint2-suite';
const PORT = 5099;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'opss2-'));

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({ uid, companyName, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

async function api(token, method, p, body) {
    const res = await fetch(BASE + p, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

async function main() {
    console.log('Starting server (Sprint 2 tests)…');
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT), WS_SESSION_SECRET: SECRET, DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
        server.stdout.on('data', d => { if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(); } });
    });
    console.log('Server up. Running Sprint 2 checks…\n');

    try {
        // Tokens
        const dirA  = sign('uid-s2dirA',  'sprint2-co-a');
        const dirB  = sign('uid-s2dirB',  'sprint2-co-b');

        // Bootstrap company A: Director + 4 team members
        let r = await api(dirA, 'GET', '/api/operations/me?name=Anna%20Dir');
        const dirAId = r.data.user.id;

        async function invite(token, name, email, role) {
            return api(token, 'POST', '/api/operations/users', { name, email, role });
        }
        const cc  = await invite(dirA, 'Carlo CC',    'cc@s2.it',  'CHEF_CUISINE');
        const adj = await invite(dirA, 'Ada Adj',     'adj@s2.it', 'ADJOINT');
        const sc  = await invite(dirA, 'Sara SC',     'sc@s2.it',  'SOUS_CHEF');
        const cdb = await invite(dirA, 'Ciro CdB',   'cdb@s2.it', 'CHEF_DE_BRIGADE');
        const cdb2= await invite(dirA, 'Dario CdB2', 'cdb2@s2.it','CHEF_DE_BRIGADE');
        const ccId  = cc.data.user.id;
        const adjId = adj.data.user.id;
        const scId  = sc.data.user.id;
        const cdbId = cdb.data.user.id;
        const cdb2Id= cdb2.data.user.id;

        // Company B Director
        await api(dirB, 'GET', '/api/operations/me?name=Bruno%20Dir');
        const dirBMeB = await api(dirB, 'GET', '/api/operations/me');
        const dirBId = dirBMeB.data.user.id;

        // ── Task creation + model ──
        r = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Mise en place', priority: 'HIGH',
            assigneeId: cdbId, dueDate: '2024-01-01T10:00',
            companyId: 'FORGED', createdBy: 'FORGED', status: 'COMPLETED', completedAt: 123
        });
        check('S2-1. Task created; forged fields (companyId/createdBy/status) ignored',
            r.status === 201 &&
            r.data.task.companyId === 'sprint2-co-a' &&
            r.data.task.createdBy === dirAId &&
            r.data.task.status === 'OPEN' &&
            r.data.task.completedAt === null,
            r.data.task);
        const taskId = r.data.task.id;
        check('S2-1b. Task history begins with TASK_CREATED event',
            Array.isArray(r.data.task.history) && r.data.task.history[0] && r.data.task.history[0].type === 'TASK_CREATED',
            r.data.task.history);
        check('S2-1c. assigneeName and createdByName snapshots present',
            r.data.task.assigneeName === 'Ciro CdB' && r.data.task.createdByName === 'Anna Dir',
            { an: r.data.task.assigneeName, cn: r.data.task.createdByName });

        // ── GET /api/operations/tasks/:id ──
        r = await api(dirA, 'GET', `/api/operations/tasks/${taskId}`);
        check('S2-2. GET task/:id returns full task',
            r.status === 200 && r.data.success && r.data.task.id === taskId, r.data.task && r.data.task.status);

        // ── PATCH edit (Director can edit any company task) ──
        r = await api(dirA, 'PATCH', `/api/operations/tasks/${taskId}`, {
            title: 'Mise en place UPDATED', priority: 'URGENT', notes: 'Note del direttore',
            companyId: 'FORGED', history: [{ type: 'FORGED' }], createdBy: 'FORGED' // must be ignored
        });
        check('S2-3. Director can edit any company task (PATCH)',
            r.status === 200 && r.data.task.title === 'Mise en place UPDATED' && r.data.task.priority === 'URGENT',
            r.data.task && r.data.task.priority);
        check('S2-3b. Forged companyId/history/createdBy ignored on PATCH',
            r.data.task.companyId === 'sprint2-co-a' &&
            r.data.task.createdBy === dirAId &&
            !r.data.task.history.some(h => h.type === 'FORGED'),
            r.data.task.companyId);
        check('S2-3c. TASK_EDITED history event added',
            r.data.task.history.some(h => h.type === 'TASK_EDITED'), r.data.task.history.length);

        // ── Company isolation: B cannot edit A task ──
        r = await api(dirB, 'PATCH', `/api/operations/tasks/${taskId}`, { title: 'Stolen' });
        check('S2-4. Company A task invisible to Company B (404)',
            r.status === 404, r.data);

        // ── /start endpoint ──
        // Use PUT (backward-compat) to simulate being the assignee by having Director do it
        // Assignee-only guard — Director cannot start (not assignee)
        r = await api(dirA, 'POST', `/api/operations/tasks/${taskId}/start`);
        check('S2-5. Non-assignee cannot start task (403)',
            r.status === 403, r.data);

        // Create a task self-assigned to Director for start/progress/complete tests
        const selfR = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Director self task', priority: 'MEDIUM', assigneeId: dirAId
        });
        const selfId = selfR.data.task.id;

        r = await api(dirA, 'POST', `/api/operations/tasks/${selfId}/start`);
        check('S2-6. Assignee can start task; status becomes IN_PROGRESS',
            r.status === 200 && r.data.task.status === 'IN_PROGRESS' && r.data.task.startedAt > 0, r.data.task && r.data.task.status);
        check('S2-6b. TASK_STARTED history event added',
            r.data.task.history.some(h => h.type === 'TASK_STARTED'), r.data.task.history);

        // ── Progress ──
        r = await api(dirA, 'POST', `/api/operations/tasks/${selfId}/progress`, { completionPercent: 150 });
        check('S2-7. Invalid progress > 100 rejected (400)', r.status === 400, r.data);

        r = await api(dirA, 'POST', `/api/operations/tasks/${selfId}/progress`, { completionPercent: -5 });
        check('S2-8. Invalid progress < 0 rejected (400)', r.status === 400, r.data);

        r = await api(dirA, 'POST', `/api/operations/tasks/${selfId}/progress`, { completionPercent: 60 });
        check('S2-9. Valid progress update accepted',
            r.status === 200 && r.data.task.completionPercent === 60, r.data.task && r.data.task.completionPercent);
        check('S2-9b. PROGRESS_CHANGED history event added',
            r.data.task.history.some(h => h.type === 'PROGRESS_CHANGED'), r.data.task.history);

        // progress=100 → auto complete
        r = await api(dirA, 'POST', `/api/operations/tasks/${selfId}/progress`, { completionPercent: 100 });
        check('S2-10. Progress=100 auto-completes task (COMPLETED / 100%)',
            r.status === 200 && r.data.task.status === 'COMPLETED' && r.data.task.completionPercent === 100 && r.data.task.completedAt > 0,
            r.data.task && r.data.task.status);

        // ── Complete endpoint ──
        const t2R = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Task for complete test', assigneeId: dirAId
        });
        const t2Id = t2R.data.task.id;
        // Non-assignee (Company B director) cannot complete
        r = await api(dirB, 'POST', `/api/operations/tasks/${t2Id}/complete`);
        check('S2-11. Cross-company complete rejected (404)', r.status === 404, r.data);

        r = await api(dirA, 'POST', `/api/operations/tasks/${t2Id}/complete`);
        check('S2-12. Completion sets 100% and completedAt',
            r.status === 200 && r.data.task.completionPercent === 100 && r.data.task.completedAt > 0,
            r.data.task && r.data.task.completionPercent);
        check('S2-12b. TASK_COMPLETED history event present',
            r.data.task.history.some(h => h.type === 'TASK_COMPLETED'), r.data.task.history);

        // ── Reassignment ──
        // Create a task assigned to cdb
        const tr = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Reassign test', assigneeId: cdbId, priority: 'MEDIUM'
        });
        const trId = tr.data.task.id;

        // Director reassigns to cdb2 — creates audit event + email attempt
        r = await api(dirA, 'POST', `/api/operations/tasks/${trId}/reassign`, { assigneeId: cdb2Id });
        check('S2-13. Director can reassign within company',
            r.status === 200 && r.data.task.assigneeId === cdb2Id, r.data.task && r.data.task.assigneeId);
        check('S2-13b. Reassignment creates ASSIGNEE_CHANGED audit event',
            r.data.task.history.some(h => h.type === 'ASSIGNEE_CHANGED'), r.data.task.history);
        check('S2-13c. notificationResult present after reassignment',
            typeof r.data.notificationResult === 'string', r.data.notificationResult);

        // Cross-company reassign: dirB cannot reassign dirA task
        r = await api(dirB, 'POST', `/api/operations/tasks/${trId}/reassign`, { assigneeId: dirBId });
        check('S2-14. Cross-company reassignment rejected (404)',
            r.status === 404, r.data);

        // Chef de Brigade cannot reassign to Adjoint (hierarchy violation)
        // We test via the module directly
        const opsAuth = require('../operations/ops-auth');
        const CdB  = { id: 'cdb', role: 'CHEF_DE_BRIGADE', companyId: 'x', active: true };
        const Adj  = { id: 'adj', role: 'ADJOINT',         companyId: 'x', active: true };
        const SC   = { id: 'sc',  role: 'SOUS_CHEF',       companyId: 'x', active: true };
        check('S2-15. Chef de Brigade cannot reassign task to Adjoint (module)',
            !opsAuth.canAssignTaskTo(CdB, Adj), null);
        check('S2-15b. Chef de Brigade cannot assign to Sous Chef (module)',
            !opsAuth.canAssignTaskTo(CdB, SC), null);

        // Sous Chef cannot modify Chef de Brigade task (canEditTask = false)
        const scActor = { id: 'sc', role: 'SOUS_CHEF', companyId: 'x', active: true };
        const cdbActor = { id: 'cdb', role: 'CHEF_DE_BRIGADE', companyId: 'x', active: true };
        const testTask = { companyId: 'x', assigneeId: 'cdb', createdBy: 'dir' };
        const byId = { sc: scActor, cdb: cdbActor };
        check('S2-16. Sous Chef cannot edit Chef de Brigade task (module)',
            !opsAuth.canEditTask(scActor, testTask, byId), null);
        check('S2-16b. Chef de Brigade cannot edit others\' task (module)',
            !opsAuth.canEditTask(cdbActor, testTask, byId), null);

        // Director can edit any company task (module)
        const dirActor = { id: 'dir', role: 'DIRECTOR', companyId: 'x', active: true };
        check('S2-17. Director can edit any company task (module)',
            opsAuth.canEditTask(dirActor, testTask, byId), null);

        // ── Comments ──
        const tCommentR = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Comment test', assigneeId: dirAId
        });
        const tCommentId = tCommentR.data.task.id;

        r = await api(dirA, 'POST', `/api/operations/tasks/${tCommentId}/comments`, { text: 'Prima nota del direttore' });
        check('S2-18. Director can add comment to own task',
            r.status === 200 && r.data.comment && r.data.comment.authorId === dirAId, r.data.comment);
        check('S2-18b. Comment has no client-supplied companyId (server-side only)',
            r.data.comment.companyId === undefined, r.data.comment);
        check('S2-18c. COMMENT_ADDED history event present',
            r.data.task.history.some(h => h.type === 'COMMENT_ADDED'), r.data.task.history);

        // Cross-company cannot comment
        r = await api(dirB, 'POST', `/api/operations/tasks/${tCommentId}/comments`, { text: 'Hacked comment' });
        check('S2-19. Company B cannot comment on Company A task (404)',
            r.status === 404, r.data);

        // ── History cannot be forged ──
        r = await api(dirA, 'PATCH', `/api/operations/tasks/${trId}`, {
            title: 'New title',
            history: [{ type: 'FORGED_EVENT', actorId: 'hacker', at: 0 }]
        });
        check('S2-20. History field from PATCH payload is ignored (not merged into task history)',
            r.status === 200 &&
            !r.data.task.history.some(h => h.type === 'FORGED_EVENT'), r.data.task && r.data.task.history.length);

        // ── Cancel (Director only) ──
        const tCancelR = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Cancel test', assigneeId: cdbId
        });
        const tCancelId = tCancelR.data.task.id;

        r = await api(dirB, 'POST', `/api/operations/tasks/${tCancelId}/cancel`);
        check('S2-21. Non-Director (other company) cannot cancel task (403 or 404)',
            r.status === 403 || r.status === 404, r.status);

        r = await api(dirA, 'POST', `/api/operations/tasks/${tCancelId}/cancel`, { reason: 'Test cancellation' });
        check('S2-22. Director can cancel task (CANCELLED status)',
            r.status === 200 && r.data.task.status === 'CANCELLED', r.data.task && r.data.task.status);
        check('S2-22b. Cancelled task has STATUS_CHANGED history',
            r.data.task.history.some(h => h.type === 'STATUS_CHANGED' && h.to === 'CANCELLED'), r.data.task.history);

        // Cancelled task is not OVERDUE
        r = await api(dirA, 'GET', `/api/operations/tasks/${tCancelId}`);
        check('S2-22c. Cancelled task effectiveStatus is CANCELLED (not OVERDUE)',
            r.data.task.effectiveStatus === 'CANCELLED', r.data.task && r.data.task.effectiveStatus);

        // Cannot cancel again
        r = await api(dirA, 'POST', `/api/operations/tasks/${tCancelId}/cancel`);
        check('S2-22d. Cannot cancel already-cancelled task (400)', r.status === 400, r.data);

        // ── Filters / search / sort ──
        const listAll = await api(dirA, 'GET', '/api/operations/tasks');
        check('S2-23. GET tasks list returns success', listAll.status === 200 && listAll.data.success, listAll.data);

        const listMy = await api(dirA, 'GET', '/api/operations/tasks?my=1');
        check('S2-24. my=1 filter shows only director\'s own tasks',
            listMy.data.tasks.every(t => t.assigneeId === dirAId), listMy.data.tasks && listMy.data.tasks.length);

        const listUrgent = await api(dirA, 'GET', '/api/operations/tasks?priority=URGENT');
        check('S2-25. Priority filter returns only URGENT tasks',
            listUrgent.data.tasks.every(t => t.priority === 'URGENT'), listUrgent.data.tasks && listUrgent.data.tasks.length);

        const listSearch = await api(dirA, 'GET', '/api/operations/tasks?q=UPDATED');
        check('S2-26. Text search finds task by title keyword',
            listSearch.data.tasks.some(t => t.title.includes('UPDATED')), listSearch.data.tasks && listSearch.data.tasks.length);

        // ── Stats endpoint ──
        const statsR = await api(dirA, 'GET', '/api/operations/stats');
        check('S2-27. GET /api/operations/stats returns structured data',
            statsR.status === 200 && statsR.data.success && typeof statsR.data.stats.my === 'number', statsR.data.stats);

        // ── canUpdateProgress module tests ──
        const updTask = { companyId: 'x', assigneeId: 'cdb', createdBy: 'dir', status: 'IN_PROGRESS' };
        check('S2-28. Assignee can update progress (module)',
            opsAuth.canUpdateProgress(cdbActor, updTask, byId), null);
        check('S2-29. Director can update progress on any task (module)',
            opsAuth.canUpdateProgress(dirActor, updTask, byId), null);
        check('S2-30. Sous Chef cannot update progress on others\' task (module)',
            !opsAuth.canUpdateProgress(scActor, updTask, byId), null);

        // ── Adjoint scope tests ──
        const adjActor = { id: 'adj', role: 'ADJOINT', companyId: 'x', active: true };
        const cdbTask = { companyId: 'x', assigneeId: 'cdb', createdBy: 'adj' };
        check('S2-31. Adjoint can manage task assigned to Chef de Brigade (module)',
            opsAuth.canEditTask(adjActor, cdbTask, { adj: adjActor, cdb: cdbActor }), null);
        check('S2-31b. Adjoint cannot manage task assigned to Sous Chef (hierarchy)',
            !opsAuth.canEditTask(adjActor, { ...cdbTask, assigneeId: 'sc', createdBy: 'adj' },
                { adj: adjActor, sc: scActor }), null);

        // Chef Cuisine scope
        const ccActor = { id: 'cc', role: 'CHEF_CUISINE', companyId: 'x', active: true };
        check('S2-32. Chef Cuisine can assign to Sous Chef',
            opsAuth.canAssignTaskTo(ccActor, scActor), null);
        check('S2-32b. Chef Cuisine cannot assign to Adjoint',
            !opsAuth.canAssignTaskTo(ccActor, adjActor), null);

        // ── Reassignment email non-fatal ──
        // Reassign again to same person (no email expected)
        const reReassign = await api(dirA, 'POST', `/api/operations/tasks/${trId}/reassign`, { assigneeId: cdb2Id });
        check('S2-33. Reassign to same assignee returns SKIPPED notification',
            reReassign.status === 200 && reReassign.data.notificationResult === 'SKIPPED',
            reReassign.data.notificationResult);

        // Reassign to different person — task persisted even if email fails
        const reRToOther = await api(dirA, 'POST', `/api/operations/tasks/${trId}/reassign`, { assigneeId: cdbId });
        check('S2-34. Task persisted after reassignment even when email fails (FAILED)',
            reRToOther.status === 200 && reRToOther.data.task.assigneeId === cdbId,
            reRToOther.data.task && reRToOther.data.task.assigneeId);

        // Verify reassigned task still fetchable
        const reFetch = await api(dirA, 'GET', `/api/operations/tasks/${trId}`);
        check('S2-34b. Reassigned task fetchable via GET/:id after email failure',
            reFetch.status === 200 && reFetch.data.task.assigneeId === cdbId,
            reFetch.data.task && reFetch.data.task.assigneeId);

        // ── User without task visibility cannot read comments ──
        // Company B cannot read company A task (which includes its comments)
        const compReadR = await api(dirB, 'GET', `/api/operations/tasks/${tCommentId}`);
        check('S2-35. User without visibility cannot read task comments (404)',
            compReadR.status === 404, compReadR.data);

    } finally {
        server.kill('SIGTERM');
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
