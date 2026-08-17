// tests/operations-activation-login.test.js
//
// Covers: activation binding + status transition, idempotent activation retry,
// ops-only login via /api/auth/session (no Service users/{uid} doc), role
// resolution for all 4 non-director roles, suspended/archived/invalid rejection,
// cross-tenant isolation, unchanged Service login, and the Director-only
// repair-binding endpoint (dry-run, execute, idempotency, safety refusals).
//
// Key behaviour change from the original bug fix:
//   emailVerified is NOT required for activation — the invite code is the
//   security proof. Activation must succeed with emailVerified:false.
//
// Uses TEST_FIREBASE_AUTH_MOCK=1: "mockfb.<base64 JSON>" tokens are decoded
// locally by the server, so no real Firebase accounts are needed.
//
// Run: node tests/operations-activation-login.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = 'test-secret-task44';
const PORT = 5084;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'opstest44-'));

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({ uid, companyName, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
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
        env: {
            ...process.env, PORT: String(PORT), WS_SESSION_SECRET: SECRET, DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '', TEST_FIREBASE_AUTH_MOCK: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
        server.stdout.on('data', d => { if (d.toString().includes('avviato')) { clearTimeout(t); resolve(); } });
    });
    console.log('Server up. Running checks…\n');

    try {
        // ── Setup: bootstrap Director A + Director B (separate companies) ──
        const dirA = sign('uid-dirA', 'company-a');
        const dirB = sign('uid-dirB', 'company-b');
        let r = await api(dirA, 'GET', '/api/operations/me?name=Anna');
        check('setup: company A director bootstrapped', r.data.success && r.data.user.role === 'DIRECTOR');
        await api(dirB, 'GET', '/api/operations/me?name=Bruno');

        async function invite(token, name, email, role) {
            const res = await api(token, 'POST', '/api/operations/users', { name, email, role });
            return res.data.user;
        }

        // ═══ 1. Activation binding & status transition ═══
        console.log('── Activation binding ──');

        // 1.1 — invitation created correctly
        const inv1 = await invite(dirA, 'Sofia Sous', 'sofia@a.test', 'SOUS_CHEF');
        check('1.1 invited record created INVITED with invite code', inv1 && inv1.status === 'INVITED' && inv1.inviteCode);

        // 1.2 — wrong email rejected (403) — email match is the security check
        r = await api(mockFb({ localId: 'uid-evil', email: 'evil@x.test', emailVerified: true }), 'POST', '/api/operations/activate', { code: inv1.inviteCode });
        check('1.2 mismatched email rejected 403', r.status === 403, r);

        // 1.3 — invalid (missing) invite code rejected (400)
        r = await api(mockFb({ localId: 'uid-sofia', email: 'sofia@a.test', emailVerified: false }), 'POST', '/api/operations/activate', { code: '' });
        check('1.3 missing invite code rejected 400', r.status === 400, r);

        // 1.4 — nonexistent invite code rejected (404)
        r = await api(mockFb({ localId: 'uid-sofia', email: 'sofia@a.test', emailVerified: false }), 'POST', '/api/operations/activate', { code: 'deadbeefdeadbeefdeadbeefdeadbeef' });
        check('1.4 nonexistent invite code rejected 404', r.status === 404, r);

        // 1.5 — invalid Firebase token rejected (401)
        r = await api('mockfb.not-base64!!!', 'POST', '/api/operations/activate', { code: inv1.inviteCode });
        check('1.5 invalid firebase token rejected 401', r.status === 401, r);

        // 1.6 — unverified email NOW SUCCEEDS (root-cause fix: emailVerified not required)
        // This is the Director-link flow: invite code is the security proof, not email verification.
        r = await api(mockFb({ localId: 'uid-sofia', email: 'sofia@a.test', emailVerified: false }), 'POST', '/api/operations/activate', { code: inv1.inviteCode });
        check('1.6 activation succeeds with emailVerified:false (invite-code flow)', r.data.success && r.data.companyId === 'company-a' && r.data.role === 'SOUS_CHEF', r);

        // 1.7 — record is now ACTIVE with uid bound
        r = await api(dirA, 'GET', '/api/operations/users?status=all');
        const sofia = r.data.users.find(u => u.email === 'sofia@a.test');
        check('1.7 record now ACTIVE with bound uid', sofia && sofia.status === 'ACTIVE' && sofia.hasFirebaseAccount === true, sofia);

        // 1.8 — binding persisted to datastore file
        const persisted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ops-users.json'), 'utf8'));
        const sofiaP = persisted['company-a'].find(u => u.email === 'sofia@a.test');
        check('1.8 binding persisted to datastore (uid bound, ACTIVE, inviteCode removed)', sofiaP && sofiaP.uid === 'uid-sofia' && sofiaP.status === 'ACTIVE' && !sofiaP.inviteCode, sofiaP);

        // 1.9 — idempotent retry: same uid, consumed code → alreadyActive success
        // Works even with emailVerified:false on the retry token.
        r = await api(mockFb({ localId: 'uid-sofia', email: 'sofia@a.test', emailVerified: false }), 'POST', '/api/operations/activate', { code: inv1.inviteCode });
        check('1.9 activation retry idempotent success (emailVerified:false ok on retry)', r.data.success && r.data.alreadyActive === true, r);

        // 1.10 — different uid using the consumed code → 404
        r = await api(mockFb({ localId: 'uid-other', email: 'sofia@a.test', emailVerified: true }), 'POST', '/api/operations/activate', { code: inv1.inviteCode });
        check('1.10 consumed code rejected for different uid (404)', r.status === 404, r);

        // 1.11 — activation request must carry a valid Firebase ID token (no token → 401)
        r = await fetch(BASE + '/api/operations/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: inv1.inviteCode })
        });
        check('1.11 no Authorization header rejected 401', r.status === 401, null);

        // ═══ 2. Ops-only login via /api/auth/session (no Service doc) ═══
        console.log('── Ops-only session exchange ──');
        // Session exchange works regardless of emailVerified on the token.
        r = await api(mockFb({ localId: 'uid-sofia', email: 'sofia@a.test', emailVerified: false }), 'POST', '/api/auth/session');
        check('2.1 ops-only session issued (emailVerified:false)', r.status === 200 && r.data.success && r.data.token, r);
        check('2.2 isOperations flag + role + company from server record', r.data.isOperations === true && r.data.opsRole === 'SOUS_CHEF' && r.data.companyName === 'company-a', r.data);
        const sofiaToken = r.data.token;
        r = await api(sofiaToken, 'GET', '/api/operations/me');
        check('2.3 /api/operations/me works with issued token', r.data.success && r.data.user.role === 'SOUS_CHEF' && r.data.companyId === 'company-a', r.data);

        // 2.4 — session immediately resolves after activation (no extra step required)
        const invNew = await invite(dirA, 'Pronto Pronto', 'pronto@a.test', 'ADJOINT');
        r = await api(mockFb({ localId: 'uid-pronto', email: 'pronto@a.test', emailVerified: false }), 'POST', '/api/operations/activate', { code: invNew.inviteCode });
        check('2.4 activation returns success', r.data.success === true, r);
        const sessNew = await api(mockFb({ localId: 'uid-pronto', email: 'pronto@a.test', emailVerified: false }), 'POST', '/api/auth/session');
        check('2.5 session immediately resolves the newly activated account', sessNew.status === 200 && sessNew.data.isOperations === true && sessNew.data.opsRole === 'ADJOINT', sessNew.data);

        // ═══ 3. Role routing data for all 4 non-director roles ═══
        console.log('── Role resolution (all non-director roles) ──');
        const roles = ['CHEF_CUISINE', 'ADJOINT', 'CHEF_DE_BRIGADE', 'SOUS_CHEF'];
        for (const role of roles) {
            const email = role.toLowerCase().replace(/_/g, '') + '@a.test';
            const uid = 'uid-' + role.toLowerCase();
            const inv = await invite(dirA, role + ' Person', email, role);
            r = await api(mockFb({ localId: uid, email, emailVerified: false }), 'POST', '/api/operations/activate', { code: inv.inviteCode });
            const sess = await api(mockFb({ localId: uid, email, emailVerified: false }), 'POST', '/api/auth/session');
            const me = await api(sess.data.token, 'GET', '/api/operations/me');
            check(`3.x ${role} activates + logs in + resolves role`, r.data.success && sess.data.opsRole === role && me.data.user.role === role, { r: r.data, sess: sess.data });
        }

        // ═══ 4. Rejections: suspended / archived / unrelated / cross-tenant ═══
        console.log('── Rejections & isolation ──');
        r = await api(dirA, 'GET', '/api/operations/users?status=all');
        const sofiaId = r.data.users.find(u => u.email === 'sofia@a.test').id;
        await api(dirA, 'POST', `/api/operations/users/${sofiaId}/suspend`);
        r = await api(sofiaToken, 'GET', '/api/operations/me');
        check('4.1 suspended ops user denied on ops API (403)', r.status === 403, r);
        r = await api(mockFb({ localId: 'uid-sofia', email: 'sofia@a.test', emailVerified: false }), 'POST', '/api/auth/session');
        check('4.2 suspended ops-only user denied session (403, no isOperations)', r.status === 403, r);
        await api(dirA, 'POST', `/api/operations/users/${sofiaId}/reactivate`);

        // archived
        const invArch = await invite(dirA, 'Archie', 'archie@a.test', 'CHEF_DE_BRIGADE');
        await api(mockFb({ localId: 'uid-archie', email: 'archie@a.test', emailVerified: false }), 'POST', '/api/operations/activate', { code: invArch.inviteCode });
        r = await api(dirA, 'GET', '/api/operations/users?status=all');
        const archieId = r.data.users.find(u => u.email === 'archie@a.test').id;
        await api(dirA, 'POST', `/api/operations/users/${archieId}/archive`);
        r = await api(mockFb({ localId: 'uid-archie', email: 'archie@a.test', emailVerified: false }), 'POST', '/api/auth/session');
        check('4.3 archived ops-only user denied session (403)', r.status === 403, r);

        // unrelated firebase user (no ops record, no service company) → 403
        r = await api(mockFb({ localId: 'uid-nobody', email: 'nobody@x.test', emailVerified: false }), 'POST', '/api/auth/session');
        check('4.4 unrelated firebase user denied session (403)', r.status === 403, r);

        // cross-tenant: company-a invite code cannot be used by a company-b email address
        // (the email match check enforces this — company-b user emails won't match company-a invites)
        const invXA = await invite(dirA, 'Cross Test', 'cross@a.test', 'SOUS_CHEF');
        r = await api(mockFb({ localId: 'uid-cross-b', email: 'beppe@b.test', emailVerified: true }), 'POST', '/api/operations/activate', { code: invXA.inviteCode });
        check('4.5 cross-tenant: company-B email rejected against company-A invite (403)', r.status === 403, r);

        // company-b members are bound to company-b only
        const invB = await invite(dirB, 'Beppe B', 'beppe@b.test', 'CHEF_CUISINE');
        await api(mockFb({ localId: 'uid-beppe', email: 'beppe@b.test', emailVerified: false }), 'POST', '/api/operations/activate', { code: invB.inviteCode });
        const sessB = await api(mockFb({ localId: 'uid-beppe', email: 'beppe@b.test', emailVerified: false }), 'POST', '/api/auth/session');
        check('4.6 company-b user bound to company-b only', sessB.data.companyName === 'company-b', sessB.data);
        const meCC = await api(sessB.data.token, 'GET', '/api/operations/assignees');
        const emails = (meCC.data.assignees || []).map(u => u.email);
        check('4.7 cross-tenant isolation: no company-a members visible to company-b user', !emails.includes('sofia@a.test'), emails);
        // forged session with company-a name but company-b ops uid still resolves company-b (server record authoritative)
        const forgedCompany = sign('uid-beppe', 'company-a');
        r = await api(forgedCompany, 'GET', '/api/operations/me');
        check('4.8 ops company from server record, not token claim', r.data.success && r.data.companyId === 'company-b', r.data);

        // ═══ 5. Service login unchanged ═══
        console.log('── Service login unchanged ──');
        r = await api(mockFb({ localId: 'uid-service', email: 'svc@x.test', emailVerified: true, company: 'Ristorante Sole' }), 'POST', '/api/auth/session');
        check('5.1 Service user (Firestore company) still gets session', r.status === 200 && r.data.success && r.data.companyName === 'ristorante sole', r.data);
        check('5.2 Service session has no isOperations flag', r.data.isOperations === undefined, r.data);

        // ═══ 6. Repair endpoint (repair-binding retains emailVerified requirement) ═══
        console.log('── Repair binding ──');
        const invStuck = await invite(dirA, 'Stucco', 'stuck@a.test', 'ADJOINT');
        r = await api(dirA, 'GET', '/api/operations/users?status=all');
        const stuckId = r.data.users.find(u => u.email === 'stuck@a.test').id;

        // no firebase account yet → 404
        r = await api(dirA, 'POST', `/api/operations/users/${stuckId}/repair-binding`, { dryRun: true });
        check('6.1 no firebase match → 404', r.status === 404, r);

        // add mock firebase directory: unverified first — repair still requires verified
        const mockFile = path.join(DATA_DIR, 'mock-firebase-users.json');
        fs.writeFileSync(mockFile, JSON.stringify([{ localId: 'uid-stuck', email: 'stuck@a.test', emailVerified: false }]));
        r = await api(dirA, 'POST', `/api/operations/users/${stuckId}/repair-binding`, { dryRun: true });
        check('6.2 repair requires emailVerified (403 for unverified)', r.status === 403, r);

        // verified → dryRun reports match without writing
        fs.writeFileSync(mockFile, JSON.stringify([{ localId: 'uid-stuck', email: 'stuck@a.test', emailVerified: true }]));
        r = await api(dirA, 'POST', `/api/operations/users/${stuckId}/repair-binding`, { dryRun: true });
        check('6.3 dryRun reports repairNeeded without writing', r.data.success && r.data.dryRun === true && r.data.repairNeeded === true, r);
        let store = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ops-users.json'), 'utf8'));
        let stuckRec = store['company-a'].find(u => u.email === 'stuck@a.test');
        check('6.4 dryRun did not modify record', stuckRec.status === 'INVITED' && stuckRec.uid === null, stuckRec);

        // non-director cannot repair
        r = await api(sofiaToken, 'POST', `/api/operations/users/${stuckId}/repair-binding`, {});
        check('6.5 non-director refused (403)', r.status === 403, r);

        // execute repair
        r = await api(dirA, 'POST', `/api/operations/users/${stuckId}/repair-binding`, {});
        check('6.6 repair binds uid and activates', r.data.success && r.data.repaired === true && r.data.user.status === 'ACTIVE', r);
        store = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ops-users.json'), 'utf8'));
        stuckRec = store['company-a'].find(u => u.email === 'stuck@a.test');
        check('6.7 repair persisted (uid bound, ACTIVE, code removed)', stuckRec.uid === 'uid-stuck' && stuckRec.status === 'ACTIVE' && !stuckRec.inviteCode, stuckRec);

        // idempotent re-run
        r = await api(dirA, 'POST', `/api/operations/users/${stuckId}/repair-binding`, {});
        check('6.8 repair idempotent (alreadyBound)', r.data.success && r.data.alreadyBound === true, r);

        // repaired user can now log in
        r = await api(mockFb({ localId: 'uid-stuck', email: 'stuck@a.test', emailVerified: true }), 'POST', '/api/auth/session');
        check('6.9 repaired user logs in as Operations', r.data.success && r.data.isOperations === true && r.data.opsRole === 'ADJOINT', r.data);

        // ambiguous: uid already bound elsewhere → 409
        const invDup = await invite(dirA, 'Dup', 'dup@a.test', 'SOUS_CHEF');
        r = await api(dirA, 'GET', '/api/operations/users?status=all');
        const dupId = r.data.users.find(u => u.email === 'dup@a.test').id;
        fs.writeFileSync(mockFile, JSON.stringify([{ localId: 'uid-stuck', email: 'dup@a.test', emailVerified: true }]));
        r = await api(dirA, 'POST', `/api/operations/users/${dupId}/repair-binding`, {});
        check('6.10 uid already bound elsewhere → 409 refused', r.status === 409, r);

        // ═══ 7. Client routing contract (browser flow) ═══
        // The pages must route on the server-authoritative isOperations/opsRole
        // flags and must NOT gate Operations routing on the presence of a
        // Firestore users/{uid} Service document.
        console.log('── Client routing contract ──');
        const homeHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'home.html'), 'utf8');
        const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

        check('7.1 home.html routes to operations.html on isOperations (non-director)',
            /sessData\.isOperations\s*&&\s*sessData\.opsRole\s*!==\s*'DIRECTOR'/.test(homeHtml)
            && homeHtml.includes("window.location.href = 'operations.html'"), null);
        check('7.2 home.html performs the session exchange before the Firestore doc check',
            homeHtml.indexOf("fetch('/api/auth/session'") < homeHtml.indexOf('doc(db, "users", user.uid)'), null);
        check('7.3 home.html no longer treats a missing users/{uid} doc as fatal when a server session exists',
            homeHtml.includes('identità risolta dal server'), null);
        check('7.4 index.html routes to /operations.html on isOperations (non-director), independent of Service doc',
            /sessionData\.isOperations\s*&&\s*sessionData\.opsRole\s*!==\s*'DIRECTOR'/.test(indexHtml)
            && indexHtml.includes("redirectTarget = '/operations.html'"), null);
        check('7.5 index.html Operations routing not gated on doc absence',
            !/isOperations\s*&&\s*!userDoc\.exists\(\)/.test(indexHtml), null);
        check('7.6 index.html no longer falls back to email prefix as company',
            !indexHtml.includes("user.email.split('@')[0]"), null);

        // 7.7 — activation page: showVerifyStep dead-UI is fully removed (was unreachable in normal flow)
        const activateHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'operations-activate.html'), 'utf8');
        check('7.7 activation page does not define showVerifyStep (dead UI removed)',
            !activateHtml.includes('showVerifyStep'), null);
        // 7.8 — duplicate Firebase verification email removed: sendEmailVerification must NOT appear
        check('7.8 activation page does NOT call sendEmailVerification (duplicate email fix)',
            !activateHtml.includes('sendEmailVerification'), null);

        // Server contract: activated user WITH a Service profile document still gets
        // isOperations + opsRole → client reaches operations.html.
        r = await api(mockFb({ localId: 'uid-sofia', email: 'sofia@a.test', emailVerified: false }), 'POST', '/api/auth/session');
        check('7.9 activated user session carries opsRole for role routing', r.data.isOperations === true && r.data.opsRole === 'SOUS_CHEF', r.data);
        // Repaired user with Firestore company: ops record wins, isOperations present.
        r = await api(mockFb({ localId: 'uid-stuck', email: 'stuck@a.test', emailVerified: true, company: 'Own Personal Co' }), 'POST', '/api/auth/session');
        check('7.10 repaired user with Service company still flagged isOperations + ops company authoritative',
            r.data.isOperations === true && r.data.opsRole === 'ADJOINT' && r.data.companyName === 'company-a', r.data);

    } catch (e) {
        failed++;
        console.error('❌ Test suite error:', e);
    } finally {
        server.kill();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main();
