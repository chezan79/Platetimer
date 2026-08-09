#!/usr/bin/env node
'use strict';
// tests/operations-usermgmt.test.js — Team user management: edit, suspend,
// archive, restore, delete. Covers all 22 spec items.
//
// Pattern: Director token for all HTTP tests (non-director activation requires
// Firebase); module-level opsAuth checks for pure logic validation.
//
// Run: node tests/operations-usermgmt.test.js

const http   = require('http');
const crypto = require('crypto');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn } = require('child_process');

const SECRET = 'test-usermgmt-secret';
const PORT   = 4457;

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
    console.log('Starting server (user-management tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstest-um-'));
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
    console.log('Server up. Running user-management checks…\n');

    // Two companies for isolation tests
    const co  = 'UM_A_' + crypto.randomBytes(3).toString('hex');
    const co2 = 'UM_B_' + crypto.randomBytes(3).toString('hex');
    const dirTok  = sign('um-dir-a', co);
    const dir2Tok = sign('um-dir-b', co2);

    // Bootstrap directors
    let r = await api(dirTok, 'GET', '/api/operations/me');
    check('UM-0. Director A bootstrapped', r.data.success && r.data.user.role === 'DIRECTOR');
    const dirId = r.data.user.id;

    r = await api(dir2Tok, 'GET', '/api/operations/me');
    check('UM-1. Director B bootstrapped (isolation company)', r.data.success);

    // Invite some team members
    async function invite(tok, name, email, role) {
        const res = await api(tok, 'POST', '/api/operations/users', { name, email, role });
        return res.data.user || null;
    }
    const ccUser  = await invite(dirTok, 'Chef Cucina Test', `cc_${crypto.randomBytes(2).toString('hex')}@um.it`, 'CHEF_CUISINE');
    const scUser  = await invite(dirTok, 'Sous Chef Test',   `sc_${crypto.randomBytes(2).toString('hex')}@um.it`, 'SOUS_CHEF');
    const cdbUser = await invite(dirTok, 'CdB Test',         `cdb_${crypto.randomBytes(2).toString('hex')}@um.it`, 'CHEF_DE_BRIGADE');
    const cleanUser = await invite(dirTok, 'Clean User',     `clean_${crypto.randomBytes(2).toString('hex')}@um.it`, 'SOUS_CHEF');
    check('UM-2. Test team members invited', !!(ccUser && scUser && cdbUser && cleanUser));

    // ── T1: Director can modify subordinate name + role ─────────────────────
    r = await api(dirTok, 'PUT', `/api/operations/users/${ccUser.id}`, { name: 'Chef Cucina Modificato', role: 'ADJOINT' });
    check('UM-3. Director can modify name', r.data.success && r.data.user.name === 'Chef Cucina Modificato', r.data.error);
    check('UM-4. Director can modify role', r.data.success && r.data.user.role === 'ADJOINT', r.data.error);

    // Role change visible in GET
    r = await api(dirTok, 'GET', '/api/operations/users?status=all');
    const updatedCC = r.data.users && r.data.users.find(u => u.id === ccUser.id);
    check('UM-5. Role change persisted in GET', updatedCC && updatedCC.role === 'ADJOINT');

    // ── T2: Non-Director / non-member cannot modify users ───────────────────
    const strangerTok = sign('stranger-' + crypto.randomBytes(4).toString('hex'), co);
    r = await api(strangerTok, 'PUT', `/api/operations/users/${ccUser.id}`, { name: 'Hack' });
    check('UM-6. Non-member cannot modify user (403)', r.status === 403);

    // ── T3: Cross-company modification rejected ──────────────────────────────
    r = await api(dir2Tok, 'PUT', `/api/operations/users/${ccUser.id}`, { name: 'CrossHack' });
    check('UM-7. Cross-company modification rejected (404)', r.status === 404, r.status);

    // ── Email for INVITED — read-only after activation (uid set) ────────────
    // ccUser is INVITED, no uid → email editable
    r = await api(dirTok, 'PUT', `/api/operations/users/${ccUser.id}`, { email: `newemail_${crypto.randomBytes(2).toString('hex')}@um.it` });
    check('UM-8. Email editable for INVITED user (no Firebase uid)', r.data.success, r.data.error);

    // ── T4: Director can suspend an ACTIVE/INVITED user ──────────────────────
    r = await api(dirTok, 'POST', `/api/operations/users/${scUser.id}/suspend`, {});
    check('UM-9. Director can suspend user', r.data.success && r.data.user.status === 'SUSPENDED', r.data.error);
    check('UM-10. Suspended user has active=false', r.data.user.active === false);
    check('UM-11. openTasks returned on suspend', typeof r.data.openTasks === 'number');

    // ── T5: Suspended user status correctly reflected ────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/users?status=suspended');
    const suspendedList = r.data.users || [];
    check('UM-12. Suspended user appears in ?status=suspended filter', suspendedList.some(u => u.id === scUser.id));

    // ── T7: Suspended user excluded from assignee list ────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/assignees');
    const assignees = r.data.assignees || [];
    check('UM-13. Suspended user NOT in assignee list', !assignees.some(u => u.id === scUser.id));

    // ── T6: Suspended user cannot receive new task ────────────────────────────
    r = await api(dirTok, 'POST', '/api/operations/tasks', {
        title: 'Task for suspended', assigneeId: scUser.id, priority: 'MEDIUM', dueDate: new Date(Date.now()+86400000).toISOString()
    });
    check('UM-14. Task cannot be assigned to suspended user (400)', r.status === 400, r.status);

    // ── T8: Director can reactivate suspended user ────────────────────────────
    r = await api(dirTok, 'POST', `/api/operations/users/${scUser.id}/reactivate`, {});
    check('UM-15. Director can reactivate suspended user', r.data.success && r.data.user.status === 'ACTIVE', r.data.error);
    check('UM-16. Reactivated user has active=true', r.data.user.active === true);

    // Verify reappears in default list
    r = await api(dirTok, 'GET', '/api/operations/users');
    check('UM-17. Reactivated user visible in default list', r.data.users.some(u => u.id === scUser.id));

    // Double-reactivate guard
    r = await api(dirTok, 'POST', `/api/operations/users/${scUser.id}/reactivate`, {});
    check('UM-18. Reactivating an active user returns 400', r.status === 400, r.status);

    // ── T9: Director can archive a user ──────────────────────────────────────
    r = await api(dirTok, 'POST', `/api/operations/users/${cdbUser.id}/archive`, {});
    check('UM-19. Director can archive user', r.data.success && r.data.user.status === 'ARCHIVED', r.data.error);

    // ── Archived user excluded from default list ─────────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/users');
    check('UM-20. Archived user NOT in default list', !r.data.users.some(u => u.id === cdbUser.id));

    // ── Archived user visible in ?status=archived ────────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/users?status=archived');
    check('UM-21. Archived user visible in ?status=archived', r.data.users.some(u => u.id === cdbUser.id));

    // ── T10: Archived user excluded from task assignment ─────────────────────
    r = await api(dirTok, 'GET', '/api/operations/assignees');
    check('UM-22. Archived user NOT in assignee list', !r.data.assignees.some(u => u.id === cdbUser.id));

    // ── T12: Historical tasks for archived user still visible to Director ─────
    // Create a task assigned to scUser (active), then archive scUser temporarily
    const taskForHistory = await api(dirTok, 'POST', '/api/operations/tasks', {
        title: 'Historical task', assigneeId: scUser.id, priority: 'LOW', dueDate: new Date(Date.now()+86400000).toISOString()
    });
    check('UM-23. Task for history test created', taskForHistory.data.success, taskForHistory.data.error);
    // Archive scUser
    r = await api(dirTok, 'POST', `/api/operations/users/${scUser.id}/archive`, {});
    check('UM-24. SC user archived', r.data.success, r.data.error);
    // Director still sees task
    r = await api(dirTok, 'GET', '/api/operations/tasks');
    const histTask = r.data.tasks && r.data.tasks.find(t => t.id === taskForHistory.data.task.id);
    check('UM-25. Historical task still visible after assignee archived', !!histTask);

    // ── T13: Director can restore archived user ───────────────────────────────
    r = await api(dirTok, 'POST', `/api/operations/users/${scUser.id}/restore`, {});
    check('UM-26. Director can restore archived user', r.data.success && r.data.user.status === 'ACTIVE', r.data.error);

    // Double-restore guard
    r = await api(dirTok, 'POST', `/api/operations/users/${scUser.id}/restore`, {});
    check('UM-27. Restoring an active user returns 400', r.status === 400, r.status);

    // ── T14/T15: Permanent deletion blocked when user has tasks ──────────────
    // scUser now has histTask assigned → has deps
    r = await api(dirTok, 'DELETE', `/api/operations/users/${scUser.id}`);
    check('UM-28. Deletion blocked when user has tasks (409)', r.status === 409, r.status);
    check('UM-29. Response suggests archiving', r.data.suggestArchive === true);

    // ── T16: Permanent deletion allowed for clean user (no tasks/history) ─────
    // cleanUser was invited, never had tasks
    r = await api(dirTok, 'DELETE', `/api/operations/users/${cleanUser.id}`);
    check('UM-30. Clean invited user can be deleted (200)', r.data.success, r.data.error);
    // Confirm gone from GET all
    r = await api(dirTok, 'GET', '/api/operations/users?status=all');
    check('UM-31. Deleted user no longer in store', !r.data.users.some(u => u.id === cleanUser.id));

    // ── T17: Director cannot delete themselves ────────────────────────────────
    r = await api(dirTok, 'DELETE', `/api/operations/users/${dirId}`);
    check('UM-32. Director cannot delete themselves (403)', r.status === 403, r.status);

    // ── T18: Non-member cannot permanently delete ─────────────────────────────
    r = await api(strangerTok, 'DELETE', `/api/operations/users/${ccUser.id}`);
    check('UM-33. Non-member cannot delete (403)', r.status === 403, r.status);

    // ── T19: Cross-company deletion rejected ──────────────────────────────────
    r = await api(dir2Tok, 'DELETE', `/api/operations/users/${ccUser.id}`);
    check('UM-34. Cross-company deletion rejected (404)', r.status === 404, r.status);

    // ── T20: Forged companyId in body is ignored ──────────────────────────────
    // Company isolation: body companyId cannot leak into another company's context
    r = await api(dir2Tok, 'POST', '/api/operations/users', {
        name: 'Forge', email: `forge_${crypto.randomBytes(2).toString('hex')}@hack.it`,
        role: 'CHEF_DE_BRIGADE', companyId: co  // deliberately wrong
    });
    // Should succeed (creates user in company B, not company A)
    if (r.data.success) {
        check('UM-35. Forged companyId ignored: user created in actor\'s company',
            r.data.user && r.data.user.id !== undefined);
        // Verify the user is NOT visible from company A
        const rA = await api(dirTok, 'GET', '/api/operations/users?status=all');
        check('UM-36. Forged companyId: user not visible in company A', !rA.data.users.some(u => u.email === r.data.user.email));
    } else {
        check('UM-35. Forged companyId ignored', false, r.data.error);
        check('UM-36. Forged companyId isolation', false, 'prior failed');
    }

    // ── Status filter: ?status=all returns everything ─────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/users?status=all');
    check('UM-37. ?status=all includes archived users', r.data.users.some(u => u.status === 'ARCHIVED'));

    // ── Status filter: default excludes archived ──────────────────────────────
    r = await api(dirTok, 'GET', '/api/operations/users');
    check('UM-38. Default list excludes archived users', !r.data.users.some(u => u.status === 'ARCHIVED'));

    // ── canManageOpsUser module-level checks ──────────────────────────────────
    const opsAuth = require('../operations/ops-auth');
    const mkU = (id, role, cId = co) => ({ id, role, companyId: cId, active: true });

    const D  = mkU(dirId, 'DIRECTOR');
    const CC = mkU(ccUser.id, 'CHEF_CUISINE');
    const SC = mkU(scUser.id, 'SOUS_CHEF');

    check('UM-39. canManageOpsUser: Director + other company member → true', opsAuth.canManageOpsUser(D, CC));
    check('UM-40. canManageOpsUser: Director + self → false (not own account)', !opsAuth.canManageOpsUser(D, D));
    check('UM-41. canManageOpsUser: non-Director → false', !opsAuth.canManageOpsUser(CC, SC));
    check('UM-42. canManageOpsUser: cross-company → false', !opsAuth.canManageOpsUser(D, mkU('x', 'SOUS_CHEF', 'other-co')));

    // ── canDeleteOpsUser ───────────────────────────────────────────────────────
    check('UM-43. canDeleteOpsUser: Director + other → true', opsAuth.canDeleteOpsUser(D, CC));
    check('UM-44. canDeleteOpsUser: Director + self → false', !opsAuth.canDeleteOpsUser(D, D));

    // ── hasUserDependencies ───────────────────────────────────────────────────
    const taskWithAssign = [{ assigneeId: 'u1', createdBy: 'u2', comments: [], history: [] }];
    check('UM-45. hasUserDependencies: assigned task → true', opsAuth.hasUserDependencies('u1', taskWithAssign, []));

    const taskCreated = [{ assigneeId: 'u2', createdBy: 'u1', comments: [], history: [] }];
    check('UM-46. hasUserDependencies: created task → true', opsAuth.hasUserDependencies('u1', taskCreated, []));

    const taskWithComment = [{ assigneeId: 'u2', createdBy: 'u2', comments: [{ authorId: 'u1' }], history: [] }];
    check('UM-47. hasUserDependencies: comment → true', opsAuth.hasUserDependencies('u1', taskWithComment, []));

    const taskWithHistory = [{ assigneeId: 'u2', createdBy: 'u2', comments: [], history: [{ actorId: 'u1' }] }];
    check('UM-48. hasUserDependencies: history entry → true', opsAuth.hasUserDependencies('u1', taskWithHistory, []));

    const tplRef = [{ defaultAssigneeId: 'u1', createdBy: 'u2' }];
    check('UM-49. hasUserDependencies: template reference → true', opsAuth.hasUserDependencies('u1', [], tplRef));

    check('UM-50. hasUserDependencies: no data → false', !opsAuth.hasUserDependencies('u1', [], []));
    check('UM-51. hasUserDependencies: unrelated task → false',
        !opsAuth.hasUserDependencies('u1', [{ assigneeId: 'u2', createdBy: 'u2', comments: [], history: [] }], []));

    // ── Self-suspend guard ────────────────────────────────────────────────────
    r = await api(dirTok, 'POST', `/api/operations/users/${dirId}/suspend`, {});
    check('UM-52. Director cannot suspend themselves (403)', r.status === 403, r.status);

    // ── Self-archive guard ────────────────────────────────────────────────────
    r = await api(dirTok, 'POST', `/api/operations/users/${dirId}/archive`, {});
    check('UM-53. Director cannot archive themselves (403)', r.status === 403, r.status);

    // ── Non-member suspend/archive/restore/delete ─────────────────────────────
    r = await api(strangerTok, 'POST', `/api/operations/users/${ccUser.id}/suspend`, {});
    check('UM-54. Non-member cannot suspend (403)', r.status === 403);
    r = await api(strangerTok, 'POST', `/api/operations/users/${ccUser.id}/archive`, {});
    check('UM-55. Non-member cannot archive (403)', r.status === 403);

    // ── hasFirebaseAccount exposed correctly for INVITED ─────────────────────
    r = await api(dirTok, 'GET', '/api/operations/users?status=all');
    const invitedUser = r.data.users.find(u => u.status === 'INVITED');
    if (invitedUser) {
        check('UM-56. INVITED user has hasFirebaseAccount=false', invitedUser.hasFirebaseAccount === false);
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log(`\n${passed} passed, ${failed} failed`);
    proc.kill();
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
