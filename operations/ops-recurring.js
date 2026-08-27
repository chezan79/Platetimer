'use strict';
// operations/ops-recurring.js
// Recurring task template model and occurrence generation engine.
// All generation is idempotent — occurrenceKey prevents duplicates across server restarts.

const crypto = require('crypto');

// ── Constants ───────────────────────────────────────────────────────────────
const VALID_FREQUENCIES = [
    'DAILY',
    'WEEKLY',
    'MONTHLY',
    'EVERY_X_DAYS',
    'EVERY_X_WEEKS',
    'EVERY_X_MONTHS'
];

// ── ID helpers ──────────────────────────────────────────────────────────────
function genTemplateId() {
    return 'opstpl_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

// Build the deterministic dedup key for one occurrence of a template on a given date.
// If a task with this key already exists in the store the occurrence is skipped.
function occurrenceKey(templateId, ds) { // ds = 'YYYY-MM-DD'
    return `${templateId}_${ds}`;
}

// ── Date helpers (local-time; avoids UTC-offset surprises for restaurant schedules) ──
function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
}

function dateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function parseLocalDate(str) {
    // 'YYYY-MM-DD' → local midnight; avoids UTC-offset shifting the day.
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function calendarDayDiff(from, to) {
    const fromUtc = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
    const toUtc = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.floor((toUtc - fromUtc) / (24 * 3600 * 1000));
}

// ── Template validation ─────────────────────────────────────────────────────
function validateTemplateInput(body) {
    const errors = [];
    const serviceDepartmentId = body.serviceDepartmentId;
    if (!body.title || typeof body.title !== 'string' || !body.title.trim())
        errors.push('title obbligatorio');
    if (!VALID_FREQUENCIES.includes(body.frequency))
        errors.push(`frequency deve essere uno di: ${VALID_FREQUENCIES.join(', ')}`);
    if (['EVERY_X_DAYS', 'EVERY_X_WEEKS', 'EVERY_X_MONTHS'].includes(body.frequency)) {
        const iv = Number(body.interval);
        if (!Number.isInteger(iv) || iv < 1 || iv > 365)
            errors.push('interval deve essere 1-365');
    }
    if (!body.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate))
        errors.push('startDate obbligatorio (YYYY-MM-DD)');
    if (body.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate))
        errors.push('endDate deve essere YYYY-MM-DD');
    if (body.maxOccurrences !== undefined && body.maxOccurrences !== null) {
        const mo = Number(body.maxOccurrences);
        if (!Number.isInteger(mo) || mo < 1)
            errors.push('maxOccurrences deve essere un intero positivo');
    }
    if (body.daysOfWeek !== undefined) {
        if (!Array.isArray(body.daysOfWeek) ||
            body.daysOfWeek.some(d => !Number.isInteger(Number(d)) || Number(d) < 0 || Number(d) > 6))
            errors.push('daysOfWeek deve essere un array di interi 0-6');
    }
    if (body.dayOfMonth !== undefined && body.dayOfMonth !== null) {
        const dom = Number(body.dayOfMonth);
        if (!Number.isInteger(dom) || dom < 1 || dom > 31)
            errors.push('dayOfMonth deve essere 1-31');
    }
    if (body.workSchedule !== undefined) {
        if (!Array.isArray(body.workSchedule) ||
            body.workSchedule.some(d => !Number.isInteger(Number(d)) || Number(d) < 0 || Number(d) > 6))
            errors.push('workSchedule deve essere un array di interi 0-6');
    }
    if (serviceDepartmentId !== undefined && serviceDepartmentId !== null &&
        typeof serviceDepartmentId !== 'string' && typeof serviceDepartmentId !== 'number') {
        errors.push('serviceDepartmentId non valido');
    }
    return errors;
}

const OPS_PRIORITIES_TPL = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

