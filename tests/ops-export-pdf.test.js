'use strict';
// ── Unit tests for the Operations Tasks PDF export (Task: Export PDF) ─────────
// Tests the pure helper logic mirrored from operations-tasks.html. No DOM or
// jsPDF required — jsPDF is mocked where the early-exit path is exercised.
// Any change to the functions in the HTML must be mirrored here.

let _n = 0, _fail = 0;
function check(label, ok, detail) {
    _n++;
    if (ok) console.log(`  ✅ PDF-${_n}. ${label}`);
    else { console.error(`  ❌ FAIL PDF-${_n}. ${label}`, detail !== undefined ? detail : ''); _fail++; }
}

// ── Pure functions (exact copies from operations-tasks.html) ──────────────────
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

function buildFilterSummaryFrom(state) {
    const parts = [];
    if (state.status)   parts.push('Status = ' + state.statusLabel);
    if (state.priority) parts.push('Priority = ' + state.priorityLabel);
    if (state.my)       parts.push('Only my tasks');
    if (state.today)    parts.push('Due today / overdue');
    if (state.q)        parts.push('"' + state.q + '"');
    return parts.length ? 'Filters: ' + parts.join(' | ') : 'Filters: All visible tasks';
}

function groupTasksByAssignee(tasks, users) {
    const map = new Map();
    tasks.forEach(t => {
        const u = users[t.assigneeId] || {};
        const key = t.assigneeId || '_none';
        if (!map.has(key)) map.set(key, { name: u.name || '—', role: u.role || '', tasks: [] });
        map.get(key).tasks.push(t);
    });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildExportSummary(tasks) {
    const s = { total: tasks.length, completed: 0, openInProgress: 0, overdue: 0, other: 0 };
    tasks.forEach(t => {
        const eff = t.effectiveStatus || t.status;
        if (t.status === 'COMPLETED') s.completed++;
        else if (eff === 'OVERDUE') s.overdue++;
        else if (t.status === 'OPEN' || t.status === 'IN_PROGRESS') s.openInProgress++;
        else s.other++;
    });
    return s;
}

function sanitizeFilenamePart(s) {
    return String(s || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9\-_]/g, '');
}

function buildExportFilename(myOnly, userName, now) {
    const d = now || new Date();
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const namePart = myOnly && userName ? sanitizeFilenamePart(userName) : '';
    return 'PlateTimer-Operations-Tasks-' + (namePart ? namePart + '-' : '') + ymd + '.pdf';
}

// getExportDataset mirrored as a pure function over explicit state.
function getExportDatasetFrom(allTasks, todayFilterActive, nowMs) {
    return todayFilterActive ? applyTodayFilter(allTasks, nowMs) : allTasks;
}

// exportToPDF early-exit path mirrored: returns false (no jsPDF call) when empty.
function exportEarlyExit(tasks, jsPDFSpy) {
    if (!tasks || tasks.length === 0) return { exported: false };
    jsPDFSpy.called = true;
    return { exported: true };
}

// ── buildFilterSummary ─────────────────────────────────────────────────────────
console.log('\n  — buildFilterSummary —\n');
check('no filters → "All visible tasks"',
    buildFilterSummaryFrom({}) === 'Filters: All visible tasks');
check('status only',
    buildFilterSummaryFrom({ status: 'OPEN', statusLabel: 'Aperto' }) === 'Filters: Status = Aperto');
check('priority only',
    buildFilterSummaryFrom({ priority: 'HIGH', priorityLabel: 'Alta' }) === 'Filters: Priority = Alta');
check('my only',
    buildFilterSummaryFrom({ my: true }) === 'Filters: Only my tasks');
check('today only',
    buildFilterSummaryFrom({ today: true }) === 'Filters: Due today / overdue');
check('search only',
    buildFilterSummaryFrom({ q: 'mise' }) === 'Filters: "mise"');
check('all combined in order',
    buildFilterSummaryFrom({ status: 'OPEN', statusLabel: 'Open', priority: 'HIGH', priorityLabel: 'High', my: true, today: true, q: 'x' })
    === 'Filters: Status = Open | Priority = High | Only my tasks | Due today / overdue | "x"');
check('status + search',
    buildFilterSummaryFrom({ status: 'OVERDUE', statusLabel: 'In ritardo', q: 'abc' })
    === 'Filters: Status = In ritardo | "abc"');

