#!/usr/bin/env node
'use strict';

/**
 * Operations task create-panel binding regression.
 *
 * The primary Create button must use a direct listener: browser-global lookup
 * from an inline onclick caused a ReferenceError in the preview even though the
 * panel renderer itself still existed.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${label}`);
    } else {
        failed++;
        console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

function extractMainScript(html) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    return scripts.reduce((largest, script) => script.length > largest.length ? script : largest, '');
}

const ROOT = path.join(__dirname, '..');
const pagePath = path.join(ROOT, 'public', 'operations-tasks.html');
const page = fs.readFileSync(pagePath, 'utf8');

const buttonTag = page.match(/<button\b[^>]*\bid="new-task-btn"[^>]*>/);
check('Create control exists', !!buttonTag);
check('Create control has no stale inline openCreatePanel handler',
    !!buttonTag && !/\bonclick\s*=\s*"[^"]*openCreatePanel\s*\(/.test(buttonTag[0]));
check('Page registers a direct click listener for the Create control',
    page.includes("newTaskBtn.addEventListener('click', openCreatePanel)"));
check('Quick Note handoff sends only an opaque source note ID',
    page.includes('body.sourceNoteId = _createSourceNoteId') &&
    !/sourceNoteText\s*[:=]/.test(page));

const dom = new JSDOM(`<!doctype html><html><body>
  <button id="new-task-btn">Create</button>
  <div id="side-panel"></div>
  <div id="panel-overlay"></div>
  <div id="panel-inner"></div>
</body></html>`, { runScripts: 'dangerously' });

const { window } = dom;
window.OpsCommon = {
    escHtml: value => String(value).replace(/[&<>]/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;'
    })[char]),
    roleLabel: role => role || '',
    priorityLabel: priority => priority || '',
    api: async () => ({ success: true, departments: [] })
};
window.I18n = {
    t: key => key,
    // Keep the page boot callback from running in this focused DOM harness.
    init: () => new Promise(() => {})
};
window.OpsRealtime = { init() {}, on() {} };

try {
    window.eval(extractMainScript(page));
    const button = window.document.getElementById('new-task-btn');
    button.click();

    const panel = window.document.getElementById('side-panel');
    const overlay = window.document.getElementById('panel-overlay');
    const title = window.document.getElementById('c-title');

    check('Clicking Create opens the side panel', panel.classList.contains('open'));
    check('Clicking Create activates the panel overlay', overlay.classList.contains('active'));
    check('Clicking Create renders the task title field', !!title);

    const note = { id: 'opsn-client-test', text: 'Prepare pastry station\nBefore lunch' };
    window.openCreatePanel(note);
    const handoffTitle = window.document.getElementById('c-title');
    const handoffDescription = window.document.getElementById('c-desc');
    check('Quick Note handoff pre-fills the task title', handoffTitle.value === 'Prepare pastry station Before lunch');
    check('Quick Note handoff copies the note text into the task description', handoffDescription.value === note.text);
    handoffDescription.value = 'Edited task draft';
    check('Editing a task draft does not mutate the source note', note.text === 'Prepare pastry station\nBefore lunch');
} catch (error) {
    check('Create-panel script evaluates and click handler runs', false, error.stack || error.message);
}

console.log(`\nOperations create-panel binding: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;