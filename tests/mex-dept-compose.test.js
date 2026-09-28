#!/usr/bin/env node
'use strict';

// Interaction regression: exercise the actual department compose functions and
// dynamically generated rows in a DOM, including the radio's inline click.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../public/department.html'), 'utf8');
function functionSource(name, html = source) {
    let start = html.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    if (html.slice(start - 6, start) === 'async ') start -= 6;
    const end = html.indexOf('\n}', start);
    assert.notEqual(end, -1, `missing end of ${name}`);
    return html.slice(start, end + 2);
}

async function makeCompose(html = source) {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="mex-recipient-list"></div>
        <textarea id="mex-body"></textarea>
        <button id="mex-send-btn" disabled>Invia</button>
        <div id="mex-send-status"></div><span id="mex-char-count"></span>
        <div id="mex-step-qm"></div><div id="mex-step-table"></div><div id="mex-step-send"></div>
        <div id="mex-send-preview"></div>
    </body>`, { runScripts: 'dangerously' });
    const { window } = dom;
    const sent = [];
    window.fetch = async () => ({
        json: async () => ({ success: true, recipients: [
            { id: 'dept_a', name: 'Cucina', active: true },
            { id: 'dept_b', name: 'Pizzeria', active: true }
        ] })
    });
    window.WebSocket = { OPEN: 1 };
    window.eval(`var token = 'test-token', myDeptId = 'dept_a', departmentMap = {},
        ws = { readyState: 1, send: payload => window.sent.push(JSON.parse(payload)) },
        _deptMexQmType = 'CUSTOM', _deptMexTableNum = null, mexSendPending = false;`);
    window.sent = sent;
    window.eval(`function _mt(key) { return key; }
        function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
        function mexDeptResetCompose() {}
        ${['buildMexRecipientList', 'toggleMexRecipient', 'mexUpdateSendBtn',
            'mexUpdateCharCount', 'mexStatus', 'sendMexMessage', 'handleMexSendAck']
            .map(name => functionSource(name, html)).join('\n')}`);
    await window.buildMexRecipientList();
    return { dom, window, document: window.document, sent };
}

async function run() {
    // Demonstrate the observed failure against the previous markup: native radio
    // selection works, but stopPropagation bypasses the row's state update.
    const previous = source.replaceAll(
        'onclick="toggleMexRecipient(this.value); event.stopPropagation()"',
        'onclick="event.stopPropagation()"');
    const old = await makeCompose(previous);
    old.document.getElementById('mxr-dept_b').click();
    assert.equal(old.document.getElementById('mxr-dept_b').checked, true);
    assert.equal(old.document.getElementById('mex-send-btn').disabled, true);
    old.dom.window.close();

    for (const target of ['radio', 'label', 'row']) {
        const { dom, window, document, sent } = await makeCompose();
        const row = document.getElementById('mxr-dept_b').closest('.mex-di');
        const element = target === 'radio' ? row.querySelector('input')
            : target === 'label' ? row.querySelector('label') : row;
        element.click();
        assert.equal(document.getElementById('mxr-dept_b').checked, true, target);
        assert.equal(row.classList.contains('sel'), true, target);
        assert.equal(document.getElementById('mex-send-btn').disabled, false, target);
        document.getElementById('mex-body').value = 'Pronto';
        window.sendMexMessage();
        assert.equal(JSON.stringify(sent[0]), JSON.stringify({ action: 'mexSend', to: 'dept_b', body: 'Pronto' }), target);
        assert.equal(document.getElementById('mex-send-btn').disabled, true, target);
        assert.equal(window.mexSendPending, true);
        window.handleMexSendAck({ success: false, code: 'MEX_INVALID_RECIPIENT' });
        assert.equal(window.mexSendPending, false);
        assert.equal(document.getElementById('mex-body').value, 'Pronto');
        assert.equal(document.getElementById('mex-send-btn').disabled, false);
        assert.equal(document.getElementById('mex-send-status').classList.contains('err'), true);
        assert.equal(document.getElementById('mex-send-status').textContent, 'dept.mexInvalidRecipient');
        window.handleMexSendAck({ success: false, code: 'MEX_NOT_BOUND' });
        assert.equal(document.getElementById('mex-send-status').textContent, 'dept.mexNotBound');
        dom.window.close();
    }

    const { dom, window, document, sent } = await makeCompose();
    document.getElementById('mxr-sala').click();
    assert.equal(document.getElementById('mex-send-btn').disabled, false);
    document.getElementById('mex-body').value = 'Sala';
    window.sendMexMessage();
    assert.equal(sent[0].to, '__sala__');
    window.handleMexSendAck({ success: true, conversationId: 'conv1' });
    assert.equal(document.getElementById('mex-send-status').classList.contains('ok'), true);
    assert.equal(document.getElementById('mex-body').value, '');
    assert.equal(window.mexSendPending, false);
    dom.window.close();

    const dropped = await makeCompose();
    dropped.document.getElementById('mxr-dept_b').click();
    dropped.document.getElementById('mex-body').value = 'Do not duplicate';
    dropped.window.sendMexMessage();
    dropped.window.WebSocket = class { constructor() { this.readyState = 1; } };
    dropped.window.setConnBadge = () => {};
    dropped.window.setTimeout = () => 0; // don't reconnect to a real server
    dropped.window.eval(functionSource('connectWS'));
    dropped.window.connectWS();
    dropped.window.ws.onclose();
    assert.equal(dropped.document.getElementById('mex-send-btn').disabled, false);
    assert.equal(dropped.document.getElementById('mex-body').value, 'Do not duplicate');
    assert.equal(dropped.document.getElementById('mex-send-status').classList.contains('err'), true);
    assert.equal(dropped.sent.length, 1, 'disconnect must not retry an ambiguous send');
    dropped.dom.window.close();
    console.log('Mex department compose: previous radio failure reproduced; radio, label, row, Floor, send and failure ACK passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });