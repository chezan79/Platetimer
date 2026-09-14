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
        this.state = { tasks: {}, idempotency: {}, history: {}, activeLeases: {} };
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
            activeLeases: value.activeLeases && typeof value.activeLeases === 'object' ? value.activeLeases : {}
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
    _indexRef(companyId, taskId, kind, value) {
        return this.db.collection(`${this.collectionName}_active_leases`)
            .doc(`${companyId}::${kind}::${value}::${taskId}`);
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

    _stateFor(task, previous, options = {}) {
        const value = clone(task || {});
        const old = previous || {};
        const incomingRevision = Number(value.serviceActionRevision || 0);
        const oldRevision = Number(old.serviceActionRevision || 0);
        const preserveServiceState = previous && incomingRevision <= oldRevision;
        if (previous && incomingRevision < oldRevision) {
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
        return task && task.companyId === context.companyId &&
            task.publishToService === true &&
            task.serviceDepartmentId === context.departmentId &&
            ACTIVE_STATUSES.has(task.status);
    }

    _workerValid(context, task, requireClaim = false) {
        if (!context || !context.workerId || context.companyId == null || context.departmentId == null) return false;
        if (context.accountStatus && context.accountStatus !== 'ACTIVE') return false;
        if (context.departmentActive === false || context.membershipActive === false ||
            context.workerActive === false || context.serviceEnabled === false) return false;
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
        let task;
        if (this.db) {
            const ref = this._ref(input.companyId, input.taskId);
            const snapshot = await ref.get();
            task = snapshot.exists ? (snapshot.data().task || snapshot.data()) : null;
            const oldIdempotency = snapshot.exists ? snapshot.data().idempotency || {} : {};
            if (oldIdempotency[key]) {
                return oldIdempotency[key].fingerprint === requestHash
                    ? { ...clone(oldIdempotency[key].outcome), idempotent: true }
                    : fail(409, 'Idempotency key was already used with another request.', { code: 'IDEMPOTENCY_CONFLICT' });
            }
        } else {
            const existing = this.state.idempotency[key];
            if (existing) {
                return existing.fingerprint === requestHash
                    ? { ...clone(existing.outcome), idempotent: true }
                    : fail(409, 'Idempotency key was already used with another request.', { code: 'IDEMPOTENCY_CONFLICT' });
            }
            task = clone(this.state.tasks[taskKey(input.companyId, input.taskId)]);
        }
        if (!task) return fail(404, 'Task not found.', { code: 'TASK_NOT_FOUND' });
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
            const idempotency = data.idempotency || {};
            if (idempotency[key]) {
                return idempotency[key].fingerprint === requestHash
                    ? { ...clone(idempotency[key].outcome), idempotent: true }
                    : fail(409, 'Idempotency key was already used with another request.', { code: 'IDEMPOTENCY_CONFLICT' });
            }
            const task = clone(data.task || data);
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
            const value = this._stateFor({ ...task }, old, {
                ...options,
                allowMetadataOverwrite: options.allowMetadataOverwrite !== false
            });
            const now = nowValue(this.clock);
            const lost = old && old.claimLeaseStatus === 'ACTIVE' &&
                (value.publishToService !== true ||
                 value.serviceDepartmentId !== old.serviceDepartmentId ||
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
                publishToService: old.publishToService, serviceDepartmentId: old.serviceDepartmentId }) !==
                JSON.stringify({ status: value.status, title: value.title, description: value.description,
                    priority: value.priority, dueDate: value.dueDate, assigneeId: value.assigneeId,
                    publishToService: value.publishToService, serviceDepartmentId: value.serviceDepartmentId })) {
                value.serviceActionRevision++;
            }
            if (this.db) {
                const ref = this._ref(task.companyId, task.id);
                let committedValue = null;
                await this.db.runTransaction(async transaction => {
                    const snapshot = await transaction.get(ref);
                    const current = snapshot.exists ? (snapshot.data().task || snapshot.data()) : null;
                    committedValue = this._stateFor({ ...task }, current, {
                        ...options,
                        allowMetadataOverwrite: options.allowMetadataOverwrite !== false
                    });
                    const currentRevision = Number(current && current.serviceActionRevision || 0);
                    const committedLost = current && current.claimLeaseStatus === 'ACTIVE' &&
                        (committedValue.publishToService !== true ||
                         committedValue.serviceDepartmentId !== current.serviceDepartmentId ||
                         !ACTIVE_STATUSES.has(committedValue.status));
                    const metadataChanged = current && JSON.stringify({
                        status: current.status, title: current.title, description: current.description,
                        priority: current.priority, dueDate: current.dueDate, assigneeId: current.assigneeId,
                        publishToService: current.publishToService, serviceDepartmentId: current.serviceDepartmentId
                    }) !== JSON.stringify({
                        status: committedValue.status, title: committedValue.title, description: committedValue.description,
                        priority: committedValue.priority, dueDate: committedValue.dueDate, assigneeId: committedValue.assigneeId,
                        publishToService: committedValue.publishToService, serviceDepartmentId: committedValue.serviceDepartmentId
                    });
                    if (committedLost) {
                        committedValue.claimLeaseStatus = 'INVALIDATED';
                        committedValue.claimLeaseClosedAt = now;
                        committedValue.claimLeaseCloseReason = options.reason || 'OPERATIONS_MUTATION';
                        committedValue.serviceActionRevision = currentRevision + 1;
                        this._recordHistory(committedValue, 'SERVICE_CLAIM_INVALIDATED', {
                            actorKind: options.actorKind || 'OPERATIONS_USER',
                            actorId: options.actorId, actorName: options.actorName,
                            departmentId: current.claimDepartmentId
                        }, { reason: committedValue.claimLeaseCloseReason });
                    } else if (metadataChanged) {
                        committedValue.serviceActionRevision = currentRevision + 1;
                    }
                    transaction.set(ref, { task: committedValue, idempotency: snapshot.exists ? snapshot.data().idempotency || {} : {}, updatedAt: now });
                    this._transactionIndexUpdate(transaction, task.companyId, task.id, current, committedValue);
                });
                value = committedValue;
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
                next.publishToService = false;
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
        if (!options.materializeExpiry) {
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
                    if (!this._expired(current, now)) return current;
                    const next = clone(current);
                    this._closeExpired(next, { actorKind: 'SYSTEM' }, now);
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
            if (!current || !this._expired(current, now)) return current;
            const nextTask = clone(current);
            this._closeExpired(nextTask, { actorKind: 'SYSTEM' }, now);
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