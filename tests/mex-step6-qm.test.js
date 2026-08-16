#!/usr/bin/env node
/**
 * Mex Step 6 — Quick Messages: Unit Tests
 *
 * Plain Node.js, no framework needed.
 * Tests MexQM module logic (renderBody, validateTableNum, buttonLabel)
 * plus mex-store.js templateType/tableNumber persistence and backward compat.
 */

'use strict';

const pathmod = require('path');
const os      = require('os');
const fs      = require('fs');
const crypto  = require('crypto');

// ─── node shim so mex-qm.js (browser module) works in Node ──────────────────
global.window = global;
require('../public/js/mex-qm.js');
const { MexQM } = global;

// i18n helper using the Italian dictionary (matches server default locale)
const I18N = JSON.parse(fs.readFileSync(pathmod.join(__dirname, '../public/i18n/it.json'), 'utf8'));
const t = k => (I18N[k] !== undefined ? I18N[k] : k);

// ─── helpers ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(label, cond, hint) {
    if (cond) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.error(`  ❌ ${label}` + (hint !== undefined ? ` — got: ${JSON.stringify(hint)}` : '')); }
}
function notOk(label, cond, hint) { ok(label, !cond, hint); }

// ─── §1. MexQM.TYPES ─────────────────────────────────────────────────────────
console.log('\n  — 1. MexQM.TYPES —\n');
ok('1a. TYPES is an array', Array.isArray(MexQM.TYPES));
ok('1b. Has exactly 6 types', MexQM.TYPES.length === 6, MexQM.TYPES.length);
const typeKeys = MexQM.TYPES.map(t => t.key);
for (const expected of ['TABLE_DELAY','TABLE_STATUS','TABLE_URGENT','TABLE_HOLD','TABLE_SEND','CUSTOM']) {
    ok(`1c. ${expected} present`, typeKeys.includes(expected));
}

// ─── §2. isTableType ─────────────────────────────────────────────────────────
console.log('\n  — 2. isTableType —\n');
for (const k of ['TABLE_DELAY','TABLE_STATUS','TABLE_URGENT','TABLE_HOLD','TABLE_SEND']) {
    ok(`2a. isTableType(${k}) = true`, MexQM.isTableType(k));
}
ok('2b. isTableType(CUSTOM) = false', !MexQM.isTableType('CUSTOM'));
ok('2c. isTableType(undefined) = false', !MexQM.isTableType(undefined));
ok('2d. isTableType("") = false', !MexQM.isTableType(''));

// ─── §3. validateTableNum ────────────────────────────────────────────────────
console.log('\n  — 3. validateTableNum —\n');
ok('3a. valid integer "12"',  MexQM.validateTableNum('12', t).ok);
ok('3b. valid integer "1"',   MexQM.validateTableNum('1',  t).ok);
ok('3c. valid integer "999"', MexQM.validateTableNum('999',t).ok);
ok('3d. normalized strips whitespace', MexQM.validateTableNum(' 24 ', t).normalized === '24');
ok('3e. alphanumeric "A12" accepted', MexQM.validateTableNum('A12', t).ok);
ok('3f. alphanumeric "T42" accepted', MexQM.validateTableNum('T42', t).ok);
ok('3g. empty string fails',   !MexQM.validateTableNum('', t).ok);
ok('3h. "0" fails (< 1)',      !MexQM.validateTableNum('0', t).ok);
ok('3i. "1000" fails (> 999)', !MexQM.validateTableNum('1000', t).ok);
ok('3j. special chars fail',   !MexQM.validateTableNum('ta!1', t).ok);
ok('3k. length > 8 fails',     !MexQM.validateTableNum('123456789', t).ok);
ok('3l. error message is string', typeof MexQM.validateTableNum('', t).error === 'string');

