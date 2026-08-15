#!/usr/bin/env node
'use strict';
// Non-UTC timezone contract: the "browser" (this test process) runs in
// Pacific/Auckland (UTC+12/+13 with DST) while the spawned server runs in UTC.
// Must be set before any Date usage.
process.env.TZ = 'Pacific/Auckland';
// tests/operations-calendar.test.js — Task 57: Operations planning calendar.
//
// Covers:
//   (a) start/end date-range filter on GET /api/operations/tasks and
//       Day/Week/Month window placement (pure calWindow/groupTasksByDate logic
//       mirrored from public/operations-calendar.html)
//   (b) role visibility: Director sees all; Sous Chef / Chef de Brigade only theirs
//   (c) company isolation: company A tasks never appear for company B
//   (d) completing / reassigning a task is reflected in the next list response
//   (e) zero interaction with the Service calendar (/api/calendar/*) — the
//       Service calendar data file stays untouched
//
// Run: node tests/operations-calendar.test.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SECRET = 'test-secret-task57';
const PORT = 5089;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstest57-'));

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({ uid, companyName, iat: Date.now(), exp: Date.now() + 3600000 })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}
function mockFb(user) { return 'mockfb.' + Buffer.from(JSON.stringify(user)).toString('base64'); }

async function api(token, method, p, body) {
    const res = await fetch(BASE + p, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

// ── Pure calendar-window logic — the ACTUAL module the page uses (no mirror) ──
const { startOfDay, addDays, calWindow, dateKey, groupTasksByDate, taskDetailUrl, windowQuery } =
    require('../public/js/operations-calendar-core.js');

// ── Pure logic tests (no server) ──────────────────────────────────────────────
function pureTests() {
    console.log('── Pure Day/Week/Month placement logic ──');
    // Fixed anchor: Saturday 2026-08-15 noon local
    const anchor = new Date(2026, 7, 15, 12, 0, 0);

    const day = calWindow('day', anchor);
    check('P1. day window covers exactly the anchor date',
        dateKey(day.start) === '2026-08-15' && dateKey(new Date(day.end)) === '2026-08-15');

    const week = calWindow('week', anchor);
    check('P2. week window is Monday-based (Mon 10 Aug → Sun 16 Aug)',
        dateKey(week.start) === '2026-08-10' && dateKey(new Date(week.end)) === '2026-08-16',
        { s: dateKey(week.start), e: dateKey(new Date(week.end)) });
    check('P3. week window starts on Monday', week.start.getDay() === 1);

    const month = calWindow('month', anchor);
    check('P4. month window covers 1–31 Aug',
        dateKey(month.start) === '2026-08-01' && dateKey(new Date(month.end)) === '2026-08-31');

    // Monday anchor edge case
    const mon = calWindow('week', new Date(2026, 7, 10, 0, 30));
    check('P5. Monday anchor stays in its own week', dateKey(mon.start) === '2026-08-10');

    // Grouping
    const tasks = [
        { id: 'a', dueDate: new Date(2026, 7, 15, 9, 0).toISOString() },
        { id: 'b', dueDate: new Date(2026, 7, 15, 22, 30).toISOString() },
        { id: 'c', dueDate: new Date(2026, 7, 16, 0, 0).toISOString() },
        { id: 'd', dueDate: null },
        { id: 'e', dueDate: 'not-a-date' },
    ];
    const g = groupTasksByDate(tasks);
    check('P6. tasks grouped by local calendar date',
        (g['2026-08-15'] || []).length === 2 && (g['2026-08-16'] || []).length === 1, g);
    check('P7. tasks without/with invalid dueDate excluded from calendar',
        !Object.values(g).flat().some(t => t.id === 'd' || t.id === 'e'));

    // Detail navigation URL
    check('P8. task card links to operations-tasks.html?taskId=<id>',
        taskDetailUrl('opstask_x1') === 'operations-tasks.html?taskId=opstask_x1');
    check('P9. task detail URL is encoded', taskDetailUrl('a b&c') === 'operations-tasks.html?taskId=a%20b%26c');

    // ── Non-UTC + DST correctness (process TZ = Pacific/Auckland) ────────────
    console.log('── Non-UTC / DST window logic (Pacific/Auckland) ──');
    check('P10. test process really runs in a UTC+ timezone',
        new Date(2026, 0, 15).getTimezoneOffset() < 0, new Date(2026, 0, 15).getTimezoneOffset());

    // A task due 00:30 LOCAL falls on the previous UTC date — must still group
    // on its local calendar day.
    const early = new Date(2026, 7, 15, 0, 30); // 15 Aug 00:30 NZST = 14 Aug 12:30 UTC
    check('P11. 00:30-local task stays on its local day despite earlier UTC date',
        early.toISOString().startsWith('2026-08-14') &&
        (groupTasksByDate([{ id: 'x', dueDate: early.toISOString() }])['2026-08-15'] || []).length === 1);

    // Day window bounds sent to the API are offset-bearing instants covering
    // exactly the local day.
    const dayWin = calWindow('day', early);
    const q = windowQuery(dayWin);
    check('P12. day window query uses ISO instants (with Z), not bare dates',
        /Z$/.test(q.start) && /Z$/.test(q.end) && Date.parse(q.start) <= early.getTime() && Date.parse(q.end) >= early.getTime(), q);

    // NZ DST starts Sun 27 Sep 2026 (2am → 3am, a 23-hour day).
    // Week Mon 21 Sep – Sun 27 Sep contains the transition.
    const dstWeek = calWindow('week', new Date(2026, 8, 26, 18, 0)); // Sat 26 Sep
    check('P13. DST-transition week still starts Mon 21 Sep local',
        dateKey(dstWeek.start) === '2026-09-21' && dstWeek.start.getHours() === 0);
    check('P14. DST-transition week still ends Sun 27 Sep 23:59 local (not the next day)',
        dateKey(new Date(dstWeek.end)) === '2026-09-27' && new Date(dstWeek.end).getHours() === 23, dateKey(new Date(dstWeek.end)));
    check('P15. DST week is 7 calendar days but NOT 7×24h of ms',
        (dstWeek.end - dstWeek.start + 1) === 7 * 86400000 - 3600000, dstWeek.end - dstWeek.start + 1);

    // addDays across the transition lands on the next calendar day at same wall time.
    const beforeDst = new Date(2026, 8, 26, 12, 0);
    const afterDst = addDays(beforeDst, 2); // Mon 28 Sep
    check('P16. addDays across DST keeps wall-clock time',
        dateKey(afterDst) === '2026-09-28' && afterDst.getHours() === 12);

    // NZ DST ends Sun 5 Apr 2026 (25-hour day) — month window April still exact.
    const aprWin = calWindow('month', new Date(2026, 3, 15));
    check('P17. month window exact across fall-back DST day',
        dateKey(aprWin.start) === '2026-04-01' && dateKey(new Date(aprWin.end)) === '2026-04-30' && new Date(aprWin.end).getHours() === 23);
}

// ── Server tests ──────────────────────────────────────────────────────────────
async function main() {
    pureTests();

    console.log('\nStarting server (calendar tests)…');
    // Seed a Service calendar file so we can verify it is never touched.
    const svcCalPath = path.join(DATA_DIR, 'calendar-events.json');
    fs.writeFileSync(svcCalPath, JSON.stringify({}), 'utf8');
    const svcCalBefore = fs.readFileSync(svcCalPath, 'utf8');
    const svcCalMtime = fs.statSync(svcCalPath).mtimeMs;

    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(PORT), WS_SESSION_SECRET: SECRET, DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '', TEST_FIREBASE_AUTH_MOCK: '1',
            TZ: 'UTC' // server in UTC while this test process is Pacific/Auckland
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 20000);
        server.stdout.on('data', d => { if (d.toString().includes('avviato')) { clearTimeout(t); resolve(); } });
        server.on('exit', code => { clearTimeout(t); reject(new Error(`Server exited: ${code}`)); });
    });
    console.log('Server up. Running calendar checks…\n');

    try {
        // ── Setup: two companies ──
        const coA = 'cal-co-a', coB = 'cal-co-b';
        const dirA = sign('uid-cal-dirA', coA);
        const dirB = sign('uid-cal-dirB', coB);
        let r = await api(dirA, 'GET', '/api/operations/me?name=DirA');
        check('S0. Director A bootstrapped', r.data.success && r.data.user.role === 'DIRECTOR');
        const dirAId = r.data.user.id;
        r = await api(dirB, 'GET', '/api/operations/me?name=DirB');
        check('S1. Director B bootstrapped', r.data.success);

        async function invite(token, name, email, role) {
            const res = await api(token, 'POST', '/api/operations/users', { name, email, role });
            return res.data.user;
        }
        async function activate(uid, email, code) {
            const res = await api(mockFb({ localId: uid, email, emailVerified: true }), 'POST', '/api/operations/activate', { code });
            return res.data.success;
        }

        // Sous Chef + Chef de Brigade in company A, activated
        const scInv = await invite(dirA, 'Sara SC', 'sara@cal.test', 'SOUS_CHEF');
        const cdbInv = await invite(dirA, 'Carlo CdB', 'carlo@cal.test', 'CHEF_DE_BRIGADE');
        check('S2. SC + CdB invited', scInv && cdbInv && scInv.inviteCode && cdbInv.inviteCode);
        check('S3. SC activated', await activate('uid-cal-sc', 'sara@cal.test', scInv.inviteCode));
        check('S4. CdB activated', await activate('uid-cal-cdb', 'carlo@cal.test', cdbInv.inviteCode));
        const scTok = sign('uid-cal-sc', coA);
        const cdbTok = sign('uid-cal-cdb', coA);

        // ── Create tasks across dates (company A) ──
        // Fixed reference week: Mon 2026-08-10 … Sun 2026-08-16; month: August 2026.
        const mk = (title, assigneeId, dueDate) =>
            api(dirA, 'POST', '/api/operations/tasks', { title, assigneeId, dueDate, priority: 'MEDIUM' });

        const d = (day, h = 10) => new Date(2026, 7, day, h, 0, 0).toISOString();
        const tMon = (await mk('Cal Mon task', scInv.id, d(10))).data.task;       // in week
        const tSat = (await mk('Cal Sat task', cdbInv.id, d(15))).data.task;      // in week + day 15
        const tSun = (await mk('Cal Sun task', dirAId, d(16, 23))).data.task;     // last day of week
        const tJul = (await mk('Cal July task', dirAId, new Date(2026, 6, 31, 12).toISOString())).data.task; // outside month
        const tSep = (await mk('Cal Sept task', scInv.id, new Date(2026, 8, 1, 0, 30).toISOString())).data.task; // outside month
        const tNoDue = (await mk('Cal no-due task', dirAId, null)).data.task;     // never in calendar
        // The reviewer case: due 00:30 LOCAL on Sat 15 → previous UTC date on the (UTC) server
        const tEarly = (await mk('Cal early Sat task', dirAId, new Date(2026, 7, 15, 0, 30).toISOString())).data.task;
        check('S5. seven tasks created', tMon && tSat && tSun && tJul && tSep && tNoDue && tEarly);

        // Company B task on the same Saturday
        r = await api(dirB, 'GET', '/api/operations/me');
        const dirBId = r.data.user.id;
        const tB = (await api(dirB, 'POST', '/api/operations/tasks', { title: 'B-company Sat task', assigneeId: dirBId, dueDate: d(15), priority: 'HIGH' })).data.task;
        check('S6. company B task created', !!tB);

        // ── (a) start/end range filter — using the page's real query contract:
        //     offset-bearing ISO instants from windowQuery(calWindow(...)),
        //     built in local NZ time, evaluated by a UTC server. ──
        console.log('\n── start/end range filter (instant contract, NZ client vs UTC server) ──');
        const ids = res => (res.data.tasks || []).map(t => t.id);
        const qs = (view, anchor) => {
            const q = windowQuery(calWindow(view, anchor));
            return `start=${encodeURIComponent(q.start)}&end=${encodeURIComponent(q.end)}`;
        };

        // Day window: local Sat 2026-08-15
        r = await api(dirA, 'GET', `/api/operations/tasks?${qs('day', new Date(2026, 7, 15, 12))}&sort=dueDate`);
        check('A1. day window contains only the Saturday tasks',
            ids(r).includes(tSat.id) && !ids(r).includes(tMon.id) && !ids(r).includes(tSun.id), ids(r));
        check('A1b. 00:30-local task included in its local day (UTC server, previous UTC date)',
            ids(r).includes(tEarly.id), ids(r));
        check('A2. day window excludes tasks without dueDate', !ids(r).includes(tNoDue.id));

        // Week window: local Mon 10 → Sun 16 (inclusive)
        r = await api(dirA, 'GET', `/api/operations/tasks?${qs('week', new Date(2026, 7, 15, 12))}&sort=dueDate`);
        check('A3. week window contains Mon+Sat+Sun tasks',
            ids(r).includes(tMon.id) && ids(r).includes(tSat.id) && ids(r).includes(tSun.id), ids(r));
        check('A4. week window excludes July + September tasks',
            !ids(r).includes(tJul.id) && !ids(r).includes(tSep.id));
        check('A5. end instant is inclusive (23:00 local task on last day included)', ids(r).includes(tSun.id));

        // Month window: August 2026 (local)
        const monthQ = qs('month', new Date(2026, 7, 15));
        r = await api(dirA, 'GET', `/api/operations/tasks?${monthQ}`);
        check('A6. month window contains all August tasks',
            ids(r).includes(tMon.id) && ids(r).includes(tSat.id) && ids(r).includes(tSun.id) && ids(r).includes(tEarly.id));
        check('A7. month window excludes 31 July and 1 Sept (local) tasks',
            !ids(r).includes(tJul.id) && !ids(r).includes(tSep.id), ids(r));

        // start-only / end-only (instants)
        r = await api(dirA, 'GET', `/api/operations/tasks?start=${encodeURIComponent(new Date(2026, 8, 1).toISOString())}`);
        check('A8. start-only filter returns only later tasks', ids(r).includes(tSep.id) && !ids(r).includes(tSat.id));
        r = await api(dirA, 'GET', `/api/operations/tasks?end=${encodeURIComponent(new Date(2026, 7, 1).toISOString())}`);
        check('A9. end-only filter returns only earlier tasks', ids(r).includes(tJul.id) && !ids(r).includes(tMon.id));

        // Bare YYYY-MM-DD still supported (UTC semantics, inclusive end-of-day)
        r = await api(dirA, 'GET', '/api/operations/tasks?start=2026-08-01&end=2026-08-31');
        check('A9b. bare-date range still works (UTC semantics, inclusive end)', r.status === 200 && r.data.success && ids(r).includes(tMon.id));

        // No range → unchanged behaviour (no-due task still listed)
        r = await api(dirA, 'GET', '/api/operations/tasks');
        check('A10. no range param keeps existing behaviour (no-due task listed)', ids(r).includes(tNoDue.id));

        // Malformed dates → no crash
        r = await api(dirA, 'GET', '/api/operations/tasks?start=garbage&end=alsogarbage');
        check('A11. malformed start/end does not crash (200)', r.status === 200 && r.data.success);

        // ── (b) role visibility ──
        console.log('\n── role visibility in calendar window ──');
        const weekQ = `/api/operations/tasks?${monthQ}&sort=dueDate`;
        r = await api(dirA, 'GET', weekQ);
        check('B1. Director sees all August company tasks',
            ids(r).includes(tMon.id) && ids(r).includes(tSat.id) && ids(r).includes(tSun.id));
        r = await api(scTok, 'GET', weekQ);
        check('B2. Sous Chef sees own task', ids(r).includes(tMon.id));
        check('B3. Sous Chef does NOT see Director\'s task', !ids(r).includes(tSun.id), ids(r));
        r = await api(cdbTok, 'GET', weekQ);
        check('B4. CdB sees only own Saturday task',
            ids(r).includes(tSat.id) && !ids(r).includes(tMon.id) && !ids(r).includes(tSun.id), ids(r));

        // ── (c) company isolation ──
        console.log('\n── company isolation ──');
        r = await api(dirB, 'GET', '/api/operations/tasks?start=2026-08-01&end=2026-08-31');
        check('C1. company B sees its own task', ids(r).includes(tB.id));
        check('C2. company B never sees company A tasks',
            !ids(r).some(id => [tMon.id, tSat.id, tSun.id].includes(id)), ids(r));
        r = await api(dirA, 'GET', '/api/operations/tasks?start=2026-08-01&end=2026-08-31');
        check('C3. company A never sees company B task', !ids(r).includes(tB.id));

        // ── (d) mutations reflected in next calendar fetch ──
        console.log('\n── complete / reassign reflected ──');
        r = await api(cdbTok, 'POST', `/api/operations/tasks/${tSat.id}/complete`, {});
        check('D1. CdB completes own task', r.data.success, r.data);
        r = await api(dirA, 'GET', `/api/operations/tasks?${qs('day', new Date(2026, 7, 15, 12))}`);
        const satAfter = (r.data.tasks || []).find(t => t.id === tSat.id);
        check('D2. completed status visible in calendar window fetch', satAfter && satAfter.status === 'COMPLETED', satAfter);

        r = await api(dirA, 'POST', `/api/operations/tasks/${tMon.id}/reassign`, { assigneeId: cdbInv.id });
        check('D3. Director reassigns SC task to CdB', r.data.success, r.data);
        r = await api(scTok, 'GET', weekQ);
        check('D4. reassigned task no longer visible to former assignee (SC)', !ids(r).includes(tMon.id), ids(r));
        r = await api(cdbTok, 'GET', weekQ);
        check('D5. reassigned task visible to new assignee (CdB)', ids(r).includes(tMon.id));

        // ── (e) Service calendar isolation ──
        console.log('\n── Service calendar untouched ──');
        const svcCalAfter = fs.readFileSync(svcCalPath, 'utf8');
        check('E1. Service calendar data file content unchanged', svcCalAfter === svcCalBefore);
        check('E2. Service calendar data file not rewritten', fs.statSync(svcCalPath).mtimeMs === svcCalMtime);
        // The calendar page never references Service calendar endpoints
        const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'operations-calendar.html'), 'utf8');
        check('E3. calendar page never calls /api/calendar/*', !pageSrc.includes('/api/calendar'));
        check('E4. calendar page fetches the Operations task list', pageSrc.includes('/api/operations/tasks'));
        check('E5. calendar page uses existing OpsRealtime channel (no new WebSocket)',
            pageSrc.includes('operations-realtime.js') && !/new\s+WebSocket/.test(pageSrc));
        check('E6. calendar page listens for task lifecycle events',
            ['OPS_TASK_CREATED', 'OPS_TASK_UPDATED', 'OPS_TASK_COMPLETED', 'OPS_TASK_REASSIGNED', 'OPS_TASK_DELETED']
                .every(evt => pageSrc.includes(evt)));

        // ── Static UI wiring checks ──
        console.log('\n── UI wiring ──');
        const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
        for (const f of ['operations-director.html', 'operations-cc.html', 'operations-adjoint.html', 'operations-souschef.html', 'operations-cdb.html']) {
            check(`U. ${f} has Calendar quick-action`, pub(f).includes('operations-calendar.html') && pub(f).includes('ops.cal.quickAction'));
        }
        for (const f of ['operations-tasks.html', 'operations-team.html', 'operations-templates.html', 'operations-performance.html', 'operations-director.html']) {
            check(`U. ${f} nav links to calendar`, pub(f).includes('href="operations-calendar.html"'));
        }
        const calSrc = pub('operations-calendar.html');
        check('U. calendar page uses operations-shell redesign', calSrc.includes('body class="operations-shell"') && calSrc.includes('operations-redesign.css'));
        check('U. calendar nav marks Calendar active', /ops-nav-item active" data-i18n="ops\.cal\.navLink"/.test(calSrc));
        check('U. calendar cards link to task detail',
            calSrc.includes('taskDetailUrl(') &&
            fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'operations-calendar-core.js'), 'utf8').includes('operations-tasks.html?taskId='));
        check('U. calendar page loads shared core module', calSrc.includes('operations-calendar-core.js'));

        // i18n keys present in all three locales
        const KEYS = ['ops.cal.tab.day', 'ops.cal.tab.week', 'ops.cal.tab.month', 'ops.cal.nav.prev', 'ops.cal.nav.today',
            'ops.cal.nav.next', 'ops.cal.empty.day', 'ops.cal.empty.week', 'ops.cal.empty.month', 'ops.cal.loading',
            'ops.cal.error.network', 'ops.cal.quickAction', 'ops.cal.navLink'];
        for (const lang of ['it', 'fr', 'en']) {
            const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n', `${lang}.json`), 'utf8'));
            check(`U. ${lang}.json valid + has all ops.cal.* keys`, KEYS.every(k => typeof dict[k] === 'string' && dict[k].length));
        }
    } finally {
        server.kill();
        try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
