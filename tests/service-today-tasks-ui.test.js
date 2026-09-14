#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../public/department.html'), 'utf8');
const dictionaries = ['it', 'fr', 'en'].map(locale => ({
  locale,
  data: JSON.parse(fs.readFileSync(path.join(__dirname, `../public/i18n/${locale}.json`), 'utf8'))
}));

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}

check('uses canonical today endpoint', html.includes("fetch('/api/service/ops-tasks/today'"));
check('does not fetch all-actionable endpoint', !html.includes("fetch('/api/service/ops-tasks',"));
check('renders title, description, due time, priority, canonical status and acknowledgement',
  html.includes('ops-task-title') && html.includes('ops-task-description') &&
  html.includes('_opsFmtDue(tk.dueDate)') && html.includes('ops-prio-pill') &&
  html.includes('ops-status-pill') && html.includes('acknowledgeOpsTask'));
check('does not inspect recurrence provenance or filter by createdAt',
  !/templateId|recurrence|createdAt/.test(html.slice(html.indexOf('function renderOpsTasks'), html.indexOf('function openOpsDetailModal'))));
check('acknowledgement uses existing department route and removes only local daily item',
  html.includes('/acknowledge') && html.includes('opsTasks.delete(taskId)'));
check('task events invalidate and refresh instead of upserting event payloads',
  html.includes("scheduleOpsTasksRefresh()") &&
  !html.slice(html.indexOf("} else if(['OPS_TASK_CREATED'"), html.indexOf("} else if(data.action === 'mexIncoming'")).includes('opsTasks.set'));
check('reconnect refreshes today list', html.includes('if(WsAuth.isServiceSession()) loadOpsTasks();'));
check('date rollover compares Zurich date to authoritative todayDate',
  html.includes("timeZone:'Europe/Zurich'") && html.includes('_opsZurichDate() !== opsTodayDate'));
check('Mex and countdown handlers remain present',
  html.includes("data.action === 'startCountdown'") && html.includes("data.action === 'mexIncoming'"));

for (const { locale, data } of dictionaries) {
  for (const key of [
    'service.todayTasksSection', 'service.todayTasksLoading', 'service.todayTasksEmpty',
    'service.todayTasksAllDay',
    'service.todayTasksAuthError', 'service.todayTasksSuspended', 'service.todayTasksInactive',
    'service.todayTasksError', 'service.todayTasksRetry', 'service.todayTasksAckError'
  ]) check(`${locale} contains ${key}`, typeof data[key] === 'string' && data[key].length > 0);
}

function extractFunction(name) {
  const asyncStart = html.indexOf(`async function ${name}(`);
  const plainStart = html.indexOf(`function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : plainStart;
  if (start < 0) throw new Error(`Missing function ${name}`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

async function behaviorChecks() {
  const formatContext = {
    window: {},
    I18n: {
      getLanguage: () => 'en',
      t: key => ({ 'service.todayTasksAllDay': 'Due today' }[key] || key)
    },
    navigator: { language: 'en' }
  };
  formatContext.window.I18n = formatContext.I18n;
  vm.createContext(formatContext);
  vm.runInContext(`${extractFunction('_ot')}; ${extractFunction('_opsFmtDue')}; ${extractFunction('_opsIsOverdue')}`, formatContext);
  check('date-only tasks render without a fabricated time',
    formatContext._opsFmtDue('2026-09-14') === 'Due today');
  check('a date-only task due today is not marked overdue',
    formatContext._opsIsOverdue({ dueDate: '2026-09-14', status: 'OPEN' }) === false);
  const timed = formatContext._opsFmtDue('2026-09-14T10:30:00.000Z');
  check('timed tasks render in the Zurich timezone', /12[.:]30/.test(timed), timed);

  const pending = [];
  const requestContext = {
    Map,
    console: { log() {}, warn() {} },
    token: 'test-token',
    WsAuth: { isServiceSession: () => true },
    opsTasks: new Map(),
    opsTasksState: 'idle',
    opsTasksErrorKey: '',
    opsTodayDate: '',
    opsRequestGeneration: 0,
    renderOpsTasks() {},
    fetch: () => new Promise(resolve => pending.push(resolve))
  };
  vm.createContext(requestContext);
  vm.runInContext(extractFunction('loadOpsTasks'), requestContext);
  const older = requestContext.loadOpsTasks();
  const newer = requestContext.loadOpsTasks();
  pending[1]({
    ok: true,
    json: async () => ({ success: true, todayDate: '2026-09-14', tasks: [{ id: 'newer' }] })
  });
  await newer;
  pending[0]({
    ok: true,
    json: async () => ({ success: true, todayDate: '2026-09-14', tasks: [{ id: 'older' }] })
  });
  await older;
  check('an older refresh cannot overwrite a newer response',
    requestContext.opsTasks.has('newer') && !requestContext.opsTasks.has('older'));

  console.log(`\nService today tasks UI: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

behaviorChecks().catch(error => {
  console.error(error);
  process.exit(1);
});