'use strict';

/*
 * Transactional Service task lifecycle repository.
 *
 * The Operations task store predates Service worker actions and is deliberately
 * not used as a compare-and-set store.  This repository owns the Service
 * lifecycle portion of a task (revision, lease, idempotency and history) and
 * commits that portion as one unit.  Firestore uses one transaction-addressable
 * document per company/task.  Local development uses one process mutex and an
 * atomic replace; it is intentionally not advertised as multi-process safe.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const executionTargets = require('./execution-target');

const ACTIVE_STATUSES = new Set(['OPEN', 'IN_PROGRESS']);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELLED']);
const LEASE_STATUSES = new Set(['ACTIVE', 'RELEASED', 'EXPIRED', 'INVALIDATED', 'COMPLETED']);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function fail(code, error, extra = {}) {
    return { ok: false, code, error, ...extra };
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function nowValue(clock) {
    const value = typeof clock === 'function' ? clock() : Date.now();
    return Number.isFinite(value) ? value : Date.now();
}
function id() { return `svcact_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`; }
function taskKey(companyId, taskId) {
    return `${String(companyId)}::${String(taskId)}`;
}
function fingerprint(input) {
    return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
function safeWorker(worker) {
    if (!worker) return null;
    return { id: worker.id || worker.workerId, displayName: worker.displayName || '' };
}

class TaskActionRepository {
    constructor(options = {}) {
        this.db = options.firestore || options.db || null;
        this.collectionName = options.collectionName || 'service_task_actions';
        this.filePath = options.filePath || options.path || null;
        this.clock = options.clock || Date.now;
        this.leaseMs = Number(options.leaseMs) > 0 ? Number(options.leaseMs) : 15 * 60 * 1000;
        this.maxLeaseMs = Number(options.maxLeaseMs) > 0 ? Number(options.maxLeaseMs) : 60 * 60 * 1000;
        this.completionFreshnessMs = Number(options.completionFreshnessMs) > 0
            ? Number(options.completionFreshnessMs) : 5 * 60 * 1000;
        this.persist = typeof options.persist === 'function' ? options.persist : null;
        this.state = {
            tasks: {},
            idempotency: {},
            history: {},
            activeLeases: {},
            authorizationFences: {}
        };
        this.queue = Promise.resolve();
    }

    async initialize(seed) {
        if (this.db) return this;
        if (seed && typeof seed === 'object') {
            this.state = this._normaliseStore(seed);
            return this;
        }
        if (!this.filePath) return this;
        try {
            if (fs.existsSync(this.filePath)) {
                this.state = this._normaliseStore(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
            }
        } catch (error) {
            throw new Error(`Unable to load Service task action store: ${error.message}`);
        }
        return this;
    }
    setState(value) { this.state = this._normaliseStore(value); return this; }
    getState() { return clone(this.state); }

    _normaliseStore(value) {
        value = value && typeof value === 'object' ? value : {};
        return {
            tasks: value.tasks && typeof value.tasks === 'object' ? value.tasks : {},
            idempotency: value.idempotency && typeof value.idempotency === 'object' ? value.idempotency : {},
            history: value.history && typeof value.history === 'object' ? value.history : {},
            activeLeases: value.activeLeases && typeof value.activeLeases === 'object' ? value.activeLeases : {},
            authorizationFences: value.authorizationFences && typeof value.authorizationFences === 'object'
                ? value.authorizationFences : {}
        };
    }

    _enqueue(work) {
        const result = this.queue.then(work, work);
        this.queue = result.catch(() => {});
        return result;
    }

    _ref(companyId, taskId) {
        return this.db.collection(this.collectionName).doc(taskKey(companyId, taskId));
    }
    taskRef(companyId, taskId) {
        return this.db ? this._ref(companyId, taskId) : null;
    }
    _indexRef(companyId, taskId, kind, value) {
        return this.db.collection(`${this.collectionName}_active_leases`)
            .doc(`${companyId}::${kind}::${value}::${taskId}`);
    }
    _fenceKey(companyId, workerId) {
        return `${String(companyId)}::${String(workerId)}`;
    }
    _fenceRef(companyId, workerId) {
        return this.db.collection(`${this.collectionName}_authorization_fences`)
            .doc(this._fenceKey(companyId, workerId));
    }
    _leaseIndex(task) {
        if (!task || task.claimLeaseStatus !== 'ACTIVE') return [];
        return [
            { kind: 'worker', value: task.claimedByWorkerId },
            { kind: 'department', value: task.claimDepartmentId }
        ].filter(item => item.value);
    }
    _transactionIndexUpdate(transaction, companyId, taskId, before, task) {
        const oldIndexes = this._leaseIndex(before);
        const newIndexes = this._leaseIndex(task);
        for (const index of oldIndexes) {
            if (!newIndexes.some(item => item.kind === index.kind && item.value === index.value)) {
                transaction.delete(this._indexRef(companyId, taskId, index.kind, index.value));
            }
        }
        for (const index of newIndexes) {
            transaction.set(this._indexRef(companyId, taskId, index.kind, index.value), {
                companyId, taskId, workerId: task.claimedByWorkerId || null,
                departmentId: task.claimDepartmentId || null, leaseId: task.claimLeaseId || null,
                expiresAt: task.claimLeaseExpiresAt || null, updatedAt: nowValue(this.clock)
            }, { merge: true });
        }
    }

    _fenceFromWorker(input) {
        const worker = input.worker || input;
        const memberships = {};
        for (const member of worker.departmentMemberships || []) {
            if (member && member.departmentId) {
                memberships[member.departmentId] = {
                    authorizationVersion: Number(member.authorizationVersion || 0),
                    validFrom: member.validFrom == null ? null : Number(member.validFrom),
                    validUntil: member.validUntil == null ? null : Number(member.validUntil)
                };
            }
        }
        return {
            companyId: input.companyId || worker.companyId,
            workerId: input.workerId || worker.id || worker.workerId,
            authorizationVersion: Number(worker.authorizationVersion || input.authorizationVersion || 0),
            membershipAuthorizationVersions: memberships,
            revocationEpoch: Number(input.revocationEpoch || 0),
            updatedAt: nowValue(this.clock),
            reason: input.reason || 'WORKER_AUTHORIZATION_CHANGED'
        };
    }

    _fenceAllows(context, fence) {
        if (!fence) return true; // legacy tasks/workers are fenced on next mutation
        if (!context || context.authorizationVersion == null ||
            Number(context.authorizationVersion) !== Number(fence.authorizationVersion)) return false;
        const membership = fence.membershipAuthorizationVersions &&
            fence.membershipAuthorizationVersions[context.departmentId];
        if (!membership || context.membershipAuthorizationVersion == null ||
            Number(context.membershipAuthorizationVersion) !== Number(membership.authorizationVersion)) return false;
        if (fence.revocationEpoch != null &&
            Number(context.proofEpoch || 0) !== Number(fence.revocationEpoch)) return false;
        const now = nowValue(this.clock);
        if (membership.validFrom != null && now < Number(membership.validFrom)) return false;
        if (membership.validUntil != null && now > Number(membership.validUntil)) return false;
        return true;
    }

    _authorizationDenied() {
        // Never attach a task, revision, claimant, or idempotency outcome to
        // an authorization failure. This is used before all replay/CAS paths.
        return fail(403, 'Worker is not authorized for this task.', {
            code: 'WORKER_NOT_AUTHORIZED'
        });
    }

    _authorizationGate(input, task, fence) {
        if (input.action === 'override' || (input.context && input.context.actorKind === 'OPERATIONS_USER')) {
            return null;
        }
        const context = input.context || {};
        const target = executionTargets.effectiveTarget(task);
        const identityMatchesTarget = task && task.companyId === context.companyId &&
            target && target.type !== executionTargets.ROLE &&
            target.departmentId === context.departmentId &&
            (target.type !== executionTargets.PERSON || target.workerId === context.workerId);
        const entitled = input.allowAuthorizedReplay
            ? identityMatchesTarget
            : this._entitled(task, context);
        if (!this._workerValid(context, task, false) ||
            !this._fenceAllows(context, fence) ||
            !entitled) {
            return this._authorizationDenied();
        }
        return null;
    }

    _stateFor(task, previous, options = {}) {
        const value = clone(task || {});
        const target = executionTargets.effectiveTarget(value);
        value.serviceExecutionTarget = target;
        value.serviceDepartmentId = target ? target.departmentId : null;
        value.serviceExecutionTargetVersion = Number(value.serviceExecutionTargetVersion || 0);
        const old = previous || {};
        const incomingRevision = Number(value.serviceActionRevision || 0);
        const oldRevision = Number(old.serviceActionRevision || 0);
        // A target mutation is itself an authoritative Service-state change.
        // Do not let a stale action revision discard it before the invalidation
        // check can close an incompatible active lease.
        const targetChanged = previous &&
            JSON.stringify(target) !== JSON.stringify(executionTargets.effectiveTarget(old));
        const preserveServiceState = previous && incomingRevision <= oldRevision && !targetChanged;
        if (previous && incomingRevision < oldRevision && !targetChanged) {
            return clone(old);
        }
        if (previous && preserveServiceState && !options.allowMetadataOverwrite) {
            // The transaction document is authoritative. A legacy Operations
            // projection may be stale in every field, not just its lease.
            return clone(old);
        }
        if (previous && incomingRevision < oldRevision) {
            // A stale Operations projection must not resurrect a task that a
            // committed Service action already started or completed.
            for (const field of ['status', 'completionPercent', 'startedAt', 'completedAt']) {
                if (old[field] !== undefined) value[field] = clone(old[field]);
            }
        }
        for (const field of [
            'claimedByWorkerId', 'claimedByWorkerName', 'claimedAt',
            'claimDepartmentId', 'claimDepartmentName', 'claimLeaseId',
            'claimLeaseExpiresAt', 'claimLeaseAbsoluteExpiresAt',
            'claimLeaseStatus', 'claimLeaseClosedAt', 'claimLeaseCloseReason',
            'claimWorkerAuthorizationVersion', 'claimMembershipAuthorizationVersion',
            'claimMembershipValidFrom', 'claimMembershipValidUntil',
            'startedByWorkerId', 'startedByWorkerName', 'completedByWorkerId',
            'completedByWorkerName'
        ]) {
            if (old[field] !== undefined && (value[field] === undefined || preserveServiceState || options.allowMetadataOverwrite)) {
                value[field] = clone(old[field]);
            }
        }
        value.serviceActionRevision = preserveServiceState
            ? oldRevision : Number(value.serviceActionRevision ?? old.serviceActionRevision ?? 0);
        value.claimLeaseStatus = value.claimLeaseStatus || old.claimLeaseStatus || null;
        if (Array.isArray(old.history)) {
            const seen = new Set((Array.isArray(value.history) ? value.history : []).map(item => item && item.id));
            value.history = [
                ...(Array.isArray(value.history) ? value.history : []),
                ...old.history.filter(item => item && !seen.has(item.id)).map(clone)
            ];
        } else if (!Array.isArray(value.history)) value.history = [];
        return value;
    }

    _recordHistory(task, event, context = {}, extra = {}) {
        const at = nowValue(this.clock);
        const entry = {
            id: id(),
            type: event,
            actorKind: context.actorKind || 'SERVICE_WORKER',
            actorId: context.workerId || context.actorId || null,
            actorName: context.workerName || context.actorName || null,
            departmentAccountId: context.departmentAccountId || null,
            departmentId: context.departmentId || null,
            departmentName: context.departmentName || null,
            verificationStrength: context.verificationStrength || 'WORKER_PROOF',
            at,
            ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
            ...extra
        };
        if (!Array.isArray(task.history)) task.history = [];
        task.history.push(entry);
        return entry;
    }

    _safeTask(task) {
        if (!task) return null;
        const result = {
            id: task.id,
            title: task.title,
            description: task.description,
            dueDate: task.dueDate,
            priority: task.priority,
            status: task.status,
            serviceDepartmentId: task.serviceDepartmentId,
            serviceExecutionTarget: executionTargets.effectiveTarget(task),
            serviceExecutionTargetVersion: Number(task.serviceExecutionTargetVersion || 0),
            serviceDepartmentName: task.serviceDepartmentName,
            source: 'OPERATIONS',
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            serviceActionRevision: Number(task.serviceActionRevision || 0),
            claimLeaseStatus: task.claimLeaseStatus || null,
            claimLeaseId: task.claimLeaseId || null,
            claimLeaseExpiresAt: task.claimLeaseExpiresAt || null,
            claimedByWorkerName: task.claimedByWorkerName || null,
            claim: task.claimLeaseStatus ? {
                workerId: task.claimedByWorkerId || null,
                workerName: task.claimedByWorkerName || null,
                departmentId: task.claimDepartmentId || null,
                leaseId: task.claimLeaseId || null,
                status: task.claimLeaseStatus,
                expiresAt: task.claimLeaseExpiresAt || null,
                claimedAt: task.claimedAt || null,
                startedAt: task.startedAt || null
            } : null
        };
        return result;
    }

    _entitled(task, context) {
        const target = executionTargets.effectiveTarget(task);
        const targetWorkerAllowed = target && target.type !== executionTargets.ROLE &&
            (target.type !== executionTargets.PERSON || target.workerId === context.workerId);
        return task && task.companyId === context.companyId &&
            task.publishToService === true &&
            target && target.departmentId === context.departmentId &&
            targetWorkerAllowed &&
            ACTIVE_STATUSES.has(task.status);
    }

    _workerValid(context, task, requireClaim = false) {
        if (!context || !context.workerId || context.companyId == null || context.departmentId == null) return false;
        if (context.accountStatus && context.accountStatus !== 'ACTIVE') return false;
        if (context.departmentActive === false || context.membershipActive === false ||
            context.workerActive === false || context.serviceEnabled === false) return false;
        const now = nowValue(this.clock);
        if (context.membershipValidFrom != null && now < Number(context.membershipValidFrom)) return false;
        if (context.membershipValidUntil != null && now > Number(context.membershipValidUntil)) return false;
        if (task && task.claimWorkerAuthorizationVersion != null &&
            context.authorizationVersion != null &&
            task.claimWorkerAuthorizationVersion !== context.authorizationVersion && requireClaim) return false;
        if (task && task.claimMembershipAuthorizationVersion != null &&
            context.membershipAuthorizationVersion != null &&
            task.claimMembershipAuthorizationVersion !== context.membershipAuthorizationVersion && requireClaim) return false;
        return true;
    }

    _key(input) {
        return [
            input.companyId, input.taskId, input.action, input.workerId || 'none',
            input.idempotencyKey
        ].map(String).join('::');
    }

    _requestFingerprint(input) {
        return fingerprint({
            action: input.action,
            expectedRevision: input.expectedRevision == null ? null : Number(input.expectedRevision),
            leaseId: input.leaseId || null,
            reason: input.reason || null,
            workerId: input.workerId || null,
            departmentId: input.context && input.context.departmentId || input.departmentId || null
        });
    }

    _validateInput(input) {
        const companyId = text(input && input.companyId);
        const taskId = text(input && input.taskId);
        const action = text(input && input.action).toLowerCase();
        const key = text(input && (input.idempotencyKey || input.requestId));
        if (!companyId || !taskId || !key) return fail(400, 'companyId, taskId, action and idempotencyKey are required.', { code: 'INVALID_ACTION_REQUEST' });
        if (!['claim', 'start', 'renew', 'release', 'complete', 'override'].includes(action)) {
            return fail(400, 'Unknown Service task action.', { code: 'INVALID_ACTION_REQUEST' });
        }
        return { ok: true, companyId, taskId, action, idempotencyKey: key };
    }

    _expired(task, now) {
        return task.claimLeaseStatus === 'ACTIVE' && Number(task.claimLeaseExpiresAt) <= now;
    }

    _membershipExpired(task, fence, now) {
        if (!task || task.claimLeaseStatus !== 'ACTIVE') return false;
        const member = fence && fence.membershipAuthorizationVersions &&
            fence.membershipAuthorizationVersions[task.claimDepartmentId];
        const until = member && member.validUntil != null
            ? member.validUntil : task.claimMembershipValidUntil;
        return until != null && Number(until) <= now;
    }

    _closeMembershipExpired(task, now) {
        if (!task || task.claimLeaseStatus !== 'ACTIVE') return false;
        const from = task.claimLeaseStatus;
        task.claimLeaseStatus = 'INVALIDATED';
        task.claimLeaseClosedAt = now;
        task.claimLeaseCloseReason = 'MEMBERSHIP_EXPIRED';
        task.serviceActionRevision = Number(task.serviceActionRevision || 0) + 1;
        this._recordHistory(task, 'SERVICE_CLAIM_INVALIDATED', {
            actorKind: 'SYSTEM',
            departmentId: task.claimDepartmentId
        }, {
            reason: 'MEMBERSHIP_EXPIRED',
            fromLeaseStatus: from,
            toLeaseStatus: 'INVALIDATED'
        });
        return true;
    }

    _closeExpired(task, context, now) {
        if (!this._expired(task, now)) return false;
        const from = task.claimLeaseStatus;
        task.claimLeaseStatus = 'EXPIRED';
        task.claimLeaseClosedAt = now;
        task.claimLeaseCloseReason = 'LEASE_EXPIRED';
        task.serviceActionRevision++;
        this._recordHistory(task, 'SERVICE_CLAIM_EXPIRED', {
            ...context, actorKind: 'SYSTEM'
        }, { fromLeaseStatus: from, toLeaseStatus: 'EXPIRED', fromStatus: task.status, toStatus: task.status });
        return true;
    }

    _baseOutcome(task, action, extra = {}) {
        return {
            ok: true,
            success: true,
            action,
            task: this._safeTask(task),
            revision: Number(task.serviceActionRevision || 0),
            ...extra
        };
    }

    _perform(input, task) {
        const context = input.context || {};
        const now = nowValue(this.clock);
        const expected = input.expectedRevision;
        if (expected != null && Number(expected) !== Number(task.serviceActionRevision || 0)) {
            return fail(409, 'Task revision is stale.', {
                code: 'TASK_VERSION_CONFLICT',
                revision: Number(task.serviceActionRevision || 0),
                task: this._safeTask(task)
            });
        }
        if (input.action === 'override') {
            if (context.actorKind !== 'OPERATIONS_USER') {
                return fail(403, 'Operations authority is required to override a Service claim.', { code: 'OVERRIDE_NOT_AUTHORIZED' });
            }
            if (!text(input.leaseId)) {
                return fail(400, 'The active claim lease ID is required.', { code: 'INVALID_ACTION_REQUEST' });
            }
            if (task.claimLeaseStatus !== 'ACTIVE') {
                return fail(409, 'There is no active Service claim to override.', {
                    code: 'NO_ACTIVE_CLAIM', revision: task.serviceActionRevision
                });
            }
            if (input.leaseId !== task.claimLeaseId) {
                return fail(409, 'The Service claim lease has changed.', {
                    code: 'CLAIM_LEASE_CONFLICT',
                    revision: task.serviceActionRevision,
                    task: this._safeTask(task)
                });
            }
            task.claimLeaseStatus = 'INVALIDATED';
            task.claimLeaseClosedAt = now;
            task.claimLeaseCloseReason = input.reason || 'OPERATIONS_OVERRIDE';
            task.serviceActionRevision++;
            this._recordHistory(task, 'SERVICE_CLAIM_OVERRIDE_RELEASED', context, {
                reason: task.claimLeaseCloseReason, fromStatus: task.status, toStatus: task.status
            });
            return this._baseOutcome(task, 'override');
        }
        if (!this._workerValid(context, task, input.action !== 'claim')) {
            return fail(403, 'Worker is no longer authorized for this task.', { code: 'WORKER_REVOKED' });
        }
        if (this._expired(task, now)) {
            if (input.action !== 'claim') {
                this._closeExpired(task, context, now);
                return fail(409, 'The claim lease has expired.', {
                    code: 'LEASE_EXPIRED', revision: task.serviceActionRevision, task: this._safeTask(task)
                });
            }
            this._closeExpired(task, context, now);
        }
        if (input.action === 'claim') {
            if (!this._entitled(task, context)) {
                return fail(409, 'Task is no longer published to this department.', { code: 'TASK_NOT_ENTITLED' });
            }
            const departmentAck = task.acknowledgements &&
                task.acknowledgements[context.departmentId];
            if (input.acknowledged || departmentAck) {
                return fail(409, 'Task has already been acknowledged by this department.', { code: 'TASK_ACKNOWLEDGED' });
            }
            if (task.claimLeaseStatus === 'ACTIVE') {
                return fail(409, 'Task is already claimed by another worker.', {
                    code: 'ALREADY_CLAIMED', claimantName: task.claimedByWorkerName || null,
                    revision: task.serviceActionRevision
                });
            }
            const leaseId = input.leaseId || id();
            task.claimedByWorkerId = context.workerId;
            task.claimedByWorkerName = context.workerName || '';
            task.claimedAt = now;
            task.claimDepartmentId = context.departmentId;
            task.claimDepartmentName = context.departmentName || '';
            task.claimLeaseId = leaseId;
            task.claimLeaseExpiresAt = now + this.leaseMs;
            task.claimLeaseAbsoluteExpiresAt = now + this.maxLeaseMs;
            task.claimLeaseStatus = 'ACTIVE';
            task.claimLeaseClosedAt = null;
            task.claimLeaseCloseReason = null;
            task.claimWorkerAuthorizationVersion = context.authorizationVersion ?? null;
            task.claimMembershipAuthorizationVersion = context.membershipAuthorizationVersion ?? null;
            task.claimMembershipValidFrom = context.membershipValidFrom ?? null;
            task.claimMembershipValidUntil = context.membershipValidUntil ?? null;
            task.serviceActionRevision++;
            this._recordHistory(task, 'SERVICE_CLAIMED', context, {
                fromStatus: task.status, toStatus: task.status, leaseId,
                leaseExpiresAt: task.claimLeaseExpiresAt
            });
            return this._baseOutcome(task, 'claim');
        }
        if (TERMINAL_STATUSES.has(task.status)) {
            return fail(409, 'Task is no longer active.', { code: 'TASK_TERMINAL', revision: task.serviceActionRevision });
        }
        if (!this._entitled(task, context)) {
            return fail(409, 'Task is no longer published to this department.', { code: 'TASK_NOT_ENTITLED' });
        }
        if (task.claimLeaseStatus !== 'ACTIVE' ||
            task.claimedByWorkerId !== context.workerId ||
            (input.leaseId && input.leaseId !== task.claimLeaseId)) {
            return fail(409, 'Worker does not hold the active claim.', { code: 'NOT_CLAIMANT', task: this._safeTask(task) });
        }
        if (input.action === 'renew') {
            const expiry = Math.min(now + this.leaseMs, Number(task.claimLeaseAbsoluteExpiresAt || now + this.maxLeaseMs));
            if (expiry <= now) return fail(409, 'The claim lease cannot be renewed.', { code: 'LEASE_EXPIRED' });
            const previousExpiry = task.claimLeaseExpiresAt;
            task.claimLeaseExpiresAt = expiry;
            task.serviceActionRevision++;
            this._recordHistory(task, 'SERVICE_CLAIM_RENEWED', context, {
                previousExpiresAt: previousExpiry, newExpiresAt: expiry,
                fromStatus: task.status, toStatus: task.status
            });
            return this._baseOutcome(task, 'renew');
        }
        if (input.action === 'release') {
            task.claimLeaseStatus = 'RELEASED';
            task.claimLeaseClosedAt = now;
            task.claimLeaseCloseReason = 'WORKER_RELEASED';
            task.serviceActionRevision++;
            this._recordHistory(task, 'SERVICE_RELEASED', context, {
                fromStatus: task.status, toStatus: task.status, leaseId: task.claimLeaseId
            });
            return this._baseOutcome(task, 'release');
        }
        if (input.action === 'start') {
            if (task.status !== 'OPEN') return fail(409, 'Task cannot be started in its current state.', { code: 'INVALID_TRANSITION' });
            const fromStatus = task.status;
            task.status = 'IN_PROGRESS';
            task.startedAt = task.startedAt || now;
            task.startedByWorkerId = context.workerId;
            task.startedByWorkerName = context.workerName || '';
            task.serviceActionRevision++;
            this._recordHistory(task, 'SERVICE_STARTED', context, { fromStatus, toStatus: task.status });
            return this._baseOutcome(task, 'start');
        }
        if (input.action === 'complete') {
            if (task.status !== 'IN_PROGRESS') return fail(409, 'Task must be in progress before completion.', { code: 'INVALID_TRANSITION' });
            if (input.proofIssuedAt && now - Number(input.proofIssuedAt) > this.completionFreshnessMs) {
                return fail(403, 'Fresh worker verification is required to complete this task.', { code: 'WORKER_PROOF_STALE' });
            }
            const fromStatus = task.status;
            task.status = 'COMPLETED';
            task.completionPercent = 100;
            task.completedAt = now;
            task.completedByWorkerId = context.workerId;
            task.completedByWorkerName = context.workerName || '';
            task.claimLeaseStatus = 'COMPLETED';
            task.claimLeaseClosedAt = now;
            task.claimLeaseCloseReason = 'TASK_COMPLETED';
            task.serviceActionRevision++;
            this._recordHistory(task, 'SERVICE_COMPLETED', context, { fromStatus, toStatus: task.status });
            return this._baseOutcome(task, 'complete');
        }
        return fail(400, 'Unknown Service task action.', { code: 'INVALID_ACTION_REQUEST' });
    }

    async _loadFirestore(ref, transaction) {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return null;
        const data = snapshot.data() || {};
        return data.task || data;
    }

    async _commit(input, task, before, outcome) {
        const key = this._key(input);
        const record = {
            fingerprint: this._requestFingerprint(input),
            outcome: clone(outcome),
            committedAt: nowValue(this.clock)
        };
        if (this.db) {
            const ref = this._ref(input.companyId, input.taskId);
            await this.db.runTransaction(async transaction => {
                const snapshot = await transaction.get(ref);
                const latest = snapshot.exists ? (snapshot.data().task || snapshot.data()) : null;
                // A Firestore retry re-runs the callback.  Never apply a stale
                // in-memory mutation over the transaction's latest snapshot.
                if (latest && Number(latest.serviceActionRevision || 0) !== Number(before.serviceActionRevision || 0)) {
                    throw Object.assign(new Error('Task revision changed during transaction.'), { code: 'TASK_VERSION_CONFLICT' });
                }
                const persistedIdempotency = snapshot.exists ? snapshot.data().idempotency || {} : {};
                persistedIdempotency[key] = record;
                transaction.set(ref, { task, idempotency: persistedIdempotency, updatedAt: nowValue(this.clock) }, { merge: true });
                this._transactionIndexUpdate(transaction, input.companyId, input.taskId, before, task);
            });
            return;
        }
        const next = clone(this.state);
        next.tasks[taskKey(input.companyId, input.taskId)] = clone(task);
        next.idempotency[key] = record;
        next.history[taskKey(input.companyId, input.taskId)] = clone(task.history || []);
        for (const [indexKey, entry] of Object.entries(next.activeLeases)) {
            if (entry && entry.taskId === input.taskId && entry.companyId === input.companyId) delete next.activeLeases[indexKey];
        }
        for (const index of this._leaseIndex(task)) {
            next.activeLeases[`${input.companyId}::${index.kind}::${index.value}::${input.taskId}`] = {
                companyId: input.companyId, taskId: input.taskId, workerId: task.claimedByWorkerId,
                departmentId: task.claimDepartmentId, leaseId: task.claimLeaseId,
                expiresAt: task.claimLeaseExpiresAt
            };
        }
        if (this.persist) await this.persist(clone(next));
        else if (this.filePath) {
            const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
            fs.renameSync(tmp, this.filePath);
        }
        this.state = next;
    }

    async _action(rawInput) {
        const parsed = this._validateInput(rawInput);
        if (!parsed.ok) return parsed;
        const input = {
            ...rawInput,
            ...parsed,
            context: rawInput.context || rawInput.worker || {
                workerId: rawInput.workerId,
                workerName: rawInput.workerName,
                companyId: parsed.companyId,
                departmentId: rawInput.departmentId,
                departmentName: rawInput.departmentName,
                authorizationVersion: rawInput.authorizationVersion,
                membershipAuthorizationVersion: rawInput.membershipAuthorizationVersion,
                accountStatus: rawInput.accountStatus,
                departmentActive: rawInput.departmentActive,
                workerActive: rawInput.workerActive,
                serviceEnabled: rawInput.serviceEnabled
            }
        };
        if (!input.workerId && input.context && input.context.workerId) {
            input.workerId = input.context.workerId;
        }
        if (this.db) return this._actionFirestore(input);
        const key = this._key(input);
        const requestHash = this._requestFingerprint(input);
        const existing = this.state.idempotency[key];
        const task = clone(this.state.tasks[taskKey(input.companyId, input.taskId)]);
        if (!task) return fail(404, 'Task not found.', { code: 'TASK_NOT_FOUND' });
        const fence = this.state.authorizationFences[this._fenceKey(input.companyId, input.workerId)];
        if (this._membershipExpired(task, fence, nowValue(this.clock))) {
            const before = clone(task);
            this._closeMembershipExpired(task, nowValue(this.clock));
            const denied = this._authorizationDenied();
            await this._commit({
                ...input,
                idempotencyKey: `${input.idempotencyKey}:membership-expiry`
            }, task, before, denied);
            return denied;
        }
        const denied = this._authorizationGate({
            ...input,
            allowAuthorizedReplay: !!existing && existing.fingerprint === requestHash
        }, task, fence);
        if (denied) return denied;
        if (existing) {
            return existing.fingerprint === requestHash
                ? { ...clone(existing.outcome), idempotent: true }
                : fail(409, 'Idempotency key was already used with another request.', { code: 'IDEMPOTENCY_CONFLICT' });
        }
        const before = clone(task);
        const result = this._perform(input, task);
        if (!result.ok) {
            // Expiry is itself a state transition.  Persist it even though the
            // requested operation was denied, without writing an idempotency
            // result for a failed request.
            if (task.serviceActionRevision !== before.serviceActionRevision) {
                const expiryInput = { ...input, idempotencyKey: `${input.idempotencyKey}:expiry` };
                try { await this._commit(expiryInput, task, before, result); }
                catch (error) {
                    if (error && error.code === 'TASK_VERSION_CONFLICT') {
                        return fail(409, 'Task revision changed during this action.', { code: 'TASK_VERSION_CONFLICT' });
                    }
                    throw error;
                }
            }
            return result;
        }
        try {
            await this._commit(input, task, before, result);
            return result;
        } catch (error) {
            if (error && error.code === 'TASK_VERSION_CONFLICT') {
                return fail(409, 'Task revision changed during this action.', {
                    code: 'TASK_VERSION_CONFLICT'
                });
            }
            throw error;
        }
    }

    async _actionFirestore(input) {
        const key = this._key(input);
        const requestHash = this._requestFingerprint(input);
        const ref = this._ref(input.companyId, input.taskId);
        return this.db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) return fail(404, 'Task not found.', { code: 'TASK_NOT_FOUND' });
            const data = snapshot.data() || {};
            const fenceSnapshot = input.workerId
                ? await transaction.get(this._fenceRef(input.companyId, input.workerId))
                : null;
            const fence = fenceSnapshot && fenceSnapshot.exists ? fenceSnapshot.data() : null;
            const task = clone(data.task || data);
            const idempotency = data.idempotency || {};
            const now = nowValue(this.clock);
            if (this._membershipExpired(task, fence, now)) {
                const before = clone(task);
                this._closeMembershipExpired(task, now);
                transaction.set(ref, {
                    task,
                    idempotency,
                    updatedAt: now
                }, { merge: true });
                this._transactionIndexUpdate(transaction, input.companyId, input.taskId, before, task);
                return this._authorizationDenied();
            }
            const denied = this._authorizationGate({
                ...input,
                allowAuthorizedReplay: !!idempotency[key] &&
                    idempotency[key].fingerprint === requestHash
            }, task, fence);
            if (denied) return denied;
            if (idempotency[key]) {
                return idempotency[key].fingerprint === requestHash
                    ? { ...clone(idempotency[key].outcome), idempotent: true }
                    : fail(409, 'Idempotency key was already used with another request.', { code: 'IDEMPOTENCY_CONFLICT' });
            }
            const before = clone(task);
            const result = this._perform(input, task);
            const changed = Number(task.serviceActionRevision || 0) !== Number(before.serviceActionRevision || 0);
            if (!result.ok && !changed) return result;
            const nextIdempotency = { ...idempotency };
            if (result.ok) {
                nextIdempotency[key] = {
                    fingerprint: requestHash,
                    outcome: clone(result),
                    committedAt: nowValue(this.clock)
                };
            }
            transaction.set(ref, {
                task,
                idempotency: nextIdempotency,
                updatedAt: nowValue(this.clock)
            }, { merge: true });
            this._transactionIndexUpdate(transaction, input.companyId, input.taskId, before, task);
            return result;
        });
    }

    async action(input) { return this._enqueue(() => this._action(input)); }
    claim(input) { return this.action({ ...input, action: 'claim' }); }
    start(input) { return this.action({ ...input, action: 'start' }); }
    renew(input) { return this.action({ ...input, action: 'renew' }); }
    release(input) { return this.action({ ...input, action: 'release' }); }
    complete(input) { return this.action({ ...input, action: 'complete' }); }

    _invalidateWorkerLeasesLocal(fence, options = {}) {
        const invalidated = [];
        const now = nowValue(this.clock);
        for (const task of Object.values(this.state.tasks)) {
            if (!task || task.companyId !== fence.companyId ||
                task.claimLeaseStatus !== 'ACTIVE' ||
                task.claimedByWorkerId !== fence.workerId) continue;
            task.claimLeaseStatus = 'INVALIDATED';
            task.claimLeaseClosedAt = now;
            task.claimLeaseCloseReason = options.reason || fence.reason;
            task.serviceActionRevision = Number(task.serviceActionRevision || 0) + 1;
            this._recordHistory(task, 'SERVICE_CLAIM_INVALIDATED', {
                actorKind: options.actorKind || 'SYSTEM',
                actorId: options.actorId,
                actorName: options.actorName,
                departmentId: task.claimDepartmentId
            }, { reason: task.claimLeaseCloseReason });
            invalidated.push(clone(task));
        }
        return invalidated;
    }

    // Local persistence has no cross-process transaction. The fence is applied
    // synchronously before the returned persistence promise, so an action
    // cannot enter this process after the worker mutation and before the fence.
    async advanceWorkerFence(input = {}) {
        if (!input.companyId || !input.workerId) {
            throw new Error('companyId and workerId are required for an authorization fence.');
        }
        if (this.db) {
            const result = await this._enqueue(() => this.db.runTransaction(transaction =>
                this.writeWorkerFenceInTransaction(transaction, input)
            ));
            // Keep the process-local mirror useful for diagnostics and for
            // callers that inspect repository state after a Firestore commit.
            const key = this._fenceKey(result.fence.companyId, result.fence.workerId);
            this.state.authorizationFences[key] = clone(result.fence);
            for (const task of result.invalidated || []) {
                const taskKeyValue = taskKey(task.companyId, task.id);
                this.state.tasks[taskKeyValue] = clone(task);
                for (const [indexKey, entry] of Object.entries(this.state.activeLeases)) {
                    if (entry && entry.companyId === task.companyId && entry.taskId === task.id) {
                        delete this.state.activeLeases[indexKey];
                    }
                }
            }
            return result;
        }
        const oldFence = this.state.authorizationFences[this._fenceKey(input.companyId, input.workerId)];
        const fence = this._fenceFromWorker({
            ...input,
            revocationEpoch: input.revocationEpoch == null
                ? Number(oldFence && oldFence.revocationEpoch || 0) : input.revocationEpoch
        });
        const apply = () => {
            this.state.authorizationFences[this._fenceKey(fence.companyId, fence.workerId)] = fence;
            const invalidated = this._invalidateWorkerLeasesLocal(fence, input);
            return { fence: clone(fence), invalidated };
        };
        const result = apply();
        return this._enqueue(async () => {
            if (this.persist) await this.persist(clone(this.state));
            else if (this.filePath) {
                const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
                fs.renameSync(tmp, this.filePath);
            }
            return result;
        });
    }

    async revokeWorkerFence(input = {}) {
        if (this.db) {
            return this.advanceWorkerFence({ ...input, incrementRevocationEpoch: true });
        }
        const old = this.state.authorizationFences[this._fenceKey(input.companyId, input.workerId)];
        return this.advanceWorkerFence({
            ...input,
            revocationEpoch: Number(old && old.revocationEpoch || 0) + 1
        });
    }

    // Create the initial worker authorization fence without treating
    // verification itself as a revocation event. This is intentionally
    // create-if-missing: an existing epoch/version fence is authoritative and
    // must survive repeated proof issuance and process restarts unchanged.
    async ensureWorkerFence(input = {}) {
        if (!input.companyId || !input.workerId) {
            throw new Error('companyId and workerId are required for an authorization fence.');
        }
        if (this.db) {
            const result = await this._enqueue(() => this.db.runTransaction(async transaction => {
                const fenceRef = this._fenceRef(input.companyId, input.workerId);
                const snapshot = await transaction.get(fenceRef);
                if (snapshot && snapshot.exists) {
                    return { fence: clone(snapshot.data()), created: false };
                }
                const fence = this._fenceFromWorker({
                    ...input,
                    revocationEpoch: 0
                });
                transaction.set(fenceRef, fence);
                return { fence, created: true };
            }));
            this.state.authorizationFences[
                this._fenceKey(result.fence.companyId, result.fence.workerId)
            ] = clone(result.fence);
            return result;
        }
        return this._enqueue(async () => {
            const key = this._fenceKey(input.companyId, input.workerId);
            const existing = this.state.authorizationFences[key];
            if (existing) return { fence: clone(existing), created: false };
            const fence = this._fenceFromWorker({ ...input, revocationEpoch: 0 });
            this.state.authorizationFences[key] = fence;
            if (this.persist) await this.persist(clone(this.state));
            else if (this.filePath) {
                const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
                fs.renameSync(tmp, this.filePath);
            }
            return { fence: clone(fence), created: true };
        });
    }

    async readWorkerFence(companyId, workerId) {
        if (!companyId || !workerId) return null;
        if (!this.db) return clone(this.state.authorizationFences[this._fenceKey(companyId, workerId)] || null);
        const snapshot = await this._fenceRef(companyId, workerId).get();
        return snapshot.exists ? clone(snapshot.data()) : null;
    }

    async writeWorkerFenceInTransaction(transaction, input = {}) {
        const fenceRef = this._fenceRef(input.companyId, input.workerId);
        const previous = await transaction.get(fenceRef);
        const old = previous && previous.exists ? previous.data() : null;
        const fence = this._fenceFromWorker({
            ...input,
            revocationEpoch: input.revocationEpoch == null
                ? Number(old && old.revocationEpoch || 0) +
                    (input.incrementRevocationEpoch ? 1 : 0)
                : input.revocationEpoch
        });
        const leaseQuery = this.db.collection(`${this.collectionName}_active_leases`)
            .where('companyId', '==', fence.companyId);
        const leaseSnapshot = await transaction.get(leaseQuery);
        const invalidated = [];
        const taskWrites = [];
        for (const lease of leaseSnapshot.docs || []) {
            if (lease.data().workerId !== fence.workerId) continue;
            const taskRef = this._ref(fence.companyId, lease.data().taskId);
            const taskSnapshot = await transaction.get(taskRef);
            if (!taskSnapshot.exists) continue;
            const data = taskSnapshot.data() || {};
            const task = clone(data.task || data);
            if (task.claimLeaseStatus !== 'ACTIVE' ||
                task.claimedByWorkerId !== fence.workerId) continue;
            task.claimLeaseStatus = 'INVALIDATED';
            task.claimLeaseClosedAt = nowValue(this.clock);
            task.claimLeaseCloseReason = input.reason || fence.reason;
            task.serviceActionRevision = Number(task.serviceActionRevision || 0) + 1;
            this._recordHistory(task, 'SERVICE_CLAIM_INVALIDATED', {
                actorKind: input.actorKind || 'SYSTEM',
                actorId: input.actorId,
                actorName: input.actorName,
                departmentId: task.claimDepartmentId
            }, { reason: task.claimLeaseCloseReason });
            taskWrites.push({
                taskRef,
                task,
                idempotency: data.idempotency || {},
                updatedAt: nowValue(this.clock)
                , before: data.task || data
            });
            invalidated.push(clone(task));
        }
        for (const write of taskWrites) {
            transaction.set(write.taskRef, {
                task: write.task,
                idempotency: write.idempotency,
                updatedAt: write.updatedAt
            }, { merge: true });
            this._transactionIndexUpdate(transaction, fence.companyId, write.task.id, write.before, write.task);
        }
        transaction.set(fenceRef, fence, { merge: true });
        return { fence, previous: old, invalidated };
    }

    async registerTask(task) {
        if (!task || !task.companyId || !task.id) return fail(400, 'A canonical company task is required.');
        return this._enqueue(async () => {
            const key = taskKey(task.companyId, task.id);
            if (!this.db) {
                const old = this.state.tasks[key];
                const next = clone(this.state);
                next.tasks[key] = this._stateFor(task, old);
                for (const [indexKey, entry] of Object.entries(next.activeLeases)) {
                    if (entry && entry.taskId === task.id && entry.companyId === task.companyId) delete next.activeLeases[indexKey];
                }
                for (const index of this._leaseIndex(next.tasks[key])) {
                    next.activeLeases[`${task.companyId}::${index.kind}::${index.value}::${task.id}`] = {
                        companyId: task.companyId, taskId: task.id,
                        workerId: next.tasks[key].claimedByWorkerId,
                        departmentId: next.tasks[key].claimDepartmentId,
                        leaseId: next.tasks[key].claimLeaseId,
                        expiresAt: next.tasks[key].claimLeaseExpiresAt
                    };
                }
                if (this.persist) await this.persist(clone(next));
                else if (this.filePath) {
                    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
                    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                    fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, this.filePath);
                }
                this.state = next;
                return { ok: true, task: this._safeTask(next.tasks[key]) };
            }
            const ref = this._ref(task.companyId, task.id);
            await this.db.runTransaction(async transaction => {
                const snapshot = await transaction.get(ref);
                const old = snapshot.exists ? (snapshot.data().task || snapshot.data()) : null;
                if (old) {
                    // Existing transactional state is authoritative.  A
                    // stale Operations snapshot may seed only a missing
                    // record; it must never overwrite a newer lease/status.
                    this._transactionIndexUpdate(transaction, task.companyId, task.id, old, old);
                    return;
                }
            const value = this._stateFor(task, old);
                transaction.set(ref, { task: value, idempotency: snapshot.exists ? snapshot.data().idempotency || {} : {}, updatedAt: nowValue(this.clock) });
                this._transactionIndexUpdate(transaction, task.companyId, task.id, null, value);
            });
            return { ok: true, task: this._safeTask(task) };
        });
    }
    async ensureTask(task) {
        if (!task || !task.companyId || !task.id) return fail(400, 'A canonical company task is required.');
        if (!this.db) {
            if (this.state.tasks[taskKey(task.companyId, task.id)]) return { ok: true, created: false };
            return this.registerTask(task);
        }
        return this._enqueue(async () => {
            const ref = this._ref(task.companyId, task.id);
            let created = false;
            await this.db.runTransaction(async transaction => {
                const snapshot = await transaction.get(ref);
                if (snapshot.exists) return;
                const value = this._stateFor(task, null);
                transaction.set(ref, { task: value, idempotency: {}, updatedAt: nowValue(this.clock) });
                this._transactionIndexUpdate(transaction, task.companyId, task.id, null, value);
                created = true;
            });
            return { ok: true, created };
        });
    }

    async reconcileStartupTasks(tasks, concurrency = 20) {
        const values = (Array.isArray(tasks) ? tasks : [])
            .filter(task => task && task.companyId && task.id);
        if (!this.db) {
            const reconciled = [];
            for (const task of values) {
                await this.registerTask(task);
                reconciled.push(await this.readTask(task.companyId, task.id));
            }
            return reconciled;
        }

        const reconciled = [];
        const width = Math.max(1, Math.min(50, Number(concurrency) || 20));
        for (let offset = 0; offset < values.length; offset += width) {
            const chunk = values.slice(offset, offset + width);
            const committed = await Promise.all(chunk.map(task => {
                const ref = this._ref(task.companyId, task.id);
                return this.db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(ref);
                    if (snapshot.exists) {
                        const current = snapshot.data().task || snapshot.data();
                        this._transactionIndexUpdate(transaction, task.companyId, task.id, current, current);
                        return clone(current);
                    }
                    const value = this._stateFor(task, null);
                    transaction.set(ref, {
                        task: value,
                        idempotency: {},
                        updatedAt: nowValue(this.clock)
                    });
                    this._transactionIndexUpdate(transaction, task.companyId, task.id, null, value);
                    return clone(value);
                });
            }));
            reconciled.push(...committed);
        }
        return reconciled;
    }

    syncTask(task, options = {}) {
        return this._enqueue(async () => {
            if (!task || !task.companyId || !task.id) return fail(400, 'A canonical company task is required.');
            const key = taskKey(task.companyId, task.id);
            const old = this.db ? null : this.state.tasks[key];
            if (old && options.expectedServiceExecutionTargetVersion !== undefined &&
                Number(old.serviceExecutionTargetVersion || 0) !== Number(options.expectedServiceExecutionTargetVersion)) {
                if (options.targetChanged) {
                    const error = new Error('Service execution target version conflict.');
                    error.code = 'SERVICE_TARGET_VERSION_CONFLICT';
                    error.version = Number(old.serviceExecutionTargetVersion || 0);
                    throw error;
                }
                task = {
                    ...task,
                    serviceExecutionTarget: clone(old.serviceExecutionTarget),
                    serviceDepartmentId: old.serviceDepartmentId || null,
                    serviceDepartmentName: old.serviceDepartmentName || null,
                    serviceExecutionTargetVersion: Number(old.serviceExecutionTargetVersion || 0),
                    publishToService: old.publishToService === true
                };
            }
            let value = this._stateFor({ ...task }, old, {
                ...options,
                allowMetadataOverwrite: options.allowMetadataOverwrite !== false
            });
            const now = nowValue(this.clock);
            const lost = old && old.claimLeaseStatus === 'ACTIVE' &&
                (value.publishToService !== true ||
                 JSON.stringify(executionTargets.effectiveTarget(value)) !==
                     JSON.stringify(executionTargets.effectiveTarget(old)) ||
                 !ACTIVE_STATUSES.has(value.status));
            if (lost) {
                value.claimLeaseStatus = 'INVALIDATED';
                value.claimLeaseClosedAt = now;
                value.claimLeaseCloseReason = options.reason || 'OPERATIONS_MUTATION';
                value.serviceActionRevision++;
                this._recordHistory(value, 'SERVICE_CLAIM_INVALIDATED', {
                    actorKind: options.actorKind || 'OPERATIONS_USER',
                    actorId: options.actorId, actorName: options.actorName,
                    departmentId: old.claimDepartmentId
                }, { reason: value.claimLeaseCloseReason, fromStatus: old.status, toStatus: value.status });
            } else if (old && JSON.stringify({ status: old.status, title: old.title, description: old.description,
                priority: old.priority, dueDate: old.dueDate, assigneeId: old.assigneeId,
                publishToService: old.publishToService, serviceExecutionTarget: executionTargets.effectiveTarget(old) }) !==
                JSON.stringify({ status: value.status, title: value.title, description: value.description,
                    priority: value.priority, dueDate: value.dueDate, assigneeId: value.assigneeId,
                    publishToService: value.publishToService, serviceExecutionTarget: executionTargets.effectiveTarget(value) })) {
                value.serviceActionRevision++;
            }
            if (this.db) {
                const ref = this._ref(task.companyId, task.id);
                await this.db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(ref);
                    value = this.syncTaskFromSnapshot(transaction, task, snapshot, options);
                });
            } else {
                const next = clone(this.state); next.tasks[key] = value;
                next.history[key] = clone(value.history || []);
                if (this.persist) await this.persist(clone(next));
                else if (this.filePath) {
                    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
                    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                    fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, this.filePath);
                }
                this.state = next;
            }
            return { ok: true, task: this._safeTask(value), committedTask: clone(value), invalidated: !!lost };
        });
    }

    syncTaskFromSnapshot(transaction, task, snapshot, options = {}) {
        const current = snapshot && snapshot.exists ? (snapshot.data().task || snapshot.data()) : null;
        if (current && current.operationsDeleted === true &&
            options.expectedServiceExecutionTargetVersion !== undefined) {
            const error = new Error('Service execution target version conflict.');
            error.code = 'SERVICE_TARGET_VERSION_CONFLICT';
            error.version = Number(current.serviceExecutionTargetVersion || 0);
            throw error;
        }
        if (current && options.expectedServiceExecutionTargetVersion !== undefined &&
            Number(current.serviceExecutionTargetVersion || 0) !== Number(options.expectedServiceExecutionTargetVersion)) {
            if (options.targetChanged) {
                const error = new Error('Service execution target version conflict.');
                error.code = 'SERVICE_TARGET_VERSION_CONFLICT';
                error.version = Number(current.serviceExecutionTargetVersion || 0);
                throw error;
            }
            task = {
                ...task,
                serviceExecutionTarget: clone(current.serviceExecutionTarget),
                serviceDepartmentId: current.serviceDepartmentId || null,
                serviceDepartmentName: current.serviceDepartmentName || null,
                serviceExecutionTargetVersion: Number(current.serviceExecutionTargetVersion || 0),
                publishToService: current.publishToService === true
            };
        }
        const committed = this._stateFor({ ...task }, current, {
            ...options,
            allowMetadataOverwrite: options.allowMetadataOverwrite !== false
        });
        const currentRevision = Number(current && current.serviceActionRevision || 0);
        const lost = current && current.claimLeaseStatus === 'ACTIVE' &&
            (committed.publishToService !== true ||
             JSON.stringify(executionTargets.effectiveTarget(committed)) !==
                 JSON.stringify(executionTargets.effectiveTarget(current)) ||
             !ACTIVE_STATUSES.has(committed.status));
        const metadataChanged = current && JSON.stringify({
            status: current.status, title: current.title, description: current.description,
            priority: current.priority, dueDate: current.dueDate, assigneeId: current.assigneeId,
            publishToService: current.publishToService, serviceExecutionTarget: executionTargets.effectiveTarget(current)
        }) !== JSON.stringify({
            status: committed.status, title: committed.title, description: committed.description,
            priority: committed.priority, dueDate: committed.dueDate, assigneeId: committed.assigneeId,
            publishToService: committed.publishToService, serviceExecutionTarget: executionTargets.effectiveTarget(committed)
        });
        const now = nowValue(this.clock);
        if (lost) {
            committed.claimLeaseStatus = 'INVALIDATED';
            committed.claimLeaseClosedAt = now;
            committed.claimLeaseCloseReason = options.reason || 'OPERATIONS_MUTATION';
            committed.serviceActionRevision = currentRevision + 1;
            this._recordHistory(committed, 'SERVICE_CLAIM_INVALIDATED', {
                actorKind: options.actorKind || 'OPERATIONS_USER',
                actorId: options.actorId, actorName: options.actorName,
                departmentId: current.claimDepartmentId
            }, { reason: committed.claimLeaseCloseReason });
        } else if (metadataChanged) {
            committed.serviceActionRevision = currentRevision + 1;
        }
        const ref = this._ref(task.companyId, task.id);
        transaction.set(ref, {
            task: committed,
            idempotency: snapshot && snapshot.exists ? snapshot.data().idempotency || {} : {},
            updatedAt: now
        });
        this._transactionIndexUpdate(transaction, task.companyId, task.id, current, committed);
        return committed;
    }

    removeTaskFromSnapshot(transaction, companyId, taskId, snapshot, options = {}) {
        if (!snapshot || !snapshot.exists) return { ok: true, removed: false };
        const current = snapshot.data().task || snapshot.data();
        const next = clone(current);
        const now = nowValue(this.clock);
        if (next.claimLeaseStatus === 'ACTIVE') {
            next.claimLeaseStatus = 'INVALIDATED';
            next.claimLeaseClosedAt = now;
            next.claimLeaseCloseReason = options.reason || 'OPERATIONS_DELETED';
            next.serviceActionRevision = Number(next.serviceActionRevision || 0) + 1;
            this._recordHistory(next, 'SERVICE_CLAIM_INVALIDATED', {
                actorKind: options.actorKind || 'OPERATIONS_USER',
                actorId: options.actorId, actorName: options.actorName,
                departmentId: next.claimDepartmentId
            }, { reason: next.claimLeaseCloseReason });
        }
        if (next.publishToService === true) {
            next.serviceExecutionTargetVersion =
                Number(next.serviceExecutionTargetVersion || 0) + 1;
        }
        next.publishToService = false;
        next.operationsDeleted = true;
        const ref = this._ref(companyId, taskId);
        transaction.set(ref, {
            task: next,
            idempotency: snapshot.data().idempotency || {},
            updatedAt: now
        }, { merge: true });
        this._transactionIndexUpdate(transaction, companyId, taskId, current, next);
        return { ok: true, removed: true, committedTask: next };
    }

    async invalidateClaim(input = {}) {
        const key = taskKey(input.companyId, input.taskId);
        return this.syncTask({
            ...(input.task || {}),
            id: input.taskId,
            companyId: input.companyId,
            status: input.status || (input.task && input.task.status) || 'OPEN',
            publishToService: input.publishToService !== undefined ? input.publishToService : input.task && input.task.publishToService,
            serviceDepartmentId: input.serviceDepartmentId || (input.task && input.task.serviceDepartmentId)
        }, { reason: input.reason || 'INVALIDATED', actorKind: input.actorKind, actorId: input.actorId, actorName: input.actorName });
    }

    async invalidateActiveLeases(filter = {}) {
        return this._enqueue(async () => {
        const matches = task => task && task.claimLeaseStatus === 'ACTIVE' &&
            (!filter.companyId || task.companyId === filter.companyId) &&
            (!filter.taskId || task.id === filter.taskId) &&
            (!filter.workerId || task.claimedByWorkerId === filter.workerId) &&
            (!filter.departmentId || task.claimDepartmentId === filter.departmentId);
        if (!this.db) {
            const tasks = Object.values(this.state.tasks).filter(matches);
            const results = [];
            const committedTasks = [];
            for (const current of tasks) {
                const next = clone(current);
                next.claimLeaseStatus = 'INVALIDATED';
                next.claimLeaseClosedAt = nowValue(this.clock);
                next.claimLeaseCloseReason = filter.reason || 'AUTHORIZATION_REVOKED';
                next.serviceActionRevision = Number(next.serviceActionRevision || 0) + 1;
                this._recordHistory(next, 'SERVICE_CLAIM_INVALIDATED', {
                    actorKind: filter.actorKind || 'SYSTEM',
                    actorId: filter.actorId, actorName: filter.actorName,
                    departmentId: current.claimDepartmentId,
                    verificationStrength: filter.verificationStrength || 'SYSTEM_REVOCATION'
                }, { reason: next.claimLeaseCloseReason });
                const key = taskKey(current.companyId, current.id);
                const state = clone(this.state);
                state.tasks[key] = next;
                state.history[key] = clone(next.history || []);
                for (const index of Object.keys(state.activeLeases)) {
                    if (state.activeLeases[index].taskId === current.id && state.activeLeases[index].companyId === current.companyId) delete state.activeLeases[index];
                }
                if (this.persist) await this.persist(clone(state));
                else if (this.filePath) {
                    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
                    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                    fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, this.filePath);
                }
                this.state = state;
                results.push(this._safeTask(next));
                committedTasks.push(clone(next));
            }
            return { ok: true, count: results.length, tasks: results, committedTasks };
        }
        const indexQuery = this.db.collection(`${this.collectionName}_active_leases`);
        let query = indexQuery;
        if (filter.companyId) query = query.where('companyId', '==', filter.companyId);
        if (filter.workerId) query = query.where('workerId', '==', filter.workerId);
        if (filter.departmentId) query = query.where('departmentId', '==', filter.departmentId);
        const indexSnapshot = await query.get();
        const results = [];
        const committedTasks = [];
        for (const indexDoc of indexSnapshot.docs || []) {
            const index = indexDoc.data() || {};
            if (filter.taskId && index.taskId !== filter.taskId) continue;
            const ref = this._ref(index.companyId, index.taskId);
            const result = await this.db.runTransaction(async transaction => {
                const snapshot = await transaction.get(ref);
                if (!snapshot.exists) return null;
                const data = snapshot.data() || {};
                const current = clone(data.task || data);
                if (!matches(current)) return null;
                const next = clone(current);
                next.claimLeaseStatus = 'INVALIDATED';
                next.claimLeaseClosedAt = nowValue(this.clock);
                next.claimLeaseCloseReason = filter.reason || 'AUTHORIZATION_REVOKED';
                next.serviceActionRevision = Number(next.serviceActionRevision || 0) + 1;
                this._recordHistory(next, 'SERVICE_CLAIM_INVALIDATED', {
                    actorKind: filter.actorKind || 'SYSTEM',
                    actorId: filter.actorId, actorName: filter.actorName,
                    departmentId: current.claimDepartmentId,
                    verificationStrength: filter.verificationStrength || 'SYSTEM_REVOCATION'
                }, { reason: next.claimLeaseCloseReason });
                transaction.set(ref, { task: next, idempotency: data.idempotency || {}, updatedAt: nowValue(this.clock) }, { merge: true });
                this._transactionIndexUpdate(transaction, index.companyId, index.taskId, current, next);
                return { safe: this._safeTask(next), committed: clone(next) };
            });
            if (result) {
                results.push(result.safe);
                committedTasks.push(result.committed);
            }
        }
        return { ok: true, count: results.length, tasks: results, committedTasks };
        });
    }
    invalidateForWorker(input = {}) { return this.invalidateActiveLeases({ ...input, workerId: input.workerId, reason: input.reason || 'WORKER_AUTHORIZATION_REVOKED' }); }
    invalidateForDepartment(input = {}) { return this.invalidateActiveLeases({ ...input, departmentId: input.departmentId, reason: input.reason || 'DEPARTMENT_INACTIVE' }); }

    async acknowledge(input = {}) {
        const companyId = text(input.companyId);
        const taskId = text(input.taskId);
        const departmentId = text(input.departmentId || input.context && input.context.departmentId);
        const idempotencyKey = text(input.idempotencyKey || input.requestId);
        if (!companyId || !taskId || !departmentId || !idempotencyKey) {
            return fail(400, 'companyId, taskId, departmentId and idempotencyKey are required.', { code: 'INVALID_ACK_REQUEST' });
        }
        return this._enqueue(async () => {
            const key = `${companyId}::${taskId}::ack::${departmentId}::${idempotencyKey}`;
            const hash = fingerprint({ companyId, taskId, departmentId, action: 'acknowledge' });
            const commit = (task, idempotency) => {
                const oldAck = task.acknowledgements && task.acknowledgements[departmentId];
                if (task.claimLeaseStatus === 'ACTIVE') {
                    return fail(409, 'An active Service worker claim cannot be acknowledged.', { code: 'TASK_ACTIVE_CLAIM' });
                }
                if (oldAck) return { ok: true, acknowledged: true, task: this._safeTask(task), committedTask: clone(task), idempotent: true };
                task.acknowledgements = { ...(task.acknowledgements || {}), [departmentId]: {
                    departmentId, acknowledgedAt: nowValue(this.clock),
                    actorId: input.actorId || null, actorName: input.actorName || null
                }};
                task.serviceActionRevision = Number(task.serviceActionRevision || 0) + 1;
                this._recordHistory(task, 'SERVICE_TASK_ACKNOWLEDGED', {
                    actorKind: 'SERVICE_DEPARTMENT',
                    actorId: input.actorId, actorName: input.actorName,
                    departmentId, idempotencyKey
                }, { departmentId });
                return { ok: true, acknowledged: true, task: this._safeTask(task), committedTask: clone(task), revision: task.serviceActionRevision };
            };
            if (this.db) {
                const ref = this._ref(companyId, taskId);
                return this.db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(ref);
                    if (!snapshot.exists) return fail(404, 'Task not found.', { code: 'TASK_NOT_FOUND' });
                    const data = snapshot.data() || {};
                    const idempotency = data.idempotency || {};
                    if (idempotency[key]) {
                        return idempotency[key].fingerprint === hash
                            ? { ...clone(idempotency[key].outcome), idempotent: true }
                            : fail(409, 'Idempotency key was already used with another request.', { code: 'IDEMPOTENCY_CONFLICT' });
                    }
                    const task = clone(data.task || data);
                    const outcome = commit(task, idempotency);
                    if (!outcome.ok) return outcome;
                    idempotency[key] = { fingerprint: hash, outcome: clone(outcome), committedAt: nowValue(this.clock) };
                    transaction.set(ref, { task, idempotency, updatedAt: nowValue(this.clock) }, { merge: true });
                    return outcome;
                });
            }
            const state = clone(this.state);
            const taskKeyValue = taskKey(companyId, taskId);
            const task = state.tasks[taskKeyValue];
            if (!task) return fail(404, 'Task not found.', { code: 'TASK_NOT_FOUND' });
            const existing = state.idempotency[key];
            if (existing) {
                return existing.fingerprint === hash
                    ? { ...clone(existing.outcome), idempotent: true }
                    : fail(409, 'Idempotency key was already used with another request.', { code: 'IDEMPOTENCY_CONFLICT' });
            }
            const outcome = commit(task, state.idempotency);
            if (!outcome.ok) return outcome;
            state.idempotency[key] = { fingerprint: hash, outcome: clone(outcome), committedAt: nowValue(this.clock) };
            state.tasks[taskKeyValue] = task;
            state.history[taskKeyValue] = clone(task.history || []);
            if (this.persist) await this.persist(clone(state));
            else if (this.filePath) {
                const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, this.filePath);
            }
            this.state = state;
            return outcome;
        });
    }

    async seedAcknowledgement(input = {}) {
        const { companyId, taskId, departmentId } = input;
        if (!companyId || !taskId || !departmentId) return fail(400, 'Acknowledgement identity is required.');
        return this._enqueue(async () => {
            const apply = task => {
                if (!task || task.claimLeaseStatus === 'ACTIVE' ||
                    (task.acknowledgements && task.acknowledgements[departmentId])) return false;
                task.acknowledgements = { ...(task.acknowledgements || {}), [departmentId]: {
                    departmentId, acknowledgedAt: input.acknowledgedAt || nowValue(this.clock),
                    actorKind: 'LEGACY_MIGRATION'
                }};
                return true;
            };
            if (this.db) {
                const ref = this._ref(companyId, taskId);
                await this.db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(ref);
                    if (!snapshot.exists) return;
                    const data = snapshot.data() || {};
                    const task = clone(data.task || data);
                    if (!apply(task)) return;
                    task.serviceActionRevision = Number(task.serviceActionRevision || 0) + 1;
                    transaction.set(ref, { task, idempotency: data.idempotency || {}, updatedAt: nowValue(this.clock) }, { merge: true });
                });
                return { ok: true };
            }
            const key = taskKey(companyId, taskId);
            const task = this.state.tasks[key];
            if (!apply(task)) return { ok: true };
            task.serviceActionRevision = Number(task.serviceActionRevision || 0) + 1;
            const next = clone(this.state); next.tasks[key] = task; next.history[key] = clone(task.history || []);
            if (this.persist) await this.persist(clone(next));
            else if (this.filePath) {
                const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, this.filePath);
            }
            this.state = next;
            return { ok: true };
        });
    }

    async removeTask(companyId, taskId, options = {}) {
        return this._enqueue(async () => {
            const close = current => {
                if (!current) return null;
                const next = clone(current);
                const now = nowValue(this.clock);
                if (next.claimLeaseStatus === 'ACTIVE') {
                    next.claimLeaseStatus = 'INVALIDATED';
                    next.claimLeaseClosedAt = now;
                    next.claimLeaseCloseReason = options.reason || 'OPERATIONS_DELETED';
                    next.serviceActionRevision = Number(next.serviceActionRevision || 0) + 1;
                    this._recordHistory(next, 'SERVICE_CLAIM_INVALIDATED', {
                        actorKind: options.actorKind || 'OPERATIONS_USER',
                        actorId: options.actorId, actorName: options.actorName,
                        departmentId: next.claimDepartmentId
                    }, { reason: next.claimLeaseCloseReason });
                }
                if (next.publishToService === true) {
                    next.serviceExecutionTargetVersion =
                        Number(next.serviceExecutionTargetVersion || 0) + 1;
                }
                next.publishToService = false;
                next.operationsDeleted = true;
                return next;
            };
            if (this.db) {
                const ref = this._ref(companyId, taskId);
                return this.db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(ref);
                    if (!snapshot.exists) return { ok: true, removed: false };
                    const current = snapshot.data().task || snapshot.data();
                    const next = close(current);
                    transaction.set(ref, { task: next, idempotency: snapshot.data().idempotency || {}, updatedAt: nowValue(this.clock) }, { merge: true });
                    this._transactionIndexUpdate(transaction, companyId, taskId, current, next);
                    return { ok: true, removed: true, committedTask: next };
                });
            }
            const current = this.state.tasks[taskKey(companyId, taskId)];
            if (!current) return { ok: true, removed: false };
            const next = close(current);
            const state = clone(this.state);
            state.tasks[taskKey(companyId, taskId)] = next;
            state.history[taskKey(companyId, taskId)] = clone(next.history || []);
            for (const index of Object.keys(state.activeLeases)) {
                if (state.activeLeases[index].taskId === taskId && state.activeLeases[index].companyId === companyId) delete state.activeLeases[index];
            }
            if (this.persist) await this.persist(clone(state));
            else if (this.filePath) {
                const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, this.filePath);
            }
            this.state = state;
            return { ok: true, removed: true, committedTask: next };
        });
    }

    async overrideRelease(input = {}) {
        if (!text(input.leaseId) || input.expectedRevision == null ||
            !Number.isFinite(Number(input.expectedRevision))) {
            return fail(400, 'leaseId and expectedRevision are required for an Operations override.', {
                code: 'INVALID_ACTION_REQUEST'
            });
        }
        return this.action({
            ...input,
            action: 'override',
            idempotencyKey: input.idempotencyKey ||
                `override:${input.leaseId || 'none'}:${input.expectedRevision == null ? 'current' : input.expectedRevision}:${input.reason || 'OPERATIONS_OVERRIDE'}`,
            context: {
                ...input.context,
                actorKind: 'OPERATIONS_USER',
                actorId: input.actorId,
                actorName: input.actorName,
                companyId: input.companyId,
                departmentId: input.departmentId || null
            }
        });
    }

    getTask(companyId, taskId) {
        const value = this.state.tasks[taskKey(companyId, taskId)];
        return clone(value ? this._safeTask(value) : null);
    }
    async readTask(companyId, taskId, options = {}) {
        if (options.materializeExpiry === false) {
            if (!this.db) return this.getRawTask(companyId, taskId);
            const snapshot = await this._ref(companyId, taskId).get();
            if (!snapshot.exists) return null;
            return clone(snapshot.data().task || snapshot.data());
        }
        return this._enqueue(async () => {
            const now = nowValue(this.clock);
            if (this.db) {
                const ref = this._ref(companyId, taskId);
                return this.db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(ref);
                    if (!snapshot.exists) return null;
                    const current = clone(snapshot.data().task || snapshot.data());
                    const fenceSnapshot = current.claimLeaseStatus === 'ACTIVE' &&
                        current.claimedByWorkerId
                        ? await transaction.get(this._fenceRef(companyId, current.claimedByWorkerId))
                        : null;
                    const fence = fenceSnapshot && fenceSnapshot.exists ? fenceSnapshot.data() : null;
                    const membershipExpired = this._membershipExpired(current, fence, now);
                    if (!this._expired(current, now) && !membershipExpired) return current;
                    const next = clone(current);
                    if (membershipExpired) this._closeMembershipExpired(next, now);
                    else this._closeExpired(next, { actorKind: 'SYSTEM' }, now);
                    transaction.set(ref, {
                        task: next,
                        idempotency: snapshot.data().idempotency || {},
                        updatedAt: now
                    }, { merge: true });
                    this._transactionIndexUpdate(transaction, companyId, taskId, current, next);
                    return next;
                });
            }
            const key = taskKey(companyId, taskId);
            const current = clone(this.state.tasks[key]);
            const fence = current && current.claimedByWorkerId
                ? this.state.authorizationFences[this._fenceKey(companyId, current.claimedByWorkerId)]
                : null;
            const membershipExpired = this._membershipExpired(current, fence, now);
            if (!current || (!this._expired(current, now) && !membershipExpired)) return current;
            const nextTask = clone(current);
            if (membershipExpired) this._closeMembershipExpired(nextTask, now);
            else this._closeExpired(nextTask, { actorKind: 'SYSTEM' }, now);
            const next = clone(this.state);
            next.tasks[key] = nextTask;
            next.history[key] = clone(nextTask.history || []);
            for (const indexKey of Object.keys(next.activeLeases)) {
                const entry = next.activeLeases[indexKey];
                if (entry && entry.companyId === companyId && entry.taskId === taskId) {
                    delete next.activeLeases[indexKey];
                }
            }
            if (this.persist) await this.persist(clone(next));
            else if (this.filePath) {
                const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
                fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
                fs.renameSync(tmp, this.filePath);
            }
            this.state = next;
            return clone(nextTask);
        });
    }
    getTaskAsync(companyId, taskId) { return this.readTask(companyId, taskId); }
    getRawTask(companyId, taskId) { return clone(this.state.tasks[taskKey(companyId, taskId)] || null); }
    getHistory(companyId, taskId) {
        const value = this.state.history[taskKey(companyId, taskId)] || (this.state.tasks[taskKey(companyId, taskId)] || {}).history || [];
        return clone(value);
    }
    projectTask(task) { return this._safeTask(task); }
}

module.exports = {
    TaskActionRepository,
    ServiceTaskActionRepository: TaskActionRepository,
    createTaskActionRepository: options => new TaskActionRepository(options),
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    LEASE_STATUSES
};