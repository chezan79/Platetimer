#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { TaskActionRepository } = require('../service/task-action-repository');

class FakeFirestore {
    constructor() { this.docs = new Map(); this.queue = Promise.resolve(); }
    collection(name) {
        const db = this;
        return {
            doc(id) {
                const key = `${name}/${id}`;
                return {
                    key,
                    async get() {
                        const value = db.docs.get(key);
                        return { exists: value !== undefined, data: () => value && JSON.parse(JSON.stringify(value)) };
                    }
                };
            },
            where(field, op, value) {
                return {
                    async get() {
                        const docs = [];
                        for (const [key, data] of db.docs) {
                            if (key.startsWith(`${name}/`) && data && data[field] === value) {
                                docs.push({ id: key.slice(name.length + 1), data: () => data });
                            }
                        }
                        return { docs };
                    }
                };
            }
        };
    }
    async runTransaction(callback) {
        let output;
        const work = this.queue.then(async () => {
            const writes = [];
            const transaction = {
                get: ref => ref.get(),
                set: (ref, value) => writes.push({ type: 'set', ref, value }),
                delete: ref => writes.push({ type: 'delete', ref })
            };
            output = await callback(transaction);
            for (const write of writes) {
                if (write.type === 'delete') this.docs.delete(write.ref.key);
                else {
                    const prior = this.docs.get(write.ref.key) || {};
                    this.docs.set(write.ref.key, { ...prior, ...JSON.parse(JSON.stringify(write.value)) });
                }
            }
        });
        this.queue = work.catch(() => {});
        await work;
        return output;
    }
}

let now = 1_000;
const context = (workerId, overrides = {}) => ({
    workerId, workerName: workerId, companyId: 'co', departmentId: 'kitchen',
    departmentName: 'Kitchen', accountStatus: 'ACTIVE', departmentActive: true,
    membershipActive: true, workerActive: true, serviceEnabled: true,
    authorizationVersion: 1, membershipAuthorizationVersion: 1, ...overrides
});
const task = (extra = {}) => ({
    id: 'task-1', companyId: 'co', title: 'Prepare station', status: 'OPEN',
    publishToService: true, serviceDepartmentId: 'kitchen', history: [], ...extra
});

async function fresh(options = {}) {
    const repo = new TaskActionRepository({ clock: () => now, leaseMs: 100, maxLeaseMs: 300, ...options });
    await repo.initialize({});
    await repo.registerTask(task());
    return repo;
}

