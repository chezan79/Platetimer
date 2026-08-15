'use strict';
/**
 * PlateTimer Operations — Executive Assistant Engine (Sprint 6.3)
 *
 * Transforms existing intelligence data (Sprint 6.0–6.2) into a concise
 * operational assistant output:
 *
 *  generatePriorityQueue(decisions) → ranked action items
 *  detectRisks(tasks, users, workload, lang)               → risk items (CRITICAL→LOW)
 *  buildChangesSince(trends, yesterdaySnap, summary, lang) → meaningful change sentences
 *  buildExecutiveBrief(role, ..., lang)                    → structured brief
 *
 * No AI, no ML, no external APIs.  Everything deterministic and explainable.
 */

const opsI18n = require('./ops-i18n');

const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const RISK_ORDER     = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowMs() { return Date.now(); }

function withEffective(t) {
    let effectiveStatus = t.status;
    if (!['COMPLETED','CANCELLED'].includes(t.status) && t.dueDate) {
        const due = new Date(t.dueDate).getTime();
        if (!isNaN(due) && nowMs() > due) effectiveStatus = 'OVERDUE';
    }
    return { ...t, effectiveStatus };
}

// ── 1. Priority Queue ─────────────────────────────────────────────────────────
/**
 * Derive a ranked list of recommended actions from the decision cards.
 * No i18n needed here — text comes from already-translated decision cards.
 *
 * @param {object[]} decisions — already sorted by severity→confidence
 * @returns {Array<{rank, priority, reason, confidence, linkedTask, linkedUser,
 *                  linkedDept, recommendedAction, quickAction}>}
 */
function generatePriorityQueue(decisions) {
    if (!decisions || !decisions.length) return [];

    return decisions
        .slice(0, 10)
        .map((d, i) => ({
            rank:             i + 1,
            priority:         d.severity,   // HIGH | MEDIUM | LOW
            reason:           d.reason,
            confidence:       d.confidence,
            title:            d.title,
            linkedTask:       d.linkedTask   || null,
            linkedUser:       d.linkedUser   || null,
            linkedDept:       d.department   || null,
            recommendedAction: d.recommendedAction,
            quickAction:      d.quickAction  || null,
        }));
}

// ── 2. Risk Watch ─────────────────────────────────────────────────────────────
/**
 * Identify tasks or users that are likely to become problematic soon.
 * Uses only deterministic rules — no randomness.
 *
 * Risk levels: CRITICAL > HIGH > MEDIUM > LOW
 *
 * @param {object[]} rawTasks
 * @param {object[]} users
 * @param {object[]} workload  — from analyzeIntelligence
 * @param {string}   [lang='it']
 * @returns {Array<{riskId, level, title, description, linkedTask, linkedUser,
 *                  linkedDept, minutesUntilDue?, _deptRiskKind?}>}
 */
