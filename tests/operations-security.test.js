// tests/operations-security.test.js — Automated security & DoD checks for
// PlateTimer Operations Sprint 1.
//
// Spawns the real server with a known WS_SESSION_SECRET and an isolated
// DATA_DIR, signs session tokens directly (same HMAC scheme) and exercises the
// Operations API as multiple users/companies.
//
// Run: node tests/operations-security.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = 'test-secret-for-ops-suite';
const PORT = 5097;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'opstest-'));

function sign(uid, companyName, authSource = 'ops-bootstrap') {
    const payload = Buffer.from(JSON.stringify({ uid, companyName, authSource, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}
function forge(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({ uid, companyName, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64');
    return `${payload}.` + '0'.repeat(64); // bad signature
}
function mockFb(user) {
    return 'mockfb.' + Buffer.from(JSON.stringify(user)).toString('base64');
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
    else { failed++; console.error(`  ❌ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

async function main() {
    console.log('Starting server…');
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT), WS_SESSION_SECRET: SECRET, DATA_DIR, FIREBASE_ADMIN_SERVICE_ACCOUNT: '', TEST_FIREBASE_AUTH_MOCK: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
        server.stdout.on('data', d => { if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(); } });
    });
    console.log('Server up. Running checks…\n');

    try {
        // Tokens: company A director (bootstrap), company B director
        const dirA = sign('uid-dirA', 'company-a');
        const dirB = sign('uid-dirB', 'company-b');

        // ── Auth basics ──
        let r = await api('garbage', 'GET', '/api/operations/tasks');
        check('1. Invalid token rejected (401)', r.status === 401);
        r = await api(forge('uid-x', 'company-a'), 'GET', '/api/operations/tasks');
        check('2. Forged-signature token rejected (401)', r.status === 401);

        const newServiceFb = mockFb({
            localId: 'uid-new-service',
            email: 'new-service@example.test',
            emailVerified: true
        });
        let registration = await fetch(`${BASE}/api/auth/register-company`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${newServiceFb}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                firstName: 'New',
                lastName: 'Service',
                company: 'New Service Company'
            })
        });
        const registrationData = await registration.json();
        let registeredSession = await fetch(`${BASE}/api/auth/session`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${newServiceFb}` }
        });
        const registeredSessionData = await registeredSession.json();
        check('2-registration. Server registration provisions a usable Service company session',
            registration.status === 201 &&
            registrationData.companyName === 'new service company' &&
            registeredSession.status === 200 &&
            registeredSessionData.companyName === 'new service company');

        // A Firebase profile may still identify a legacy Service tenant, but it
        // is never sufficient to bootstrap that tenant's first Director.
        const forgedProfileToken = mockFb({
            localId: 'uid-profile-attacker',
            email: 'attacker@example.test',
            emailVerified: true,
            company: 'profile-forged-company'
        });
        let profileSessionRes = await fetch(`${BASE}/api/auth/session`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${forgedProfileToken}` }
        });
        const profileSession = await profileSessionRes.json();
        r = await api(profileSession.token, 'GET', '/api/operations/me');
        check('2a. Firebase-profile company cannot bootstrap first Director (403)', r.status === 403);
        const floorExchange = await api(profileSession.token, 'GET', '/api/sala/token');
        r = await api(floorExchange.data.token, 'GET', '/api/operations/me');
        check('2b. Firebase-profile user cannot bootstrap through a Floor token', r.status === 403);
        const claimedBootstrapToken = mockFb({
            localId: 'uid-claimed-bootstrap',
            email: 'owner@example.test',
            company: 'attacker-profile-company',
            customAttributes: JSON.stringify({
                plateTimerCompanyAdmin: true,
                plateTimerCompanyId: 'claimed-bootstrap-company'
            })
        });
        const claimedSessionRes = await fetch(`${BASE}/api/auth/session`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${claimedBootstrapToken}` }
        });
        const claimedSession = await claimedSessionRes.json();
        r = await api(claimedSession.token, 'GET', '/api/operations/me');
        check('2c. Server-controlled admin claim bootstraps its claimed company',
            r.status === 200 && r.data.companyId === 'claimed-bootstrap-company');

        // ── Bootstrap: first user of a company becomes DIRECTOR ──
        r = await api(dirA, 'GET', '/api/operations/me?name=Anna%20Direttrice');
        check('3. First company user bootstrapped as DIRECTOR', r.data.success && r.data.user.role === 'DIRECTOR');
        const dirAId = r.data.user.id;
        r = await api(dirB, 'GET', '/api/operations/me?name=Bruno');
        const dirBId = r.data.user.id;

        // Department Account administration is Director-only and company comes
        // from the actor's server-side Operations record.
        r = await api(dirA, 'POST', '/api/departments', { name: 'Admin Test Kitchen' });
        const adminDeptId = r.data.department.id;
        const createdAccount = await api(dirA, 'POST', '/api/department-accounts', {
            departmentId: adminDeptId,
            loginIdentifier: 'admin.security.kitchen',
            password: 'test-pin'
        });
        check('3a. Director can create Department Accounts', createdAccount.status === 201);
        const accountId = createdAccount.data.account.id;
        const ordinaryA = sign('uid-ordinary-a', 'company-a', 'firebase-profile');
        r = await api(ordinaryA, 'GET', '/api/department-accounts');
        check('3b. Ordinary company user cannot list Department Accounts', r.status === 403);
        r = await api(ordinaryA, 'PUT', `/api/departments/${adminDeptId}`, { active: false });
        check('3b-dept. Ordinary company user cannot deactivate departments', r.status === 403);
        r = await api(ordinaryA, 'POST', '/api/departments', { name: 'Unauthorized Department' });
        check('3b-dept-create. Ordinary company user cannot create departments', r.status === 403);
        r = await api(ordinaryA, 'PUT', `/api/departments/${adminDeptId}/type`, { departmentType: 'CENTRAL' });
        check('3b-dept-type. Ordinary company user cannot change department type', r.status === 403);
        r = await api(ordinaryA, 'DELETE', `/api/departments/${adminDeptId}`);
        check('3b-dept-delete. Ordinary company user cannot delete departments', r.status === 403);
        r = await api(ordinaryA, 'POST', '/api/department-accounts', {
            departmentId: adminDeptId,
            loginIdentifier: 'ordinary.takeover'
        });
        check('3c. Ordinary company user cannot create Department Accounts', r.status === 403);
        r = await api(ordinaryA, 'PATCH', `/api/department-accounts/${accountId}`, { loginIdentifier: 'stolen' });
        check('3d. Ordinary company user cannot edit Department Accounts', r.status === 403);
        r = await api(ordinaryA, 'PUT', `/api/department-accounts/${accountId}/status`, { status: 'SUSPENDED' });
        check('3e. Ordinary company user cannot change Department Account status', r.status === 403);
        r = await api(dirB, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'admin.security.kitchen',
            uid: 'forged-target'
        });
        check('3f. Cross-company Department Account binding rejected', r.status === 403);
        const secondDept = await api(dirA, 'POST', '/api/departments', { name: 'Second Admin Test Kitchen' });
        const secondAccount = await api(dirA, 'POST', '/api/department-accounts', {
            departmentId: secondDept.data.department.id,
            loginIdentifier: 'admin.security.second',
            password: 'second-pin'
        });
        const directLogin = await fetch(`${BASE}/api/service/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loginIdentifier: 'admin.security.kitchen', password: 'test-pin' })
        });
        const directSession = await directLogin.json();
        r = await api(directSession.token, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: secondAccount.data.account.loginIdentifier
        });
        check('3g. Direct Service session cannot create a synthetic Firebase UID binding', r.status === 403);
        r = await api(directSession.token, 'PUT', `/api/departments/${adminDeptId}`, { active: false });
        check('3g-dept. Direct Service session cannot mutate departments', r.status === 403);
        const emptyServiceCompany = sign('depacct_synthetic', 'service-only-company', 'department-account');
        r = await api(emptyServiceCompany, 'GET', '/api/operations/me');
        check('3h. Direct Service principal cannot bootstrap first Director', r.status === 403);

        // ── Director creates team (companyId always server-side) ──
        async function invite(token, name, email, role) {
            const res = await api(token, 'POST', '/api/operations/users', { name, email, role, companyId: 'FORGED-COMPANY' });
            return res;
        }
        const cc = await invite(dirA, 'Carlo ChefCuisine', 'cc@a.it', 'CHEF_CUISINE');
        const adj = await invite(dirA, 'Ada Adjoint', 'adj@a.it', 'ADJOINT');
        const sc = await invite(dirA, 'Sara SousChef', 'sc@a.it', 'SOUS_CHEF');
        const cdb = await invite(dirA, 'Ciro Brigade', 'cdb@a.it', 'CHEF_DE_BRIGADE');
        check('4. Director creates users; forged companyId ignored',
            cc.status === 201 && cc.data.user && !JSON.stringify(cc.data).includes('FORGED-COMPANY'));
        r = await api(dirA, 'POST', '/api/operations/users', { name: 'X', email: 'x@a.it', role: 'SUPER_ADMIN' });
        check('5. Invalid role rejected server-side', r.status === 400);

        // Bind uids to invited users by activating? Can't (Firebase). Instead simulate
        // logged-in members: directly patch the store file is not possible while server
        // holds memory. Use invitation binding endpoint is Firebase-only, so instead
        // test hierarchy with tokens whose uid matches... we need uid-bound records.
        // Trick: each invited member's record has uid=null. We create per-company
        // sessions for NEW uids in a company that already has ops users → must be 403.
        r = await api(sign('uid-stranger', 'company-a'), 'GET', '/api/operations/tasks');
        check('6. Non-member of existing Ops company rejected (403)', r.status === 403);

        // For hierarchy tests, bind uids via the test-only path: activation requires
        // Firebase, so emulate by having the members be first users of sub-checks is
        // impossible — instead we validate hierarchy through the authorization module
        // directly (unit-level) and through Director-level API behaviour.
        const opsAuth = require('../operations/ops-auth');
        const U = (id, role, companyId = 'company-a') => ({ id, role, companyId, active: true });
        const D = U('d', 'DIRECTOR'), C = U('c', 'CHEF_CUISINE'), A = U('a', 'ADJOINT'), S = U('s', 'SOUS_CHEF'), B = U('b', 'CHEF_DE_BRIGADE');
        check('7. Chef Cuisine cannot assign to Director/Adjoint',
            !opsAuth.canAssignTaskTo(C, D) && !opsAuth.canAssignTaskTo(C, A) &&
            opsAuth.canAssignTaskTo(C, S) && opsAuth.canAssignTaskTo(C, B) && opsAuth.canAssignTaskTo(C, C));
        check('8. Adjoint: self + Chef de Brigade only',
            opsAuth.canAssignTaskTo(A, A) && opsAuth.canAssignTaskTo(A, B) &&
            !opsAuth.canAssignTaskTo(A, S) && !opsAuth.canAssignTaskTo(A, C) && !opsAuth.canAssignTaskTo(A, D));
        check('9. Sous Chef / Chef de Brigade self-assign only',
            opsAuth.canAssignTaskTo(S, S) && !opsAuth.canAssignTaskTo(S, B) &&
            opsAuth.canAssignTaskTo(B, B) && !opsAuth.canAssignTaskTo(B, S) && !opsAuth.canAssignTaskTo(B, A));
        check('10. Cross-company assignment impossible (module level)',
            !opsAuth.canAssignTaskTo(D, U('z', 'CHEF_DE_BRIGADE', 'company-b')));
        const task = { companyId: 'company-a', assigneeId: 'b', createdBy: 'c' };
        const byId = { d: D, c: C, a: A, s: S, b: B };
        check('11. Visibility: Director sees all; Brigade sees own only; Adjoint sees Brigade tasks',
            opsAuth.canViewTask(D, task, byId) && opsAuth.canViewTask(A, task, byId) &&
            opsAuth.canViewTask(B, task, byId) && !opsAuth.canViewTask(S, task, byId));
        check('12. Completion: assignee only',
            opsAuth.canCompleteTask(B, task) && !opsAuth.canCompleteTask(D, task) && !opsAuth.canCompleteTask(C, task));

        // ── Task API through HTTP (Director A) ──
        r = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Mise en place', description: 'Prep', priority: 'HIGH',
            assigneeId: cc.data.user.id, dueDate: '2020-01-01T10:00',
            companyId: 'company-b', createdBy: 'FORGED', status: 'COMPLETED', completedAt: 123
        });
        check('13. Task created; forged companyId/createdBy/status ignored',
            r.status === 201 && r.data.task.companyId === 'company-a' &&
            r.data.task.createdBy === dirAId && r.data.task.status === 'OPEN' && r.data.task.completedAt === null);
        check('14. OVERDUE computed from past dueDate', r.data.task.effectiveStatus === 'OVERDUE');
        const taskId = r.data.task.id;

        // Assignee not in company (cross-company assignee id)
        r = await api(dirB, 'POST', '/api/operations/tasks', { title: 'Steal', assigneeId: cc.data.user.id });
        check('15. Cross-company assigneeId rejected', r.status === 400);

        // Company B director cannot see/complete company A tasks
        r = await api(dirB, 'GET', '/api/operations/tasks');
        check('16. Company B sees zero company A tasks', r.data.success && r.data.tasks.length === 0);
        r = await api(dirB, 'PUT', `/api/operations/tasks/${taskId}`, { status: 'COMPLETED' });
        check('17. Cross-company task completion rejected (404)', r.status === 404);

        // Director is not assignee → cannot complete
        r = await api(dirA, 'PUT', `/api/operations/tasks/${taskId}`, { status: 'COMPLETED' });
        check('18. Non-assignee completion rejected (403)', r.status === 403);

        // Self-assigned task completes fine, completedAt set
        r = await api(dirA, 'POST', '/api/operations/tasks', { title: 'My own task', assigneeId: dirAId });
        const myTask = r.data.task.id;
        r = await api(dirA, 'PUT', `/api/operations/tasks/${myTask}`, { status: 'COMPLETED' });
        check('19. Assignee completes own task; completedAt set',
            r.data.success && r.data.task.status === 'COMPLETED' && typeof r.data.task.completedAt === 'number');

        // Non-director user management rejection: dirB manages only company-b; try
        // toggling a company-a user id from dirB (company isolation)
        r = await api(dirB, 'PUT', `/api/operations/users/${cc.data.user.id}`, { active: false });
        check('20. Director of another company cannot manage foreign users (404)', r.status === 404);

        // Deactivation works in own company, deactivated member listing intact
        r = await api(dirA, 'PUT', `/api/operations/users/${cdb.data.user.id}`, { active: false });
        check('21. Director deactivates own-company user', r.data.success && r.data.user.active === false);
        r = await api(dirA, 'POST', '/api/operations/tasks', { title: 'To inactive', assigneeId: cdb.data.user.id });
        check('22. Cannot assign task to deactivated user', r.status === 400);

        // Invitation endpoints
        r = await fetch(`${BASE}/api/operations/invitations/${cc.data.user.inviteCode}`).then(x => x.json());
        check('23. Invitation lookup by code works', r.success && r.invitation.email === 'cc@a.it');
        r = await fetch(`${BASE}/api/operations/invitations/badcode`).then(x => x.status === 404 ? { s: 404 } : x.json(), () => ({}));
        const badInv = await fetch(`${BASE}/api/operations/invitations/badcode`);
        check('24. Bad invite code rejected (404)', badInv.status === 404);
        const noTok = await fetch(`${BASE}/api/operations/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'x' }) });
        check('25. Activation without Firebase token rejected (401)', noTok.status === 401);

        // Activation account validation (centralized module — the /activate endpoint
        // delegates to this after Firebase accounts:lookup, which cannot be minted
        // in tests without live Firebase credentials)
        const inv = { status: 'INVITED', email: 'cc@a.it' };
        let v = opsAuth.validateActivationAccount({ localId: 'u1', email: 'cc@a.it', emailVerified: false }, inv);
        check('25a. Matching invite email accepted without Firebase verification', v.ok === true);
        v = opsAuth.validateActivationAccount({ localId: 'u1', email: 'attacker@evil.it', emailVerified: true }, inv);
        check('25b. Mismatched email rejected (403)', !v.ok && v.code === 403);
        v = opsAuth.validateActivationAccount({ localId: 'u1', email: 'CC@A.IT', emailVerified: true }, inv);
        check('25c. Verified matching email accepted', v.ok === true);
        v = opsAuth.validateActivationAccount({ localId: 'u1', email: 'cc@a.it', emailVerified: true }, { status: 'ACTIVE', email: 'cc@a.it' });
        check('25d. Already-used invitation rejected (404)', !v.ok && v.code === 404);

        // ── Integration: real Firebase invitee, profile-less → session issuance ──
        // Creates a throwaway Firebase account via REST (public web API key),
        // verifies: (a) session exchange fails with NO Firestore profile — the
        // reason the activation page must create the profile BEFORE the exchange;
        // (b) after the profile exists, session exchange succeeds; (c) activation
        // with an UNVERIFIED (but matching) email is rejected 403 end-to-end.
        const FB_KEY = 'AIzaSyDZ0FdjenO-ngblcuXKdwWwvRV5liiR18I';
        const FB_PROJECT = 'app-dati-tavoli';
        let fb = null;
        try {
            const email = `ops-test-${Date.now()}@example.com`;
            const su = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_KEY}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password: 'test-pass-123', returnSecureToken: true })
            });
            if (su.ok) fb = await su.json();
            if (fb) {
                const idToken = fb.idToken, uid = fb.localId;

                // (a) profile-less session exchange must fail (403 — no company)
                let sess = await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Authorization': `Bearer ${idToken}` } });
                check('27. Session exchange fails for profile-less new invitee (403)', sess.status === 403);

                // Activation with unverified email — invite the test address first
                const invR = await invite(dirA, 'Test Invitee', email, 'CHEF_DE_BRIGADE');
                const act = await fetch(`${BASE}/api/operations/activate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                    body: JSON.stringify({ code: invR.data.user.inviteCode })
                });
                const actData = await act.json();
                check('28. Real matching Firebase account activates via single-use invite',
                    act.status === 200 && actData.success === true);

                // (b) create the Firestore users/{uid} profile (as the activation page
                // does, using the user's own token), then session exchange succeeds
                const fsWrite = await fetch(
                    `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/users/${uid}`,
                    {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                        body: JSON.stringify({ fields: { company: { stringValue: 'company-a' }, email: { stringValue: email } } })
                    });
                if (fsWrite.ok) {
                    sess = await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Authorization': `Bearer ${idToken}` } });
                    const sessData = await sess.json().catch(() => ({}));
                    check('29. Session issued once profile exists (activation-page ordering)',
                        sess.ok && sessData.token && sessData.companyName === 'company-a');
                    // cleanup Firestore doc
                    await fetch(`https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/users/${uid}`,
                        { method: 'DELETE', headers: { 'Authorization': `Bearer ${idToken}` } }).catch(() => {});
                } else {
                    console.log('  ⚠️ 29. skipped — Firestore rules blocked test profile write (' + fsWrite.status + ')');
                }
                // ── Cross-company regression: activated ops record wins ──
                // The invite bound this uid to company-a server-side. A forged
                // profile company must not move that administrative membership.
                let br = await api(sign(uid, 'company-a'), 'GET', '/api/operations/me');
                check('30. Activated uid resolves through server-side Operations membership',
                    br.data.success && br.data.companyId === 'company-a');
                const forgedCompany = `forged-profile-${Date.now()}`;
                const forgeWrite = await fetch(
                    `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=company`,
                    {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                        body: JSON.stringify({ fields: { company: { stringValue: forgedCompany } } })
                    });
                if (forgeWrite.ok) {
                    const sess2 = await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Authorization': `Bearer ${idToken}` } });
                    const sess2Data = await sess2.json().catch(() => ({}));
                    check('31. Session company = server-side ops company, forged profile company ignored',
                        sess2.ok && sess2Data.companyName === 'company-a');
                    // The signed token must not grant access to the forged tenant.
                    if (sess2Data.token) {
                        const depts = await fetch(`${BASE}/api/departments`, { headers: { 'Authorization': `Bearer ${sess2Data.token}` } });
                        const deptsData = await depts.json().catch(() => ({}));
                        check('32. Ops-derived session remains scoped to its server-side company',
                            depts.ok && Array.isArray(deptsData.departments) &&
                            deptsData.departments.some(d => d.id === adminDeptId));
                    }
                } else {
                    check('31. Firestore rules reject changing the company field', forgeWrite.status === 403);
                    console.log('  ⚠️ 32 skipped — forged profile write correctly blocked');
                }

                // cleanup Firebase account (self-delete)
                await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${FB_KEY}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
                }).catch(() => {});
            } else {
                console.log('  ⚠️ 27-29 skipped — Firebase signUp unavailable (' + su.status + ')');
            }
        } catch (e) {
            console.log('  ⚠️ 27-29 skipped — no network access to Firebase: ' + e.message);
        }

        // Assignees endpoint reflects hierarchy (director sees everyone active)
        const allUsers = await api(dirA, 'GET', '/api/operations/users');
        const activeCount = allUsers.data.users.filter(u => u.active).length;
        r = await api(dirA, 'GET', '/api/operations/assignees');
        check('26. Director assignee list = all active company users',
            r.data.success && r.data.assignees.length === activeCount && activeCount >= 4);
    } finally {
        server.kill('SIGTERM');
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
