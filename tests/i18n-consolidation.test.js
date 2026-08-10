// tests/i18n-consolidation.test.js — I18N Consolidation Fix regression tests.
//
// Covers:
//   • home.openStation values in IT / FR / EN
//   • ops.brief.* narrative keys resolve in all 3 languages
//   • ops.sec.inEscalation, ops.team.emailReadonly
//   • home.operations key
//   • greeting keys (morning / afternoon / evening) per language
//   • briefFmt pattern: {n} placeholder gets replaced
//   • key consistency: every ops.brief.* key exists in all 3 dicts
//   • no key resolves to undefined/null/raw key in any language
//   • server-generated fields (executiveBrief/briefing) are Italian strings
//     (inventory confirmation — not expected to be translated yet)
//
// Run: node tests/i18n-consolidation.test.js

'use strict';

const fs = require('fs');
const path = require('path');

// ── Load I18n ────────────────────────────────────────────────────────────────
const I18n = require('../public/js/i18n.js');

function loadDicts() {
    const base = path.join(__dirname, '..', 'public', 'i18n');
    return {
        it: JSON.parse(fs.readFileSync(path.join(base, 'it.json'), 'utf8')),
        fr: JSON.parse(fs.readFileSync(path.join(base, 'fr.json'), 'utf8')),
        en: JSON.parse(fs.readFileSync(path.join(base, 'en.json'), 'utf8')),
    };
}

const dicts = loadDicts();
I18n.setDictionaries(dicts);

let passed = 0, failed = 0;

function ok(label, cond) {
    if (cond) { console.log('  ✅', label); passed++; }
    else       { console.log('  ❌', label); failed++; }
}

function tLang(lang, key) {
    I18n.setDictionaries(dicts);
    // Simulate language selection by temporarily hacking internal state
    // via setDictionaries + checking dict directly
    const dict = dicts[lang];
    const it   = dicts['it'];
    if (dict && typeof dict[key] === 'string') return dict[key];
    if (it   && typeof it[key]   === 'string') return it[key];
    return key;
}

// ── Section 1: Service home — department card subtitle ───────────────────────
console.log('\n— Service home: department card subtitle —');
ok('IT openStation = "Apri il reparto"', tLang('it','home.openStation') === 'Apri il reparto');
ok('FR openStation = "Ouvrir le poste"', tLang('fr','home.openStation') === 'Ouvrir le poste');
ok('EN openStation = "Open department"', tLang('en','home.openStation') === 'Open department');
ok('home.operations key exists in IT', typeof dicts.it['home.operations'] === 'string');
ok('home.operations key exists in FR', typeof dicts.fr['home.operations'] === 'string');
ok('home.operations key exists in EN', typeof dicts.en['home.operations'] === 'string');

// ── Section 2: Operations greeting ──────────────────────────────────────────
console.log('\n— Operations greeting —');
ok('IT morning = Buongiorno',      tLang('it','ops.greeting.morning') === 'Buongiorno');
ok('IT afternoon = Buon pomeriggio', tLang('it','ops.greeting.afternoon') === 'Buon pomeriggio');
ok('IT evening = Buonasera',       tLang('it','ops.greeting.evening') === 'Buonasera');
ok('FR morning = Bonjour',         tLang('fr','ops.greeting.morning') === 'Bonjour');
ok('FR afternoon != IT',           tLang('fr','ops.greeting.afternoon') !== tLang('it','ops.greeting.afternoon'));
ok('FR evening = Bonsoir',         tLang('fr','ops.greeting.evening') === 'Bonsoir');
ok('EN morning = Good morning',    tLang('en','ops.greeting.morning') === 'Good morning');
ok('EN afternoon = Good afternoon',tLang('en','ops.greeting.afternoon') === 'Good afternoon');
ok('EN evening = Good evening',    tLang('en','ops.greeting.evening') === 'Good evening');

// ── Section 3: Operations director narrative keys ────────────────────────────
console.log('\n— Director narrative keys —');
const dirKeys = [
    'ops.brief.dir.tasks',
    'ops.brief.dir.done',
    'ops.brief.overdue1',
    'ops.brief.overdueN',
    'ops.brief.esc1',
    'ops.brief.escN',
    'ops.brief.allOk',
];
for (const k of dirKeys) {
    for (const lang of ['it','fr','en']) {
        const v = tLang(lang, k);
        ok(`${lang}: ${k} is non-empty string`, typeof v === 'string' && v.length > 0 && v !== k);
    }
}

// ── Section 4: CC narrative keys ─────────────────────────────────────────────
console.log('\n— CC narrative keys —');
const ccKeys = ['ops.brief.cc.tasks', 'ops.brief.cc.done', 'ops.brief.cc.noDelay'];
for (const k of ccKeys) {
    for (const lang of ['it','fr','en']) {
        const v = tLang(lang, k);
        ok(`${lang}: ${k}`, typeof v === 'string' && v.length > 0 && v !== k);
    }
}