function detectRisks(rawTasks, users, workload, lang = 'it') {
    lang = opsI18n.sanitizeLang(lang);
    const t = (key, vars) => opsI18n.t(lang, key, vars);

    const tasks = (rawTasks || []).map(withEffective);
    const wl    = workload || [];
    const now   = nowMs();
    const risks  = [];
    let riskId  = 0;
    const nid   = () => `risk_${++riskId}`;

    // Reusable lookup
    const overloadedIds = new Set(wl.filter(w => w.status === 'OVERLOADED').map(w => w.userId));
    const suspendedIds  = new Set((users || []).filter(u => u.status === 'SUSPENDED').map(u => u.id));

    // ── CRITICAL: urgent AND overdue AND assignee is overloaded ──────────────
    tasks
        .filter(t2 =>
            t2.priority === 'URGENT' &&
            t2.effectiveStatus === 'OVERDUE' &&
            t2.assigneeId && overloadedIds.has(t2.assigneeId)
        )
        .forEach(t2 => {
            const overMin = Math.round((now - new Date(t2.dueDate).getTime()) / 60_000);
            risks.push({
                riskId: nid(), level: 'CRITICAL',
                title:       t('ops.risk.criticalOverloaded.title'),
                description: t('ops.risk.criticalOverloaded.desc', { title: t2.title, min: overMin }),
                linkedTask:  t2.id,
                linkedUser:  t2.assigneeId || null,
                linkedDept:  t2.department || null,
            });
        });

    // ── CRITICAL: suspended user still has urgent tasks ───────────────────────
    tasks
        .filter(t2 =>
            t2.priority === 'URGENT' &&
            !['COMPLETED','CANCELLED'].includes(t2.status) &&
            t2.assigneeId && suspendedIds.has(t2.assigneeId)
        )
        .forEach(t2 => {
            risks.push({
                riskId: nid(), level: 'CRITICAL',
                title:       t('ops.risk.criticalSuspended.title'),
                description: t('ops.risk.criticalSuspended.desc', { title: t2.title }),
                linkedTask:  t2.id,
                linkedUser:  t2.assigneeId || null,
                linkedDept:  t2.department || null,
            });
        });

    // ── HIGH: task due within 60 minutes and not started (status OPEN) ────────
    tasks
        .filter(t2 => {
            if (t2.status !== 'OPEN' || !t2.dueDate) return false;
            const dueMs = new Date(t2.dueDate).getTime();
            const minsLeft = (dueMs - now) / 60_000;
            return minsLeft > 0 && minsLeft <= 60;
        })
        .forEach(t2 => {
            const minsLeft = Math.round((new Date(t2.dueDate).getTime() - now) / 60_000);
            risks.push({
                riskId: nid(), level: 'HIGH',
                title:          t('ops.risk.highDeadline.title'),
                description:    t('ops.risk.highDeadline.desc', { title: t2.title, min: minsLeft }),
                linkedTask:     t2.id,
                linkedUser:     t2.assigneeId || null,
                linkedDept:     t2.department || null,
                minutesUntilDue: minsLeft,
            });
        });

    // ── HIGH: user overloaded ─────────────────────────────────────────────────
    wl.filter(w => w.status === 'OVERLOADED').forEach(w => {
        risks.push({
            riskId: nid(), level: 'HIGH',
            title:       t('ops.risk.highOverloaded.title', { name: w.userName }),
            description: t('ops.risk.highOverloaded.desc',  { score: w.currentLoadScore, assigned: w.assigned, overdue: w.overdue, urgent: w.urgent }),
            linkedTask:  null,
            linkedUser:  w.userId,
            linkedDept:  null,
        });
    });

    // ── HIGH: urgent task overdue but assignee not overloaded (not already CRITICAL) ─
    tasks
        .filter(t2 =>
            t2.priority === 'URGENT' &&
            t2.effectiveStatus === 'OVERDUE' &&
            !(t2.assigneeId && overloadedIds.has(t2.assigneeId))  // CRITICAL already covers overloaded
        )
        .forEach(t2 => {
            const overdueMin = Math.round((now - new Date(t2.dueDate).getTime()) / 60_000);
            risks.push({
                riskId: nid(), level: 'HIGH',
                title:       t('ops.risk.highUrgentOverdue.title', { title: t2.title }),
                description: t('ops.risk.highUrgentOverdue.desc',  { title: t2.title, min: overdueMin }),
                linkedTask:  t2.id,
                linkedUser:  t2.assigneeId || null,
                linkedDept:  t2.department || null,
            });
        });

    // ── HIGH: urgent task not started at all ──────────────────────────────────
    tasks
        .filter(t2 => t2.priority === 'URGENT' && t2.status === 'OPEN' && t2.effectiveStatus !== 'OVERDUE')
        .forEach(t2 => {
            if (t2.assigneeId && overloadedIds.has(t2.assigneeId)) return; // already CRITICAL
            risks.push({
                riskId: nid(), level: 'HIGH',
                title:       t('ops.risk.highUrgentNotStarted.title', { title: t2.title }),
                description: t('ops.risk.highUrgentNotStarted.desc',  { title: t2.title }),
                linkedTask:  t2.id,
                linkedUser:  t2.assigneeId || null,
                linkedDept:  t2.department || null,
            });
        });

    // ── MEDIUM: IN_PROGRESS task inactive for ≥ 4 hours ──────────────────────
    const INACTIVE_CUTOFF = now - 4 * 3_600_000;
    tasks
        .filter(t2 =>
            t2.status === 'IN_PROGRESS' &&
            t2.updatedAt &&
            new Date(t2.updatedAt).getTime() < INACTIVE_CUTOFF
        )
        .forEach(t2 => {
            const hrsInactive = Math.round((now - new Date(t2.updatedAt).getTime()) / 3_600_000);
            risks.push({
                riskId: nid(), level: 'MEDIUM',
                title:       t('ops.risk.mediumInactive.title'),
                description: t('ops.risk.mediumInactive.desc', { title: t2.title, hours: hrsInactive }),
                linkedTask:  t2.id,
                linkedUser:  t2.assigneeId || null,
                linkedDept:  t2.department || null,
            });
        });

    // ── MEDIUM: recurring task overdue ────────────────────────────────────────
    tasks
        .filter(t2 => t2.effectiveStatus === 'OVERDUE' && t2.templateId)
        .forEach(t2 => {
            const overMin = Math.round((now - new Date(t2.dueDate).getTime()) / 60_000);
            risks.push({
                riskId: nid(), level: 'MEDIUM',
                title:       t('ops.risk.mediumRecurring.title'),
                description: t('ops.risk.mediumRecurring.desc', { title: t2.title, min: overMin }),
                linkedTask:  t2.id,
                linkedUser:  t2.assigneeId || null,
                linkedDept:  t2.department || null,
            });
        });

    // ── MEDIUM: department with ≥ 3 overdue tasks ─────────────────────────────
    const deptOverdue = {};
    tasks
        .filter(t2 => t2.effectiveStatus === 'OVERDUE' && t2.department)
        .forEach(t2 => { deptOverdue[t2.department] = (deptOverdue[t2.department] || 0) + 1; });
    Object.entries(deptOverdue)
        .filter(([, cnt]) => cnt >= 3)
        .forEach(([dept, cnt]) => {
            risks.push({
                riskId: nid(), level: 'MEDIUM',
                title:          t('ops.risk.mediumDeptOverdue.title', { dept }),
                description:    t('ops.risk.mediumDeptOverdue.desc',  { dept, n: cnt }),
                linkedTask:     null,
                linkedUser:     null,
                linkedDept:     dept,
                _deptRiskKind:  'overdue',   // language-agnostic dedup marker
            });
        });

    // ── LOW: task open > 48 hours with no update ──────────────────────────────
    const STALE_CUTOFF = now - 48 * 3_600_000;
    tasks
        .filter(t2 =>
            t2.status === 'OPEN' &&
            t2.createdAt &&
            new Date(t2.createdAt).getTime() < STALE_CUTOFF &&
            (!t2.updatedAt || new Date(t2.updatedAt).getTime() < STALE_CUTOFF)
        )
        .forEach(t2 => {
            const daysOld = Math.round((now - new Date(t2.createdAt).getTime()) / 86_400_000);
            risks.push({
                riskId: nid(), level: 'LOW',
                title:       t('ops.risk.lowStale.title', { days: daysOld }),
                description: t('ops.risk.lowStale.desc',  { title: t2.title, days: daysOld }),
                linkedTask:  t2.id,
                linkedUser:  t2.assigneeId || null,
                linkedDept:  t2.department || null,
            });
        });

    // ── LOW: department with ≥ 2 urgent tasks ────────────────────────────────
    const deptUrgent = {};
    tasks
        .filter(t2 =>
            t2.priority === 'URGENT' &&
            !['COMPLETED','CANCELLED'].includes(t2.status) &&
            t2.department
        )
        .forEach(t2 => { deptUrgent[t2.department] = (deptUrgent[t2.department] || 0) + 1; });
    Object.entries(deptUrgent)
        .filter(([, cnt]) => cnt >= 2)
        .forEach(([dept, cnt]) => {
            // Only raise LOW if not already raised as MEDIUM (dept overdue ≥3)
            if ((deptOverdue[dept] || 0) >= 3) return;
            risks.push({
                riskId: nid(), level: 'LOW',
                title:         t('ops.risk.lowDeptUrgent.title', { dept }),
                description:   t('ops.risk.lowDeptUrgent.desc',  { dept, n: cnt }),
                linkedTask:    null,
                linkedUser:    null,
                linkedDept:    dept,
                _deptRiskKind: 'urgent',   // language-agnostic dedup marker
            });
        });

    // ── LOW: BUSY user with at least one overdue task ─────────────────────────
    wl.filter(w => w.status === 'BUSY' && w.overdue >= 1 && !overloadedIds.has(w.userId)).forEach(w => {
        risks.push({
            riskId: nid(), level: 'LOW',
            title:       t('ops.risk.lowBusy.title', { name: w.userName }),
            description: t('ops.risk.lowBusy.desc',  { name: w.userName, score: w.currentLoadScore, overdue: w.overdue }),
            linkedTask:  null,
            linkedUser:  w.userId,
            linkedDept:  null,
        });
    });

    // Sort: CRITICAL → HIGH → MEDIUM → LOW, then by title for determinism
    const sorted = risks.sort((a, b) => {
        const r = RISK_ORDER[a.level] - RISK_ORDER[b.level];
        return r !== 0 ? r : a.title.localeCompare(b.title);
    });

    return deduplicateRisks(sorted);
}

