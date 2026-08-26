// Browser-level capture cancellation regression tests for Operations Quick Notes.
// A closed modal must never start a late recorder or append a late transcript.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
    if (condition) { passed++; console.log(`  ✅ ${label}`); }
    else { failed++; console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const wait = () => new Promise(resolve => setTimeout(resolve, 0));

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'operations-notes.html'), 'utf8');
const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(code => code.includes('async function toggleVoice'));

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="capture-modal"><textarea id="note-text"></textarea></div>
  <button id="voice-btn"></button><span id="voice-btn-label"></span>
  <div id="capture-state"></div><button id="save-note-btn"></button>
  <div id="notes-list"></div><div id="notes-empty"></div><span id="me-name"></span><span id="me-role"></span>
  <span id="i18n-sel"></span>
</body></html>`, { runScripts: 'dangerously', url: 'http://example.test/operations-notes.html' });

const { window } = dom;
window.I18n = { t: key => key, getLanguage: () => 'en', init: () => new Promise(() => {}) };
window.OpsCommon = {
    escHtml: value => String(value),
    api: async () => ({ success: true, count: 0, notes: [] }),
    fmtDatetime: () => '',
    showError() {},
    loadMe: async () => null,
    roleLabel: () => ''
};
window.WsAuth = { getStoredToken: () => 'test-token' };

class FakeRecorder {
    static instances = [];
    static isTypeSupported() { return true; }
    constructor(stream, options) {
        this.stream = stream;
        this.mimeType = options && options.mimeType || 'audio/webm';
        this.state = 'inactive';
        FakeRecorder.instances.push(this);
    }
    start() { this.state = 'recording'; }
    stop() {
        this.state = 'inactive';
        if (this.ondataavailable) this.ondataavailable({ data: new window.Blob(['audio'], { type: this.mimeType }) });
        if (this.onstop) this.onstop();
    }
}
window.MediaRecorder = FakeRecorder;

let getUserMediaResolve;
let getUserMediaPromise;
window.navigator.mediaDevices = {
    getUserMedia: () => {
        getUserMediaPromise = new Promise(resolve => { getUserMediaResolve = resolve; });
        return getUserMediaPromise;
    }
};
window.eval(script);

function streamWithStopCounter() {
    const track = { stopped: false, stop() { this.stopped = true; } };
    return { getTracks: () => [track], track };
}

(async () => {
    // Cancel while the permission prompt is still pending.
    window.openCapture();
    const permissionStart = window.toggleVoice();
    const permissionStream = streamWithStopCounter();
    window.closeCapture();
    getUserMediaResolve(permissionStream);
    await permissionStart;
    check('Cancel during microphone permission stops the late stream', permissionStream.track.stopped);
    check('Cancel during microphone permission never starts a recorder', FakeRecorder.instances.length === 0);

    // Cancel after stop has begun transcription; a late response must be ignored.
    window.openCapture();
    const recordingStart = window.toggleVoice();
    const processingStream = streamWithStopCounter();
    getUserMediaResolve(processingStream);
    await recordingStart;
    const recorder = FakeRecorder.instances[0];
    let speechResolve;
    let speechSignal;
    window.fetch = (_url, options) => {
        speechSignal = options.signal;
        return new Promise(resolve => { speechResolve = resolve; });
    };
    window.toggleVoice();
    for (let i = 0; i < 25 && !speechResolve; i++) await wait();
    if (!speechResolve) throw new Error('speech request did not begin');
    window.closeCapture();
    check('Cancel during transcription aborts the speech request', !!speechSignal && speechSignal.aborted);
    speechResolve({ ok: true, json: async () => ({ transcription: 'Late transcript' }) });
    await wait();
    await wait();
    check('Canceled transcription never appends its transcript', window.document.getElementById('note-text').value === '');
    check('Cancel during transcription stops recorder tracks', processingStream.track.stopped);
    check('Recorder was started before the processing-cancel check', recorder && recorder.state === 'inactive');

    console.log(`\nOperations Quick Note capture: ${passed} passed, ${failed} failed.`);
    process.exitCode = failed ? 1 : 0;
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});