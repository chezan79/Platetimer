'use strict';
/**
 * PlateTimer Operations — Intelligence Engine (Sprint 6.0 + 6.1)
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

    // ── DECISIONS (Sprint 6.1) ────────────────────────────────────────────────
    const decisions = generateDecisions(companyId, { tasks, users, workload, now, generatedAt: ts });

    return { attention, workload, suggestions, summary, decisions };
}

// ── Decision Support Engine (Sprint 6.1) ──────────────────────────────────────
// Transforms intelligence data into Decision Cards with reason, supportingFacts,
// confidence scores, and quick actions. Fully deterministic — no AI, no random.
//
// Confidence tiers:
//   95   strongest evidence (suspended user with active tasks)
//   90   strong (overloaded + overdue + urgent + no recent completion; urgent task past due)
//   85   high   (overdue recurring task)
//   80   good   (dept concentration, dept overdue)
//   75   likely (reassign suggestion; urgent task due within 2 h)
//   70   possible (workload only; underused user)
//   60   weak   (single overdue < threshold; urgent task, due far out)
//  <50   suppressed — never shown
//
// Sort order: severity (HIGH→LOW), confidence (desc), generatedAt (asc).

const MIN_CONFIDENCE = 50;
const OVERDUE_DEPT_THRESHOLD = 2; // ≥N overdue in one dept → CHECK_DEPARTMENT

function generateDecisions(companyId, { tasks, users, workload, now, generatedAt }) {
    const decisions = [];
    let decId = 0;
    const nid = () => `dec_${++decId}`;

    // Helper: minutes since a ms timestamp
    const minsSince   = ms  => Math.round((now - ms) / 60000);
    const minsUntil   = ms  => Math.round((ms - now) / 60000);
    const fmtSince    = ms  => ms ? `${minsSince(ms)} min fa` : 'mai';
    const fmtAvg      = ms  => ms ? `${Math.round(ms / 60000)} min` : 'n/d';

    function push(card) {
        if (card.confidence >= MIN_CONFIDENCE) decisions.push(card);
    }

    // ── 1. OVERLOADED_USER ────────────────────────────────────────────────────
    workload.filter(w => w.status === 'OVERLOADED').forEach(w => {
        const userTasks  = tasks.filter(t => t.assigneeId === w.userId);
        const lastComp   = userTasks
            .filter(t => t.status === 'COMPLETED' && t.completedAt)
            .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0];
        const lastCompMs = lastComp ? new Date(lastComp.completedAt).getTime() : null;
        const hasRecentComp = lastCompMs && (now - lastCompMs) < 30 * 60_000;

        let confidence = 70; // workload only
        if (w.overdue >= 1 && w.urgent >= 1 && !hasRecentComp) confidence = 90;
        else if (w.overdue >= 1 || w.urgent >= 1)              confidence = 80;

        const reasonParts = [
            `${w.userName} ha ${w.assigned} compiti attivi.`,
            w.urgent  > 0 ? `${w.urgent} ${w.urgent  === 1 ? 'è urgente'    : 'sono urgenti'}.`    : null,
            w.overdue > 0 ? `${w.overdue} ${w.overdue === 1 ? 'è in ritardo' : 'sono in ritardo'}.` : null,
            lastCompMs
                ? `Nessun completamento negli ultimi ${minsSince(lastCompMs)} minuti.`
                : 'Nessun completamento oggi.',
            `Score di carico = ${w.currentLoadScore}.`,
        ].filter(Boolean).join(' ');

        push({
            id: nid(), type: 'OVERLOADED_USER', severity: 'HIGH',
            title:             `${w.userName} è sovraccarico`,
            reason:            reasonParts,
            recommendedAction: 'Ridistribuire alcuni compiti a membri con carico minore.',
            confidence,
            supportingFacts: [
                `Compiti attivi: ${w.assigned}`,
                `Urgenti: ${w.urgent}`,
                `In ritardo: ${w.overdue}`,
                `Completamento medio: ${fmtAvg(w.averageCompletionTime)}`,
                `Ultimo completamento: ${fmtSince(lastCompMs)}`,
                `Score: ${w.currentLoadScore}`,
            ],
            linkedTask: null, linkedUser: w.userId, department: null,
            quickAction: { label: 'Apri Team', url: '/operations-team.html' },
            generatedAt,
        });
    });

    // ── 2. SUSPENDED_USER_WITH_TASKS ──────────────────────────────────────────
    users.filter(u => u.status === 'SUSPENDED').forEach(u => {
        const activeTasks = tasks.filter(
            t => t.assigneeId === u.id && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
        );
        if (!activeTasks.length) return;
        const urgentCnt = activeTasks.filter(t => t.priority === 'URGENT').length;

        push({
            id: nid(), type: 'SUSPENDED_USER_WITH_TASKS', severity: 'HIGH',
            title:             `${u.name} è sospeso con compiti assegnati`,
            reason:            `${u.name} è stato sospeso ma ha ancora ${activeTasks.length} ` +
                               `${activeTasks.length === 1 ? 'compito attivo' : 'compiti attivi'}` +
                               (urgentCnt > 0 ? `, di cui ${urgentCnt} urgenti` : '') + '.',
            recommendedAction: 'Riassegnare immediatamente i compiti a un membro attivo del team.',
            confidence:        95,
            supportingFacts: [
                `Compiti assegnati: ${activeTasks.length}`,
                `Urgenti: ${urgentCnt}`,
                `Stato utente: SOSPESO`,
            ],
            linkedTask: null, linkedUser: u.id, department: null,
            quickAction: { label: 'Apri Team', url: '/operations-team.html' },
            generatedAt,
        });
    });

    // ── 3. OPENING_NOT_STARTED (URGENT + OPEN) ────────────────────────────────
    tasks.filter(t => t.priority === 'URGENT' && t.status === 'OPEN').forEach(t => {
        const isOverdue  = t.effectiveStatus === 'OVERDUE';
        const dueMs      = t.dueDate ? new Date(t.dueDate).getTime() : null;
        const minsLeft   = dueMs ? minsUntil(dueMs) : null;
        const overdueMin = isOverdue && dueMs ? minsSince(dueMs) : 0;

        let confidence = 60;
        if (isOverdue)                              confidence = 90;
        else if (minsLeft !== null && minsLeft < 120) confidence = 75;

        const timeDesc = isOverdue
            ? `è già in ritardo di ${overdueMin} minuti`
            : minsLeft !== null
                ? `scade tra ${minsLeft} minuti`
                : 'non ha scadenza impostata';

        push({
            id: nid(), type: 'OPENING_NOT_STARTED', severity: 'HIGH',
            title:             `Compito urgente non avviato: "${t.title}"`,
            reason:            `Basato sui compiti urgenti: "${t.title}" è urgente, non è stato avviato e ${timeDesc}.`,
            recommendedAction: 'Avviare immediatamente o riassegnare a chi può iniziare ora.',
            confidence,
            supportingFacts: [
                `Stato: OPEN (non avviato)`,
                `Priorità: URGENTE`,
                `Assegnato a: ${t.assigneeName || 'N/D'}`,
                `Scadenza: ${t.dueDate ? new Date(t.dueDate).toLocaleString('it-IT') : 'N/D'}`,
            ],
            linkedTask: t.id, linkedUser: t.assigneeId || null, department: t.department || null,
            quickAction: { label: 'Apri Task', url: `/operations-tasks.html#${t.id}` },
            generatedAt,
        });
    });

    // ── 4. URGENT_DEPARTMENT ──────────────────────────────────────────────────
    const deptUrgentLists = {};
    tasks.filter(t =>
        t.priority === 'URGENT' && t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && t.department
    ).forEach(t => {
        if (!deptUrgentLists[t.department]) deptUrgentLists[t.department] = [];
        deptUrgentLists[t.department].push(t);
    });

    Object.entries(deptUrgentLists)
        .filter(([, list]) => list.length >= URGENT_DEPT_THRESHOLD)
        .forEach(([dept, list]) => {
            const overdueInDept = list.filter(t => t.effectiveStatus === 'OVERDUE').length;
            push({
                id: nid(), type: 'URGENT_DEPARTMENT', severity: 'MEDIUM',
                title:             `Reparto "${dept}" sotto pressione`,
                reason:            `Il reparto "${dept}" ha ${list.length} compiti urgenti aperti` +
                                   (overdueInDept > 0 ? `, di cui ${overdueInDept} in ritardo` : '') + '.',
                recommendedAction: `Verificare e prioritizzare il reparto "${dept}".`,
                confidence:        80,
                supportingFacts: [
                    `Urgenti nel reparto: ${list.length}`,
                    `In ritardo nel reparto: ${overdueInDept}`,
                ],
                linkedTask: null, linkedUser: null, department: dept,
                quickAction: { label: 'Apri Operazioni', url: '/operations-tasks.html' },
                generatedAt,
            });
        });

    // ── 5. CHECK_DEPARTMENT (≥ OVERDUE_DEPT_THRESHOLD overdue in one dept) ────
    const deptOverdueLists = {};
    tasks.filter(t => t.effectiveStatus === 'OVERDUE' && t.department)
        .forEach(t => {
            if (!deptOverdueLists[t.department]) deptOverdueLists[t.department] = [];
            deptOverdueLists[t.department].push(t);
        });

    Object.entries(deptOverdueLists)
        .filter(([, list]) => list.length >= OVERDUE_DEPT_THRESHOLD)
        .forEach(([dept, list]) => {
            const urgentInDept = list.filter(t => t.priority === 'URGENT').length;
            const maxMin = Math.max(...list.map(t =>
                Math.round((now - new Date(t.dueDate).getTime()) / 60_000)
            ));
            push({
                id: nid(), type: 'CHECK_DEPARTMENT', severity: 'MEDIUM',
                title:             `Verificare reparto "${dept}"`,
                reason:            `Basato sui compiti in ritardo: il reparto "${dept}" ha ${list.length} compiti in ritardo. ` +
                                   `Il più in ritardo è da ${maxMin} minuti.`,
                recommendedAction: `Rivedere le priorità del reparto "${dept}" e intervenire sui compiti in ritardo.`,
                confidence:        80,
                supportingFacts: [
                    `In ritardo nel reparto: ${list.length}`,
                    `Urgenti in ritardo: ${urgentInDept}`,
                    `Ritardo massimo: ${maxMin} min`,
                ],
                linkedTask: null, linkedUser: null, department: dept,
                quickAction: { label: 'Apri Operazioni', url: '/operations-tasks.html' },
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
            t => t.assigneeId === w.userId && t.status === 'OPEN' && t.priority !== 'URGENT'
        );
        if (!movable.length) return;
        const t = movable[0];

        push({
            id: nid(), type: 'REASSIGN_TASK', severity: 'MEDIUM',
            title:             `Sposta "${t.title}" da ${w.userName} a ${candidate.userName}`,
            reason:            `Basato sul carico attuale: ${w.userName} ha score ${w.currentLoadScore} (OVERLOADED), ` +
                               `${candidate.userName} ha score ${candidate.currentLoadScore} (${candidate.status}).`,
            recommendedAction: `Spostare "${t.title}" a ${candidate.userName} per bilanciare il carico.`,
            confidence:        75,
            supportingFacts: [
                `Da: ${w.userName} (score ${w.currentLoadScore})`,
                `A: ${candidate.userName} (score ${candidate.currentLoadScore})`,
                `Compito: "${t.title}"`,
                `Priorità: ${t.priority}`,
            ],
            linkedTask: t.id, linkedUser: w.userId, department: t.department || null,
            quickAction: { label: 'Apri Task', url: `/operations-tasks.html#${t.id}` },
            generatedAt,
        });
    });

    // ── 7. REVIEW_RECURRING ───────────────────────────────────────────────────
    tasks.filter(t => t.effectiveStatus === 'OVERDUE' && t.templateId).forEach(t => {
        const overdueMin = Math.round((now - new Date(t.dueDate).getTime()) / 60_000);
        push({
            id: nid(), type: 'REVIEW_RECURRING', severity: 'MEDIUM',
            title:             `Compito ricorrente in ritardo: "${t.title}"`,
            reason:            `Il compito ricorrente "${t.title}" è in ritardo di ${overdueMin} minuti. ` +
                               'I compiti ricorrenti non completati in tempo interrompono il ciclo operativo.',
            recommendedAction: 'Completare questo compito ricorrente il prima possibile.',
            confidence:        85,
            supportingFacts: [
                `Tipo: ricorrente`,
                `In ritardo di: ${overdueMin} min`,
                `Assegnato a: ${t.assigneeName || 'N/D'}`,
            ],
            linkedTask: t.id, linkedUser: t.assigneeId || null, department: t.department || null,
            quickAction: { label: 'Apri Task', url: `/operations-tasks.html#${t.id}` },
            generatedAt,
        });
    });

    // ── 8. UNDERUSED_USER ─────────────────────────────────────────────────────
    const teamOverdueCount = tasks.filter(t => t.effectiveStatus === 'OVERDUE').length;
    if (teamOverdueCount > 0) {
        workload.filter(w => w.assigned === 0 && w.completedToday === 0).forEach(w => {
            push({
                id: nid(), type: 'UNDERUSED_USER', severity: 'LOW',
                title:             `${w.userName} non ha compiti assegnati`,
                reason:            `Basato sul carico attuale: ${w.userName} non ha compiti attivi mentre il team ` +
                                   `ha ${teamOverdueCount} ${teamOverdueCount === 1 ? 'compito in ritardo' : 'compiti in ritardo'}.`,
                recommendedAction: 'Considerare di assegnare compiti a questo membro disponibile.',
                confidence:        70,
                supportingFacts: [
                    `Compiti assegnati: 0`,
                    `Completati oggi: 0`,
                    `Compiti in ritardo nel team: ${teamOverdueCount}`,
                ],
                linkedTask: null, linkedUser: w.userId, department: null,
                quickAction: { label: 'Apri Task', url: '/operations-tasks.html' },
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
// Produces a deterministic role-specific Italian briefing string from structured facts.

function generateBriefing(role, data) {
    const h = new Date().getHours();
    const greeting = h < 12 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';

    switch (role) {
        case 'DIRECTOR': {
            const { summary, decisionsCount, trends } = data;
            const totalOps = (summary.completedToday || 0) + (summary.overdueToday || 0) + (summary.urgentOpen || 0);
            const trendNote = (() => {
                if (!trends || !trends.overdue) return null;
                if (trends.overdue.direction === 'IMPROVING')  return 'Il numero di attività scadute è migliorato rispetto a ieri.';
                if (trends.overdue.direction === 'WORSENING')  return 'Il numero di attività scadute è aumentato rispetto a ieri.';
                if (trends.overdue.direction === 'STABLE')     return 'Il carico operativo è stabile rispetto a ieri.';
                return null;
            })();
            return [
                `${greeting}.`,
                `Oggi ci sono ${totalOps} attività operative.`,
                summary.overdueToday > 0
                    ? `${summary.overdueToday} ${summary.overdueToday === 1 ? 'è in ritardo' : 'sono in ritardo'}.`
                    : 'Nessuna attività in ritardo.',
                decisionsCount > 0
                    ? `${decisionsCount} ${decisionsCount === 1 ? 'decisione richiede' : 'decisioni richiedono'} la tua attenzione.`
                    : null,
                trendNote,
            ].filter(Boolean).join(' ');
        }
        case 'CHEF_CUISINE': {
            const { summary, decisionsCount } = data;
            const totalKitchen = (summary.completedToday || 0) + (summary.overdueToday || 0);
            return [
                `La cucina ha ${totalKitchen} attività.`,
                (summary.urgentOpen || 0) > 0 ? `${summary.urgentOpen} ${summary.urgentOpen === 1 ? 'è urgente' : 'sono urgenti'}.` : null,
                (summary.overdueToday || 0) > 0
                    ? `${summary.overdueToday === 1 ? 'Una attività è in ritardo' : `${summary.overdueToday} attività sono in ritardo`}.`
                    : 'Nessun ritardo.',
                decisionsCount > 0 ? `${decisionsCount} ${decisionsCount === 1 ? 'decisione richiede' : 'decisioni richiedono'} attenzione.` : null,
            ].filter(Boolean).join(' ');
        }
        case 'ADJOINT': {
            const { summary, decisionsCount } = data;
            return [
                `${greeting}.`,
                (summary.overdueToday || 0) > 0
                    ? `${summary.overdueToday} ${summary.overdueToday === 1 ? 'compito richiede' : 'compiti richiedono'} coordinamento (in ritardo).`
                    : 'Nessun ritardo nel tuo scope.',
                (summary.urgentOpen || 0) > 0 ? `${summary.urgentOpen} urgenti da gestire.` : null,
                decisionsCount > 0 ? `${decisionsCount} ${decisionsCount === 1 ? 'decisione richiede' : 'decisioni richiedono'} attenzione.` : null,
            ].filter(Boolean).join(' ');
        }
        case 'SOUS_CHEF': {
            const { myMetrics, nextTask } = data;
            return [
                `Hai ${myMetrics.assigned} ${myMetrics.assigned === 1 ? 'attività' : 'attività'} oggi.`,
                myMetrics.urgent > 0 ? `${myMetrics.urgent === 1 ? 'Una è urgente' : `${myMetrics.urgent} sono urgenti`}.` : null,
                nextTask && nextTask.dueDate
                    ? `La prossima scade alle ${new Date(nextTask.dueDate).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}.`
                    : nextTask ? 'Hai un compito da completare.' : null,
            ].filter(Boolean).join(' ');
        }
        case 'CHEF_DE_BRIGADE': {
            const { myMetrics, nextTask } = data;
            return [
                myMetrics.overdue > 0
                    ? `${myMetrics.overdue === 1 ? 'Un compito è in ritardo' : `${myMetrics.overdue} compiti sono in ritardo`}. Intervieni subito.`
                    : 'Nessun ritardo.',
                nextTask ? `Prossimo compito: "${nextTask.title}".` : 'Nessun compito imminente.',
                myMetrics.completedToday > 0 ? `Hai già completato ${myMetrics.completedToday} compiti oggi.` : null,
            ].filter(Boolean).join(' ');
        }
        default:
            return `${greeting}. Controlla le tue attività.`;
    }
}

// ── Department Health (Sprint 6.2) ────────────────────────────────────────────
// Returns per-department metrics from scoped tasks, with a trend direction
// computed by comparing current overdue count against yesterday's snapshot.

function getDepartmentHealth(scopedTasks, yesterdaySnapshot) {
    const now   = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    const enriched = (scopedTasks || []).map(t => {
        let effectiveStatus = t.status;
        if (!['COMPLETED','CANCELLED'].includes(t.status) && t.dueDate) {
            const due = new Date(t.dueDate).getTime();
            if (!isNaN(due) && now > due) effectiveStatus = 'OVERDUE';
        }
        return { ...t, effectiveStatus };
    });

    const depts = {};
    enriched.forEach(t => {
        if (!t.department) return;
        if (!depts[t.department]) {
            depts[t.department] = { dept: t.department, open: 0, overdue: 0, urgent: 0, completedToday: 0 };
        }
        const d = depts[t.department];
        if (!['COMPLETED','CANCELLED'].includes(t.status)) d.open++;
        if (t.effectiveStatus === 'OVERDUE')               d.overdue++;
        if (t.priority === 'URGENT' && !['COMPLETED','CANCELLED'].includes(t.status)) d.urgent++;
        if (t.status === 'COMPLETED') {
            try { if (new Date(t.completedAt).toISOString().slice(0, 10) === today) d.completedToday++; }
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
