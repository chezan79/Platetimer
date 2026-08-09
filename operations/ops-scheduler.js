'use strict';
// operations/ops-scheduler.js
// Recurring-generation, reminder, escalation, and daily-digest scheduler.
// Designed to be IDEMPOTENT — safe to run repeatedly and after server restarts.
// All phase functions accept an optional `now` Date for testability.

const opsRecurring = require('./ops-recurring');

// ── Escalation chains ───────────────────────────────────────────────────────
// Maps assignee ROLE → ordered list of ROLES to escalate through.
// Director has no escalation target — they are the top of the chain.
const ESCALATION_CHAIN = {
    CHEF_DE_BRIGADE: ['ADJOINT', 'DIRECTOR'],
    SOUS_CHEF:       ['CHEF_CUISINE', 'DIRECTOR'],
    CHEF_CUISINE:    ['DIRECTOR'],
    ADJOINT:         ['DIRECTOR'],
    DIRECTOR:        [],
};

function getEscalationChain(role) {
    return ESCALATION_CHAIN[role] || [];
}

// Resolve actual user records for the escalation chain of a task's assignee.
// Returns ordered array of active company users to notify (skipping missing roles).
function resolveEscalationTargets(task, allUsersForCompany) {
    const usersById = {};
    for (const u of (allUsersForCompany || [])) usersById[u.id] = u;

    const assignee = task.assigneeId ? usersById[task.assigneeId] : null;
    if (!assignee) return [];

    const chain = getEscalationChain(assignee.role);
    const targets = [];
    for (const role of chain) {
        // Find the first active company user with that role (most senior match is fine —
        // for DIRECTOR there is typically only one).
        const match = (allUsersForCompany || []).find(
            u => u.role === role && (u.status === 'ACTIVE') && u.email
        );
        if (match) targets.push(match);
    }
    return targets;
}

// ── Default preferences ─────────────────────────────────────────────────────
function DEFAULT_PREFS() {
    return { emailReminders: true, taskAssignment: true, escalationEmails: true, dailyDigest: false };
}

// Resolve effective preferences for a user: company defaults overridden by user-level settings.
function getUserPrefs(opsPrefsStore, companyId, userId) {
    const co = (opsPrefsStore || {})[companyId] || {};
    const defaults = { ...DEFAULT_PREFS(), ...(co.defaults || {}) };
    const userOverride = (co.users || {})[userId] || {};
    return { ...defaults, ...userOverride };
}

function getCompanyPrefs(opsPrefsStore, companyId) {
    const co = (opsPrefsStore || {})[companyId] || {};
    return { ...DEFAULT_PREFS(), ...(co.defaults || {}) };
}

// ── Phase 1: Recurring task generation ─────────────────────────────────────
// For each active template, generate any missing occurrence tasks up to today.
async function processRecurring(stores, savers, addHistoryFn) {
    const { opsTasksStore, opsUsersStore, opsTemplatesStore } = stores;
    const { saveOpsTasks, saveOpsTemplates } = savers;

    // Collect all active templates across all companies
    const allTemplates = [];
    for (const companyId of Object.keys(opsTemplatesStore || {})) {
        for (const tpl of (opsTemplatesStore[companyId] || [])) {
            if (tpl.active !== false) allTemplates.push({ tpl, companyId });
        }
    }
    if (!allTemplates.length) return { generated: 0 };

    let generated = 0;
    let tasksDirty = false;
    let templatesDirty = false;

    for (const { tpl, companyId } of allTemplates) {
        // Build set of existing occurrence keys for this template's company
        const existingKeys = new Set(
            (opsTasksStore[companyId] || [])
                .filter(t => t.templateId === tpl.id && t.occurrenceKey)
                .map(t => t.occurrenceKey)
        );

        // Build usersById for this company
        const usersById = {};
        for (const u of (opsUsersStore[companyId] || [])) usersById[u.id] = u;

        const newTasks = opsRecurring.generateTasksForTemplate(tpl, companyId, existingKeys, usersById, addHistoryFn);
        if (!newTasks.length) continue;

        if (!opsTasksStore[companyId]) opsTasksStore[companyId] = [];
        for (const task of newTasks) {
            opsTasksStore[companyId].push(task);
            generated++;
        }
        tasksDirty = true;

        // Update template counters
        tpl.generatedCount = (tpl.generatedCount || 0) + newTasks.length;
        tpl.lastGeneratedAt = Date.now();
        templatesDirty = true;
    }

    if (tasksDirty)     saveOpsTasks();
    if (templatesDirty) saveOpsTemplates();
    if (generated > 0)  console.log(`[SCHEDULER] Generati ${generated} compiti ricorrenti`);
    return { generated };
}

