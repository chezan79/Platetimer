#!/usr/bin/env node
/**
 * Mex Step 7 — Replies: Unit Tests
 *
 * Covers:
 *  - MexQR module (renderBody, buttonLabel, isCustom)
 *  - mex-store addReply persistence
 *  - getInboxForDept includes replies (backward compat with legacy messages)
 *  - Security: addReply rejects non-participants and closed conversations
 *  - All six reply types
 *  - i18n dictionary integrity for mex.qr.* keys
 */

'use strict';

const pathmod = require('path');
const os      = require('os');
const fs      = require('fs');
const crypto  = require('crypto');

// ─── Browser shim for mex-qr.js ──────────────────────────────────────────────
global.window = global;
require('../public/js/mex-qr.js');
const { MexQR } = global;

// i18n helper
const I18N = JSON.parse(fs.readFileSync(pathmod.join(__dirname, '../public/i18n/it.json'), 'utf8'));
const t = k => (I18N[k] !== undefined ? I18N[k] : k);

// ─── Helpers ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(label, cond, hint) {
    if (cond) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.error(`  ❌ ${label}` + (hint !== undefined ? ` — got: ${JSON.stringify(hint)}` : '')); }
}
function notOk(label, cond, hint) { ok(label, !cond, hint); }

// ─── §1. MexQR.TYPES ─────────────────────────────────────────────────────────
console.log('\n  — 1. MexQR.TYPES —\n');
ok('1a. TYPES is an array', Array.isArray(MexQR.TYPES));
ok('1b. Has exactly 6 types', MexQR.TYPES.length === 6, MexQR.TYPES.length);
const qrKeys = MexQR.TYPES.map(t => t.key);
for (const k of ['ACK','MIN_2','MIN_5','READY','PROBLEM','CUSTOM']) {
    ok(`1c. ${k} present`, qrKeys.includes(k));
}

// ─── §2. isCustom ────────────────────────────────────────────────────────────
console.log('\n  — 2. isCustom —\n');
ok('2a. CUSTOM is custom', MexQR.isCustom('CUSTOM'));
for (const k of ['ACK','MIN_2','MIN_5','READY','PROBLEM']) {
    ok(`2b. ${k} is not custom`, !MexQR.isCustom(k));
}
ok('2c. undefined is not custom', !MexQR.isCustom(undefined));

// ─── §3. renderBody ──────────────────────────────────────────────────────────
console.log('\n  — 3. renderBody —\n');
for (const k of ['ACK','MIN_2','MIN_5','READY','PROBLEM']) {
    const body = MexQR.renderBody(k, t);
    ok(`3a. ${k} renders non-empty string`, typeof body === 'string' && body.length > 0, body);
    notOk(`3b. ${k} body has no i18n key fallback`, body.startsWith('mex.qr.'), body);
}
ok('3c. CUSTOM returns null', MexQR.renderBody('CUSTOM', t) === null);
ok('3d. unknown key returns null', MexQR.renderBody('UNKNOWN', t) === null);
// Italian body texts (per spec)
ok('3e. ACK_body is "Ricevuto."', MexQR.renderBody('ACK', t) === 'Ricevuto.');
ok('3f. MIN_5_body contains "5"', MexQR.renderBody('MIN_5', t).includes('5'));
ok('3g. READY_body is "Pronto."', MexQR.renderBody('READY', t) === 'Pronto.');

// ─── §4. buttonLabel ─────────────────────────────────────────────────────────
console.log('\n  — 4. buttonLabel —\n');
for (const k of ['ACK','MIN_2','MIN_5','READY','PROBLEM','CUSTOM']) {
    const lbl = MexQR.buttonLabel(k, t);
    ok(`4a. ${k} label is non-empty`, typeof lbl === 'string' && lbl.length > 0, lbl);
}

// ─── §5. mex-store: addReply ─────────────────────────────────────────────────
console.log('\n  — 5. mex-store addReply —\n');
const DATA_DIR = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'mex7unit-'));
process.env.DATA_DIR = DATA_DIR;
const store = require('../service/mex-store.js');
store._resetForTest();
store.init(DATA_DIR, null, null);