function sanitizeTemplateInput(body) {
    return {
        title:              String(body.title || '').trim().slice(0, 200),
        description:        String(body.description || '').trim().slice(0, 2000),
        priority:           OPS_PRIORITIES_TPL.includes(body.priority) ? body.priority : 'MEDIUM',
        department:         typeof body.department === 'string' ? body.department.trim().slice(0, 100) : '',
        // Canonical Service department identity. The display name is derived by
        // server.js after validating this ID against the authenticated company.
        serviceDepartmentId: body.serviceDepartmentId
            ? String(body.serviceDepartmentId).trim().slice(0, 120)
            : null,
        notes:              String(body.notes || '').trim().slice(0, 5000),
        defaultAssigneeId:  typeof body.defaultAssigneeId === 'string' ? body.defaultAssigneeId : null,
        frequency:          body.frequency,
        interval:           Math.max(1, Number(body.interval) || 1),
        daysOfWeek:         Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map(Number) : [],
        dayOfMonth:         body.dayOfMonth != null ? Number(body.dayOfMonth) : null,
        startDate:          body.startDate,
        endDate:            body.endDate || null,
        maxOccurrences:     body.maxOccurrences != null ? Number(body.maxOccurrences) : null,
        workSchedule:       Array.isArray(body.workSchedule) ? body.workSchedule.map(Number) : [0,1,2,3,4,5,6],
        defaultReminderDays: body.defaultReminderDays != null ? Number(body.defaultReminderDays) : null,
        defaultEscalation:  body.defaultEscalation === true,
    };
}

// Patch sanitizer — only returns fields that were present in body.
function sanitizeTemplatePatch(body) {
    const out = {};
    if (body.title !== undefined) { const t = String(body.title).trim(); if (!t) throw 'Titolo obbligatorio.'; if (t.length > 200) throw 'Titolo troppo lungo.'; out.title = t; }
    if (body.description !== undefined) out.description = String(body.description).trim().slice(0, 2000);
    if (body.notes !== undefined) out.notes = String(body.notes).trim().slice(0, 5000);
    if (body.priority !== undefined) { if (!OPS_PRIORITIES_TPL.includes(body.priority)) throw 'Priorità non valida.'; out.priority = body.priority; }
    if (body.department !== undefined) out.department = String(body.department || '').trim().slice(0, 100);
    if (body.serviceDepartmentId !== undefined) {
        if (body.serviceDepartmentId !== null && typeof body.serviceDepartmentId !== 'string' && typeof body.serviceDepartmentId !== 'number')
            throw 'serviceDepartmentId non valido.';
        out.serviceDepartmentId = body.serviceDepartmentId ? String(body.serviceDepartmentId).trim().slice(0, 120) : null;
    }
    if (body.defaultAssigneeId !== undefined) out.defaultAssigneeId = body.defaultAssigneeId || null;
    if (body.startDate !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) throw 'startDate non valido.'; out.startDate = body.startDate; }
    if (body.endDate !== undefined) out.endDate = body.endDate || null;
    if (body.maxOccurrences !== undefined) out.maxOccurrences = body.maxOccurrences != null ? Number(body.maxOccurrences) : null;
    if (body.workSchedule !== undefined) out.workSchedule = Array.isArray(body.workSchedule) ? body.workSchedule.map(Number) : [0,1,2,3,4,5,6];
    if (body.daysOfWeek !== undefined) out.daysOfWeek = Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map(Number) : [];
    if (body.dayOfMonth !== undefined) out.dayOfMonth = body.dayOfMonth != null ? Number(body.dayOfMonth) : null;
    if (body.defaultReminderDays !== undefined) out.defaultReminderDays = body.defaultReminderDays != null ? Number(body.defaultReminderDays) : null;
    if (body.defaultEscalation !== undefined) out.defaultEscalation = body.defaultEscalation === true;
    return out;
}

