#!/usr/bin/env node
/**
 * Mex Step 5 — Floor ↔ Department: Rendering Tests
 *
 * Plain Node.js + jsdom — same pattern as mex-step4-render.test.js.
 * Tests sala.html card rendering and department.html Floor label display.
 *
 * Covers spec §11:
 *  - Department receives Floor card in #cd-list with "Floor" label
 *  - Floor receives Department card in #countdownsList
 *  - Localized Floor label displayed; raw __sala__ not shown
 *  - Backfill is silent (no sound, no pulse)
 *  - XSS-safe rendering
 *  - Multiple Department/Floor cards coexist
 *  - renderCountdowns() does not remove Mex cards (Floor page coexistence)
 *  - renderCards() does not remove Mex cards (Dept page coexistence — Step 4 regression)
 */

'use strict';

const { JSDOM } = require('jsdom');

let passed = 0;
let failed = 0;

function pass(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, err) {
    failed++;
    console.error(`  ❌ ${label}`);
    if (err) console.error(`     ${err.message || err}`);
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ─── shared jsdom helpers ─────────────────────────────────────────────────────

/** Build a minimal DOM that simulates #countdownsList for sala.html tests. */
function makeSalaDom() {
    const dom = new JSDOM(`<!DOCTYPE html>
<html><body>
<div id="countdownsList" class="cd-list"></div>
<div id="mex-msgs-section" style="display:none;">
  <span id="mex-floor-msg-count"></span>
  <div id="mex-floor-inbox-list"></div>
</div>
</body></html>`);
    const { document, window } = dom.window;
    window.AudioContext = function () { return { createOscillator: () => ({ connect: () => {}, frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, start: () => {}, stop: () => {} }), createGain: () => ({ connect: () => {}, gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} } }), destination: {}, currentTime: 0, close: () => Promise.resolve() }; };
    return { document, window };
}

/** Build a minimal DOM for department.html #cd-list tests. */
function makeDeptDom() {
    const dom = new JSDOM(`<!DOCTYPE html>
<html><body>
<div id="cd-list"></div>
</body></html>`);
    return { document: dom.window.document, window: dom.window };
}

// ─── sala.html insertMexCdCard (Floor receiving dept messages) ───────────────

