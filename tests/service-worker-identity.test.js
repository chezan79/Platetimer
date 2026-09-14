'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 5089;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'service-worker-identity-test-secret';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'service-worker-'));
let passed = 0;
let failed = 0;

function check(name, condition, extra) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        console.error(`  ❌ ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
    }
}

function sign(uid, companyName, authSource = 'ops-bootstrap') {
    const encoded = Buffer.from(JSON.stringify({
        uid, companyName, authSource, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const signature = crypto.createHmac('sha256', SECRET).update(encoded).digest('hex');
    return `${encoded}.${signature}`;
}

async function api(token, method, route, body, workerProof, ip) {
    const response = await fetch(BASE + route, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(workerProof ? { 'X-Worker-Proof': workerProof } : {}),
            ...(ip ? { 'X-Forwarded-For': ip } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
        status: response.status,
        headers: response.headers,
        data: await response.json().catch(() => ({}))
    };
}

async function login(loginIdentifier, password) {
    const response = await fetch(BASE + '/api/service/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginIdentifier, password })
    });
    return { status: response.status, data: await response.json() };
}

async function startServer() {
    const child = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            DATA_DIR,
            WS_SESSION_SECRET: SECRET,
            SESSION_SECRET: 'worker-pin-pepper-for-tests',
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            RESEND_API_KEY: '',
            SMTP_HOST: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('server start timeout')), 15000);
        const ready = chunk => {
            if (String(chunk).includes('Server avviato')) {
                clearTimeout(timeout);
                resolve();
            }
        };
        child.stdout.on('data', ready);
        child.stderr.on('data', ready);
        child.once('exit', code => reject(new Error(`server exited early (${code})`)));
    });
    return child;
}

async function createDepartment(adminToken, name) {
    const response = await api(adminToken, 'POST', '/api/departments', { name });
    if (response.status !== 201) throw new Error(JSON.stringify(response.data));
    return response.data.department;
}

async function createAccount(adminToken, departmentId, loginIdentifier) {
    const response = await api(adminToken, 'POST', '/api/department-accounts', {
        departmentId, loginIdentifier, password: 'device-password'
    });
    if (response.status !== 201) throw new Error(JSON.stringify(response.data));
    return response.data.account;
}

async function createWorker(adminToken, displayName, pin, departmentIds, operationsUserId) {
    return api(adminToken, 'POST', '/api/service/workers', {
        displayName,
        pin,
        departmentMemberships: departmentIds,
        ...(operationsUserId ? { operationsUserId } : {})
    });
}

async function run() {
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({
        'company-a': 'medium',
        'company-b': 'medium'
    }));
    const server = await startServer();
    try {
        const adminA = sign('uid-director-a', 'company-a');
        const adminB = sign('uid-director-b', 'company-b');
        let response = await api(adminA, 'GET', '/api/operations/me?name=Director%20A');
        const opsAId = response.data.user.id;
        response = await api(adminB, 'GET', '/api/operations/me?name=Director%20B');
        const opsBId = response.data.user.id;

        const deptA1 = await createDepartment(adminA, 'Kitchen A1');
        const deptA2 = await createDepartment(adminA, 'Kitchen A2');
        const deptB = await createDepartment(adminB, 'Kitchen B');
        await createAccount(adminA, deptA1.id, 'device-a1');
        await createAccount(adminA, deptA2.id, 'device-a2');
        await createAccount(adminB, deptB.id, 'device-b');

        response = await createWorker(adminA, 'Weak PIN', '1234', [deptA1.id]);
        check('weak PIN is rejected', response.status === 400);

        response = await createWorker(adminA, 'Alice', '7392', [deptA1.id], opsAId);
        check('Director creates a company worker', response.status === 201, response.data);
        const alice = response.data.worker;
        check('worker response never exposes verifier secrets',
            !JSON.stringify(response.data).includes('secretHash') &&
            !JSON.stringify(response.data).includes('"salt"'));

        response = await createWorker(adminA, 'Duplicate link', '8462', [deptA1.id], opsAId);
        check('Operations link is unique', response.status === 409);
        response = await api(adminA, 'PUT', `/api/service/workers/${alice.id}/operations-link`,
            { operationsUserId: opsBId });
        check('cross-company Operations link is rejected', response.status === 404 || response.status === 409);

        response = await api(adminB, 'GET', '/api/service/workers');
        check('other companies cannot list the worker', response.status === 200 && response.data.workers.length === 0);

        const tokenA1 = (await login('device-a1', 'device-password')).data.token;
        const tokenA2 = (await login('device-a2', 'device-password')).data.token;
        const tokenB = (await login('device-b', 'device-password')).data.token;

        response = await api(tokenA1, 'GET', '/api/service/workers/roster');
        check('eligible device roster contains safe worker fields only',
            response.status === 200 && response.data.workers.length === 1 &&
            Object.keys(response.data.workers[0]).sort().join(',') === 'displayName,id',
            response.data);
        response = await api(tokenA2, 'GET', '/api/service/workers/roster');
        check('sibling department roster does not expose worker', response.data.workers.length === 0);
        response = await api(tokenB, 'GET', '/api/service/workers/roster');
        check('other company roster does not expose worker', response.data.workers.length === 0);

        response = await api(tokenA1, 'GET', '/api/service/ops-tasks');
        check('existing task reads do not require worker proof', response.status === 200);

        response = await api(tokenA1, 'POST', '/api/service/workers/verify',
            { workerId: alice.id, pin: '7392' }, null, '10.0.0.1');
        check('eligible worker verifies on department device', response.status === 200, response.data);
        let proof = response.data.proof;
        check('proof response is short-lived and safe',
            proof && response.data.expiresAt > Date.now() &&
            response.data.inactivityExpiresAt <= Date.now() + 5 * 60 * 1000 + 2000);

        response = await api(tokenA1, 'GET', '/api/service/workers/current', undefined, proof);
        check('current proof resolves on originating device', response.status === 200);
        response = await api(tokenA2, 'GET', '/api/service/workers/current', undefined, proof);
        check('proof cannot replay on sibling device', response.status === 401);
        response = await api(tokenB, 'GET', '/api/service/workers/current', undefined, proof);
        check('proof cannot replay in another company', response.status === 401);
        const tampered = proof.slice(0, -1) + (proof.endsWith('a') ? 'b' : 'a');
        response = await api(tokenA1, 'GET', '/api/service/workers/current', undefined, tampered);
        check('tampered proof is rejected', response.status === 401);

        response = await api(tokenA1, 'POST', '/api/service/workers/clear', {}, proof);
        check('handoff revokes proof', response.status === 200);
        response = await api(tokenA1, 'GET', '/api/service/workers/current', undefined, proof);
        check('revoked handoff proof cannot be reused', response.status === 401);

        const concurrentSelections = await Promise.all([
            api(tokenA1, 'POST', '/api/service/workers/verify',
                { workerId: alice.id, pin: '7392' }, null, '10.0.0.2'),
            api(tokenA1, 'POST', '/api/service/workers/verify',
                { workerId: alice.id, pin: '7392' }, null, '10.0.0.2')
        ]);
        const concurrentProofs = concurrentSelections.map(item => item.data.proof);
        const concurrentCurrent = await Promise.all(concurrentProofs.map(item =>
            api(tokenA1, 'GET', '/api/service/workers/current', undefined, item)));
        check('concurrent worker selection leaves exactly one current proof',
            concurrentCurrent.filter(item => item.status === 200).length === 1);
        const switchedProof = concurrentProofs[concurrentCurrent.findIndex(item => item.status === 200)];
        response = await api(tokenA1, 'POST', '/api/service/workers/clear-device', {});
        check('device logout revokes all worker proofs', response.status === 200);
        response = await api(tokenA1, 'GET', '/api/service/workers/current', undefined, switchedProof);
        check('proof cannot be replayed after device logout', response.status === 401);

        response = await api(tokenA1, 'POST', '/api/service/workers/verify',
            { workerId: alice.id, pin: '7392' }, null, '10.0.0.2');
        proof = response.data.proof;
        await api(adminA, 'POST', `/api/service/workers/${alice.id}/reset-pin`, { pin: '8462' });
        response = await api(tokenA1, 'GET', '/api/service/workers/current', undefined, proof);
        check('PIN reset immediately invalidates old proof', response.status === 401);

        response = await api(tokenA1, 'POST', '/api/service/workers/verify',
            { workerId: alice.id, pin: '8462' }, null, '10.0.0.3');
        proof = response.data.proof;
        await api(adminA, 'PUT', `/api/service/workers/${alice.id}/memberships`,
            { departmentMemberships: [] });
        response = await api(tokenA1, 'GET', '/api/service/workers/current', undefined, proof);
        check('membership revocation immediately invalidates proof', response.status === 401);

        await api(adminA, 'PUT', `/api/service/workers/${alice.id}/memberships`,
            { departmentMemberships: [deptA1.id] });
        response = await api(tokenA1, 'POST', '/api/service/workers/verify',
            { workerId: alice.id, pin: '8462' }, null, '10.0.0.4');
        proof = response.data.proof;
        await api(adminA, 'PUT', `/api/service/workers/${alice.id}/status`, { status: 'SUSPENDED' });
        response = await api(tokenA1, 'GET', '/api/service/workers/current', undefined, proof);
        check('worker suspension immediately invalidates proof', response.status === 401);
        response = await api(tokenA1, 'GET', '/api/service/workers/roster');
        check('suspended worker disappears from roster', response.data.workers.length === 0);

        await api(adminA, 'PUT', `/api/service/workers/${alice.id}/status`, { status: 'ACTIVE' });
        for (let attempt = 0; attempt < 5; attempt++) {
            response = await api(tokenA1, 'POST', '/api/service/workers/verify',
                { workerId: alice.id, pin: '0000' }, null, '10.0.0.9');
        }
        response = await api(tokenA1, 'POST', '/api/service/workers/verify',
            { workerId: alice.id, pin: '8462' }, null, '10.0.0.9');
        check('verification failures trigger rate limit with Retry-After',
            response.status === 429 && Number(response.headers.get('retry-after')) > 0);

        response = await api(adminA, 'GET', '/api/service/workers/audit');
        check('administration audit is server-authored and secret-free',
            response.status === 200 &&
            response.data.audit.some(item => item.action === 'WORKER_PIN_RESET') &&
            !JSON.stringify(response.data).includes('secretHash'));
    } finally {
        server.kill('SIGTERM');
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});