// ── Risk Watch deduplication ───────────────────────────────────────────────────
/**
 * Collapse multiple risk items that concern the same underlying entity.
 * Uses `_deptRiskKind` ('overdue'|'urgent') when available; falls back to
 * checking for 'ritardo' in description for backward compatibility with
 * direct test calls that supply Italian descriptions.
 */
function deduplicateRisks(risks) {
    function dedupKey(risk) {
        if (risk.linkedTask) return `task:${risk.linkedTask}`;
        if (risk.linkedUser && !risk.linkedDept) return `user:${risk.linkedUser}:overload`;
        if (risk.linkedDept) {
            // Prefer the explicit kind marker; fall back to Italian keyword for compat
            let kind = risk._deptRiskKind;
            if (!kind) {
                kind = (risk.description && risk.description.includes('ritardo')) ? 'overdue' : 'urgent';
            }
            return `department:${risk.linkedDept}:${kind}`;
        }
        return `misc:${risk.title}`;
    }

    const map = new Map();

    for (const risk of risks) {
        const key = dedupKey(risk);
        if (!map.has(key)) {
            map.set(key, { ...risk, dedupKey: key, reasons: [risk.description] });
        } else {
            const winner = map.get(key);
            if (!winner.reasons.includes(risk.description)) {
                winner.reasons.push(risk.description);
            }
            if (RISK_ORDER[risk.level] < RISK_ORDER[winner.level]) {
                winner.level       = risk.level;
                winner.title       = risk.title;
                winner.description = risk.description;
            }
        }
    }

    return Array.from(map.values());
}