(async () => {
    // Create base conversation
    const r = await store.createAndSend({
        companyId: 'co1', senderDeptId: 'dept-a', recipientDeptId: 'dept-b',
        body: 'Test message'
    });
    const conv = r.conversation;
    ok('5a. conversation created', !!conv);
    ok('5b. conv.replies initially empty or undefined', !conv.replies || conv.replies.length === 0);

    // Add ACK reply from recipient
    const r1 = await store.addReply('co1', conv.id, {
        from: 'dept-b', replyType: 'ACK', body: MexQR.renderBody('ACK', t)
    });
    ok('5c. addReply returns reply', !!r1.reply);
    ok('5d. reply.id starts with mexrep_', r1.reply.id.startsWith('mexrep_'), r1.reply.id);
    ok('5e. reply.from is dept-b', r1.reply.from === 'dept-b', r1.reply.from);
    ok('5f. reply.replyType is ACK', r1.reply.replyType === 'ACK', r1.reply.replyType);
    ok('5g. reply.body is correct', r1.reply.body === 'Ricevuto.', r1.reply.body);
    ok('5h. reply.createdAt set', typeof r1.reply.createdAt === 'string');

    // Original sender can reply back
    const r2 = await store.addReply('co1', conv.id, {
        from: 'dept-a', replyType: 'MIN_5', body: MexQR.renderBody('MIN_5', t)
    });
    ok('5i. Original sender can reply back', !!r2.reply);
    ok('5j. Reply from dept-a stored', r2.reply.from === 'dept-a', r2.reply.from);

    // All five QR types stored correctly
    for (const type of ['ACK','MIN_2','MIN_5','READY','PROBLEM']) {
        const rN = await store.addReply('co1', conv.id, {
            from: 'dept-b', replyType: type, body: MexQR.renderBody(type, t) || 'test'
        });
        ok(`5k. ${type} stored`, rN.reply.replyType === type, rN.reply.replyType);
    }

    // CUSTOM reply
    const rC = await store.addReply('co1', conv.id, {
        from: 'dept-b', replyType: 'CUSTOM', body: 'Custom free text'
    });
    ok('5l. CUSTOM reply stored', rC.reply.replyType === 'CUSTOM', rC.reply.replyType);
    ok('5m. CUSTOM body preserved', rC.reply.body === 'Custom free text', rC.reply.body);

    // ─── §6. Security: addReply rejects non-participants ─────────────────────
    console.log('\n  — 6. addReply security —\n');
    try {
        await store.addReply('co1', conv.id, { from: 'dept-c', replyType: 'ACK', body: 'test' });
        ok('6a. Non-participant rejected', false);
    } catch (e) {
        ok('6a. Non-participant rejected', e.code === 'MEX_NOT_PARTICIPANT', e.code);
    }

    try {
        await store.addReply('co1', 'mexconv_nonexistent', { from: 'dept-a', replyType: 'ACK', body: 'test' });
        ok('6b. Missing conv rejected', false);
    } catch (e) {
        ok('6b. Missing conv rejected', e.code === 'MEX_CONVERSATION_NOT_FOUND', e.code);
    }

    // Closed conversation rejected
    const co1 = store._mexStore['co1'];
    conv.closedAt = new Date().toISOString();
    try {
        await store.addReply('co1', conv.id, { from: 'dept-b', replyType: 'ACK', body: 'test' });
        ok('6c. Closed conv rejected', false);
    } catch (e) {
        ok('6c. Closed conv rejected', e.code === 'MEX_CONVERSATION_CLOSED', e.code);
    }
    conv.closedAt = null; // restore

    // ─── §7. getInboxForDept includes replies ─────────────────────────────────
    console.log('\n  — 7. getInboxForDept includes replies —\n');
    const inbox = await store.getInboxForDept('co1', 'dept-b');
    const inboxConv = inbox.find(c => c.id === conv.id);
    ok('7a. Conversation in inbox', !!inboxConv);
    ok('7b. inboxConv.replies is array', Array.isArray(inboxConv.replies), typeof inboxConv.replies);
    ok('7c. replies contain ACK', inboxConv.replies.some(r => r.replyType === 'ACK'));
    ok('7d. reply has required fields', inboxConv.replies.every(r =>
        r.id && r.conversationId && r.from && r.body && r.createdAt));

    // ─── §8. Backward compat: legacy messages (no replies field) ─────────────
    console.log('\n  — 8. Backward compat —\n');
    const legacyConvId = 'mexconv_legacy_' + crypto.randomBytes(4).toString('hex');
    store._mexStore['co1'].conversations[legacyConvId] = {
        id: legacyConvId, companyId: 'co1',
        participants: ['dept-a', 'dept-b'],
        createdAt: new Date().toISOString(), createdBy: 'dept-a',
        closedAt: null, readBy: {},
        messages: [{ id: 'mexmsg_legacy', conversationId: legacyConvId,
            from: 'dept-a', body: 'legacy text', timestamp: new Date().toISOString() }]
        // NO replies field — simulates Step 3-6 conversation
    };
    const inbox2 = await store.getInboxForDept('co1', 'dept-b');
    const legacyConv = inbox2.find(c => c.id === legacyConvId);
    ok('8a. Legacy conv loads', !!legacyConv);
    ok('8b. Legacy conv.replies is empty array', Array.isArray(legacyConv.replies) && legacyConv.replies.length === 0,
       legacyConv.replies);
    ok('8c. Legacy messages intact', legacyConv.messages[0].body === 'legacy text');

    // ─── §9. i18n dictionary integrity ───────────────────────────────────────
    console.log('\n  — 9. i18n integrity —\n');
    const QR_KEYS = [
        'mex.qr.ACK', 'mex.qr.MIN_2', 'mex.qr.MIN_5', 'mex.qr.READY', 'mex.qr.PROBLEM', 'mex.qr.CUSTOM',
        'mex.qr.ACK_body', 'mex.qr.MIN_2_body', 'mex.qr.MIN_5_body', 'mex.qr.READY_body', 'mex.qr.PROBLEM_body',
        'mex.qr.customPlaceholder', 'mex.qr.customTitle', 'mex.qr.repliedBy',
        'mex.qr.sending', 'mex.qr.sent', 'mex.qr.error'
    ];
    for (const lang of ['it','en','fr']) {
        const d = JSON.parse(fs.readFileSync(pathmod.join(__dirname, `../public/i18n/${lang}.json`), 'utf8'));
        const missing = QR_KEYS.filter(k => !d[k]);
        ok(`9a. ${lang}.json has all mex.qr.* keys`, missing.length === 0, missing);
    }

    // ─── Summary ─────────────────────────────────────────────────────────────
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`Mex Step 7 QR unit tests: ${passed} passed, ${failed} failed`);
    if (!failed) console.log('✅ All Mex Step 7 QR unit tests passed.');
    else console.error(`❌ ${failed} test(s) failed.`);
    console.log('──────────────────────────────────────────────────────\n');
    process.exit(failed ? 1 : 0);
})();
