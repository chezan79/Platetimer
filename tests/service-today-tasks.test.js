#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeBusinessDate } = require('../operations/business-date');

const SECRET = 'service-today-tasks-secret';
const PORT = 5090;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'service-today-'));

function sign(uid, companyName, authSource = 'firebase-profile') {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, authSource, iat: Date.now(), exp: Date.now() + 3_600_000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

async function api(token, method, route, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(BASE + route, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  PASS ${label}`);
    } else {
        failed++;
        console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    }
}

function addDays(dateKey, amount) {
    const d = new Date(`${dateKey}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + amount);
    return d.toISOString().slice(0, 10);
}

async function run() {
    fs.writeFileSync(path.join(DATA_DIR, 'plans.json'), JSON.stringify({
        'today-co': 'medium', 'other-co': 'medium'
    }));
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            TEST_FIREBASE_AUTH_MOCK: '1',
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            TZ: 'Pacific/Auckland'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('server start timeout')), 20_000);
        server.stdout.on('data', chunk => {
            if (chunk.toString().includes('avviato')) {
                clearTimeout(timeout);
                resolve();
            }
        });
        server.on('exit', code => reject(new Error(`server exited ${code}`)));
    });

    try {
        const director = sign('today-director', 'today-co', 'ops-bootstrap');
        const deptToken = sign('today-dept', 'today-co');
        const otherDeptToken = sign('today-other-dept', 'today-co');
        const otherDirector = sign('other-director', 'other-co', 'ops-bootstrap');
        const otherCompanyDeptToken = sign('other-dept', 'other-co');
        const unbound = sign('unbound', 'today-co');

        await api(director, 'GET', '/api/operations/me?name=Director');
        let r = await api(director, 'POST', '/api/departments', { name: 'Kitchen' });
        const kitchen = r.data.department;
        r = await api(director, 'POST', '/api/departments', { name: 'Bar' });
        const bar = r.data.department;
        r = await api(director, 'POST', '/api/department-accounts', {
            departmentId: kitchen.id, displayName: 'Kitchen', loginIdentifier: 'today.kitchen'
        });
        const kitchenAccount = r.data.account;
        await api(director, 'POST', '/api/department-accounts', {
            departmentId: bar.id, displayName: 'Bar', loginIdentifier: 'today.bar'
        });
        await api(deptToken, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'today.kitchen' });
        await api(otherDeptToken, 'POST', '/api/department-accounts/bind', { loginIdentifier: 'today.bar' });

        await api(otherDirector, 'GET', '/api/operations/me?name=Other');
        r = await api(otherDirector, 'POST', '/api/departments', { name: 'Other Kitchen' });
        const otherKitchen = r.data.department;
        await api(otherDirector, 'POST', '/api/department-accounts', {
            departmentId: otherKitchen.id, displayName: 'Other Kitchen', loginIdentifier: 'other.kitchen'
        });
        await api(otherCompanyDeptToken, 'POST', '/api/department-accounts/bind', {
            loginIdentifier: 'other.kitchen'
        });

        r = await api(deptToken, 'GET', '/api/service/ops-tasks/today');
        const today = r.data.todayDate;
        const yesterday = addDays(today, -1);
        const tomorrow = addDays(today, 1);
        check('returns authoritative Zurich date', r.status === 200 && /^\d{4}-\d{2}-\d{2}$/.test(today), r);

        const create = async (title, dueDate, extra = {}) =>
            (await api(director, 'POST', '/api/operations/tasks', {
                title,
                dueDate,
                serviceDepartmentId: kitchen.id,
                publishToService: true,
                ...extra
            })).data.task;

        const exact = await create('exact date-only', today);
        const instant = await create('same Zurich day instant', `${today}T12:00:00.000Z`);
        const nearMidnight = await create('near midnight UTC', `${yesterday}T23:30:00.000Z`);
        const prior = await create('yesterday', yesterday);
        const future = await create('tomorrow', tomorrow);
        const missing = await create('missing date', null);
        const malformedResult = await api(director, 'POST', '/api/operations/tasks', {
            title: 'malformed date',
            dueDate: 'not-a-date',
            serviceDepartmentId: kitchen.id,
            publishToService: true
        });
        const impossibleValue = `${today.slice(0, 5)}02-30`;
        const unpublished = await create('unpublished', today, { publishToService: false });
        const wrongDept = await create('wrong department', today, { serviceDepartmentId: bar.id });
        const completed = await create('completed', today);
        await api(director, 'POST', `/api/operations/tasks/${completed.id}/complete`);
        const cancelled = await create('cancelled', today);
        await api(director, 'POST', `/api/operations/tasks/${cancelled.id}/cancel`, { reason: 'test' });
        const acknowledged = await create('acknowledged', today);
        await api(deptToken, 'POST', `/api/service/ops-tasks/${acknowledged.id}/acknowledge`);

        const otherCompanyTask = (await api(otherDirector, 'POST', '/api/operations/tasks', {
            title: 'other company',
            dueDate: today,
            serviceDepartmentId: otherKitchen.id,
            publishToService: true
        })).data.task;

        r = await api(deptToken, 'GET', '/api/service/ops-tasks/today');
        const ids = new Set((r.data.tasks || []).map(task => task.id));
        check('includes exact date-only and same-day ISO tasks',
            ids.has(exact.id) && ids.has(instant.id) && ids.has(nearMidnight.id), [...ids]);
        check('excludes adjacent, missing, malformed, and impossible dates',
            !ids.has(prior.id) && !ids.has(future.id) && !ids.has(missing.id) &&
            malformedResult.status === 400 &&
            normalizeBusinessDate('not-a-date') === null &&
            normalizeBusinessDate(impossibleValue) === null &&
            normalizeBusinessDate('2026-02-30T10:00:00Z') === null, [...ids]);
        check('excludes unpublished and terminal tasks',
            !ids.has(unpublished.id) && !ids.has(completed.id) && !ids.has(cancelled.id), [...ids]);
        check('excludes acknowledged task', !ids.has(acknowledged.id), [...ids]);
        check('enforces department and company isolation',
            !ids.has(wrongDept.id) && !ids.has(otherCompanyTask.id), [...ids]);
        check('uses unchanged safe projection',
            r.data.tasks.every(task => task.source === 'OPERATIONS' &&
                !('companyId' in task) && !('assigneeId' in task) && !('createdBy' in task)),
            r.data.tasks);

        const allTasks = await api(deptToken, 'GET', '/api/service/ops-tasks');
        check('existing all-actionable route remains unfiltered by date',
            allTasks.data.tasks.some(task => task.id === prior.id) &&
            allTasks.data.tasks.some(task => task.id === future.id), allTasks.data.tasks);

        check('unauthenticated request is rejected',
            (await api(null, 'GET', '/api/service/ops-tasks/today')).status === 401);
        r = await api(unbound, 'GET', '/api/service/ops-tasks/today');
        check('unbound request is rejected', r.status === 403 && r.data.code === 'NOT_BOUND', r);

        await api(director, 'PUT', `/api/department-accounts/${kitchenAccount.id}/status`, {
            status: 'SUSPENDED'
        });
        r = await api(deptToken, 'GET', '/api/service/ops-tasks/today');
        check('suspended account is rejected',
            r.status === 403 && r.data.code === 'ACCOUNT_SUSPENDED', r);
        await api(director, 'PUT', `/api/department-accounts/${kitchenAccount.id}/status`, {
            status: 'ACTIVE'
        });

        await api(director, 'PUT', `/api/departments/${kitchen.id}`, { active: false });
        r = await api(deptToken, 'GET', '/api/service/ops-tasks/today');
        check('inactive or auto-suspended department is rejected',
            (r.status === 403 && r.data.code === 'ACCOUNT_SUSPENDED') ||
            (r.status === 410 && r.data.code === 'DEPARTMENT_INACTIVE'), r);

        const dstOpening = '2026-03-28T23:30:00.000Z';
        const dstClosing = '2026-03-29T22:30:00.000Z';
        check('Zurich spring-DST boundary maps opening instant to March 29',
            normalizeBusinessDate(dstOpening) === '2026-03-29',
            normalizeBusinessDate(dstOpening));
        check('Zurich spring-DST boundary maps closing instant to March 30',
            normalizeBusinessDate(dstClosing) === '2026-03-30',
            normalizeBusinessDate(dstClosing));
    } finally {
        server.kill('SIGTERM');
        await new Promise(resolve => {
            server.on('exit', resolve);
            setTimeout(resolve, 3000);
        });
    }

    console.log(`\nService today tasks: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});