// ── 5. New Since Last Visit ───────────────────────────────────────────────────
/**
 * @param {{riskWatch, decisions, tasks, previousVisitAt, now, lang?}} opts
 * @returns {{ previousVisitAt, newCount, newCritical, newHigh, items[] }}
 */
function buildNewSinceLastVisit({ riskWatch, decisions, tasks, previousVisitAt, now, lang = 'it' }) {
    now  = now || Date.now();
    lang = opsI18n.sanitizeLang(lang);
    const t = (key, vars) => opsI18n.t(lang, key, vars);

    if (!previousVisitAt) {
        return { previousVisitAt: null, newCount: 0, newCritical: 0, newHigh: 0, items: [] };
    }

    const prev      = previousVisitAt;
    const taskMap   = new Map((tasks || []).map(t2 => [t2.id, t2]));
    const newItems  = [];
    const seenIds   = new Set();

    function addItem(id, type, severity, title, description, linkedTask, linkedUser, linkedDept, eventTime) {
        if (!['CRITICAL', 'HIGH'].includes(severity)) return;
        if (eventTime <= prev) return;
        if (seenIds.has(id)) return;
        seenIds.add(id);
        newItems.push({ id, type, severity, title, description, linkedTask, linkedUser, linkedDept, createdAt: eventTime });
    }

    // ── Source 1: HIGH/CRITICAL Risk Watch items ───────────────────────────
    for (const rk of (riskWatch || [])) {
        if (!['CRITICAL', 'HIGH'].includes(rk.level)) continue;
        const task2 = rk.linkedTask ? taskMap.get(rk.linkedTask) : null;
        const eventTime = task2
            ? (task2.updatedAt || task2.createdAt || now)
            : now;
        const itemId = `rw:${rk.dedupKey || rk.riskId}`;
        addItem(itemId, 'RISK', rk.level, rk.title, rk.description,
                rk.linkedTask || null, rk.linkedUser || null, rk.linkedDept || null, eventTime);
    }

    // ── Source 2: HIGH/CRITICAL Decision Cards ─────────────────────────────
    for (const d of (decisions || [])) {
        if (!['HIGH'].includes(d.severity)) continue;
        const task2 = d.linkedTask ? taskMap.get(d.linkedTask) : null;
        const eventTime = task2 ? (task2.updatedAt || task2.createdAt || now) : now;
        const itemId = `dec:${d.type || d.title}:${d.linkedTask || d.linkedUser || ''}`;
        addItem(itemId, 'DECISION', d.severity, d.title, d.reason,
                d.linkedTask || null, d.linkedUser || null, d.department || null, eventTime);
    }

    // ── Source 3: Urgent tasks created after last visit ────────────────────
    for (const t2 of (tasks || [])) {
        if (t2.priority !== 'URGENT') continue;
        if (['COMPLETED', 'CANCELLED'].includes(t2.status)) continue;
        const eventTime = t2.createdAt || now;
        if (eventTime <= prev) continue;
        const itemId = `urgent:${t2.id}`;
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);
        newItems.push({
            id: itemId, type: 'URGENT_TASK', severity: 'HIGH',
            title:       t('ops.nsv.urgentNew.title', { title: t2.title }),
            description: t('ops.nsv.urgentNew.desc',  { title: t2.title }),
            linkedTask: t2.id, linkedUser: t2.assigneeId || null, linkedDept: t2.department || null,
            createdAt: eventTime,
        });
    }

    // ── Source 4: New escalations triggered after last visit ───────────────
    for (const t2 of (tasks || [])) {
        if (!t2.escalationSentAt) continue;
        if (['COMPLETED', 'CANCELLED'].includes(t2.status)) continue;
        const eventTime = typeof t2.escalationSentAt === 'number'
            ? t2.escalationSentAt : new Date(t2.escalationSentAt).getTime();
        if (isNaN(eventTime) || eventTime <= prev) continue;
        const itemId = `esc:${t2.id}`;
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);
        newItems.push({
            id: itemId, type: 'ESCALATION', severity: 'HIGH',
            title:       t('ops.nsv.escalation.title', { title: t2.title }),
            description: t('ops.nsv.escalation.desc',  { title: t2.title }),
            linkedTask: t2.id, linkedUser: t2.assigneeId || null, linkedDept: t2.department || null,
            createdAt: eventTime,
        });
    }

    // ── Cross-source deduplication ─────────────────────────────────────────
    // The four sources above use disjoint ID namespaces so within-source
    // deduplication (seenIds) cannot prevent the same underlying condition
    // from appearing multiple times across sources.
    //
    // Example: a single newly-created URGENT+OPEN task produces:
    //   Source 1 → RISK "urgent task not started"   (key rw:task:{id})
    //   Source 2 → DECISION "OPENING_NOT_STARTED"   (key dec:OPENING_NOT_STARTED:{id})
    //   Source 3 → URGENT_TASK "new urgent task"    (key urgent:{id})
    // All three keys are distinct → all three pass seenIds → three identical
    // HIGH entries for one underlying condition.
    //
    // Rule: group items by their underlying entity.  Within each group keep:
    //   • all ESCALATION items (each is a distinct timed event)
    //   • at most ONE non-ESCALATION item (best severity; tie-break by type
    //     priority RISK > DECISION > URGENT_TASK)
    const deduped = crossSourceDeduplicate(newItems);

    // Sort: CRITICAL first, then HIGH; within same severity by createdAt desc
    deduped.sort((a, b) => {
        const sv = RISK_ORDER[a.severity] - RISK_ORDER[b.severity];
        return sv !== 0 ? sv : b.createdAt - a.createdAt;
    });

    const newCritical = deduped.filter(i => i.severity === 'CRITICAL').length;
    const newHigh     = deduped.filter(i => i.severity === 'HIGH').length;

    return {
        previousVisitAt: prev,
        newCount:    deduped.length,
        newCritical,
        newHigh,
        items: deduped,
    };
}