// ── Occurrence date calculation ─────────────────────────────────────────────
// Returns sorted array of 'YYYY-MM-DD' strings for dates that should have
// tasks generated, from template.startDate up to (and including) `upTo`.
// Idempotent: calling multiple times returns the same set.
function getOccurrenceDates(template, upTo, fromDate) {
    const upToDate = upTo instanceof Date ? upTo : new Date(upTo || Date.now());
    // Use end of day so a task due "today" is always generated on the run that happens today.
    const ceiling = new Date(upToDate);
    ceiling.setHours(23, 59, 59, 999);

    const start    = parseLocalDate(template.startDate);
    const end      = template.endDate ? parseLocalDate(template.endDate) : null;
    const maxOcc   = (template.maxOccurrences && template.maxOccurrences > 0) ? template.maxOccurrences : Infinity;
    const requestedFloor = fromDate
        ? (fromDate instanceof Date ? new Date(fromDate) : parseLocalDate(fromDate))
        : null;
    const floor = requestedFloor && requestedFloor > start ? requestedFloor : start;
    // A lower-bound jump is safe only without maxOccurrences. With a finite cap,
    // the canonical count starts at template.startDate, so the existing full
    // walk is retained to preserve scheduler semantics exactly.
    const canJumpToFloor = !!requestedFloor && maxOcc === Infinity;
    const workdays = new Set(
        Array.isArray(template.workSchedule) && template.workSchedule.length > 0
            ? template.workSchedule
            : [0, 1, 2, 3, 4, 5, 6]
    );

    const dates = [];

    const freq = template.frequency;

    if (freq === 'DAILY') {
        // Every calendar day within workSchedule.
        let cur = new Date(canJumpToFloor ? floor : start);
        while (cur <= ceiling && dates.length < maxOcc) {
            if (end && cur > end) break;
            if (workdays.has(cur.getDay())) dates.push(dateStr(cur));
            cur = addDays(cur, 1);
        }

    } else if (freq === 'EVERY_X_DAYS') {
        const step = Math.max(1, template.interval || 1);
        const elapsed = canJumpToFloor ? Math.max(0, calendarDayDiff(start, floor)) : 0;
        let cur = addDays(start, Math.ceil(elapsed / step) * step);
        while (cur <= ceiling && dates.length < maxOcc) {
            if (end && cur > end) break;
            if (workdays.has(cur.getDay())) dates.push(dateStr(cur));
            cur = addDays(cur, step);
        }

    } else if (freq === 'WEEKLY' || freq === 'EVERY_X_WEEKS') {
        const weekStep = (freq === 'WEEKLY' ? 1 : Math.max(1, template.interval || 1)) * 7;
        // Which days of the week to generate (default: day of startDate)
        const targetDays = (Array.isArray(template.daysOfWeek) && template.daysOfWeek.length > 0)
            ? new Set(template.daysOfWeek.map(Number))
            : new Set([start.getDay()]);

        // Anchor the week iteration on the Sunday of the start date's week.
        const anchorSunday = addDays(start, -start.getDay());
        let weekCur = new Date(anchorSunday);
        if (canJumpToFloor) {
            const elapsed = Math.max(0, calendarDayDiff(anchorSunday, floor));
            const periods = Math.floor(elapsed / weekStep);
            weekCur = addDays(anchorSunday, periods * weekStep);
            if (addDays(weekCur, 6) < floor) weekCur = addDays(weekCur, weekStep);
        }

        outer: while (weekCur <= ceiling && dates.length < maxOcc) {
            for (let d = 0; d < 7; d++) {
                const day = addDays(weekCur, d);
                if (day < start) continue;
                if (canJumpToFloor && day < floor) continue;
                if (day > ceiling) break outer;
                if (end && day > end) break outer;
                if (!targetDays.has(day.getDay())) continue;
                if (!workdays.has(day.getDay())) continue;
                dates.push(dateStr(day));
                if (dates.length >= maxOcc) break outer;
            }
            weekCur = addDays(weekCur, weekStep);
        }
        dates.sort(); // already sorted but guard against out-of-order pushes

    } else if (freq === 'MONTHLY' || freq === 'EVERY_X_MONTHS') {
        const monthStep = freq === 'MONTHLY' ? 1 : Math.max(1, template.interval || 1);
        const dom = (template.dayOfMonth != null) ? Number(template.dayOfMonth) : start.getDate();

        let year  = start.getFullYear();
        let month = start.getMonth(); // 0-based
        if (canJumpToFloor) {
            const elapsedMonths = Math.max(
                0,
                (floor.getFullYear() - year) * 12 + floor.getMonth() - month
            );
            const periods = Math.floor(elapsedMonths / monthStep);
            month += periods * monthStep;
            year += Math.floor(month / 12);
            month %= 12;
        }

        while (dates.length < maxOcc) {
            // new Date(year, month, dom) will roll over if dom > last-day-of-month.
            // We detect that by checking candidate.getDate() === dom.
            const candidate = new Date(year, month, dom);
            if (isNaN(candidate.getTime())) break;
            if (candidate.getDate() !== dom) { // month rollover guard
                month += monthStep;
                year  += Math.floor(month / 12);
                month  = month % 12;
                continue;
            }
            if (candidate > ceiling) break;
            if (end && candidate > end) break;
            if (candidate >= start &&
                (!canJumpToFloor || candidate >= floor) &&
                workdays.has(candidate.getDay())) {
                dates.push(dateStr(candidate));
            }
            month += monthStep;
            year  += Math.floor(month / 12);
            month  = month % 12;
        }
    }

    return dates;
}

