'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { group, isManager } = require('../public/js/operations-task-groups');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/operations-tasks.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]).sort((a, b) => b.length - a.length)[0];
const now = Date.parse('2026-09-23T12:00:00Z');
const mk = (id, assigneeId, status, extra = {}) =>
    ({ id, title: id, assigneeId, status, priority: 'MEDIUM', effectiveStatus: status, ...extra });
const users = {
    a: { name: 'Alex', role: 'SOUS_CHEF' },
    b: { name: 'Alex', role: 'CHEF_DE_BRIGADE' },
    c: { name: 'Chris', role: 'ADJOINT' },
    d: { name: 'Dana', role: 'DIRECTOR' }
};
const tasks = [
    mk('a1', 'a', 'OPEN', { effectiveStatus: 'OVERDUE', dueDate: '2026-09-20T12:00:00Z' }),
    mk('a2', 'a', 'IN_PROGRESS', { dueDate: '2026-09-24T12:00:00Z' }),
    mk('a3', 'a', 'COMPLETED', { dueDate: '2026-09-21T12:00:00Z' }),
    mk('b1', 'b', 'IN_PROGRESS', { dueDate: '2026-09-25T12:00:00Z' }),
    mk('b2', 'b', 'CANCELLED', { dueDate: '2026-09-23T18:00:00Z' }),
    mk('c1', 'c', 'OPEN', { dueDate: '2026-09-24T06:00:00Z' }),
    mk('d1', 'd', 'COMPLETED'),
    mk('lost', 'retired-1', 'CANCELLED'),
    mk('lost2', 'retired-2', 'OPEN'),
    mk('none', null, 'OPEN')
];

assert.deepEqual(['DIRECTOR', 'CHEF_CUISINE', 'ADJOINT'].map(isManager), [true, true, true]);
assert.deepEqual(['SOUS_CHEF', 'CHEF_DE_BRIGADE'].map(isManager), [false, false]);
let groups = group(tasks, users, now);
assert.equal(groups.length, 7);
assert.deepEqual(groups.slice(0, 3).map(g => g.assigneeId), ['a', 'b', 'c']);
assert.equal(groups.find(g => g.assigneeId === 'a').total, 3);
assert.deepEqual(
    (({ open, inProgress, overdue, completed }) => ({ open, inProgress, overdue, completed }))(
        groups.find(g => g.assigneeId === 'a')),
    { open: 1, inProgress: 1, overdue: 1, completed: 1 }
);
assert.equal(groups.find(g => g.assigneeId === 'a').nextDue, Date.parse('2026-09-24T12:00:00Z'));
assert.equal(groups.find(g => g.assigneeId === 'b').nextDue, Date.parse('2026-09-25T12:00:00Z'));
assert.equal(groups.find(g => g.assigneeId === 'd').nextDue, null);
assert.equal(groups.find(g => g.assigneeId === 'retired-1').missing, true);
assert.notEqual(groups.find(g => g.assigneeId === 'retired-1').key,
    groups.find(g => g.assigneeId === 'retired-2').key);
assert.equal(groups.find(g => g.assigneeId === null).total, 1);
assert.deepEqual(group([mk('z', 'z', 'OPEN', { dueDate: '2026-09-24T12:00:00Z' }),
    mk('x', 'x', 'OPEN', { dueDate: '2026-09-24T12:00:00Z' })], {}, now).map(g => g.assigneeId), ['x', 'z']);
assert.deepEqual(group([mk('bad', 'a', 'OPEN', { dueDate: 'invalid' })], users, now)[0].nextDue, null);
assert.deepEqual(group([
    mk('second', 'b', 'OPEN', { dueDate: '2026-09-26T12:00:00Z' }),
    mk('first', 'a', 'OPEN', { dueDate: '2026-09-24T12:00:00Z' })
], users, now).map(g => g.assigneeId), ['a', 'b']);
assert.deepEqual(group([mk('cancelled', 'b', 'CANCELLED')], users, now)[0].tier, 4);
assert.deepEqual(group([], users), []);

const dict = Object.fromEntries(['it', 'fr', 'en'].map(lang =>
    [lang, JSON.parse(fs.readFileSync(path.join(root, `public/i18n/${lang}.json`), 'utf8'))]));
