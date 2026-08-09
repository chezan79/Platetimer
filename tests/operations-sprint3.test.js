#!/usr/bin/env node
'use strict';
// tests/operations-sprint3.test.js — Sprint 3: Recurring Tasks, Reminders, Escalation
// Tests scheduler logic directly (via exported phase functions) + HTTP API.
// Designed to avoid requiring a live Firebase or SMTP connection.

const http    = require('http');
const crypto  = require('crypto');
const path    = require('path');

// ── HMAC helper (mirrors existing test suite token signing) ──────────────────
const SECRET = 'test-sprint3-secret';

function makeToken(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({ uid, companyName, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64');
    const sig     = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

// ── Test counter ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else        { console.error(`  ❌ ${label}${hint !== undefined ? ' — got: ' + JSON.stringify(hint) : ''}`); failed++; }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
const PORT = 4454;
function api(token, method, path_, body) {
    return new Promise((resolve, reject) => {
        const buf  = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: '127.0.0.1', port: PORT, path: path_, method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...(buf ? { 'Content-Length': Buffer.byteLength(buf) } : {})
            }
        };
        const req = http.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, data }); }
            });
        });
        req.on('error', reject);
        if (buf) req.write(buf);
        req.end();
    });
}

// ── Test runner ───────────────────────────────────────────────────────────────
async function run() {
    console.log('\nStarting server (Sprint 3 tests)…');

    // Spawn server in a child process so we can control environment
    const { spawn } = require('child_process');
    const os  = require('os');
    const fs2 = require('fs');
    const DATA_DIR_S3 = fs2.mkdtempSync(path.join(os.tmpdir(), 'opstest-s3-'));
    const serverEnv = {
        ...process.env,
        PORT: String(PORT),
        WS_SESSION_SECRET: SECRET,
        DATA_DIR: DATA_DIR_S3,
        FIREBASE_ADMIN_SERVICE_ACCOUNT: ''
    };
    const proc = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stderr.on('data', () => {});
    // Wait for server to signal it's ready
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 20000);
        proc.stdout.on('data', d => { if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(); } });
        proc.on('exit', code => { clearTimeout(t); reject(new Error(`Server exited with code ${code}`)); });
    });
    console.log('Server up. Running Sprint 3 checks…\n');

    // ── Tokens ──
    const dirUid  = 'sprint3-dir-' + crypto.randomBytes(3).toString('hex');
    const dir2Uid = 'sprint3-dir2-' + crypto.randomBytes(3).toString('hex');
    const co      = 'S3Co_'  + crypto.randomBytes(3).toString('hex');
    const co2     = 'S3Co2_' + crypto.randomBytes(3).toString('hex');
    const dirA    = makeToken(dirUid,  co);
    const dir2A   = makeToken(dir2Uid, co2);

    // Bootstrap company A director
    let r = await api(dirA, 'GET', '/api/operations/me');
    check('S3-0. Director A bootstrapped', r.data.success && r.data.user.role === 'DIRECTOR');
    const dirId = r.data.user.id;

    // ── Pure module tests: occurrence date generation ──────────────────────────
    const rec = require('../operations/ops-recurring');

    // DAILY
    const dailyDates = rec.getOccurrenceDates({
        frequency: 'DAILY', startDate: '2026-08-01', workSchedule: [0,1,2,3,4,5,6]
    }, new Date('2026-08-05'));
    check('S3-1. DAILY: generates 5 dates from Aug 1 to Aug 5', dailyDates.length === 5, dailyDates.length);
    check('S3-1b. DAILY: first date is 2026-08-01', dailyDates[0] === '2026-08-01', dailyDates[0]);
    check('S3-1c. DAILY: last date is 2026-08-05', dailyDates[dailyDates.length-1] === '2026-08-05');

    // EVERY_X_DAYS
    const everyXDays = rec.getOccurrenceDates({
        frequency: 'EVERY_X_DAYS', interval: 3, startDate: '2026-08-01', workSchedule: [0,1,2,3,4,5,6]
    }, new Date('2026-08-10'));
    check('S3-2. EVERY_X_DAYS(3): correct step', everyXDays[0] === '2026-08-01' && everyXDays[1] === '2026-08-04', everyXDays);

    // WEEKLY with specific days
    const weekly = rec.getOccurrenceDates({
        frequency: 'WEEKLY', interval: 1, daysOfWeek: [1, 5], startDate: '2026-08-03', workSchedule: [0,1,2,3,4,5,6]
    }, new Date('2026-08-14'));
    check('S3-3. WEEKLY Mon+Fri: only Mondays and Fridays', weekly.every(d => { const day = new Date(d+'T12:00:00').getDay(); return day === 1 || day === 5; }), weekly);
    check('S3-3b. WEEKLY Mon+Fri: correct count', weekly.length >= 2);

    // MONTHLY
    const monthly = rec.getOccurrenceDates({
        frequency: 'MONTHLY', startDate: '2026-01-15', dayOfMonth: 15, workSchedule: [0,1,2,3,4,5,6]
    }, new Date('2026-04-30'));
    check('S3-4. MONTHLY day 15: generates Jan/Feb/Mar/Apr', monthly.length === 4, monthly);
    check('S3-4b. MONTHLY day 15: all are 15th', monthly.every(d => d.endsWith('-15')));

    // maxOccurrences cap
    const capped = rec.getOccurrenceDates({
        frequency: 'DAILY', startDate: '2026-08-01', maxOccurrences: 3, workSchedule: [0,1,2,3,4,5,6]
    }, new Date('2026-08-10'));
    check('S3-5. maxOccurrences cap honored', capped.length === 3, capped.length);

    // endDate cap
    const ended = rec.getOccurrenceDates({
        frequency: 'DAILY', startDate: '2026-08-01', endDate: '2026-08-03', workSchedule: [0,1,2,3,4,5,6]
    }, new Date('2026-08-10'));
    check('S3-6. endDate stops generation', ended.length === 3, ended.length);

    // workSchedule exclusion
    const noMonday = rec.getOccurrenceDates({
        frequency: 'DAILY', startDate: '2026-08-03', workSchedule: [0, 2, 3, 4, 5, 6]  // no Monday (1)
    }, new Date('2026-08-09'));
    check('S3-7. workSchedule excludes closed days (Mon)', !noMonday.some(d => new Date(d+'T12:00:00').getDay() === 1), noMonday);

    // occurrenceKey uniqueness
    const key1 = rec.occurrenceKey('tpl_001', '2026-08-01');
    const key2 = rec.occurrenceKey('tpl_001', '2026-08-02');
    const key3 = rec.occurrenceKey('tpl_002', '2026-08-01');
    check('S3-8. occurrenceKey is deterministic', key1 === 'tpl_001_2026-08-01');
    check('S3-8b. Different dates produce different keys', key1 !== key2);
    check('S3-8c. Different templates produce different keys', key1 !== key3);

    // generateTasksForTemplate idempotency
    const tpl = {
        id: 'tpl_test_001', companyId: co, title: 'Daily Check', description: '', priority: 'HIGH',
        department: 'Cucina', notes: '', defaultAssigneeId: dirId, frequency: 'DAILY',
        interval: 1, daysOfWeek: [], dayOfMonth: null, startDate: '2026-08-01',
        endDate: '2026-08-03', maxOccurrences: null, workSchedule: [0,1,2,3,4,5,6],
        defaultReminderDays: null, defaultEscalation: false,
        createdBy: dirId, createdByName: 'Dir', active: true
    };
    const usersById = { [dirId]: { id: dirId, name: 'Dir', email: 'dir@test.com', role: 'DIRECTOR', status: 'ACTIVE', companyId: co } };
    const firstGen = rec.generateTasksForTemplate(tpl, co, new Set(), usersById, null);
    check('S3-9. generateTasksForTemplate: 3 tasks for 3-day template', firstGen.length === 3, firstGen.length);

    const existingKeys = new Set(firstGen.map(t => t.occurrenceKey));
    const secondGen = rec.generateTasksForTemplate(tpl, co, existingKeys, usersById, null);
    check('S3-9b. generateTasksForTemplate: idempotent — no duplicates on re-run', secondGen.length === 0, secondGen.length);

    // Generated task structure
    const genTask = firstGen[0];
    check('S3-9c. Generated task has correct companyId', genTask.companyId === co);
    check('S3-9d. Generated task has templateId', genTask.templateId === tpl.id);
    check('S3-9e. Generated task has occurrenceKey', typeof genTask.occurrenceKey === 'string' && genTask.occurrenceKey.startsWith(tpl.id));
    check('S3-9f. Generated task has escalation object', genTask.escalation && typeof genTask.escalation.enabled === 'boolean');
    check('S3-9g. Generated task status is OPEN', genTask.status === 'OPEN');

    // ── Escalation chain tests (module level) ─────────────────────────────────
    const opsAuth = require('../operations/ops-auth');
    check('S3-10. CdB escalation chain: Adjoint → Director', JSON.stringify(opsAuth.getEscalationChain('CHEF_DE_BRIGADE')) === JSON.stringify(['ADJOINT','DIRECTOR']));
    check('S3-11. SousChef escalation chain: ChefCuisine → Director', JSON.stringify(opsAuth.getEscalationChain('SOUS_CHEF')) === JSON.stringify(['CHEF_CUISINE','DIRECTOR']));
    check('S3-12. ChefCuisine escalation chain: Director only', JSON.stringify(opsAuth.getEscalationChain('CHEF_CUISINE')) === JSON.stringify(['DIRECTOR']));
    check('S3-13. Adjoint escalation chain: Director only', JSON.stringify(opsAuth.getEscalationChain('ADJOINT')) === JSON.stringify(['DIRECTOR']));
    check('S3-14. Director has no escalation chain', opsAuth.getEscalationChain('DIRECTOR').length === 0);

    // ── Scheduler phase tests (pure logic) ───────────────────────────────────
    const sched = require('../operations/ops-scheduler');

    // DEFAULT_PREFS
    const defaults = sched.DEFAULT_PREFS();
    check('S3-15. DEFAULT_PREFS has required keys', 'emailReminders' in defaults && 'dailyDigest' in defaults);

    // getUserPrefs — company default override
    const testPrefsStore = {
        [co]: { defaults: { emailReminders: false, dailyDigest: false, taskAssignment: true, escalationEmails: true }, users: {} }
    };
    const userPrefs = sched.getUserPrefs(testPrefsStore, co, 'nobody');
    check('S3-16. getUserPrefs picks up company defaults', userPrefs.emailReminders === false);

    // getUserPrefs — user override wins
    testPrefsStore[co].users['u1'] = { emailReminders: true };
    const overridePrefs = sched.getUserPrefs(testPrefsStore, co, 'u1');
    check('S3-17. getUserPrefs user override wins over company defaults', overridePrefs.emailReminders === true);

    // resolveEscalationTargets
    const companyUsersArr = [
        { id: 'cdb1', role: 'CHEF_DE_BRIGADE', status: 'ACTIVE', email: 'cdb@t.it', name: 'CdB', companyId: co },
        { id: 'adj1', role: 'ADJOINT',          status: 'ACTIVE', email: 'adj@t.it', name: 'Adj', companyId: co },
        { id: 'dir1', role: 'DIRECTOR',         status: 'ACTIVE', email: 'dir@t.it', name: 'Dir', companyId: co },
    ];
    const taskForEsc = { assigneeId: 'cdb1', companyId: co };
    const targets = sched.resolveEscalationTargets(taskForEsc, companyUsersArr);
    check('S3-18. CdB escalation targets: [Adjoint, Director]', targets.length === 2 && targets[0].role === 'ADJOINT' && targets[1].role === 'DIRECTOR');

    // Escalation does NOT fire for COMPLETED task
    let reminderEmailCalled = false, escalationEmailCalled = false;
    const fakeEmail = {
        sendReminderEmail:   async () => { reminderEmailCalled = true; return { result: 'SENT' }; },
        sendEscalationEmail: async () => { escalationEmailCalled = true; return { result: 'SENT' }; },
        sendDailyDigestEmail:async () => ({ result: 'SENT' }),
        RESULT: { SENT: 'SENT', FAILED: 'FAILED', SKIPPED: 'SKIPPED' }
    };

    const overdueTask = {
        id: 'task_esc_test', companyId: co, assigneeId: 'cdb1', assigneeName: 'CdB',
        status: 'COMPLETED', dueDate: '2020-01-01',  // far in the past
        escalation: { enabled: true, waitHoursAfterDue: 0, waitHoursBetweenLevels: 24 },
        escalationLevel: 0, escalationSentAt: null, escalationNotified: []
    };
    const storesEsc = {
        opsTasksStore: { [co]: [overdueTask] },
        opsUsersStore: { [co]: companyUsersArr },
        opsPrefsStore: {}
    };
    const saversNoOp = { saveOpsTasks: () => {}, saveOpsTemplates: () => {}, saveOpsPrefs: () => {} };
    await sched.processEscalation(storesEsc, saversNoOp, fakeEmail, new Date());
    check('S3-19. Escalation NOT fired for COMPLETED task', !escalationEmailCalled);

    // Escalation fires for overdue task with escalation enabled
    overdueTask.status = 'OPEN';
    escalationEmailCalled = false;
    await sched.processEscalation(storesEsc, saversNoOp, fakeEmail, new Date());
    check('S3-20. Escalation fires for overdue OPEN task', escalationEmailCalled);
    check('S3-20b. Task escalationLevel incremented to 1', overdueTask.escalationLevel === 1);

    // Escalation does NOT fire again immediately (waitHoursBetweenLevels)
    escalationEmailCalled = false;
    await sched.processEscalation(storesEsc, saversNoOp, fakeEmail, new Date());
    check('S3-21. Escalation not re-fired before wait period', !escalationEmailCalled);

    // Escalation fires again after wait period
    escalationEmailCalled = false;
    const farFuture = new Date(Date.now() + 48 * 3600000); // 48h later
    await sched.processEscalation(storesEsc, saversNoOp, fakeEmail, farFuture);
    check('S3-22. Escalation fires again for level 2 after wait period', escalationEmailCalled);
    check('S3-22b. Task escalationLevel incremented to 2', overdueTask.escalationLevel === 2);

    // Escalation stops when chain exhausted (no more targets above Director)
    escalationEmailCalled = false;
    const veryFarFuture = new Date(Date.now() + 96 * 3600000);
    await sched.processEscalation(storesEsc, saversNoOp, fakeEmail, veryFarFuture);
    check('S3-23. Escalation stops when chain is exhausted', !escalationEmailCalled);

    // Reminder: NOT fired for completed task
    reminderEmailCalled = false;
    const completedTaskReminder = {
        id: 'task_rem_test', companyId: co, assigneeId: 'adj1',
        status: 'COMPLETED', dueDate: '2026-08-10',
        reminderDays: 1, reminderSentAt: null,
        escalation: null, escalationLevel: 0
    };
    const storesRem = {
        opsTasksStore: { [co]: [completedTaskReminder] },
        opsUsersStore: { [co]: companyUsersArr },
        opsPrefsStore: {}
    };
    await sched.processReminders(storesRem, saversNoOp, fakeEmail, new Date());
    check('S3-24. Reminder NOT sent for COMPLETED task', !reminderEmailCalled);

    // Reminder: NOT fired before window
    reminderEmailCalled = false;
    completedTaskReminder.status = 'OPEN';
    await sched.processReminders(storesRem, saversNoOp, fakeEmail, new Date('2026-08-01'));
    check('S3-25. Reminder NOT sent before reminder window', !reminderEmailCalled);

    // Reminder: fired within window (now = Aug 10 noon, reminderTime = Aug 9 23:59:59)
    reminderEmailCalled = false;
    await sched.processReminders(storesRem, saversNoOp, fakeEmail, new Date('2026-08-10T12:00:00'));
    check('S3-26. Reminder sent within window', reminderEmailCalled);
    check('S3-26b. reminderSentAt set after send', !!completedTaskReminder.reminderSentAt);

    // Reminder: not re-sent
    reminderEmailCalled = false;
    await sched.processReminders(storesRem, saversNoOp, fakeEmail, new Date('2026-08-11'));
    check('S3-27. Reminder not re-sent (idempotent)', !reminderEmailCalled);

    // Reminder: suppressed by user preference
    completedTaskReminder.reminderSentAt = null; // reset
    const storesRemPref = {
        opsTasksStore: { [co]: [{ ...completedTaskReminder, reminderSentAt: null }] },
        opsUsersStore: { [co]: companyUsersArr },
        opsPrefsStore: { [co]: { defaults: {}, users: { adj1: { emailReminders: false, taskAssignment: true, escalationEmails: true, dailyDigest: false } } } }
    };
    reminderEmailCalled = false;
    await sched.processReminders(storesRemPref, saversNoOp, fakeEmail, new Date('2026-08-10T12:00:00'));
    check('S3-28. Reminder suppressed by user emailReminders=false pref', !reminderEmailCalled);

    // Cancelled task: no escalation
    escalationEmailCalled = false;
    const cancelledTask = { ...overdueTask, id: 'task_cancelled', status: 'CANCELLED', escalationLevel: 0, escalationSentAt: null };
    const storesCancelled = { opsTasksStore: { [co]: [cancelledTask] }, opsUsersStore: { [co]: companyUsersArr }, opsPrefsStore: {} };
    await sched.processEscalation(storesCancelled, saversNoOp, fakeEmail, new Date());
    check('S3-29. Escalation NOT fired for CANCELLED task', !escalationEmailCalled);

    // ── HTTP API tests ─────────────────────────────────────────────────────────

    // Template creation (Director A)
    r = await api(dirA, 'POST', '/api/operations/templates', {
        title: 'Pulizia serale', frequency: 'DAILY', startDate: '2026-08-01',
        priority: 'HIGH', department: 'Cucina', workSchedule: [1,2,3,4,5]
    });
    check('S3-30. Director can create a template', r.data.success && r.data.template.id, r.data.error);
    const tplId = r.data.success ? r.data.template.id : null;
    check('S3-30b. Template has companyId from session (not forged)', r.data.template && r.data.template.companyId === co);
    check('S3-30c. Template has createdBy from session', r.data.template && r.data.template.createdBy === dirId);

    // Forged companyId ignored
    r = await api(dirA, 'POST', '/api/operations/templates', {
        title: 'Forged tpl', frequency: 'DAILY', startDate: '2026-08-01',
        companyId: co2, createdBy: 'hacker', workSchedule: [0,1,2,3,4,5,6]
    });
    check('S3-30d. Forged companyId ignored in template creation', r.data.success && r.data.template.companyId === co);

    // GET templates
    r = await api(dirA, 'GET', '/api/operations/templates');
    check('S3-31. Director can list templates', r.data.success && Array.isArray(r.data.templates));

    // GET single template
    if (tplId) {
        r = await api(dirA, 'GET', '/api/operations/templates/' + tplId);
        check('S3-32. Director can get single template', r.data.success && r.data.template.id === tplId);

        // Cross-company: Company B cannot see Company A's template
        r = await api(dir2A, 'GET', '/api/operations/templates/' + tplId);
        check('S3-33. Company B cannot see Company A template (404)', r.status === 403 || r.status === 404);
    }

    // Invalid frequency
    r = await api(dirA, 'POST', '/api/operations/templates', {
        title: 'Bad freq', frequency: 'HOURLY', startDate: '2026-08-01', workSchedule: [0,1,2,3,4,5,6]
    });
    check('S3-34. Invalid frequency rejected', r.status === 400);

    // Missing startDate
    r = await api(dirA, 'POST', '/api/operations/templates', {
        title: 'No start', frequency: 'DAILY', workSchedule: [0,1,2,3,4,5,6]
    });
    check('S3-35. Missing startDate rejected', r.status === 400);

    // Force generate
    if (tplId) {
        r = await api(dirA, 'POST', '/api/operations/templates/' + tplId + '/generate-now', {});
        check('S3-36. generate-now returns generated count', r.data.success && typeof r.data.generated === 'number');

        // Re-generate: idempotent (0 new tasks since already generated)
        r = await api(dirA, 'POST', '/api/operations/templates/' + tplId + '/generate-now', {});
        check('S3-37. generate-now is idempotent (0 duplicates)', r.data.success && r.data.generated === 0, r.data.generated);
    }

    // PATCH template
    if (tplId) {
        r = await api(dirA, 'PATCH', '/api/operations/templates/' + tplId, { title: 'Pulizia serale UPDATED' });
        check('S3-38. Director can patch template', r.data.success && r.data.template.title === 'Pulizia serale UPDATED');
        // Previously generated tasks should still exist (not modified)
        const tasks = await api(dirA, 'GET', '/api/operations/tasks');
        const genTasks = (tasks.data.tasks || []).filter(t => t.templateId === tplId);
        check('S3-39. Existing generated tasks NOT modified by template patch', genTasks.every(t => t.title !== 'Pulizia serale UPDATED'));
    }

    // DELETE (deactivate) template
    if (tplId) {
        r = await api(dirA, 'DELETE', '/api/operations/templates/' + tplId);
        check('S3-40. Director can deactivate template', r.data.success);

        // Deleted template no longer generates
        const before = (await api(dirA, 'GET', '/api/operations/tasks')).data;
        const countBefore = (before.tasks || []).filter(t => t.templateId === tplId).length;
        await api(dirA, 'POST', '/api/operations/templates/' + tplId + '/generate-now', {});
        const after = (await api(dirA, 'GET', '/api/operations/tasks')).data;
        const countAfter = (after.tasks || []).filter(t => t.templateId === tplId).length;
        check('S3-41. Deactivated template generates no new tasks', countAfter === countBefore);

        // But generated tasks are still accessible
        check('S3-42. Generated tasks remain after template deactivation', countBefore > 0);
    }

    // Reminder settings via HTTP
    const taskData = await api(dirA, 'POST', '/api/operations/tasks', {
        title: 'Task for reminder test', assigneeId: dirId, priority: 'HIGH', dueDate: '2026-12-31'
    });
    const tskId = taskData.data.success ? taskData.data.task.id : null;

    if (tskId) {
        r = await api(dirA, 'PATCH', '/api/operations/tasks/' + tskId + '/reminder', { reminderDays: 3 });
        check('S3-43. Reminder can be set via PATCH', r.data.success && r.data.task.reminderDays === 3, r.data.error);

        r = await api(dirA, 'PATCH', '/api/operations/tasks/' + tskId + '/reminder', { reminderDays: null });
        check('S3-44. Reminder can be cleared', r.data.success && r.data.task.reminderDays === null);

        // Invalid reminderDays
        r = await api(dirA, 'PATCH', '/api/operations/tasks/' + tskId + '/reminder', { reminderDays: 999 });
        check('S3-45. reminderDays > 365 rejected', r.status === 400);
    }

    // Escalation settings via HTTP
    if (tskId) {
        r = await api(dirA, 'PATCH', '/api/operations/tasks/' + tskId + '/escalation', {
            enabled: true, waitHoursAfterDue: 2, waitHoursBetweenLevels: 4
        });
        check('S3-46. Escalation config can be set via PATCH', r.data.success && r.data.task.escalation && r.data.task.escalation.enabled === true, r.data.error);
        check('S3-46b. waitHoursAfterDue stored', r.data.task.escalation.waitHoursAfterDue === 2);
        check('S3-46c. escalationLevel reset to 0', r.data.task.escalationLevel === 0);

        r = await api(dirA, 'PATCH', '/api/operations/tasks/' + tskId + '/escalation', { enabled: false });
        check('S3-47. Escalation can be disabled', r.data.success && r.data.task.escalation.enabled === false);
    }

    // Preferences API
    r = await api(dirA, 'GET', '/api/operations/preferences');
    check('S3-48. User can fetch preferences', r.data.success && typeof r.data.preferences === 'object');

    r = await api(dirA, 'PATCH', '/api/operations/preferences', { dailyDigest: true, emailReminders: false });
    check('S3-49. User can update preferences', r.data.success && r.data.preferences.dailyDigest === true);
    check('S3-49b. emailReminders updated', r.data.preferences.emailReminders === false);

    // Company preferences (Director only)
    r = await api(dirA, 'GET', '/api/operations/company-preferences');
    check('S3-50. Director can fetch company preferences', r.data.success);

    r = await api(dirA, 'PATCH', '/api/operations/company-preferences', { dailyDigest: false, escalationEmails: false });
    check('S3-51. Director can update company defaults', r.data.success && r.data.preferences.escalationEmails === false);

    // Escalation status endpoint
    r = await api(dirA, 'GET', '/api/operations/escalation-status');
    check('S3-52. Director can access escalation-status', r.data.success && Array.isArray(r.data.escalated));
    check('S3-52b. escalatedToday is a number', typeof r.data.escalatedToday === 'number');
    check('S3-52c. overdueByDepartment is an object', r.data.overdueByDepartment && typeof r.data.overdueByDepartment === 'object');

    // Company B cannot access company A's escalation status
    r = await api(dir2A, 'GET', '/api/operations/escalation-status');
    // director of company B is allowed (their own company's status)
    check('S3-53. Director of Company B sees their own escalation status (not A\'s)', r.data.success && r.data.escalated.every(t => t.companyId !== co));

    // Non-Director cannot access templates
    const ccEmail = 'cc_' + crypto.randomBytes(3).toString('hex') + '@test.it';
    let createUser = await api(dirA, 'POST', '/api/operations/users', { name: 'Chef Cuisine', email: ccEmail, role: 'CHEF_CUISINE' });
    const ccCode   = createUser.data.user && createUser.data.user.inviteCode;
    // (Can't fully activate without Firebase, but we can test auth rejection via tokens)
    check('S3-54. Template creation rejected for non-Director — verified via module', !require('../operations/ops-auth').canManageUsers({ role: 'CHEF_CUISINE' }));

    // processRecurring: generates tasks and is idempotent
    const testTplId = 'tpl_sched_test_' + crypto.randomBytes(3).toString('hex');
    const schedTpl = {
        id: testTplId, companyId: 'schedco', title: 'Sched test', description: '', priority: 'MEDIUM',
        department: '', notes: '', defaultAssigneeId: null, frequency: 'DAILY',
        interval: 1, daysOfWeek: [], dayOfMonth: null,
        startDate: rec.dateStr(rec.addDays(new Date(), -2)),  // 2 days ago
        endDate: null, maxOccurrences: 3, workSchedule: [0,1,2,3,4,5,6],
        defaultReminderDays: null, defaultEscalation: false,
        createdBy: 'dir0', createdByName: 'Dir', active: true, generatedCount: 0, lastGeneratedAt: null
    };
    const schedStores = {
        opsTasksStore: { schedco: [] },
        opsUsersStore: { schedco: [] },
        opsTemplatesStore: { schedco: [schedTpl] },
        opsPrefsStore: {}
    };
    const schedSavers = { saveOpsTasks: () => {}, saveOpsTemplates: () => {}, saveOpsPrefs: () => {} };
    const { generated: gen1 } = await sched.processRecurring(schedStores, schedSavers, null);
    check('S3-55. processRecurring generates expected tasks', gen1 === 3, gen1);
    check('S3-55b. template generatedCount updated', schedTpl.generatedCount === 3);

    const { generated: gen2 } = await sched.processRecurring(schedStores, schedSavers, null);
    check('S3-56. processRecurring is idempotent (no duplicates on re-run)', gen2 === 0, gen2);

    // Template deactivated: processRecurring skips it
    schedTpl.active = false;
    schedStores.opsTasksStore.schedco = []; // clear tasks
    const { generated: gen3 } = await sched.processRecurring(schedStores, schedSavers, null);
    check('S3-57. Inactive template skipped by scheduler', gen3 === 0, gen3);

    // EVERY_X_WEEKS
    const everyXWeeks = rec.getOccurrenceDates({
        frequency: 'EVERY_X_WEEKS', interval: 2, startDate: '2026-08-03',
        daysOfWeek: [], workSchedule: [0,1,2,3,4,5,6]
    }, new Date('2026-08-30'));
    check('S3-58. EVERY_X_WEEKS(2): step is 14 days', everyXWeeks.length >= 2 && (new Date(everyXWeeks[1]) - new Date(everyXWeeks[0])) === 14 * 86400000, everyXWeeks);

    // EVERY_X_MONTHS
    const everyXMonths = rec.getOccurrenceDates({
        frequency: 'EVERY_X_MONTHS', interval: 2, startDate: '2026-01-10',
        dayOfMonth: 10, workSchedule: [0,1,2,3,4,5,6]
    }, new Date('2026-08-31'));
    check('S3-59. EVERY_X_MONTHS(2): generates Jan/Mar/May/Jul', everyXMonths.length === 4, everyXMonths);

    // Company isolation: company B templates invisible to company A
    r = await api(dir2A, 'POST', '/api/operations/templates', {
        title: 'B template', frequency: 'DAILY', startDate: '2026-08-01', workSchedule: [0,1,2,3,4,5,6]
    });
    const bTplId = r.data.success ? r.data.template.id : null;
    if (bTplId) {
        r = await api(dirA, 'GET', '/api/operations/templates/' + bTplId);
        check('S3-60. Company isolation: A cannot see B\'s template', r.status === 403 || r.status === 404);

        r = await api(dirA, 'PATCH', '/api/operations/templates/' + bTplId, { title: 'Hacked' });
        check('S3-61. Company isolation: A cannot patch B\'s template', r.status === 403 || r.status === 404);

        r = await api(dirA, 'DELETE', '/api/operations/templates/' + bTplId);
        check('S3-62. Company isolation: A cannot delete B\'s template', r.status === 403 || r.status === 404);
    }

    // New task creation includes Sprint 3 fields
    r = await api(dirA, 'POST', '/api/operations/tasks', {
        title: 'Sprint3 fields test', assigneeId: dirId, priority: 'MEDIUM',
        reminderDays: 2,
        escalation: { enabled: true, waitHoursAfterDue: 12, waitHoursBetweenLevels: 12 }
    });
    check('S3-63. Task creation accepts reminderDays', r.data.success && r.data.task.reminderDays === 2, r.data.error || (r.data.task && r.data.task.reminderDays));
    check('S3-64. Task creation accepts escalation config', r.data.success && r.data.task.escalation && r.data.task.escalation.enabled === true);
    check('S3-65. New task has occurrenceKey null (not recurring)', r.data.success && r.data.task.occurrenceKey === null);
    check('S3-66. New task has templateId null (not recurring)', r.data.success && r.data.task.templateId === null);

    // escalation status not accessible by non-existent company (Company B Director sees own empty data)
    r = await api(dir2A, 'GET', '/api/operations/escalation-status');
    check('S3-67. Company B Director gets own escalation status (not A data)', r.data.success);

    // Company-preferences not accessible to non-Director (module level)
    check('S3-68. canManageUsers false for non-Director', !opsAuth.canManageUsers({ role: 'CHEF_CUISINE' }));
    check('S3-69. canManageUsers true for Director', opsAuth.canManageUsers({ role: 'DIRECTOR' }));

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${passed} passed, ${failed} failed`);
    proc.kill();
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
