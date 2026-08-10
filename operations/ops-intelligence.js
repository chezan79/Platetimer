'use strict';
/**
 * PlateTimer Operations — Intelligence Engine (Sprint 6.0)
 *
 * Pure rule-based analysis of operations data.
 * No AI, no ML, no external APIs, no database writes, no background jobs.
 * Called on-demand from GET /api/operations/intelligence (Director only).
 *
 * analyzeIntelligence(companyId, { tasks, users }) → { attention, workload, suggestions, summary }
 *
 * `tasks`  — raw task records from getOpsTasks(); effectiveStatus computed internally.
 * `users`  — raw user records from getOpsUsers().
 */

// ── Thresholds ────────────────────────────────────────────────────────────────
const OVERDUE_HIGH_MIN       = 30;   // minutes overdue before a HIGH alert is raised
const INACTIVE_HRS           = 4;    // hours without update on IN_PROGRESS → LOW alert
const URGENT_DEPT_THRESHOLD  = 2;    // ≥N urgent tasks in one dept → MEDIUM alert
const LOAD_BUSY              = 5;    // currentLoadScore ≥ this → BUSY
const LOAD_OVERLOADED        = 10;   // currentLoadScore ≥ this → OVERLOADED

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowMs() { return Date.now(); }

function isToday(dateStr) {
    if (!dateStr) return false;
    try {
        return new Date(dateStr).toISOString().slice(0, 10) ===
               new Date().toISOString().slice(0, 10);
    } catch { return false; }
}

/** Compute effectiveStatus (mirrors server.js opsTaskWithComputedStatus). */
function withEffectiveStatus(t) {
    let effectiveStatus = t.status;
    if (t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && t.dueDate) {
        const due = new Date(t.dueDate).getTime();
        if (!isNaN(due) && nowMs() > due) effectiveStatus = 'OVERDUE';
    }
    return { ...t, effectiveStatus };
}

/** Deterministic load score formula. */
function computeLoadScore({ assigned, overdue, urgent }) {
    return assigned * 1 + overdue * 3 + urgent * 2;
}

/** Map load score to status label. */
function loadStatus(score) {
    if (score >= LOAD_OVERLOADED) return 'OVERLOADED';
    if (score >= LOAD_BUSY)       return 'BUSY';
    return 'NORMAL';
}

const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {string} companyId
 * @param {{ tasks: object[], users: object[] }} data
 * @returns {{ attention: object[], workload: object[], suggestions: object[], summary: object }}
 */
