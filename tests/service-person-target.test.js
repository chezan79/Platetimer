#!/usr/bin/env node
'use strict';

// Focused Task #140 contract tests.  These stay at the authorization/repository
// boundary so they run quickly and deterministically without a live server.
const assert = require('assert');
const targets = require('../service/execution-target');
const recurring = require('../operations/ops-recurring');
const { TaskActionRepository } = require('../service/task-action-repository');
const workers = require('../service/service-workers');
const opsAuth = require('../operations/ops-auth');

function context(workerId, overrides = {}) {
    return {
        workerId, workerName: workerId, companyId: 'company-a',
        departmentId: 'kitchen', departmentName: 'Kitchen',
        accountStatus: 'ACTIVE', departmentActive: true,
        membershipActive: true, workerActive: true, serviceEnabled: true,
        authorizationVersion: 1, membershipAuthorizationVersion: 1,
        ...overrides
    };
}

function personTask(extra = {}) {
    return {
        id: 'person-task', companyId: 'company-a', status: 'OPEN',
        title: 'Exact worker task', publishToService: true,
        serviceDepartmentId: 'kitchen',
        serviceExecutionTarget: {
            type: 'PERSON', departmentId: 'kitchen', workerId: 'alice'
        },
        serviceExecutionTargetVersion: 0,
        history: [], ...extra
    };
}

