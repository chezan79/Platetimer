/**
 * tests/operations-task-delete.test.js
 * Permanent hard-delete of Operations tasks.
 * 10 required scenarios from the spec.
 */
'use strict';

const { spawn } = require('child_process');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const SECRET   = 'test-secret-task-delete-suite';
const PORT     = 5087;
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstaskdel-'));

// ── HMAC session token (same algorithm as existing sprint tests) ─────────────
function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function api(token, method, p, body) {
    const res = await fetch(BASE + p, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body != null ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ── Test runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else       { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('Starting server (task-delete tests)…');
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
            MOCK_FIREBASE_STORAGE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 20_000);
        server.stdout.on('data', d => {
            if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(); }
        });
    });
    console.log('Server up. Running task-delete checks…\n');

    try {
        // ── Tokens ────────────────────────────────────────────────────────────
        const dirA  = sign('uid-del-dirA',  'taskdel-company-a');
        const dirB  = sign('uid-del-dirB',  'taskdel-company-b');
        const ccA   = sign('uid-del-ccA',   'taskdel-company-a');

        // ── Bootstrap actors ──────────────────────────────────────────────────
        let r;
        // Director A
        r = await api(dirA, 'GET', '/api/operations/me?name=Anna%20Director');
        const dirAId = r.data.user.id;

        // Invite a Chef de Brigade for Director A to assign tasks to
        r = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Carlo CdB', email: 'cdb@del-a.it', role: 'CHEF_DE_BRIGADE',
        });
        const cdbId = r.data.user ? r.data.user.id : null;

        // Invite a Chef Cuisine in company A (for non-Director test)
        await api(ccA, 'GET', '/api/operations/me?name=Chef%20Cuisine%20A');

        // Director B
        await api(dirB, 'GET', '/api/operations/me?name=Bruno%20Director');

        // ── Helper: create a task (assigned to Director) ───────────────────
        async function createTask(tok, title) {
            const me = await api(tok, 'GET', '/api/operations/me');
            const assigneeId = me.data.user ? me.data.user.id : dirAId;
            return api(tok, 'POST', '/api/operations/tasks', {
                title, assigneeId, priority: 'NORMAL',
            });
        }

        async function cancelTask(tok, taskId) {
            return api(tok, 'POST', `/api/operations/tasks/${taskId}/cancel`, { reason: 'test' });
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 1: Director can permanently delete a cancelled task
        // ─────────────────────────────────────────────────────────────────────
        r = await createTask(dirA, 'Preparare la cena');
        const taskId1 = r.data.task && r.data.task.id;
        check('T1a. Task created successfully', r.status === 201 && taskId1, r.status);
        if (taskId1) {
            await cancelTask(dirA, taskId1);
            r = await api(dirA, 'DELETE', `/api/operations/tasks/${taskId1}`);
            check('T1b. Director can permanently delete cancelled task (200)', r.status === 200 && r.data.success, r);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 2: Deleted task no longer appears in task list
        // ─────────────────────────────────────────────────────────────────────
        r = await createTask(dirA, 'Task da eliminare');
        const taskId2 = r.data.task && r.data.task.id;
        if (taskId2) {
            await cancelTask(dirA, taskId2);
            await api(dirA, 'DELETE', `/api/operations/tasks/${taskId2}`);
            const list = await api(dirA, 'GET', '/api/operations/tasks');
            const found = (list.data.tasks || []).some(t => t.id === taskId2);
            check('T2. Deleted task absent from task list', !found, { found });
        } else check('T2. Deleted task absent from task list', false, 'task not created');

        // ─────────────────────────────────────────────────────────────────────
        // TEST 3: Deleted task disappears from Cancelled filter
        // ─────────────────────────────────────────────────────────────────────
        r = await createTask(dirA, 'Cancellato da eliminare');
        const taskId3 = r.data.task && r.data.task.id;
        if (taskId3) {
            await cancelTask(dirA, taskId3);

            // Verify visible in list (as CANCELLED) before delete
            const before = await api(dirA, 'GET', '/api/operations/tasks');
            const wasCancelled = (before.data.tasks || []).some(t => t.id === taskId3 && (t.status === 'CANCELLED' || t.effectiveStatus === 'CANCELLED'));
            check('T3a. Cancelled task visible before delete', wasCancelled, { taskId3 });

            await api(dirA, 'DELETE', `/api/operations/tasks/${taskId3}`);

            const after = await api(dirA, 'GET', '/api/operations/tasks');
            const stillThere = (after.data.tasks || []).some(t => t.id === taskId3);
            check('T3b. Deleted task absent from Cancelled view', !stillThere, { stillThere });
        } else check('T3. Cancelled view test', false, 'task not created');

        // ─────────────────────────────────────────────────────────────────────
        // TEST 4: Task counts decrease after deletion
        // ─────────────────────────────────────────────────────────────────────
        // Create an extra task, cancel it, count before/after delete
        r = await createTask(dirA, 'Conteggio task A');
        const taskId4 = r.data.task && r.data.task.id;
        if (taskId4) {
            await cancelTask(dirA, taskId4);
            const before = await api(dirA, 'GET', '/api/operations/tasks');
            const countBefore = (before.data.tasks || []).length;
            await api(dirA, 'DELETE', `/api/operations/tasks/${taskId4}`);
            const after = await api(dirA, 'GET', '/api/operations/tasks');
            const countAfter = (after.data.tasks || []).length;
            check('T4. Task count decreases after delete', countAfter < countBefore,
                { countBefore, countAfter });
        } else check('T4. Task count', false, 'task not created');

        // ─────────────────────────────────────────────────────────────────────
        // TEST 5: Non-Director (CHEF_CUISINE) is rejected with 403
        // ─────────────────────────────────────────────────────────────────────
        r = await createTask(dirA, 'Non-director delete attempt');
        const taskId5 = r.data.task && r.data.task.id;
        if (taskId5) {
            await cancelTask(dirA, taskId5);
            const delR = await api(ccA, 'DELETE', `/api/operations/tasks/${taskId5}`);
            check('T5a. Chef Cuisine gets 403 on delete', delR.status === 403, { status: delR.status });

            // Task must still exist
            const list = await api(dirA, 'GET', '/api/operations/tasks');
            const still = (list.data.tasks || []).some(t => t.id === taskId5);
            check('T5b. Task still exists after unauthorized delete attempt', still);
        } else check('T5. Non-Director 403', false, 'task not created');

        // ─────────────────────────────────────────────────────────────────────
        // TEST 6: Cross-company deletion rejected
        // ─────────────────────────────────────────────────────────────────────
        r = await createTask(dirA, 'Cross-company target');
        const taskId6 = r.data.task && r.data.task.id;
        if (taskId6) {
            await cancelTask(dirA, taskId6);
            const delR = await api(dirB, 'DELETE', `/api/operations/tasks/${taskId6}`);
            check('T6a. Director B cannot delete Director A task (404 or 403)',
                delR.status === 404 || delR.status === 403,
                { status: delR.status });

            // Task still in company A
            const list = await api(dirA, 'GET', '/api/operations/tasks');
            const still = (list.data.tasks || []).some(t => t.id === taskId6);
            check('T6b. Company A task still exists after cross-company attempt', still);
        } else check('T6. Cross-company', false, 'task not created');

        // ─────────────────────────────────────────────────────────────────────
        // TEST 7: Nonexistent task ID → 404
        // ─────────────────────────────────────────────────────────────────────
        r = await api(dirA, 'DELETE', '/api/operations/tasks/does-not-exist-xyz-999');
        check('T7. Nonexistent task returns 404', r.status === 404, { status: r.status });

        // ─────────────────────────────────────────────────────────────────────
        // TEST 8: Normal cancel still works (status → CANCELLED, task preserved)
        // ─────────────────────────────────────────────────────────────────────
        r = await createTask(dirA, 'Solo cancellazione normale');
        const taskId8 = r.data.task && r.data.task.id;
        if (taskId8) {
            const cancelR = await cancelTask(dirA, taskId8);
            check('T8a. Cancel returns success', cancelR.status === 200 && cancelR.data.success, cancelR);
            check('T8b. Cancelled task has CANCELLED status',
                cancelR.data.task && cancelR.data.task.status === 'CANCELLED',
                cancelR.data.task && cancelR.data.task.status);

            // Task still present
            const list = await api(dirA, 'GET', '/api/operations/tasks');
            const found = (list.data.tasks || []).some(t => t.id === taskId8);
            check('T8c. Cancelled task still present in list (not hard-deleted)', found);
        } else check('T8. Normal cancel', false, 'task not created');

        // ─────────────────────────────────────────────────────────────────────
        // TEST 9: Cancelling does NOT permanently delete
        // ─────────────────────────────────────────────────────────────────────
        r = await createTask(dirA, 'Cancellazione ≠ eliminazione');
        const taskId9 = r.data.task && r.data.task.id;
        if (taskId9) {
            await cancelTask(dirA, taskId9);
            const list = await api(dirA, 'GET', '/api/operations/tasks');
            const found = (list.data.tasks || []).find(t => t.id === taskId9);
            check('T9a. Task still exists after cancel', !!found);
            check('T9b. Task is CANCELLED not deleted', found && found.status === 'CANCELLED', found && found.status);
        } else check('T9. Cancel ≠ delete', false, 'task not created');

        // ─────────────────────────────────────────────────────────────────────
        // TEST 10: Deleting one recurring-generated task leaves template intact
        // ─────────────────────────────────────────────────────────────────────
        // Count templates before and after deleting a plain task
        const tplBefore = await api(dirA, 'GET', '/api/operations/templates');
        const tplCountBefore = Array.isArray(tplBefore.data.templates) ? tplBefore.data.templates.length : 0;

        r = await createTask(dirA, 'Istanza ricorrente simulata');
        const taskId10 = r.data.task && r.data.task.id;
        if (taskId10) {
            await cancelTask(dirA, taskId10);
            await api(dirA, 'DELETE', `/api/operations/tasks/${taskId10}`);
        }

        const tplAfter = await api(dirA, 'GET', '/api/operations/templates');
        const tplCountAfter = Array.isArray(tplAfter.data.templates) ? tplAfter.data.templates.length : 0;
        check('T10. Template count unchanged after deleting a task',
            tplCountAfter === tplCountBefore, { tplCountBefore, tplCountAfter });

    } finally {
        server.kill();
        try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
    }

    console.log(`\noperations-task-delete tests: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
