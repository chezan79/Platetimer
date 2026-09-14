// Focused unit tests for service/service-workers.js.
'use strict';

const assert = require('assert');
const workers = require('../service/service-workers');

let saves = 0;
const departmentsA = [
    { id: 'dep-a', companyId: 'company-a', active: true },
    { id: 'dep-inactive', companyId: 'company-a', active: false }
];
const departmentsB = [{ id: 'dep-b', companyId: 'company-b', active: true }];
const optionsA = {
    pepper: 'unit-test-pepper',
    departments: departmentsA,
    operationsUsers: [{ id: 'ops-a', companyId: 'company-a' }]
};

workers.setStore({});
workers.setAuditStore({});
workers.setPersist(() => { saves++; });

function expectFailure(result, code) {
    assert.strictEqual(result.ok, false);
    if (code) assert.strictEqual(result.code, code);
}

// PIN policy and required pepper.
expectFailure(workers.createWorker({
    companyId: 'company-a', displayName: 'No pepper', pin: '2468'
}, { departments: departmentsA }), 500);
for (const pin of ['1111', '1234', '4321', '12ab', '123']) {
    expectFailure(workers.createWorker({
        companyId: 'company-a', displayName: 'Weak', pin
    }, optionsA), 400);
}

const created = workers.createWorker({
    companyId: 'company-a',
    displayName: 'Alice',
    pin: '7392',
    departmentMemberships: ['dep-a'],
    operationsUserId: 'ops-a',
    createdBy: 'admin-a'
}, optionsA);
assert.strictEqual(created.ok, true);
const worker = created.worker;
assert.match(worker.id, /^worker_/);
assert.strictEqual(worker.workerId, worker.id);
assert.strictEqual(worker.companyId, 'company-a');
assert.strictEqual(worker.departmentMemberships[0].departmentId, 'dep-a');
assert.strictEqual(worker.departmentMemberships[0].authorizationVersion, 1);
assert.ok(!JSON.stringify(worker).includes('secretHash'));
assert.ok(!JSON.stringify(worker).includes('salt'));
assert.strictEqual(workers.getStore()['company-a'][0].verifier.type, 'PIN');
assert.ok(workers.getStore()['company-a'][0].verifier.salt);
assert.ok(saves > 0);

// IDs cannot be changed, and a name change leaves the canonical ID alone.
expectFailure(workers.updateWorker('company-a', worker.id, { workerId: 'worker_other' }, optionsA), 400);
const renamed = workers.updateWorker('company-a', worker.id, { displayName: 'Alice Updated' }, optionsA);
assert.strictEqual(renamed.worker.id, worker.id);

// Company and department boundaries are enforced.
expectFailure(workers.createWorker({
    companyId: 'company-a', displayName: 'Inactive', pin: '7392',
    departmentMemberships: ['dep-inactive']
}, optionsA), 409);
expectFailure(workers.createWorker({
    companyId: 'company-a', displayName: 'Wrong company', pin: '7392',
    departmentMemberships: ['dep-b']
}, { ...optionsA, departments: departmentsB }), 404);

// Operations links are explicit, validated, and unique within a company.
expectFailure(workers.createWorker({
    companyId: 'company-a', displayName: 'Duplicate op', pin: '7392',
    operationsUserId: 'ops-a'
}, optionsA), 409);
expectFailure(workers.updateWorker('company-a', worker.id, { operationsUserId: 'ops-b' }, {
    pepper: optionsA.pepper, operationsUsers: [{ id: 'ops-b', companyId: 'company-b' }]
}), 409);

const second = workers.createWorker({
    companyId: 'company-a', displayName: 'Bob', pin: '7392'
}, optionsA);
assert.strictEqual(second.ok, true);
expectFailure(workers.linkWorkerOperationsUser('company-a', second.worker.id, 'ops-a', optionsA), 409);

// Correct PIN verifies; wrong pepper/PIN never does. Reset invalidates old PIN
// and increments both versions without exposing verifier material.
assert.strictEqual(workers.verifyWorkerPin('company-a', worker.id, '7392', optionsA.pepper).ok, true);
assert.strictEqual(workers.verifyWorkerPin('company-a', worker.id, '7392', 'wrong-pepper').ok, false);
const beforeVersion = workers.getWorker('company-a', worker.id).authorizationVersion;
const reset = workers.resetWorkerPin('company-a', worker.id, '8462', { pepper: optionsA.pepper, actorId: 'admin-a' });
assert.strictEqual(reset.ok, true);
assert.ok(reset.worker.authorizationVersion > beforeVersion);
assert.strictEqual(workers.verifyWorkerPin('company-a', worker.id, '7392', optionsA.pepper).ok, false);
assert.strictEqual(workers.verifyWorkerPin('company-a', worker.id, '8462', optionsA.pepper).ok, true);
assert.ok(!JSON.stringify(reset.worker).includes('secretHash'));
assert.ok(!JSON.stringify(reset.worker).includes('salt'));

// Exact memberships and versions; roster is company/department scoped.
const membershipChange = workers.setWorkerMemberships('company-a', worker.id, ['dep-a'], {
    departments: departmentsA, actorId: 'admin-a'
});
assert.strictEqual(membershipChange.ok, true);
assert.deepStrictEqual(membershipChange.worker.departmentMemberships.map(m => m.departmentId), ['dep-a']);
assert.strictEqual(workers.getSelectableWorkers('company-a', 'dep-a').length, 1);
assert.strictEqual(workers.getSelectableWorkers('company-b', 'dep-a').length, 0);

// Archive is a lifecycle state, not deletion, and is not selectable.
const archived = workers.setWorkerStatus('company-a', worker.id, 'ARCHIVED', { actorId: 'admin-a' });
assert.strictEqual(archived.ok, true);
assert.strictEqual(workers.getWorker('company-a', worker.id).status, 'ARCHIVED');
assert.strictEqual(workers.getSelectableWorkers('company-a', 'dep-a').some(item => item.id === worker.id), false);
assert.ok(workers.getStore()['company-a'].some(item => item.id === worker.id));

const audit = workers.getAdministrationAuditRecords('company-a');
assert.ok(audit.some(item => item.action === 'WORKER_CREATED'));
assert.ok(audit.some(item => item.action === 'WORKER_PIN_RESET'));
assert.ok(audit.every(item => !JSON.stringify(item).includes('secretHash')));

console.log('service-workers-unit.test.js: all checks passed');
