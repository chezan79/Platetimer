'use strict';
/**
 * PlateTimer Operations — Daily Intelligence Snapshot Store (Sprint 6.2)
 *
 * Stores one aggregate metrics snapshot per company per calendar day.
 * Idempotent: calling generateSnapshot() multiple times on the same day
 * returns the already-stored snapshot without overwriting it.
 *
 * File structure: data/ops-snapshots.json
 *   { [companyId]: { [YYYY-MM-DD]: SnapshotObject } }
 *
 * Never stores raw task copies — aggregated metrics only.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR       = process.env.DATA_DIR || path.join(__dirname, '../data');
const SNAPSHOTS_FILE = path.join(DATA_DIR, 'ops-snapshots.json');

// ── File helpers ──────────────────────────────────────────────────────────────

function loadAll() {
    try { return JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8')); }
    catch { return {}; }
}

function saveAll(data) {
    const dir = path.dirname(SNAPSHOTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(data, null, 2));
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayStr()     { return new Date().toISOString().slice(0, 10); }
function yesterdayStr() { return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10); }

// ── Internal: compute effectiveStatus without duplicating ops-intelligence ────

function _withEffective(t) {
    let effectiveStatus = t.status;
    if (t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && t.dueDate) {
        const due = new Date(t.dueDate).getTime();
        if (!isNaN(due) && Date.now() > due) effectiveStatus = 'OVERDUE';
    }
    return { ...t, effectiveStatus };
}

function _isDateStr(d, dateStr) {
    if (!d) return false;
    try { return new Date(d).toISOString().slice(0, 10) === dateStr; } catch { return false; }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get all stored snapshots for a company.
 * @returns { [date: string]: SnapshotObject }
 */
function getCompanySnapshots(companyId) {
    return loadAll()[companyId] || {};
}

/**
 * Return yesterday's snapshot or null if not available.
 */
function getYesterdaySnapshot(companyId) {
    return getCompanySnapshots(companyId)[yesterdayStr()] || null;
}

/**
 * Return the most recent N daily snapshots (excluding today), newest first.
 */
function getRecentSnapshots(companyId, days = 7) {
    const snaps = getCompanySnapshots(companyId);
    const today = todayStr();
    return Object.entries(snaps)
        .filter(([d]) => d !== today)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, days)
        .map(([, s]) => s);
}

/**
 * Generate today's snapshot for a company — idempotent.
 *
 * If today's snapshot already exists, returns the cached one immediately.
 * Otherwise computes from `tasks`, `users`, and (optionally) the already-
 * computed `workload` array to avoid duplicating load score logic.
 *
 * @param {string} companyId
 * @param {{ tasks: object[], users: object[], workload?: object[] }} data
 * @returns {object} the snapshot (new or cached)
 */
function generateSnapshot(companyId, { tasks, users, workload }) {
    const date = todayStr();
    const all  = loadAll();

    // ── Idempotency guard ──────────────────────────────────────────────────
    if (all[companyId] && all[companyId][date]) {
        return all[companyId][date];
    }

    // ── Compute metrics ────────────────────────────────────────────────────
    const enriched = (tasks || []).map(_withEffective);

    const openTasks      = enriched.filter(t => !['COMPLETED','CANCELLED'].includes(t.status));
    const overdueTasks   = enriched.filter(t => t.effectiveStatus === 'OVERDUE');
    const urgentTasks    = enriched.filter(t => t.priority === 'URGENT' && !['COMPLETED','CANCELLED'].includes(t.status));
    const completedToday = enriched.filter(t => t.status === 'COMPLETED' && _isDateStr(t.completedAt, date));
    const tasksCreated   = enriched.filter(t => _isDateStr(t.createdAt, date));

    const finished = enriched.filter(t => t.status === 'COMPLETED' && t.createdAt && t.completedAt);
    const avgCompletionTime = finished.length
        ? Math.round(
            finished.reduce((s, t) =>
                s + (new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()), 0
            ) / finished.length / 60_000
          )
        : 0;

    const activeUsers    = (users || []).filter(u => u.status === 'ACTIVE').length;
    const overloadedUsers = (workload || []).filter(w => w.status === 'OVERLOADED').length;

    // Department metrics
    const deptMetrics = {};
    enriched.forEach(t => {
        if (!t.department) return;
        if (!deptMetrics[t.department]) {
            deptMetrics[t.department] = { open: 0, overdue: 0, urgent: 0, completedToday: 0 };
        }
        const d = deptMetrics[t.department];
        if (!['COMPLETED','CANCELLED'].includes(t.status))   d.open++;
        if (t.effectiveStatus === 'OVERDUE')                 d.overdue++;
        if (t.priority === 'URGENT' && !['COMPLETED','CANCELLED'].includes(t.status)) d.urgent++;
        if (t.status === 'COMPLETED' && _isDateStr(t.completedAt, date)) d.completedToday++;
    });

    const total          = completedToday.length + openTasks.length;
    const completionRate = total > 0 ? Math.round(completedToday.length / total * 100) : 0;

    const snapshot = {
        companyId,
        date,
        generatedAt:          new Date().toISOString(),
        tasksCreated:         tasksCreated.length,
        tasksCompleted:       completedToday.length,
        openTasks:            openTasks.length,
        overdueTasks:         overdueTasks.length,
        urgentTasks:          urgentTasks.length,
        completionRate,
        averageCompletionTime: avgCompletionTime,
        activeUsers,
        overloadedUsers,
        escalations:          0,
        departmentMetrics:    deptMetrics,
    };

    if (!all[companyId]) all[companyId] = {};
    all[companyId][date] = snapshot;
    saveAll(all);
    return snapshot;
}

// ── Test helpers (not for production use) ─────────────────────────────────────

/**
 * Forcibly store a snapshot for any date (bypass idempotency).
 * Only called from test suites to seed historical data.
 */
function _saveSnapshotForDate(companyId, date, snapshot) {
    const all = loadAll();
    if (!all[companyId]) all[companyId] = {};
    all[companyId][date] = { companyId, date, generatedAt: new Date().toISOString(), ...snapshot };
    saveAll(all);
    return all[companyId][date];
}

/** Remove all snapshots for a company (test teardown). */
function _clearCompanySnapshots(companyId) {
    const all = loadAll();
    delete all[companyId];
    saveAll(all);
}

module.exports = {
    generateSnapshot,
    getCompanySnapshots,
    getYesterdaySnapshot,
    getRecentSnapshots,
    _saveSnapshotForDate,
    _clearCompanySnapshots,
    _todayStr:     todayStr,
    _yesterdayStr: yesterdayStr,
};
