'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const index=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const home=fs.readFileSync(path.join(__dirname,'../public/home.html'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
test('central admin is recognized only by verified server identity',()=>{
  assert.match(server,/uid === platformAdminUid/);
  assert.match(server,/fbUser\.emailVerified !== true/);
  assert.match(server,/return res\.json\(\{ success: true, isPlatformAdmin: true \}\)/);
  assert.match(index,/platformIdentity\.isPlatformAdmin === true/);
});
test('login fails closed before looking up any restaurant profile',()=>{
  const start=index.indexOf('const platformIdentity = await platformResponse.json()');
  const stop=index.indexOf('const userDoc = await getDoc(doc(db, "users", user.uid))');
  assert.ok(start>=0&&stop>start);
  const gate=index.slice(start,stop);
  assert.match(gate,/!platformResponse\.ok/);
  assert.match(gate,/!platformIdentity\.token/);
  assert.match(gate,/localStorage\.removeItem\('userCompany'\)/);
  assert.match(gate,/throw new Error/);
  assert.match(gate,/window\.location\.replace\('\/platform-admin\.html'\)/);
});
test('home cannot enter legacy restaurant path when platform identity fails',()=>{
  const authStart=home.indexOf('const sessResp = await fetch');
  const legacyStart=home.indexOf('const userDocRef = doc(db, "users", user.uid)');
  assert.ok(authStart>=0&&legacyStart>authStart);
  const gate=home.slice(authStart,legacyStart);
  assert.match(gate,/!sessResp\.ok/);
  assert.match(gate,/!parsed\.token \|\| !parsed\.companyName/);
  assert.match(gate,/localStorage\.removeItem\('userCompany'\)/);
  assert.match(gate,/return;/);
  assert.match(gate,/window\.location\.replace\('\/platform-admin\.html'\)/);
});