const keys = ['byCollaborator', 'allTasks', 'groupTotal', 'nextDue', 'expandTasks',
    'unassigned', 'unknownAssignee'];
for (const lang of ['it', 'fr', 'en']) for (const key of keys)
    assert.ok(dict[lang]['ops.task.' + key], `${lang}: ${key}`);
assert.notEqual(dict.fr['ops.task.byCollaborator'], dict.it['ops.task.byCollaborator']);
assert.notEqual(dict.en['ops.task.byCollaborator'], dict.it['ops.task.byCollaborator']);

async function pageHarness(role, initialTasks = tasks, search = '') {
    const dom = new JSDOM(html, {
        url: 'https://example.test/operations-tasks.html' + (search ? '?filter=today' : ''),
        runScripts: 'outside-only'
    });
    const { window } = dom;
    window.OpsTaskGroups = { group, isManager };
    let visible = initialTasks;
    const requests = [];
    const renders = [];
    const detailClicks = [];
    window.I18n = { t: k => dict.en[k] || k, init: () => new Promise(() => {}) };
    window.OpsRealtime = { init() {}, on() {} };
    window.OpsCommon = {
        escHtml: str => String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        roleLabel: r => r,
        statusLabel: s => s,
        fmtDue: date => new Date(date).toISOString().slice(0, 10),
        loadMe: async () => ({ user: { id: 'manager', name: 'Manager', role } }),
        showError: e => { throw Error(e); },
        api: async url => {
            requests.push(url);
            if (url.startsWith('/api/operations/tasks/')) {
                detailClicks.push(url);
                return { success: false, error: 'not found' };
            }
            if (url.startsWith('/api/operations/tasks?')) return {
                success: true, tasks: visible, users, me: { id: 'manager', role }
            };
            if (url === '/api/operations/assignees') return { success: true, assignees: [] };
            if (url === '/api/operations/service-departments') return { success: true, departments: [] };
            throw Error('unexpected API: ' + url);
        },
        renderTaskList: (container, rows, _users, _myId, _onChange, options) => {
            renders.push(rows.map(row => row.id));
            container.innerHTML = rows.map(row => `<button type="button" class="task-item" data-taskid="${row.id}">${row.title}</button>`).join('');
            container.querySelectorAll('[data-taskid]').forEach(el =>
                el.addEventListener('click', () => options.onTaskClick(el.dataset.taskid, { silent: true })));
        }
    };
    window.eval(script);
    await window.eval('load()');
    return {
        window, requests, renders, detailClicks,
        setVisible: next => { visible = next; },
        close: () => window.close()
    };
}