// ── Cross-source deduplication for buildNewSinceLastVisit ─────────────────────
// Groups NSV items by their underlying entity and collapses non-ESCALATION
// items within each group to a single best representative.
//
// Entity key priority: linkedTask > linkedUser > linkedDept > id (misc)
// Type priority for tie-breaking: RISK(0) > DECISION(1) > URGENT_TASK(2)
// ESCALATION items are always kept separately (distinct timed events).
const NSV_TYPE_PRIORITY = { RISK: 0, DECISION: 1, URGENT_TASK: 2 };

function crossSourceDeduplicate(items) {
    function entityKey(item) {
        if (item.linkedTask)  return `task:${item.linkedTask}`;
        if (item.linkedUser)  return `user:${item.linkedUser}`;
        if (item.linkedDept)  return `dept:${item.linkedDept}`;
        return `misc:${item.id}`;
    }

    // Separate escalations (always kept) from current-state items (dedup needed)
    const escalations   = items.filter(i => i.type === 'ESCALATION');
    const currentState  = items.filter(i => i.type !== 'ESCALATION');

    // Within current-state items, keep one per entity (best severity + type)
    const bestByEntity = new Map();
    for (const item of currentState) {
        const key = entityKey(item);
        if (!bestByEntity.has(key)) {
            bestByEntity.set(key, item);
        } else {
            const winner = bestByEntity.get(key);
            const severityDiff = RISK_ORDER[item.severity] - RISK_ORDER[winner.severity];
            if (severityDiff < 0) {
                // item has higher severity (lower RISK_ORDER value)
                bestByEntity.set(key, item);
            } else if (severityDiff === 0) {
                // same severity — prefer by type priority
                const typeDiff = (NSV_TYPE_PRIORITY[item.type] ?? 99) - (NSV_TYPE_PRIORITY[winner.type] ?? 99);
                if (typeDiff < 0) bestByEntity.set(key, item);
            }
        }
    }

    return [...bestByEntity.values(), ...escalations];
}

