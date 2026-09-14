#!/usr/bin/env node
'use strict';

// Task 109: trace the authenticated browser-level Operations task request chain.
//
// The server-side flow remains an evidence-producing regression, while the
// source assertions verify that the browser page records exact API requests,
// detail failures, static assets/source maps, and preview WebSockets.
//
// Run: node tests/operations-task108-detail-trace.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SECRET = 'test-task108-detail-trace-secret';
const PORT = 5110;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'opstest-task108-'));

function sign(uid, companyName, authSource = 'firebase-profile') {
    const payload = Buffer.from(JSON.stringify({
        uid,
        companyName,
        authSource,
        iat: Date.now(),
        exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

async function api(token, method, requestPath, body) {
    const res = await fetch(BASE + requestPath, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
        status: res.status,
        body: await res.json().catch(() => ({}))
    };
}

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

function evidence(label, method, requestPath, caller, response) {
    console.log(JSON.stringify({
        evidence: label,
        method,
        url: requestPath,
        caller,
        responseStatus: response.status,
        responseBody: response.body
    }));
}

function createBrowserTraceHarness() {
    const values = new Map();
    const sessionStorage = {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
    class FakeWebSocket {
        constructor(url) {
            this.url = String(url);
            this.listeners = {};
        }
        addEventListener(name, listener) {
            (this.listeners[name] ||= []).push(listener);
        }
    }
    class FakePerformanceObserver {
        constructor(callback) { this.callback = callback; }
        observe() {}
    }
    const location = {
        href: 'https://preview.example.replit.dev/operations-tasks.html',
        origin: 'https://preview.example.replit.dev'
    };
    const window = {
        location,
        sessionStorage,
        WebSocket: FakeWebSocket,
        PerformanceObserver: FakePerformanceObserver,
        performance: {
            getEntriesByType: () => [
                {
                    name: 'https://preview.example.replit.dev/css/operations.css',
                    startTime: 1,
                    initiatorType: 'link',
                    duration: 12
                },
                {
                    name: 'https://preview.example.replit.dev/js/operations-common.js.map',
                    startTime: 2,
                    initiatorType: 'script',
                    duration: 3
                }
            ]
        }
    };
    const context = {
        window,
        URL,
        console: { info() {}, warn() {} },
        alert() {},
        WsAuth: {
            getStoredToken: () => 'browser-trace-token',
            clearToken() {}
        },
        fetch: async requestUrl => ({
            status: 404,
            url: new URL(requestUrl, location.href).href,
            text: async () => '{"success":false,"error":"Task not found"}'
        })
    };
    vm.createContext(context);
    const commonSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'operations-common.js'), 'utf8');
    vm.runInContext(`${commonSource}\nglobalThis.__opsCommonForTraceTest = OpsCommon;`, context);
    return context;
}

async function startServer() {
    const server = spawn('node', ['server.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            SMTP_HOST: '',
            SMTP_USER: '',
            SMTP_PASS: '',
            RESEND_API_KEY: '',
            RESEND_API_BASE: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let startupOutput = '';
    server.stderr.on('data', chunk => { startupOutput += chunk.toString(); });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`server start timeout\n${startupOutput}`));
        }, 20_000);
        server.stdout.on('data', chunk => {
            if (chunk.toString().includes('Server avviato')) {
                clearTimeout(timeout);
                resolve();
            }
        });
        server.on('exit', code => {
            clearTimeout(timeout);
            reject(new Error(`server exited before startup: ${code}\n${startupOutput}`));
        });
    });
    return server;
}

