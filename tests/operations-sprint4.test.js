#!/usr/bin/env node
'use strict';
// tests/operations-sprint4.test.js — Sprint 4: Role-Based Command Center
//
// Integration tests for role-specific dashboard data, widgets, security,
// and the deterministic "next task" algorithm.
//
// NOTE: Non-director user activation requires Firebase (Google Identity Toolkit)
// and cannot be simulated in test environments without Firebase credentials.
// Role-restriction tests are therefore done at the module level (opsAuth) using
// the same approach as Sprint 1 / Sprint 2 test suites.
//
// Run: node tests/operations-sprint4.test.js

const http   = require('http');
const crypto = require('crypto');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn } = require('child_process');

const SECRET = 'test-sprint4-secret';
const PORT   = 4456;

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({ uid, companyName, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64');
    const sig     = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else       { console.error(`  ❌ ${label}${hint !== undefined ? ' — got: ' + JSON.stringify(hint) : ''}`); failed++; }
}

async function api(token, method, p, body) {
    return new Promise((resolve, reject) => {
        const buf  = body ? JSON.stringify(body) : null;
        const req  = http.request({
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

async function run() {
    console.log('Starting server (Sprint 4 tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstest-s4-'));
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
    console.log('Server up. Running Sprint 4 checks…\n');

    const co  = 'S4Co_'  + crypto.randomBytes(3).toString('hex');
    const co2 = 'S4Co2_' + crypto.randomBytes(3).toString('hex');
    const dirTok  = sign('s4-dir-a',  co);
    const dir2Tok = sign('s4-dir-b', co2);

    // ── Bootstrap directors ──
    let r = await api(dirTok, 'GET', '/api/operations/me');
    check('S4-0. Director A bootstrapped', r.data.success && r.data.user.role === 'DIRECTOR');
    const dirId = r.data.user.id;

    r = await api(dir2Tok, 'GET', '/api/operations/me');
    check('S4-1. Director B bootstrapped (company B)', r.data.success && r.data.user.role === 'DIRECTOR');

    // ── Create team members via Director ──
    async function invite(tok, name, email, role) {
        const res = await api(tok, 'POST', '/api/operations/users', { name, email, role });
        return res.data.user || null;
    }
    const ccUser  = await invite(dirTok, 'Chef Cucina', `cc_${crypto.randomBytes(2).toString('hex')}@test.it`,  'CHEF_CUISINE');
    const adjUser = await invite(dirTok, 'Adjoint',     `adj_${crypto.randomBytes(2).toString('hex')}@test.it`, 'ADJOINT');
    const scUser  = await invite(dirTok, 'Sous Chef',   `sc_${crypto.randomBytes(2).toString('hex')}@test.it`,  'SOUS_CHEF');
    const cdbUser = await invite(dirTok, 'Chef Brigade', `cdb_${crypto.randomBytes(2).toString('hex')}@test.it`,'CHEF_DE_BRIGADE');
    check('S4-2. Team created: CHEF_CUISINE', ccUser && ccUser.role === 'CHEF_CUISINE');
    check('S4-3. Team created: ADJOINT',      adjUser && adjUser.role === 'ADJOINT');
    check('S4-4. Team created: SOUS_CHEF',    scUser && scUser.role === 'SOUS_CHEF');
    check('S4-5. Team created: CHEF_DE_BRIGADE', cdbUser && cdbUser.role === 'CHEF_DE_BRIGADE');

    const ccId  = ccUser && ccUser.id;
    const adjId = adjUser && adjUser.id;
    const scId  = scUser && scUser.id;
    const cdbId = cdbUser && cdbUser.id;

    // ── opsAuth module: role-based access controls ─────────────────────────────
    const opsAuth = require('../operations/ops-auth');
    const mk = (id, role, cId = co) => ({ id, role, companyId: cId, active: true, uid: 'uid-'+id });
    const D  = mk(dirId, 'DIRECTOR');
    const CC = mk(ccId,  'CHEF_CUISINE');
    const AJ = mk(adjId, 'ADJOINT');
    const SC = mk(scId,  'SOUS_CHEF');
    const CB = mk(cdbId, 'CHEF_DE_BRIGADE');

    // Task visibility (drives what each dashboard widget shows)
    const task_cdb = { companyId: co, assigneeId: cdbId, createdBy: dirId };
    const task_sc  = { companyId: co, assigneeId: scId,  createdBy: dirId };
    const byId = { [dirId]: D, [ccId]: CC, [adjId]: AJ, [scId]: SC, [cdbId]: CB };

    check('S4-6. Director sees ALL tasks (dashboard: full overview)',
        opsAuth.canViewTask(D, task_cdb, byId) && opsAuth.canViewTask(D, task_sc, byId));
    check('S4-7. Chef Cuisine sees SousChef + CdB tasks (dashboard: kitchen tasks)',
        opsAuth.canViewTask(CC, task_cdb, byId) && opsAuth.canViewTask(CC, task_sc, byId));
    check('S4-8. Adjoint sees CdB tasks (dashboard: coordination view)',
        opsAuth.canViewTask(AJ, task_cdb, byId));
    check('S4-9. Adjoint CANNOT see SousChef tasks',
        !opsAuth.canViewTask(AJ, task_sc, byId));
    check('S4-10. SousChef sees OWN tasks only (dashboard: personal view)',
        opsAuth.canViewTask(SC, task_sc, byId) && !opsAuth.canViewTask(SC, task_cdb, byId));
    check('S4-11. CdB sees OWN tasks only (dashboard: personal next-task view)',
        opsAuth.canViewTask(CB, task_cdb, byId) && !opsAuth.canViewTask(CB, task_sc, byId));

    // Quick action eligibility: canManageUsers
    check('S4-12. Director: Create User quick action available', opsAuth.canManageUsers(D));
    check('S4-13. CC/Adj/SC/CdB: Create User quick action NOT available',
        !opsAuth.canManageUsers(CC) && !opsAuth.canManageUsers(AJ) &&
        !opsAuth.canManageUsers(SC) && !opsAuth.canManageUsers(CB));

    // canAssignTaskTo: drives "Create Task" quick action scope
    check('S4-14. Director can assign to anyone in company',
        opsAuth.canAssignTaskTo(D, CC) && opsAuth.canAssignTaskTo(D, SC) && opsAuth.canAssignTaskTo(D, CB));
    check('S4-15. CC can assign to SC and CdB (kitchen scope)',
        opsAuth.canAssignTaskTo(CC, SC) && opsAuth.canAssignTaskTo(CC, CB));
    check('S4-16. CC cannot assign to Director or Adjoint',
        !opsAuth.canAssignTaskTo(CC, D) && !opsAuth.canAssignTaskTo(CC, AJ));
    check('S4-17. Adjoint: self + CdB only',
        opsAuth.canAssignTaskTo(AJ, AJ) && opsAuth.canAssignTaskTo(AJ, CB) &&
        !opsAuth.canAssignTaskTo(AJ, SC));
    check('S4-18. SC: self-assign only (no create-for-others action)',
        opsAuth.canAssignTaskTo(SC, SC) && !opsAuth.canAssignTaskTo(SC, CB));
    check('S4-19. CdB: self-assign only',
        opsAuth.canAssignTaskTo(CB, CB) && !opsAuth.canAssignTaskTo(CB, SC));

    // Completion (drives "Complete" button on CdB/SousChef dashboards)
    const ownTaskSC  = { companyId: co, assigneeId: scId  };
    const ownTaskCDB = { companyId: co, assigneeId: cdbId };
    check('S4-20. SC can complete own task (next-task action)',
        opsAuth.canCompleteTask(SC, ownTaskSC));
    check('S4-21. CdB can complete own task (next-task action)',
        opsAuth.canCompleteTask(CB, ownTaskCDB));
    check('S4-22. SC cannot complete CdB\'s task',
        !opsAuth.canCompleteTask(SC, ownTaskCDB));
    check('S4-23. Director cannot complete SC\'s task',
        !opsAuth.canCompleteTask(D, ownTaskSC));

    // Escalation chain (Director escalation dashboard)
    check('S4-24. CdB escalation chain includes Adjoint and Director',
        JSON.stringify(opsAuth.getEscalationChain('CHEF_DE_BRIGADE')) === JSON.stringify(['ADJOINT','DIRECTOR']));
    check('S4-25. SC escalation chain: ChefCuisine + Director',
        JSON.stringify(opsAuth.getEscalationChain('SOUS_CHEF')) === JSON.stringify(['CHEF_CUISINE','DIRECTOR']));
    check('S4-26. Director has no escalation targets (stop condition)',
        opsAuth.getEscalationChain('DIRECTOR').length === 0);

    // ── HTTP: stats endpoint (Director tests) ──────────────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/stats');
    check('S4-27. Stats endpoint returns success', r.data.success);
    check('S4-28. Stats has my/open/inProgress/urgent/overdue/completed fields',
        r.data.success && ['my','open','inProgress','urgent','overdue','completed'].every(k => k in r.data.stats));
    check('S4-29. Stats has workload array for Director',
        r.data.success && Array.isArray(r.data.workload));
    check('S4-30. Stats workload includes team members',
        r.data.success && r.data.workload.length >= 1);
    check('S4-31. Stats avgCompletion is a number',
        r.data.success && typeof r.data.stats.avgCompletion === 'number');

    // ── Create tasks to populate dashboards ──────────────────────────────────────
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const todayEnd  = new Date(); todayEnd.setHours(23, 0, 0, 0);
    const tomorrow  = new Date(Date.now() + 86400000).toISOString();

    async function task(assigneeId, title, priority, dueDate, extra = {}) {
        const res = await api(dirTok, 'POST', '/api/operations/tasks', { title, assigneeId, priority, dueDate, ...extra });
        return res.data.task || null;
    }
    const t_overdue_cdb  = await task(cdbId, 'CdB overdue task',  'HIGH',   yesterday);
    const t_urgent_cdb   = await task(cdbId, 'CdB urgent',        'URGENT', todayEnd.toISOString());
    const t_today_cdb    = await task(cdbId, 'CdB today',         'MEDIUM', todayEnd.toISOString());
    const t_overdue_sc   = await task(scId,  'SC overdue',        'HIGH',   yesterday);
    const t_urgent_sc    = await task(scId,  'SC urgent',         'URGENT', tomorrow);
    const t_today_cc     = await task(ccId,  'CC today task',     'HIGH',   todayEnd.toISOString());
    const t_dir          = await task(dirId, 'Director own task', 'MEDIUM', todayEnd.toISOString());

    check('S4-32. Dashboard test tasks created', !!(t_overdue_cdb && t_urgent_cdb && t_today_cdb && t_overdue_sc && t_urgent_sc));

    // ── HTTP: tasks endpoint (Director sees all) ─────────────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/tasks');
    check('S4-33. Director gets all company tasks', r.data.success && Array.isArray(r.data.tasks));
    const allTasks = r.data.tasks || [];
    const overdueDir = allTasks.filter(t =>
        (t.effectiveStatus === 'OVERDUE') || (t.dueDate && new Date(t.dueDate) < new Date() && t.status !== 'COMPLETED' && t.status !== 'CANCELLED')
    );
    check('S4-34. Overdue tasks visible in Director dashboard data', overdueDir.length >= 2);

    const urgentTasks = allTasks.filter(t => t.priority === 'URGENT' && t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
    check('S4-35. Urgent tasks visible in Director dashboard data', urgentTasks.length >= 2);

    // ── Stats after task creation ──
    r = await api(dirTok, 'GET', '/api/operations/stats');
    // stats.overdue is personal (Director's own overdue tasks); company-wide overdue
    // is verified via the task list in S4-34. Verify the field exists and is numeric.
    check('S4-36. Stats.overdue is a numeric field (personal scope)',
        r.data.success && typeof r.data.stats.overdue === 'number');
    check('S4-37. Stats.urgent > 0 after creating urgent tasks',
        r.data.success && r.data.stats.urgent > 0, r.data.stats && r.data.stats.urgent);

    // Workload shows team members
    if (r.data.success && Array.isArray(r.data.workload)) {
        const roles = r.data.workload.map(w => w.role);
        check('S4-38. Workload includes CHEF_CUISINE', roles.includes('CHEF_CUISINE'));
        check('S4-39. Workload includes CHEF_DE_BRIGADE', roles.includes('CHEF_DE_BRIGADE'));
    } else {
        check('S4-38. Workload includes CHEF_CUISINE', false, 'no workload');
        check('S4-39. Workload includes CHEF_DE_BRIGADE', false, 'no workload');
    }

    // ── HTTP: escalation-status (Director only) ──────────────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/escalation-status');
    check('S4-40. Director can access escalation-status', r.data.success);
    check('S4-41. escalation-status has escalated array', Array.isArray(r.data.escalated));
    check('S4-42. escalation-status has requiresEscalation array', Array.isArray(r.data.requiresEscalation));
    check('S4-43. escalation-status has overdueByDepartment', typeof r.data.overdueByDepartment === 'object');
    check('S4-44. escalation-status has escalatedToday number', typeof r.data.escalatedToday === 'number');

    // ── HTTP: role-gate enforced via stranger tokens (not activated) ─────────────
    // A token whose uid has no ops record in an already-populated company → 403
    const strangerTok = sign('stranger-uid-' + crypto.randomBytes(4).toString('hex'), co);
    r = await api(strangerTok, 'GET', '/api/operations/escalation-status');
    check('S4-45. Non-member cannot access escalation-status (403)', r.status === 403);

    r = await api(strangerTok, 'POST', '/api/operations/users', { name: 'Hack', email: 'h@h.it', role: 'DIRECTOR' });
    check('S4-46. Non-member cannot create users (403)', r.status === 403);

    r = await api(strangerTok, 'POST', '/api/operations/templates', {
        title: 'Hack', frequency: 'DAILY', startDate: '2026-08-01', workSchedule: [0,1,2,3,4,5,6]
    });
    check('S4-47. Non-member cannot create templates (403)', r.status === 403);

    r = await api(strangerTok, 'PATCH', '/api/operations/company-preferences', { dailyDigest: true });
    check('S4-48. Non-member cannot modify company-preferences (403)', r.status === 403);

    // ── HTTP: company isolation ───────────────────────────────────────────────────
    r = await api(dir2Tok, 'GET', '/api/operations/tasks');
    const co2Tasks = r.data.tasks || [];
    check('S4-49. Company B sees no company A tasks', co2Tasks.every(t => t.companyId !== co));

    r = await api(dir2Tok, 'GET', '/api/operations/escalation-status');
    check('S4-50. Company B escalation-status contains no company A tasks',
        r.data.success && (r.data.escalated||[]).every(t => t.companyId !== co));

    r = await api(dir2Tok, 'GET', '/api/operations/stats');
    check('S4-51. Company B stats shows 0 tasks (empty company)', r.data.success && r.data.stats.open === 0, r.data.stats && r.data.stats.open);

    // ── HTTP: Director task actions (Director can act on own tasks) ────────────────
    if (t_dir) {
        r = await api(dirTok, 'POST', '/api/operations/tasks/' + t_dir.id + '/start', {});
        check('S4-52. Director can start own task', r.data.success, r.data.error);
        r = await api(dirTok, 'POST', '/api/operations/tasks/' + t_dir.id + '/complete', {});
        check('S4-53. Director can complete own task', r.data.success, r.data.error);

        r = await api(dirTok, 'GET', '/api/operations/stats');
        check('S4-54. Stats.completed increments after completion',
            r.data.success && r.data.stats.completed >= 1, r.data.stats && r.data.stats.completed);
    }

    // ── HTTP: reminder/escalation config on tasks ────────────────────────────────
    if (t_overdue_cdb) {
        r = await api(dirTok, 'PATCH', '/api/operations/tasks/' + t_overdue_cdb.id + '/escalation', {
            enabled: true, waitHoursAfterDue: 1, waitHoursBetweenLevels: 2
        });
        check('S4-55. Director can configure escalation for CdB\'s task', r.data.success, r.data.error);

        // Now it should appear in requiresEscalation (already overdue + escalation.enabled)
        r = await api(dirTok, 'GET', '/api/operations/escalation-status');
        check('S4-56. Escalation-enabled overdue task appears in requiresEscalation',
            r.data.success && r.data.requiresEscalation.some(t => t.id === t_overdue_cdb.id));
    }

    // ── HTTP: preferences API (Director) ────────────────────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/preferences');
    check('S4-57. Director can fetch own preferences', r.data.success && typeof r.data.preferences === 'object');

    r = await api(dirTok, 'PATCH', '/api/operations/preferences', { dailyDigest: true, emailReminders: false });
    check('S4-58. Director can update own preferences', r.data.success && r.data.preferences.dailyDigest === true);

    r = await api(dirTok, 'GET', '/api/operations/company-preferences');
    check('S4-59. Director can fetch company preferences', r.data.success);

    r = await api(dirTok, 'PATCH', '/api/operations/company-preferences', { escalationEmails: true, dailyDigest: false });
    check('S4-60. Director can update company preferences', r.data.success);

    // ── "Next task" algorithm — pure logic tests ─────────────────────────────────
    function nextTask(tasks, myId) {
        const now = new Date(), todayEnd = new Date(), todayStart = new Date();
        todayEnd.setHours(23,59,59,999); todayStart.setHours(0,0,0,0);
        const mine = tasks.filter(t =>
            t.assigneeId === myId && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
        );
        if (!mine.length) return null;
        function score(t) {
            if (t.priority === 'URGENT') return 0;
            const eff = t.effectiveStatus || t.status;
            if (eff === 'OVERDUE' || (t.dueDate && new Date(t.dueDate) < now)) return 1;
            if (t.dueDate) { const d = new Date(t.dueDate); if (d >= todayStart && d <= todayEnd) return 2; }
            return 3;
        }
        return mine.sort((a,b) => {
            const sa = score(a), sb = score(b);
            return sa !== sb ? sa - sb : new Date(a.createdAt) - new Date(b.createdAt);
        })[0];
    }
    function isToday(dateStr) {
        if (!dateStr) return false;
        const d = new Date(dateStr), n = new Date();
        return d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate();
    }
    function mkT(assigneeId, daysOffset, priority='MEDIUM', status='OPEN') {
        return {
            id: crypto.randomBytes(4).toString('hex'), assigneeId, priority, status, companyId: co,
            dueDate: new Date(Date.now() + daysOffset * 86400000).toISOString(),
            createdAt: new Date(Date.now() - Math.random()*100000).toISOString()
        };
    }

    // URGENT always first
    const set1 = [mkT('u1', 3, 'LOW'), mkT('u1', 0, 'MEDIUM'), mkT('u1', -1, 'HIGH'), mkT('u1', 1, 'URGENT')];
    check('S4-61. Next task: URGENT wins', nextTask(set1, 'u1').priority === 'URGENT');

    // Overdue before today
    const set2 = [mkT('u1', -1, 'HIGH'), mkT('u1', 0, 'MEDIUM'), mkT('u1', 3, 'LOW')];
    const nt2  = nextTask(set2, 'u1');
    check('S4-62. Next task: overdue beats today', new Date(nt2.dueDate) < new Date());

    // Today before future
    const set3 = [mkT('u1', 0, 'MEDIUM'), mkT('u1', 3, 'LOW')];
    check('S4-63. Next task: today beats future', isToday(nextTask(set3, 'u1').dueDate));

    // Future fallback: oldest createdAt wins tiebreak (same score bucket)
    const base = Date.now();
    const older_fut = { ...mkT('u1', 10, 'LOW'), createdAt: new Date(base - 10000).toISOString() };
    const newer_fut = { ...mkT('u1',  5, 'LOW'), createdAt: new Date(base -  2000).toISOString() };
    const nt4 = nextTask([newer_fut, older_fut], 'u1');
    check('S4-64. Next task: oldest createdAt wins tiebreak among future tasks', nt4.createdAt === older_fut.createdAt);

    // No tasks → null
    check('S4-65. Next task: null when no tasks', nextTask([], 'u1') === null);

    // Completed excluded
    const set5 = [{ ...mkT('u1', -1, 'URGENT'), status: 'COMPLETED' }, mkT('u1', 3, 'LOW')];
    check('S4-66. Next task: completed tasks excluded', nextTask(set5, 'u1').priority === 'LOW');

    // Cancelled excluded
    const set6 = [{ ...mkT('u1', -1, 'URGENT'), status: 'CANCELLED' }, mkT('u1', 2, 'MEDIUM')];
    check('S4-67. Next task: cancelled tasks excluded', nextTask(set6, 'u1').priority === 'MEDIUM');

    // Cross-user isolation
    const set7 = [mkT('u1', 0, 'URGENT'), mkT('u2', -1, 'HIGH')];
    check('S4-68. Next task: only own tasks returned', nextTask(set7, 'u1').assigneeId === 'u1');

    // Oldest open breaks ties (same score)
    const older = { ...mkT('u1', 3, 'LOW'), createdAt: new Date(Date.now() - 5000).toISOString() };
    const newer = { ...mkT('u1', 3, 'LOW'), createdAt: new Date(Date.now() - 1000).toISOString() };
    check('S4-69. Next task: oldest open wins tiebreak', nextTask([newer, older], 'u1').createdAt === older.createdAt);

    // ── Next task from live API (Director's own tasks) ────────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/tasks');
    if (r.data.success && dirId) {
        const nt = nextTask(r.data.tasks, dirId);
        // Director has t_dir (completed) — so no remaining tasks. Either null or any remaining open.
        check('S4-70. Next task from live API returns null or a valid task',
            nt === null || (nt && typeof nt.id === 'string'));
    }

    // ── Template quick action: only Director ────────────────────────────────────
    r = await api(dirTok, 'POST', '/api/operations/templates', {
        title: 'Dir daily check', frequency: 'DAILY', startDate: '2026-08-01', workSchedule: [1,2,3,4,5]
    });
    check('S4-71. Director template quick action works', r.data.success, r.data.error);

    r = await api(strangerTok, 'GET', '/api/operations/templates');
    check('S4-72. Non-member cannot list templates (403)', r.status === 403);

    // ── File existence: all 5 role dashboards + router ─────────────────────────
    const rootDir = path.join(__dirname, '..');
    const dashFiles = [
        ['operations.html',          'Role router'],
        ['operations-director.html', 'Director dashboard'],
        ['operations-cc.html',       'Chef Cuisine dashboard'],
        ['operations-adjoint.html',  'Adjoint dashboard'],
        ['operations-souschef.html', 'Sous Chef dashboard'],
        ['operations-cdb.html',      'Chef de Brigade dashboard'],
    ];
    for (const [file, label] of dashFiles) {
        check(`S4-73. ${label} file exists`, fs.existsSync(path.join(rootDir, 'public', file)));
    }

    // Verify router contains role→route mapping for all 5 roles
    const routerSrc = fs.readFileSync(path.join(rootDir, 'public/operations.html'), 'utf8');
    check('S4-79. Router maps DIRECTOR',       routerSrc.includes('operations-director.html'));
    check('S4-80. Router maps CHEF_CUISINE',   routerSrc.includes('operations-cc.html'));
    check('S4-81. Router maps ADJOINT',        routerSrc.includes('operations-adjoint.html'));
    check('S4-82. Router maps SOUS_CHEF',      routerSrc.includes('operations-souschef.html'));
    check('S4-83. Router maps CHEF_DE_BRIGADE',routerSrc.includes('operations-cdb.html'));

    // Verify each dashboard has role-guard redirect
    const dirSrc  = fs.readFileSync(path.join(rootDir, 'public/operations-director.html'), 'utf8');
    const ccSrc   = fs.readFileSync(path.join(rootDir, 'public/operations-cc.html'), 'utf8');
    const adjSrc  = fs.readFileSync(path.join(rootDir, 'public/operations-adjoint.html'), 'utf8');
    const scSrc   = fs.readFileSync(path.join(rootDir, 'public/operations-souschef.html'), 'utf8');
    const cdbSrc  = fs.readFileSync(path.join(rootDir, 'public/operations-cdb.html'), 'utf8');
    check('S4-84. Director dashboard has role guard', dirSrc.includes("!== 'DIRECTOR'") && dirSrc.includes('operations.html'));
    check('S4-85. CC dashboard has role guard',       ccSrc.includes("!== 'CHEF_CUISINE'")    && ccSrc.includes('operations.html'));
    check('S4-86. Adjoint dashboard has role guard',  adjSrc.includes("!== 'ADJOINT'")        && adjSrc.includes('operations.html'));
    check('S4-87. SC dashboard has role guard',       scSrc.includes("!== 'SOUS_CHEF'")       && scSrc.includes('operations.html'));
    check('S4-88. CdB dashboard has role guard',      cdbSrc.includes("!== 'CHEF_DE_BRIGADE'")&& cdbSrc.includes('operations.html'));

    // Verify role-specific quick actions present in HTML
    check('S4-89. Director dashboard: "Crea utente" quick action', dirSrc.includes('Crea utente'));
    check('S4-90. Director dashboard: "Crea template" quick action', dirSrc.includes('Crea template') || dirSrc.includes('Template'));
    check('S4-91. Director dashboard: escalation quick action', dirSrc.includes('Escalation') || dirSrc.includes('escalation'));
    check('S4-92. CC dashboard: kitchen task quick action', ccSrc.includes('cucina') || ccSrc.includes('Cucina'));
    check('S4-93. SC dashboard: "Start next task" primary button', scSrc.includes('Inizia ora') || scSrc.includes('Inizia'));
    check('S4-94. CdB dashboard: "View all my tasks" secondary button', cdbSrc.includes('Visualizza tutti') || cdbSrc.includes('tutti i miei compiti'));
    check('S4-95. SC dashboard: NO workload table (kept simple)', !scSrc.includes('workload-table') && !scSrc.includes('carico di lavoro'));
    check('S4-96. CdB dashboard: NO analytics (kept minimal)', !cdbSrc.includes('workload-table') && !cdbSrc.includes('analytics'));

    // Verify briefing/greeting is present in managerial dashboards
    check('S4-97. Director dashboard has brief-card', dirSrc.includes('brief-card'));
    check('S4-98. CC dashboard has brief-card', ccSrc.includes('brief-card'));
    check('S4-99. Adjoint dashboard has brief-card', adjSrc.includes('brief-card'));

    // Verify next-task cards on operational dashboards
    check('S4-100. SC dashboard has next-task-card', scSrc.includes('next-task-card'));
    check('S4-101. CdB dashboard has next-task-card', cdbSrc.includes('next-task-card'));
    check('S4-102. Director dashboard does NOT have next-task-card (strategic, not operational)', !dirSrc.includes('next-task-card'));

    // ── Empty state messages (not empty tables) ──
    check('S4-103. SC dashboard has positive empty state', scSrc.includes('completati') || scSrc.includes('Ottimo'));
    check('S4-104. CdB dashboard has positive empty state', cdbSrc.includes('completati') || cdbSrc.includes('Ottimo'));

    // ── Sprint 4 CSS additions ──
    const cssSrc = fs.readFileSync(path.join(rootDir, 'public/css/operations.css'), 'utf8');
    check('S4-105. CSS: .brief-card defined', cssSrc.includes('.brief-card'));
    check('S4-106. CSS: .qa-grid defined',    cssSrc.includes('.qa-grid'));
    check('S4-107. CSS: .next-task-card defined', cssSrc.includes('.next-task-card'));
    check('S4-108. CSS: .qa-btn defined', cssSrc.includes('.qa-btn'));

    // ── Summary ──────────────────────────────────────────────────────────────────
    console.log(`\n${passed} passed, ${failed} failed`);
    proc.kill();
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
