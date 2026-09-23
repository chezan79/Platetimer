#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let passed = 0;
let failed = 0;

function check(label, condition) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${label}`);
    } else {
        failed++;
        console.error(`  ❌ ${label}`);
    }
}

function routeBody(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    return from >= 0 && to > from ? source.slice(from, to) : '';
}

const departmentRoute = routeBody(
    "app.get('/api/operations/service-departments'",
    "app.get('/api/operations/service-workers'"
);
check('department options refresh the canonical department authority before filtering',
    departmentRoute.includes('await refreshDepartmentsFromAuthority()'));
check('department options remain company-scoped and CENTRAL-only',
    departmentRoute.includes('ctx.opsUser.companyId') &&
    departmentRoute.includes('isEligibleOperationsDepartment(d, companyId)'));
check('department serialization depends only on canonical ID and name',
    departmentRoute.includes("map(d => ({ id: d.id, name: d.name }))") &&
    !departmentRoute.includes('departmentAccounts'));

const workerRoute = routeBody(
    "app.get('/api/operations/service-workers'",
    'function sendServiceTargetError'
);
check('eligible-worker lookup refreshes departments and workers from the same authority',
    workerRoute.includes('refreshDepartmentsFromAuthority()') &&
    workerRoute.includes('refreshServiceWorkersFromAuthority()'));
check('eligible-worker lookup keeps canonical company and membership checks',
    workerRoute.includes('getCompanyDepts(companyId)') &&
    workerRoute.includes('findEligibleOperationsDepartment') &&
    workerRoute.includes('getSelectableWorkers(companyId, departmentId)'));

const broadcastRoute = routeBody('function broadcastOps(companyId, payload)', '// Store per i countdown attivi');
check('bound WebSocket Operations delivery checks the database rather than a stale process snapshot',
    broadcastRoute.includes("doc('departments').get()") &&
    broadcastRoute.includes('opsPayloadForBoundSocket(payload, client.boundDepartmentId, companyId, depts)') &&
    broadcastRoute.includes('.catch(e =>'));

for (const [label, routeStart, routeEnd] of [
    ['manual task creation', "app.post('/api/operations/tasks'", "app.get('/api/operations/tasks'"],
    ['manual task update', "app.patch('/api/operations/tasks/:id'", "app.delete('/api/operations/tasks/:id'"],
    ['manual task metadata update', "app.put('/api/operations/tasks/:id'", "app.post('/api/operations/tasks/:id/reassign'"],
    ['recurring template creation', "app.post('/api/operations/templates'", "app.get('/api/operations/templates/:id'"],
    ['recurring template update', "app.patch('/api/operations/templates/:id'", "app.delete('/api/operations/templates/:id'"]
]) {
    const body = routeBody(routeStart, routeEnd);
    check(`${label} validates against a freshly loaded canonical department store`,
        body.includes('refreshDepartmentsFromAuthority()') &&
        body.includes('refreshServiceWorkersFromAuthority()'));
}

console.log(`\nService target department freshness: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;