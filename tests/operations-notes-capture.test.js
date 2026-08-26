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
const common = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'operations-common.js'), 'utf8');
const tasksPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'operations-tasks.html'), 'utf8');
const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(code => code.includes('async function toggleVoice'));

check('Manual note requests use the protected Operations Notes API',
    page.includes("OpsCommon.api('/api/operations/notes'") &&
    page.includes("const endpoint = _voiceCaptured ? '/api/operations/notes/voice' : '/api/operations/notes';"));
check('Notes list, dismiss, and task handoff use canonical absolute API paths',
    page.includes("OpsCommon.api('/api/operations/notes/'") &&
    tasksPage.includes("OpsCommon.api('/api/operations/notes/'"));
check('Notes count uses the canonical absolute API path',
    common.includes("api('/api/operations/notes/count')"));
check('Voice transcription uses the existing speech endpoint',
    page.includes("fetch('/api/speech-to-text'") &&
    !page.includes("fetch('voice'") && !page.includes('fetch("voice"'));
check('Quick Notes contains no bare notes or voice request targets',
    !/(?:fetch|api)\(\s*['"`](?:notes|voice)(?:['"`]|\/)/.test(page));
check('Voice-note persistence is text-only and separate from transcription',
    page.includes("body: JSON.stringify({ text })") &&
    !page.includes("OpsCommon.api('/api/speech-to-text'"));

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
    apiCalls: [],
    api: async (path, options = {}) => {
        window.OpsCommon.apiCalls.push({ path, options });
        return { success: true, count: 0, notes: [] };
    },
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

    // Manual capture must use the protected Notes API, not a page-relative URL.
    window.openCapture();
    window.document.getElementById('note-text').value = 'Manual route contract';
    await window.saveNote();
    const manualCall = window.OpsCommon.apiCalls.find(call => call.options.method === 'POST' &&
        call.path === '/api/operations/notes');
    check('Manual save calls POST /api/operations/notes', !!manualCall);
    check('Manual save sends only note text', !!manualCall &&
        JSON.parse(manualCall.options.body).text === 'Manual route contract' &&
        !('audio' in JSON.parse(manualCall.options.body)));

    // A completed recording must transcribe at the speech endpoint, then save
    // only the resulting text through the separate VOICE note persistence API.
    window.openCapture();
    const voiceStart = window.toggleVoice();
    const voiceStream = streamWithStopCounter();
    getUserMediaResolve(voiceStream);
    await voiceStart;
    window.fetch = (url, options) => {
        window.OpsCommon.lastSpeechCall = { url, options };
        speechSignal = options.signal;
        speechResolve = null;
        return Promise.resolve({
            ok: true,
            json: async () => ({ transcription: 'Transcript route contract' })
        });
    };
    window.toggleVoice();
    await wait();
    await wait();
    const speechCall = window.OpsCommon.lastSpeechCall;
    // The fetch shim records the request independently from OpsCommon.api,
    // whose responsibility is only protected note persistence.
    check('Voice recording posts to POST /api/speech-to-text', !!speechCall &&
        speechCall.url === '/api/speech-to-text' && speechCall.options.method === 'POST');
    check('Speech request keeps bearer auth and JSON audio payload', !!speechCall &&
        speechCall.options.headers.Authorization === 'Bearer test-token' &&
        typeof JSON.parse(speechCall.options.body).audioData === 'string' &&
        JSON.parse(speechCall.options.body).config.encoding === 'WEBM_OPUS');
    check('Speech request is not sent to the VOICE note persistence route',
        !speechCall || speechCall.url !== '/api/operations/notes/voice');
    check('Transcription is inserted before VOICE note save',
        window.document.getElementById('note-text').value === 'Transcript route contract');
    await window.saveNote();
    const voiceCall = window.OpsCommon.apiCalls.find(call => call.options.method === 'POST' &&
        call.path === '/api/operations/notes/voice');
    check('Transcript save calls POST /api/operations/notes/voice', !!voiceCall);
    check('VOICE persistence sends transcript text without audio', !!voiceCall &&
        JSON.parse(voiceCall.options.body).text === 'Transcript route contract' &&
        !('audioData' in JSON.parse(voiceCall.options.body)) &&
        !('audio' in JSON.parse(voiceCall.options.body)));
    check('No Quick Notes request uses a bare notes or voice path',
        window.OpsCommon.apiCalls.every(call => !/^(?:notes|voice)(?:\/|$)/.test(call.path)));

    console.log(`\nOperations Quick Note capture: ${passed} passed, ${failed} failed.`);
    process.exitCode = failed ? 1 : 0;
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});