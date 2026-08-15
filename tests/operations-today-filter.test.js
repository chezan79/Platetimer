'use strict';
// ── Regression tests for the "Compiti della giornata" today filter ────────────
// Tests the pure applyTodayFilter() logic (mirrors operations-tasks.html) plus
// URL param parsing behaviour. No DOM or server required.

let _n = 0, _fail = 0;
function check(label, ok, detail) {
    _n++;
    if (ok) {
        console.log(`  ✅ TF-${_n}. ${label}`);
    } else {
        console.error(`  ❌ FAIL TF-${_n}. ${label}`, detail !== undefined ? detail : '');
        _fail++;
    }
}

// ── Pure filter function (exact copy from operations-tasks.html) ──────────────
// Any change to the function in the HTML must be mirrored here.
function applyTodayFilter(tasks, nowMs) {
    const now = nowMs !== undefined ? new Date(nowMs) : new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const cutoff = endOfToday.getTime();
    return tasks.filter(task => {
        if (!task.dueDate) return false;
        if (task.status === 'COMPLETED' || task.status === 'CANCELLED') return false;
        const due = new Date(task.dueDate).getTime();
        return !isNaN(due) && due <= cutoff;
    });
}

// ── Reference timestamps ──────────────────────────────────────────────────────
// Use a fixed noon-local reference to avoid midnight-boundary flakiness across
// timezones. We drive all due-date strings from offsets relative to NOW so the
// local calendar date of NOW is what the filter uses as "today".
const DAY = 24 * 60 * 60 * 1000;
// Build a Date at local noon on a well-known date far in the past to keep tests
// deterministic regardless of when they run.
const _ref = new Date(2026, 7, 15, 12, 0, 0, 0); // 2026-08-15 noon local
const NOW  = _ref.getTime();

// Helper to build ISO strings relative to NOW
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

// Task factory
function mkTask(overrides) {
    return { id: 't1', title: 'Task', status: 'OPEN', dueDate: null, ...overrides };
}

// ── T1: tasks with no dueDate are always excluded ─────────────────────────────
console.log('\n  — no dueDate —\n');
{
    const r = applyTodayFilter([mkTask({ id: 't-noduedate', dueDate: null })], NOW);
    check('no dueDate → excluded', r.length === 0, r.length);
}

// ── T2–T3: completed and cancelled tasks excluded even if due today ────────────
console.log('\n  — completed / cancelled excluded —\n');
{
    const due = iso(0); // exactly NOW = today
    const r = applyTodayFilter([
        mkTask({ id: 't-completed', status: 'COMPLETED', dueDate: due }),
        mkTask({ id: 't-cancelled', status: 'CANCELLED', dueDate: due }),
    ], NOW);
    check('COMPLETED due today → excluded', !r.find(t => t.id === 't-completed'));
    check('CANCELLED due today → excluded', !r.find(t => t.id === 't-cancelled'));
}

// ── T4: OPEN task due today is included ───────────────────────────────────────
console.log('\n  — due today —\n');
{
    const r = applyTodayFilter([mkTask({ id: 't-open-today', dueDate: iso(0) })], NOW);
    check('OPEN task due today → included', r.length === 1 && r[0].id === 't-open-today');
}

// ── T5: IN_PROGRESS task due today is included ────────────────────────────────
{
    const r = applyTodayFilter([mkTask({ id: 't-inp-today', status: 'IN_PROGRESS', dueDate: iso(0) })], NOW);
    check('IN_PROGRESS task due today → included', r.length === 1);
}

// ── T6: OVERDUE task (due 3 days ago, OPEN) is included ──────────────────────
console.log('\n  — overdue —\n');
{
    const r = applyTodayFilter([mkTask({ id: 't-overdue', status: 'OVERDUE', dueDate: iso(-3 * DAY) })], NOW);
    check('OVERDUE (status) task → included', r.find(t => t.id === 't-overdue') !== undefined);
}

// ── T7: OPEN task with past dueDate (overdue by dueDate, status still OPEN) ───
{
    const r = applyTodayFilter([mkTask({ id: 't-open-overdue', dueDate: iso(-2 * DAY) })], NOW);
    check('OPEN task with past dueDate → included (overdue)', r.length === 1);
}

// ── T8: future task excluded ──────────────────────────────────────────────────
console.log('\n  — future excluded —\n');
{
    const r = applyTodayFilter([mkTask({ id: 't-future', dueDate: iso(2 * DAY) })], NOW);
    check('Task due in 2 days → excluded', r.length === 0, r.length);
}

// ── T9: task due tomorrow (start of tomorrow) excluded ───────────────────────
{
    // Start of tomorrow = end of today + 1ms
    const startOfTomorrow = new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), new Date(NOW).getDate() + 1, 0, 0, 0, 0).getTime();
    const r = applyTodayFilter([mkTask({ id: 't-tomorrow', dueDate: new Date(startOfTomorrow).toISOString() })], NOW);
    check('Task due at start of tomorrow → excluded', r.length === 0, r.length);
}

