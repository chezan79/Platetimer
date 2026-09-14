// service/service-workers.js — company-scoped Service worker identities.
//
// This module deliberately has no Express (or Firebase) dependency.  The
// server supplies the company department and Operations-user validators and
// supplies persistence in exactly the same way as department-accounts.js.

'use strict';

const crypto = require('crypto');

const WORKER_STATUSES = Object.freeze(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const MEMBERSHIP_STATUS = 'ACTIVE';
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });

let store = {};
let auditStore = {};
let persist = () => {};

function setStore(value) {
    store = (value && typeof value === 'object') ? value : {};
    // Worker tests and server startup both use setStore as a fresh state
    // boundary.  Audit persistence has its own injection point below.
    auditStore = {};
}
function getStore() { return store; }
function setPersist(fn) {
    if (typeof fn === 'function') persist = fn;
}
function setAuditStore(value) {
    auditStore = (value && typeof value === 'object') ? value : {};
}
function getAuditStore() { return auditStore; }

function fail(code, error) { return { ok: false, code, error }; }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function workersFor(companyId) {
    return Array.isArray(store[companyId]) ? store[companyId] : [];
}
function findRawWorker(companyId, workerId) {
    return workersFor(companyId).find(worker => worker.id === workerId) || null;
}
function genWorkerId() {
    return `worker_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
}

function weakPin(pin) {
    const value = String(pin);
    if (!/^\d+$/.test(value) || value.length < 4) return true;
    if (/^(\d)\1+$/.test(value)) return true;
    const digits = value.split('').map(Number);
    const ascending = digits.every((digit, i) => i === 0 || digit === digits[i - 1] + 1);
    const descending = digits.every((digit, i) => i === 0 || digit === digits[i - 1] - 1);
    return ascending || descending;
}

function checkPepper(pepper) {
    return (typeof pepper === 'string' || Buffer.isBuffer(pepper)) && pepper.length > 0;
}
function pinHash(pin, salt, pepper) {
    return crypto.scryptSync(`${String(pepper)}:${String(pin)}`, salt, 64, SCRYPT_OPTIONS).toString('hex');
}
function newVerifier(pin, pepper, version = 1) {
    if (!checkPepper(pepper)) return null;
    const salt = crypto.randomBytes(16).toString('hex');
    return {
        type: 'PIN',
        salt,
        secretHash: pinHash(pin, salt, pepper),
        version,
        failedAttempts: 0,
        lockedUntil: null,
        changedAt: Date.now()
    };
}
function sameSecret(a, b) {
    const left = Buffer.from(String(a), 'hex');
    const right = Buffer.from(String(b), 'hex');
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

// Safe projections are intentionally constructed field-by-field.  In
// particular, spreading a worker here would make adding a secret field in a
// future migration an accidental disclosure.
function toSafeWorker(worker) {
    if (!worker) return null;
    return {
        id: worker.id,
        workerId: worker.id,
        companyId: worker.companyId,
        displayName: worker.displayName,
        status: worker.status,
        serviceEnabled: worker.serviceEnabled,
        authorizationVersion: worker.authorizationVersion,
        departmentMemberships: (worker.departmentMemberships || []).map(member => ({
            departmentId: member.departmentId,
            status: member.status,
            authorizationVersion: member.authorizationVersion,
            ...(member.validFrom !== undefined ? { validFrom: member.validFrom } : {}),
            ...(member.validUntil !== undefined ? { validUntil: member.validUntil } : {})
        })),
        operationsUserId: worker.operationsUserId == null ? null : worker.operationsUserId,
        verifier: worker.verifier ? {
            type: worker.verifier.type,
            version: worker.verifier.version,
            changedAt: worker.verifier.changedAt
        } : null,
        createdAt: worker.createdAt,
        updatedAt: worker.updatedAt
    };
}
const projectWorker = toSafeWorker;

function getWorkers(companyId) {
    return workersFor(companyId).map(toSafeWorker);
}
function getWorker(companyId, workerId) {
    return toSafeWorker(findRawWorker(companyId, workerId));
}
function findWorkerById(companyId, workerId) {
    return getWorker(companyId, workerId);
}

function audit(companyId, action, worker, actorId, details) {
    if (!auditStore[companyId]) auditStore[companyId] = [];
    const entry = {
        id: `workeraudit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        type: 'WORKER_ADMINISTRATION',
        action,
        companyId,
        workerId: worker && worker.id,
        actorId: actorId || null,
        at: Date.now(),
        ...(details && typeof details === 'object' ? { details: { ...details } } : {})
    };
    auditStore[companyId].push(entry);
    return entry;
}
function getAdministrationAuditRecords(companyId) {
    return (auditStore[companyId] || []).map(record => ({ ...record, details: record.details ? { ...record.details } : undefined }));
}
const getWorkerAuditRecords = getAdministrationAuditRecords;

