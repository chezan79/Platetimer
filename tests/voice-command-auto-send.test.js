'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/department.html'), 'utf8');

test('a validated voice command is dispatched immediately without showing confirmation UI', () => {
  const functionText = html.match(/function showVoiceDraft\(parsed\)\{[\s\S]*?\n\}(?=\nfunction cancelVoiceDraft\()/);
  assert.ok(functionText, 'showVoiceDraft function exists');
  const elements = {
    'vc-preview': { textContent: '' },
    'vc-confirm': { style: { display: '' } },
    'vc-language': { disabled: false }
  };
  let dispatched = 0;
  const context = {
    document: { getElementById: id => elements[id] },
    departmentMap: { pizzeria: { name: 'Pizzeria' } },
    voiceStrings: () => ({ transcript: 'Trascrizione', table: 'Tavolo', duration: 'Durata', minutes: 'minuti', dest: 'Destinazioni' }),
    confirmVoiceDraft: () => { dispatched++; }
  };
  vm.runInNewContext(functionText[0] + '\nshowVoiceDraft({transcription:"Tavolo 12 otto minuti Pizzeria",tableNumber:"12",durationMinutes:8,departmentIds:["pizzeria"]});', context);
  assert.equal(dispatched, 1, 'must dispatch exactly once');
  assert.equal(elements['vc-confirm'].style.display, 'none', 'confirmation must not block delivery');
  assert.match(elements['vc-preview'].textContent, /Pizzeria/);
});

test('both microphone paths route validated commands to auto dispatch', () => {
  assert.match(html, /onCommand:transcription=>\{[\s\S]*?if\(!parsed\.ok\|\|!wsConnected\)return false;\s*showVoiceDraft\(parsed\);/);
  assert.match(html, /async function processVoiceCmd\(\)[\s\S]*?if\(!parsed\.ok\)[\s\S]*?showVoiceDraft\(parsed\);/);
  assert.match(html, /function confirmVoiceDraft\(\)[\s\S]*?if\(!wsConnected\|\|!ws\|\|ws\.readyState!==WebSocket\.OPEN\)/);
  assert.match(html, /function confirmVoiceDraft\(\)[\s\S]*?if\(existing&&existing\.expiredAt===null&&existing\.timeRemaining>0\)/);
});
