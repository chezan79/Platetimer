'use strict';
/**
 * PlateTimer Operations — Intelligence Engine (Sprint 6.0 + 6.1)
 *
 * Pure rule-based analysis of operations data.
 * No AI, no ML, no external APIs, no database writes, no background jobs.
 * Called on-demand from GET /api/operations/intelligence (Director only).
 *
 * analyzeIntelligence(companyId, { tasks, users }, lang) → { attention, workload, suggestions, summary }
 *
 * `tasks`  — raw task records from getOpsTasks(); effectiveStatus computed internally.
 * `users`  — raw user records from getOpsUsers().
 * `lang`   — 'it' | 'fr' | 'en' (default 'it'). Controls all generated text.
 */

const opsI18n = require('./ops-i18n');

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
 * @param {string} [lang='it']
 * @returns {{ attention: object[], workload: object[], suggestions: object[], summary: object }}
 */
function analyzeIntelligence(companyId, { tasks: rawTasks, users: rawUsers }, lang = 'it') {
    lang = opsI18n.sanitizeLang(lang);
    const t = (key, vars) => opsI18n.t(lang, key, vars);

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
        const mine       = tasks.filter(t2 => t2.assigneeId === u.id);
        const openMine   = mine.filter(t2 => t2.status !== 'COMPLETED' && t2.status !== 'CANCELLED');
        const assigned   = openMine.length;
        const overdue    = openMine.filter(t2 => t2.effectiveStatus === 'OVERDUE').length;
        const urgent     = openMine.filter(t2 => t2.priority === 'URGENT').length;
        const completedToday = mine.filter(t2 => t2.status === 'COMPLETED' && isToday(t2.completedAt)).length;

        const finished = mine.filter(t2 => t2.status === 'COMPLETED' && t2.createdAt && t2.completedAt);
        const avgCompletionTime = finished.length
            ? Math.round(
                finished.reduce((s, t2) =>
                    s + (new Date(t2.completedAt).getTime() - new Date(t2.createdAt).getTime()), 0
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
        .filter(t2 => t2.effectiveStatus === 'OVERDUE')
        .forEach(t2 => {
            const overdueMin = (now - new Date(t2.dueDate).getTime()) / 60000;
            if (overdueMin >= OVERDUE_HIGH_MIN) {
                attention.push({
                    id: nextAlertId(),
                    severity: 'HIGH',
                    title: t('ops.intel.late.title'),
                    description: t('ops.intel.late.desc', { title: t2.title, min: Math.round(overdueMin) }),
                    recommendedAction: t('ops.intel.late.action'),
                    linkedTask: t2.id,
                    linkedUser: t2.assigneeId || null,
                    department: t2.department || null,
                    timestamp: ts,
                });
            }
        });

    // HIGH — URGENT task not yet started (status OPEN)
    tasks
        .filter(t2 => t2.priority === 'URGENT' && t2.status === 'OPEN')
        .forEach(t2 => {
            attention.push({
                id: nextAlertId(),
                severity: 'HIGH',
                title: t('ops.intel.urgent.title'),
                description: t('ops.intel.urgent.desc', { title: t2.title }),
                recommendedAction: t('ops.intel.urgent.action'),
                linkedTask: t2.id,
                linkedUser: t2.assigneeId || null,
                department: t2.department || null,
                timestamp: ts,
            });
        });

    // HIGH — suspended user still has active tasks
    suspendedUsers.forEach(u => {
        const activeTasks = tasks.filter(
            t2 => t2.assigneeId === u.id && t2.status !== 'COMPLETED' && t2.status !== 'CANCELLED'
        );
        if (activeTasks.length) {
            attention.push({
                id: nextAlertId(),
                severity: 'HIGH',
                title: t('ops.intel.suspended.title'),
                description: activeTasks.length === 1
                    ? t('ops.intel.suspended.desc1', { name: u.name, n: activeTasks.length })
                    : t('ops.intel.suspended.descN', { name: u.name, n: activeTasks.length }),
                recommendedAction: t('ops.intel.suspended.action'),
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
                title: t('ops.intel.overloaded.title'),
                description: t('ops.intel.overloaded.desc', {
                    name: w.userName, assigned: w.assigned, overdue: w.overdue,
                    urgent: w.urgent, score: w.currentLoadScore,
                }),
                recommendedAction: t('ops.intel.overloaded.action'),
                linkedTask: null,
                linkedUser: w.userId,
                department: null,
                timestamp: ts,
            });
        });

    // MEDIUM — many urgent tasks concentrated in one department
    const deptUrgent = {};
    tasks
        .filter(t2 =>
            t2.priority === 'URGENT' &&
            t2.status !== 'COMPLETED' &&
            t2.status !== 'CANCELLED' &&
            t2.department
        )
        .forEach(t2 => { deptUrgent[t2.department] = (deptUrgent[t2.department] || 0) + 1; });

    Object.entries(deptUrgent)
        .filter(([, cnt]) => cnt >= URGENT_DEPT_THRESHOLD)
        .forEach(([dept, cnt]) => {
            attention.push({
                id: nextAlertId(),
                severity: 'MEDIUM',
                title: t('ops.intel.deptUrgent.title', { dept }),
                description: t('ops.intel.deptUrgent.desc', { dept, n: cnt }),
                recommendedAction: t('ops.intel.deptUrgent.action', { dept }),
                linkedTask: null,
                linkedUser: null,
                department: dept,
                timestamp: ts,
            });
        });

    // LOW — IN_PROGRESS task inactive for more than INACTIVE_HRS hours
    const inactiveCutoff = now - INACTIVE_HRS * 3_600_000;
    tasks
        .filter(t2 =>
            t2.status === 'IN_PROGRESS' &&
            t2.updatedAt &&
            new Date(t2.updatedAt).getTime() < inactiveCutoff
        )
        .forEach(t2 => {
            const hrsInactive = Math.round((now - new Date(t2.updatedAt).getTime()) / 3_600_000);
            attention.push({
                id: nextAlertId(),
                severity: 'LOW',
                title: t('ops.intel.inactive.title'),
                description: t('ops.intel.inactive.desc', { title: t2.title, hours: hrsInactive }),
                recommendedAction: t('ops.intel.inactive.action'),
                linkedTask: t2.id,
                linkedUser: t2.assigneeId || null,
                department: t2.department || null,
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
                t2 => t2.assigneeId === w.userId &&
                     t2.status === 'OPEN' &&
                     t2.priority !== 'URGENT'
            );
            if (movable.length) {
                suggestions.push({
                    id: nextSugId(),
                    type: 'REASSIGN_BALANCE',
                    title: t('ops.intel.sug.balance.title', { from: w.userName, to: candidate.userName }),
                    description: t('ops.intel.sug.balance.desc', { task: movable[0].title }),
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
            t2 => t2.assigneeId === u.id && t2.status !== 'COMPLETED' && t2.status !== 'CANCELLED'
        );
        activeTasks.forEach(t2 => {
            suggestions.push({
                id: nextSugId(),
                type: 'REASSIGN_SUSPENDED',
                title: t('ops.intel.sug.reassign.title', { name: u.name }),
                description: t('ops.intel.sug.reassign.desc', { task: t2.title, name: u.name }),
                linkedTask: t2.id,
                linkedUser: u.id,
                targetUser: null,
                department: t2.department || null,
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
                title: t('ops.intel.sug.reviewDept.title', { dept }),
                description: t('ops.intel.sug.reviewDept.desc', { dept }),
                linkedTask: null,
                linkedUser: null,
                targetUser: null,
                department: dept,
            });
        });

    // Suggest completing recurring tasks that are overdue
    tasks
        .filter(t2 => t2.effectiveStatus === 'OVERDUE' && t2.templateId)
        .forEach(t2 => {
            suggestions.push({
                id: nextSugId(),
                type: 'COMPLETE_RECURRING',
                title: t('ops.intel.sug.recurring.title'),
                description: t('ops.intel.sug.recurring.desc', { task: t2.title }),
                linkedTask: t2.id,
                linkedUser: t2.assigneeId || null,
                targetUser: null,
                department: t2.department || null,
            });
        });

    // ── SUMMARY ───────────────────────────────────────────────────────────────
    const completedToday = tasks.filter(t2 => t2.status === 'COMPLETED' && isToday(t2.completedAt));
    const overdueToday   = tasks.filter(t2 => t2.effectiveStatus === 'OVERDUE');
    const urgentOpen     = tasks.filter(
        t2 => t2.priority === 'URGENT' && t2.status !== 'COMPLETED' && t2.status !== 'CANCELLED'
    );
    const openTasks = tasks.filter(t2 => t2.status !== 'COMPLETED' && t2.status !== 'CANCELLED');

    // Most active department: most completions today
    const deptCompletions = {};
    completedToday.filter(t2 => t2.department).forEach(t2 => {
        deptCompletions[t2.department] = (deptCompletions[t2.department] || 0) + 1;
    });
    const mostActiveDepartment =
        Object.entries(deptCompletions).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // Most overloaded department: most overdue + urgent tasks
    const deptLoad = {};
    tasks
        .filter(t2 =>
            t2.department &&
            (t2.effectiveStatus === 'OVERDUE' ||
             (t2.priority === 'URGENT' && t2.status !== 'COMPLETED' && t2.status !== 'CANCELLED'))
        )
        .forEach(t2 => { deptLoad[t2.department] = (deptLoad[t2.department] || 0) + 1; });
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
                    t2 => t2.assigneeId === u.id && t2.status !== 'COMPLETED' && t2.status !== 'CANCELLED'
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

    // ── DECISIONS (Sprint 6.1) ────────────────────────────────────────────────
    const decisions = generateDecisions(companyId, { tasks, users, workload, now, generatedAt: ts }, lang);

    return { attention, workload, suggestions, summary, decisions };
}

// ── Decision Support Engine (Sprint 6.1) ──────────────────────────────────────

const MIN_CONFIDENCE = 50;
const OVERDUE_DEPT_THRESHOLD = 2;

function generateDecisions(companyId, { tasks, users, workload, now, generatedAt }, lang = 'it') {
    lang = opsI18n.sanitizeLang(lang);
    const t = (key, vars) => opsI18n.t(lang, key, vars);

    const decisions = [];
    let decId = 0;
    const nid = () => `dec_${++decId}`;

    // Helper: minutes since/until a ms timestamp
    const minsSince = ms  => Math.round((now - ms) / 60000);
    const minsUntil = ms  => Math.round((ms - now) / 60000);
    const fmtSince  = ms  => ms ? t('ops.dec.since', { min: minsSince(ms) }) : t('ops.dec.never');
    const fmtAvg    = ms  => ms ? t('ops.dec.avg',   { min: Math.round(ms / 60000) }) : t('ops.dec.avgNone');

    function push(card) {
        if (card.confidence >= MIN_CONFIDENCE) decisions.push(card);
    }

    // ── 1. OVERLOADED_USER ────────────────────────────────────────────────────
    workload.filter(w => w.status === 'OVERLOADED').forEach(w => {
        const userTasks  = tasks.filter(t2 => t2.assigneeId === w.userId);
        const lastComp   = userTasks
            .filter(t2 => t2.status === 'COMPLETED' && t2.completedAt)
            .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0];
        const lastCompMs = lastComp ? new Date(lastComp.completedAt).getTime() : null;
        const hasRecentComp = lastCompMs && (now - lastCompMs) < 30 * 60_000;

        let confidence = 70;
        if (w.overdue >= 1 && w.urgent >= 1 && !hasRecentComp) confidence = 90;
        else if (w.overdue >= 1 || w.urgent >= 1)              confidence = 80;

        const reasonParts = [
            t('ops.dec.overloaded.reason.tasks', { name: w.userName, n: w.assigned }),
            w.urgent  > 0 ? (w.urgent  === 1 ? t('ops.dec.overloaded.reason.urgent1',  { n: w.urgent  })
                                              : t('ops.dec.overloaded.reason.urgentN',  { n: w.urgent  })) : null,
            w.overdue > 0 ? (w.overdue === 1 ? t('ops.dec.overloaded.reason.overdue1', { n: w.overdue })
                                              : t('ops.dec.overloaded.reason.overdueN', { n: w.overdue })) : null,
            lastCompMs
                ? t('ops.dec.overloaded.reason.noCompMin', { min: minsSince(lastCompMs) })
                : t('ops.dec.overloaded.reason.noCompToday'),
            t('ops.dec.overloaded.reason.score', { score: w.currentLoadScore }),
        ].filter(Boolean).join(' ');

        push({
            id: nid(), type: 'OVERLOADED_USER', severity: 'HIGH',
            title:             t('ops.dec.overloaded.title', { name: w.userName }),
            reason:            reasonParts,
            recommendedAction: t('ops.dec.overloaded.action'),
            confidence,
            supportingFacts: [
                t('ops.dec.overloaded.fact.active',  { n: w.assigned }),
                t('ops.dec.overloaded.fact.urgent',  { n: w.urgent }),
                t('ops.dec.overloaded.fact.overdue', { n: w.overdue }),
                t('ops.dec.overloaded.fact.avg',     { val: fmtAvg(w.averageCompletionTime) }),
                t('ops.dec.overloaded.fact.last',    { val: fmtSince(lastCompMs) }),
                t('ops.dec.overloaded.fact.score',   { val: w.currentLoadScore }),
            ],
            linkedTask: null, linkedUser: w.userId, department: null,
            quickAction: { label: t('ops.dec.qa.team'), url: '/operations-team.html' },
            generatedAt,
        });
    });

    // ── 2. SUSPENDED_USER_WITH_TASKS ──────────────────────────────────────────
    users.filter(u => u.status === 'SUSPENDED').forEach(u => {
        const activeTasks = tasks.filter(
            t2 => t2.assigneeId === u.id && t2.status !== 'COMPLETED' && t2.status !== 'CANCELLED'
        );
        if (!activeTasks.length) return;
        const urgentCnt = activeTasks.filter(t2 => t2.priority === 'URGENT').length;

        const baseReason = activeTasks.length === 1
            ? t('ops.dec.suspended.reason1', { name: u.name, n: activeTasks.length })
            : t('ops.dec.suspended.reasonN', { name: u.name, n: activeTasks.length });
        const urgentSuffix = urgentCnt > 0 ? t('ops.dec.suspended.reasonUrgent', { n: urgentCnt }) : '';

        push({
            id: nid(), type: 'SUSPENDED_USER_WITH_TASKS', severity: 'HIGH',
            title:             t('ops.dec.suspended.title', { name: u.name }),
            reason:            baseReason.replace(/\.$/, '') + urgentSuffix + '.',
            recommendedAction: t('ops.dec.suspended.action'),
            confidence:        95,
            supportingFacts: [
                t('ops.dec.suspended.fact.assigned', { n: activeTasks.length }),
                t('ops.dec.suspended.fact.urgent',   { n: urgentCnt }),
                t('ops.dec.suspended.fact.status'),
            ],
            linkedTask: null, linkedUser: u.id, department: null,
            quickAction: { label: t('ops.dec.qa.team'), url: '/operations-team.html' },
            generatedAt,
        });
    });

    // ── 3. OPENING_NOT_STARTED (URGENT + OPEN) ────────────────────────────────
    tasks.filter(t2 => t2.priority === 'URGENT' && t2.status === 'OPEN').forEach(t2 => {
        const isOverdue  = t2.effectiveStatus === 'OVERDUE';
        const dueMs      = t2.dueDate ? new Date(t2.dueDate).getTime() : null;
        const minsLeft   = dueMs ? minsUntil(dueMs) : null;
        const overdueMin = isOverdue && dueMs ? minsSince(dueMs) : 0;

        let confidence = 60;
        if (isOverdue)                              confidence = 90;
        else if (minsLeft !== null && minsLeft < 120) confidence = 75;

        const timeDesc = isOverdue
            ? t('ops.dec.notStarted.timeOverdue', { min: overdueMin })
            : minsLeft !== null
                ? t('ops.dec.notStarted.timeDue', { min: minsLeft })
                : t('ops.dec.notStarted.timeNone');

        // Format deadline for supportingFacts
        let deadlineVal;
        if (t2.dueDate) {
            try {
                const locale = lang === 'fr' ? 'fr-FR' : lang === 'en' ? 'en-GB' : 'it-IT';
                deadlineVal = new Date(t2.dueDate).toLocaleString(locale);
            } catch { deadlineVal = t2.dueDate; }
        } else {
            deadlineVal = t('ops.dec.notStarted.fact.nd');
        }

        push({
            id: nid(), type: 'OPENING_NOT_STARTED', severity: 'HIGH',
            title:             t('ops.dec.notStarted.title',  { title: t2.title }),
            reason:            t('ops.dec.notStarted.reason', { title: t2.title, timeDesc }),
            recommendedAction: t('ops.dec.notStarted.action'),
            confidence,
            supportingFacts: [
                t('ops.dec.notStarted.fact.status'),
                t('ops.dec.notStarted.fact.priority'),
                t('ops.dec.notStarted.fact.assignee', { val: t2.assigneeName || t('ops.dec.notStarted.fact.nd') }),
                t('ops.dec.notStarted.fact.deadline', { val: deadlineVal }),
            ],
            linkedTask: t2.id, linkedUser: t2.assigneeId || null, department: t2.department || null,
            quickAction: { label: t('ops.dec.qa.task'), url: `/operations-tasks.html#${t2.id}` },
            generatedAt,
        });
    });

    // ── 4. URGENT_DEPARTMENT ──────────────────────────────────────────────────
    const deptUrgentLists = {};
    tasks.filter(t2 =>
        t2.priority === 'URGENT' && t2.status !== 'COMPLETED' && t2.status !== 'CANCELLED' && t2.department
    ).forEach(t2 => {
        if (!deptUrgentLists[t2.department]) deptUrgentLists[t2.department] = [];
        deptUrgentLists[t2.department].push(t2);
    });

    Object.entries(deptUrgentLists)
        .filter(([, list]) => list.length >= URGENT_DEPT_THRESHOLD)
        .forEach(([dept, list]) => {
            const overdueInDept = list.filter(t2 => t2.effectiveStatus === 'OVERDUE').length;
            const reason = overdueInDept > 0
                ? t('ops.dec.urgentDept.reasonWithOverdue', { dept, n: list.length, overdue: overdueInDept })
                : t('ops.dec.urgentDept.reason',            { dept, n: list.length });
            push({
                id: nid(), type: 'URGENT_DEPARTMENT', severity: 'MEDIUM',
                title:             t('ops.dec.urgentDept.title',  { dept }),
                reason,
                recommendedAction: t('ops.dec.urgentDept.action', { dept }),
                confidence:        80,
                supportingFacts: [
                    t('ops.dec.urgentDept.fact.urgent',  { n: list.length }),
                    t('ops.dec.urgentDept.fact.overdue', { n: overdueInDept }),
                ],
                linkedTask: null, linkedUser: null, department: dept,
                quickAction: { label: t('ops.dec.qa.ops'), url: '/operations-tasks.html' },
                generatedAt,
            });
        });

    // ── 5. CHECK_DEPARTMENT (≥ OVERDUE_DEPT_THRESHOLD overdue in one dept) ────
    const deptOverdueLists = {};
    tasks.filter(t2 => t2.effectiveStatus === 'OVERDUE' && t2.department)
        .forEach(t2 => {
            if (!deptOverdueLists[t2.department]) deptOverdueLists[t2.department] = [];
            deptOverdueLists[t2.department].push(t2);
        });

    Object.entries(deptOverdueLists)
        .filter(([, list]) => list.length >= OVERDUE_DEPT_THRESHOLD)
        .forEach(([dept, list]) => {
            const urgentInDept = list.filter(t2 => t2.priority === 'URGENT').length;
            const maxMin = Math.max(...list.map(t2 =>
                Math.round((now - new Date(t2.dueDate).getTime()) / 60_000)
            ));
            push({
                id: nid(), type: 'CHECK_DEPARTMENT', severity: 'MEDIUM',
                title:             t('ops.dec.checkDept.title',  { dept }),
                reason:            t('ops.dec.checkDept.reason', { dept, n: list.length, maxMin }),
                recommendedAction: t('ops.dec.checkDept.action', { dept }),
                confidence:        80,
                supportingFacts: [
                    t('ops.dec.checkDept.fact.overdue',      { n: list.length }),
                    t('ops.dec.checkDept.fact.urgentOverdue',{ n: urgentInDept }),
                    t('ops.dec.checkDept.fact.maxDelay',     { min: maxMin }),
                ],
                linkedTask: null, linkedUser: null, department: dept,
                quickAction: { label: t('ops.dec.qa.ops'), url: '/operations-tasks.html' },
                generatedAt,
            });
        });

    // ── 6. REASSIGN_TASK ──────────────────────────────────────────────────────
    const normalWl = workload
        .filter(w => w.status === 'NORMAL')
        .sort((a, b) => a.currentLoadScore - b.currentLoadScore);

    workload.filter(w => w.status === 'OVERLOADED').forEach(w => {
        const candidate = normalWl[0];
        if (!candidate) return;
        const movable = tasks.filter(
            t2 => t2.assigneeId === w.userId && t2.status === 'OPEN' && t2.priority !== 'URGENT'
        );
        if (!movable.length) return;
        const t2 = movable[0];

        push({
            id: nid(), type: 'REASSIGN_TASK', severity: 'MEDIUM',
            title:             t('ops.dec.reassign.title',  { task: t2.title, from: w.userName, to: candidate.userName }),
            reason:            t('ops.dec.reassign.reason', {
                from: w.userName, fromScore: w.currentLoadScore,
                to: candidate.userName, toScore: candidate.currentLoadScore,
                toStatus: candidate.status,
            }),
            recommendedAction: t('ops.dec.reassign.action', { task: t2.title, to: candidate.userName }),
            confidence:        75,
            supportingFacts: [
                t('ops.dec.reassign.fact.from',     { name: w.userName,         score: w.currentLoadScore }),
                t('ops.dec.reassign.fact.to',       { name: candidate.userName, score: candidate.currentLoadScore }),
                t('ops.dec.reassign.fact.task',     { title: t2.title }),
                t('ops.dec.reassign.fact.priority', { val: t2.priority }),
            ],
            linkedTask: t2.id, linkedUser: w.userId, department: t2.department || null,
            quickAction: { label: t('ops.dec.qa.task'), url: `/operations-tasks.html#${t2.id}` },
            generatedAt,
        });
    });

    // ── 7. REVIEW_RECURRING ───────────────────────────────────────────────────
    tasks.filter(t2 => t2.effectiveStatus === 'OVERDUE' && t2.templateId).forEach(t2 => {
        const overdueMin = Math.round((now - new Date(t2.dueDate).getTime()) / 60_000);
        push({
            id: nid(), type: 'REVIEW_RECURRING', severity: 'MEDIUM',
            title:             t('ops.dec.recurring.title',  { title: t2.title }),
            reason:            t('ops.dec.recurring.reason', { title: t2.title, min: overdueMin }),
            recommendedAction: t('ops.dec.recurring.action'),
            confidence:        85,
            supportingFacts: [
                t('ops.dec.recurring.fact.type'),
                t('ops.dec.recurring.fact.overdue',   { min: overdueMin }),
                t('ops.dec.recurring.fact.assignee',  { val: t2.assigneeName || t('ops.dec.notStarted.fact.nd') }),
            ],
            linkedTask: t2.id, linkedUser: t2.assigneeId || null, department: t2.department || null,
            quickAction: { label: t('ops.dec.qa.task'), url: `/operations-tasks.html#${t2.id}` },
            generatedAt,
        });
    });

    // ── 8. UNDERUSED_USER ─────────────────────────────────────────────────────
    const teamOverdueCount = tasks.filter(t2 => t2.effectiveStatus === 'OVERDUE').length;
    if (teamOverdueCount > 0) {
        workload.filter(w => w.assigned === 0 && w.completedToday === 0).forEach(w => {
            const reason = teamOverdueCount === 1
                ? t('ops.dec.underused.reason1', { name: w.userName, n: teamOverdueCount })
                : t('ops.dec.underused.reasonN', { name: w.userName, n: teamOverdueCount });
            push({
                id: nid(), type: 'UNDERUSED_USER', severity: 'LOW',
                title:             t('ops.dec.underused.title',  { name: w.userName }),
                reason,
                recommendedAction: t('ops.dec.underused.action'),
                confidence:        70,
                supportingFacts: [
                    t('ops.dec.underused.fact.assigned'),
                    t('ops.dec.underused.fact.completed'),
                    t('ops.dec.underused.fact.teamOverdue', { n: teamOverdueCount }),
                ],
                linkedTask: null, linkedUser: w.userId, department: null,
                quickAction: { label: t('ops.dec.qa.task'), url: '/operations-tasks.html' },
                generatedAt,
            });
        });
    }

    // ── Sort: severity → confidence desc → generatedAt asc ───────────────────
    decisions.sort((a, b) => {
        const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (s !== 0) return s;
        const c = b.confidence - a.confidence;
        if (c !== 0) return c;
        return a.generatedAt.localeCompare(b.generatedAt);
    });

    return decisions;
}

// ── Briefing Generator (Sprint 6.2) ──────────────────────────────────────────

function generateBriefing(role, data, lang = 'it') {
    lang = opsI18n.sanitizeLang(lang);
    const t = (key, vars) => opsI18n.t(lang, key, vars);

    const h = new Date().getHours();
    const greeting = h < 12 ? t('ops.greeting.morning') : h < 18 ? t('ops.greeting.afternoon') : t('ops.greeting.evening');

    switch (role) {
        case 'DIRECTOR': {
            const { summary, decisionsCount, trends } = data;
            const totalOps = (summary.completedToday || 0) + (summary.overdueToday || 0) + (summary.urgentOpen || 0);
            const trendNote = (() => {
                if (!trends || !trends.overdue) return null;
                if (trends.overdue.direction === 'IMPROVING')  return t('ops.brief.dir.trendImproving');
                if (trends.overdue.direction === 'WORSENING')  return t('ops.brief.dir.trendWorsening');
                if (trends.overdue.direction === 'STABLE')     return t('ops.brief.dir.trendStable');
                return null;
            })();
            const overdueN = summary.overdueToday || 0;
            const decN     = decisionsCount || 0;
            return [
                `${greeting}.`,
                t('ops.brief.dir.totalOps', { n: totalOps }),
                overdueN > 0
                    ? (overdueN === 1 ? t('ops.brief.dir.overdue1', { n: overdueN }) : t('ops.brief.dir.overdueN', { n: overdueN }))
                    : t('ops.brief.dir.noOverdue'),
                decN > 0
                    ? (decN === 1 ? t('ops.brief.dir.decisions1', { n: decN }) : t('ops.brief.dir.decisionsN', { n: decN }))
                    : null,
                trendNote,
            ].filter(Boolean).join(' ');
        }
        case 'CHEF_CUISINE': {
            const { summary, decisionsCount } = data;
            const totalKitchen = (summary.completedToday || 0) + (summary.overdueToday || 0);
            const urgN = summary.urgentOpen || 0;
            const ovdN = summary.overdueToday || 0;
            const decN = decisionsCount || 0;
            return [
                t('ops.brief.cc.total', { n: totalKitchen }),
                urgN > 0 ? (urgN === 1 ? t('ops.brief.cc.urgent1', { n: urgN }) : t('ops.brief.cc.urgentN', { n: urgN })) : null,
                ovdN > 0 ? (ovdN === 1 ? t('ops.brief.cc.overdue1') : t('ops.brief.cc.overdueN', { n: ovdN })) : t('ops.brief.cc.noOverdue'),
                decN > 0 ? (decN === 1 ? t('ops.brief.cc.decisions1', { n: decN }) : t('ops.brief.cc.decisionsN', { n: decN })) : null,
            ].filter(Boolean).join(' ');
        }
        case 'ADJOINT': {
            const { summary, decisionsCount } = data;
            const ovdN = summary.overdueToday || 0;
            const urgN = summary.urgentOpen || 0;
            const decN = decisionsCount || 0;
            return [
                `${greeting}.`,
                ovdN > 0
                    ? (ovdN === 1 ? t('ops.brief.adj.overdue1', { n: ovdN }) : t('ops.brief.adj.overdueN', { n: ovdN }))
                    : t('ops.brief.adj.noOverdue'),
                urgN > 0 ? t('ops.brief.adj.urgent', { n: urgN }) : null,
                decN > 0 ? (decN === 1 ? t('ops.brief.adj.decisions1', { n: decN }) : t('ops.brief.adj.decisionsN', { n: decN })) : null,
            ].filter(Boolean).join(' ');
        }
        case 'SOUS_CHEF': {
            const { myMetrics, nextTask } = data;
            const urgN = myMetrics ? (myMetrics.urgent || 0) : 0;
            let nextDueLine = null;
            if (nextTask && nextTask.dueDate) {
                try {
                    const locale = lang === 'fr' ? 'fr-FR' : lang === 'en' ? 'en-GB' : 'it-IT';
                    const time = new Date(nextTask.dueDate).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                    nextDueLine = t('ops.brief.sc.nextDue', { time });
                } catch { nextDueLine = t('ops.brief.sc.nextTask'); }
            } else if (nextTask) {
                nextDueLine = t('ops.brief.sc.nextTask');
            }
            return [
                t('ops.brief.sc.tasks', { n: myMetrics ? (myMetrics.assigned || 0) : 0 }),
                urgN > 0 ? (urgN === 1 ? t('ops.brief.sc.urgent1') : t('ops.brief.sc.urgentN', { n: urgN })) : null,
                nextDueLine,
            ].filter(Boolean).join(' ');
        }
        case 'CHEF_DE_BRIGADE': {
            const { myMetrics, nextTask } = data;
            const ovdN = myMetrics ? (myMetrics.overdue || 0) : 0;
            const doneN = myMetrics ? (myMetrics.completedToday || 0) : 0;
            return [
                ovdN > 0
                    ? (ovdN === 1 ? t('ops.brief.cdb.overdue1') : t('ops.brief.cdb.overdueN', { n: ovdN }))
                    : t('ops.brief.cdb.noOverdue'),
                nextTask ? t('ops.brief.cdb.nextTask', { title: nextTask.title }) : t('ops.brief.cdb.noNextTask'),
                doneN > 0 ? t('ops.brief.cdb.completed', { n: doneN }) : null,
            ].filter(Boolean).join(' ');
        }
        default:
            return `${greeting}. ${t('ops.brief.default')}`;
    }
}

// ── Department Health (Sprint 6.2) ────────────────────────────────────────────
// Returns per-department metrics from scoped tasks, with a trend direction
// computed by comparing current overdue count against yesterday's snapshot.
// No i18n needed here — only numeric data and enum strings are returned.

function getDepartmentHealth(scopedTasks, yesterdaySnapshot) {
    const now   = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    const enriched = (scopedTasks || []).map(t2 => {
        let effectiveStatus = t2.status;
        if (!['COMPLETED','CANCELLED'].includes(t2.status) && t2.dueDate) {
            const due = new Date(t2.dueDate).getTime();
            if (!isNaN(due) && now > due) effectiveStatus = 'OVERDUE';
        }
        return { ...t2, effectiveStatus };
    });

    const depts = {};
    enriched.forEach(t2 => {
        if (!t2.department) return;
        if (!depts[t2.department]) {
            depts[t2.department] = { dept: t2.department, open: 0, overdue: 0, urgent: 0, completedToday: 0 };
        }
        const d = depts[t2.department];
        if (!['COMPLETED','CANCELLED'].includes(t2.status)) d.open++;
        if (t2.effectiveStatus === 'OVERDUE')               d.overdue++;
        if (t2.priority === 'URGENT' && !['COMPLETED','CANCELLED'].includes(t2.status)) d.urgent++;
        if (t2.status === 'COMPLETED') {
            try { if (new Date(t2.completedAt).toISOString().slice(0, 10) === today) d.completedToday++; }
            catch { /* skip */ }
        }
    });

    const yestDepts = (yesterdaySnapshot && yesterdaySnapshot.departmentMetrics) || {};

    return Object.values(depts)
        .map(d => {
            const yest = yestDepts[d.dept];
            let trend = 'INSUFFICIENT_DATA';
            if (yest !== undefined) {
                if (d.overdue < yest.overdue)       trend = 'IMPROVING';
                else if (d.overdue > yest.overdue)  trend = 'WORSENING';
                else                                trend = 'STABLE';
            }
            return { ...d, trend };
        })
        .sort((a, b) => b.overdue - a.overdue || b.urgent - a.urgent);
}

module.exports = {
    analyzeIntelligence,
    generateDecisions,
    generateBriefing,
    getDepartmentHealth,
    // Exported for unit tests
    _computeLoadScore:       computeLoadScore,
    _loadStatus:             loadStatus,
    _LOAD_BUSY:              LOAD_BUSY,
    _LOAD_OVERLOADED:        LOAD_OVERLOADED,
    _MIN_CONFIDENCE:         MIN_CONFIDENCE,
    _OVERDUE_DEPT_THRESHOLD: OVERDUE_DEPT_THRESHOLD,
    _isToday:                isToday,
};
