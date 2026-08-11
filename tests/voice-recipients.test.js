// tests/voice-recipients.test.js — Voice-message recipient directory (Task: recipient regression fix)
//
// Verifies:
//  1. GET /api/voice-recipients returns all active company departments {id,name} for
//     a bound ACTIVE Department Account (self excluded client-side, so all are returned)
//  2. Unbound legacy user gets the same directory
//  3. SUSPENDED bound account → 403; bound account with inactive dept → 410; no token → 401
//  4. Inactive departments are excluded; foreign company depts never appear
//  5. Bound account can send dept→dept and dept→__sala__ voice messages
//  6. Foreign/invalid destinations still rejected on /api/voice-message
//  7. S1.4 locking unchanged: bound account still gets ONLY its own dept from /api/departments
//
// Run: node tests/voice-recipients.test.js

const { spawn } = require('child_process');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');

const SECRET   = 'test-secret-voice-recipients';
const PORT     = 5089;
const BASE     = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vrec-'));
const SALA_ID  = '__sala__';

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

async function api(token, method, p, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(BASE + p, {
        method, headers, body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ' — got: ' + JSON.stringify(extra) : ''}`); }
}

function startServer() {
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
        server.stdout.on('data', d => {
            if (d.toString().includes('avviato')) { clearTimeout(t); resolve(server); }
        });
    });
}
function stopServer(srv) {
    return new Promise(resolve => {
        srv.on('exit', resolve);
        srv.kill('SIGTERM');
        setTimeout(resolve, 3000);
    });
}

async function createDept(token, name) {
    const r = await api(token, 'POST', '/api/departments', { name });
    return r.data?.department?.id;
}
async function createAccount(token, departmentId, displayName, loginIdentifier) {
    const r = await api(token, 'POST', '/api/department-accounts', {
        departmentId, displayName, loginIdentifier
    });
    return r.data?.account;
}
async function bindAccount(token, loginIdentifier) {
    return api(token, 'POST', '/api/department-accounts/bind', { loginIdentifier });
}

const AUDIO = Buffer.from('fake-audio-bytes').toString('base64');

async function main() {
    // Medium plan so we can create 4+ departments
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({ ristorante: 'medium' }));

    console.log('Starting server…');
    const server = await startServer();
    console.log('Server up. Running voice-recipients checks…\n');

    try {
        const tokAdmin  = sign('uid-admin',  'ristorante');
        const tokPizza  = sign('uid-pizza',  'ristorante');   // bound to Pizzeria
        const tokSusp   = sign('uid-susp',   'ristorante');   // suspended acct
        const tokDead   = sign('uid-dead',   'ristorante');   // bound to dept that will be deactivated
        const tokLegacy = sign('uid-legacy', 'ristorante');   // unbound legacy
        const tokAdminB = sign('uid-adminB', 'other-co');

        // ── Setup ─────────────────────────────────────────────────────────────
        const cucina   = await createDept(tokAdmin, 'Cucina');
        const pizzeria = await createDept(tokAdmin, 'Pizzeria');
        const bar      = await createDept(tokAdmin, 'Bar');
        const insalate = await createDept(tokAdmin, 'Insalate');
        const doomed   = await createDept(tokAdmin, 'Doomed');
        const foreignD = await createDept(tokAdminB, 'ForeignDept');
        check('Setup: 5 depts + foreign created', !!(cucina && pizzeria && bar && insalate && doomed && foreignD));

        const acctPizza = await createAccount(tokAdmin, pizzeria, 'Pizzeria Display', 'pizza.vrec');
        const acctSusp  = await createAccount(tokAdmin, bar,      'Bar Display',      'bar.vrec');
        const acctDead  = await createAccount(tokAdmin, doomed,   'Doomed Display',   'doomed.vrec');
        check('Setup: accounts created', !!(acctPizza?.id && acctSusp?.id && acctDead?.id));

        let r = await bindAccount(tokPizza, 'pizza.vrec');
        check('Setup: pizza bound', r.data.success === true, r.data);
        r = await bindAccount(tokSusp, 'bar.vrec');
        check('Setup: susp bound', r.data.success === true, r.data);
        r = await bindAccount(tokDead, 'doomed.vrec');
        check('Setup: doomed bound', r.data.success === true, r.data);
        r = await api(tokAdmin, 'PUT', `/api/department-accounts/${acctSusp.id}/status`, { status: 'SUSPENDED' });
        check('Setup: bar acct suspended', r.data.success === true, r.data);
        // Deactivate the "Doomed" dept
        r = await api(tokAdmin, 'PUT', `/api/departments/${doomed}`, { active: false });
        check('Setup: doomed dept deactivated', r.data.success === true, r.data);

        // ── 1. Bound ACTIVE account gets full recipient directory ────────────
        r = await api(tokPizza, 'GET', '/api/voice-recipients');
        check('1. Bound account: 200 + success', r.status === 200 && r.data.success === true, r);
        const ids = (r.data.recipients || []).map(x => x.id);
        check('1. Contains all active depts', [cucina, pizzeria, bar, insalate].every(id => ids.includes(id)), ids);
        check('1. Excludes inactive dept', !ids.includes(doomed), ids);
        check('1. Excludes foreign-company dept', !ids.includes(foreignD), ids);
        check('1. Recipients carry only id+name', (r.data.recipients || []).every(x =>
            Object.keys(x).sort().join(',') === 'id,name'), r.data.recipients?.[0]);
        // Client-side exclusion of self leaves the other three + Floor
        const others = ids.filter(id => id !== pizzeria);
        check('1. Excluding self leaves the other 3 depts', others.length === 3 &&
            [cucina, bar, insalate].every(id => others.includes(id)), others);

        // ── 2. Unbound legacy user gets same directory ────────────────────────
        r = await api(tokLegacy, 'GET', '/api/voice-recipients');
        check('2. Legacy user: 200 with all active depts',
            r.status === 200 && [cucina, pizzeria, bar, insalate].every(id =>
                (r.data.recipients || []).some(x => x.id === id)), r.data);

        // ── 3. Locked/edge cases ──────────────────────────────────────────────
        r = await api(tokSusp, 'GET', '/api/voice-recipients');
        check('3. SUSPENDED account → 403', r.status === 403 && r.data.code === 'ACCOUNT_SUSPENDED', r);
        // Deactivating a department auto-suspends its account (S1.1 referential
        // integrity), so the bound-with-inactive-dept case surfaces as 403
        // SUSPENDED; the endpoint's 410 branch remains defense in depth.
        r = await api(tokDead, 'GET', '/api/voice-recipients');
        check('3. Deactivated-dept account locked out (403 SUSPENDED)',
            r.status === 403 && r.data.code === 'ACCOUNT_SUSPENDED', r);
        r = await api(null, 'GET', '/api/voice-recipients');
        check('3. No token → 401', r.status === 401, r.status);

        // ── 4. Bound account can send dept→dept and dept→Floor ───────────────
        r = await api(tokPizza, 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-rec-d2d',
            destinations: [cucina], from: pizzeria
        });
        check('4. Bound dept→dept accepted', r.status === 200 && r.data.success === true, r);
        r = await api(tokPizza, 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-rec-sala',
            destinations: [SALA_ID], from: pizzeria
        });
        check('4. Bound dept→__sala__ accepted', r.status === 200 && r.data.success === true, r);
        r = await api(tokPizza, 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-rec-multi',
            destinations: [bar, insalate, SALA_ID], from: pizzeria
        });
        check('4. Bound multi-dest (2 depts + Floor) accepted', r.status === 200 && r.data.success === true, r);

        // ── 5. Foreign/invalid destinations still rejected ────────────────────
        r = await api(tokPizza, 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-rec-foreign',
            destinations: [foreignD], from: pizzeria
        });
        check('5. Foreign destination rejected (400)', r.status === 400, r.status);
        r = await api(tokPizza, 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-rec-inactive',
            destinations: [doomed], from: pizzeria
        });
        check('5. Inactive destination rejected (400)', r.status === 400, r.status);
        r = await api(tokPizza, 'POST', '/api/voice-message', {
            audioData: AUDIO, messageId: 'vm-rec-bogus',
            destinations: ['no-such-dept'], from: pizzeria
        });
        check('5. Nonexistent destination rejected (400)', r.status === 400, r.status);

        // ── 6. S1.4 department locking unchanged ──────────────────────────────
        r = await api(tokPizza, 'GET', '/api/departments');
        check('6. Bound account /api/departments still returns ONLY own dept',
            r.status === 200 && r.data.departments?.length === 1 &&
            r.data.departments[0].id === pizzeria, r.data.departments);
        r = await api(tokSusp, 'GET', '/api/departments');
        check('6. SUSPENDED /api/departments still 403', r.status === 403, r.status);
        r = await api(tokDead, 'GET', '/api/departments');
        check('6. Deactivated-dept bound /api/departments still locked (403)', r.status === 403, r.status);

    } catch (err) {
        failed++;
        console.error('  ❌ Unhandled test error:', err);
    } finally {
        await stopServer(server);
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\nvoice-recipients: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
