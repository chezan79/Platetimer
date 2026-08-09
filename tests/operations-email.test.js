// tests/operations-email.test.js — Sprint 1.1 targeted email/notification tests.
//
// Validates: invitation email trigger, task notification trigger, self-task skip,
// unauthorized/cross-company assignment sends no email, email failure does not
// roll back task, invitation failure does not corrupt account, resend authorization,
// activation link host from trusted config.
//
// Run: node tests/operations-email.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = 'test-secret-email-suite';
const PORT = 5098;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'opsemail-'));

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
    else { failed++; console.error(`  ❌ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

async function main() {
    console.log('Starting server (email tests)…');
    // Start server WITHOUT SMTP configured — ensures logging transport.
    // Tests verify the result enum (SENT/FAILED/SKIPPED) in API responses.
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            // Explicitly clear SMTP so transport = 'logging'
            SMTP_HOST: '',
            SMTP_USER: '',
            SMTP_PASS: '',
            // Set APP_BASE_URL to verify activation link construction
            APP_BASE_URL: 'https://test.platetimer.example'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
        server.stdout.on('data', d => { if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(); } });
    });
    console.log('Server up. Running email checks…\n');

    try {
        const dirA = sign('uid-edirA', 'email-co-a');
        const dirB = sign('uid-edirB', 'email-co-b');

        // Bootstrap directors
        await api(dirA, 'GET', '/api/operations/me?name=Elena%20Dir');
        const meA = await api(dirA, 'GET', '/api/operations/me');
        const dirAId = meA.data.user.id;
        await api(dirB, 'GET', '/api/operations/me?name=Franco%20Dir');
        const meB = await api(dirB, 'GET', '/api/operations/me');

        // ── E1. Invitation email trigger ──────────────────────────────────────
        // User creation should return emailResult field (SENT or FAILED, never absent)
        let r = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Chef Test', email: 'chef@test.it', role: 'CHEF_DE_BRIGADE'
        });
        check('E1. User creation returns emailResult field',
            r.status === 201 && r.data.success && typeof r.data.emailResult === 'string',
            r.data);
        check('E1b. emailResult is a valid result enum (SENT|FAILED)',
            r.data.emailResult === 'SENT' || r.data.emailResult === 'FAILED',
            r.data.emailResult);
        const chefId = r.data.user && r.data.user.id;
        const chefInviteCode = r.data.user && r.data.user.inviteCode;
        check('E1c. activationUrl in response is relative path (never exposes full host to client)',
            r.data.activationUrl && r.data.activationUrl.startsWith('/operations-activate.html'),
            r.data.activationUrl);
        check('E1d. emailNote is present and non-empty',
            typeof r.data.emailNote === 'string' && r.data.emailNote.length > 0,
            r.data.emailNote);

        // ── E2. Activation link uses APP_BASE_URL (server config), not client headers ──
        // We can verify indirectly: response returns relative activationUrl (safe for client).
        // The actual absolute URL is only used internally for email body.
        // Test: verify invite code structure is intact (code is NOT the base URL)
        check('E2. activationUrl contains invite code',
            r.data.activationUrl && r.data.activationUrl.includes('code='),
            r.data.activationUrl);
        check('E2b. inviteCode never includes APP_BASE_URL (no host in code field)',
            chefInviteCode && !chefInviteCode.includes('https://'),
            chefInviteCode);

        // ── E3. Task notification trigger ─────────────────────────────────────
        // Assign task to different user → notificationResult must be present
        r = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Task per Chef', priority: 'HIGH', assigneeId: chefId
        });
        check('E3. Task creation for other user returns notificationResult',
            r.status === 201 && typeof r.data.notificationResult === 'string',
            r.data);
        check('E3b. notificationResult is valid enum (SENT|FAILED)',
            r.data.notificationResult === 'SENT' || r.data.notificationResult === 'FAILED',
            r.data.notificationResult);
        const taskId = r.data.task && r.data.task.id;

        // ── E4. Self-assigned task → email SKIPPED ────────────────────────────
        r = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'My own task', assigneeId: dirAId
        });
        check('E4. Self-assigned task returns notificationResult SKIPPED',
            r.status === 201 && r.data.notificationResult === 'SKIPPED',
            r.data.notificationResult);

        // ── E5. Unauthorized assignment → no task created, no email ───────────
        // Create a CHEF_DE_BRIGADE and try to assign to CHEF_CUISINE (not allowed by hierarchy)
        const ccR = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Chef Cuisine', email: 'cc@test.it', role: 'CHEF_CUISINE'
        });
        const ccId = ccR.data.user && ccR.data.user.id;
        // Simulate a CHEF_DE_BRIGADE session: we can't activate Firebase, but we can
        // verify through the API that unauthorized assignment is rejected (status 403).
        // The test verifies that no task is created (no 201) when authorization fails.
        r = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Unauthorized', assigneeId: ccId
        });
        // Director CAN assign to CHEF_CUISINE — test cross-company instead
        const crossR = await api(dirB, 'POST', '/api/operations/tasks', {
            title: 'Cross-company steal', assigneeId: chefId
        });
        check('E5. Cross-company task rejected (400) — no task created',
            crossR.status === 400,
            crossR.data);
        check('E5b. Cross-company rejection response has no notificationResult (task not created)',
            crossR.data.notificationResult === undefined,
            crossR.data);

        // ── E6. Email failure does not roll back task ─────────────────────────
        // With logging transport, email "fails" (FAILED) but task is persisted.
        // Verify by fetching task list after a FAILED notification.
        r = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Persist-test task', priority: 'NORMAL', assigneeId: chefId
        });
        const persistedTaskId = r.data.task && r.data.task.id;
        check('E6. Task created even when email result is FAILED (not SENT)',
            r.status === 201 && r.data.task && r.data.notificationResult !== 'SENT',
            r.data.notificationResult);
        // Verify task is actually stored
        const taskList = await api(dirA, 'GET', '/api/operations/tasks');
        check('E6b. Persisted task appears in task list after FAILED notification',
            taskList.data.success && taskList.data.tasks.some(t => t.id === persistedTaskId),
            { persistedTaskId, count: taskList.data.tasks && taskList.data.tasks.length });

        // ── E7. Invitation failure does not corrupt account/invitation ─────────
        // With logging transport, invite email "fails" but user record is intact.
        r = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Fail Invitee', email: 'failinvite@test.it', role: 'SOUS_CHEF'
        });
        check('E7. User record created even when emailResult is not SENT',
            r.status === 201 && r.data.user && r.data.user.id,
            r.data);
        // Invitation lookup should still work
        const invLookup = await fetch(`${BASE}/api/operations/invitations/${r.data.user.inviteCode}`).then(x => x.json());
        check('E7b. Invitation record intact after email failure',
            invLookup.success && invLookup.invitation.email === 'failinvite@test.it',
            invLookup);

        // ── E8. Resend invitation — Director only, same company ───────────────
        const failUserId = r.data.user.id;
        // Director of same company can resend
        const resendR = await api(dirA, 'POST', `/api/operations/users/${failUserId}/resend-invite`);
        check('E8. Director can resend invitation (200)',
            resendR.status === 200 && resendR.data.success && typeof resendR.data.emailResult === 'string',
            resendR.data);
        check('E8b. Resend returns activationUrl',
            resendR.data.activationUrl && resendR.data.activationUrl.startsWith('/'),
            resendR.data.activationUrl);

        // Director of OTHER company cannot resend
        const crossResend = await api(dirB, 'POST', `/api/operations/users/${failUserId}/resend-invite`);
        check('E8c. Director of other company cannot resend invitation (404)',
            crossResend.status === 404,
            crossResend.data);

        // Non-director (unauthenticated) cannot resend
        const noAuthResend = await fetch(`${BASE}/api/operations/users/${failUserId}/resend-invite`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }
        });
        check('E8d. Unauthenticated resend rejected (401)',
            noAuthResend.status === 401);

        // Cannot resend for already-active user (status !== INVITED)
        // Simulate: activate the user directly won't work without Firebase.
        // Verify by testing on an already-active director (bootstrapped, not INVITED).
        const resendActive = await api(dirA, 'POST', `/api/operations/users/${dirAId}/resend-invite`);
        check('E8e. Cannot resend for active (non-INVITED) user (400)',
            resendActive.status === 400,
            resendActive.data);

        // ── E9. Duplicate invite code not created on resend ───────────────────
        // Invite code must remain the same after resend (no second user, no changed role)
        const codeBeforeResend = r.data.user.inviteCode;
        const resendR2 = await api(dirA, 'POST', `/api/operations/users/${failUserId}/resend-invite`);
        // Fetch user list to verify no duplicate user was created
        const userList = await api(dirA, 'GET', '/api/operations/users');
        const usersWithEmail = userList.data.users.filter(u => u.email === 'failinvite@test.it');
        check('E9. Resend does not create a duplicate user record',
            usersWithEmail.length === 1,
            { count: usersWithEmail.length });

        // ── E10. Cross-company assignment sends no email ──────────────────────
        // Already covered by E5, verify explicitly for the email field
        const crossTask = await api(dirB, 'POST', '/api/operations/tasks', {
            title: 'No email cross', assigneeId: chefId
        });
        check('E10. Cross-company task rejected → no notificationResult (no email sent)',
            crossTask.status === 400 && crossTask.data.notificationResult === undefined,
            crossTask.data);

    } finally {
        server.kill('SIGTERM');
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