async function main() {
    // Firestore transaction simulation: concurrent duplicate requests must
    // replay the one committed idempotency result, not produce a conflict.
    now = 500;
    const firestore = new FakeFirestore();
    const firestoreRepo = new TaskActionRepository({ firestore, clock: () => now });
    await firestoreRepo.initialize();
    await firestoreRepo.ensureTask(task());
    const duplicate = await Promise.all([
        firestoreRepo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'same', context: context('alice') }),
        firestoreRepo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'same', context: context('alice') })
    ]);
    assert.strictEqual(duplicate[0].ok, true);
    assert.strictEqual(duplicate[1].idempotent, true);
    await firestoreRepo.ensureTask({ ...task(), title: 'stale title' });
    assert.strictEqual((await firestoreRepo.readTask('co', 'task-1')).title, 'Prepare station');
    await firestoreRepo.ensureTask({ ...task(), id: 'task-2' });
    const fsAckClaim = await Promise.all([
        firestoreRepo.acknowledge({ companyId: 'co', taskId: 'task-2', departmentId: 'kitchen', idempotencyKey: 'ack-fs' }),
        firestoreRepo.claim({ companyId: 'co', taskId: 'task-2', idempotencyKey: 'claim-fs', context: context('bob') })
    ]);
    assert.strictEqual(fsAckClaim.filter(result => result.ok).length, 1);

    // Atomic first-writer-wins race.
    let repo = await fresh();
    const race = await Promise.all([
        repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'a', context: context('alice') }),
        repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'b', context: context('bob') })
    ]);
    assert.strictEqual(race.filter(item => item.ok).length, 1);
    assert.strictEqual(race.filter(item => item.code === 'ALREADY_CLAIMED').length, 1);

    // Same request replays the committed result; a reused key with another
    // payload is rejected without changing task state.
    const winner = race.find(item => item.ok);
    const worker = winner.task.claim.workerId;
    const replay = await repo.claim({
        companyId: 'co', taskId: 'task-1', idempotencyKey: worker === 'alice' ? 'a' : 'b',
        context: context(worker)
    });
    assert.strictEqual(replay.idempotent, true);
    const idemConflict = await repo.claim({
        companyId: 'co', taskId: 'task-1', idempotencyKey: worker === 'alice' ? 'a' : 'b',
        context: context(worker, { departmentId: 'other' })
    });
    assert.strictEqual(idemConflict.code, 'IDEMPOTENCY_CONFLICT');

    // Stale revisions, start, completion freshness and terminal replay.
    const stale = await repo.start({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'stale',
        expectedRevision: 0, leaseId: winner.task.claim.leaseId, context: context(worker)
    });
    assert.strictEqual(stale.code, 'TASK_VERSION_CONFLICT');
    const started = await repo.start({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'start',
        expectedRevision: winner.revision, leaseId: winner.task.claim.leaseId, context: context(worker)
    });
    assert.strictEqual(started.ok, true);
    const completed = await repo.complete({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'complete',
        leaseId: winner.task.claim.leaseId, proofIssuedAt: now,
        context: context(worker)
    });
    assert.strictEqual(completed.ok, true);
    assert.strictEqual(completed.task.status, 'COMPLETED');
    assert.ok(repo.getHistory('co', 'task-1').some(item => item.type === 'SERVICE_COMPLETED'));

    // Expiry is observed and closed atomically; a later worker can reclaim.
    now = 2_000;
    repo = await fresh();
    const first = await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'first', context: context('alice') });
    now += 101;
    const second = await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'second', context: context('bob') });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.task.claim.workerId, 'bob');
    assert.ok(repo.getHistory('co', 'task-1').some(item => item.type === 'SERVICE_CLAIM_EXPIRED'));
    assert.strictEqual((await repo.renew({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'old-renew',
        leaseId: first.task.claim.leaseId, context: context('alice')
    })).code, 'NOT_CLAIMANT');

    // Authoritative reads materialize abandoned lease expiry, so clients can
    // discover a reclaimable task without the original claimant acting.
    now = 2_500;
    repo = await fresh();
    await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'abandoned', context: context('alice') });
    now += 101;
    const expiredOnRead = await repo.readTask('co', 'task-1', { materializeExpiry: true });
    assert.strictEqual(expiredOnRead.claimLeaseStatus, 'EXPIRED');
    assert.strictEqual(Object.keys(repo.getState().activeLeases).length, 0);
    assert.strictEqual((await repo.claim({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'after-read-expiry', context: context('bob')
    })).ok, true);

    // Renewal cap, release, and subsequent reclaim.
    now = 3_000;
    repo = await fresh();
    const claim = await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'claim', context: context('alice') });
    const renewed = await repo.renew({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'renew',
        leaseId: claim.task.claim.leaseId, context: context('alice')
    });
    assert.ok(renewed.task.claim.expiresAt <= now + 300);
    assert.strictEqual((await repo.release({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'release',
        leaseId: claim.task.claim.leaseId, context: context('alice')
    })).ok, true);
    assert.strictEqual((await repo.claim({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'reclaim', context: context('bob')
    })).ok, true);

    // Worker/membership revocation fails closed against the captured versions.
    repo = await fresh();
    const revoked = await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'claim', context: context('alice') });
    const denied = await repo.start({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'revoked',
        leaseId: revoked.task.claim.leaseId, context: context('alice', { authorizationVersion: 2 })
    });
    assert.strictEqual(denied.code, 'WORKER_REVOKED');

    // Operations move/unpublish invalidates the lease and records attribution.
    repo = await fresh();
    await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'claim', context: context('alice') });
    const moved = await repo.syncTask({
        ...task(), serviceDepartmentId: 'bar', serviceActionRevision: 1
    }, { reason: 'SERVICE_DEPARTMENT_MOVED', actorId: 'ops-1', actorKind: 'OPERATIONS_USER' });
    assert.strictEqual(moved.task.claim.status, 'INVALIDATED');
    assert.ok(repo.getHistory('co', 'task-1').some(item => item.type === 'SERVICE_CLAIM_INVALIDATED'));

    // Acknowledgement is checked by the HTTP boundary, but repository claim
    // also supports the explicit acknowledged input as a fail-closed guard.
    repo = await fresh();
    assert.strictEqual((await repo.claim({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'ack',
        acknowledged: true, context: context('alice')
    })).code, 'TASK_ACKNOWLEDGED');

    // Persistence failure cannot expose a partially committed claim.
    let fail = false;
    repo = await fresh({ persist: async () => { if (fail) throw new Error('simulated persistence failure'); } });
    const before = repo.getRawTask('co', 'task-1');
    fail = true;
    await assert.rejects(() => repo.claim({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'failure', context: context('alice')
    }), /simulated persistence failure/);
    assert.deepStrictEqual(repo.getRawTask('co', 'task-1'), before);

    // Operations can explicitly override an active claim.
    fail = false;
    repo = await fresh();
    const overrideClaim = await repo.claim({
        companyId: 'co', taskId: 'task-1', idempotencyKey: 'claim', context: context('alice')
    });
    const override = await repo.overrideRelease({
        companyId: 'co', taskId: 'task-1',
        leaseId: overrideClaim.task.claim.leaseId,
        expectedRevision: overrideClaim.revision,
        actorId: 'ops-1', actorName: 'Director', reason: 'SHIFT_HANDOFF'
    });
    assert.strictEqual(override.ok, true);
    assert.strictEqual(repo.getRawTask('co', 'task-1').claimLeaseStatus, 'INVALIDATED');

    // Materialized active-lease indexes are idempotent under repeated
    // revocation notifications.
    repo = await fresh();
    await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'claim', context: context('alice') });
    assert.strictEqual(Object.keys(repo.getState().activeLeases).length, 2);
    const revokedOnce = await repo.invalidateForWorker({ companyId: 'co', workerId: 'alice', reason: 'PIN_VERIFIER_CHANGED' });
    const revokedTwice = await repo.invalidateForWorker({ companyId: 'co', workerId: 'alice', reason: 'PIN_VERIFIER_CHANGED' });
    assert.strictEqual(revokedOnce.count, 1);
    assert.strictEqual(revokedTwice.count, 0);
    assert.strictEqual(Object.keys(repo.getState().activeLeases).length, 0);

    repo = await fresh();
    await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'claim', context: context('alice') });
    const removed = await repo.removeTask('co', 'task-1', { reason: 'OPERATIONS_DELETED' });
    assert.strictEqual(removed.removed, true);
    assert.strictEqual(repo.getRawTask('co', 'task-1').publishToService, false);
    assert.strictEqual(repo.getRawTask('co', 'task-1').claimLeaseStatus, 'INVALIDATED');

    // Acknowledgement and claim share the same authoritative transaction:
    // exactly one wins, regardless of scheduling order.
    repo = await fresh();
    const ackClaim = await Promise.all([
        repo.acknowledge({ companyId: 'co', taskId: 'task-1', departmentId: 'kitchen', idempotencyKey: 'ack-1' }),
        repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'claim-1', context: context('alice') })
    ]);
    assert.strictEqual(ackClaim.filter(result => result.ok).length, 1);
    const authoritative = repo.getRawTask('co', 'task-1');
    assert.strictEqual(Boolean(authoritative.acknowledgements && authoritative.acknowledgements.kitchen),
        ackClaim[0].ok);
    assert.strictEqual(authoritative.claimLeaseStatus === 'ACTIVE', ackClaim[1].ok);

    // A stale whole-task projection cannot overwrite newer recoverable
    // metadata, while an equal-revision Operations edit explicitly can.
    repo = await fresh();
    await repo.syncTask({ ...task(), title: 'Authoritative edit', description: 'body', serviceActionRevision: 1 });
    await repo.syncTask({ ...task(), title: 'stale edit', description: 'stale', serviceActionRevision: 0 });
    assert.strictEqual(repo.getRawTask('co', 'task-1').title, 'Authoritative edit');
    await repo.syncTask({
        ...task(), title: 'new Operations edit',
        serviceActionRevision: repo.getRawTask('co', 'task-1').serviceActionRevision
    }, { allowMetadataOverwrite: true });
    assert.strictEqual(repo.getRawTask('co', 'task-1').title, 'new Operations edit');

    repo = await fresh();
    const firstClaim = await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'claim-one', context: context('alice') });
    await repo.release({ companyId: 'co', taskId: 'task-1', leaseId: firstClaim.task.claim.leaseId, idempotencyKey: 'release-one', context: context('alice') });
    const secondClaim = await repo.claim({ companyId: 'co', taskId: 'task-1', idempotencyKey: 'claim-two', context: context('bob') });
    const missingLeaseOverride = await repo.overrideRelease({
        companyId: 'co', taskId: 'task-1',
        expectedRevision: secondClaim.revision, reason: 'DIRECTOR_OVERRIDE', actorId: 'director'
    });
    assert.strictEqual(missingLeaseOverride.code, 'INVALID_ACTION_REQUEST');
    const staleLeaseOverride = await repo.overrideRelease({
        companyId: 'co', taskId: 'task-1', leaseId: firstClaim.task.claim.leaseId,
        expectedRevision: secondClaim.revision, reason: 'DIRECTOR_OVERRIDE', actorId: 'director'
    });
    assert.strictEqual(staleLeaseOverride.code, 'CLAIM_LEASE_CONFLICT');
    assert.strictEqual(repo.getRawTask('co', 'task-1').claimLeaseId, secondClaim.task.claim.leaseId);
    assert.strictEqual(repo.getRawTask('co', 'task-1').claimLeaseStatus, 'ACTIVE');
    const overrideAfterReclaim = await repo.overrideRelease({
        companyId: 'co', taskId: 'task-1', leaseId: secondClaim.task.claim.leaseId,
        expectedRevision: secondClaim.revision, reason: 'DIRECTOR_OVERRIDE', actorId: 'director'
    });
    assert.strictEqual(overrideAfterReclaim.ok, true);
    assert.strictEqual(overrideAfterReclaim.idempotent, undefined);
    assert.strictEqual(repo.getRawTask('co', 'task-1').claimLeaseStatus, 'INVALIDATED');

    console.log('Service task action repository: all checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });