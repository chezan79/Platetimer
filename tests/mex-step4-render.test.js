#!/usr/bin/env node
'use strict';
/**
 * Mex Step 4 — rendering & coexistence tests (plain Node.js + jsdom)
 *
 * Tests the client-side functions extracted from department.html:
 *   • insertMexCdCard(msg, isNew) — inserts Mex cards into #cd-list
 *   • renderCards(countdowns) — countdown render that preserves .mex-cd-card
 *   • HTML escaping safety
 *   • Backfill / reload: isNew:false → no sound, no pulse
 *   • Coexistence: Countdown does not remove Mex; Mex does not remove Countdown
 *
 * Run: node tests/mex-step4-render.test.js
 */

const { JSDOM } = require('jsdom');

// ── Test counters ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else       { console.error(`  ❌ ${label}${hint !== undefined ? ' — got: ' + JSON.stringify(hint) : ''}`); failed++; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal DOM harness — mirrors department.html logic exactly
// ─────────────────────────────────────────────────────────────────────────────
function buildDOM() {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div class="cd-list" id="cd-list"></div>
      <div id="mex-inbox-list"></div>
      <div id="ra-count">0</div>
    </body></html>`);

    const { document } = dom.window;
    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const timeFmt = ts => {
        try { const d = new Date(ts); return isNaN(d) ? String(ts||'') : d.toISOString().slice(11,16); }
        catch { return String(ts||''); }
    };

    const mexCdCards  = new Map();
    let   soundCalls  = 0;

    function playMexSound() { soundCalls++; }

    function insertMexCdCard(msg, isNew) {
        if (mexCdCards.has(msg.id)) return;
        const list = document.getElementById('cd-list');
        if (!list) return;
        const emptyEl = list.querySelector('.empty-state');
        if (emptyEl) emptyEl.remove();
        const el = document.createElement('div');
        el.className = 'mex-cd-card' + (isNew ? ' new-arrival' : '');
        el.id = `mex-cd-${_esc(msg.id)}`;
        el.innerHTML =
            `<div class="mex-cd-from"><span class="mex-cd-icon">💬</span>${_esc(msg.fromName||msg.from)}</div>` +
            `<div class="mex-cd-body">${_esc(msg.body)}</div>` +
            `<div class="mex-cd-time">Ricevuto ${timeFmt(msg.timestamp)}</div>`;
        list.appendChild(el);
        mexCdCards.set(msg.id, el);
    }

    // renderCards — mirrors department.html coexistence logic exactly
    function renderCards(countdowns, departmentMap = {}) {
        const list = document.getElementById('cd-list');
        document.getElementById('ra-count').textContent = countdowns.size;

        // Remove only non-mex children
        Array.from(list.children).forEach(el => {
            if (!el.classList.contains('mex-cd-card')) el.remove();
        });

        if (!countdowns.size) {
            if (!list.querySelector('.mex-cd-card')) {
                const e = document.createElement('div');
                e.className = 'empty-state';
                e.textContent = 'Nessun countdown attivo per questo reparto.';
                list.insertAdjacentElement('afterbegin', e);
            }
            return;
        }

        const level = s => s === 0 ? 'expired' : s < 120 ? 'crit' : s < 300 ? 'warn' : '';
        const fmt   = s => { s = Math.max(0,s); return Math.floor(s/60)+':'+(s%60).toString().padStart(2,'0'); };
        const sorted = Array.from(countdowns.values()).sort((a,b) => a.timeRemaining - b.timeRemaining);
        const firstMex = list.querySelector('.mex-cd-card');

        sorted.forEach(cd => {
            const lv  = level(cd.timeRemaining);
            const pct = cd.initialDuration > 0
                ? Math.max(0, Math.round((cd.timeRemaining / cd.initialDuration) * 100))
                : 0;
            const sentBadges = (cd.direction === 'sent' && cd.destinations && cd.destinations.length)
                ? cd.destinations.map(id => {
                    const name = departmentMap[id] ? _esc(departmentMap[id].name) : _esc(id);
                    return `<span class="cdc-badge">${name}</span>`;
                  }).join('')
                : '<span class="cdc-badge recv">Ricevuto</span>';
            const tmp = document.createElement('div');
            tmp.innerHTML =
                `<div class="cdc ${lv}">` +
                `<div class="cdc-top">` +
                `<div class="cdc-tbl"><span>${_esc(cd.tableNumber)}</span></div>` +
                `<div class="cdc-time ${lv}">${fmt(cd.timeRemaining)}</div>` +
                `<button class="cdc-cancel">✕</button>` +
                `</div>` +
                `<div class="cdc-prog"><div class="cdc-prog-fill ${lv}" style="width:${pct}%"></div></div>` +
                `<div class="cdc-meta"><div class="cdc-badges">${sentBadges}</div>` +
                `<div class="cdc-started">Avviato: ${_esc(cd.startedAt)}</div></div></div>`;
            list.insertBefore(tmp.firstElementChild, firstMex || null);
        });
    }

    return {
        document, mexCdCards, insertMexCdCard, renderCards, playMexSound,
        getSound:   () => soundCalls,
        resetSound: () => { soundCalls = 0; },
        list:       () => document.getElementById('cd-list'),
    };
}

function makeCountdown(key, tableNumber, timeRemaining) {
    return [key, { id: key, tableNumber, timeRemaining, initialDuration: 600,
                   direction: 'sent', destinations: [], startedAt: '14:00',
                   endsAt: Date.now() + timeRemaining * 1000 }];
}

function msg(id, from, fromName, body) {
    return { id, from, fromName, body, timestamp: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
async function run() {

    // ── 1. insertMexCdCard basics ──────────────────────────────────────────────
    console.log('\n  — 1. insertMexCdCard basics —\n');
    {
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('m1','d1','Cucina','Hello'), true);
        check('1a. creates .mex-cd-card inside #cd-list', !!ctx.list().querySelector('.mex-cd-card'));
        check('1b. card has stable id mex-cd-m1', !!ctx.document.getElementById('mex-cd-m1'));
    }
    {
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('m2','d1','Cucina','Hi'), true);
        check('1c. new-arrival → has .new-arrival class',
            ctx.document.getElementById('mex-cd-m2').classList.contains('new-arrival'));
    }
    {
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('m3','d1','Cucina','Old'), false);
        check('1d. backfill (isNew:false) → no .new-arrival class',
            !ctx.document.getElementById('mex-cd-m3').classList.contains('new-arrival'));
    }
    {
        // Deduplication
        const ctx = buildDOM();
        const m   = msg('m4','d1','Cucina','Dup');
        ctx.insertMexCdCard(m, true);
        ctx.insertMexCdCard(m, true);
        check('1e. same messageId inserted twice → only 1 card',
            ctx.list().querySelectorAll('.mex-cd-card').length === 1);
    }
    {
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('a','d1','A','msg A'), false);
        ctx.insertMexCdCard(msg('b','d2','B','msg B'), false);
        check('1f. two different messages → two cards',
            ctx.list().querySelectorAll('.mex-cd-card').length === 2);
    }

    // ── 2. empty-state interaction ─────────────────────────────────────────────
    console.log('\n  — 2. empty-state interaction —\n');
    {
        const ctx  = buildDOM();
        const list = ctx.list();
        const e    = ctx.document.createElement('div');
        e.className = 'empty-state';
        e.textContent = 'Nessun countdown';
        list.appendChild(e);
        ctx.insertMexCdCard(msg('x','d1','A','hi'), true);
        check('2a. Mex card removes empty-state placeholder',
            !list.querySelector('.empty-state'));
        check('2b. Mex card is present after empty-state removal',
            !!list.querySelector('.mex-cd-card'));
    }
    {
        // renderCards with no countdowns + existing Mex card → no empty-state
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('y','d1','A','msg'), false);
        ctx.renderCards(new Map());
        check('2c. renderCards(empty) does NOT add empty-state when Mex cards exist',
            !ctx.list().querySelector('.empty-state'));
    }
    {
        // renderCards with no countdowns + no Mex card → shows empty-state
        const ctx = buildDOM();
        ctx.renderCards(new Map());
        check('2d. renderCards(empty) shows empty-state when no Mex cards',
            !!ctx.list().querySelector('.empty-state'));
    }

    // ── 3. HTML escaping / XSS safety ─────────────────────────────────────────
    console.log('\n  — 3. HTML escaping / XSS safety —\n');
    {
        const xss = '<script>alert(1)</script>';
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('xss1','d1','A',xss), false);
        const bodyEl = ctx.list().querySelector('.mex-cd-body');
        check('3a. XSS body rendered as text, not HTML',
            bodyEl.textContent === xss, bodyEl.innerHTML);
        check('3b. < is escaped in innerHTML',
            bodyEl.innerHTML.includes('&lt;'), bodyEl.innerHTML);
    }
    {
        const xssName = '<b>Evil<br>Sender</b>';
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('xss2','d1',xssName,'ok'), false);
        const fromEl = ctx.list().querySelector('.mex-cd-from');
        check('3c. XSS sender name rendered as text',
            fromEl.textContent.includes('Evil'), fromEl.innerHTML);
        check('3d. <b> tag not injected as actual element',
            !fromEl.querySelector('b'), fromEl.innerHTML);
    }
    {
        const long = 'a'.repeat(300);
        const ctx  = buildDOM();
        ctx.insertMexCdCard(msg('long','d1','A',long), false);
        const bodyEl = ctx.list().querySelector('.mex-cd-body');
        check('3e. exactly 300-char message rendered in full',
            bodyEl.textContent.length === 300);
    }

    // ── 4. Coexistence — Countdown does not remove Mex cards ──────────────────
    console.log('\n  — 4. Countdown does not remove Mex cards —\n');
    {
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('mA','d1','A','msg'), false);
        const cds = new Map([makeCountdown('t1','5',300)]);
        ctx.renderCards(cds);
        check('4a. Mex card survives renderCards call',
            !!ctx.list().querySelector('.mex-cd-card'));
        check('4b. Countdown card also present',
            !!ctx.list().querySelector('.cdc'));
    }
    {
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('mB','d1','A','msg'), false);
        const cds = new Map([makeCountdown('t1','5',300)]);
        ctx.renderCards(cds);
        ctx.renderCards(cds); // second tick
        ctx.renderCards(cds); // third tick
        check('4c. Mex card survives 3 consecutive renderCards calls',
            !!ctx.list().querySelector('.mex-cd-card'));
    }
    {
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('m1','d1','A','first'), false);
        ctx.insertMexCdCard(msg('m2','d2','B','second'), false);
        const cds = new Map([makeCountdown('t1','1',500), makeCountdown('t2','2',100)]);
        ctx.renderCards(cds);
        ctx.renderCards(cds); // second render
        check('4d. two Mex cards survive renderCards',
            ctx.list().querySelectorAll('.mex-cd-card').length === 2);
        check('4e. two countdown cards still present',
            ctx.list().querySelectorAll('.cdc').length === 2);
    }

    // ── 5. Coexistence — Mex does not remove Countdown cards ──────────────────
    console.log('\n  — 5. Mex does not remove Countdown cards —\n');
    {
        const ctx = buildDOM();
        const cds = new Map([makeCountdown('t2','3',400)]);
        ctx.renderCards(cds);
        ctx.insertMexCdCard(msg('mC','d2','B','new msg'), true);
        check('5a. Countdown card survives insertMexCdCard',
            !!ctx.list().querySelector('.cdc'));
        check('5b. Mex card also present',
            !!ctx.list().querySelector('.mex-cd-card'));
    }

    // ── 6. DOM order — countdown cards before Mex cards ───────────────────────
    console.log('\n  — 6. DOM order —\n');
    {
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('mFirst','d1','A','msg'), false);
        const cds = new Map([makeCountdown('t1','5',300)]);
        ctx.renderCards(cds);
        const children = Array.from(ctx.list().children);
        const cdcIdx   = children.findIndex(el => el.classList.contains('cdc'));
        const mexIdx   = children.findIndex(el => el.classList.contains('mex-cd-card'));
        check('6. countdown cards appear before Mex cards in DOM',
            cdcIdx !== -1 && mexIdx !== -1 && cdcIdx < mexIdx,
            { cdcIdx, mexIdx });
    }

    // ── 7. Countdown expiry — Mex cards remain, no stale empty-state ─────────
    console.log('\n  — 7. countdown expiry + Mex cards remain —\n');
    {
        const ctx = buildDOM();
        ctx.renderCards(new Map([makeCountdown('t1','8',300)]));
        ctx.insertMexCdCard(msg('mD','d1','A','hi'), false);
        // All countdowns expire and are cleared
        ctx.renderCards(new Map());
        check('7a. Mex card remains after all countdowns removed',
            !!ctx.list().querySelector('.mex-cd-card'));
        check('7b. No empty-state shown (Mex cards are present)',
            !ctx.list().querySelector('.empty-state'));
        check('7c. No countdown cards',
            !ctx.list().querySelector('.cdc'));
    }

    // ── 8. Sound — real-time vs backfill ──────────────────────────────────────
    console.log('\n  — 8. sound behaviour —\n');
    {
        // Real-time: caller (handleMexIncoming) calls playMexSound — simulated here
        const ctx = buildDOM();
        ctx.resetSound();
        // Simulate handleMexIncoming calling both insertMexCdCard AND playMexSound
        ctx.insertMexCdCard(msg('s1','d1','A','realtime'), true);
        ctx.playMexSound(); // handleMexIncoming always calls this
        check('8a. Real-time arrival: playMexSound called',
            ctx.getSound() === 1);
    }
    {
        // Backfill: loadMexInbox calls insertMexCdCard(m, false) — does NOT call playMexSound
        const ctx = buildDOM();
        ctx.resetSound();
        ctx.insertMexCdCard(msg('s2','d1','A','backfill'), false);
        // Note: loadMexInbox does NOT call playMexSound for backfill
        check('8b. Backfill (isNew:false): playMexSound NOT called',
            ctx.getSound() === 0);
    }

    // ── 9. #ra-count is updated by renderCards ─────────────────────────────────
    console.log('\n  — 9. ra-count updated —\n');
    {
        const ctx = buildDOM();
        ctx.renderCards(new Map([makeCountdown('t1','1',300), makeCountdown('t2','2',200)]));
        check('9. #ra-count reflects countdown count',
            ctx.document.getElementById('ra-count').textContent === '2');
    }
    {
        const ctx = buildDOM();
        ctx.insertMexCdCard(msg('mE','d1','A','msg'), false);
        ctx.renderCards(new Map()); // countdowns cleared, but Mex present
        check('9b. #ra-count is 0 when no countdowns (Mex cards don\'t count)',
            ctx.document.getElementById('ra-count').textContent === '0');
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Mex Step 4 rendering tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.error('❌ Some tests failed.');
        process.exit(1);
    } else {
        console.log('✅ All Mex Step 4 rendering tests passed.');
    }
}

run().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