async function main() {
    // PERSON is canonical and ROLE is deliberately fail-closed.
    assert.deepStrictEqual(targets.parseTarget({
        type: 'PERSON', departmentId: ' kitchen ', workerId: ' alice '
    }), { type: 'PERSON', departmentId: 'kitchen', roleId: null, workerId: 'alice' });
    assert.throws(() => targets.parseTarget({
        type: 'ROLE', departmentId: 'kitchen', roleId: 'CHEF'
    }), /ROLE non supportato/);
    assert.throws(() => targets.parseTarget({
        type: 'PERSON', departmentId: 'kitchen'
    }), /workerId/);
    assert.strictEqual(targets.effectiveTarget({
        serviceExecutionTarget: { type: 'ROLE', departmentId: 'kitchen', roleId: 'CHEF' }
    }), null);

    // Recurring generation carries a PERSON target independently of the
    // Operations assignee namespace.
    const template = {
        id: 'tpl-person', title: 'Recurring person', startDate: '2020-01-01',
        frequency: 'DAILY', maxOccurrences: 1, publishToService: true,
        serviceDepartmentId: 'kitchen',
        defaultServiceExecutionTarget: {
            type: 'PERSON', departmentId: 'kitchen', workerId: 'alice',
            roleId: null
        }, defaultAssigneeId: 'ops-user'
    };
    const generated = recurring.generateTasksForTemplate(
        template, 'company-a', new Set(), { 'ops-user': { id: 'ops-user', status: 'ACTIVE' } },
        null, {
            isDepartmentEligible: () => true,
            getServiceWorker: () => ({
                id: 'alice', companyId: 'company-a', status: 'ACTIVE',
                serviceEnabled: true,
                departmentMemberships: [{
                    departmentId: 'kitchen', status: 'ACTIVE',
                    authorizationVersion: 1
                }]
            })
        }
    );
    assert.strictEqual(generated.length, 1);
    assert.deepStrictEqual(generated[0].serviceExecutionTarget, template.defaultServiceExecutionTarget);
    assert.strictEqual(generated[0].assigneeId, 'ops-user');
    assert.strictEqual(generated[0].publishToService, true);
    for (const worker of [
        null,
        { id: 'alice', companyId: 'company-a', status: 'SUSPENDED', serviceEnabled: true,
            departmentMemberships: [{ departmentId: 'kitchen', status: 'ACTIVE' }] },
        { id: 'alice', companyId: 'company-b', status: 'ACTIVE', serviceEnabled: true,
            departmentMemberships: [{ departmentId: 'kitchen', status: 'ACTIVE' }] },
        { id: 'alice', companyId: 'company-a', status: 'ACTIVE', serviceEnabled: true,
            departmentMemberships: [{ departmentId: 'pastry', status: 'ACTIVE' }] },
        { id: 'alice', companyId: 'company-a', status: 'ACTIVE', serviceEnabled: true,
            departmentMemberships: [{ departmentId: 'kitchen', status: 'ACTIVE', validUntil: 1 }] }
    ]) {
        const failClosed = recurring.generateTasksForTemplate(
            { ...template, id: `tpl-invalid-${worker && worker.status || 'missing'}` },
            'company-a', new Set(), { 'ops-user': { id: 'ops-user', status: 'ACTIVE' } },
            null, {
                isDepartmentEligible: () => true,
                now: 10_000,
                getServiceWorker: () => worker
            }
        )[0];
        assert.strictEqual(failClosed.publishToService, false);
        assert.strictEqual(failClosed.serviceExecutionTarget, null);
        assert.strictEqual(failClosed.serviceDepartmentId, null);
    }

    let now = 10_000;
    const repo = new TaskActionRepository({ clock: () => now, leaseMs: 100, maxLeaseMs: 300 });
    await repo.initialize({});
    await repo.registerTask(personTask());

    // Exact worker is eligible; a same-department sibling and another device
    // department are not.  This also proves Operations assignee identity is
    // not consulted by Service authorization.
    const aliceClaim = await repo.claim({
        companyId: 'company-a', taskId: 'person-task',
        idempotencyKey: 'alice-claim', context: context('alice')
    });
    assert.strictEqual(aliceClaim.ok, true);
    const bobClaim = await repo.claim({
        companyId: 'company-a', taskId: 'person-task',
        idempotencyKey: 'bob-claim', context: context('bob')
    });
    assert.strictEqual(bobClaim.ok, false);
    assert.strictEqual(bobClaim.code, 'WORKER_NOT_AUTHORIZED');
    const otherDeptClaim = await repo.claim({
        companyId: 'company-a', taskId: 'person-task',
        idempotencyKey: 'other-dept-claim',
        context: context('alice', { departmentId: 'pastry' })
    });
    assert.strictEqual(otherDeptClaim.ok, false);
    assert.strictEqual(otherDeptClaim.code, 'WORKER_NOT_AUTHORIZED');
    const replayWrongWorker = await repo.claim({
        companyId: 'company-a', taskId: 'person-task',
        idempotencyKey: 'alice-claim', expectedRevision: 999,
        context: context('bob')
    });
    assert.strictEqual(replayWrongWorker.ok, false);
    assert.strictEqual(replayWrongWorker.code, 'WORKER_NOT_AUTHORIZED');

    // Retargeting in the same department atomically invalidates the active
    // lease; a stale lease action cannot continue under the old worker.
    const leaseId = aliceClaim.task.claim.leaseId;
    const retargeted = await repo.syncTask({
        ...personTask(),
        serviceExecutionTarget: {
            type: 'PERSON', departmentId: 'kitchen', workerId: 'bob'
        },
        serviceExecutionTargetVersion: 1
    }, {
        expectedServiceExecutionTargetVersion: 0,
        targetChanged: true,
        reason: 'PERSON_RETARGETED'
    });
    assert.strictEqual(retargeted.invalidated, true);
    assert.strictEqual(retargeted.committedTask.claimLeaseStatus, 'INVALIDATED');
    assert.strictEqual(retargeted.committedTask.serviceExecutionTarget.workerId, 'bob');
    const stale = await repo.start({
        companyId: 'company-a', taskId: 'person-task',
        idempotencyKey: 'stale-start', leaseId, context: context('alice')
    });
    assert.strictEqual(stale.ok, false);
    assert.ok(['NOT_CLAIMANT', 'CLAIM_INVALIDATED', 'TASK_NOT_ENTITLED',
        'WORKER_NOT_AUTHORIZED'].includes(stale.code));

    // Every lifecycle action uses the same preflight fence, including actions
    // carrying a stale expected revision or a replayed idempotency key.
    for (const action of ['start', 'renew', 'release', 'complete']) {
        const lifecycleRepo = new TaskActionRepository({ clock: () => now, leaseMs: 100 });
        await lifecycleRepo.initialize({});
        await lifecycleRepo.registerTask({
            ...personTask(), id: `lifecycle-${action}`,
            serviceExecutionTarget: {
                type: 'PERSON', departmentId: 'kitchen', workerId: 'alice'
            }
        });
        const claim = await lifecycleRepo.claim({
            companyId: 'company-a', taskId: `lifecycle-${action}`,
            idempotencyKey: `claim-${action}`, context: context('alice')
        });
        const denied = await lifecycleRepo[action]({
            companyId: 'company-a', taskId: `lifecycle-${action}`,
            idempotencyKey: `sibling-${action}`, expectedRevision: 999,
            leaseId: claim.task.claim.leaseId,
            context: context('bob', { departmentId: 'pastry' })
        });
        assert.strictEqual(denied.ok, false);
        assert.strictEqual(denied.code, 'WORKER_NOT_AUTHORIZED');
    }

    // The authorization fence wins over an action queued at the same time as
    // a suspension/PIN/membership mutation and closes the active lease.
    const fencedRepo = new TaskActionRepository({ clock: () => now, leaseMs: 100 });
    await fencedRepo.initialize({});
    await fencedRepo.registerTask(personTask({ id: 'fenced-task' }));
    const fencedClaim = await fencedRepo.claim({
        companyId: 'company-a', taskId: 'fenced-task',
        idempotencyKey: 'fenced-claim', context: context('alice')
    });
    const [fenceResult, raceAction] = await Promise.all([
        fencedRepo.advanceWorkerFence({
            companyId: 'company-a', workerId: 'alice',
            authorizationVersion: 2,
            worker: {
                id: 'alice', companyId: 'company-a', authorizationVersion: 2,
                departmentMemberships: [{
                    departmentId: 'kitchen', status: 'ACTIVE',
                    authorizationVersion: 2
                }]
            }, reason: 'WORKER_SUSPENDED'
        }),
        fencedRepo.start({
            companyId: 'company-a', taskId: 'fenced-task',
            idempotencyKey: 'race-start', leaseId: fencedClaim.task.claim.leaseId,
            expectedRevision: fencedClaim.revision,
            context: context('alice')
        })
    ]);
    assert.strictEqual(fenceResult.invalidated.length, 1);
    assert.strictEqual(raceAction.ok, false);
    assert.strictEqual(raceAction.code, 'WORKER_NOT_AUTHORIZED');
    assert.strictEqual((await fencedRepo.readTask('company-a', 'fenced-task')).claimLeaseStatus, 'INVALIDATED');

    const expiredProof = await fencedRepo.claim({
        companyId: 'company-a', taskId: 'fenced-task',
        idempotencyKey: 'expired-proof',
        context: context('alice', {
            authorizationVersion: 2, membershipAuthorizationVersion: 2,
            membershipValidUntil: now - 1
        })
    });
    assert.strictEqual(expiredProof.ok, false);
    assert.strictEqual(expiredProof.code, 'WORKER_NOT_AUTHORIZED');

    // Membership validity is an authoritative lifecycle boundary, not just
    // an authorization check. The next read materializes the invalidation.
    let boundaryNow = 100;
    const boundaryRepo = new TaskActionRepository({ clock: () => boundaryNow, leaseMs: 500 });
    await boundaryRepo.initialize({});
    await boundaryRepo.registerTask(personTask({ id: 'membership-boundary-task' }));
    await boundaryRepo.advanceWorkerFence({
        companyId: 'company-a', workerId: 'alice',
        worker: {
            id: 'alice', companyId: 'company-a', authorizationVersion: 1,
            departmentMemberships: [{
                departmentId: 'kitchen', status: 'ACTIVE',
                authorizationVersion: 1, validUntil: 150
            }]
        }
    });
    const boundaryClaim = await boundaryRepo.claim({
        companyId: 'company-a', taskId: 'membership-boundary-task',
        idempotencyKey: 'boundary-claim',
        context: context('alice', { membershipValidUntil: 150 })
    });
    assert.strictEqual(boundaryClaim.ok, true);
    boundaryNow = 151;
    const reconciledBoundary = await boundaryRepo.readTask(
        'company-a', 'membership-boundary-task');
    assert.strictEqual(reconciledBoundary.claimLeaseStatus, 'INVALIDATED');
    assert.strictEqual(reconciledBoundary.claimLeaseCloseReason, 'MEMBERSHIP_EXPIRED');
    assert.ok(reconciledBoundary.serviceActionRevision > boundaryClaim.revision);
    assert.ok(reconciledBoundary.history.some(item =>
        item.type === 'SERVICE_CLAIM_INVALIDATED' &&
        item.reason === 'MEMBERSHIP_EXPIRED'));
    const boundaryAction = await boundaryRepo.start({
        companyId: 'company-a', taskId: 'membership-boundary-task',
        idempotencyKey: 'boundary-start', leaseId: boundaryClaim.task.claim.leaseId,
        expectedRevision: boundaryClaim.revision,
        context: context('alice', { membershipValidUntil: 150 })
    });
    assert.strictEqual(boundaryAction.ok, false);
    assert.strictEqual(boundaryAction.code, 'WORKER_NOT_AUTHORIZED');

    // Eligible-worker projection is company and active-membership scoped.
    workers.setStore({
        'company-a': [{
            id: 'worker-a', workerId: 'worker-a', companyId: 'company-a',
            displayName: 'Alice', status: 'ACTIVE', serviceEnabled: true,
            departmentMemberships: [{ departmentId: 'kitchen', status: 'ACTIVE' }]
        }, {
            id: 'expired', workerId: 'expired', companyId: 'company-a',
            displayName: 'Expired', status: 'ACTIVE', serviceEnabled: true,
            departmentMemberships: [{ departmentId: 'kitchen', status: 'ACTIVE', validUntil: 1 }]
        }],
        'company-b': [{
            id: 'worker-b', workerId: 'worker-b', companyId: 'company-b',
            displayName: 'Other Co', status: 'ACTIVE', serviceEnabled: true,
            departmentMemberships: [{ departmentId: 'kitchen', status: 'ACTIVE' }]
        }]
    });
    const eligible = workers.getSelectableWorkers('company-a', 'kitchen')
        .filter(worker => worker.departmentMemberships.some(member =>
            member.departmentId === 'kitchen' && (!member.validUntil || member.validUntil >= Date.now())));
    assert.deepStrictEqual(eligible.map(worker => worker.id), ['worker-a']);
    assert.deepStrictEqual(workers.getSelectableWorkers('company-b', 'kitchen').map(worker => worker.id), ['worker-b']);
    const workerProjection = JSON.stringify(workers.projectWorker(eligible[0]));
    assert.ok(!workerProjection.includes('secretHash') && !workerProjection.includes('salt'));

    // Target management stays distinct from Operations assignee authority.
    const director = { id: 'director', companyId: 'company-a', role: 'DIRECTOR' };
    const manager = { id: 'chef', companyId: 'company-a', role: 'CHEF_CUISINE' };
    const task = { id: 't', companyId: 'company-a', createdBy: 'chef', assigneeId: 'chef' };
    assert.strictEqual(opsAuth.canManageServiceExecutionTarget(manager, task, {
        chef: manager
    }), true);
    assert.strictEqual(opsAuth.canManageServiceExecutionTarget({
        id: 'sous', companyId: 'company-a', role: 'SOUS_CHEF'
    }, { ...task, createdBy: 'sous', assigneeId: 'sous' }, {
        sous: { id: 'sous', companyId: 'company-a', role: 'SOUS_CHEF' }
    }), false);
    assert.strictEqual(opsAuth.canManageServiceExecutionTarget(director, {
        ...task, companyId: 'company-b'
    }, { chef: manager }), false);

    console.log('service-person-target.test.js: all checks passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});