// ── Phase 2: Reminders ──────────────────────────────────────────────────────
// Send a reminder email once per task when the reminder window is reached.
// Idempotent: task.reminderSentAt prevents re-sending.
async function processReminders(stores, savers, email, now) {
    const { opsTasksStore, opsUsersStore, opsPrefsStore } = stores;
    const { saveOpsTasks } = savers;
    const nowTime = now instanceof Date ? now : new Date(now || Date.now());
    const baseUrl = process.env.APP_BASE_URL || '';
    let sent = 0;
    let dirty = false;

    for (const companyId of Object.keys(opsTasksStore || {})) {
        for (const task of (opsTasksStore[companyId] || [])) {
            if (task.status === 'COMPLETED' || task.status === 'CANCELLED') continue;
            if (!task.reminderDays || !task.dueDate) continue;
            if (task.reminderSentAt) continue; // already sent

            // Reminder fires at dueDate-end-of-day minus reminderDays
            const dueEnd        = new Date(task.dueDate + 'T23:59:59');
            const reminderTime  = new Date(dueEnd.getTime() - task.reminderDays * 86400000);
            if (nowTime < reminderTime) continue;

            if (!task.assigneeId) continue;
            const assignee = (opsUsersStore[companyId] || []).find(u => u.id === task.assigneeId);
            if (!assignee || assignee.status !== 'ACTIVE' || !assignee.email) continue;

            const prefs = getUserPrefs(opsPrefsStore, companyId, assignee.id);
            if (!prefs.emailReminders) {
                // Mark as sent (suppressed by prefs) so we don't re-check every tick
                task.reminderSentAt = nowTime.getTime();
                dirty = true;
                continue;
            }

            const daysRemaining = Math.ceil((dueEnd.getTime() - nowTime.getTime()) / 86400000);
            try {
                await email.sendReminderEmail({ to: assignee.email, toName: assignee.name || assignee.email, task, daysRemaining, baseUrl });
            } catch (e) {
                console.error('[SCHEDULER] Reminder email error:', e.message);
            }
            task.reminderSentAt = nowTime.getTime();
            task.updatedAt = Date.now();
            dirty = true;
            sent++;
        }
    }

    if (dirty) saveOpsTasks();
    return { sent };
}

// ── Phase 3: Escalation ─────────────────────────────────────────────────────
// Notify superiors when a task remains overdue past the wait window.
// Escalation is notification-only — it never changes task permissions or status.
// Idempotent: task.escalationLevel + task.escalationSentAt prevent re-sending.
async function processEscalation(stores, savers, email, now) {
    const { opsTasksStore, opsUsersStore, opsPrefsStore } = stores;
    const { saveOpsTasks } = savers;
    const nowTime = now instanceof Date ? now : new Date(now || Date.now());
    const baseUrl = process.env.APP_BASE_URL || '';
    let escalated = 0;
    let dirty = false;

    for (const companyId of Object.keys(opsTasksStore || {})) {
        const companyUsers = opsUsersStore[companyId] || [];

        for (const task of (opsTasksStore[companyId] || [])) {
            if (task.status === 'COMPLETED' || task.status === 'CANCELLED') continue;
            if (!task.escalation || !task.escalation.enabled) continue;
            if (!task.dueDate) continue;

            const dueEnd = new Date(task.dueDate + 'T23:59:59');
            if (nowTime <= dueEnd) continue; // not yet overdue

            const waitHoursAfterDue     = Number((task.escalation || {}).waitHoursAfterDue) || 24;
            const waitHoursBetweenLevels = Number((task.escalation || {}).waitHoursBetweenLevels) || 24;
            const escalationStart       = new Date(dueEnd.getTime() + waitHoursAfterDue * 3600000);
            if (nowTime < escalationStart) continue;

            const targets = resolveEscalationTargets(task, companyUsers);
            if (!targets.length) continue;

            const assignee     = companyUsers.find(u => u.id === task.assigneeId);
            const assigneeName = assignee ? (assignee.name || assignee.email) : (task.assigneeName || 'Unknown');
            const currentLevel = task.escalationLevel || 0;

            if (currentLevel === 0) {
                // First escalation: notify targets[0]
                const target = targets[0];
                if (!target) continue;

                const prefs = getUserPrefs(opsPrefsStore, companyId, target.id);
                if (prefs.escalationEmails) {
                    try {
                        await email.sendEscalationEmail({ to: target.email, toName: target.name || target.email, task, assigneeName, level: 1, baseUrl });
                    } catch (e) { console.error('[SCHEDULER] Escalation email error:', e.message); }
                    escalated++;
                }
                task.escalationLevel    = 1;
                task.escalationSentAt   = nowTime.getTime();
                task.escalationNotified = [target.id];
                task.updatedAt = Date.now();
                dirty = true;

            } else {
                // Subsequent levels: check if enough time has elapsed since last escalation
                if (!task.escalationSentAt) continue;
                const nextTime = new Date(task.escalationSentAt + waitHoursBetweenLevels * 3600000);
                if (nowTime < nextTime) continue;

                const nextTarget = targets[currentLevel]; // targets is 0-indexed
                if (!nextTarget) continue; // no more levels

                const prefs = getUserPrefs(opsPrefsStore, companyId, nextTarget.id);
                const level = currentLevel + 1;
                if (prefs.escalationEmails) {
                    try {
                        await email.sendEscalationEmail({ to: nextTarget.email, toName: nextTarget.name || nextTarget.email, task, assigneeName, level, baseUrl });
                    } catch (e) { console.error('[SCHEDULER] Escalation email error:', e.message); }
                    escalated++;
                }
                task.escalationLevel    = level;
                task.escalationSentAt   = nowTime.getTime();
                task.escalationNotified = [...(task.escalationNotified || []), nextTarget.id];
                task.updatedAt = Date.now();
                dirty = true;
            }
        }
    }

    if (dirty) saveOpsTasks();
    return { escalated };
}

