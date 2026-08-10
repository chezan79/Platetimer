// tests/i18n.test.js — I18N-1: IT/FR/EN foundation tests.
//
// Covers:
//   • all three translation JSON files load, are valid and key-consistent
//   • saved language ('pt_language') is restored
//   • invalid saved language falls back to Italian
//   • browser fr/en picks fr/en when no saved preference exists
//   • missing translation key falls back to Italian (never undefined/null/raw key)
//   • switching language changes translation output
//
// Run: node tests/i18n.test.js

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.error(`  ❌ ${name}${extra !== undefined ? ' — got: ' + JSON.stringify(extra) : ''}`); }
}

// ── Fake browser environment (before requiring the helper) ───────────────────
function makeStorage(initial) {
    const store = Object.assign({}, initial || {});
    return {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        _store: store,
    };
}
// Node ≥21 exposes a read-only `navigator` global — plain assignment is silently
// ignored, so override it with defineProperty.
function setNavigator(nav) {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
}
globalThis.localStorage = makeStorage();
setNavigator({ language: 'it-IT' });

const I18n = require('../public/js/i18n.js');

// ── 1. Translation files: valid JSON + key consistency ──────────────────────
console.log('\n— Translation files —');
const I18N_DIR = path.join(__dirname, '..', 'public', 'i18n');
const dicts = {};
for (const lang of ['it', 'fr', 'en']) {
    let parsed = null, ok = true;
    try { parsed = JSON.parse(fs.readFileSync(path.join(I18N_DIR, lang + '.json'), 'utf8')); }
    catch (e) { ok = false; }
    check(`${lang}.json is valid JSON`, ok);
    dicts[lang] = parsed || {};
    check(`${lang}.json is non-empty`, Object.keys(dicts[lang]).length > 10, Object.keys(dicts[lang]).length);
    const badVals = Object.entries(dicts[lang]).filter(([, v]) => typeof v !== 'string' || v.trim() === '');
    check(`${lang}.json has no empty/non-string values`, badVals.length === 0, badVals.slice(0, 3));
}
const itKeys = Object.keys(dicts.it).sort();
for (const lang of ['fr', 'en']) {
    const keys = Object.keys(dicts[lang]).sort();
    const missing = itKeys.filter(k => !keys.includes(k));
    const extra   = keys.filter(k => !itKeys.includes(k));
    check(`${lang}.json has the same keys as it.json`, missing.length === 0 && extra.length === 0,
          { missing: missing.slice(0, 5), extra: extra.slice(0, 5) });
}
check('keys are namespaced (contain a dot), never raw Italian text', itKeys.every(k => k.includes('.') && !/[àèéìòù ]/.test(k)));

// ── 2. All three languages load and produce output ───────────────────────────
console.log('\n— Language loading & switching —');
I18n.setDictionaries(dicts);
for (const lang of ['it', 'fr', 'en']) {
    I18n.setLanguage(lang);
    const v = I18n.t('service.enterBtn');
    check(`t('service.enterBtn') resolves in ${lang}`, v === dicts[lang]['service.enterBtn'], v);
}

// Switching changes output
I18n.setLanguage('it');
const itVal = I18n.t('login.forgotLink');
I18n.setLanguage('fr');
const frVal = I18n.t('login.forgotLink');
I18n.setLanguage('en');
const enVal = I18n.t('login.forgotLink');
check('translation output changes across languages', itVal !== frVal && frVal !== enVal && itVal !== enVal, { itVal, frVal, enVal });

// setLanguage persists to pt_language
I18n.setLanguage('fr');
check("setLanguage persists to localStorage 'pt_language'", globalThis.localStorage.getItem('pt_language') === 'fr');

// ── 3. Fallback chain: saved pref → browser fr/en → Italian ─────────────────
console.log('\n— Fallback chain —');
globalThis.localStorage = makeStorage({ pt_language: 'en' });
setNavigator({ language: 'fr-FR' });
check('saved language restored (en beats browser fr)', I18n.detectLanguage() === 'en');

globalThis.localStorage = makeStorage({ pt_language: 'de' });   // unsupported
setNavigator({ language: 'it-IT' });
check('invalid saved language falls back to Italian', I18n.detectLanguage() === 'it');

globalThis.localStorage = makeStorage();
setNavigator({ language: 'fr-CH' });
check('browser fr picks French when no saved pref', I18n.detectLanguage() === 'fr');
setNavigator({ language: 'en-US' });
check('browser en picks English when no saved pref', I18n.detectLanguage() === 'en');
setNavigator({ language: 'de-DE' });
check('browser de falls back to Italian', I18n.detectLanguage() === 'it');

// setLanguage with invalid value → Italian
const applied = I18n.setLanguage('xx');
check("setLanguage('xx') falls back to Italian", applied === 'it' && I18n.getLanguage() === 'it');

// ── 4. Missing keys fall back to Italian, never undefined/null ──────────────
console.log('\n— Missing key fallback —');
I18n.setDictionaries({
    it: { 'only.italian': 'Solo italiano', 'both.langs': 'Ciao' },
    fr: { 'both.langs': 'Salut' },
    en: {},
});
I18n.setLanguage('fr');
check('missing fr key falls back to Italian', I18n.t('only.italian') === 'Solo italiano');
I18n.setLanguage('en');
check('missing en key falls back to Italian', I18n.t('both.langs') === 'Ciao');
const unknown = I18n.t('totally.unknown.key');
check('unknown key never returns undefined/null', typeof unknown === 'string' && unknown.length > 0, unknown);

// Real dictionaries: no key ever resolves to undefined/null in any language
I18n.setDictionaries(dicts);
let badResolutions = 0;
for (const lang of ['it', 'fr', 'en']) {
    I18n.setLanguage(lang);
    for (const k of itKeys) {
        const v = I18n.t(k);
        if (v == null || v === '' || v === k) badResolutions++;
    }
}
check('every key resolves to a real string in all languages', badResolutions === 0, badResolutions);

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\ni18n tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