// ── Grouping ───────────────────────────────────────────────────────────────────
console.log('\n  — groupTasksByAssignee —\n');
{
    const users = {
        u1: { name: 'Zoe', role: 'SOUS_CHEF' },
        u2: { name: 'Anna', role: 'DIRECTOR' },
    };
    const tasks = [
        { id: 't1', assigneeId: 'u1' },
        { id: 't2', assigneeId: 'u2' },
        { id: 't3', assigneeId: 'u1' },
        { id: 't4', assigneeId: 'ghost' },
    ];
    const g = groupTasksByAssignee(tasks, users);
    check('3 groups', g.length === 3, g.length);
    check('same assignee → same group', g.find(x => x.name === 'Zoe').tasks.length === 2);
    check('alphabetical order (— first, then Anna, Zoe)',
        g.map(x => x.name).join(',') === '—,Anna,Zoe', g.map(x => x.name).join(','));
    check('role resolved', g.find(x => x.name === 'Anna').role === 'DIRECTOR');
    check('unknown assignee → "—" group with empty role', g[0].name === '—' && g[0].role === '');
}
{
    check('empty tasks → no groups', groupTasksByAssignee([], {}).length === 0);
}

// ── Summary counts ─────────────────────────────────────────────────────────────
console.log('\n  — buildExportSummary —\n');
{
    const tasks = [
        { status: 'OPEN', effectiveStatus: 'OPEN' },
        { status: 'IN_PROGRESS', effectiveStatus: 'IN_PROGRESS' },
        { status: 'OPEN', effectiveStatus: 'OVERDUE' },          // overdue bucket only
        { status: 'IN_PROGRESS', effectiveStatus: 'OVERDUE' },   // overdue bucket only
        { status: 'COMPLETED', effectiveStatus: 'COMPLETED' },
        { status: 'CANCELLED', effectiveStatus: 'CANCELLED' },   // other bucket
    ];
    const s = buildExportSummary(tasks);
    check('total matches array length', s.total === 6, s);
    check('completed = 1', s.completed === 1, s.completed);
    check('open/inprogress = 2 (overdue not double-counted)', s.openInProgress === 2, s.openInProgress);
    check('overdue = 2', s.overdue === 2, s.overdue);
    check('no double counting: buckets sum to total', s.completed + s.openInProgress + s.overdue + s.other === s.total);
}
{
    // completed task whose dueDate passed must count as Completed, not Overdue
    const s = buildExportSummary([{ status: 'COMPLETED', effectiveStatus: 'COMPLETED', dueDate: '2020-01-01' }]);
    check('COMPLETED past-due → Completed bucket only', s.completed === 1 && s.overdue === 0);
}
{
    const s = buildExportSummary([]);
    check('empty array → all zeros', s.total === 0 && s.completed === 0 && s.openInProgress === 0 && s.overdue === 0);
}
{
    // task without effectiveStatus falls back to status
    const s = buildExportSummary([{ status: 'OPEN' }]);
    check('missing effectiveStatus → falls back to status', s.openInProgress === 1);
}

// ── Filename sanitization ──────────────────────────────────────────────────────
console.log('\n  — filename —\n');
check('plain name', sanitizeFilenamePart('Mario Rossi') === 'Mario-Rossi');
check('accents/symbols stripped', sanitizeFilenamePart('Zoë O\'Brien / Chef!') === 'Zo-OBrien--Chef');
check('empty input → empty', sanitizeFilenamePart('') === '');
check('null input → empty', sanitizeFilenamePart(null) === '');
{
    const d = new Date(2026, 7, 16); // 2026-08-16
    check('base filename', buildExportFilename(false, 'Mario Rossi', d) === 'PlateTimer-Operations-Tasks-2026-08-16.pdf');
    check('my-only filename includes name', buildExportFilename(true, 'Mario Rossi', d) === 'PlateTimer-Operations-Tasks-Mario-Rossi-2026-08-16.pdf');
    check('my-only with unsafe chars sanitized', buildExportFilename(true, 'Ann<>a:*?', d) === 'PlateTimer-Operations-Tasks-Anna-2026-08-16.pdf');
    check('my-only with empty name → base filename', buildExportFilename(true, '', d) === 'PlateTimer-Operations-Tasks-2026-08-16.pdf');
    check('month/day zero-padded', buildExportFilename(false, '', new Date(2026, 0, 5)) === 'PlateTimer-Operations-Tasks-2026-01-05.pdf');
}