// ── Phase 4: Daily digest ────────────────────────────────────────────────────
// Send one summary email per opted-in user per day.
// Idempotent: opsPrefsStore[co].users[uid].lastDigestSentDate prevents double-sending.
async function processDailyDigest(stores, savers, email, now) {
    const { opsTasksStore, opsUsersStore, opsPrefsStore } = stores;
    const { saveOpsPrefs } = savers;
    const nowTime  = now instanceof Date ? now : new Date(now || Date.now());
    const todayStr = opsRecurring.dateStr(nowTime);
    const baseUrl  = process.env.APP_BASE_URL || '';
    let sent  = 0;
    let dirty = false;

    for (const companyId of Object.keys(opsUsersStore || {})) {
        const companyTasks = opsTasksStore[companyId] || [];

        for (const user of (opsUsersStore[companyId] || [])) {
            if (user.status !== 'ACTIVE' || !user.email) continue;

            const prefs = getUserPrefs(opsPrefsStore, companyId, user.id);
            if (!prefs.dailyDigest) continue;

            // Check last-sent date
            const coPrefs   = (opsPrefsStore || {})[companyId] || {};
            const userRec   = (coPrefs.users || {})[user.id] || {};
            if (userRec.lastDigestSentDate === todayStr) continue;

            // Build digest
            const mine    = companyTasks.filter(t => t.assigneeId === user.id && t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
            const today   = mine.filter(t => t.dueDate === todayStr);
            const late    = mine.filter(t => t.dueDate && t.dueDate < todayStr);
            const urgent  = mine.filter(t => t.priority === 'URGENT');
            const recurring = companyTasks.filter(t => t.templateId && t.occurrenceKey && t.occurrenceKey.endsWith('_' + todayStr) && t.assigneeId === user.id);

            try {
                await email.sendDailyDigestEmail({
                    to:      user.email,
                    toName:  user.name || user.email,
                    digest:  { today, late, urgent, recurring },
                    baseUrl,
                });
                sent++;
            } catch (e) {
                console.error('[SCHEDULER] Digest email error:', e.message);
            }

            // Mark as sent today regardless of email outcome (prevent retry spam)
            if (!opsPrefsStore[companyId]) opsPrefsStore[companyId] = { defaults: DEFAULT_PREFS(), users: {} };
            if (!opsPrefsStore[companyId].users) opsPrefsStore[companyId].users = {};
            if (!opsPrefsStore[companyId].users[user.id]) opsPrefsStore[companyId].users[user.id] = {};
            opsPrefsStore[companyId].users[user.id].lastDigestSentDate = todayStr;
            dirty = true;
        }
    }

    if (dirty) saveOpsPrefs();
    return { sent };
}

// ── Scheduler factory ────────────────────────────────────────────────────────
// `getStores`    — () → { opsTasksStore, opsUsersStore, opsTemplatesStore, opsPrefsStore }
// `getSavers`    — () → { saveOpsTasks, saveOpsTemplates, saveOpsPrefs }
// `email`        — ops-email module (sendReminderEmail, sendEscalationEmail, sendDailyDigestEmail)
// `addHistoryFn` — server.js addHistory(task, type, actorId, actorName, data)
function createScheduler(getStores, getSavers, email, addHistoryFn) {
    async function run({ now } = {}) {
        const stores  = getStores();
        const savers  = getSavers();
        const nowDate = now instanceof Date ? now : (now ? new Date(now) : undefined);

        const opts = nowDate ? { now: nowDate } : {};

        try { await processRecurring(stores, savers, addHistoryFn); } catch (e) { console.error('[SCHEDULER] recurring error:', e.message); }
        try { await processReminders(stores, savers, email, opts.now); } catch (e) { console.error('[SCHEDULER] reminders error:', e.message); }
        try { await processEscalation(stores, savers, email, opts.now); } catch (e) { console.error('[SCHEDULER] escalation error:', e.message); }
        try { await processDailyDigest(stores, savers, email, opts.now); } catch (e) { console.error('[SCHEDULER] digest error:', e.message); }
    }

    return { run };
}

module.exports = {
    createScheduler,
    getEscalationChain,
    resolveEscalationTargets,
    getUserPrefs,
    getCompanyPrefs,
    DEFAULT_PREFS,
    // Export individual phases for unit testing
    processRecurring,
    processReminders,
    processEscalation,
    processDailyDigest,
};