function optionsFor(options, third) {
    if (Array.isArray(options)) {
        return { departments: options, ...(third && typeof third === 'object' && !Array.isArray(third) ? third : {}) };
    }
    if (typeof options === 'string' || Buffer.isBuffer(options)) {
        return Array.isArray(third)
            ? { pepper: options, departments: third }
            : { pepper: options, ...(third && typeof third === 'object' ? third : {}) };
    }
    return (options && typeof options === 'object') ? options : {};
}

function resolveDepartments(options) {
    return options.departments || options.companyDepartments || options.companyDepts ||
        options.departmentRecords ||
        (typeof options.getCompanyDepartments === 'function' ? options.getCompanyDepartments : null) || null;
}
function validateDepartment(companyId, departmentId, options) {
    const validator = options.validateDepartment || options.validateDepartmentId;
    if (typeof validator === 'function') {
        let result;
        try {
            result = validator.length >= 2
                ? validator(companyId, departmentId)
                : validator({ companyId, departmentId });
        } catch (error) {
            return fail(400, 'Department validation failed.');
        }
        if (result && result.ok === false) return fail(result.code || 404, result.error || 'Department not found in your company.');
        const department = result && result.department ? result.department : result;
        if (department === false || department == null) return fail(404, 'Department not found in your company.');
        if (department && department.active === false) return fail(409, 'Department is not active.');
        if (department && department.companyId && department.companyId !== companyId) {
            return fail(404, 'Department not found in your company.');
        }
        return { ok: true };
    }
    let departments = resolveDepartments(options);
    if (typeof departments === 'function') {
        try { departments = departments(companyId); } catch (error) { return fail(400, 'Department validation failed.'); }
    }
    if (!Array.isArray(departments)) return fail(400, 'A company department validator is required.');
    const department = departments.find(item => item && item.id === departmentId);
    if (!department) return fail(404, 'Department not found in your company.');
    if (department.companyId && department.companyId !== companyId) return fail(404, 'Department not found in your company.');
    if (department.active === false) return fail(409, 'Department is not active.');
    return { ok: true };
}

function membershipInput(memberships) {
    if (!Array.isArray(memberships)) return null;
    return memberships.map(member => {
        if (typeof member === 'string') return { departmentId: member };
        return member && typeof member === 'object' ? member : { departmentId: '' };
    });
}
function normalizeMemberships(companyId, memberships, options, existing) {
    const input = membershipInput(memberships);
    if (!input) return fail(400, 'departmentMemberships must be an array.');
    const ids = new Set();
    const result = [];
    for (const member of input) {
        const departmentId = text(member.departmentId);
        if (!departmentId) return fail(400, 'Each department membership requires departmentId.');
        if (ids.has(departmentId)) return fail(409, 'A department may only appear once in memberships.');
        ids.add(departmentId);
        const valid = validateDepartment(companyId, departmentId, options);
        if (!valid.ok) return valid;
        const old = (existing || []).find(item => item.departmentId === departmentId);
        result.push({
            departmentId,
            status: MEMBERSHIP_STATUS,
            authorizationVersion: old ? (Number(old.authorizationVersion) || 1) : 1,
            ...(member.validFrom !== undefined ? { validFrom: member.validFrom } : old && member.validFrom === undefined && old.validFrom !== undefined ? { validFrom: old.validFrom } : {}),
            ...(member.validUntil !== undefined ? { validUntil: member.validUntil } : old && member.validUntil === undefined && old.validUntil !== undefined ? { validUntil: old.validUntil } : {})
        });
    }
    return { ok: true, memberships: result };
}

