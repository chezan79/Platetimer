// operations-calendar-core.js — pure Day/Week/Month window & grouping logic
// for the Operations planning calendar (Task 57).
//
// Single source of truth shared by public/operations-calendar.html (browser)
// and tests/operations-calendar.test.js (Node require).
//
// Timezone contract:
//   * All window math is done in the LOCAL timezone using calendar-date
//     constructors (never fixed 86400000 ms steps), so windows stay correct
//     across DST transitions.
//   * The API is queried with offset-bearing ISO instants
//     (Date.prototype.toISOString on the local window bounds), so the server
//     compares instants and never re-interprets bare dates as UTC.
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api; // Node (tests)
    else root.OpsCalCore = api;                                             // browser
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Local midnight of d's calendar date.
    function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

    // Calendar-date addition — DST-safe (23h/25h days handled by the Date ctor).
    function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()); }

    // Inclusive local window for a view around an anchor date.
    // { start: Date (local 00:00 of first day), end: Date (local 23:59:59.999 of last day) }
    function calWindow(view, anchorDate) {
        const a = startOfDay(anchorDate);
        if (view === 'day') return { start: a, end: new Date(addDays(a, 1).getTime() - 1) };
        if (view === 'week') {
            const dow = (a.getDay() + 6) % 7; // Monday-based
            const start = addDays(a, -dow);
            return { start, end: new Date(addDays(start, 7).getTime() - 1) };
        }
        // month
        const start = new Date(a.getFullYear(), a.getMonth(), 1);
        return { start, end: new Date(new Date(a.getFullYear(), a.getMonth() + 1, 1).getTime() - 1) };
    }

    // Local calendar-date key yyyy-mm-dd.
    function dateKey(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // Group tasks by the LOCAL calendar date of their dueDate.
    function groupTasksByDate(tasks) {
        const map = {};
        for (const tk of tasks || []) {
            if (!tk.dueDate) continue;
            const d = new Date(tk.dueDate);
            if (isNaN(d.getTime())) continue;
            const k = dateKey(d);
            (map[k] = map[k] || []).push(tk);
        }
        return map;
    }

    function taskDetailUrl(taskId) {
        return 'operations-tasks.html?taskId=' + encodeURIComponent(taskId);
    }

    // Offset-bearing ISO instants for the API query (server compares instants).
    function windowQuery(win) {
        return { start: win.start.toISOString(), end: new Date(win.end).toISOString() };
    }

    return { startOfDay, addDays, calWindow, dateKey, groupTasksByDate, taskDetailUrl, windowQuery };
}));
