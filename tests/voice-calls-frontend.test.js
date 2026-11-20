'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const browser=fs.readFileSync(path.join(__dirname,'../public/js/voice-preview-panel.js'),'utf8');
const page=fs.readFileSync(path.join(__dirname,'../public/department.html'),'utf8');

test('production endpoints mount separately from Replit Preview with authoritative Firestore lookup',()=>{
  assert.match(server,/mountProductionVoiceCalls\(app,/);
  assert.match(server,/getAuthoritativeServiceDeviceContext,/);
  assert.match(server,/db\.collection\(STORE_COLLECTION\)\.doc\('departments'\)/);
  assert.match(server,/PLATETIMER_VOICE_TEST_ENABLED.*REPL_ID/);
});
test('browser chooses production endpoints without enabling Replit preview in Railway',()=>{
  assert.match(browser,/fetch\('\/api\/voice-call\/status'/);
  assert.match(browser,/apiPrefix = '\/api\/voice-call'/);
  assert.match(browser,/fetch\('\/api\/voice-test\/status'/);
  assert.match(browser,/apiPrefix \+ '\/token'/);
  assert.match(page,/id="pt-voice-test-open"/);
});
test('only the invited call joins; browser can hang up and track peer termination',()=>{
  assert.match(browser,/body:JSON\.stringify\(\{callId\}\)/);
  assert.match(browser,/connect\(prodMode \? id : undefined\)/);
  assert.match(browser,/api\('session\?id='/);
  assert.match(browser,/api\('hangup'/);
  assert.match(browser,/token-privilege-will-expire/);
  assert.match(browser,/document\.hidden && prodMode && connected/);
});
test('existing manual countdown, voice command and invitation preview remain present',()=>{
  assert.match(page,/onclick="toggleVoiceCmd\(\)"/);
  assert.match(page,/onclick="toggleVoiceWindow\(\)"/);
  assert.match(page,/id="pt-voice-test-panel"/);
  assert.match(browser,/if \(prodMode\)/);
});