(async () => {
    const h = await pageHarness('DIRECTOR');
    const { window: w } = h;
    const doc = w.document;
    assert.equal(doc.getElementById('view-collaborator').getAttribute('aria-pressed'), 'true');
    assert.equal(doc.querySelectorAll('.ops-collab-card').length, 7);
    assert.equal(doc.querySelector('.has-overdue .ops-collab-late b').textContent, '1');
    assert.ok(doc.querySelector('[data-group-key="id:retired-1"]').textContent.includes('Assignee unavailable'));
    assert.ok(doc.querySelector('[data-group-key="id:b"]').textContent.includes('CANCELLED') === false);
    assert.ok(doc.querySelector('[data-group-key="id:b"] [data-taskid="b2"]'));
    const requestCount = h.requests.length;
    doc.querySelector('[data-group-key="id:a"] summary').click();
    await new Promise(resolve => w.setTimeout(resolve, 0));
    assert.equal(doc.querySelector('[data-group-key="id:a"]').open, true);
    doc.querySelector('[data-group-key="id:a"] [data-taskid="a1"]').click();
    assert.deepEqual(h.detailClicks, ['/api/operations/tasks/a1']);
    doc.getElementById('view-all').click();
    assert.equal(doc.querySelectorAll('.ops-collab-card').length, 0);
    assert.equal(doc.querySelectorAll('#task-list [data-taskid]').length, tasks.length);
    assert.equal(doc.getElementById('view-all').getAttribute('aria-pressed'), 'true');
    doc.getElementById('view-collaborator').click();
    assert.equal(doc.querySelectorAll('#task-list [data-taskid]').length, tasks.length);
    assert.equal(doc.querySelector('[data-group-key="id:a"]').open, true);
    doc.getElementById('view-all').click();
    doc.querySelector('#task-list [data-taskid="b2"]').click();
    assert.deepEqual(h.detailClicks, ['/api/operations/tasks/a1', '/api/operations/tasks/b2']);
    assert.equal(h.requests.length, requestCount + 2); // only detail clicks, no view fetch
    assert.equal(w.eval('getExportDataset().length'), tasks.length);
    // The same previously authorized, server-filtered result drives both modes.
    doc.getElementById('flt-search').value = 'urgent';
    doc.getElementById('flt-priority').value = 'URGENT';
    doc.getElementById('flt-sort').value = 'dueDate';
    doc.getElementById('flt-my').checked = true;
    doc.getElementById('flt-status').value = 'OPEN';
    h.setVisible([tasks[0]]);
    await w.eval('loadTasks()');
    const lastRequest = h.requests.at(-1);
    for (const param of ['status=OPEN', 'priority=URGENT', 'sort=dueDate', 'my=1', 'q=urgent'])
        assert.ok(lastRequest.includes(param), param);
    const requestsAfterFilter = h.requests.length;
    doc.getElementById('view-collaborator').click();
    assert.deepEqual([...doc.querySelectorAll('#task-list [data-taskid]')].map(el => el.dataset.taskid), ['a1']);
    doc.getElementById('view-all').click();
    assert.deepEqual([...doc.querySelectorAll('#task-list [data-taskid]')].map(el => el.dataset.taskid), ['a1']);
    assert.equal(h.requests.length, requestsAfterFilter);
    assert.equal(doc.getElementById('flt-search').value, 'urgent');
    assert.equal(doc.getElementById('flt-my').checked, true);
    assert.equal(w.eval('getExportDataset().length'), 1);
    h.close();

    const worker = await pageHarness('SOUS_CHEF', [mk('mine', 'a', 'OPEN')]);
    assert.equal(worker.window.document.getElementById('view-all').getAttribute('aria-pressed'), 'true');
    worker.window.document.getElementById('view-collaborator').click();
    assert.equal(worker.window.document.querySelectorAll('.ops-collab-card').length, 1);
    assert.equal(worker.window.document.querySelectorAll('[data-taskid]').length, 1);
    worker.close();

    const h2 = await pageHarness('ADJOINT', [tasks[0], tasks[1], tasks[4]], 'today');
    assert.equal(h2.window.document.querySelectorAll('.ops-collab-card').length, 1);
    assert.deepEqual(h2.renders.at(-1), ['a1']);
    assert.equal(h2.window.eval('getExportDataset().length'), 1);
    h2.window.document.getElementById('flt-status').value = 'OVERDUE';
    h2.setVisible([tasks[0]]);
    await h2.window.eval('loadTasks()');
    assert.equal(h2.window.document.querySelector('[data-group-key="id:a"] [data-taskid="a1"]') !== null, true);
    h2.window.document.getElementById('view-all').click();
    assert.equal(h2.window.eval('getExportDataset().length'), 1);
    h2.close();

    const css = fs.readFileSync(path.join(root, 'public/css/operations-redesign.css'), 'utf8');
    assert.match(css, /ops-collab-summary/);
    assert.match(css, /@media \(max-width: 768px\)[\s\S]*?ops-collab-metrics/);
    assert.match(css, /@media \(max-width: 500px\)[\s\S]*?ops-collab-next/);
    const endpoint = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const taskListRoute = endpoint.slice(endpoint.indexOf("app.get('/api/operations/tasks',"),
        endpoint.indexOf("app.get('/api/operations/calendar',"));
    assert.ok(taskListRoute.indexOf('opsAuth.canViewTask(actor, t, byId)') <
        taskListRoute.indexOf('res.json({ success: true, tasks'), 'server visibility precedes response');
    assert.ok(!taskListRoute.includes('groupTasksByAssignee'), 'server response stays unchanged');
    console.log('Operations collaborator grouping: pure and DOM checks passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });