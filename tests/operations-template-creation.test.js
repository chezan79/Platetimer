#!/usr/bin/env node
'use strict';

/**
 * Operations template page client regression coverage.
 *
 * Execute the page's actual inline script in jsdom so these checks catch
 * accidental reversion to the old three-argument OpsCommon.api() contract.
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

function pageDom(url) {
    const dom = new JSDOM(`<!doctype html><html><body>
      <button id="new-tpl-btn"></button>
      <div id="ops-error"></div>
      <span id="me-name"></span><span id="me-role"></span>
      <div id="tpl-list"></div>
      <div id="panel-overlay"></div>
      <div id="side-panel"></div>
      <div id="panel-inner"></div>
    </body></html>`, { url, runScripts: 'dangerously' });

    const calls = [];
    const templates = [{
        id: 'tpl-1',
        title: 'Daily close',
        description: '',
        frequency: 'DAILY',
        interval: 1,
        daysOfWeek: [],
        dayOfMonth: null,
        defaultAssigneeId: null,
        priority: 'MEDIUM',
        department: '',
        serviceDepartmentId: 'dept-kitchen',
        serviceDepartmentName: 'Kitchen',
        startDate: '2026-08-26',
        endDate: null,
        maxOccurrences: null,
        workSchedule: [0, 1, 2, 3, 4, 5, 6],
        defaultReminderDays: null,
        defaultEscalation: false,
        active: true,
        generatedCount: 0
    }];

    dom.window.OpsCommon = {
        PRIORITY_LABELS: { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Urgent' },
        escHtml: value => String(value).replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]),
        roleLabel: role => role,
        loadMe: async () => ({ user: { id: 'director-1', name: 'Director', role: 'DIRECTOR' } }),
        showError: () => {},
        showPanelMsg: () => {},
        api: async (requestPath, options = {}) => {
            calls.push({ requestPath, options });
            if (requestPath === '/api/operations/assignees') {
                return { success: true, assignees: [] };
            }
            if (requestPath === '/api/operations/service-departments') {
                return {
                    success: true,
                    departments: [
                        { id: 'dept-bar', name: 'Bar' }
                    ]
                };
            }
            if (requestPath === '/api/operations/templates') {
                if (options.method === 'POST') return { success: true, template: templates[0] };
                return { success: true, templates };
            }
            return { success: true, generated: 1 };
        }
    };
    dom.window.confirm = () => true;
    dom.window.alert = () => {};
    return { dom, calls, templates };
}

async function run() {
    const root = path.join(__dirname, '..');
    const source = fs.readFileSync(path.join(root, 'public', 'operations-templates.html'), 'utf8');
    const script = extractMainScript(source);

    const route = pageDom('https://example.test/operations-templates.html?action=create');
    route.dom.window.eval(script);
    await new Promise(resolve => setTimeout(resolve, 0));
    check('action=create opens the create panel after the initial load',
        route.dom.window.document.getElementById('side-panel').classList.contains('open'));
    check('action=create renders the template form',
        !!route.dom.window.document.getElementById('tpl-title'));
    const createDepartment = route.dom.window.document.getElementById('tpl-service-dept');
    check('template form uses the shared optional Service department dropdown',
        !!createDepartment && createDepartment.options.length === 2 && createDepartment.value === '');

    const createCalls = route.calls.splice(0);
    const createTitle = route.dom.window.document.getElementById('tpl-title');
    createTitle.value = 'Nightly close';
    createDepartment.value = 'dept-bar';
    await route.dom.window.doCreate();
    const create = route.calls.find(call => call.requestPath === '/api/operations/templates' &&
        call.options.method === 'POST');
    check('create uses the documented POST options object', !!create);
    check('create sends the collected form as a JSON body',
        !!create && JSON.parse(create.options.body).title === 'Nightly close');
    check('create sends the canonical single Service department ID',
        !!create &&
        JSON.parse(create.options.body).serviceDepartmentId === 'dept-bar' &&
        JSON.parse(create.options.body).department === undefined);
    check('initial loading uses GET options defaults, not a stale mutation call',
        createCalls.some(call => call.requestPath === '/api/operations/templates' &&
            call.options.method === undefined));

    route.dom.window.openEditMode('tpl-1');
    const editDepartment = route.dom.window.document.getElementById('tpl-service-dept');
    check('edit visibly preserves a selected department that is no longer active',
        editDepartment.value === 'dept-kitchen' &&
        editDepartment.selectedOptions[0].disabled &&
        editDepartment.selectedOptions[0].textContent.includes('non attivo'));
    await route.dom.window.doEdit('tpl-1');
    const edit = route.calls.find(call => call.requestPath === '/api/operations/templates/tpl-1' &&
        call.options.method === 'PATCH');
    check('edit uses the PATCH options object', !!edit);
    check('edit sends a JSON body', !!edit && typeof edit.options.body === 'string');
    check('unrelated edit omits an unchanged inactive department',
        !!edit && JSON.parse(edit.options.body).serviceDepartmentId === undefined);

    await route.dom.window.forceGenerate('tpl-1');
    const generate = route.calls.find(call =>
        call.requestPath === '/api/operations/templates/tpl-1/generate-now' &&
        call.options.method === 'POST');
    check('generate now uses the POST options object', !!generate);

    await route.dom.window.deactivate('tpl-1');
    const deactivate = route.calls.find(call =>
        call.requestPath === '/api/operations/templates/tpl-1' &&
        call.options.method === 'DELETE');
    check('deactivate uses the DELETE options object', !!deactivate);

    console.log(`\nOperations template client regression: ${passed} passed, ${failed} failed.`);
    process.exitCode = failed ? 1 : 0;
}

run().catch(error => {
    console.error('Fatal:', error.stack || error.message);
    process.exitCode = 1;
});