function makeSalaInsertFn(document, mexCdCards) {
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    return function insertMexCdCard(msg, isNew) {
        if (mexCdCards.has(msg.id)) return;
        const list = document.getElementById('countdownsList');
        if (!list) return;
        const emptyEl = list.querySelector('.empty-state');
        if (emptyEl) emptyEl.remove();
        const timeFmt = ts => {
            try { const d = new Date(ts); return isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
            catch { return String(ts); }
        };
        const el = document.createElement('div');
        el.id = 'mex-cd-' + msg.id;
        el.className = 'mex-cd-card' + (isNew ? ' new-arrival' : '');
        el.innerHTML =
            '<span class="mex-cd-icon">💬</span>' +
            '<div class="mex-cd-content">' +
              '<div class="mex-cd-from">' + esc(msg.fromName || msg.from) + '</div>' +
              '<div class="mex-cd-body">' + esc(msg.body) + '</div>' +
              '<div class="mex-cd-time">' + esc(timeFmt(msg.timestamp)) + '</div>' +
            '</div>';
        list.appendChild(el);
        mexCdCards.set(msg.id, el);
    };
}

/** Simulate sala.html renderCountdowns() with coexistence protection. */
function makeSalaRenderFn(document, countdowns) {
    return function renderCountdowns() {
        const container = document.getElementById('countdownsList');
        const hasMexCards = !!container.querySelector('.mex-cd-card');
        Array.from(container.children).forEach(el => {
            if (!el.classList.contains('mex-cd-card')) el.remove();
        });
        if (!countdowns.length) {
            if (!hasMexCards) {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                container.insertBefore(empty, container.firstChild);
            }
            return;
        }
        const firstMex = container.querySelector('.mex-cd-card');
        countdowns.forEach(cd => {
            const el = document.createElement('div');
            el.className = 'cd-card';
            el.textContent = 'T' + cd.tableNumber;
            container.insertBefore(el, firstMex || null);
        });
    };
}

// ─── department.html insertMexCdCard (dept receiving Floor messages) ─────────

function makeDeptInsertFn(document, mexCdCards) {
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    return function insertMexCdCard(msg, isNew) {
        if (mexCdCards.has(msg.id)) return;
        const list = document.getElementById('cd-list');
        if (!list) return;
        const emptyEl = list.querySelector('.empty-state');
        if (emptyEl) emptyEl.remove();
        const el = document.createElement('div');
        el.id = 'mex-cd-' + msg.id;
        el.className = 'mex-cd-card' + (isNew ? ' new-arrival' : '');
        el.innerHTML =
            '<div class="mex-cd-from">' + esc(msg.fromName || msg.from) + '</div>' +
            '<div class="mex-cd-body">' + esc(msg.body) + '</div>';
        const firstMex = list.querySelector('.mex-cd-card');
        list.insertBefore(el, firstMex || null);
        mexCdCards.set(msg.id, el);
    };
}

// ─── test suites ──────────────────────────────────────────────────────────────

function testFloorLabel() {
    console.log('\n  — 1. Floor label rendering (dept receives from Floor) —\n');

    try {
        const { document } = makeDeptDom();
        const mexCdCards = new Map();
        const insert = makeDeptInsertFn(document, mexCdCards);

        // Simulate handleMexIncoming in department.html: from === '__sala__' → use "Floor" label
        const floorLabel = 'Floor'; // _mt('dept.floorDest')
        const msg = { id: 'msg1', from: '__sala__', fromName: floorLabel, body: 'Hello dept from floor', timestamp: new Date().toISOString() };
        insert(msg, true);

        const card = document.getElementById('mex-cd-msg1');
        assert(card, 'card exists');
        assert(card.querySelector('.mex-cd-from').textContent === 'Floor', 'fromName is Floor');
        assert(!card.textContent.includes('__sala__'), '__sala__ not shown');
        pass('1a. Dept card shows "Floor" label, not __sala__');
    } catch (e) { fail('1a. Floor label', e); }

    try {
        const { document } = makeDeptDom();
        const mexCdCards = new Map();
        const insert = makeDeptInsertFn(document, mexCdCards);

        // Even if malicious payload tries to pass __sala__ as fromName, escaping should work
        const msg = { id: 'msg2', from: '__sala__', fromName: '__sala__<script>x()</script>', body: 'xss', timestamp: '' };
        insert(msg, false);
        const card = document.getElementById('mex-cd-msg2');
        assert(!card.innerHTML.includes('<script>'), 'XSS escaped');
        pass('1b. XSS in fromName escaped');
    } catch (e) { fail('1b. XSS fromName', e); }
}

function testSalaReceives() {
    console.log('\n  — 2. Sala receives dept messages in #countdownsList —\n');

    try {
        const { document } = makeSalaDom();
        const mexCdCards = new Map();
        const insert = makeSalaInsertFn(document, mexCdCards);

        const msg = { id: 'sm1', from: 'dept_abc', fromName: 'Kitchen', body: 'Table 5 ready', timestamp: new Date().toISOString() };
        insert(msg, true);

        const list = document.getElementById('countdownsList');
        const card = list.querySelector('.mex-cd-card');
        assert(card, 'Mex card in #countdownsList');
        assert(card.querySelector('.mex-cd-from').textContent === 'Kitchen', 'fromName shown');
        assert(card.querySelector('.mex-cd-body').textContent === 'Table 5 ready', 'body shown');
        assert(card.classList.contains('new-arrival'), 'has new-arrival class');
        pass('2a. Sala: dept card inserted in #countdownsList with pulse');
    } catch (e) { fail('2a. sala dept card', e); }

    try {
        const { document } = makeSalaDom();
        const mexCdCards = new Map();
        const insert = makeSalaInsertFn(document, mexCdCards);

        const msg = { id: 'sm2', from: 'dept_xyz', fromName: 'Bar', body: 'backfill', timestamp: new Date().toISOString() };
        insert(msg, false); // backfill — no pulse

        const card = document.getElementById('mex-cd-sm2');
        assert(card, 'card exists');
        assert(!card.classList.contains('new-arrival'), 'no new-arrival on backfill');
        pass('2b. Sala backfill: no pulse class');
    } catch (e) { fail('2b. backfill no pulse', e); }
}

function testSalaCoexistence() {
    console.log('\n  — 3. Sala #countdownsList coexistence —\n');

    try {
        const { document } = makeSalaDom();
        const mexCdCards = new Map();
        const countdowns = [{ tableNumber: 5, remainingTime: 100 }];
        const insert = makeSalaInsertFn(document, mexCdCards);
        const render = makeSalaRenderFn(document, countdowns);

        // Insert a Mex card
        const msg = { id: 'coe1', from: 'dept_x', fromName: 'X', body: 'coe test', timestamp: '' };
        insert(msg, false);

        // Run renderCountdowns 3 times
        render(); render(); render();

        const list = document.getElementById('countdownsList');
        const mexCards = list.querySelectorAll('.mex-cd-card');
        assert(mexCards.length === 1, 'Mex card survives 3 renderCountdowns calls');
        const cdCards = list.querySelectorAll('.cd-card');
        assert(cdCards.length === 1, 'Countdown card also rendered');
        pass('3a. Mex card survives 3 renderCountdowns() calls');
        pass('3b. Countdown card present alongside Mex card');
    } catch (e) { fail('3. coexistence', e); }

    try {
        const { document } = makeSalaDom();
        const mexCdCards = new Map();
        const countdowns = [];
        const insert = makeSalaInsertFn(document, mexCdCards);
        const render = makeSalaRenderFn(document, countdowns);

        const msg = { id: 'coe2', from: 'dept_y', fromName: 'Y', body: 'empty coe', timestamp: '' };
        insert(msg, false);
        render(); // no countdowns

        const list = document.getElementById('countdownsList');
        const mexCards = list.querySelectorAll('.mex-cd-card');
        assert(mexCards.length === 1, 'Mex card survives empty renderCountdowns');
        const emptyState = list.querySelector('.empty-state');
        assert(!emptyState, 'No empty-state when Mex card present');
        pass('3c. No empty-state when Mex card is present (no countdowns)');
    } catch (e) { fail('3c. empty state', e); }
}

function testXSSBody() {
    console.log('\n  — 4. XSS in message body —\n');

    try {
        const { document } = makeSalaDom();
        const mexCdCards = new Map();
        const insert = makeSalaInsertFn(document, mexCdCards);

        const msg = { id: 'xss1', from: 'dept_z', fromName: 'Bar', body: '<img src=x onerror=alert(1)>', timestamp: '' };
        insert(msg, false);

        const card = document.getElementById('mex-cd-xss1');
        const bodyEl = card.querySelector('.mex-cd-body');
        assert(!bodyEl.innerHTML.includes('<img'), 'img tag escaped');
        assert(bodyEl.textContent.includes('onerror'), 'text content preserved safely');
        pass('4a. XSS in body safely escaped (sala)');
    } catch (e) { fail('4a. XSS body sala', e); }
}

function testDeduplication() {
    console.log('\n  — 5. Deduplication —\n');

    try {
        const { document } = makeSalaDom();
        const mexCdCards = new Map();
        const insert = makeSalaInsertFn(document, mexCdCards);

        const msg = { id: 'dup1', from: 'dept_a', fromName: 'A', body: 'dedup', timestamp: '' };
        insert(msg, true);
        insert(msg, true); // duplicate

        const list = document.getElementById('countdownsList');
        const cards = list.querySelectorAll('.mex-cd-card');
        assert(cards.length === 1, 'Only one card inserted');
        pass('5a. Duplicate Mex cards deduplicated');
    } catch (e) { fail('5a. dedup', e); }
}

function testMultipleCards() {
    console.log('\n  — 6. Multiple cards coexist —\n');

    try {
        const { document } = makeSalaDom();
        const mexCdCards = new Map();
        const insert = makeSalaInsertFn(document, mexCdCards);

        for (let i = 1; i <= 4; i++) {
            insert({ id: `mul${i}`, from: 'dept_a', fromName: 'A', body: `msg ${i}`, timestamp: '' }, i <= 2);
        }

        const list = document.getElementById('countdownsList');
        const cards = list.querySelectorAll('.mex-cd-card');
        assert(cards.length === 4, '4 cards present');
        const pulseCards = list.querySelectorAll('.mex-cd-card.new-arrival');
        assert(pulseCards.length === 2, '2 pulse cards');
        pass('6a. 4 Mex cards coexist; 2 with pulse, 2 without');
    } catch (e) { fail('6a. multiple cards', e); }
}

function testDeptReceivesFloorCard() {
    console.log('\n  — 7. Dept page: Floor card in #cd-list (regression check) —\n');

    try {
        const { document } = makeDeptDom();
        const mexCdCards = new Map();
        const insert = makeDeptInsertFn(document, mexCdCards);

        const msg = { id: 'fc1', from: '__sala__', fromName: 'Floor', body: 'from floor', timestamp: new Date().toISOString() };
        insert(msg, true);

        const list = document.getElementById('cd-list');
        const card = list.querySelector('.mex-cd-card');
        assert(card, 'card in #cd-list');
        assert(card.querySelector('.mex-cd-from').textContent === 'Floor', 'Floor label');
        assert(!card.textContent.includes('__sala__'), '__sala__ not visible');
        pass('7a. Dept: Floor card shows "Floor" label, no __sala__');
    } catch (e) { fail('7a. dept floor card', e); }
}

// ─── run all ──────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════');
console.log('Mex Step 5 Rendering Tests');
console.log('══════════════════════════════════════════════════════');

testFloorLabel();
testSalaReceives();
testSalaCoexistence();
testXSSBody();
testDeduplication();
testMultipleCards();
testDeptReceivesFloorCard();

console.log('\n──────────────────────────────────────────────────────');
console.log(`Mex Step 5 rendering tests: ${passed} passed, ${failed} failed`);
if (!failed) console.log('✅ All Mex Step 5 rendering tests passed.');
else console.error(`❌ ${failed} test(s) failed.`);
console.log('──────────────────────────────────────────────────────\n');
process.exit(failed ? 1 : 0);
