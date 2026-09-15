#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../public/department.html'), 'utf8');
const identityModule = fs.readFileSync(path.join(__dirname, '../public/js/service-worker-identity.js'), 'utf8');
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
check('completed attribution never falls back to a former claimant',
  html.includes('const completedName = tk.completedByWorkerName;') &&
  !html.includes('const completedName = tk.completedByWorkerName || claimName;'));
check('acknowledgement uses existing department route and removes only local daily item',
  html.includes('/acknowledge') && html.includes('opsTasks.delete(taskId)'));
check('task events invalidate and refresh instead of upserting event payloads',
  html.includes("scheduleOpsTasksRefresh()") &&
  html.includes("_opsHideLeaseWarning(data.task && data.task.id)") &&
  !html.slice(html.indexOf("} else if(['OPS_TASK_CREATED'"), html.indexOf("} else if(data.action === 'mexIncoming'")).includes('opsTasks.set'));
check('reconnect refreshes today list', html.includes('if(WsAuth.isServiceSession()) loadOpsTasks();'));
check('worker identity lifecycle emits changes consumed by the workspace',
  identityModule.includes("new root.CustomEvent('service-worker-identity-change'") &&
  html.includes("window.addEventListener('service-worker-identity-change', _opsHandleWorkerIdentityChange)"));
check('date rollover compares Zurich date to authoritative todayDate',
  html.includes("timeZone:'Europe/Zurich'") && html.includes('_opsZurichDate() !== opsTodayDate'));
check('Mex and countdown handlers remain present',
  html.includes("data.action === 'startCountdown'") && html.includes("data.action === 'mexIncoming'"));