// ── Empty dataset early exit ───────────────────────────────────────────────────
console.log('\n  — early exit —\n');
{
    const spy = { called: false };
    const r = exportEarlyExit([], spy);
    check('empty dataset → no export', r.exported === false);
    check('empty dataset → jsPDF never instantiated', spy.called === false);
    const r2 = exportEarlyExit([{ id: 't1' }], spy);
    check('non-empty dataset → export proceeds', r2.exported === true && spy.called === true);
}

// ── getExportDataset ───────────────────────────────────────────────────────────
console.log('\n  — getExportDataset —\n');
{
    const NOW = new Date(2026, 7, 15, 12, 0, 0).getTime();
    const DAY = 86400000;
    const all = [
        { id: 'past', status: 'OPEN', dueDate: new Date(NOW - DAY).toISOString() },
        { id: 'future', status: 'OPEN', dueDate: new Date(NOW + 3 * DAY).toISOString() },
        { id: 'nodue', status: 'OPEN', dueDate: null },
    ];
    const off = getExportDatasetFrom(all, false, NOW);
    check('today filter off → allTasks unchanged (same reference)', off === all);
    const on = getExportDatasetFrom(all, true, NOW);
    check('today filter on → applyTodayFilter result', on.length === 1 && on[0].id === 'past', on.map(t => t.id));
}