function validateOperationsUser(companyId, operationsUserId, options) {
    const id = text(operationsUserId);
    if (!id) return fail(400, 'operationsUserId is required.');
    const validator = options.validateOperationsUser || options.validateOperationsUserId ||
        options.findOperationsUser;
    let result;
    if (typeof validator === 'function') {
        try {
            result = validator.length >= 2
                ? validator(id, companyId)
                : validator({ operationsUserId: id, companyId });
        } catch (error) {
            return fail(400, 'Operations user validation failed.');
        }
    } else {
        const users = options.operationsUsers || options.operationsUserRecords;
        if (Array.isArray(users)) result = users.find(user => user && (user.id === id || user.userId === id));
        else if (users && typeof users === 'object') result = users[id];
        else {
            const byCompany = options.operationsUserCompanyById || options.operationsUserCompanies;
            result = byCompany && byCompany[id] ? { id, companyId: byCompany[id] } : null;
        }
    }
    // A boolean callback is an explicit validation result.  A callback that
    // returns an object must additionally identify the owning company.
    if (result === true) return { ok: true };
    if (!result || result === false || (result.ok === false)) {
        return fail((result && result.code) || 404, (result && result.error) || 'Operations user not found.');
    }
    const linked = result.user || result.operationsUser || result;
    const linkedCompany = linked.companyId || linked.company || linked.companyName;
    if (typeof result === 'string') {
        return result === companyId
            ? { ok: true }
            : fail(409, 'Operations user must belong to the same company.');
    }
    if (!linkedCompany || linkedCompany !== companyId) {
        return fail(409, 'Operations user must belong to the same company.');
    }
    return { ok: true };
}

function actorFrom(options) {
    return options.updatedBy || options.createdBy || options.actorId || options.adminId || null;
}
function requiredCompany(input) {
    const companyId = text(input && input.companyId);
    return companyId ? { ok: true, companyId } : fail(400, 'companyId is required.');
}

function createWorker(input, options, third) {
    input = input || {};
    options = optionsFor(options, third);
    const company = requiredCompany(input);
    if (!company.ok) return company;
    const companyId = company.companyId;
    const displayName = text(input.displayName);
    if (!displayName) return fail(400, 'displayName is required.');
    if (displayName.length > 120) return fail(400, 'displayName too long (max 120).');
    const pin = input.pin !== undefined ? input.pin : input.workerPin;
    if (pin === undefined || pin === null || weakPin(pin)) {
        return fail(400, 'PIN must be at least 4 digits and not repeated or sequential.');
    }
    if (!checkPepper(options.pepper)) return fail(500, 'A PIN pepper is required.');
    const memberships = input.departmentMemberships !== undefined
        ? input.departmentMemberships
        : (input.departmentIds !== undefined ? input.departmentIds : []);
    const normalized = normalizeMemberships(companyId, memberships, options);
    if (!normalized.ok) return normalized;
    let operationsUserId = null;
    if (input.operationsUserId !== undefined && input.operationsUserId !== null && text(input.operationsUserId)) {
        const validLink = validateOperationsUser(companyId, input.operationsUserId, options);
        if (!validLink.ok) return validLink;
        operationsUserId = text(input.operationsUserId);
        if (workersFor(companyId).some(worker => worker.operationsUserId === operationsUserId)) {
            return fail(409, 'This Operations user is already linked to a worker in your company.');
        }
    }
    const now = Date.now();
    const worker = {
        id: genWorkerId(),
        companyId,
        displayName,
        status: 'ACTIVE',
        serviceEnabled: input.serviceEnabled !== false,
        authorizationVersion: 1,
        departmentMemberships: normalized.memberships,
        operationsUserId,
        verifier: newVerifier(pin, options.pepper, 1),
        createdAt: now,
        createdBy: input.createdBy || null,
        updatedAt: now,
        updatedBy: input.createdBy || null
    };
    if (!store[companyId]) store[companyId] = [];
    store[companyId].push(worker);
    audit(companyId, 'WORKER_CREATED', worker, input.createdBy, {
        membershipCount: worker.departmentMemberships.length,
        operationsUserLinked: Boolean(worker.operationsUserId)
    });
    persist();
    return { ok: true, worker: toSafeWorker(worker) };
}

