'use strict';
/**
 * PlateTimer Operations — Trend Engine (Sprint 6.2)
 *
 * Compares current operational metrics with yesterday's snapshot and the
 * trailing 7-day average. Fully deterministic — no AI, no ML, no randomness.
 *
 * Directions: IMPROVING | STABLE | WORSENING | INSUFFICIENT_DATA
 */

// ── Single-field trend computation ────────────────────────────────────────────

/**
 * Compute the trend for one metric.
 *
 * @param {number}  current
 * @param {number|null} previous  — null → INSUFFICIENT_DATA
 * @param {{ lowerIsBetter?: boolean, unit?: string }} opts
 * @returns {{ currentValue, previousValue, delta, direction, interpretation }}
 */
function computeTrend(current, previous, { lowerIsBetter = false, unit = '' } = {}) {
    if (previous === null || previous === undefined) {
        return {
            currentValue:    current,
            previousValue:   null,
            delta:           null,
            direction:       'INSUFFICIENT_DATA',
            interpretation:  'Dati storici non disponibili per il confronto.',
        };
    }

    const delta = current - previous;
    let direction;
    if (delta === 0)          direction = 'STABLE';
    else if (lowerIsBetter)   direction = delta < 0 ? 'IMPROVING' : 'WORSENING';
    else                      direction = delta > 0 ? 'IMPROVING' : 'WORSENING';

    let interpretation;
    if (direction === 'STABLE') {
        interpretation = `Il carico operativo è stabile rispetto a ieri (${current}${unit}).`;
    } else if (lowerIsBetter) {
        if (direction === 'IMPROVING')
            interpretation = `Le attività in ritardo sono diminuite da ${previous} a ${current}${unit}.`;
        else
            interpretation = `Le attività in ritardo sono aumentate da ${previous} a ${current}${unit}.`;
    } else {
        if (direction === 'IMPROVING')
            interpretation = `Il tasso di completamento è migliorato da ${previous} a ${current}${unit}.`;
        else
            interpretation = `Il tasso di completamento è diminuito da ${previous} a ${current}${unit}.`;
    }

    return { currentValue: current, previousValue: previous, delta, direction, interpretation };
}

// ── 7-day average helper ──────────────────────────────────────────────────────

/**
 * Compute the integer average of `field` across at most 7 historical snapshots.
 * Returns null if no snapshots contain the field.
 */
function sevenDayAvg(snapshots, field) {
    const valid = (snapshots || [])
        .filter(s => typeof s[field] === 'number')
        .slice(0, 7);
    if (!valid.length) return null;
    return Math.round(valid.reduce((s, snap) => s + snap[field], 0) / valid.length);
}

// ── Full trend analysis ───────────────────────────────────────────────────────

/**
 * Produce a trends object for the Director dashboard.
 *
 * @param {object} currentSummary  — summary block from analyzeIntelligence()
 * @param {object|null} yesterdaySnapshot
 * @param {object[]} recentSnapshots  — array of ≤7 past snapshots (newest first, excl. today)
 */
function analyzeTrends(currentSummary, yesterdaySnapshot, recentSnapshots) {
    const y = yesterdaySnapshot;

    // ── Overdue ───────────────────────────────────────────────────────────────
    const overdueTrend = computeTrend(
        currentSummary.overdueToday,
        y ? y.overdueTasks : null,
        { lowerIsBetter: true }
    );
    const avg7Overdue = sevenDayAvg(recentSnapshots, 'overdueTasks');
    if (avg7Overdue !== null) {
        overdueTrend.sevenDayAvg = avg7Overdue;
        const diff = currentSummary.overdueToday - avg7Overdue;
        if (diff < 0)
            overdueTrend.sevenDayInterpretation =
                `Le attività in ritardo sono inferiori di ${Math.abs(diff)} rispetto alla media degli ultimi 7 giorni.`;
        else if (diff > 0)
            overdueTrend.sevenDayInterpretation =
                `Le attività in ritardo sono superiori di ${diff} rispetto alla media degli ultimi 7 giorni.`;
        else
            overdueTrend.sevenDayInterpretation = 'In linea con la media degli ultimi 7 giorni.';
    }

    // ── Completion rate ───────────────────────────────────────────────────────
    const crTrend = computeTrend(
        currentSummary.completionRate,
        y ? y.completionRate : null,
        { lowerIsBetter: false, unit: '%' }
    );
    const avg7Cr = sevenDayAvg(recentSnapshots, 'completionRate');
    if (avg7Cr !== null) {
        crTrend.sevenDayAvg = avg7Cr;
        const diff = currentSummary.completionRate - avg7Cr;
        if (Math.abs(diff) <= 2)
            crTrend.sevenDayInterpretation = 'In linea con la media degli ultimi 7 giorni.';
        else if (diff < 0)
            crTrend.sevenDayInterpretation =
                `Il tasso di completamento è inferiore di ${Math.abs(diff)} punti rispetto alla media degli ultimi 7 giorni.`;
        else
            crTrend.sevenDayInterpretation =
                `Il tasso di completamento è superiore di ${diff} punti rispetto alla media degli ultimi 7 giorni.`;
    }

    // ── Urgent tasks ──────────────────────────────────────────────────────────
    const urgentTrend = computeTrend(
        currentSummary.urgentOpen,
        y ? y.urgentTasks : null,
        { lowerIsBetter: true }
    );

    // ── Workload (overloaded users) ───────────────────────────────────────────
    const wlTrend = computeTrend(
        (currentSummary.usersNeedingAttention || []).filter(u => u.reason === 'OVERLOADED').length,
        y ? y.overloadedUsers : null,
        { lowerIsBetter: true }
    );

    // ── Average completion time ───────────────────────────────────────────────
    const avg7Time = sevenDayAvg(recentSnapshots, 'averageCompletionTime');
    const avgTimeTrend = {
        currentValue:   null,  // not available from summary alone
        previousValue:  y ? y.averageCompletionTime : null,
        delta:          null,
        direction:      avg7Time !== null ? 'INSUFFICIENT_DATA' : 'INSUFFICIENT_DATA',
        interpretation: 'Il tempo medio di completamento non è disponibile per confronto diretto.',
    };
    if (avg7Time !== null) avgTimeTrend.sevenDayAvg = avg7Time;

    return {
        overdue:               overdueTrend,
        completionRate:        crTrend,
        urgentTasks:           urgentTrend,
        workload:              wlTrend,
        averageCompletionTime: avgTimeTrend,
    };
}

module.exports = {
    computeTrend,
    analyzeTrends,
    _sevenDayAvg: sevenDayAvg,
};
