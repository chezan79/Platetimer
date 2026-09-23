'use strict';

const assert = require('assert');
const targets = require('../service/execution-target');
const recurring = require('../operations/ops-recurring');

const legacy = targets.effectiveTarget({ serviceDepartmentId: 'dept_a' });
assert.deepStrictEqual(legacy, {
    type: 'DEPARTMENT', departmentId: 'dept_a', roleId: null, workerId: null
});
assert.strictEqual(targets.effectiveTarget({
    serviceExecutionTarget: null,
    serviceDepartmentId: 'dept_a'
}), null);
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
        recurring.sanitizeTemplatePatch({
            title: 'Metadata',
            defaultServiceExecutionTargetVersion: 99
        }),
        'defaultServiceExecutionTargetVersion'
    ),
    false
);
assert.strictEqual(targets.effectiveTarget({
    serviceExecutionTarget: { type: 'DEPARTMENT', departmentId: 'dept_b' },
    serviceDepartmentId: 'dept_a'
}), null);

const template = {
    id: 'opstpl_target',
    title: 'Inactive target',
    startDate: '2026-09-15',
    frequency: 'DAILY',
    maxOccurrences: 1,
    serviceDepartmentId: 'dept_inactive',
    defaultServiceExecutionTarget: {
        type: 'DEPARTMENT', departmentId: 'dept_inactive', roleId: null, workerId: null
    },
    publishToService: true
};
const generated = recurring.generateTasksForTemplate(
    template, 'company', new Set(), {}, null,
    { isDepartmentEligible: () => false }
);
assert.strictEqual(generated.length, 1);
assert.strictEqual(generated[0].publishToService, false);
assert.strictEqual(generated[0].serviceDepartmentId, null);
assert.strictEqual(generated[0].serviceExecutionTarget, null);

assert.strictEqual(targets.isEligibleOperationsDepartment({
    id: 'renamed-central', name: 'Qualunque nome', active: true,
    departmentType: 'CENTRAL', companyId: 'company'
}, 'company'), true);
assert.strictEqual(targets.isEligibleOperationsDepartment({
    id: 'cucina-by-name-only', name: 'Cucina', active: true,
    departmentType: 'STANDARD', companyId: 'company'
}, 'company'), false);
assert.strictEqual(targets.isEligibleOperationsDepartment({
    id: 'other-company', active: true, departmentType: 'CENTRAL',
    companyId: 'other'
}, 'company'), false);
const departments = [
    { id: 'central', name: 'Renamed prep', active: true, departmentType: 'CENTRAL', companyId: 'company' },
    { id: 'standard', name: 'Cucina', active: true, departmentType: 'STANDARD', companyId: 'company' },
    { id: 'inactive', name: 'Cucina', active: false, departmentType: 'CENTRAL', companyId: 'company' },
    { id: 'foreign', name: 'Cucina', active: true, departmentType: 'CENTRAL', companyId: 'foreign' }
];
assert.strictEqual(targets.findEligibleOperationsDepartment(departments, 'company', 'central'), departments[0]);
for (const id of ['standard', 'inactive', 'foreign', 'missing']) {
    assert.strictEqual(targets.findEligibleOperationsDepartment(departments, 'company', id), null);
    const occurrence = recurring.generateTasksForTemplate({
        ...template, id: `template-${id}`, serviceDepartmentId: id,
        defaultServiceExecutionTarget: { type: 'DEPARTMENT', departmentId: id }
    }, 'company', new Set(), {}, null, {
        isDepartmentEligible: (deptId, companyId) =>
            !!targets.findEligibleOperationsDepartment(departments, companyId, deptId)
    });
    assert.strictEqual(occurrence.length, 1);
    assert.strictEqual(occurrence[0].publishToService, false);
    assert.strictEqual(occurrence[0].serviceExecutionTarget, null);
}
const centralOccurrence = recurring.generateTasksForTemplate({
    ...template, id: 'template-central', serviceDepartmentId: 'central',
    defaultServiceExecutionTarget: { type: 'DEPARTMENT', departmentId: 'central' }
}, 'company', new Set(), {}, null, {
    isDepartmentEligible: (deptId, companyId) =>
        !!targets.findEligibleOperationsDepartment(departments, companyId, deptId)
});
assert.strictEqual(centralOccurrence[0].publishToService, true);

const versioned = {
    serviceExecutionTarget: {
        type: 'DEPARTMENT', departmentId: 'dept_a', roleId: null, workerId: null
    },
    serviceDepartmentId: 'dept_a',
    serviceExecutionTargetVersion: 1,
    publishToService: true
};
assert.throws(
    () => targets.normalizeWrite({
        publishToService: false,
        serviceExecutionTargetVersion: 0
    }, versioned),
    error => error.code === 'SERVICE_TARGET_VERSION_CONFLICT' && error.version === 1
);
assert.throws(
    () => targets.normalizeWrite({
        publishToService: false,
        serviceExecutionTargetVersion: '1'
    }, versioned),
    error => !error.code && /non valido/.test(error.message)
);
const publicationOnly = targets.normalizeWrite({
    publishToService: false,
    serviceExecutionTargetVersion: 1
}, versioned);
assert.strictEqual(publicationOnly.publish, false);
assert.strictEqual(publicationOnly.version, 2);

console.log('Service execution target contract: all checks passed');