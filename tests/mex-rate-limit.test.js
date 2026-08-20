#!/usr/bin/env node
'use strict';

/**
 * Task 100 — explicit recovery for rate-limited Mex sends.
 *
 * Run: node tests/mex-rate-limit.test.js
 *
 * Covers the server's pre-dispatch rate-limit branch and the failure ACK
 * handling in both Department and Floor compose UIs.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WS = require('ws');

const SECRET = 'test-mex-rate-limit-secret';
const PORT = 4453;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

let passed = 0;
let failed = 0;

function check(label, condition, hint) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${label}`);
    } else {
        failed++;
        console.error(`  ❌ ${label}${hint === undefined ? '' : ` — got: ${JSON.stringify(hint)}`}`);
    }
}

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid,
        companyName,
        iat: Date.now(),
        exp: Date.now() + 3_600_000
    })).toString('base64');
    const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${signature}`;
}

async function api(token, method, route, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(BASE + route, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
        status: response.status,
        data: await response.json().catch(() => ({}))
    };
}

function connect(token) {
    return new Promise((resolve, reject) => {
        const client = new WS(WS_URL);
        const buffer = [];
        const waiters = [];
        const received = [];

        client.on('open', () => {
            client.send(JSON.stringify({ action: 'joinRoom', token }));
            resolve({
                received,
                send(message) {
                    client.send(JSON.stringify(message));
                },
                close() {
                    try { client.close(); } catch (_) {}
                },
                waitFor(action, timeout = 4000) {
                    const index = buffer.findIndex(message => message.action === action);
                    if (index !== -1) return Promise.resolve(buffer.splice(index, 1)[0]);
                    return new Promise(waitResolve => {
                        const waiter = { action, resolve: waitResolve };
                        waiter.timer = setTimeout(() => {
                            const waiterIndex = waiters.indexOf(waiter);
                            if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
                            waitResolve(null);
                        }, timeout);
                        waiters.push(waiter);
                    });
                }
            });
        });

        client.on('message', raw => {
            let message;
            try { message = JSON.parse(raw); } catch (_) { return; }
            if (!message.action) return;
            received.push(message);
            const index = waiters.findIndex(waiter => waiter.action === message.action);
            if (index === -1) {
                buffer.push(message);
                return;
            }
            const waiter = waiters.splice(index, 1)[0];
            clearTimeout(waiter.timer);
            waiter.resolve(message);
        });
        client.on('error', reject);
        client.on('close', () => {
            waiters.splice(0).forEach(waiter => {
                clearTimeout(waiter.timer);
                waiter.resolve(null);
            });
        });
    });
}

function startServer(dataDir) {
    const proc = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR: dataDir,
            TEST_FIREBASE_AUTH_MOCK: '1',
            FIREBASE_ADMIN_SERVICE_ACCOUNT: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server start timeout')), 20_000);
        proc.stdout.on('data', chunk => {
            if (chunk.toString().includes('avviato')) {
                clearTimeout(timer);
                resolve();
            }
        });
    });
    return { proc, ready };
}

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`Could not find ${name}`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = bodyStart; index < source.length; index++) {
        const character = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            quote = character;
            continue;
        }
        if (character === '{') depth++;
        if (character === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Could not parse ${name}`);
}

function runDepartmentUiRecoveryTest() {
    const source = fs.readFileSync(path.join(__dirname, '../public/department.html'), 'utf8');
    const elements = {
        'mex-send-btn': { disabled: true },
        'mex-body': { value: 'Keep this message' },
        'mex-send-status': { textContent: '', className: '' }
    };
    const document = { getElementById: id => elements[id] };
    const status = (message, className) => {
        elements['mex-send-status'].textContent = message;
        elements['mex-send-status'].className = `mex-send-status${className ? ` ${className}` : ''}`;
    };
    const handler = new Function(
        'document', '_mt', 'mexStatus', 'mexUpdateCharCount', 'mexDeptResetCompose',
        `${extractFunction(source, 'handleMexSendAck')}; return handleMexSendAck;`
    )(
        document,
        key => ({ 'dept.mexRateLimited': 'RATE LIMITED' }[key] || key),
        status,
        () => {},
        () => { throw new Error('rate-limited failure must not reset compose'); }
    );

    handler({ success: false, code: 'MEX_RATE_LIMITED' });
    check('Department rate-limit failure re-enables Send', elements['mex-send-btn'].disabled === false);
    check('Department rate-limit failure preserves body', elements['mex-body'].value === 'Keep this message');
    check('Department rate-limit failure uses localized status', elements['mex-send-status'].textContent === 'RATE LIMITED');
    check('Department rate-limit failure marks status as error', elements['mex-send-status'].className.includes('err'));
}

function runFloorUiRecoveryTest() {
    const source = fs.readFileSync(path.join(__dirname, '../public/sala.html'), 'utf8');
    const elements = {
        'mex-floor-send-btn': { disabled: true },
        'mex-floor-body': { value: 'Keep this floor message' },
        'mex-floor-status': { textContent: '', className: '' }
    };
    const document = { getElementById: id => elements[id] };
    const status = (message, className) => {
        elements['mex-floor-status'].textContent = message;
        elements['mex-floor-status'].className = `mex-send-status${className ? ` ${className}` : ''}`;
    };
    const handler = new Function(
        'document', '_t', 'mexFloorStatus', 'mexFloorUpdateCharCount', 'mexFloorResetCompose',
        `${extractFunction(source, 'handleMexFloorSendAck')}; return handleMexFloorSendAck;`
    )(
        document,
        key => ({ 'sala.mexRateLimited': 'RATE LIMITED FLOOR' }[key] || key),
        status,
        () => {},
        () => { throw new Error('rate-limited failure must not reset floor compose'); }
    );

    handler({ success: false, code: 'MEX_RATE_LIMITED' });
    check('Floor rate-limit failure re-enables Send', elements['mex-floor-send-btn'].disabled === false);
    check('Floor rate-limit failure preserves body', elements['mex-floor-body'].value === 'Keep this floor message');
    check('Floor rate-limit failure uses localized status', elements['mex-floor-status'].textContent === 'RATE LIMITED FLOOR');
    check('Floor rate-limit failure marks status as error', elements['mex-floor-status'].className.includes('err'));
}

async function runServerTest() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mex-rate-limit-'));
    fs.writeFileSync(path.join(dataDir, 'plans.json'), JSON.stringify({ restaurant: 'medium' }));
    const { proc, ready } = startServer(dataDir);
    await ready;

    const adminToken = sign('admin', 'restaurant');
    const senderToken = sign('sender-user', 'restaurant');
    const recipientToken = sign('recipient-user', 'restaurant');
    let sender;
    let recipient;

    try {
        let response = await api(adminToken, 'POST', '/api/departments', { name: 'Kitchen' });
        const senderDept = response.data.department;
        response = await api(adminToken, 'POST', '/api/departments', { name: 'Pizzeria' });
        const recipientDept = response.data.department;

        response = await api(adminToken, 'POST', '/api/department-accounts', {
            departmentId: senderDept.id,
            displayName: 'Kitchen account',
            loginIdentifier: 'kitchen.rate'
        });
        check('Server setup creates sender account', !!response.data.account?.id, response.data);
        response = await api(adminToken, 'POST', '/api/department-accounts', {
            departmentId: recipientDept.id,
            displayName: 'Pizzeria account',
            loginIdentifier: 'pizzeria.rate'
        });
        check('Server setup creates recipient account', !!response.data.account?.id, response.data);

        response = await api(senderToken, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'kitchen.rate' });
        check('Server setup binds sender account', response.data.success === true, response.data);
        response = await api(recipientToken, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'pizzeria.rate' });
        check('Server setup binds recipient account', response.data.success === true, response.data);

        sender = await connect(senderToken);
        recipient = await connect(recipientToken);
        check('Both WS sessions join successfully', !!(
            await Promise.all([sender.waitFor('joinedRoom'), recipient.waitFor('joinedRoom')])
        ).every(Boolean));

        // joinRoom itself traverses the global limiter. Wait for its unchanged
        // 400 ms window to reset before sending the six-message test burst.
        await new Promise(resolve => setTimeout(resolve, 450));
        const rateLimitedBody = 'This seventh send must not persist';
        for (let index = 0; index < 6; index++) {
            sender.send({
                action: 'mexSend',
                to: recipientDept.id,
                body: `normal send ${index}`
            });
        }
        sender.send({ action: 'mexSend', to: recipientDept.id, body: rateLimitedBody });

        const acks = [];
        for (let index = 0; index < 7; index++) acks.push(await sender.waitFor('mexSendAck'));
        const failedAcks = acks.filter(ack => ack?.code === 'MEX_RATE_LIMITED');
        const successAcks = acks.filter(ack => ack?.success === true);
        check('Rate-limited send returns exactly one failure ACK', failedAcks.length === 1, acks);
        check('Rate-limit failure ACK has success=false', failedAcks[0]?.success === false, failedAcks[0]);
        check('Rate-limit failure ACK uses MEX_RATE_LIMITED', failedAcks[0]?.code === 'MEX_RATE_LIMITED', failedAcks[0]);
        check('Six earlier sends receive success ACKs', successAcks.length === 6, acks);
        check('Rate-limited send produces no success ACK', !failedAcks.some(ack => ack.success === true));

        await new Promise(resolve => setTimeout(resolve, 250));
        for (let index = 0; index < 6; index++) await recipient.waitFor('mexIncoming');
        check('Rate-limited body produces no recipient mexIncoming',
            !recipient.received.some(message =>
                message.action === 'mexIncoming' && message.body === rateLimitedBody
            ),
            recipient.received);

        response = await api(recipientToken, 'GET', '/api/service/mex/inbox');
        const persistedRateLimitedBody = response.data.conversations?.some(conversation =>
            conversation.messages?.some(message => message.body === rateLimitedBody)
        );
        check('Rate-limited body is not persisted', persistedRateLimitedBody !== true, response.data);

        await new Promise(resolve => setTimeout(resolve, 450));
        sender.send({ action: 'mexSend', to: recipientDept.id, body: 'retry after rate limit' });
        const retryAck = await sender.waitFor('mexSendAck');
        const retryIncoming = await recipient.waitFor('mexIncoming');
        check('Retry after rate-limit window succeeds', retryAck?.success === true, retryAck);
        check('Successful retry reaches recipient', retryIncoming?.body === 'retry after rate limit', retryIncoming);
    } finally {
        sender?.close();
        recipient?.close();
        proc.kill();
        try { fs.rmSync(dataDir, { recursive: true }); } catch (_) {}
    }
}

async function run() {
    console.log('Task 100 Mex rate-limit tests\n');
    runDepartmentUiRecoveryTest();
    runFloorUiRecoveryTest();
    await runServerTest();
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Mex rate-limit tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch(error => {
    console.error('Fatal test error:', error);
    process.exit(1);
});