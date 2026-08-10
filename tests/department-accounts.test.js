// tests/department-accounts.test.js — Security & DoD checks for Sprint S1.1
// Department Account model foundation.
//
// Spawns the real server with a known WS_SESSION_SECRET and an isolated
// DATA_DIR, signs session tokens directly (same HMAC scheme) and exercises
// the transitional Department Account APIs as multiple companies.
//
// Run: node tests/department-accounts.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = 'test-secret-for-deptacct-suite';
const PORT = 5099;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'deptaccttest-'));

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

function startServer() {
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT), WS_SESSION_SECRET: SECRET, DATA_DIR, FIREBASE_ADMIN_SERVICE_ACCOUNT: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
        server.stdout.on('data', d => { if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(server); } });
    });
}
function stopServer(server) {
    return new Promise(resolve => { server.on('exit', resolve); server.kill('SIGTERM'); setTimeout(resolve, 3000); });
}

async function main() {
    console.log('Starting server…');
    let server = await startServer();
    console.log('Server up. Running checks…\n');

    const userA = sign('uid-userA', 'company-a');
    const userB = sign('uid-userB', 'company-b');
    let deptA1, deptA2, deptB1, acct1;

    try {
        // ── Setup: departments per company ──
        let r = await api(userA, 'POST', '/api/departments', { name: 'Cucina' });
        deptA1 = r.data.department;
        r = await api(userA, 'POST', '/api/departments', { name: 'Bar' });
        deptA2 = r.data.department;
        r = await api(userB, 'POST', '/api/departments', { name: 'Pasticceria' });
        deptB1 = r.data.department;
        check('0. Setup: departments created', !!(deptA1 && deptA2 && deptB1));

        // ── Auth ──
        r = await api('garbage', 'GET', '/api/department-accounts');
        check('1. Invalid token rejected (401)', r.status === 401);

        // ── Creation for existing department ──
        r = await api(userA, 'POST', '/api/department-accounts', {
            departmentId: deptA1.id, displayName: 'Cucina Tablet', loginIdentifier: 'cucina@company-a'
        });
        acct1 = r.data.account;
        check('2. Account created for existing department', r.status === 201 && r.data.success === true);
        check('3. Account bound to one companyId + one departmentId',
            acct1 && acct1.companyId === 'company-a' && acct1.departmentId === deptA1.id);
        check('4. firebaseUid stays null', acct1 && acct1.firebaseUid === null);
        check('5. No plaintext password / hash / type / role fields on account',
            acct1 && !('password' in acct1) && !('passwordHash' in acct1) &&
            !('type' in acct1) && !('role' in acct1) && !('departmentType' in acct1) && !('isCentral' in acct1) && !('central' in acct1));

        // ── Cross-company department rejected ──
        r = await api(userA, 'POST', '/api/department-accounts', {
            departmentId: deptB1.id, displayName: 'Intruso', loginIdentifier: 'intruso@x'
        });
        check('6. Cross-company department rejected (404)', r.status === 404);

        // ── Duplicate ACTIVE per department rejected ──
        r = await api(userA, 'POST', '/api/department-accounts', {
            departmentId: deptA1.id, displayName: 'Cucina Bis', loginIdentifier: 'cucina2@company-a'
        });
        check('7. Second ACTIVE account for same department rejected (409)', r.status === 409);

        // ── Duplicate loginIdentifier rejected (cross-company too) ──
        r = await api(userB, 'POST', '/api/department-accounts', {
            departmentId: deptB1.id, displayName: 'Pasticceria', loginIdentifier: 'CUCINA@company-a'
        });
        check('8. Duplicate loginIdentifier rejected across companies (409)', r.status === 409);

        // ── Forged companyId in body ignored ──
        r = await api(userA, 'POST', '/api/department-accounts', {
            companyId: 'company-b', departmentId: deptA2.id, displayName: 'Bar Tablet', loginIdentifier: 'bar@company-a'
        });
        check('9. Forged companyId in body ignored — account lands in session company',
            r.status === 201 && r.data.account.companyId === 'company-a');

        // ── Company isolation on listing ──
        r = await api(userB, 'GET', '/api/department-accounts?companyId=company-a');
        check('10. Company B cannot read company A accounts (forged query ignored)',
            r.data.success === true && (r.data.accounts || []).every(a => a.companyId === 'company-b') &&
            (r.data.accounts || []).length === 0);
        r = await api(userA, 'GET', '/api/department-accounts');
        check('11. Company A sees exactly its own accounts', r.data.success === true && r.data.accounts.length === 2);

        // ── Status updates ──
        r = await api(userA, 'PUT', `/api/department-accounts/${acct1.id}/status`, { status: 'SUSPENDED' });
        check('12. Suspend works', r.data.success === true && r.data.account.status === 'SUSPENDED');
        r = await api(userA, 'PUT', `/api/department-accounts/${acct1.id}/status`, { status: 'DELETED' });
        check('13. Invalid status rejected (400)', r.status === 400);
        r = await api(userB, 'PUT', `/api/department-accounts/${acct1.id}/status`, { status: 'ACTIVE' });
        check('14. Company B cannot touch company A account (404)', r.status === 404);

        // Suspended dept can get a new ACTIVE account; then reactivation of the old one is blocked
        r = await api(userA, 'POST', '/api/department-accounts', {
            departmentId: deptA1.id, displayName: 'Cucina Nuovo', loginIdentifier: 'cucina-new@company-a'
        });
        check('15. New ACTIVE account allowed after suspension', r.status === 201);
        r = await api(userA, 'PUT', `/api/department-accounts/${acct1.id}/status`, { status: 'ACTIVE' });
        check('16. Reactivation blocked while another ACTIVE exists (409)', r.status === 409);

        // ── departmentType ──
        r = await api(userA, 'GET', '/api/departments');
        check('17. Existing departments carry no CENTRAL meaning (absent = STANDARD)',
            r.data.departments.every(d => d.departmentType === undefined || d.departmentType === 'STANDARD'));

        r = await api(userA, 'PUT', `/api/departments/${deptA1.id}/type`, { departmentType: 'CENTRAL' });
        check('18. Department set to CENTRAL', r.data.success === true && r.data.department.departmentType === 'CENTRAL');
        r = await api(userA, 'PUT', `/api/departments/${deptA2.id}/type`, { departmentType: 'CENTRAL' });
        check('19. Second CENTRAL rejected until first reverted (409)', r.status === 409);
        r = await api(userA, 'PUT', `/api/departments/${deptA1.id}/type`, { departmentType: 'STANDARD' });
        check('20. Revert to STANDARD works', r.data.success === true && r.data.department.departmentType === 'STANDARD');
        r = await api(userA, 'PUT', `/api/departments/${deptA2.id}/type`, { departmentType: 'CENTRAL' });
        check('21. CENTRAL allowed after revert', r.data.success === true);
        r = await api(userA, 'PUT', `/api/departments/${deptA1.id}/type`, { departmentType: 'central' });
        check('22. Invalid departmentType value rejected (400)', r.status === 400);
        r = await api(userA, 'PUT', `/api/departments/${deptA1.id}/type`, { departmentType: 'MAIN' });
        check('23. Unknown departmentType rejected (400)', r.status === 400);
        r = await api(userB, 'PUT', `/api/departments/${deptA1.id}/type`, { departmentType: 'CENTRAL' });
        check('24. Cross-company type change rejected (404)', r.status === 404);
        // Company B can have its OWN central — uniqueness is per company
        r = await api(userB, 'PUT', `/api/departments/${deptB1.id}/type`, { departmentType: 'CENTRAL' });
        check('25. CENTRAL uniqueness is per company, not global', r.data.success === true);

        // Type lives only on the department, never on accounts
        r = await api(userA, 'GET', '/api/department-accounts');
        check('26. Accounts carry no type data even when their department is CENTRAL',
            r.data.accounts.every(a => !('departmentType' in a) && !('type' in a) && !('role' in a)));

        // Department names carry no authorization meaning — a dept named
        // "Central" / "Sala" is STANDARD unless explicitly set otherwise.
        r = await api(userA, 'POST', '/api/departments', { name: 'Central' });
        const namedCentral = r.data.department;
        check('27. Department named "Central" is still STANDARD',
            namedCentral && (namedCentral.departmentType === undefined || namedCentral.departmentType === 'STANDARD'));

        // ── Referential integrity: department lifecycle vs accounts ──
        const grill = namedCentral; // reuse (base plan allows max 3 active departments)
        r = await api(userA, 'POST', '/api/department-accounts', {
            departmentId: grill.id, displayName: 'Grill Tablet', loginIdentifier: 'grill@company-a'
        });
        const grillAcct = r.data.account;
        r = await api(userA, 'DELETE', `/api/departments/${grill.id}`);
        check('32. Department with bound account cannot be deleted (409)', r.status === 409);
        r = await api(userA, 'PUT', `/api/departments/${grill.id}`, { active: false });
        check('33. Department deactivation succeeds', r.data.success === true);
        r = await api(userA, 'GET', '/api/department-accounts');
        const grillAfter = r.data.accounts.find(a => a.id === grillAcct.id);
        check('34. ACTIVE account auto-suspended when its department is deactivated',
            grillAfter && grillAfter.status === 'SUSPENDED');
        r = await api(userA, 'PUT', `/api/department-accounts/${grillAcct.id}/status`, { status: 'ACTIVE' });
        check('35. Reactivating account blocked while department inactive (409)', r.status === 409);
        r = await api(userA, 'PUT', `/api/departments/${grill.id}`, { active: true });
        r = await api(userA, 'PUT', `/api/department-accounts/${grillAcct.id}/status`, { status: 'ACTIVE' });
        check('36. Account reactivation allowed after department reactivated', r.data.success === true);
        r = await api(userA, 'DELETE', `/api/departments/${grill.id}`);
        check('37. Deletion still blocked even with suspended/active account history (409)', r.status === 409);

        // ── Persistence across restart ──
        console.log('\nRestarting server to verify persistence…');
        await stopServer(server);
        server = await startServer();

        r = await api(userA, 'GET', '/api/department-accounts');
        check('28. Department accounts survive restart', r.data.success === true && r.data.accounts.length === 4);
        const restored = r.data.accounts.find(a => a.id === acct1.id);
        check('29. SUSPENDED status persists across restart', restored && restored.status === 'SUSPENDED');
        r = await api(userA, 'GET', '/api/departments');
        const a2 = r.data.departments.find(d => d.id === deptA2.id);
        check('30. departmentType persists across restart', a2 && a2.departmentType === 'CENTRAL');

        // Stored file must never contain password material
        const raw = fs.readFileSync(path.join(DATA_DIR, 'department-accounts.json'), 'utf8');
        check('31. Persisted store contains no password fields', !/password/i.test(raw));

    } finally {
        await stopServer(server);
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
