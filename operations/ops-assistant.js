'use strict';
/**
 * PlateTimer Operations — Executive Assistant Engine (Sprint 6.3)
 *
 * Transforms existing intelligence data (Sprint 6.0–6.2) into a concise
 * operational assistant output:
 *
 *  generatePriorityQueue(tasks, workload, decisions) → ranked action items
 *  detectRisks(tasks, users, workload)               → risk items (CRITICAL→LOW)
 *  buildChangesSince(trends, yesterdaySnap, summary) → meaningful change sentences
 *  buildExecutiveBrief(role, ...)                    → structured Italian brief
 *
 * No AI, no ML, no external APIs.  Everything deterministic and explainable.
 */

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
 * @returns {Array<{riskId, level, title, description, linkedTask, linkedUser,
 *                  linkedDept, minutesUntilDue?}>}
 */
function detectRisks(rawTasks, users, workload) {
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
        .filter(t =>
            t.priority === 'URGENT' &&
            t.effectiveStatus === 'OVERDUE' &&
            t.assigneeId && overloadedIds.has(t.assigneeId)
        )
        .forEach(t => {
            const overMin = Math.round((now - new Date(t.dueDate).getTime()) / 60_000);
            risks.push({
                riskId: nid(), level: 'CRITICAL',
                title:       `Compito urgente in ritardo su utente sovraccarico`,
                description: `"${t.title}" è urgente, in ritardo di ${overMin} min, e l'assegnatario è sovraccarico.`,
                linkedTask:  t.id,
                linkedUser:  t.assigneeId || null,
                linkedDept:  t.department || null,
            });
        });

    // ── CRITICAL: suspended user still has urgent tasks ───────────────────────
    tasks
        .filter(t =>
            t.priority === 'URGENT' &&
            !['COMPLETED','CANCELLED'].includes(t.status) &&
            t.assigneeId && suspendedIds.has(t.assigneeId)
        )
        .forEach(t => {
            risks.push({
                riskId: nid(), level: 'CRITICAL',
                title:       `Compito urgente assegnato a utente sospeso`,
                description: `"${t.title}" è urgente ma assegnato a un utente sospeso. Riassegnare immediatamente.`,
                linkedTask:  t.id,
                linkedUser:  t.assigneeId || null,
                linkedDept:  t.department || null,
            });
        });

    // ── HIGH: task due within 60 minutes and not started (status OPEN) ────────
    tasks
        .filter(t => {
            if (t.status !== 'OPEN' || !t.dueDate) return false;
            const dueMs = new Date(t.dueDate).getTime();
            const minsLeft = (dueMs - now) / 60_000;
            return minsLeft > 0 && minsLeft <= 60;
        })
        .forEach(t => {
            const minsLeft = Math.round((new Date(t.dueDate).getTime() - now) / 60_000);
            risks.push({
                riskId: nid(), level: 'HIGH',
                title:          `Scadenza imminente — compito non avviato`,
                description:    `"${t.title}" scade tra ${minsLeft} minuti e non è ancora stato avviato.`,
                linkedTask:     t.id,
                linkedUser:     t.assigneeId || null,
                linkedDept:     t.department || null,
                minutesUntilDue: minsLeft,
            });
        });

    // ── HIGH: user overloaded ─────────────────────────────────────────────────
    wl.filter(w => w.status === 'OVERLOADED').forEach(w => {
        risks.push({
            riskId: nid(), level: 'HIGH',
            title:       `${w.userName} è sovraccarico`,
            description: `Score di carico ${w.currentLoadScore}: ${w.assigned} compiti, ${w.overdue} in ritardo, ${w.urgent} urgenti.`,
            linkedTask:  null,
            linkedUser:  w.userId,
            linkedDept:  null,
        });
    });

    // ── HIGH: urgent task overdue but assignee not overloaded (not already CRITICAL) ─
    tasks
        .filter(t =>
            t.priority === 'URGENT' &&
            t.effectiveStatus === 'OVERDUE' &&
            !(t.assigneeId && overloadedIds.has(t.assigneeId))  // CRITICAL already covers overloaded
        )
        .forEach(t => {
            const overdueMin = Math.round((now - new Date(t.dueDate).getTime()) / 60_000);
            risks.push({
                riskId: nid(), level: 'HIGH',
                title:       `Compito urgente in ritardo: "${t.title}"`,
                description: `"${t.title}" è urgente e in ritardo di ${overdueMin} min.`,
                linkedTask:  t.id,
                linkedUser:  t.assigneeId || null,
                linkedDept:  t.department || null,
            });
        });

    // ── HIGH: urgent task not started at all ──────────────────────────────────
    tasks
        .filter(t => t.priority === 'URGENT' && t.status === 'OPEN' && t.effectiveStatus !== 'OVERDUE')
        .forEach(t => {
            // Only raise HIGH here if not CRITICAL (no overloaded assignee)
            if (t.assigneeId && overloadedIds.has(t.assigneeId)) return; // already CRITICAL
            risks.push({
                riskId: nid(), level: 'HIGH',
                title:       `Compito urgente non avviato: "${t.title}"`,
                description: `Il compito urgente "${t.title}" è ancora in stato OPEN e non è stato avviato.`,
                linkedTask:  t.id,
                linkedUser:  t.assigneeId || null,
                linkedDept:  t.department || null,
            });
        });

    // ── MEDIUM: IN_PROGRESS task inactive for ≥ 4 hours ──────────────────────
    const INACTIVE_CUTOFF = now - 4 * 3_600_000;
    tasks
        .filter(t =>
            t.status === 'IN_PROGRESS' &&
            t.updatedAt &&
            new Date(t.updatedAt).getTime() < INACTIVE_CUTOFF
        )
        .forEach(t => {
            const hrsInactive = Math.round((now - new Date(t.updatedAt).getTime()) / 3_600_000);
            risks.push({
                riskId: nid(), level: 'MEDIUM',
                title:       `Compito in corso senza aggiornamenti`,
                description: `"${t.title}" è IN_PROGRESS ma non viene aggiornato da ${hrsInactive} ore.`,
                linkedTask:  t.id,
                linkedUser:  t.assigneeId || null,
                linkedDept:  t.department || null,
            });
        });

    // ── MEDIUM: recurring task overdue ────────────────────────────────────────
    tasks
        .filter(t => t.effectiveStatus === 'OVERDUE' && t.templateId)
        .forEach(t => {
            const overMin = Math.round((now - new Date(t.dueDate).getTime()) / 60_000);
            risks.push({
                riskId: nid(), level: 'MEDIUM',
                title:       `Compito ricorrente in ritardo`,
                description: `"${t.title}" è un compito ricorrente in ritardo di ${overMin} min. Il ciclo operativo è a rischio.`,
                linkedTask:  t.id,
                linkedUser:  t.assigneeId || null,
                linkedDept:  t.department || null,
            });
        });

    // ── MEDIUM: department with ≥ 3 overdue tasks ─────────────────────────────
    const deptOverdue = {};
    tasks
        .filter(t => t.effectiveStatus === 'OVERDUE' && t.department)
        .forEach(t => { deptOverdue[t.department] = (deptOverdue[t.department] || 0) + 1; });
    Object.entries(deptOverdue)
        .filter(([, cnt]) => cnt >= 3)
        .forEach(([dept, cnt]) => {
            risks.push({
                riskId: nid(), level: 'MEDIUM',
                title:       `Reparto "${dept}" sotto pressione`,
                description: `Il reparto "${dept}" ha ${cnt} compiti in ritardo.`,
                linkedTask:  null,
                linkedUser:  null,
                linkedDept:  dept,
            });
        });

    // ── LOW: task open > 48 hours with no update ──────────────────────────────
    const STALE_CUTOFF = now - 48 * 3_600_000;
    tasks
        .filter(t =>
            t.status === 'OPEN' &&
            t.createdAt &&
            new Date(t.createdAt).getTime() < STALE_CUTOFF &&
            (!t.updatedAt || new Date(t.updatedAt).getTime() < STALE_CUTOFF)
        )
        .forEach(t => {
            const daysOld = Math.round((now - new Date(t.createdAt).getTime()) / 86_400_000);
            risks.push({
                riskId: nid(), level: 'LOW',
                title:       `Compito aperto da ${daysOld} giorni`,
                description: `"${t.title}" è stato creato ${daysOld} giorni fa e non è ancora iniziato.`,
                linkedTask:  t.id,
                linkedUser:  t.assigneeId || null,
                linkedDept:  t.department || null,
            });
        });

    // ── LOW: department with ≥ 2 urgent tasks ────────────────────────────────
    const deptUrgent = {};
    tasks
        .filter(t =>
            t.priority === 'URGENT' &&
            !['COMPLETED','CANCELLED'].includes(t.status) &&
            t.department
        )
        .forEach(t => { deptUrgent[t.department] = (deptUrgent[t.department] || 0) + 1; });
    Object.entries(deptUrgent)
        .filter(([, cnt]) => cnt >= 2)
        .forEach(([dept, cnt]) => {
            // Only raise LOW if not already raised as MEDIUM (dept overdue ≥3)
            if ((deptOverdue[dept] || 0) >= 3) return;
            risks.push({
                riskId: nid(), level: 'LOW',
                title:       `Reparto "${dept}" con più urgenze`,
                description: `Il reparto "${dept}" ha ${cnt} compiti urgenti aperti.`,
                linkedTask:  null,
                linkedUser:  null,
                linkedDept:  dept,
            });
        });

    // ── LOW: BUSY user with at least one overdue task ─────────────────────────
    wl.filter(w => w.status === 'BUSY' && w.overdue >= 1 && !overloadedIds.has(w.userId)).forEach(w => {
        risks.push({
            riskId: nid(), level: 'LOW',
            title:       `${w.userName} è occupato con compiti in ritardo`,
            description: `${w.userName} (BUSY, score ${w.currentLoadScore}) ha ${w.overdue} compiti in ritardo.`,
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
 * Collapse multiple risk items that concern the same underlying entity
 * into a single card:
 *   task:<taskId>               — same task → highest severity, merged reasons
 *   user:<userId>:overload      — same user overload / busy
 *   department:<dept>:overdue   — same dept overdue cluster
 *   department:<dept>:urgent    — same dept urgent cluster
 *   misc:<title>                — everything else — dedupe by exact title
 *
 * Rules:
 *  1. Group by stable dedup key.
 *  2. Winner = highest severity (CRITICAL > HIGH > MEDIUM > LOW).
 *  3. Merge reasons from all members into `reasons[]` (deduplicated).
 *  4. The winner's description becomes the primary description; extras appended.
 *
 * @param {object[]} risks — already sorted CRITICAL→LOW
 * @returns {object[]}
 */
function deduplicateRisks(risks) {
    /**
     * Derive the stable deduplication key for a risk item.
     * Task-linked items always key on the task so a task never appears twice.
     * User-linked items key on the user for overload/busy scenarios.
     * Department items key on dept + problem type.
     */
    function dedupKey(risk) {
        if (risk.linkedTask) return `task:${risk.linkedTask}`;
        if (risk.linkedUser && !risk.linkedDept) return `user:${risk.linkedUser}:overload`;
        if (risk.linkedDept) {
            // Distinguish overdue cluster from urgent cluster by description keyword
            const isOverdue = risk.description && risk.description.includes('ritardo');
            return `department:${risk.linkedDept}:${isOverdue ? 'overdue' : 'urgent'}`;
        }
        return `misc:${risk.title}`;
    }

    // Ordered map to preserve CRITICAL→LOW order of first occurrence of each key
    const map = new Map();

    for (const risk of risks) {
        const key = dedupKey(risk);
        if (!map.has(key)) {
            // First (highest-severity) occurrence → clone and add reasons array
            map.set(key, { ...risk, dedupKey: key, reasons: [risk.description] });
        } else {
            // Merge: keep winner's level, append reason if it adds new info
            const winner = map.get(key);
            if (!winner.reasons.includes(risk.description)) {
                winner.reasons.push(risk.description);
            }
            // Elevate severity if a later item is somehow higher (shouldn't happen
            // with a pre-sorted list, but guard defensively)
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
 * Compute which high-signal items are "new" since the user's previous visit.
 *
 * An item is new when its meaningful event time > previousVisitAt.
 *
 * Includes:
 *   • HIGH / CRITICAL Risk Watch items
 *   • HIGH / CRITICAL Decision Cards
 *   • New overdue tasks (became overdue after previousVisitAt)
 *   • New urgent tasks created after previousVisitAt
 *   • New escalations triggered after previousVisitAt
 *
 * Excludes:
 *   • LOW / MEDIUM items
 *   • Completed or cancelled tasks
 *   • Items created before previousVisitAt
 *
 * First-visit rule: if previousVisitAt is null, return empty (no backlog dump).
 *
 * @param {{riskWatch, decisions, tasks, previousVisitAt, now}} opts
 * @returns {{ previousVisitAt, newCount, newCritical, newHigh, items[] }}
 */
function buildNewSinceLastVisit({ riskWatch, decisions, tasks, previousVisitAt, now }) {
    now = now || Date.now();

    // First visit — establish baseline, show nothing as new
    if (!previousVisitAt) {
        return { previousVisitAt: null, newCount: 0, newCritical: 0, newHigh: 0, items: [] };
    }

    const prev      = previousVisitAt;
    const taskMap   = new Map((tasks || []).map(t => [t.id, t]));
    const newItems  = [];
    const seenIds   = new Set();   // avoid double-counting across source arrays

    function addItem(id, type, severity, title, description, linkedTask, linkedUser, linkedDept, eventTime) {
        if (!['CRITICAL', 'HIGH'].includes(severity)) return;  // ignore MEDIUM/LOW noise
        if (eventTime <= prev) return;                          // not new
        if (seenIds.has(id)) return;                           // already counted
        seenIds.add(id);
        newItems.push({ id, type, severity, title, description, linkedTask, linkedUser, linkedDept, createdAt: eventTime });
    }

    // ── Source 1: HIGH/CRITICAL Risk Watch items ───────────────────────────
    for (const rk of (riskWatch || [])) {
        if (!['CRITICAL', 'HIGH'].includes(rk.level)) continue;
        const task = rk.linkedTask ? taskMap.get(rk.linkedTask) : null;
        // Event time = when the task was last meaningfully changed.
        // Do NOT use dueDate: a task overdue before the last visit would otherwise
        // be counted as "new" every visit.  updatedAt is the correct signal.
        const eventTime = task
            ? (task.updatedAt || task.createdAt || now)
            : now;
        const itemId = `rw:${rk.dedupKey || rk.riskId}`;
        addItem(itemId, 'RISK', rk.level, rk.title, rk.description,
                rk.linkedTask || null, rk.linkedUser || null, rk.linkedDept || null, eventTime);
    }

    // ── Source 2: HIGH/CRITICAL Decision Cards ─────────────────────────────
    for (const d of (decisions || [])) {
        if (!['HIGH'].includes(d.severity)) continue;  // decisions are HIGH at most
        const task = d.linkedTask ? taskMap.get(d.linkedTask) : null;
        const eventTime = task ? (task.updatedAt || task.createdAt || now) : now;
        const itemId = `dec:${d.type || d.title}:${d.linkedTask || d.linkedUser || ''}`;
        addItem(itemId, 'DECISION', d.severity, d.title, d.reason,
                d.linkedTask || null, d.linkedUser || null, d.department || null, eventTime);
    }

    // ── Source 3: Urgent tasks created after last visit ────────────────────
    for (const t of (tasks || [])) {
        if (t.priority !== 'URGENT') continue;
        if (['COMPLETED', 'CANCELLED'].includes(t.status)) continue;
        const eventTime = t.createdAt || now;
        if (eventTime <= prev) continue;
        const itemId = `urgent:${t.id}`;
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);
        newItems.push({
            id: itemId, type: 'URGENT_TASK', severity: 'HIGH',
            title:       `Nuovo compito urgente: "${t.title}"`,
            description: `Compito urgente "${t.title}" creato dopo la tua ultima visita.`,
            linkedTask: t.id, linkedUser: t.assigneeId || null, linkedDept: t.department || null,
            createdAt: eventTime,
        });
    }

    // ── Source 4: New escalations triggered after last visit ───────────────
    for (const t of (tasks || [])) {
        if (!t.escalationSentAt) continue;
        if (['COMPLETED', 'CANCELLED'].includes(t.status)) continue;
        const eventTime = typeof t.escalationSentAt === 'number'
            ? t.escalationSentAt : new Date(t.escalationSentAt).getTime();
        if (isNaN(eventTime) || eventTime <= prev) continue;
        const itemId = `esc:${t.id}`;
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);
        newItems.push({
            id: itemId, type: 'ESCALATION', severity: 'HIGH',
            title:       `Escalation: "${t.title}"`,
            description: `Il compito "${t.title}" ha attivato un'escalation dopo la tua ultima visita.`,
            linkedTask: t.id, linkedUser: t.assigneeId || null, linkedDept: t.department || null,
            createdAt: eventTime,
        });
    }

    // Sort: CRITICAL first, then HIGH; within same severity by createdAt desc
    newItems.sort((a, b) => {
        const sv = RISK_ORDER[a.severity] - RISK_ORDER[b.severity];
        return sv !== 0 ? sv : b.createdAt - a.createdAt;
    });

    const newCritical = newItems.filter(i => i.severity === 'CRITICAL').length;
    const newHigh     = newItems.filter(i => i.severity === 'HIGH').length;

    return {
        previousVisitAt: prev,
        newCount:    newItems.length,
        newCritical,
        newHigh,
        items: newItems,
    };
}

// ── 3. Changes Since Yesterday ────────────────────────────────────────────────
/**
 * Build a list of meaningful change sentences from trend data.
 * Only includes non-STABLE, non-INSUFFICIENT_DATA metrics.
 *
 * @param {object|null} trends          — from analyzeTrends()
 * @param {object|null} yesterdaySnap   — raw snapshot
 * @param {object}      summary         — from analyzeIntelligence()
 * @returns {Array<{field, direction, text}>}
 */
function buildChangesSince(trends, yesterdaySnap, summary) {
    if (!trends || !yesterdaySnap) return [];

    const changes = [];

    function push(field, t, textFn) {
        if (!t || t.direction === 'STABLE' || t.direction === 'INSUFFICIENT_DATA') return;
        if (t.previousValue === null || t.previousValue === undefined) return;
        changes.push({ field, direction: t.direction, text: textFn(t) });
    }

    push('overdue', trends.overdue, t => {
        const delta = Math.abs(t.delta);
        return t.direction === 'IMPROVING'
            ? `I compiti in ritardo sono diminuiti da ${t.previousValue} a ${t.currentValue}.`
            : `I compiti in ritardo sono aumentati da ${t.previousValue} a ${t.currentValue}.`;
    });

    push('completionRate', trends.completionRate, t => {
        const delta = Math.abs(t.delta);
        return t.direction === 'IMPROVING'
            ? `Il tasso di completamento è migliorato di ${delta} punti percentuali (${t.previousValue}% → ${t.currentValue}%).`
            : `Il tasso di completamento è diminuito di ${delta} punti percentuali (${t.previousValue}% → ${t.currentValue}%).`;
    });

    push('urgentTasks', trends.urgentTasks, t => {
        return t.direction === 'IMPROVING'
            ? `I compiti urgenti sono diminuiti da ${t.previousValue} a ${t.currentValue}.`
            : `I compiti urgenti sono aumentati da ${t.previousValue} a ${t.currentValue}.`;
    });

    push('workload', trends.workload, t => {
        return t.direction === 'IMPROVING'
            ? `Il numero di utenti sovraccarichi è diminuito (da ${t.previousValue} a ${t.currentValue}).`
            : `Il numero di utenti sovraccarichi è aumentato (da ${t.previousValue} a ${t.currentValue}).`;
    });

    return changes;
}

// ── 4. Executive Brief ────────────────────────────────────────────────────────
/**
 * Build the structured Italian executive brief.
 * More detailed than generateBriefing() — includes numbered priorities and
 * change bullets.
 *
 * @param {string}   role
 * @param {object}   summary       — from analyzeIntelligence()
 * @param {object[]} priorityQueue — from generatePriorityQueue()
 * @param {object[]} riskWatch     — from detectRisks()
 * @param {object[]} changesSince  — from buildChangesSince()
 * @param {object[]} decisions     — raw decisions
 * @param {object|null} trends
 * @param {object|null} myMetrics  — for SC/CDB
 * @param {object|null} nextTask   — for SC/CDB
 * @returns {string}
 */
function buildExecutiveBrief(role, summary, priorityQueue, riskWatch, changesSince, decisions, trends, myMetrics, nextTask) {
    const h = new Date().getHours();
    const greeting = h < 12 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';

    const lines = [];

    switch (role) {
        case 'DIRECTOR': {
            const totalOps   = (summary.completedToday || 0) + (summary.overdueToday || 0) + (summary.urgentOpen || 0);
            const decCount   = (decisions || []).length;
            const critRisks  = riskWatch.filter(r => r.level === 'CRITICAL').length;
            const highRisks  = riskWatch.filter(r => r.level === 'HIGH').length;

            lines.push(`${greeting}.`);
            lines.push('');
            lines.push(`Oggi ci sono ${totalOps} attività operative.`);
            lines.push('');

            if (summary.overdueToday > 0)
                lines.push(`${summary.overdueToday} ${summary.overdueToday === 1 ? 'è in ritardo' : 'sono in ritardo'}.`);
            else
                lines.push('Nessuna attività in ritardo.');

            if (summary.urgentOpen > 0)
                lines.push(`${summary.urgentOpen} ${summary.urgentOpen === 1 ? 'è urgente' : 'sono urgenti'}.`);

            if (decCount > 0)
                lines.push(`${decCount} ${decCount === 1 ? 'decisione richiede' : 'decisioni richiedono'} il tuo intervento.`);

            if (critRisks > 0)
                lines.push(`⚠️ ${critRisks} rischio${critRisks > 1 ? 'hi critici' : ' critico'} rilevato${critRisks > 1 ? 'i' : ''}.`);

            if (changesSince && changesSince.length) {
                lines.push('');
                lines.push('Rispetto a ieri:');
                changesSince.forEach(c => {
                    const icon = c.direction === 'IMPROVING' ? '↓' : '↑';
                    lines.push(`• ${icon} ${c.text}`);
                });
            }

            if (priorityQueue && priorityQueue.length) {
                lines.push('');
                lines.push('Priorità consigliate:');
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
            lines.push(`La cucina ha ${(summary.completedToday || 0) + (summary.overdueToday || 0)} attività.`);
            if ((summary.urgentOpen || 0) > 0)
                lines.push(`${summary.urgentOpen} ${summary.urgentOpen === 1 ? 'è urgente' : 'sono urgenti'}.`);
            if ((summary.overdueToday || 0) > 0)
                lines.push(`${summary.overdueToday === 1 ? 'Una attività è in ritardo' : `${summary.overdueToday} attività sono in ritardo`}.`);
            else
                lines.push('Nessun ritardo.');
            if (decCount > 0)
                lines.push(`${decCount} ${decCount === 1 ? 'decisione richiede' : 'decisioni richiedono'} attenzione.`);
            if (priorityQueue && priorityQueue.length) {
                lines.push('');
                lines.push('Priorità:');
                priorityQueue.slice(0, 3).forEach((p, i) =>
                    lines.push(`${i + 1}. ${p.recommendedAction.slice(0, 60)}`)
                );
            }
            break;
        }

        case 'ADJOINT': {
            const decCount = (decisions || []).length;
            lines.push(`${greeting}.`);
            if ((summary.overdueToday || 0) > 0)
                lines.push(`${summary.overdueToday} ${summary.overdueToday === 1 ? 'compito richiede' : 'compiti richiedono'} coordinamento (in ritardo).`);
            else
                lines.push('Nessun ritardo nel tuo scope.');
            if ((summary.urgentOpen || 0) > 0)
                lines.push(`${summary.urgentOpen} urgenti da gestire.`);
            if (decCount > 0)
                lines.push(`${decCount} ${decCount === 1 ? 'decisione richiede' : 'decisioni richiedono'} attenzione.`);
            if (priorityQueue && priorityQueue.length) {
                lines.push('');
                lines.push('Priorità:');
                priorityQueue.slice(0, 3).forEach((p, i) =>
                    lines.push(`${i + 1}. ${p.recommendedAction.slice(0, 60)}`)
                );
            }
            break;
        }

        case 'SOUS_CHEF': {
            const m = myMetrics || {};
            lines.push(`Hai ${m.assigned || 0} ${(m.assigned || 0) === 1 ? 'attività' : 'attività'} oggi.`);
            if ((m.urgent || 0) > 0)
                lines.push(`${m.urgent === 1 ? 'Una è urgente' : `${m.urgent} sono urgenti`}.`);
            if ((m.overdue || 0) > 0)
                lines.push(`${m.overdue} in ritardo — intervieni subito.`);
            if (nextTask && nextTask.dueDate)
                lines.push(`Prossima scadenza alle ${new Date(nextTask.dueDate).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}.`);
            else if (nextTask)
                lines.push('Hai un compito da completare.');
            break;
        }

        case 'CHEF_DE_BRIGADE': {
            const m = myMetrics || {};
            if ((m.overdue || 0) > 0)
                lines.push(`${m.overdue === 1 ? 'Un compito è in ritardo' : `${m.overdue} compiti sono in ritardo`}. Intervieni subito.`);
            else
                lines.push('Nessun ritardo.');
            if (nextTask)
                lines.push(`Prossimo compito: "${nextTask.title}".`);
            else
                lines.push('Nessun compito imminente.');
            if ((m.completedToday || 0) > 0)
                lines.push(`Hai già completato ${m.completedToday} compiti oggi.`);
            break;
        }

        default:
            lines.push(`${greeting}. Controlla le tue attività.`);
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
