'use strict';
/**
 * mex-qm-labels.test.js
 *
 * Verifies that MexQM.buttonLabel() always returns localized human-readable text
 * (never the canonical key string) for all six Quick Message types in all three
 * supported locales, and that language switching produces the correct labels.
 *
 * These tests run in Node — no DOM or server required.
 */

const I18n  = require('../public/js/i18n.js');
// mex-qm.js is an IIFE parameterised with `window`; stub it for Node.
if (typeof global.window === 'undefined') global.window = global;
require('../public/js/mex-qm.js');   // sets global.MexQM via window.MexQM = …
const { readFileSync } = require('fs');
const path = require('path');

// ── Load real dictionaries from the i18n JSON files ───────────────────────────
function loadDicts() {
    const out = {};
    for (const l of ['it', 'fr', 'en']) {
        out[l] = JSON.parse(
            readFileSync(path.join(__dirname, '../public/i18n', l + '.json'), 'utf8')
        );
    }
    return out;
}
const dicts = loadDicts();
I18n.setDictionaries(dicts);

const TYPES       = ['TABLE_DELAY', 'TABLE_STATUS', 'TABLE_URGENT', 'TABLE_HOLD', 'TABLE_SEND', 'CUSTOM'];
const TABLE_TYPES = ['TABLE_DELAY', 'TABLE_STATUS', 'TABLE_URGENT', 'TABLE_HOLD', 'TABLE_SEND'];

// ── Test infrastructure ────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(cond, msg) {
    if (cond) { console.log('  ✅', msg); passed++; }
    else       { console.error('  ❌', msg); failed++; }
}

/** Make a t_fn for the given locale (mirrors _mt / _t on the pages). */
function makeTfn(lang) {
    I18n.setDictionaries(dicts);
    I18n.setLanguage(lang);
    return k => I18n.t(k);
}

// ── 1. Italian labels ─────────────────────────────────────────────────────────
console.log('\n  — 1. Italian labels —');
{
    const t_fn = makeTfn('it');
    for (const key of TYPES) {
        const label = MexQM.buttonLabel(key, t_fn);
        assert(label !== key,      `IT ${key}: label is not the canonical key`);
        assert(label.length > 0,   `IT ${key}: label is non-empty`);
    }
}

// ── 2. French labels ──────────────────────────────────────────────────────────
console.log('\n  — 2. French labels —');
{
    const t_fn = makeTfn('fr');
    for (const key of TYPES) {
        const label = MexQM.buttonLabel(key, t_fn);
        assert(label !== key, `FR ${key}: label is not the canonical key`);
        assert(label.length > 0, `FR ${key}: label is non-empty`);
    }
}

// ── 3. English labels ─────────────────────────────────────────────────────────
console.log('\n  — 3. English labels —');
{
    const t_fn = makeTfn('en');
    for (const key of TYPES) {
        const label = MexQM.buttonLabel(key, t_fn);
        assert(label !== key, `EN ${key}: label is not the canonical key`);
        assert(label.length > 0, `EN ${key}: label is non-empty`);
    }
}

// ── 4. Canonical keys must NEVER appear as visible button text ────────────────
console.log('\n  — 4. Canonical keys never shown as button text —');
for (const lang of ['it', 'fr', 'en']) {
    const t_fn = makeTfn(lang);
    for (const key of TYPES) {
        const label = MexQM.buttonLabel(key, t_fn);
        assert(
            label !== key,
            `${lang.toUpperCase()}: "${key}" is never rendered as visible button text`
        );
    }
}

// ── 5. renderBody is localized for all table types ────────────────────────────
console.log('\n  — 5. renderBody localized for table types —');
for (const lang of ['it', 'fr', 'en']) {
    const t_fn = makeTfn(lang);
    for (const key of TABLE_TYPES) {
        const body = MexQM.renderBody(key, '7', t_fn);
        assert(body !== null,        `${lang.toUpperCase()} ${key}: renderBody returns non-null`);
        assert(body.includes('7'),   `${lang.toUpperCase()} ${key}: renderBody interpolates table number`);
        assert(body !== key,         `${lang.toUpperCase()} ${key}: renderBody is not the canonical key`);
    }
}

