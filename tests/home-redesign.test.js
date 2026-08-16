// tests/home-redesign.test.js — Task 61: home page Service/Operations split.
// Static regression checks over public/home.html and the i18n dictionaries.
// No server needed — the redesign is purely presentational.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'home.html'), 'utf8');

const NEW_KEYS = ['home.serviceSub', 'home.todayService', 'home.opsSectionSub', 'home.opsCardSub', 'home.openOps'];
const LOCALES = ['it', 'fr', 'en'];

test('two distinct sections render: #pt-service-section and #pt-ops-section', () => {
  assert.match(html, /<section id="pt-service-section" class="pt-section pt-service-section">/);
  assert.match(html, /<section id="pt-ops-section" class="pt-section pt-ops-section">/);
  // Service section comes before Operations section
  assert.ok(html.indexOf('pt-service-section') < html.indexOf('pt-ops-section'));
});

test('section headings and localized subtitles present', () => {
  assert.match(html, /PLATETIMER SERVICE/);
  assert.match(html, /PLATETIMER OPERATIONS/);
  assert.match(html, /data-i18n="home.serviceSub"/);
  assert.match(html, /data-i18n="home.opsSectionSub"/);
});

test('department cards remain dynamic inside the Service section', () => {
  const svc = html.slice(html.indexOf('id="pt-service-section"'), html.indexOf('id="pt-ops-section"'));
  assert.match(svc, /id="dept-section"/);
  assert.match(svc, /id="dept-grid"/);
  // JS still populates the grid from the API
  assert.match(html, /fetch\('\/api\/departments'/);
  assert.match(html, /loadDepartmentsGrid/);
});

test('all Service tool routes unchanged and inside Service section', () => {
  const svc = html.slice(html.indexOf('id="pt-service-section"'), html.indexOf('id="pt-ops-section"'));
  for (const href of ['sala.html', 'calendar.html', 'admin-departments.html', 'history.html']) {
    assert.match(svc, new RegExp(`href="${href}"`), `missing ${href} in Service section`);
  }
});

test('Today preview lives in Service section and uses the Service calendar API only', () => {
  const svc = html.slice(html.indexOf('id="pt-service-section"'), html.indexOf('id="pt-ops-section"'));
  assert.match(svc, /id="today-summary"/);
  assert.match(svc, /id="today-summary-body"/);
  assert.match(html, /fetch\('\/api\/calendar\/events\/upcoming'/);
  // loadCalendarSummary must not reference any Operations endpoint
  const js = html.slice(html.indexOf('async function loadCalendarSummary'), html.indexOf('function escHome'));
  assert.ok(!/\/api\/operations/.test(js), 'Today preview must not hit Operations endpoints');
});

test('Operations renders as a single entry card linking to operations.html', () => {
  const ops = html.slice(html.indexOf('id="pt-ops-section"'), html.indexOf('</main>'));
  const cards = ops.match(/nav-card/g) || [];
  assert.strictEqual(cards.length, 1, 'exactly one nav-card in Operations section');
  assert.match(ops, /href="operations.html"/);
  assert.match(ops, /ops-entry-card/);
  assert.match(ops, /data-i18n="home.operations"/);
  assert.match(ops, /data-i18n="home.opsCardSub"/);
  assert.match(ops, /data-i18n="home.openOps"/);
  // operations.html is linked exactly once in the whole page
  assert.strictEqual((html.match(/href="operations.html"/g) || []).length, 1);
});

test('no role-dispatch logic added to home page (routing unchanged)', () => {
  // The existing server-driven redirect block is preserved verbatim
  assert.match(html, /sessData\.isOperations && sessData\.opsRole !== 'DIRECTOR'/);
  assert.match(html, /window\.location\.href = 'operations.html'/);
  // No new role branching on the Operations card itself
  const ops = html.slice(html.indexOf('id="pt-ops-section"'), html.indexOf('</main>'));
  assert.ok(!/onclick/.test(ops), 'Operations entry card must be a plain link');
});

test('authorization wiring untouched: identity routing, suspended/error states', () => {
  assert.match(html, /resolveIdentityAndRoute/);
  assert.match(html, /id="suspended-msg"/);
  assert.match(html, /id="dept-error-msg"/);
  assert.match(html, /\/api\/service\/identity/);
  assert.match(html, /_identityResolved/);
});

test('preserved element IDs and i18n attributes', () => {
  for (const id of ['dept-section', 'dept-grid', 'today-summary', 'today-summary-body', 'cal-notif-badge', 'company-name', 'hdr-company', 'logo-monogram', 'logo-img', 'i18n-home-sel']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing id ${id}`);
  }
  for (const k of ['home.floor', 'home.calendar', 'home.operations', 'home.adminDepts', 'home.history', 'home.depts', 'home.functions']) {
    assert.match(html, new RegExp(`data-i18n="${k}"`), `missing data-i18n ${k}`);
  }
});

test('all three locale files are valid JSON and contain the five new keys', () => {
  for (const l of LOCALES) {
    const raw = fs.readFileSync(path.join(PUB, 'i18n', `${l}.json`), 'utf8');
    let dict;
    assert.doesNotThrow(() => { dict = JSON.parse(raw); }, `${l}.json invalid JSON`);
    for (const k of NEW_KEYS) {
      assert.strictEqual(typeof dict[k], 'string', `${l}.json missing ${k}`);
      assert.ok(dict[k].length > 0);
    }
    // Existing keys preserved
    for (const k of ['home.floor', 'home.calendar', 'home.operations', 'home.adminDepts', 'home.history', 'home.todayLabel']) {
      assert.strictEqual(typeof dict[k], 'string', `${l}.json lost ${k}`);
    }
  }
});

test('responsive CSS: pt-section styles, breakpoints, no horizontal overflow', () => {
  assert.match(html, /\.pt-section\{/);
  assert.match(html, /\.pt-section-hdr\{/);
  assert.match(html, /\.pt-section-sub\{/);
  assert.match(html, /\.pt-ops-section\{background:#101722/);
  assert.match(html, /\.ops-entry-cta\{/);
  // existing breakpoints still stack the grids
  assert.match(html, /@media\(max-width:700px\)\{\.card-grid\{grid-template-columns:repeat\(2,1fr\);\}\}/);
  assert.match(html, /@media\(max-width:440px\)\{\.card-grid\{grid-template-columns:1fr;\}\}/);
  // no forced horizontal overflow introduced
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(!/overflow-x\s*:\s*(scroll|auto)/.test(style));
  // CTA keeps a ≥44px touch target
  assert.match(style, /min-height:44px/);
});

test('CTA meets touch-target minimum via padding + min-height', () => {
  assert.match(html, /\.ops-entry-cta\{[^}]*min-height:44px/s);
});