// ─── §4. renderBody ──────────────────────────────────────────────────────────
console.log('\n  — 4. renderBody —\n');
const tableNum = '24';
for (const k of ['TABLE_DELAY','TABLE_STATUS','TABLE_URGENT','TABLE_HOLD','TABLE_SEND']) {
    const body = MexQM.renderBody(k, tableNum, t);
    ok(`4a. ${k} renders non-empty string`, typeof body === 'string' && body.length > 0, body);
    ok(`4b. ${k} body contains "24"`, body.includes('24'), body);
    notOk(`4c. ${k} body has no literal {n}`, body.includes('{n}'), body);
}
ok('4d. CUSTOM returns null', MexQM.renderBody('CUSTOM', '24', t) === null);
ok('4e. unknown key returns null', MexQM.renderBody('UNKNOWN', '24', t) === null);

const b5 = MexQM.renderBody('TABLE_DELAY', '5', t);
const b6 = MexQM.renderBody('TABLE_DELAY', '6', t);
ok('4f. Different table numbers → different bodies', b5 !== b6);

// Different table types produce different bodies
const bDelay  = MexQM.renderBody('TABLE_DELAY',  '10', t);
const bStatus = MexQM.renderBody('TABLE_STATUS', '10', t);
ok('4g. Different template types → different bodies', bDelay !== bStatus);

// ─── §5. buttonLabel ─────────────────────────────────────────────────────────
console.log('\n  — 5. buttonLabel —\n');
for (const k of ['TABLE_DELAY','TABLE_STATUS','TABLE_URGENT','TABLE_HOLD','TABLE_SEND','CUSTOM']) {
    const lbl = MexQM.buttonLabel(k, t);
    ok(`5a. ${k} label is non-empty string`, typeof lbl === 'string' && lbl.length > 0, lbl);
    notOk(`5b. ${k} label has no {n} placeholder`, lbl.includes('{n}'), lbl);
}

// ─── §6. mex-store persistence ───────────────────────────────────────────────
console.log('\n  — 6. mex-store persistence —\n');
const DATA_DIR = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'mex6unit-'));
process.env.DATA_DIR = DATA_DIR;
const mexStore = require('../service/mex-store.js');
mexStore._resetForTest();
mexStore.init(DATA_DIR, null, null);