function updateWorker(companyId, workerId, patch, options, fourth) {
    options = optionsFor(options, fourth);
    const worker = findRawWorker(companyId, workerId);
    if (!worker) return fail(404, 'Worker not found.');
    patch = patch || {};
    if ((patch.id !== undefined && patch.id !== worker.id) ||
        (patch.workerId !== undefined && patch.workerId !== worker.id)) {
        return fail(400, 'workerId is immutable.');
    }
    if (patch.companyId !== undefined && patch.companyId !== worker.companyId) {
        return fail(400, 'companyId is immutable.');
    }
    const actor = actorFrom({ ...options, updatedBy: patch.updatedBy || options.updatedBy });
    let changed = false;
    if (patch.displayName !== undefined) {
        const name = text(patch.displayName);
        if (!name) return fail(400, 'displayName is required.');
        if (name.length > 120) return fail(400, 'displayName too long (max 120).');
        if (worker.displayName !== name) { worker.displayName = name; changed = true; }
    }
    if (patch.serviceEnabled !== undefined) {
        if (typeof patch.serviceEnabled !== 'boolean') return fail(400, 'serviceEnabled must be boolean.');
        if (worker.serviceEnabled !== patch.serviceEnabled) {
            worker.serviceEnabled = patch.serviceEnabled;
            worker.authorizationVersion++;
            changed = true;
        }
    }
    if (patch.departmentMemberships !== undefined) {
        const normalized = normalizeMemberships(companyId, patch.departmentMemberships, options, worker.departmentMemberships);
        if (!normalized.ok) return normalized;
        const before = JSON.stringify(worker.departmentMemberships);
        const after = JSON.stringify(normalized.memberships);
        if (before !== after) {
            worker.departmentMemberships = normalized.memberships;
            worker.authorizationVersion++;
            changed = true;
        }
    }
    if (patch.operationsUserId !== undefined) {
        const requested = patch.operationsUserId === null || text(patch.operationsUserId) === ''
            ? null : text(patch.operationsUserId);
        if (requested !== null) {
            const validLink = validateOperationsUser(companyId, requested, options);
            if (!validLink.ok) return validLink;
            if (workersFor(companyId).some(item => item.id !== worker.id && item.operationsUserId === requested)) {
                return fail(409, 'This Operations user is already linked to a worker in your company.');
            }
        }
        if (worker.operationsUserId !== requested) {
            worker.operationsUserId = requested;
            worker.authorizationVersion++;
            changed = true;
        }
    }
    if (!changed) return { ok: true, worker: toSafeWorker(worker) };
    worker.updatedAt = Date.now();
    worker.updatedBy = actor;
    const auditAction = patch.operationsUserId !== undefined
        ? (worker.operationsUserId ? 'WORKER_OPERATIONS_LINKED' : 'WORKER_OPERATIONS_UNLINKED')
        : 'WORKER_UPDATED';
    audit(companyId, auditAction, worker, actor);
    persist();
    return { ok: true, worker: toSafeWorker(worker) };
}