// Returns only the canonical occurrences inside an inclusive date-only window.
// This deliberately delegates recurrence semantics to getOccurrenceDates so
// projection reads cannot drift from scheduler generation. It does not create
// tasks or occurrence keys; the caller may use occurrenceKey only in memory
// when comparing against already-generated tasks.
function getOccurrenceDatesInRange(template, rangeStart, rangeEnd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rangeStart || '')) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(rangeEnd || '')) ||
        String(rangeStart) > String(rangeEnd)) {
        return [];
    }
    if (template.maxOccurrences) {
        const start = parseLocalDate(template.startDate);
        const finish = parseLocalDate(rangeEnd);
        const elapsedDays = Math.max(0, calendarDayDiff(start, finish));
        const interval = Math.max(1, Number(template.interval) || 1);
        let estimatedSteps;
        if (template.frequency === 'WEEKLY' || template.frequency === 'EVERY_X_WEEKS') {
            estimatedSteps = Math.ceil(elapsedDays / (7 * interval)) * 7;
        } else if (template.frequency === 'MONTHLY' || template.frequency === 'EVERY_X_MONTHS') {
            const elapsedMonths = Math.max(
                0,
                (finish.getFullYear() - start.getFullYear()) * 12 +
                finish.getMonth() - start.getMonth()
            );
            estimatedSteps = Math.ceil(elapsedMonths / interval);
        } else {
            estimatedSteps = Math.ceil(elapsedDays / interval);
        }
        if (estimatedSteps > 10000) {
            throw new RangeError('Recurring projection exceeds its computation budget');
        }
    }
    const dates = getOccurrenceDates(
        template,
        parseLocalDate(rangeEnd),
        template.maxOccurrences ? null : parseLocalDate(rangeStart)
    );
    return dates.filter(ds => ds >= rangeStart && ds <= rangeEnd);
}

// ── Task generation ─────────────────────────────────────────────────────────
// Returns an array of NEW task objects that are missing from the store.
// `existingKeysSet` = Set of occurrenceKey strings already persisted.
// `addHistoryFn`    = server.js `addHistory` — keeps history write in one place.
function generateTasksForTemplate(template, companyId, existingKeysSet, usersById, addHistoryFn) {
    const now  = new Date();
    const dates = getOccurrenceDates(template, now);

    const assigneeId   = template.defaultAssigneeId || null;
    const assigneeUser = (assigneeId && usersById) ? (usersById[assigneeId] || null) : null;
    // Skip generation if the template's default assignee no longer exists or is inactive
    if (assigneeId && (!assigneeUser || assigneeUser.status !== 'ACTIVE')) {
        // Still generate but with no assignee (Director can reassign later)
    }

    const newTasks = [];
    for (const ds of dates) {
        const key = occurrenceKey(template.id, ds);
        if (existingKeysSet.has(key)) continue; // idempotent guard

        const ts = Date.now();
        const task = {
            id:               'opst_' + ts + '_' + crypto.randomBytes(3).toString('hex'),
            companyId,
            title:            template.title,
            description:      template.description || '',
            priority:         template.priority || 'MEDIUM',
            department:       template.department || '',
            serviceDepartmentId:   template.serviceDepartmentId ?? null,
            serviceDepartmentName: template.serviceDepartmentName ?? null,
            publishToService:      template.publishToService === true,
            notes:            template.notes || '',
            status:           'OPEN',
            assigneeId:       assigneeId,
            assigneeName:     assigneeUser ? (assigneeUser.name || assigneeUser.email || assigneeId) : null,
            createdBy:        template.createdBy,
            createdByName:    template.createdByName || 'Sistema',
            dueDate:          ds,
            completionPercent: 0,
            startedAt:        null,
            completedAt:      null,
            createdAt:        ts,
            updatedAt:        ts,
            attachments:      [],
            comments:         [],
            history:          [],
            // Recurring metadata
            templateId:       template.id,
            occurrenceKey:    key,
            // Reminder / escalation — inherit from template defaults
            reminderDays:     template.defaultReminderDays || null,
            reminderSentAt:   null,
            escalation: {
                enabled:                template.defaultEscalation || false,
                waitHoursAfterDue:      24,
                waitHoursBetweenLevels: 24,
            },
            escalationLevel:    0,
            escalationSentAt:   null,
            escalationNotified: [],
        };

        if (typeof addHistoryFn === 'function') {
            addHistoryFn(task, 'TASK_CREATED', template.createdBy, template.createdByName || 'Sistema', {
                source:      'recurring',
                templateId:  template.id,
                occurrence:  ds,
            });
        }
        newTasks.push(task);
    }
    return newTasks;
}

module.exports = {
    genTemplateId,
    occurrenceKey,
    dateStr,
    parseLocalDate,
    addDays,
    VALID_FREQUENCIES,
    validateTemplateInput,
    sanitizeTemplateInput,
    sanitizeTemplatePatch,
    getOccurrenceDates,
    getOccurrenceDatesInRange,
    generateTasksForTemplate,
};