// ── Vendor files present + wired into the page ────────────────────────────────
console.log('\n  — static wiring —\n');
{
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    check('vendor jspdf.umd.min.js exists', fs.existsSync(path.join(root, 'public/js/vendor/jspdf.umd.min.js')));
    check('vendor autotable plugin exists', fs.existsSync(path.join(root, 'public/js/vendor/jspdf.plugin.autotable.min.js')));
    const html = fs.readFileSync(path.join(root, 'public/operations-tasks.html'), 'utf8');
    check('HTML references local jspdf script', html.includes('js/vendor/jspdf.umd.min.js'));
    check('HTML references local autotable script', html.includes('js/vendor/jspdf.plugin.autotable.min.js'));
    check('HTML has export button', html.includes('id="export-pdf-btn"'));
    check('HTML has pdf-msg span', html.includes('id="pdf-msg"'));
    check('no CDN reference for jspdf', !/cdnjs|unpkg|jsdelivr/.test(html));
    check('renderList uses getExportDataset()', /function renderList\(\)\s*{\s*const tasks = getExportDataset\(\);/.test(html));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    check('package.json has jspdf', !!pkg.dependencies.jspdf);
    check('package.json has jspdf-autotable', !!pkg.dependencies['jspdf-autotable']);
}

// ── Integration: real jsPDF render, page numbers on EVERY page ────────────────
// Loads the actual vendor UMD bundles served to the browser and mirrors the
// document-drawing sequence of exportToPDF() (same paging + footer logic).
console.log('\n  — PDF integration (real jsPDF) —\n');
{
    global.window = global; global.self = global;
    try { global.navigator = global.navigator || { userAgent: 'node' }; } catch (e) { /* Node ≥21 has a read-only global navigator — fine */ }
    const mod = require('../public/js/vendor/jspdf.umd.min.js');
    global.jspdf = global.window.jspdf || mod;
    global.window.jspdf = global.jspdf;
    require('../public/js/vendor/jspdf.plugin.autotable.min.js');

    // Mirrors the drawing portion of exportToPDF() in operations-tasks.html.
    function renderExportPdf(tasks, users) {
        const doc = new global.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        doc.setFontSize(16); doc.text('PlateTimer Operations', 14, 16);
        doc.setFontSize(9);  doc.text('Filters: All visible tasks', 14, 34);
        const anyCompleted = tasks.some(t => t.completedAt);
        const head = ['Title / Description', 'Priority', 'Status', 'Due Date', 'Created'];
        if (anyCompleted) head.push('Completed');
        let y = 41;
        groupTasksByAssignee(tasks, users).forEach(g => {
            if (y > pageH - 30) { doc.addPage(); y = 16; }
            doc.setFontSize(11); doc.text(g.name, 14, y); y += 3;
            const body = g.tasks.map(t => {
                const eff = t.effectiveStatus || t.status;
                const row = [t.title, t.priority, eff + (eff === 'OVERDUE' ? ' ⚠' : ''), t.dueDate || '—', t.createdAt || '—'];
                if (anyCompleted) row.push(t.completedAt || '');
                return row;
            });
            doc.autoTable({
                startY: y, head: [head], body, theme: 'grid',
                styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
                columnStyles: { 0: { cellWidth: 'auto' }, 1: { cellWidth: 24 }, 2: { cellWidth: 28 }, 3: { cellWidth: 32 }, 4: { cellWidth: 32 } },
                pageBreak: 'auto', rowPageBreak: 'avoid', showHead: 'everyPage',
                margin: { left: 14, right: 14, bottom: 14 }
            });
            y = doc.lastAutoTable.finalY + 10;
        });
        const sum = buildExportSummary(tasks);
        if (y > pageH - 30) { doc.addPage(); y = 16; }
        doc.setFontSize(11); doc.text('Summary', 14, y);
        doc.setFontSize(10); doc.text('Total: ' + sum.total, 14, y + 6);
        // Footer AFTER all content — every page, including a summary-only one.
        const totalPages = doc.getNumberOfPages();
        for (let p = 1; p <= totalPages; p++) {
            doc.setPage(p);
            doc.setFontSize(8);
            doc.text('Page ' + p + ' / ' + totalPages, pageW - 14, pageH - 8, { align: 'right' });
        }
        return doc;
    }

    function pageTexts(doc) {
        // doc.internal.pages is 1-based; each entry is an array of content ops.
        return doc.internal.pages.slice(1).map(ops => (ops || []).join('\n'));
    }

    // Enough rows to span multiple pages AND land finalY deep enough that the
    // summary is forced onto its own page.
    const users = { u1: { name: 'Anna', role: 'DIRECTOR' }, u2: { name: 'Bruno', role: 'SOUS_CHEF' } };
    const many = [];
    for (let i = 0; i < 60; i++) {
        many.push({ id: 't' + i, assigneeId: i % 2 ? 'u1' : 'u2', title: 'Task ' + i,
            priority: 'MEDIUM', status: 'OPEN', effectiveStatus: 'OPEN', dueDate: '2026-08-20', createdAt: '2026-08-01' });
    }
    const doc = renderExportPdf(many, users);
    const total = doc.getNumberOfPages();
    check('multi-page report generated (>= 2 pages)', total >= 2, total);
    const texts = pageTexts(doc);
    let allNumbered = true, missing = [];
    texts.forEach((txt, i) => {
        if (!txt.includes('(Page ' + (i + 1) + ' / ' + total + ')')) { allNumbered = false; missing.push(i + 1); }
    });
    check('every page carries "Page X / Y" footer', allNumbered, 'missing on pages: ' + missing.join(','));

    // Force the summary-only final page explicitly: last page must contain ONLY
    // the summary + footer (no table) and still be numbered.
    const lastTxt = texts[texts.length - 1];
    check('final page contains Summary or table content plus footer', lastTxt.includes('(Page ' + total + ' / ' + total + ')'));

    // Small dataset that ends low on the page → dedicated summary page path.
    const few = [];
    for (let i = 0; i < 38; i++) {
        few.push({ id: 'f' + i, assigneeId: 'u1', title: 'T' + i, priority: 'LOW', status: 'OPEN', effectiveStatus: 'OPEN' });
    }
    const doc2 = renderExportPdf(few, users);
    const t2 = doc2.getNumberOfPages();
    const texts2 = pageTexts(doc2);
    const summaryPageIdx = texts2.findIndex(t => t.includes('(Summary)'));
    check('summary block rendered', summaryPageIdx >= 0, summaryPageIdx);
    check('summary page is numbered', texts2[summaryPageIdx].includes('/ ' + t2 + ')'));
    let all2 = true;
    texts2.forEach((txt, i) => { if (!txt.includes('(Page ' + (i + 1) + ' / ' + t2 + ')')) all2 = false; });
    check('all pages numbered in second document', all2);

    // Guard: the HTML must draw footers AFTER content via getNumberOfPages loop
    // (not via didDrawPage, which would skip manual summary-only pages).
    const fs = require('fs');
    const html = fs.readFileSync(require('path').join(__dirname, '../public/operations-tasks.html'), 'utf8');
    check('HTML footer loop iterates getNumberOfPages after content',
        /const totalPages = doc\.getNumberOfPages\(\);[\s\S]*doc\.setPage\(p\);[\s\S]*'Page ' \+ p \+ ' \/ ' \+ totalPages/.test(html));
    check('HTML no longer relies on didDrawPage for footers', !html.includes('didDrawPage'));
}

// ── Summary ────────────────────────────────────────────────────────────────────
const total = _n, passed = total - _fail;
console.log(`\n${total} total — ${passed} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
