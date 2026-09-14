#!/usr/bin/env node
'use strict';

// Task 127: end-to-end HTTP contract for verified Service worker actions.
// This deliberately starts the real server with local-file persistence so that
// claims, proofs, projections and canonical Operations state cross a restart.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SECRET = 'task-127-http-test-secret';
const PORT = 40000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'task-127-http-'));

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${label}`);
    } else {
        failed++;
        console.error(`  ❌ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    }
}

function sign(uid, companyName, authSource = 'firebase-profile') {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, authSource, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${signature}`;
}

async function api(token, method, route, body, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(BASE + route, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
        status: response.status,
        headers: response.headers,
        data: await response.json().catch(() => ({}))
    };
}

async function action(token, proof, taskId, name, key, body = {}) {
    return api(token, 'POST', `/api/service/ops-tasks/${taskId}/${name}`,
        body, { 'X-Worker-Proof': proof, 'Idempotency-Key': key });
}

function startServer() {
    const child = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            DATA_DIR,
            WS_SESSION_SECRET: SECRET,
            SESSION_SECRET: 'task-127-worker-pin-pepper',
            SERVICE_TASK_CLAIM_LEASE_MS: '2000',
            SERVICE_TASK_CLAIM_MAX_LEASE_MS: '10000',
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            RESEND_API_KEY: '',
            SMTP_HOST: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const ready = new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error('server start timeout'));
            }
        }, 20_000);
        const onData = chunk => {
            if (!settled && String(chunk).includes('Server avviato')) {
                settled = true;
                clearTimeout(timeout);
                resolve();
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('exit', code => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error(`server exited early (${code})`));
            }
        });
    });
    return { child, ready };
}

async function stopServer(child) {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            finish();
        }, 5_000);
        child.once('exit', finish);
    });
}

async function createWorker(director, displayName, pin, departmentId) {
    const response = await api(director, 'POST', '/api/service/workers', {
        displayName,
        pin,
        departmentMemberships: [departmentId]
    });
    if (response.status !== 201) throw new Error(`worker setup failed: ${JSON.stringify(response.data)}`);
    return response.data.worker;
}

async function run() {
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({ 'task-127-co': 'medium' }));
    let server;

    try {
        server = startServer();
        await server.ready;

        const director = sign('task-127-director', 'task-127-co', 'ops-bootstrap');

        let response = await api(director, 'GET', '/api/operations/me?name=Operations%20Director');
        check('Operations Director is bootstrapped', response.status === 200 && response.data.user?.role === 'DIRECTOR', response.data);

        response = await api(director, 'POST', '/api/departments', { name: 'Task 127 Kitchen' });
        const department = response.data.department;
        check('active Service department is created', response.status === 201 && department?.active === true, response.data);

        response = await api(director, 'POST', '/api/department-accounts', {
            departmentId: department.id,
            loginIdentifier: 'task127-kitchen',
            password: 'device-password'
        });
        check('active department account is created', response.status === 201 && response.data.account?.status === 'ACTIVE', response.data);

        response = await api(null, 'POST', '/api/service/login', {
            loginIdentifier: 'task127-kitchen',
            password: 'device-password'
        });
        const serviceToken = response.data.token;
        check('Service device login is server-derived', response.status === 200 &&
            response.data.departmentId === department.id && !JSON.stringify(response.data).includes('passwordHash'), response.data);

        const alice = await createWorker(director, 'Alice', '7392', department.id);
        const bob = await createWorker(director, 'Bob', '8462', department.id);
        check('two Service workers have active memberships', alice?.id && bob?.id &&
            alice.departmentMemberships?.some(m => m.departmentId === department.id && m.status === 'ACTIVE') &&
            bob.departmentMemberships?.some(m => m.departmentId === department.id && m.status === 'ACTIVE'));

        response = await api(serviceToken, 'GET', '/api/service/workers/roster');
        check('worker roster is a safe membership projection', response.status === 200 &&
            response.data.workers?.length === 2 &&
            response.data.workers.every(worker => Object.keys(worker).sort().join(',') === 'displayName,id'), response.data);

        response = await api(serviceToken, 'POST', '/api/service/workers/verify',
            { workerId: alice.id, pin: '7392' });
        const aliceProof = response.data.proof;
        check('Alice PIN verification issues a short-lived proof', response.status === 200 &&
            aliceProof && response.data.expiresAt > Date.now(), response.data);
        response = await api(serviceToken, 'GET', '/api/service/workers/current',
            undefined, { 'X-Worker-Proof': aliceProof });
        check('Alice proof resolves on the authorized device', response.status === 200 &&
            response.data.worker?.id === alice.id, response.data);

        response = await api(serviceToken, 'POST', '/api/service/workers/verify',
            { workerId: bob.id, pin: '8462' });
        let bobProof = response.data.proof;
        check('Bob PIN verification issues a worker proof', response.status === 200 &&
            bobProof && response.data.worker?.id === bob.id, response.data);
        response = await api(serviceToken, 'GET', '/api/service/workers/current',
            undefined, { 'X-Worker-Proof': aliceProof });
        check('switching the verified worker revokes the previous proof', response.status === 401, response.data);
        response = await api(serviceToken, 'GET', '/api/service/workers/current',
            undefined, { 'X-Worker-Proof': bobProof });
        check('Bob proof resolves after PIN verification', response.status === 200 &&
            response.data.worker?.id === bob.id, response.data);

        response = await api(director, 'POST', '/api/operations/tasks', {
            title: 'Task 127 canonical task',
            description: 'Prepare the station',
            priority: 'HIGH',
            serviceDepartmentId: department.id,
            publishToService: true
        });
        const task = response.data.task;
        check('published Operations task is created', response.status === 201 &&
            task?.status === 'OPEN' && task.publishToService === true, response.data);

        response = await api(serviceToken, 'GET', '/api/service/ops-tasks');
        const serviceTask = (response.data.tasks || []).find(item => item.id === task.id);
        const forbiddenServiceFields = ['companyId', 'assigneeId', 'createdBy', 'history', 'comments', 'attachments', 'notes'];
        check('Service task projection is safe and entitled', response.status === 200 && serviceTask &&
            forbiddenServiceFields.every(field => !(field in serviceTask)) &&
            serviceTask.source === 'OPERATIONS' && serviceTask.serviceDepartmentId === department.id, serviceTask);

        response = await api(director, 'GET', `/api/operations/tasks/${task.id}`);
        check('Operations projection retains canonical task identity and history',
            response.status === 200 && response.data.task?.companyId === 'task-127-co' &&
            Array.isArray(response.data.task?.history), response.data.task);

        // The two requests deliberately share the currently verified proof. The
        // repository must still make the compare-and-set claim first-wins.
        const race = await Promise.all([
            action(serviceToken, bobProof, task.id, 'claim', 'task127-race-a'),
            action(serviceToken, bobProof, task.id, 'claim', 'task127-race-b')
        ]);
        const winner = race.find(item => item.status === 200);
        const loser = race.find(item => item.status !== 200);
        check('concurrent claims are first-writer-wins', race.filter(item => item.status === 200).length === 1 &&
            loser?.data.code === 'ALREADY_CLAIMED', race.map(item => item.data));
        const leaseId = winner?.data.task?.claim?.leaseId;
        const claimRevision = winner?.data.revision;

        response = await action(serviceToken, bobProof, task.id, 'claim', 'task127-race-a');
        check('claim replay is idempotent', response.status === 200 && response.data.idempotent === true &&
            response.data.task?.claim?.leaseId === leaseId, response.data);

        response = await action(serviceToken, bobProof, task.id, 'start', 'task127-stale-start',
            { expectedRevision: 0, leaseId });
        check('stale action revision is rejected', response.status === 409 &&
            response.data.code === 'TASK_VERSION_CONFLICT', response.data);

        response = await action(serviceToken, bobProof, task.id, 'start', 'task127-wrong-lease',
            { leaseId: 'not-the-active-lease' });
        check('only the active claimant lease may start', response.status === 409 &&
            response.data.code === 'NOT_CLAIMANT', response.data);

        response = await action(serviceToken, bobProof, task.id, 'start', 'task127-start',
            { expectedRevision: claimRevision, leaseId });
        check('claimant can start the task', response.status === 200 &&
            response.data.task?.status === 'IN_PROGRESS', response.data);
        const startedRevision = response.data.revision;

        response = await action(serviceToken, bobProof, task.id, 'renew', 'task127-renew',
            { expectedRevision: startedRevision, leaseId });
        check('claimant can renew the active lease', response.status === 200 &&
            response.data.task?.claim?.status === 'ACTIVE', response.data);

        response = await action(serviceToken, bobProof, task.id, 'release', 'task127-release',
            { leaseId });
        check('claimant can release the active lease', response.status === 200 &&
            response.data.task?.claimLeaseStatus === 'RELEASED', response.data);

        response = await action(serviceToken, bobProof, task.id, 'claim', 'task127-reclaim');
        check('a released task can be reclaimed', response.status === 200 &&
            response.data.task?.claim?.workerId === bob.id, response.data);
        const completionLeaseId = response.data.task.claim.leaseId;
        const completionRevision = response.data.revision;

        response = await api(director, 'POST',
            `/api/operations/tasks/${task.id}/service-claim/override`,
            { expectedRevision: completionRevision });
        check('Operations override requires the targeted lease ID',
            response.status === 400 && response.data.code === 'INVALID_ACTION_REQUEST', response.data);

        response = await api(director, 'POST',
            `/api/operations/tasks/${task.id}/service-claim/override`,
            { expectedRevision: completionRevision, leaseId });
        check('a delayed override cannot close a newer claim',
            response.status === 409 && response.data.code === 'CLAIM_LEASE_CONFLICT', response.data);

        response = await api(serviceToken, 'GET', '/api/service/ops-tasks');
        const stillClaimed = (response.data.tasks || []).find(item => item.id === task.id);
        check('newer claim remains active after stale override',
            stillClaimed?.claim?.status === 'ACTIVE' &&
            stillClaimed?.claim?.leaseId === completionLeaseId, stillClaimed);

        response = await api(serviceToken, 'POST',
            `/api/service/ops-tasks/${task.id}/acknowledge`);
        check('acknowledgement cannot hide an active individual claim',
            response.status === 409 && response.data.code === 'TASK_ACTIVE_CLAIM', response.data);

        response = await action(serviceToken, bobProof, task.id, 'complete', 'task127-complete',
            { expectedRevision: completionRevision, leaseId: completionLeaseId });
        check('claimant can complete with a fresh worker proof', response.status === 200 &&
            response.data.task?.status === 'COMPLETED' &&
            response.data.task?.claimLeaseStatus === 'COMPLETED', response.data);

        response = await action(serviceToken, bobProof, task.id, 'complete', 'task127-complete',
            { expectedRevision: completionRevision, leaseId: completionLeaseId });
        check('completion replay is idempotent', response.status === 200 && response.data.idempotent === true, response.data);

        response = await api(director, 'GET', `/api/operations/tasks/${task.id}`);
        const completedBeforeRestart = response.data.task;
        const completedHistoryCount = (completedBeforeRestart.history || [])
            .filter(item => item.type === 'SERVICE_COMPLETED').length;
        check('completion is canonically persisted in Operations', response.status === 200 &&
            completedBeforeRestart.status === 'COMPLETED' && completedHistoryCount === 1, completedBeforeRestart);

        response = await api(director, 'POST', '/api/operations/tasks', {
            title: 'Task 127 abandoned lease probe',
            serviceDepartmentId: department.id,
            publishToService: true
        });
        const abandonedTask = response.data.task;
        response = await action(serviceToken, bobProof, abandonedTask.id, 'claim', 'task127-abandoned-claim');
        check('abandoned lease probe can be claimed', response.status === 200, response.data);
        await new Promise(resolve => setTimeout(resolve, 2100));

        response = await api(serviceToken, 'GET', '/api/service/ops-tasks');
        const expiredTask = (response.data.tasks || []).find(item => item.id === abandonedTask.id);
        check('authoritative read exposes an abandoned task as reclaimable',
            response.status === 200 && expiredTask?.claim?.status === 'EXPIRED', expiredTask);

        response = await api(serviceToken, 'POST', '/api/service/workers/verify',
            { workerId: alice.id, pin: '7392' });
        const reclaimProof = response.data.proof;
        response = await action(serviceToken, reclaimProof, abandonedTask.id, 'claim', 'task127-abandoned-reclaim');
        check('another verified worker can reclaim after read-materialized expiry',
            response.status === 200 && response.data.task?.claim?.workerId === alice.id, response.data);

        response = await api(serviceToken, 'POST', '/api/service/workers/verify',
            { workerId: bob.id, pin: '8462' });
        bobProof = response.data.proof;
        check('Bob can be re-verified after abandoned lease recovery',
            response.status === 200 && !!bobProof, response.data);

        // A second task proves that revoking a worker/membership denies an
        // already-issued proof before any terminal-state shortcut can apply.
        response = await api(director, 'POST', '/api/operations/tasks', {
            title: 'Task 127 revocation probe',
            serviceDepartmentId: department.id,
            publishToService: true
        });
        const revocationTask = response.data.task;
        response = await action(serviceToken, bobProof, revocationTask.id, 'claim', 'task127-revocation-claim');
        check('revocation probe task can be claimed', response.status === 200, response.data);
        response = await api(director, 'PUT', `/api/service/workers/${bob.id}/memberships`,
            { departmentMemberships: [] });
        check('membership revocation is accepted', response.status === 200, response.data);

        response = await action(serviceToken, bobProof, revocationTask.id, 'start', 'task127-revoked-start',
            { leaseId: response.data?.task?.claim?.leaseId });
        check('revoked worker proof is denied before task action', response.status === 401 &&
            response.data.code === 'WORKER_PROOF_INVALID', response.data);

        response = await api(director, 'PUT', `/api/service/workers/${bob.id}/memberships`,
            { departmentMemberships: [department.id] });
        check('worker membership can be restored', response.status === 200, response.data);

        await stopServer(server.child);
        server = startServer();
        await server.ready;

        response = await api(director, 'GET', `/api/operations/tasks/${task.id}`);
        const completedAfterRestart = response.data.task;
        const historyAfterRestart = completedAfterRestart.history || [];
        check('canonical completion survives server restart/reconnect',
            response.status === 200 && completedAfterRestart.status === 'COMPLETED' &&
            completedAfterRestart.claimLeaseStatus === 'COMPLETED', completedAfterRestart);
        check('restart does not duplicate Service history',
            historyAfterRestart.filter(item => item.type === 'SERVICE_COMPLETED').length === 1 &&
            historyAfterRestart.length === completedBeforeRestart.history.length, {
                before: completedBeforeRestart.history.length,
                after: historyAfterRestart.length
            });

        response = await api(serviceToken, 'GET', '/api/service/ops-tasks');
        check('reconnected Service projection hides completed task',
            response.status === 200 && !(response.data.tasks || []).some(item => item.id === task.id), response.data);
    } catch (error) {
        failed++;
        console.error(`❌ Task 127 HTTP test error: ${error.stack || error.message}`);
    } finally {
        await stopServer(server && server.child);
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\nTask 127 HTTP: ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
}

run().catch(error => {
    console.error(error);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exitCode = 1;
});