// ── 6. CUSTOM renderBody returns null (no template body) ─────────────────────
console.log('\n  — 6. CUSTOM renderBody returns null —');
for (const lang of ['it', 'fr', 'en']) {
    const t_fn = makeTfn(lang);
    const body = MexQM.renderBody('CUSTOM', null, t_fn);
    assert(body === null, `${lang.toUpperCase()} CUSTOM: renderBody correctly returns null`);
}

// ── 7. Empty dictionaries → canonical fallback, no throw ─────────────────────
console.log('\n  — 7. Empty dictionaries → safe canonical fallback, no crash —');
{
    I18n.setDictionaries({});
    const t_fn = k => I18n.t(k);
    for (const key of TYPES) {
        let threw = false, label;
        try { label = MexQM.buttonLabel(key, t_fn); } catch (e) { threw = true; }
        assert(!threw,       `Fallback: ${key} does not throw when dicts are empty`);
        assert(label === key, `Fallback: ${key} returns canonical key (acceptable internal default)`);
    }
    // Restore for subsequent tests
    I18n.setDictionaries(dicts);
}

// ── 8. Department and Floor use the same key pattern → identical labels ───────
console.log('\n  — 8. Department and Floor produce identical labels (shared MexQM module) —');
{
    for (const lang of ['it', 'fr', 'en']) {
        const t_fn = makeTfn(lang);
        for (const key of TYPES) {
            // Simulate dept page calling MexQM.buttonLabel (department.html)
            const deptLabel  = MexQM.buttonLabel(key, t_fn);
            // Simulate floor page calling MexQM.buttonLabel (sala.html)
            const floorLabel = MexQM.buttonLabel(key, t_fn);
            assert(
                deptLabel === floorLabel,
                `${lang.toUpperCase()} ${key}: dept and floor labels are identical`
            );
        }
    }
}

// ── 9. Language switch: TABLE_DELAY labels differ across locales ──────────────
console.log('\n  — 9. Language switch produces locale-specific labels —');
{
    I18n.setDictionaries(dicts);

    I18n.setLanguage('it');
    const labelIT = MexQM.buttonLabel('TABLE_DELAY', k => I18n.t(k));

    I18n.setLanguage('fr');
    const labelFR = MexQM.buttonLabel('TABLE_DELAY', k => I18n.t(k));

    I18n.setLanguage('en');
    const labelEN = MexQM.buttonLabel('TABLE_DELAY', k => I18n.t(k));

    assert(labelIT !== 'TABLE_DELAY', 'IT: TABLE_DELAY label is not the canonical key');
    assert(labelFR !== 'TABLE_DELAY', 'FR: TABLE_DELAY label is not the canonical key');
    assert(labelEN !== 'TABLE_DELAY', 'EN: TABLE_DELAY label is not the canonical key');
    assert(labelIT !== labelFR, 'IT and FR labels differ (locale-sensitive)');
    assert(labelFR !== labelEN, 'FR and EN labels differ (locale-sensitive)');
    assert(labelIT !== labelEN, 'IT and EN labels differ (locale-sensitive)');

    // All six types in all three locales — none should match the canonical key
    for (const lang of ['it', 'fr', 'en']) {
        I18n.setLanguage(lang);
        for (const key of TYPES) {
            const label = MexQM.buttonLabel(key, k => I18n.t(k));
            assert(label !== key, `After lang-switch to ${lang.toUpperCase()}: ${key} not shown as raw key`);
        }
    }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────────────');
console.log(`mex-qm-labels: ${passed} passed, ${failed} failed`);
if (failed === 0) {
    console.log('✅ All Mex QM label tests passed.');
    process.exit(0);
} else {
    process.exit(1);
}