function analyzeIntelligence(companyId, { tasks: rawTasks, users: rawUsers }) {
    const now = nowMs();
    const ts  = new Date().toISOString();

    // ── Prepare data ──────────────────────────────────────────────────────────
    const tasks         = (rawTasks  || []).map(withEffectiveStatus);
    const users         = rawUsers   || [];
    const activeUsers   = users.filter(u => u.status === 'ACTIVE');
    const suspendedUsers= users.filter(u => u.status === 'SUSPENDED');

    let alertId = 0;
    const nextAlertId = () => `alert_${++alertId}`;
    let sugId = 0;
    const nextSugId = () => `sug_${++sugId}`;

    // ── WORKLOAD ──────────────────────────────────────────────────────────────
    const workload = activeUsers.map(u => {
        const mine       = tasks.filter(t => t.assigneeId === u.id);
        const openMine   = mine.filter(t => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
        const assigned   = openMine.length;
        const overdue    = openMine.filter(t => t.effectiveStatus === 'OVERDUE').length;
        const urgent     = openMine.filter(t => t.priority === 'URGENT').length;
        const completedToday = mine.filter(t => t.status === 'COMPLETED' && isToday(t.completedAt)).length;

        const finished = mine.filter(t => t.status === 'COMPLETED' && t.createdAt && t.completedAt);
        const avgCompletionTime = finished.length
            ? Math.round(
                finished.reduce((s, t) =>
                    s + (new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()), 0
                ) / finished.length
              )
            : 0;

        const score = computeLoadScore({ assigned, overdue, urgent });
        return {
            userId: u.id,
            userName: u.name,
            role: u.role,
            assigned,
            completedToday,
            overdue,
            urgent,
            averageCompletionTime: avgCompletionTime,
            currentLoadScore: score,
            status: loadStatus(score),
        };
    });

    // ── ATTENTION ─────────────────────────────────────────────────────────────
    const attention = [];

    // HIGH — task overdue by more than OVERDUE_HIGH_MIN minutes
    tasks
        .filter(t => t.effectiveStatus === 'OVERDUE')
        .forEach(t => {
            const overdueMin = (now - new Date(t.dueDate).getTime()) / 60000;
            if (overdueMin >= OVERDUE_HIGH_MIN) {
                attention.push({
                    id: nextAlertId(),
                    severity: 'HIGH',
                    title: 'Compito in ritardo',
                    description: `"${t.title}" è in ritardo di ${Math.round(overdueMin)} minuti.`,
                    recommendedAction: 'Completare o riassegnare immediatamente.',
                    linkedTask: t.id,
                    linkedUser: t.assigneeId || null,
                    department: t.department || null,
                    timestamp: ts,
                });
            }
        });

    // HIGH — URGENT task not yet started (status OPEN)
    tasks
        .filter(t => t.priority === 'URGENT' && t.status === 'OPEN')
        .forEach(t => {
            attention.push({
                id: nextAlertId(),
                severity: 'HIGH',
                title: 'Compito urgente non avviato',
                description: `"${t.title}" è urgente ma non è ancora stato avviato.`,
                recommendedAction: 'Avviare il compito o riassegnarlo a chi può iniziare subito.',
                linkedTask: t.id,
                linkedUser: t.assigneeId || null,
                department: t.department || null,
                timestamp: ts,
            });
        });

    // HIGH — suspended user still has active tasks
    suspendedUsers.forEach(u => {
        const activeTasks = tasks.filter(
            t => t.assigneeId === u.id && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
        );
        if (activeTasks.length) {
            attention.push({
                id: nextAlertId(),
                severity: 'HIGH',
                title: 'Utente sospeso con compiti assegnati',
                description:
                    `${u.name} è sospeso ma ha ancora ${activeTasks.length} ` +
                    `${activeTasks.length === 1 ? 'compito assegnato' : 'compiti assegnati'}.`,
                recommendedAction: 'Riassegnare i compiti a un membro attivo del team.',
                linkedTask: null,
                linkedUser: u.id,
                department: null,
                timestamp: ts,
            });
        }
    });

    // MEDIUM — user overloaded
    workload
        .filter(w => w.status === 'OVERLOADED')
        .forEach(w => {
            attention.push({
                id: nextAlertId(),
                severity: 'MEDIUM',
                title: 'Membro del team sovraccarico',
                description:
                    `${w.userName} ha un carico elevato: ${w.assigned} compiti aperti, ` +
                    `${w.overdue} in ritardo, ${w.urgent} urgenti (score: ${w.currentLoadScore}).`,
                recommendedAction: 'Ridistribuire alcuni compiti ad altri membri disponibili.',
                linkedTask: null,
                linkedUser: w.userId,
                department: null,
                timestamp: ts,
            });
        });

    // MEDIUM — many urgent tasks concentrated in one department
    const deptUrgent = {};
    tasks
        .filter(t =>
            t.priority === 'URGENT' &&
            t.status !== 'COMPLETED' &&
            t.status !== 'CANCELLED' &&
            t.department
        )
        .forEach(t => { deptUrgent[t.department] = (deptUrgent[t.department] || 0) + 1; });

    Object.entries(deptUrgent)
        .filter(([, cnt]) => cnt >= URGENT_DEPT_THRESHOLD)
        .forEach(([dept, cnt]) => {
            attention.push({
                id: nextAlertId(),
                severity: 'MEDIUM',
                title: `Concentrazione urgenze nel reparto "${dept}"`,
                description: `Il reparto "${dept}" ha ${cnt} compiti urgenti aperti.`,
                recommendedAction: `Verificare e prioritizzare il reparto "${dept}".`,
                linkedTask: null,
                linkedUser: null,
                department: dept,
                timestamp: ts,
            });
        });

    // LOW — IN_PROGRESS task inactive for more than INACTIVE_HRS hours
    const inactiveCutoff = now - INACTIVE_HRS * 3_600_000;
    tasks
        .filter(t =>
            t.status === 'IN_PROGRESS' &&
            t.updatedAt &&
            new Date(t.updatedAt).getTime() < inactiveCutoff
        )
        .forEach(t => {
            const hrsInactive = Math.round((now - new Date(t.updatedAt).getTime()) / 3_600_000);
            attention.push({
                id: nextAlertId(),
                severity: 'LOW',
                title: 'Compito inattivo da tempo',
                description:
                    `"${t.title}" è in corso ma non viene aggiornato da ${hrsInactive} ore.`,
                recommendedAction: 'Verificare lo stato avanzamento e aggiornare il compito.',
                linkedTask: t.id,
                linkedUser: t.assigneeId || null,
                department: t.department || null,
                timestamp: ts,
            });
        });

    // Sort: HIGH → MEDIUM → LOW
    attention.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    // ── SUGGESTIONS ───────────────────────────────────────────────────────────
    const suggestions = [];

    // Suggest moving tasks from overloaded users to normal users
    const normalUsers = workload
        .filter(w => w.status === 'NORMAL')
        .sort((a, b) => a.currentLoadScore - b.currentLoadScore);

    workload
        .filter(w => w.status === 'OVERLOADED')
        .forEach(w => {
            const candidate = normalUsers[0];
            if (!candidate) return;
            const movable = tasks.filter(
                t => t.assigneeId === w.userId &&
                     t.status === 'OPEN' &&
                     t.priority !== 'URGENT'
            );
            if (movable.length) {
                suggestions.push({
                    id: nextSugId(),
                    type: 'REASSIGN_BALANCE',
                    title: `Sposta un compito da ${w.userName} a ${candidate.userName}`,
                    description:
                        `"${movable[0].title}" può essere spostato per bilanciare il carico di lavoro.`,
                    linkedTask: movable[0].id,
                    linkedUser: w.userId,
                    targetUser: candidate.userId,
                    department: movable[0].department || null,
                });
            }
        });

    // Suggest reassigning tasks from suspended users
    suspendedUsers.forEach(u => {
        const activeTasks = tasks.filter(
            t => t.assigneeId === u.id && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
        );
        activeTasks.forEach(t => {
            suggestions.push({
                id: nextSugId(),
                type: 'REASSIGN_SUSPENDED',
                title: `Riassegna il compito di ${u.name}`,
                description: `"${t.title}" è assegnato a ${u.name} che è sospeso.`,
                linkedTask: t.id,
                linkedUser: u.id,
                targetUser: null,
                department: t.department || null,
            });
        });
    });

    // Suggest reviewing overloaded departments
    Object.entries(deptUrgent)
        .filter(([, cnt]) => cnt >= URGENT_DEPT_THRESHOLD)
        .forEach(([dept]) => {
            suggestions.push({
                id: nextSugId(),
                type: 'REVIEW_DEPT',
                title: `Verifica il reparto "${dept}"`,
                description: `Molti compiti urgenti concentrati nel reparto "${dept}".`,
                linkedTask: null,
                linkedUser: null,
                targetUser: null,
                department: dept,
            });
        });

    // Suggest completing recurring tasks that are overdue
    tasks
        .filter(t => t.effectiveStatus === 'OVERDUE' && t.templateId)
        .forEach(t => {
            suggestions.push({
                id: nextSugId(),
                type: 'COMPLETE_RECURRING',
                title: 'Completa il compito ricorrente in ritardo',
                description: `"${t.title}" è un compito ricorrente che è in ritardo.`,
                linkedTask: t.id,
                linkedUser: t.assigneeId || null,
                targetUser: null,
                department: t.department || null,
            });
        });

    // ── SUMMARY ───────────────────────────────────────────────────────────────
    const completedToday = tasks.filter(t => t.status === 'COMPLETED' && isToday(t.completedAt));
    const overdueToday   = tasks.filter(t => t.effectiveStatus === 'OVERDUE');
    const urgentOpen     = tasks.filter(
        t => t.priority === 'URGENT' && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
    );
    const openTasks = tasks.filter(t => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');

    // Most active department: most completions today
    const deptCompletions = {};
    completedToday.filter(t => t.department).forEach(t => {
        deptCompletions[t.department] = (deptCompletions[t.department] || 0) + 1;
    });
    const mostActiveDepartment =
        Object.entries(deptCompletions).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // Most overloaded department: most overdue + urgent tasks
    const deptLoad = {};
    tasks
        .filter(t =>
            t.department &&
            (t.effectiveStatus === 'OVERDUE' ||
             (t.priority === 'URGENT' && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'))
        )
        .forEach(t => { deptLoad[t.department] = (deptLoad[t.department] || 0) + 1; });
    const mostOverloadedDepartment =
        Object.entries(deptLoad).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // Users needing attention
    const usersNeedingAttention = [
        ...workload
            .filter(w => w.status === 'OVERLOADED')
            .map(w => ({ userId: w.userId, userName: w.userName, reason: 'OVERLOADED' })),
        ...suspendedUsers
            .filter(u =>
                tasks.some(
                    t => t.assigneeId === u.id && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
                )
            )
            .map(u => ({ userId: u.id, userName: u.name, reason: 'SUSPENDED_WITH_TASKS' })),
    ];

    // Completion rate = completedToday / (completedToday + open) * 100
    const total = completedToday.length + openTasks.length;
    const completionRate = total > 0 ? Math.round((completedToday.length / total) * 100) : 0;

    const summary = {
        completedToday:          completedToday.length,
        overdueToday:            overdueToday.length,
        urgentOpen:              urgentOpen.length,
        mostActiveDepartment,
        mostOverloadedDepartment,
        usersNeedingAttention,
        completionRate,
        generatedAt:             ts,
    };

    return { attention, workload, suggestions, summary };
}

module.exports = {
    analyzeIntelligence,
    // Exported for unit tests
    _computeLoadScore: computeLoadScore,
    _loadStatus:       loadStatus,
    _LOAD_BUSY:        LOAD_BUSY,
    _LOAD_OVERLOADED:  LOAD_OVERLOADED,
};