(async () => {
    // TABLE_DELAY with tableNumber
    const r1 = await mexStore.createAndSend({
        companyId: 'co1', senderDeptId: 'dept-a', recipientDeptId: 'dept-b',
        body: MexQM.renderBody('TABLE_DELAY', '42', t),
        templateType: 'TABLE_DELAY', tableNumber: '42'
    });
    ok('6a. createAndSend returns ok', !!(r1.message && r1.conversation));
    ok('6b. message.templateType stored', r1.message.templateType === 'TABLE_DELAY', r1.message.templateType);
    ok('6c. message.tableNumber stored',  r1.message.tableNumber  === '42',           r1.message.tableNumber);
    ok('6d. message.body contains "42"',  r1.message.body.includes('42'));

    // Inbox projection includes metadata
    const inbox = await mexStore.getInboxForDept('co1', 'dept-b');
    const msg   = inbox[0]?.messages[0];
    ok('6e. inbox msg.templateType = TABLE_DELAY', msg?.templateType === 'TABLE_DELAY', msg?.templateType);
    ok('6f. inbox msg.tableNumber = 42',            msg?.tableNumber  === '42',          msg?.tableNumber);

    // CUSTOM (no template metadata)
    const r2 = await mexStore.createAndSend({
        companyId: 'co1', senderDeptId: 'dept-b', recipientDeptId: 'dept-a',
        body: 'A custom free-text message'
    });
    ok('6g. CUSTOM templateType is null', r2.message.templateType === null, r2.message.templateType);
    ok('6h. CUSTOM tableNumber is null',  r2.message.tableNumber  === null, r2.message.tableNumber);

    // Backward compat: inject a legacy message without template fields
    const store    = mexStore._mexStore;
    const co1      = store['co1'];
    const legacyId = 'mexconv_legacy_' + crypto.randomBytes(4).toString('hex');
    const legacyMId = 'mexmsg_legacy_' + crypto.randomBytes(4).toString('hex');
    co1.conversations[legacyId] = {
        id: legacyId, companyId: 'co1',
        participants: ['dept-c', 'dept-d'],
        createdAt: new Date().toISOString(), createdBy: 'dept-c',
        closedAt: null, readBy: {},
        messages: [{
            id: legacyMId, conversationId: legacyId,
            from: 'dept-c', body: 'legacy text', timestamp: new Date().toISOString()
            // NO templateType / tableNumber — simulates Step 3/4/5 message
        }]
    };
    const inbox2 = await mexStore.getInboxForDept('co1', 'dept-d');
    const legConv = inbox2.find(c => c.id === legacyId);
    ok('6i. Legacy message loads without error', !!legConv);
    const legMsg = legConv?.messages[0];
    ok('6j. Legacy msg.body intact', legMsg?.body === 'legacy text', legMsg?.body);
    ok('6k. Legacy msg.templateType is null (default)', legMsg?.templateType === null, legMsg?.templateType);
    ok('6l. Legacy msg.tableNumber is null (default)',   legMsg?.tableNumber  === null, legMsg?.tableNumber);

    // TABLE_SEND variant
    const r3 = await mexStore.createAndSend({
        companyId: 'co1', senderDeptId: 'dept-a', recipientDeptId: 'dept-b',
        body: MexQM.renderBody('TABLE_SEND', '7', t),
        templateType: 'TABLE_SEND', tableNumber: '7'
    });
    ok('6m. TABLE_SEND templateType stored', r3.message.templateType === 'TABLE_SEND');
    ok('6n. TABLE_SEND tableNumber stored',  r3.message.tableNumber  === '7');

    // ─── §7. i18n dictionary integrity ───────────────────────────────────────
    console.log('\n  — 7. i18n dictionary integrity —\n');
    for (const lang of ['it','en','fr']) {
        try {
            const dict = JSON.parse(fs.readFileSync(pathmod.join(__dirname, `../public/i18n/${lang}.json`), 'utf8'));
            // Check all mex.qm.* keys present
            const EXPECTED_KEYS = [
                'mex.qm.title','mex.qm.tableLabel','mex.qm.continue','mex.qm.back','mex.qm.tableError',
                ...['TABLE_DELAY','TABLE_STATUS','TABLE_URGENT','TABLE_HOLD','TABLE_SEND'].flatMap(k =>
                    [`mex.qm.${k}`,`mex.qm.${k}_body`]),
                'mex.qm.CUSTOM'
            ];
            const missing = EXPECTED_KEYS.filter(k => !dict[k]);
            ok(`7a. ${lang}.json valid JSON`, true);
            ok(`7b. ${lang}.json has all mex.qm.* keys (missing: ${missing.join(',') || 'none'})`, missing.length === 0, missing);
            // Check body templates contain {n}
            for (const k of ['TABLE_DELAY','TABLE_STATUS','TABLE_URGENT','TABLE_HOLD','TABLE_SEND']) {
                const bodyKey = `mex.qm.${k}_body`;
                ok(`7c. ${lang}.json ${bodyKey} contains {n}`, dict[bodyKey]?.includes('{n}'), dict[bodyKey]);
            }
        } catch (e) {
            ok(`7a. ${lang}.json valid JSON`, false, e.message);
        }
    }

    // ─── Summary ─────────────────────────────────────────────────────────────
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`Mex Step 6 QM unit tests: ${passed} passed, ${failed} failed`);
    if (!failed) console.log('✅ All Mex Step 6 QM unit tests passed.');
    else console.error(`❌ ${failed} test(s) failed.`);
    console.log('──────────────────────────────────────────────────────\n');
    process.exit(failed ? 1 : 0);
})();