// ── T10: task due at end of today (23:59:59.999) included ────────────────────
{
    const endOfToday = new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), new Date(NOW).getDate(), 23, 59, 59, 999).getTime();
    const r = applyTodayFilter([mkTask({ id: 't-endofday', dueDate: new Date(endOfToday).toISOString() })], NOW);
    check('Task due at 23:59:59.999 today → included', r.length === 1, r.length);
}

// ── T11: mixed set — overdue, today, future, completed ───────────────────────
console.log('\n  — mixed set —\n');
{
    const tasks = [
        mkTask({ id: 'overdue',    dueDate: iso(-5 * DAY) }),                              // ✓ included
        mkTask({ id: 'today',      dueDate: iso(0) }),                                     // ✓ included
        mkTask({ id: 'future',     dueDate: iso(3 * DAY) }),                               // ✗ excluded
        mkTask({ id: 'completed',  dueDate: iso(0), status: 'COMPLETED' }),                // ✗ excluded
        mkTask({ id: 'cancelled',  dueDate: iso(-1 * DAY), status: 'CANCELLED' }),         // ✗ excluded
        mkTask({ id: 'no-due',     dueDate: null }),                                       // ✗ excluded
        mkTask({ id: 'inp-today',  dueDate: iso(-1 * DAY), status: 'IN_PROGRESS' }),       // ✓ included
    ];
    const r = applyTodayFilter(tasks, NOW);
    const ids = r.map(t => t.id).sort();
    check('mixed: 3 included (overdue, today, inp-today)', r.length === 3, r.length);
    check('mixed: overdue included', ids.includes('overdue'));
    check('mixed: today included',   ids.includes('today'));
    check('mixed: inp-today included', ids.includes('inp-today'));
    check('mixed: future excluded',    !ids.includes('future'));
    check('mixed: completed excluded', !ids.includes('completed'));
    check('mixed: cancelled excluded', !ids.includes('cancelled'));
    check('mixed: no-due excluded',    !ids.includes('no-due'));
}

// ── T12: empty input → empty output ──────────────────────────────────────────
console.log('\n  — edge cases —\n');
{
    const r = applyTodayFilter([], NOW);
    check('empty task list → empty result', r.length === 0);
}

// ── T13: invalid dueDate string → excluded ───────────────────────────────────
{
    const r = applyTodayFilter([mkTask({ dueDate: 'not-a-date' })], NOW);
    check('invalid dueDate string → excluded (NaN guard)', r.length === 0);
}

// ── T14: multiple tasks all today — all returned, order preserved ─────────────
{
    const tasks = [
        mkTask({ id: 'a', dueDate: iso(0) }),
        mkTask({ id: 'b', dueDate: iso(-1 * DAY) }),
        mkTask({ id: 'c', dueDate: iso(-2 * DAY) }),
    ];
    const r = applyTodayFilter(tasks, NOW);
    check('three today/overdue tasks → all three returned', r.length === 3, r.length);
    check('order preserved: first returned is "a"', r[0].id === 'a');
}

// ── T15: URL param parsing — ?filter=today is recognised ─────────────────────
console.log('\n  — URL param parsing —\n');
{
    // URLSearchParams is available in Node.js ≥ 10
    const params1 = new URLSearchParams('filter=today');
    check('?filter=today detected', params1.get('filter') === 'today');
    const params2 = new URLSearchParams('filter=today&taskId=123');
    check('?filter=today with other params detected', params2.get('filter') === 'today');
    check('?filter=today with other params: taskId accessible', params2.get('taskId') === '123');
}

// ── T16: URL param parsing — other filter values not confused with today ───────
{
    const params = new URLSearchParams('filter=overdue');
    check('?filter=overdue is not the today filter', params.get('filter') !== 'today');
}

// ── T17: URL param absent — todayFilterActive stays false ────────────────────
{
    const params = new URLSearchParams('taskId=abc');
    check('no filter param → get("filter") is null', params.get('filter') === null);
}

// ── T18: applyTodayFilter without nowMs uses current time (smoke test) ────────
{
    // Just verify the function runs without nowMs (uses live Date.now()).
    // Task due a week ago should be included if status is OPEN.
    const r = applyTodayFilter([mkTask({ id: 'smoke', dueDate: iso(-7 * DAY) })]);
    // This should always pass as long as 2026-08-08 < today (test written 2026-08-15)
    check('no nowMs arg: overdue task still included', r.length === 1);
}

// ── Summary ───────────────────────────────────────────────────────────────────
const total = _n;
const passed = total - _fail;
console.log(`\n${total} total — ${passed} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