for (const { locale, data } of dictionaries) {
  for (const key of [
    'service.todayTasksSection', 'service.todayTasksLoading', 'service.todayTasksEmpty',
    'service.todayTasksAllDay',
    'service.todayTasksAuthError', 'service.todayTasksSuspended', 'service.todayTasksInactive',
    'service.todayTasksError', 'service.todayTasksRetry', 'service.todayTasksAckError',
    'service.todayTasks.todo', 'service.todayTasks.todoEmpty',
    'service.todayTasks.inProgress', 'service.todayTasks.inProgressEmpty',
    'service.todayTasks.completed', 'service.todayTasks.completedEmpty',
    'service.todayTasksClaim', 'service.todayTasksStart', 'service.todayTasksComplete',
    'service.todayTasksRenew', 'service.todayTasksLeaseWarning', 'service.todayTasksRelease', 'service.todayTasksOwnedBy',
    'service.todayTasksCompletedAt', 'service.todayTasksDue'
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

  const classifyContext = {
    window: {},
    ServiceWorkerIdentity: { getState: () => ({ worker: { id: 'worker-me' }, proof: 'proof' }) },
    Date, Number, String, Map
  };
  classifyContext.window.ServiceWorkerIdentity = classifyContext.ServiceWorkerIdentity;
  vm.createContext(classifyContext);
  vm.runInContext([
    extractFunction('_opsCurrentWorker'), extractFunction('_opsClaimIsActive'),
    extractFunction('_opsPriorityRank'), extractFunction('_opsDueRank'),
    extractFunction('_opsStableCompare'), extractFunction('_opsClassifyTasks')
  ].join(';'), classifyContext);
  const farFuture = Date.now() + 60_000;
  const sections = classifyContext._opsClassifyTasks([
    { id:'low', status:'OPEN', priority:'LOW', dueDate:'2026-09-14' },
    { id:'urgent-late', status:'OPEN', priority:'URGENT', dueDate:'2026-09-14T12:00:00Z' },
    { id:'urgent-early', status:'OPEN', priority:'URGENT', dueDate:'2026-09-14T10:00:00Z' },
    { id:'other', status:'IN_PROGRESS', priority:'URGENT',
      claim:{ status:'ACTIVE', expiresAt:farFuture, workerId:'worker-other', workerName:'Other' } },
    { id:'mine', status:'OPEN', priority:'LOW',
      claim:{ status:'ACTIVE', expiresAt:farFuture, workerId:'worker-me', workerName:'Me' } },
    { id:'released', status:'IN_PROGRESS', priority:'HIGH',
      claim:{ status:'RELEASED', expiresAt:0, workerId:'worker-other', workerName:'Other' } },
    { id:'older', status:'COMPLETED', completedAt:100 },
    { id:'newer', status:'COMPLETED', completedAt:200 }
  ]);
  check('workspace classifies canonical claim and completion states',
    sections.todo.length === 4 && sections.inProgress.length === 2 && sections.completed.length === 2);
  check('to-do ordering is priority, due time, then stable ID',
    sections.todo.map(t => t.id).join(',') === 'urgent-early,urgent-late,released,low');
  check('current worker claims sort before other active claims',
    sections.inProgress.map(t => t.id).join(',') === 'mine,other');
  check('completed tasks sort newest first',
    sections.completed.map(t => t.id).join(',') === 'newer,older');

  const buttonContext = {
    window: {}, ServiceWorkerIdentity: classifyContext.ServiceWorkerIdentity,
    Date, esc: value => String(value), _ot: key => key
  };
  buttonContext.window.ServiceWorkerIdentity = buttonContext.ServiceWorkerIdentity;
  vm.createContext(buttonContext);
  vm.runInContext([
    extractFunction('_opsCurrentWorker'), extractFunction('_opsClaimIsActive'),
    extractFunction('_opsActionButtons')
  ].join(';'), buttonContext);
  check('current worker gets lifecycle controls on their active task',
    buttonContext._opsActionButtons({
      id:'mine', status:'IN_PROGRESS',
      claim:{status:'ACTIVE',expiresAt:farFuture,workerId:'worker-me'}
    }).includes("serviceTaskAction('mine','complete')"));
  check('another worker task and completed task are read-only',
    buttonContext._opsActionButtons({
      id:'other', status:'IN_PROGRESS',
      claim:{status:'ACTIVE',expiresAt:farFuture,workerId:'worker-other'}
    }) === '' && buttonContext._opsActionButtons({id:'done',status:'COMPLETED'}) === '');
  buttonContext.ServiceWorkerIdentity.getState = () => null;
  check('mutation controls are hidden without verified worker context',
    buttonContext._opsActionButtons({id:'open',status:'OPEN'}) === '');

  classifyContext.ServiceWorkerIdentity.getState = () => ({ worker: { id: 'worker-me' }, proof: 'proof' });
  const leaseContext = {
    window: {}, ServiceWorkerIdentity: classifyContext.ServiceWorkerIdentity,
    Date, Number, String, Math, OPS_LEASE_WARNING_MS: 300000
  };
  leaseContext.window.ServiceWorkerIdentity = leaseContext.ServiceWorkerIdentity;
  vm.createContext(leaseContext);
  vm.runInContext([
    extractFunction('_opsCurrentWorker'), extractFunction('_opsLeaseWarningState'),
    extractFunction('_opsFmtLeaseRemaining')
  ].join(';'), leaseContext);
  const now = Date.now();
  check('warning selects only the verified worker active actionable claim near expiry',
    leaseContext._opsLeaseWarningState({
      status:'OPEN', claim:{status:'ACTIVE',workerId:'worker-me',expiresAt:now + 65_000}
    }, now).remainingSeconds === 65 &&
    leaseContext._opsLeaseWarningState({
      status:'IN_PROGRESS', claim:{status:'ACTIVE',workerId:'worker-other',expiresAt:now + 65_000}
    }, now) === null &&
    leaseContext._opsLeaseWarningState({
      status:'IN_PROGRESS', claim:{status:'ACTIVE',workerId:'worker-me',expiresAt:now + 600_000}
    }, now) === null);
  check('display formatting is presentation-only minutes and seconds',
    leaseContext._opsFmtLeaseRemaining(65) === '1:05');
  check('warning markup contains no security metadata',
    html.includes('ops-lease-warning') &&
    !extractFunction('_opsLeaseWarning').includes('leaseId') &&
    !extractFunction('_opsLeaseWarning').includes('workerId') &&
    !extractFunction('_opsLeaseWarning').includes('proof') &&
    !extractFunction('_opsLeaseWarning').includes('serviceActionRevision'));
  check('display expiry reconciles through canonical today refresh without local mutation',
    extractFunction('_opsScheduleLeaseWarnings').includes('loadOpsTasks()') &&
    !extractFunction('_opsScheduleLeaseWarnings').includes('opsTasks.delete') &&
    !extractFunction('_opsScheduleLeaseWarnings').includes("claim.status ="));
  let canonicalRefreshes = 0;
  const expiryContext = {
    window: {}, ServiceWorkerIdentity: classifyContext.ServiceWorkerIdentity,
    Date: { now: () => now }, Number, Math, Infinity, Map,
    OPS_LEASE_WARNING_MS: 300000,
    opsTasksState: 'ready',
    opsTasks: new Map([['claimed-open', {
      id:'claimed-open', status:'OPEN',
      claim:{status:'ACTIVE',workerId:'worker-me',expiresAt:now}
    }]]),
    opsLeaseTimer: null,
    opsLeaseReconcileKey: '',
    clearTimeout() {},
    setTimeout() { throw new Error('expired claim must reconcile immediately'); },
    loadOpsTasks() { canonicalRefreshes++; }
  };
  expiryContext.window.ServiceWorkerIdentity = expiryContext.ServiceWorkerIdentity;
  vm.createContext(expiryContext);
  vm.runInContext([
    extractFunction('_opsCurrentWorker'), extractFunction('_opsClearLeaseTimer'),
    extractFunction('_opsScheduleLeaseWarnings')
  ].join(';'), expiryContext);
  expiryContext._opsScheduleLeaseWarnings();
  expiryContext._opsScheduleLeaseWarnings();
  check('an expired claimed OPEN task requests canonical reconciliation only once',
    canonicalRefreshes === 1 && expiryContext.opsTasks.get('claimed-open').claim.status === 'ACTIVE');
  check('successful action consumes authoritative task before canonical list refresh',
    extractFunction('serviceTaskAction').includes('opsTasks.set(taskId, data.task)'));

  let identityRenders = 0;
  let identityClears = 0;
  const identityContext = {
    renderOpsTasks: () => { identityRenders++; },
    _opsClearLeaseTimer: () => { identityClears++; },
    opsLeaseReconcileKey: 'old'
  };
  vm.createContext(identityContext);
  vm.runInContext(extractFunction('_opsHandleWorkerIdentityChange'), identityContext);
  identityContext._opsHandleWorkerIdentityChange();
  identityContext._opsHandleWorkerIdentityChange();
  identityContext._opsHandleWorkerIdentityChange();
  identityContext._opsHandleWorkerIdentityChange();
  check('verify, handoff, clear and expiry events can rerender controls without a task reload',
    identityRenders === 4 && identityClears === 4 && identityContext.opsLeaseReconcileKey === '');

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