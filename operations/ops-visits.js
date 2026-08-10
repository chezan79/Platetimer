'use strict';
/**
 * PlateTimer Operations — Visit Tracking (Sprint 6.3.1)
 *
 * Stores the last time each Operations user viewed their role dashboard.
 * Server-owned — clients never supply timestamps.
 *
 * Shape: { [companyId]: { [userId]: { lastVisitAt: number } } }
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const VISITS_FILE = path.join(DATA_DIR, 'ops-visits.json');

// ── Internal helpers ──────────────────────────────────────────────────────────

function _load() {
    try {
        if (fs.existsSync(VISITS_FILE)) {
            const raw = fs.readFileSync(VISITS_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch {}
    return {};
}

function _save(store) {
    try {
        fs.writeFileSync(VISITS_FILE, JSON.stringify(store, null, 2));
    } catch (e) {
        console.error('[OPS-VISITS] save error:', e.message);
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the visit record for a user, or null if no prior visit.
 * @returns {{ lastVisitAt: number } | null}
 */
function getLastVisit(companyId, userId) {
    const store = _load();
    const co    = store[companyId];
    return (co && co[userId]) ? { lastVisitAt: co[userId].lastVisitAt } : null;
}

/**
 * Record the current server time as the user's last visit.
 * Never trusts a client-supplied timestamp.
 */
function updateLastVisit(companyId, userId) {
    const store = _load();
    if (!store[companyId]) store[companyId] = {};
    store[companyId][userId] = { lastVisitAt: Date.now() };
    _save(store);
}

/**
 * Test helper — wipe all visit records for a company.
 */
function _clearCompanyVisits(companyId) {
    const store = _load();
    delete store[companyId];
    _save(store);
}

module.exports = { getLastVisit, updateLastVisit, _clearCompanyVisits };
