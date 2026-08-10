'use strict';
/**
 * PlateTimer Operations — Exception Register (Sprint 6.4)
 *
 * Stores non-standard task outcome records per company.
 * Types are open-ended strings — never hardcoded in the store itself.
 *
 * Standard types documented (not exclusive):
 *   CANCELLED | TRANSFERRED | BLOCKED | WAITING_DEPT | WAITING_MATERIALS
 *   CUSTOMER_REQUEST | DIRECTOR_DECISION | OPERATIONAL_EMERGENCY
 *
 * File: data/ops-exceptions.json
 *   { [companyId]: [ ExceptionRecord, ... ] }
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR        = process.env.DATA_DIR || path.join(__dirname, '../data');
const EXCEPTIONS_FILE = path.join(DATA_DIR, 'ops-exceptions.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadAll() {
    try { return JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, 'utf8')); }
    catch { return {}; }
}

function saveAll(data) {
    const dir = path.dirname(EXCEPTIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(EXCEPTIONS_FILE, JSON.stringify(data, null, 2));
}

let _idSeq = 0;
function genId() { return `exc_${Date.now()}_${++_idSeq}`; }

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a new exception.
 *
 * @param {string} companyId
 * @param {{ taskId, userId, type, reason, recordedBy, recordedByName? }} opts
 * @returns {object} the stored exception record
 */
function createException(companyId, { taskId, userId, type, reason, recordedBy, recordedByName }) {
    if (!companyId || !taskId || !userId || !type) throw new Error('Missing required exception fields.');
    const all = loadAll();
    if (!all[companyId]) all[companyId] = [];
    const record = {
        id:              genId(),
        companyId,
        taskId,
        userId,
        type,
        reason:          (reason || '').trim().slice(0, 500),
        recordedBy,
        recordedByName:  recordedByName || null,
        recordedAt:      new Date().toISOString(),
    };
    all[companyId].push(record);
    saveAll(all);
    return record;
}

/** All exceptions for a company, newest first. */
function getExceptions(companyId) {
    const all = loadAll();
    return (all[companyId] || []).slice().reverse();
}

/** Exceptions for a specific user within a company, newest first. */
function getExceptionsForUser(companyId, userId) {
    return getExceptions(companyId).filter(e => e.userId === userId);
}

/** Exceptions for a specific task within a company. */
function getExceptionsForTask(companyId, taskId) {
    return getExceptions(companyId).filter(e => e.taskId === taskId);
}

/** Remove all exceptions for a company (test teardown). */
function _clearCompanyExceptions(companyId) {
    const all = loadAll();
    delete all[companyId];
    saveAll(all);
}

module.exports = {
    createException,
    getExceptions,
    getExceptionsForUser,
    getExceptionsForTask,
    _clearCompanyExceptions,
    // Standard type codes (non-exclusive — callers may use any string)
    TYPES: {
        CANCELLED:           'CANCELLED',
        TRANSFERRED:         'TRANSFERRED',
        BLOCKED:             'BLOCKED',
        WAITING_DEPT:        'WAITING_DEPT',
        WAITING_MATERIALS:   'WAITING_MATERIALS',
        CUSTOMER_REQUEST:    'CUSTOMER_REQUEST',
        DIRECTOR_DECISION:   'DIRECTOR_DECISION',
        OPERATIONAL_EMERGENCY: 'OPERATIONAL_EMERGENCY',
    },
};