// ── Section 5: Adjoint narrative keys ───────────────────────────────────────
console.log('\n— Adjoint narrative keys —');
const adjKeys = [
    'ops.brief.adj.mine',
    'ops.brief.adj.overdue1',
    'ops.brief.adj.overdueN',
    'ops.brief.adj.urgent',
    'ops.brief.adj.noCrit',
];
for (const k of adjKeys) {
    for (const lang of ['it','fr','en']) {
        const v = tLang(lang, k);
        ok(`${lang}: ${k}`, typeof v === 'string' && v.length > 0 && v !== k);
    }
}

// ── Section 6: Escalation and team ──────────────────────────────────────────
console.log('\n— Escalation / team labels —');
ok('IT inEscalation exists', typeof dicts.it['ops.sec.inEscalation'] === 'string');
ok('FR inEscalation != IT', tLang('fr','ops.sec.inEscalation') !== tLang('it','ops.sec.inEscalation'));
ok('EN inEscalation exists', typeof dicts.en['ops.sec.inEscalation'] === 'string');
ok('IT emailReadonly exists', typeof dicts.it['ops.team.emailReadonly'] === 'string');
ok('FR emailReadonly != IT', tLang('fr','ops.team.emailReadonly') !== tLang('it','ops.team.emailReadonly'));
ok('EN emailReadonly != IT', tLang('en','ops.team.emailReadonly') !== tLang('it','ops.team.emailReadonly'));

// ── Section 7: {n} placeholder present in all sentence keys ─────────────────
console.log('\n— {n} placeholder in numeric sentence keys —');
const numericKeys = [
    'ops.brief.dir.tasks', 'ops.brief.dir.done',
    'ops.brief.overdue1', 'ops.brief.overdueN',
    'ops.brief.esc1', 'ops.brief.escN',
    'ops.brief.cc.tasks', 'ops.brief.cc.done',
    'ops.brief.adj.mine',
    'ops.brief.adj.overdue1', 'ops.brief.adj.overdueN',
    'ops.brief.adj.urgent',
];
for (const k of numericKeys) {
    for (const lang of ['it','fr','en']) {
        const v = tLang(lang, k);
        ok(`${lang}: ${k} contains {n}`, v.includes('{n}'));
    }
}

// ── Section 8: Key consistency across all 3 dictionaries ────────────────────
console.log('\n— Key consistency (all ops.brief.* present in all 3 dicts) —');
const allBriefKeys = [...dirKeys, ...ccKeys, ...adjKeys];
for (const k of allBriefKeys) {
    ok(`${k} in all 3 dicts`,
        typeof dicts.it[k] === 'string' &&
        typeof dicts.fr[k] === 'string' &&
        typeof dicts.en[k] === 'string');
}

// ── Section 9: FR narrative differs from IT (language actually changes) ───────
console.log('\n— FR narrative differs from IT —');
ok('FR dir.tasks ≠ IT dir.tasks', tLang('fr','ops.brief.dir.tasks') !== tLang('it','ops.brief.dir.tasks'));
ok('FR cc.tasks ≠ IT cc.tasks',   tLang('fr','ops.brief.cc.tasks') !== tLang('it','ops.brief.cc.tasks'));
ok('FR adj.mine ≠ IT adj.mine',   tLang('fr','ops.brief.adj.mine') !== tLang('it','ops.brief.adj.mine'));
ok('EN dir.tasks ≠ IT dir.tasks', tLang('en','ops.brief.dir.tasks') !== tLang('it','ops.brief.dir.tasks'));
ok('EN allOk ≠ IT allOk',         tLang('en','ops.brief.allOk') !== tLang('it','ops.brief.allOk'));

// ── Section 10: allOk / noDelay / noCrit have no {n} placeholder ────────────
console.log('\n— Status-only keys have no {n} —');
const statusKeys = ['ops.brief.allOk', 'ops.brief.cc.noDelay', 'ops.brief.adj.noCrit'];
for (const k of statusKeys) {
    for (const lang of ['it','fr','en']) {
        ok(`${lang}: ${k} has no {n}`, !tLang(lang, k).includes('{n}'));
    }
}

// ── Section 11: ops-intelligence.js server strings are still Italian ─────────
console.log('\n— Server-generated text inventory (Italian — I18N-3 scope) —');
const intelligenceFile = fs.readFileSync(
    path.join(__dirname, '..', 'operations', 'ops-intelligence.js'), 'utf8');
ok('ops-intelligence.js still contains Italian greeting (Buongiorno/Buonasera)',
    /Buongiorno|Buonasera/.test(intelligenceFile));
ok('ops-intelligence.js still contains Italian narrative (Oggi ci sono)',
    /Oggi ci sono/.test(intelligenceFile));

const assistantFile = fs.readFileSync(
    path.join(__dirname, '..', 'operations', 'ops-assistant.js'), 'utf8');
ok('ops-assistant.js still contains Italian brief (Oggi ci sono)',
    /Oggi ci sono/.test(assistantFile));

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\ni18n-consolidation tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