function setWorkerStatus(companyId, workerId, statusOrOptions, actorOrOptions) {
    const worker = findRawWorker(companyId, workerId);
    if (!worker) return fail(404, 'Worker not found.');
    const options = typeof statusOrOptions === 'object' && statusOrOptions !== null
        ? statusOrOptions : (typeof actorOrOptions === 'object' ? actorOrOptions : {});
    const status = typeof statusOrOptions === 'string' ? statusOrOptions : options.status;
    if (!WORKER_STATUSES.includes(status)) return fail(400, `status must be one of: ${WORKER_STATUSES.join(', ')}`);
    if (worker.status === 'ARCHIVED' && status !== 'ARCHIVED') return fail(409, 'ARCHIVED workers cannot be reactivated.');
    if (worker.status === status) return { ok: true, worker: toSafeWorker(worker) };
    worker.status = status;
    if (status === 'ARCHIVED') worker.serviceEnabled = false;
    worker.authorizationVersion++;
    worker.updatedAt = Date.now();
    worker.updatedBy = actorFrom(options) || (typeof actorOrOptions === 'string' ? actorOrOptions : null);
    audit(companyId, 'WORKER_STATUS_CHANGED', worker, worker.updatedBy, { status });
    persist();
    return { ok: true, worker: toSafeWorker(worker) };
}
const updateWorkerStatus = setWorkerStatus;

function setWorkerMemberships(companyId, workerId, memberships, options) {
    const worker = findRawWorker(companyId, workerId);
    if (!worker) return fail(404, 'Worker not found.');
    if (worker.status === 'ARCHIVED') return fail(409, 'ARCHIVED workers cannot be changed.');
    options = optionsFor(options);
    const normalized = normalizeMemberships(companyId, memberships, options, worker.departmentMemberships);
    if (!normalized.ok) return normalized;
    if (JSON.stringify(worker.departmentMemberships) === JSON.stringify(normalized.memberships)) {
        return { ok: true, worker: toSafeWorker(worker) };
    }
    const old = worker.departmentMemberships;
    worker.departmentMemberships = normalized.memberships.map(member => {
        const previous = old.find(item => item.departmentId === member.departmentId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(member)) {
            member.authorizationVersion = (Number(previous.authorizationVersion) || 1) + 1;
        }
        return member;
    });
    worker.authorizationVersion++;
    worker.updatedAt = Date.now();
    worker.updatedBy = actorFrom(options);
    audit(companyId, 'WORKER_MEMBERSHIPS_UPDATED', worker, worker.updatedBy);
    persist();
    return { ok: true, worker: toSafeWorker(worker) };
}
function addWorkerMembership(companyId, workerId, departmentId, options) {
    const worker = findRawWorker(companyId, workerId);
    if (!worker) return fail(404, 'Worker not found.');
    const ids = (worker.departmentMemberships || []).map(member => member.departmentId);
    if (!ids.includes(departmentId)) ids.push(departmentId);
    return setWorkerMemberships(companyId, workerId, ids, options);
}
function removeWorkerMembership(companyId, workerId, departmentId, options) {
    const worker = findRawWorker(companyId, workerId);
    if (!worker) return fail(404, 'Worker not found.');
    if (worker.status === 'ARCHIVED') return fail(409, 'ARCHIVED workers cannot be changed.');
    const remaining = (worker.departmentMemberships || []).filter(member => member.departmentId !== departmentId);
    if (remaining.length === (worker.departmentMemberships || []).length) {
        return { ok: true, worker: toSafeWorker(worker) };
    }
    options = optionsFor(options);
    worker.departmentMemberships = remaining;
    worker.authorizationVersion++;
    worker.updatedAt = Date.now();
    worker.updatedBy = actorFrom(options);
    audit(companyId, 'WORKER_MEMBERSHIPS_UPDATED', worker, worker.updatedBy);
    persist();
    return { ok: true, worker: toSafeWorker(worker) };
}

