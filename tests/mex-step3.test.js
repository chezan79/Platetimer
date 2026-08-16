'use strict';
/**
 * Mex Step 3 — mex-store unit tests (Jest)
 *
 * Run via: npx jest tests/mex-step3.test.js
 *
 * WS/REST integration tests live in tests/mex-step3-ws.test.js
 * Run via: node tests/mex-step3-ws.test.js
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// mex-store unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe('mex-store unit', () => {
    let store;
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mex-unit-'));
        store  = require('../service/mex-store');
        store._resetForTest();
        store.init(tmpDir, null, null);
    });

    afterEach(() => {
        store._resetForTest();
        try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    });

    test('createAndSend — creates conversation with correct shape', async () => {
        const { conversation, message } = await store.createAndSend({
            companyId: 'co_A', senderDeptId: 'dept_1', recipientDeptId: 'dept_2', body: 'Hello dept 2'
        });
        expect(conversation.id).toMatch(/^mexconv_/);
        expect(message.id).toMatch(/^mexmsg_/);
        expect(message.from).toBe('dept_1');          // server-derived sender
        expect(message.body).toBe('Hello dept 2');
        expect(conversation.participants).toEqual(['dept_1','dept_2']);
        expect(conversation.closedAt).toBeNull();
        expect(conversation.companyId).toBe('co_A');
    });

    test('createAndSend — persists to local file', async () => {
        await store.createAndSend({ companyId:'co_B', senderDeptId:'d1', recipientDeptId:'d2', body:'hi' });
        const raw   = JSON.parse(fs.readFileSync(path.join(tmpDir,'mex-conversations.json'),'utf8'));
        const convs = raw['co_B'];
        expect(Object.keys(convs).length).toBe(1);
    });

    test('getInboxForDept — returns messages for participant dept', async () => {
        await store.createAndSend({ companyId:'co_C', senderDeptId:'d1', recipientDeptId:'d2', body:'msg1' });
        await store.createAndSend({ companyId:'co_C', senderDeptId:'d3', recipientDeptId:'d4', body:'msg2' });

        const inbox = await store.getInboxForDept('co_C','d2');
        expect(inbox.length).toBe(1);
        expect(inbox[0].messages[0].body).toBe('msg1');
        expect(inbox[0].messages[0].from).toBe('d1');
    });

    test('getInboxForDept — excludes non-participant departments', async () => {
        await store.createAndSend({ companyId:'co_D', senderDeptId:'d1', recipientDeptId:'d2', body:'secret' });
        const inbox = await store.getInboxForDept('co_D','d3');
        expect(inbox.length).toBe(0);
    });

    test('getInboxForDept — excludes closed conversations', async () => {
        const { conversation } = await store.createAndSend({
            companyId:'co_E', senderDeptId:'d1', recipientDeptId:'d2', body:'old'
        });
        store._mexStore['co_E'].conversations[conversation.id].closedAt = new Date().toISOString();

        const inbox = await store.getInboxForDept('co_E','d2');
        expect(inbox.length).toBe(0);
    });

    test('MEX_MAX_BODY_LENGTH — exported constant equals 300', () => {
        expect(store.MEX_MAX_BODY_LENGTH).toBe(300);
    });

    test('createAndSend — rejects when company is at open-conv cap', async () => {
        const cap   = store.MEX_MAX_OPEN_CONVERSATIONS; // 30
        const sends = [];
        for (let i = 0; i < cap; i++) {
            sends.push(store.createAndSend({
                companyId:'co_F', senderDeptId:`d${i}`, recipientDeptId:'d99', body:'x'
            }));
        }
        await Promise.all(sends);
        await expect(
            store.createAndSend({ companyId:'co_F', senderDeptId:'d100', recipientDeptId:'d101', body:'overflow' })
        ).rejects.toMatchObject({ code: 'MEX_OVER_CAPACITY' });
    }, 15000);

    test('createAndSend — multiple companies are isolated', async () => {
        await store.createAndSend({ companyId:'co_G', senderDeptId:'d1', recipientDeptId:'d2', body:'G msg' });
        await store.createAndSend({ companyId:'co_H', senderDeptId:'d3', recipientDeptId:'d4', body:'H msg' });

        const gInbox = await store.getInboxForDept('co_G','d2');
        const hInbox = await store.getInboxForDept('co_H','d4');
        expect(gInbox.length).toBe(1);
        expect(hInbox.length).toBe(1);
        expect(gInbox[0].messages[0].body).toBe('G msg');
        expect(hInbox[0].messages[0].body).toBe('H msg');
    });

    test('applyRetention — trims messages to MEX_MAX_MESSAGES_PER_CONVERSATION', async () => {
        // Create a conversation then manually stuff > MAX messages
        const { conversation } = await store.createAndSend({
            companyId:'co_I', senderDeptId:'d1', recipientDeptId:'d2', body:'first'
        });
        const convs = store._mexStore['co_I'].conversations;
        const conv  = convs[conversation.id];
        const max   = store.MEX_MAX_MESSAGES_PER_CONVERSATION;
        // Pack messages beyond the cap
        for (let i = 1; i <= max + 5; i++) {
            conv.messages.push({ id:`m${i}`, conversationId: conv.id, from:'d1',
                body:`body ${i}`, timestamp: new Date().toISOString() });
        }
        expect(conv.messages.length).toBeGreaterThan(max);
        // Trigger another createAndSend so applyRetention runs
        await store.createAndSend({ companyId:'co_I', senderDeptId:'d3', recipientDeptId:'d4', body:'trigger' });
        expect(conv.messages.length).toBe(max);
    });
});