async function run() {
    console.log('Starting isolated server (Task 109 detail trace)…');
    const server = await startServer();
    const companyId = `task108-co-${crypto.randomBytes(3).toString('hex')}`;
    const uid = `task108-director-${crypto.randomBytes(3).toString('hex')}`;
    const token = sign(uid, companyId, 'ops-bootstrap');

    try {
        const me = await api(token, 'GET', '/api/operations/me');
        evidence(
            'auth bootstrap used by the Operations page',
            'GET',
            '/api/operations/me',
            'operations-tasks.html:load() -> OpsCommon.loadMe()',
            me
        );
        check('Authenticated actor bootstraps as a Director', me.status === 200 && me.body.success);
        const actor = me.body.user;
        const actorCompanyId = me.body.companyId;

        const createPath = '/api/operations/tasks';
        const create = await api(token, 'POST', createPath, {
            title: 'Task 109 detail trace',
            description: 'Authorized creator detail regression',
            assigneeId: actor.id,
            priority: 'HIGH',
            dueDate: null
        });
        evidence(
            'task creation',
            'POST',
            createPath,
            'operations-tasks.html:doCreate()',
            create
        );
        const createdTaskId = create.body.task && create.body.task.id;
        check('Task creation returns 201 with an ID', create.status === 201 && create.body.success && !!createdTaskId);
        check('Created task is assigned to the authenticated actor',
            create.body.task && create.body.task.assigneeId === actor.id);

        // loadTasks() always appends "?" before its optional filter params;
        // with the default page filters this is the exact browser URL.
        const listPath = '/api/operations/tasks?';
        const list = await api(token, 'GET', listPath);
        evidence(
            'post-create list refresh',
            'GET',
            listPath,
            'operations-tasks.html:doCreate() -> loadTasks()',
            list
        );
        const listedTask = (list.body.tasks || []).find(task => task.id === createdTaskId);
        check('List refresh returns 200', list.status === 200 && list.body.success);
        check('Created ID appears in the authorized task list', !!listedTask);

        const persisted = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ops-tasks.json'), 'utf8'));
        const persistedTask = (persisted[companyId] || []).find(task => task.id === createdTaskId);
        console.log(JSON.stringify({
            evidence: 'persistence comparison',
            companyId,
            actor: {
                id: actor.id,
                companyId: actorCompanyId,
                role: actor.role,
                status: actor.status
            },
            createdTaskId,
            listedTaskId: listedTask && listedTask.id,
            persistedTaskId: persistedTask && persistedTask.id,
            visibilityEvaluation: {
                actorCompanyMatchesTask: !!persistedTask && actorCompanyId === persistedTask.companyId,
                directorCanViewSameCompanyTask: !!persistedTask &&
                    actor.role === 'DIRECTOR' &&
                    actorCompanyId === persistedTask.companyId
            }
        }));
        check('Persisted task has the same ID as the create response',
            !!persistedTask && persistedTask.id === createdTaskId);
        check('Persisted task has the same ID as the list response',
            !!persistedTask && listedTask && persistedTask.id === listedTask.id);

        const detailPath = `/api/operations/tasks/${createdTaskId}`;
        const detail = await api(token, 'GET', detailPath);
        evidence(
            'task detail opened after creation',
            'GET',
            detailPath,
            'operations-tasks.html:doCreate() -> setTimeout() -> openDetail(taskId)',
            detail
        );
        check('Authorized creator detail request returns 200',
            detail.status === 200 && detail.body.success);
        check('Detail response returns the same task ID',
            detail.body.task && detail.body.task.id === createdTaskId);
        check('Detail route resolves the same company-visible persisted task',
            detail.body.task &&
            detail.body.task.id === persistedTask.id &&
            detail.body.task.companyId === actorCompanyId);

        const pageSource = fs.readFileSync(path.join(ROOT, 'public', 'operations-tasks.html'), 'utf8');
        check('doCreate passes the create response ID to openDetail',
            pageSource.includes('const taskId  = r.task.id;') &&
            pageSource.includes('setTimeout(() => openDetail(taskId, {'));
        check('loadTasks constructs the exact default list URL',
            pageSource.includes("OpsCommon.api('/api/operations/tasks?' + params,"));
        check('openDetail calls the expected task-detail route',
            pageSource.includes("OpsCommon.api('/api/operations/tasks/' + taskId,"));

        const browser = createBrowserTraceHarness();
        const initialTrace = browser.window.OpsRequestTrace.get();
        check('Browser trace labels static assets and source maps separately',
            initialTrace.some(event => event.category === 'STATIC_ASSET') &&
            initialTrace.some(event => event.category === 'SOURCE_MAP'));
        browser.window.OpsRequestTrace.clear();
        const missingDetail = await browser.__opsCommonForTraceTest.api(
            '/api/operations/tasks/missing-task',
            { traceAction: 'operations-tasks.html:doCreate() -> setTimeout() -> openDetail(taskId)' }
        );
        const detail404 = browser.window.OpsRequestTrace.get()
            .find(event => event.category === 'TASK_DETAIL_404');
        check('Task-detail 404 preserves its response for the caller',
            missingDetail && missingDetail.success === false);
        check('Task-detail 404 trace includes full URL, body, and page action',
            detail404 &&
            detail404.url === 'https://preview.example.replit.dev/api/operations/tasks/missing-task' &&
            detail404.responseBody === '{"success":false,"error":"Task not found"}' &&
            detail404.caller === 'operations-tasks.html:doCreate() -> setTimeout() -> openDetail(taskId)');
        new browser.window.WebSocket('wss://preview.example.replit.dev/ws');
        check('Browser trace labels preview WebSocket requests separately',
            browser.window.OpsRequestTrace.get().some(event =>
                event.category === 'PREVIEW_WEBSOCKET' &&
                event.url === 'wss://preview.example.replit.dev/ws' &&
                event.event === 'connect'
            ));
        check('Create and list calls identify their initiating page actions',
            pageSource.includes("traceAction: 'operations-tasks.html:doCreate()'") &&
            pageSource.includes("loadTasks('operations-tasks.html:doCreate() -> loadTasks()')") &&
            pageSource.includes("operations-tasks.html:doCreate() -> setTimeout() -> openDetail(taskId)"));
    } finally {
        server.kill();
    }

    console.log(`\nTask 109 detail trace: ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});