function resetWorkerPin(companyId, workerId, pin, options, fifth) {
    if (pin && typeof pin === 'object' && !Buffer.isBuffer(pin)) {
        const request = pin;
        pin = request.pin !== undefined ? request.pin : request.workerPin;
        options = { ...request, ...(options && typeof options === 'object' ? options : {}) };
    }
    options = optionsFor(options, fifth);
    const worker = findRawWorker(companyId, workerId);
    if (!worker) return fail(404, 'Worker not found.');
    if (worker.status === 'ARCHIVED') return fail(409, 'ARCHIVED workers cannot be changed.');
    if (pin === undefined || pin === null || weakPin(pin)) {
        return fail(400, 'PIN must be at least 4 digits and not repeated or sequential.');
    }
    if (!checkPepper(options.pepper)) return fail(500, 'A PIN pepper is required.');
    worker.verifier = newVerifier(pin, options.pepper, (worker.verifier && worker.verifier.version || 0) + 1);
    worker.authorizationVersion++;
    worker.updatedAt = Date.now();
    worker.updatedBy = actorFrom(options);
    audit(companyId, 'WORKER_PIN_RESET', worker, worker.updatedBy);
    persist();
    return { ok: true, worker: toSafeWorker(worker) };
}
const resetPin = resetWorkerPin;

function linkWorkerOperationsUser(companyId, workerId, operationsUserId, options) {
    if (operationsUserId && typeof operationsUserId === 'object') {
        const request = operationsUserId;
        operationsUserId = request.operationsUserId;
        options = { ...request, ...(options && typeof options === 'object' ? options : {}) };
    }
    return updateWorker(companyId, workerId, { operationsUserId }, options);
}

function verifyWorkerPin(companyId, workerId, pin, pepper) {
    if (companyId && typeof companyId === 'object') {
        const request = companyId;
        const suppliedPepper = workerId;
        companyId = request.companyId;
        workerId = request.workerId || request.id;
        pin = request.pin !== undefined ? request.pin : request.workerPin;
        pepper = suppliedPepper !== undefined ? suppliedPepper : request.pepper;
    }
    const worker = findRawWorker(companyId, workerId);
    if (!worker) return fail(404, 'Worker not found.');
    if (!checkPepper(pepper)) return fail(500, 'A PIN pepper is required.');
    if (worker.status !== 'ACTIVE' || worker.serviceEnabled !== true) {
        return fail(403, 'Worker is not available for Service verification.');
    }
    const verifier = worker.verifier;
    if (!verifier || verifier.type !== 'PIN' || !verifier.secretHash || !verifier.salt) {
        return fail(403, 'Worker verification is unavailable.');
    }
    const candidate = pinHash(pin, verifier.salt, pepper);
    if (!sameSecret(candidate, verifier.secretHash)) {
        return fail(401, 'Worker verification failed.');
    }
    return {
        ok: true,
        worker: toSafeWorker(worker),
        workerId: worker.id,
        companyId: worker.companyId,
        authorizationVersion: worker.authorizationVersion,
        verifierVersion: verifier.version
    };
}

function getSelectableWorkers(companyId, departmentId) {
    return getWorkers(companyId).filter(worker =>
        worker.status === 'ACTIVE' &&
        worker.serviceEnabled === true &&
        (!departmentId || worker.departmentMemberships.some(member =>
            member.departmentId === departmentId && member.status === MEMBERSHIP_STATUS
        ))
    );
}

module.exports = {
    WORKER_STATUSES,
    MEMBERSHIP_STATUS,
    setStore,
    getStore,
    setPersist,
    setAuditStore,
    getAuditStore,
    getWorkers,
    getWorker,
    findWorkerById,
    toSafeWorker,
    projectWorker,
    getAdministrationAuditRecords,
    getWorkerAuditRecords,
    createWorker,
    createServiceWorker: createWorker,
    updateWorker,
    updateServiceWorker: updateWorker,
    setWorkerStatus,
    setServiceWorkerStatus: setWorkerStatus,
    updateWorkerStatus,
    setWorkerMemberships,
    addWorkerMembership,
    removeWorkerMembership,
    resetWorkerPin,
    resetServiceWorkerPin: resetWorkerPin,
    resetPin,
    linkWorkerOperationsUser,
    verifyWorkerPin,
    verifyPin: verifyWorkerPin,
    getSelectableWorkers,
    getEligibleWorkers: getSelectableWorkers,
    weakPin,
    createPinVerifier: newVerifier
};