// ── 3. Changes Since Yesterday ────────────────────────────────────────────────
function buildChangesSince(trends, yesterdaySnap, summary, lang = 'it') {
    if (!trends || !yesterdaySnap) return [];
    lang = opsI18n.sanitizeLang(lang);
    const t = (key, vars) => opsI18n.t(lang, key, vars);

    const changes = [];

    function push(field, tr, textFn) {
        if (!tr || tr.direction === 'STABLE' || tr.direction === 'INSUFFICIENT_DATA') return;
        if (tr.previousValue === null || tr.previousValue === undefined) return;
        changes.push({ field, direction: tr.direction, text: textFn(tr) });
    }

    push('overdue', trends.overdue, tr => {
        return tr.direction === 'IMPROVING'
            ? t('ops.changes.overdueImproving', { prev: tr.previousValue, cur: tr.currentValue })
            : t('ops.changes.overdueWorsening', { prev: tr.previousValue, cur: tr.currentValue });
    });

    push('completionRate', trends.completionRate, tr => {
        const delta = Math.abs(tr.delta);
        return tr.direction === 'IMPROVING'
            ? t('ops.changes.completionRateImproving', { delta, prev: tr.previousValue, cur: tr.currentValue })
            : t('ops.changes.completionRateWorsening', { delta, prev: tr.previousValue, cur: tr.currentValue });
    });

    push('urgentTasks', trends.urgentTasks, tr => {
        return tr.direction === 'IMPROVING'
            ? t('ops.changes.urgentImproving', { prev: tr.previousValue, cur: tr.currentValue })
            : t('ops.changes.urgentWorsening', { prev: tr.previousValue, cur: tr.currentValue });
    });

    push('workload', trends.workload, tr => {
        return tr.direction === 'IMPROVING'
            ? t('ops.changes.workloadImproving', { prev: tr.previousValue, cur: tr.currentValue })
            : t('ops.changes.workloadWorsening', { prev: tr.previousValue, cur: tr.currentValue });
    });

    return changes;
}

