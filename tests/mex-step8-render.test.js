#!/usr/bin/env node
/**
 * Mex Step 8 — Close / Resolve: Rendering Tests
 *
 * Plain Node.js + jsdom (same pattern as mex-step4-render.test.js).
 *
 * §14 Rendering tests:
 *  - Successful close removes correct card, mexCdCards entry removed
 *  - Unrelated Mex cards remain
 *  - Countdown cards remain
 *  - Empty state restored only when no active cards remain
 *  - Remote participant (mexClosed) removes card
 *  - Close failure leaves card visible, re-enables button
 */

'use strict';

const { JSDOM }   = require('jsdom');
const pathmod     = require('path');
const fs          = require('fs');

let passed = 0, failed = 0;
function ok(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else { console.error(`  ❌ ${label}` + (hint !== undefined ? ` — got: ${JSON.stringify(hint)}` : '')); failed++; }
}

// ── Build minimal DOM ─────────────────────────────────────────────────────────
function buildDom() {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
        <div id="cd-list">
            <div class="empty-state">Nessun countdown attivo.</div>
        </div>
        <div id="ra-count">0</div>
    </body></html>`, { url: 'http://localhost' });
    const { window } = dom;
    const { document } = window;

    // i18n shim — must be set before loading the script so _mt() works
    const I18N = JSON.parse(fs.readFileSync(pathmod.join(__dirname, '../public/i18n/it.json'), 'utf8'));
    window._mt = k => I18N[k] !== undefined ? I18N[k] : k;
    // Also shim window.I18n so the script's own `function _mt(k) { window.I18n?.t(k) }` resolves correctly
    window.I18n = { t: k => I18N[k] !== undefined ? I18N[k] : k };

    // WebSocket constructor shim — department.html does `ws = new WebSocket(url)` inside DOMContentLoaded.
    // We need a singleton that captures the instance so tests can inspect ws._sent.
    window._fakeWsSent = [];
    window._fakeWsReadyState = 1;
    window.WebSocket = class FakeWS {
        constructor(_url) {
            this.readyState = window._fakeWsReadyState;
            this._sent      = window._fakeWsSent;
            this.onopen = this.onmessage = this.onclose = this.onerror = null;
            window._fakeWsInstance = this;  // expose for assertions
        }
        send(msg)  { window._fakeWsSent.push(JSON.parse(msg)); }
        close()    {}
    };
    window.WebSocket.OPEN = 1;

    // Shim WsAuth
    window.WsAuth = {
        isServiceSession:  () => true,
        getStoredToken:    () => 'test-token',
        isAuthenticated:   () => true,
        getSession:        () => ({ uid: 'test-uid', companyName: 'coTest' })
    };

    // Shim MexQR — mex-qr.js uses `window` at module level; set global.window before require.
    const _prevWindow = global.window;
    global.window = window;
    try { require('../public/js/mex-qr.js'); } catch (_) {}
    global.window = _prevWindow;
    window.MexQR = global.MexQR || window.MexQR;

    // Shim departmentMap
    window.departmentMap = {
        'dept-a': { id: 'dept-a', name: 'Cucina', active: true },
        'dept-b': { id: 'dept-b', name: 'Pizzeria', active: true }
    };

    // Shim ws
    window.ws = { readyState: 1, _sent: [], send(msg) { this._sent.push(JSON.parse(msg)); } };

    // Shim countdowns for renderCards
    window.countdowns = new Map();
    window.renderCards = function() {
        const list = document.getElementById('cd-list');
        // Remove ONLY the empty-state placeholder (not countdown cards or mex cards)
        list.querySelectorAll('.empty-state').forEach(el => el.remove());
        const hasMex       = !!list.querySelector('.mex-cd-card');
        const hasCountdown = !!list.querySelector('.countdown-card');
        if (!hasMex && !hasCountdown && !window.countdowns.size) {
            const e = document.createElement('div');
            e.className = 'empty-state';
            e.textContent = 'Nessun countdown attivo.';
            list.insertAdjacentElement('afterbegin', e);
        }
    };

    // playMexSound is a no-op in tests
    window.playMexSound = () => {};

    return { dom, window, document };
}

// Extract the largest inline script from department.html
function extractDeptScript() {
    const html = fs.readFileSync(pathmod.join(__dirname, '../public/department.html'), 'utf8');
    const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    return matches.map(m => m[1]).reduce((a, b) => a.length > b.length ? a : b, '');
}

function loadDeptFunctions(window, document) {
    const script = extractDeptScript();
    const fn = new window.Function('window', 'document', `
        with(window) {
            ${script}
            // Expose functions we need
            window.insertMexCdCard     = typeof insertMexCdCard !== 'undefined'     ? insertMexCdCard     : null;
            window.removeMexCdCard     = typeof removeMexCdCard !== 'undefined'     ? removeMexCdCard     : null;
            window.closeMexConv        = typeof closeMexConv !== 'undefined'        ? closeMexConv        : null;
            window.handleMexCloseAck   = typeof handleMexCloseAck !== 'undefined'   ? handleMexCloseAck   : null;
            window.handleMexClosed     = typeof handleMexClosed !== 'undefined'     ? handleMexClosed     : null;
            window.mexSetCloseStatus   = typeof mexSetCloseStatus !== 'undefined'   ? mexSetCloseStatus   : null;
            window._mexCdCards          = typeof mexCdCards  !== 'undefined' ? mexCdCards  : null;
            window._scriptCountdowns    = typeof countdowns  !== 'undefined' ? countdowns  : null;
        }
    `);
    fn(window, document);
}

function makeMsg(convId, id) {
    return {
        id:        id || convId,
        convId,
        from:      'dept-a',
        fromName:  'Cucina',
        body:      'Test message',
        timestamp: new Date().toISOString(),
        replies:   []
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════');
console.log('Mex Step 8 Rendering tests');
console.log('══════════════════════════════════════════════════════\n');

// ── §1. Close button present on card ─────────────────────────────────────────
console.log('  — 1. Close button on card —\n');
{
    const { window, document } = buildDom();
    loadDeptFunctions(window, document);
    const convId = 'mexconv_test01';
    window.insertMexCdCard(makeMsg(convId), false);
    const card = document.getElementById('mex-cd-' + convId);
    ok('1a. Card inserted', !!card);
    const btn = card?.querySelector('.mex-close-btn');
    ok('1b. Close button present', !!btn);
    ok('1c. Close button text', btn?.textContent?.includes('Chiudi'));
    const statusEl = document.getElementById('mex-close-status-' + convId);
    ok('1d. Close status div present', !!statusEl);
}

// ── §2. removeMexCdCard removes card + cleans mexCdCards ─────────────────────
console.log('\n  — 2. removeMexCdCard —\n');
{
    const { window, document } = buildDom();
    loadDeptFunctions(window, document);
    const convId = 'mexconv_test02';
    window.insertMexCdCard(makeMsg(convId), false);
    ok('2a. Card in DOM', !!document.getElementById('mex-cd-' + convId));
    ok('2b. mexCdCards has entry', window._mexCdCards?.has(convId));
    window.removeMexCdCard(convId);
    ok('2c. Card removed from DOM', !document.getElementById('mex-cd-' + convId));
    ok('2d. mexCdCards entry removed', !window._mexCdCards?.has(convId));
}

// ── §3. Empty state restored when last card removed ───────────────────────────
console.log('\n  — 3. Empty state restored —\n');
{
    const { window, document } = buildDom();
    loadDeptFunctions(window, document);
    const convId = 'mexconv_test03';
    window.insertMexCdCard(makeMsg(convId), false);
    ok('3a. Empty state removed when card inserted', !document.querySelector('.empty-state'));
    window.removeMexCdCard(convId);
    ok('3b. Empty state restored after last card removed', !!document.querySelector('.empty-state'));
}

// ── §4. Unrelated Mex cards remain after one card is closed ──────────────────
console.log('\n  — 4. Unrelated cards survive —\n');
{
    const { window, document } = buildDom();
    loadDeptFunctions(window, document);
    window.insertMexCdCard(makeMsg('mexconv_A'), false);
    window.insertMexCdCard(makeMsg('mexconv_B'), false);
    ok('4a. Both cards present', !!document.getElementById('mex-cd-mexconv_A') && !!document.getElementById('mex-cd-mexconv_B'));
    window.removeMexCdCard('mexconv_A');
    ok('4b. A removed', !document.getElementById('mex-cd-mexconv_A'));
    ok('4c. B still present', !!document.getElementById('mex-cd-mexconv_B'));
    ok('4d. No empty state (B still there)', !document.querySelector('.empty-state'));
    ok('4e. mexCdCards: A removed, B present',
        !window._mexCdCards?.has('mexconv_A') && window._mexCdCards?.has('mexconv_B'));
}

// ── §5. Active countdowns in Map prevent empty-state after Mex card removed ───
// The real renderCards() rebuilds countdown cards from the `countdowns` Map.
// When the Map has entries, no empty-state is shown even if no Mex cards remain.
console.log('\n  — 5. Countdowns Map prevents empty-state —\n');
{
    const { window, document } = buildDom();
    loadDeptFunctions(window, document);

    // Populate the SCRIPT's own countdowns Map (exposed as _scriptCountdowns).
    // window.countdowns is our shim, but renderCards() reads the script-local `countdowns`.
    const cdMap = window._scriptCountdowns || window.countdowns;
    cdMap.set('tbl_1', {
        id: 'tbl_1', tableNumber: 1, time: 60, status: 'active',
        recipientId: 'dept-b', recipientName: 'Pizzeria'
    });

    window.insertMexCdCard(makeMsg('mexconv_C'), false);
    ok('5a. Mex card present with countdown in Map', !!document.getElementById('mex-cd-mexconv_C'));
    window.removeMexCdCard('mexconv_C');
    ok('5b. Mex card removed', !document.getElementById('mex-cd-mexconv_C'));
    ok('5c. No empty-state when countdowns Map non-empty', !document.querySelector('.empty-state'));

    // Clean up for subsequent tests
    window.countdowns.clear();
}

// ── §6. handleMexCloseAck (success) removes card ──────────────────────────────
console.log('\n  — 6. handleMexCloseAck success —\n');
{
    const { window, document } = buildDom();
    loadDeptFunctions(window, document);
    const convId = 'mexconv_test06';
    window.insertMexCdCard(makeMsg(convId), false);
    ok('6a. Card present before ack', !!document.getElementById('mex-cd-' + convId));
    window.handleMexCloseAck({ success: true, conversationId: convId, alreadyClosed: false });
    ok('6b. Card removed after success ack', !document.getElementById('mex-cd-' + convId));
    ok('6c. mexCdCards entry gone', !window._mexCdCards?.has(convId));
}

// ── §7. handleMexCloseAck (failure) keeps card + re-enables button ────────────
console.log('\n  — 7. handleMexCloseAck failure —\n');
{
    const { window, document } = buildDom();
    loadDeptFunctions(window, document);
    const convId = 'mexconv_test07';
    window.insertMexCdCard(makeMsg(convId), false);
    // Simulate in-flight state: disable button
    const btn = document.getElementById('mex-close-btn-' + convId);
    if (btn) { btn.disabled = true; btn.textContent = 'Chiusura…'; }
    // Server returns failure
    window.handleMexCloseAck({ success: false, conversationId: convId, code: 'MEX_NOT_PARTICIPANT' });
    ok('7a. Card still present', !!document.getElementById('mex-cd-' + convId));
    ok('7b. mexCdCards entry preserved', window._mexCdCards?.has(convId));
    const btn2 = document.getElementById('mex-close-btn-' + convId);
    ok('7c. Button re-enabled', !btn2?.disabled);
    ok('7d. Button text restored', btn2?.textContent?.includes('Chiudi'));
    const statusEl = document.getElementById('mex-close-status-' + convId);
    ok('7e. Error status shown', (statusEl?.textContent || '').length > 0);
    ok('7f. Status has err class', statusEl?.classList?.contains('err'));
}

// ── §8. handleMexClosed (remote participant closed) removes card ───────────────
console.log('\n  — 8. handleMexClosed (remote) —\n');
{
    const { window, document } = buildDom();
    loadDeptFunctions(window, document);
    const convId = 'mexconv_test08';
    window.insertMexCdCard(makeMsg(convId), false);
    ok('8a. Card present', !!document.getElementById('mex-cd-' + convId));
    window.handleMexClosed({ conversationId: convId, closedBy: 'dept-b' });
    ok('8b. Card removed by remote close', !document.getElementById('mex-cd-' + convId));
    ok('8c. mexCdCards cleaned', !window._mexCdCards?.has(convId));
}

// ── §9. closeMexConv registered + error path when WS not ready ────────────────
// (WS send path covered by lifecycle integration tests; here we verify the
//  function is exposed and handles a missing ws gracefully.)
console.log('\n  — 9. closeMexConv registered & no-ws error path —\n');
{
    const { window, document } = buildDom();
    loadDeptFunctions(window, document);
    const convId = 'mexconv_test09';
    window.insertMexCdCard(makeMsg(convId), false);

    ok('9a. closeMexConv is a function', typeof window.closeMexConv === 'function');
    // Call with no ws initialised — should show error status, not crash
    let threw = false;
    try { window.closeMexConv(convId); } catch (_) { threw = true; }
    ok('9b. closeMexConv does not throw when ws missing', !threw);
    // Card still present (no optimistic removal on error path)
    ok('9c. Card still present after no-ws call', !!document.getElementById('mex-cd-' + convId));
}

// ── §10. i18n keys present ────────────────────────────────────────────────────
console.log('\n  — 10. i18n keys —\n');
{
    const CLOSE_KEYS = ['mex.close.btn', 'mex.close.closing', 'mex.close.done', 'mex.close.error'];
    for (const lang of ['it', 'en', 'fr']) {
        const d = JSON.parse(fs.readFileSync(pathmod.join(__dirname, `../public/i18n/${lang}.json`), 'utf8'));
        const missing = CLOSE_KEYS.filter(k => !d[k]);
        ok(`10a. ${lang}.json has all mex.close.* keys`, missing.length === 0, missing);
    }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────');
console.log(`Mex Step 8 Rendering: ${passed} passed, ${failed} failed`);
if (!failed) console.log('✅ All Mex Step 8 Rendering tests passed.');
else console.error(`❌ ${failed} test(s) failed.`);
console.log('──────────────────────────────────────────────────────\n');
process.exit(failed ? 1 : 0);
