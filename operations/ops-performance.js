'use strict';
/**
 * PlateTimer Operations — Performance & Coaching Center (Sprint 6.4)
 *
 * Pure, deterministic computation of individual performance profiles.
 * No AI, no ML, no external APIs, no writes.
 *
 * Exports:
 *   parsePeriod(period, fromStr, toStr)            → { fromMs, toMs, label }
 *   computeMetrics(tasks, userId, periodMs, excps) → MetricsObject
 *   computeReliabilityIndex(metrics)               → { score, classification, components }
 *   generateStrengths(metrics)                     → string[]
 *   generateCoachingOpportunities(metrics)         → string[]
 *   computeEvolution(tasks, userId, excps)         → EvolutionObject
 *   computeWorkloadHistory(tasks, userId)          → WorkloadHistoryObject
 *   classifyTaskOutcome(task, userId, excps)       → string
 *   buildTaskHistory(tasks, userId, excps, limit)  → ClassifiedTask[]
 */

// ── Period helpers ────────────────────────────────────────────────────────────

function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function startOfMonth(ms) {
    const d = new Date(ms);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function startOfYear(ms) {
    const d = new Date(ms);
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/**
 * Resolve a named period to { fromMs, toMs, label }.
 *
 * @param {string} period  — 'today'|'7d'|'30d'|'90d'|'year'|'custom'
 * @param {string} fromStr — ISO date string (custom only)
 * @param {string} toStr   — ISO date string (custom only)
 */
function parsePeriod(period, fromStr, toStr) {
    const now = Date.now();
    switch (period) {
        case 'today':
            return { fromMs: startOfDay(now), toMs: now, label: 'Oggi' };
        case '7d':
            return { fromMs: now - 7 * 86_400_000, toMs: now, label: 'Ultimi 7 giorni' };
        case '30d':
            return { fromMs: now - 30 * 86_400_000, toMs: now, label: 'Ultimi 30 giorni' };
        case '90d':
            return { fromMs: now - 90 * 86_400_000, toMs: now, label: 'Ultimi 90 giorni' };
        case 'year':
            return { fromMs: startOfYear(now), toMs: now, label: 'Anno corrente' };
        case 'custom': {
            const f = fromStr ? new Date(fromStr).getTime() : now - 30 * 86_400_000;
            const t = toStr   ? new Date(toStr).getTime()   : now;
            return {
                fromMs: isNaN(f) ? now - 30 * 86_400_000 : f,
                toMs:   isNaN(t) ? now : t,
                label:  'Periodo personalizzato',
            };
        }
        default:
            return { fromMs: now - 30 * 86_400_000, toMs: now, label: 'Ultimi 30 giorni' };
    }
}

// ── Task helpers ──────────────────────────────────────────────────────────────

function withEffective(t) {
    let effectiveStatus = t.status;
    if (!['COMPLETED','CANCELLED'].includes(t.status) && t.dueDate) {
        const due = new Date(t.dueDate).getTime();
        if (!isNaN(due) && Date.now() > due) effectiveStatus = 'OVERDUE';
    }
    return { ...t, effectiveStatus };
}

/** Tasks ever handled by userId (current or previous assignee). */
function getUserRelatedTasks(allTasks, userId) {
    return (allTasks || []).filter(t => {
        if (t.assigneeId === userId) return true;
        return (t.history || []).some(h => h.type === 'ASSIGNEE_CHANGED' && h.from === userId);
    });
}

/** Tasks assigned to userId in [fromMs, toMs] (by createdAt). */
function tasksAssignedInPeriod(tasks, userId, fromMs, toMs) {
    return tasks.filter(t => t.assigneeId === userId && t.createdAt >= fromMs && t.createdAt <= toMs);
}

/** Tasks completed by userId (current assignee) in [fromMs, toMs]. */
function tasksCompletedInPeriod(tasks, userId, fromMs, toMs) {
    return tasks.filter(
        t => t.assigneeId === userId &&
             t.status === 'COMPLETED' &&
             t.completedAt != null &&
             t.completedAt >= fromMs &&
             t.completedAt <= toMs
    );
}

/** Tasks transferred FROM userId in [fromMs, toMs]. */
function tasksTransferredInPeriod(tasks, userId, fromMs, toMs) {
    return tasks.filter(t =>
        (t.history || []).some(
            h => h.type === 'ASSIGNEE_CHANGED' && h.from === userId && h.at >= fromMs && h.at <= toMs
        )
    );
}

/** Tasks cancelled while assigned to userId, in [fromMs, toMs] (by updatedAt). */
function tasksCancelledInPeriod(tasks, userId, fromMs, toMs) {
    return tasks.filter(
        t => t.assigneeId === userId &&
             t.status === 'CANCELLED' &&
             t.updatedAt >= fromMs && t.updatedAt <= toMs
    );
}

// ── Core Metrics ──────────────────────────────────────────────────────────────

/**
 * Compute operational metrics for a user in a period.
 *
 * @param {object[]} allTasks  — all company tasks (already company-filtered)
 * @param {string}   userId
 * @param {{ fromMs, toMs }} periodMs
 * @param {object[]} exceptions — exception records for the user (from getExceptionsForUser)
 * @returns {MetricsObject}
 */
function computeMetrics(allTasks, userId, periodMs, exceptions) {
    const { fromMs, toMs } = periodMs;
    const now = toMs || Date.now();

    // All user-related tasks
    const related   = getUserRelatedTasks(allTasks, userId);
    const assigned  = tasksAssignedInPeriod(related, userId, fromMs, toMs);
    const completed = tasksCompletedInPeriod(related, userId, fromMs, toMs);
    const transferred = tasksTransferredInPeriod(related, userId, fromMs, toMs);
    const cancelled = tasksCancelledInPeriod(related, userId, fromMs, toMs);

    // On-time vs late
    const completedOnTime = completed.filter(t => t.dueDate && t.completedAt <= new Date(t.dueDate).getTime());
    const completedLate   = completed.filter(t => t.dueDate && t.completedAt >  new Date(t.dueDate).getTime());
    const completedNoDue  = completed.filter(t => !t.dueDate);

    // Delays and anticipations
    const delays = completedLate.map(t =>
        Math.round((t.completedAt - new Date(t.dueDate).getTime()) / 60_000)
    );
    const anticipations = completedOnTime
        .filter(t => t.dueDate)
        .map(t => Math.round((new Date(t.dueDate).getTime() - t.completedAt) / 60_000));

    const avgDelay = delays.length
        ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
        : 0;
    const avgAnticipation = anticipations.length
        ? Math.round(anticipations.reduce((a, b) => a + b, 0) / anticipations.length)
        : 0;

    // Completion time (createdAt → completedAt) in minutes
    const compTimes = completed
        .filter(t => t.createdAt && t.completedAt)
        .map(t => Math.round((t.completedAt - t.createdAt) / 60_000));
    const avgCompletionTime = compTimes.length
        ? Math.round(compTimes.reduce((a, b) => a + b, 0) / compTimes.length)
        : 0;

    // Urgent and recurring
    const urgentAssigned  = assigned.filter(t => t.priority === 'URGENT');
    const urgentCompleted = completed.filter(t => t.priority === 'URGENT');
    const recurringAssigned  = assigned.filter(t => t.templateId);
    const recurringCompleted = completed.filter(t => t.templateId);

    // Current open tasks (regardless of period)
    const currentOpen     = related.filter(t => t.assigneeId === userId && t.status === 'OPEN');
    const currentInProg   = related.filter(t => t.assigneeId === userId && t.status === 'IN_PROGRESS');
    const currentOverdue  = related.filter(t => {
        if (t.assigneeId !== userId) return false;
        if (['COMPLETED','CANCELLED'].includes(t.status)) return false;
        return t.dueDate && new Date(t.dueDate).getTime() < now;
    });

    // Exception-register derived: blocked
    const periodExceptions = (exceptions || []).filter(e => {
        const at = new Date(e.recordedAt).getTime();
        return at >= fromMs && at <= toMs;
    });
    const blockedExceptions = periodExceptions.filter(e =>
        ['BLOCKED','WAITING_DEPT','WAITING_MATERIALS'].includes(e.type)
    );

    // Today sub-metrics (always relative to today's calendar day)
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs    = todayStart.getTime();
    const doneToday   = related.filter(t => t.assigneeId === userId && t.status === 'COMPLETED' && t.completedAt >= todayMs);
    const reassToday  = related.filter(t =>
        (t.history || []).some(h =>
            h.type === 'ASSIGNEE_CHANGED' && (h.from === userId || h.to === userId) && h.at >= todayMs
        )
    );

    return {
        // Period info
        fromMs, toMs,

        // Assigned
        assigned:           assigned.length,
        completed:          completed.length,
        completedOnTime:    completedOnTime.length,
        completedLate:      completedLate.length,
        completedNoDue:     completedNoDue.length,
        cancelled:          cancelled.length,
        transferred:        transferred.length,
        blocked:            blockedExceptions.length,

        // Rates
        onTimeRate:       completed.length ? completedOnTime.length / completed.length : null,
        lateRate:         completed.length ? completedLate.length   / completed.length : null,
        completionRate:   assigned.length  ? completed.length / assigned.length        : null,
        urgentAssigned:   urgentAssigned.length,
        urgentCompleted:  urgentCompleted.length,
        urgentRate:       urgentAssigned.length ? urgentCompleted.length / urgentAssigned.length : null,
        recurringAssigned:  recurringAssigned.length,
        recurringCompleted: recurringCompleted.length,
        recurringRate:    recurringAssigned.length ? recurringCompleted.length / recurringAssigned.length : null,

        // Time metrics (minutes)
        avgCompletionTime,
        avgDelay,
        avgAnticipation,

        // Current state
        currentOpen:    currentOpen.length,
        currentInProgress: currentInProg.length,
        currentOverdue: currentOverdue.length,

        // Today
        completedToday: doneToday.length,
        reassignedToday: reassToday.length,

        // Raw for history building
        _completed: completed,
        _transferred: transferred,
        _cancelled: cancelled,
        _periodExceptions: periodExceptions,
    };
}

// ── Reliability Index ─────────────────────────────────────────────────────────
/**
 * Deterministic Reliability Index (0–100).
 *
 * Weighting rules (documented):
 *
 *   Component 1 — On-time completion rate      : weight 35
 *     Score = onTimeRate × 35
 *     If no tasks with a due date completed: default = 17.5 (neutral)
 *
 *   Component 2 — Overall completion rate      : weight 20
 *     Score = completionRate × 20
 *     If no tasks assigned: default = 20 (neutral — no data to penalise)
 *
 *   Component 3 — Urgent task handling         : weight 15
 *     Score = urgentRate × 15
 *     If no urgent tasks assigned: default = 15 (full credit — never failed)
 *
 *   Component 4 — Recurring task compliance    : weight 10
 *     Score = recurringRate × 10
 *     If no recurring tasks assigned: default = 10 (full credit)
 *
 *   Component 5 — Status update consistency    : weight 10
 *     Score = min(completed / max(assigned, 1), 1.0) × 10
 *     Proxy for engagement: users who complete tasks also update status.
 *
 *   Component 6 — Volume engagement bonus      : weight 10
 *     Score = min(completed / 5, 1.0) × 10   (full credit at ≥ 5 completed)
 *
 *   Penalty A  — Late rate deduction           : max −10
 *     Deduction = lateRate × 10
 *
 *   Penalty B  — Blocked rate deduction        : max −5
 *     Deduction = min(blocked / max(assigned, 1), 1.0) × 5
 *
 *   Final = clamp(Σ components − Σ penalties, 0, 100)
 */
function computeReliabilityIndex(metrics) {
    if (!metrics || metrics.assigned === 0) {
        return {
            score:          null,
            classification: 'Dati insufficienti',
            components:     null,
        };
    }

    const onTimeRate      = metrics.onTimeRate      ?? 0.5;
    const completionRate  = metrics.completionRate  ?? 1.0;
    const urgentRate      = metrics.urgentRate      ?? 1.0; // default full credit
    const recurringRate   = metrics.recurringRate   ?? 1.0; // default full credit
    const lateRate        = metrics.lateRate        ?? 0;
    const blockedRate     = metrics.assigned > 0 ? metrics.blocked / metrics.assigned : 0;
    const engagementRate  = Math.min(metrics.completed / 5, 1.0);
    const consistencyRate = Math.min(metrics.completed / Math.max(metrics.assigned, 1), 1.0);

    const c1 = (metrics.onTimeRate === null ? 17.5 : onTimeRate * 35);
    const c2 = (metrics.completionRate === null ? 20  : completionRate * 20);
    const c3 = (metrics.urgentRate === null  ? 15  : urgentRate * 15);
    const c4 = (metrics.recurringRate === null ? 10 : recurringRate * 10);
    const c5 = consistencyRate * 10;
    const c6 = engagementRate  * 10;

    const pA = lateRate   * 10;
    const pB = Math.min(blockedRate * 5, 5);

    const raw   = c1 + c2 + c3 + c4 + c5 + c6;
    const score = Math.max(0, Math.min(100, Math.round(raw - pA - pB)));

    let classification;
    if (score >= 85)      classification = 'Eccellente';
    else if (score >= 70) classification = 'Molto Buono';
    else if (score >= 55) classification = 'Buono';
    else if (score >= 40) classification = 'Attenzione Richiesta';
    else                  classification = 'Critico';

    return {
        score,
        classification,
        components: {
            onTime:        Math.round(c1 * 10) / 10,
            completion:    Math.round(c2 * 10) / 10,
            urgent:        Math.round(c3 * 10) / 10,
            recurring:     Math.round(c4 * 10) / 10,
            consistency:   Math.round(c5 * 10) / 10,
            engagement:    Math.round(c6 * 10) / 10,
            penaltyLate:  -Math.round(pA * 10) / 10,
            penaltyBlocked: -Math.round(pB * 10) / 10,
        },
    };
}

// ── Strengths ─────────────────────────────────────────────────────────────────
/**
 * Generate factual strength statements from metrics.
 * Only uses measurable operational facts — no subjective evaluations.
 */
function generateStrengths(metrics, reliability) {
    const s = [];
    if (!metrics) return s;
    const { onTimeRate, completionRate, urgentRate, recurringRate, lateRate, completed, avgDelay } = metrics;
    const idx = reliability && reliability.score;

    if (onTimeRate !== null && onTimeRate >= 0.9)
        s.push(`Puntualità eccellente: il ${Math.round(onTimeRate * 100)}% delle attività completate in tempo.`);
    else if (onTimeRate !== null && onTimeRate >= 0.75)
        s.push(`Buona puntualità: il ${Math.round(onTimeRate * 100)}% delle attività completate entro la scadenza.`);

    if (completionRate !== null && completionRate >= 0.85)
        s.push(`Tasso di completamento molto alto (${Math.round(completionRate * 100)}%).`);

    if (urgentRate !== null && urgentRate === 1.0 && metrics.urgentAssigned > 0)
        s.push('Nessun compito urgente dimenticato.');
    else if (urgentRate !== null && urgentRate >= 0.85 && metrics.urgentAssigned > 0)
        s.push(`Ottima gestione delle urgenze (${Math.round(urgentRate * 100)}% completate).`);

    if (recurringRate === 1.0 && metrics.recurringAssigned > 0)
        s.push('Tutti i compiti ricorrenti completati nel periodo.');
    else if (recurringRate !== null && recurringRate >= 0.9 && metrics.recurringAssigned > 0)
        s.push(`Ottima conformità ai compiti ricorrenti (${Math.round(recurringRate * 100)}%).`);

    if (lateRate !== null && lateRate <= 0.05 && completed >= 3)
        s.push('Pochissimi ritardi. Prestazione molto regolare e affidabile.');

    if (idx !== null && idx >= 85)
        s.push(`Indice di affidabilità eccellente (${idx}/100).`);

    if (completed >= 20)
        s.push(`Volume di completamento elevato nel periodo: ${completed} attività.`);

    if (avgDelay === 0 && metrics.completedLate === 0 && completed > 0)
        s.push('Nessun ritardo registrato nel periodo.');

    return s;
}

// ── Coaching Opportunities ────────────────────────────────────────────────────
/**
 * Generate constructive improvement suggestions.
 * Factual — never criticises the employee personally.
 * Always proposes improvement.
 */
function generateCoachingOpportunities(metrics, reliability) {
    const c = [];
    if (!metrics) return c;
    const { onTimeRate, completionRate, urgentRate, recurringRate, lateRate, avgDelay, blocked, assigned } = metrics;

    if (lateRate !== null && lateRate > 0.3)
        c.push(`Il ${Math.round(lateRate * 100)}% delle attività completate presenta ritardi. Potrebbe essere utile rivedere la pianificazione o il carico di lavoro.`);
    else if (lateRate !== null && lateRate > 0.15)
        c.push(`Alcuni ritardi rilevati (${Math.round(lateRate * 100)}% delle attività). Considerare la gestione delle priorità.`);

    if (urgentRate !== null && urgentRate < 0.7 && metrics.urgentAssigned > 0)
        c.push(`Solo il ${Math.round(urgentRate * 100)}% dei compiti urgenti è stato completato. Le urgenze richiedono attenzione prioritaria.`);

    if (recurringRate !== null && recurringRate < 0.8 && metrics.recurringAssigned > 0)
        c.push('I compiti ricorrenti vengono occasionalmente dimenticati. Un promemoria o pianificazione potrebbe aiutare.');

    if (completionRate !== null && completionRate < 0.6 && assigned >= 5)
        c.push('Molti compiti rimangono aperti. Potrebbe essere utile una revisione del carico di lavoro o supporto dal team.');

    if (blocked > 0)
        c.push(`${blocked === 1 ? 'Un compito è risultato bloccato' : `${blocked} compiti sono risultati bloccati`}. Verificare se è necessario supporto operativo o chiarimenti.`);

    if (avgDelay > 120)
        c.push(`Il ritardo medio di completamento è di ${avgDelay} minuti. Pianificare le attività con margine potrebbe ridurre i ritardi.`);

    if (reliability && reliability.score !== null && reliability.score < 40)
        c.push('L\'indice di affidabilità è basso. Un piano di miglioramento graduale con obiettivi chiari può aiutare.');

    return c;
}

// ── Task Outcome Classification ───────────────────────────────────────────────
/**
 * Classify a single task's outcome relative to a userId.
 *
 * Possible outcomes:
 *   COMPLETED_ON_TIME | COMPLETED_LATE | CANCELLED | TRANSFERRED |
 *   BLOCKED | OPEN | IN_PROGRESS | OVERDUE
 */
function classifyTaskOutcome(task, userId, exceptions) {
    const excTypes = (exceptions || [])
        .filter(e => e.taskId === task.id)
        .map(e => e.type);

    const wasTransferred = (task.history || []).some(
        h => h.type === 'ASSIGNEE_CHANGED' && h.from === userId
    );
    if (wasTransferred) return 'TRANSFERRED';

    if (excTypes.some(t => ['BLOCKED','WAITING_DEPT','WAITING_MATERIALS'].includes(t)))
        return 'BLOCKED';

    if (task.status === 'CANCELLED') return 'CANCELLED';

    if (task.status === 'COMPLETED') {
        if (!task.dueDate) return 'COMPLETED_ON_TIME';
        return task.completedAt <= new Date(task.dueDate).getTime()
            ? 'COMPLETED_ON_TIME'
            : 'COMPLETED_LATE';
    }

    if (task.status === 'IN_PROGRESS') return 'IN_PROGRESS';

    // OPEN — check overdue
    if (task.dueDate && new Date(task.dueDate).getTime() < Date.now()) return 'OVERDUE';
    return 'OPEN';
}

/**
 * Build classified task history for the performance page.
 * Returns the most recent `limit` tasks (by updatedAt desc).
 */
function buildTaskHistory(relatedTasks, userId, exceptions, limit) {
    return relatedTasks
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, limit || 50)
        .map(t => ({
            id:          t.id,
            title:       t.title,
            status:      t.status,
            outcome:     classifyTaskOutcome(t, userId, exceptions),
            priority:    t.priority,
            department:  t.department || null,
            dueDate:     t.dueDate || null,
            completedAt: t.completedAt || null,
            createdAt:   t.createdAt,
            updatedAt:   t.updatedAt || null,
        }));
}

// ── Evolution ─────────────────────────────────────────────────────────────────
/**
 * Compare performance across three periods:
 *   currentMonth, prevMonth, last90days
 *
 * Direction: IMPROVING | STABLE | DECLINING
 *   Based on completionRate and onTimeRate weighted equally.
 *   IMPROVING: current > previous by > 5 pp
 *   DECLINING: current < previous by > 5 pp
 *   STABLE: within 5 pp
 */
function computeEvolution(allTasks, userId, exceptions) {
    const now = Date.now();
    const curMonthStart  = startOfMonth(now);
    const prevMonthEnd   = curMonthStart - 1;
    const prevMonthStart = startOfMonth(prevMonthEnd);
    const last90Start    = now - 90 * 86_400_000;

    const userExceptions = (exceptions || []).filter(e => e.userId === userId);

    function periodMetrics(fromMs, toMs) {
        return computeMetrics(allTasks, userId, { fromMs, toMs }, userExceptions);
    }

    const cur  = periodMetrics(curMonthStart, now);
    const prev = periodMetrics(prevMonthStart, prevMonthEnd);
    const l90  = periodMetrics(last90Start, now);

    function direction(m1, m2) {
        if (m1.completionRate === null || m2.completionRate === null)
            return { direction: 'INSUFFICIENT_DATA', delta: null };
        const delta = (m1.completionRate - m2.completionRate) * 100;
        if (delta > 5)  return { direction: 'IMPROVING',  delta: Math.round(delta) };
        if (delta < -5) return { direction: 'DECLINING',  delta: Math.round(delta) };
        return { direction: 'STABLE', delta: Math.round(delta) };
    }

    return {
        currentMonth: {
            fromMs: curMonthStart, toMs: now,
            label: 'Mese corrente',
            metrics: { completionRate: cur.completionRate, onTimeRate: cur.onTimeRate, completed: cur.completed, assigned: cur.assigned },
        },
        prevMonth: {
            fromMs: prevMonthStart, toMs: prevMonthEnd,
            label: 'Mese precedente',
            metrics: { completionRate: prev.completionRate, onTimeRate: prev.onTimeRate, completed: prev.completed, assigned: prev.assigned },
        },
        last90: {
            fromMs: last90Start, toMs: now,
            label: 'Ultimi 90 giorni',
            metrics: { completionRate: l90.completionRate, onTimeRate: l90.onTimeRate, completed: l90.completed, assigned: l90.assigned },
        },
        curVsPrev:  direction(cur, prev),
        curVs90:    direction(cur, l90),
    };
}

// ── Workload History ──────────────────────────────────────────────────────────
/**
 * Compute workload history statistics for a user.
 * Derived from task data — no external snapshot dependency.
 *
 * OVERLOADED threshold: ≥ 8 tasks active on a day
 * UNDERLOADED threshold: 0 tasks active on a day (while user account existed)
 */
function computeWorkloadHistory(allTasks, userId) {
    const userTasks = getUserRelatedTasks(allTasks, userId);

    // Group by active date: for each task, count the days it was active (createdAt → completedAt or now)
    const now = Date.now();
    const dayCounts = {};

    userTasks.filter(t => t.assigneeId === userId).forEach(t => {
        const start = startOfDay(t.createdAt);
        const end   = t.completedAt ? startOfDay(t.completedAt) : startOfDay(now);
        for (let d = start; d <= end; d += 86_400_000) {
            const key = new Date(d).toISOString().slice(0, 10);
            dayCounts[key] = (dayCounts[key] || 0) + 1;
        }
    });

    const days = Object.values(dayCounts);
    if (!days.length) {
        return { avgDailyTasks: 0, peakWorkload: 0, daysOverloaded: 0, daysUnderloaded: 0, avgWorkloadScore: 0 };
    }

    const avgDailyTasks   = Math.round(days.reduce((a, b) => a + b, 0) / days.length * 10) / 10;
    const peakWorkload    = Math.max(...days);
    const daysOverloaded  = days.filter(n => n >= 8).length;
    const daysUnderloaded = days.filter(n => n === 0).length;
    // Workload score proxy: assigned*1 + no overdue info available here, use count
    const avgWorkloadScore = avgDailyTasks;

    return { avgDailyTasks, peakWorkload, daysOverloaded, daysUnderloaded, avgWorkloadScore };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
    parsePeriod,
    computeMetrics,
    computeReliabilityIndex,
    generateStrengths,
    generateCoachingOpportunities,
    computeEvolution,
    computeWorkloadHistory,
    classifyTaskOutcome,
    buildTaskHistory,
    getUserRelatedTasks,
    // Exported for tests
    _startOfDay:   startOfDay,
    _startOfMonth: startOfMonth,
};