// ── 4. Executive Brief ────────────────────────────────────────────────────────
function buildExecutiveBrief(role, summary, priorityQueue, riskWatch, changesSince, decisions, trends, myMetrics, nextTask, lang = 'it') {
    lang = opsI18n.sanitizeLang(lang);
    const t = (key, vars) => opsI18n.t(lang, key, vars);

    const h = new Date().getHours();
    const greeting = h < 12 ? t('ops.greeting.morning') : h < 18 ? t('ops.greeting.afternoon') : t('ops.greeting.evening');

    const lines = [];

    switch (role) {
        case 'DIRECTOR': {
            const totalOps   = (summary.completedToday || 0) + (summary.overdueToday || 0) + (summary.urgentOpen || 0);
            const decCount   = (decisions || []).length;
            const critRisks  = riskWatch.filter(r => r.level === 'CRITICAL').length;
            const ovdN       = summary.overdueToday || 0;
            const urgN       = summary.urgentOpen || 0;

            lines.push(`${greeting}.`);
            lines.push('');
            lines.push(t('ops.exec.dir.today', { n: totalOps }));
            lines.push('');

            if (ovdN > 0)
                lines.push(ovdN === 1 ? t('ops.exec.dir.overdue1', { n: ovdN }) : t('ops.exec.dir.overdueN', { n: ovdN }));
            else
                lines.push(t('ops.exec.dir.noOverdue'));

            if (urgN > 0)
                lines.push(urgN === 1 ? t('ops.exec.dir.urgent1', { n: urgN }) : t('ops.exec.dir.urgentN', { n: urgN }));

            if (decCount > 0)
                lines.push(decCount === 1 ? t('ops.exec.dir.decisions1', { n: decCount }) : t('ops.exec.dir.decisionsN', { n: decCount }));

            if (critRisks > 0)
                lines.push(critRisks === 1 ? t('ops.exec.dir.critRisk1') : t('ops.exec.dir.critRiskN', { n: critRisks }));

            if (changesSince && changesSince.length) {
                lines.push('');
                lines.push(t('ops.exec.dir.vsYesterday'));
                changesSince.forEach(c => {
                    const icon = c.direction === 'IMPROVING' ? '↓' : '↑';
                    lines.push(`• ${icon} ${c.text}`);
                });
            }

            if (priorityQueue && priorityQueue.length) {
                lines.push('');
                lines.push(t('ops.exec.dir.priorities'));
                priorityQueue.slice(0, 3).forEach((p, i) => {
                    const shortAction = p.recommendedAction.length > 70
                        ? p.recommendedAction.slice(0, 67) + '…'
                        : p.recommendedAction;
                    lines.push(`${i + 1}. ${shortAction}`);
                });
            }
            break;
        }

        case 'CHEF_CUISINE': {
            const decCount = (decisions || []).length;
            const totalCC  = (summary.completedToday || 0) + (summary.overdueToday || 0);
            const urgN     = summary.urgentOpen || 0;
            const ovdN     = summary.overdueToday || 0;

            lines.push(t('ops.exec.cc.total', { n: totalCC }));
            if (urgN > 0)
                lines.push(urgN === 1 ? t('ops.exec.cc.urgent1', { n: urgN }) : t('ops.exec.cc.urgentN', { n: urgN }));
            if (ovdN > 0)
                lines.push(ovdN === 1 ? t('ops.exec.cc.overdue1') : t('ops.exec.cc.overdueN', { n: ovdN }));
            else
                lines.push(t('ops.exec.cc.noOverdue'));
            if (decCount > 0)
                lines.push(decCount === 1 ? t('ops.exec.cc.decisions1', { n: decCount }) : t('ops.exec.cc.decisionsN', { n: decCount }));
            if (priorityQueue && priorityQueue.length) {
                lines.push('');
                lines.push(t('ops.exec.cc.priorities'));
                priorityQueue.slice(0, 3).forEach((p, i) =>
                    lines.push(`${i + 1}. ${p.recommendedAction.slice(0, 60)}`)
                );
            }
            break;
        }

        case 'ADJOINT': {
            const decCount = (decisions || []).length;
            const ovdN     = summary.overdueToday || 0;
            const urgN     = summary.urgentOpen || 0;

            lines.push(`${greeting}.`);
            if (ovdN > 0)
                lines.push(ovdN === 1 ? t('ops.exec.adj.overdue1', { n: ovdN }) : t('ops.exec.adj.overdueN', { n: ovdN }));
            else
                lines.push(t('ops.exec.adj.noOverdue'));
            if (urgN > 0)
                lines.push(t('ops.exec.adj.urgent', { n: urgN }));
            if (decCount > 0)
                lines.push(decCount === 1 ? t('ops.exec.adj.decisions1', { n: decCount }) : t('ops.exec.adj.decisionsN', { n: decCount }));
            if (priorityQueue && priorityQueue.length) {
                lines.push('');
                lines.push(t('ops.exec.adj.priorities'));
                priorityQueue.slice(0, 3).forEach((p, i) =>
                    lines.push(`${i + 1}. ${p.recommendedAction.slice(0, 60)}`)
                );
            }
            break;
        }

        case 'SOUS_CHEF': {
            const m    = myMetrics || {};
            const urgN = m.urgent  || 0;
            const ovdN = m.overdue || 0;

            lines.push(t('ops.exec.sc.tasks', { n: m.assigned || 0 }));
            if (urgN > 0)
                lines.push(urgN === 1 ? t('ops.exec.sc.urgent1') : t('ops.exec.sc.urgentN', { n: urgN }));
            if (ovdN > 0)
                lines.push(t('ops.exec.sc.overdue', { n: ovdN }));
            if (nextTask && nextTask.dueDate) {
                try {
                    const locale = lang === 'fr' ? 'fr-FR' : lang === 'en' ? 'en-GB' : 'it-IT';
                    const time = new Date(nextTask.dueDate).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                    lines.push(t('ops.exec.sc.nextDue', { time }));
                } catch { lines.push(t('ops.exec.sc.nextTask')); }
            } else if (nextTask) {
                lines.push(t('ops.exec.sc.nextTask'));
            }
            break;
        }

        case 'CHEF_DE_BRIGADE': {
            const m    = myMetrics || {};
            const ovdN = m.overdue       || 0;
            const doneN = m.completedToday || 0;

            if (ovdN > 0)
                lines.push(ovdN === 1 ? t('ops.exec.cdb.overdue1') : t('ops.exec.cdb.overdueN', { n: ovdN }));
            else
                lines.push(t('ops.exec.cdb.noOverdue'));
            if (nextTask)
                lines.push(t('ops.exec.cdb.nextTask', { title: nextTask.title }));
            else
                lines.push(t('ops.exec.cdb.noNextTask'));
            if (doneN > 0)
                lines.push(t('ops.exec.cdb.completed', { n: doneN }));
            break;
        }

        default:
            lines.push(`${greeting}. ${t('ops.exec.default')}`);
    }

    return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    generatePriorityQueue,
    detectRisks,
    deduplicateRisks,
    buildChangesSince,
    buildExecutiveBrief,
    buildNewSinceLastVisit,
    // Exposed for tests
    _RISK_ORDER: RISK_ORDER,
};
