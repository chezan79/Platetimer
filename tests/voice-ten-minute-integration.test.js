'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname,'../public/department.html'),'utf8');
test('department loads ten-minute capture module before inline command handler', () => {
  assert.match(html, /<script src="js\/voice-session-10min\.js"><\/script>/);
  assert.match(html, /PlateTimerVoiceSession\.createVoiceSession/);
  assert.match(html, /onClip: \(blob, guard\) => processVoiceCmd\(blob, guard\.isCurrent\)/);
});
test('voice commands keep auto dispatch and reject stale callbacks', () => {
  assert.match(html, /async function processVoiceCmd\(blob, isCurrent\)/);
  assert.match(html, /if\(!isCurrent\(\)\) return;/);
  assert.match(html, /action:\s*'startCountdown'/);
  assert.match(html, /destinations:\s*deptIds/);
  assert.match(html, /window\.addEventListener\('pagehide', stopVoiceCmd\)/);
  assert.doesNotMatch(html, /vcMediaRec\.onstop = processVoiceCmd/);
});
