'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

test('public welcome and access screen use the same existing PlateTimer logo', () => {
  assert.match(html, /id="pt-welcome"/);
  assert.match(html, /href="\/index\.html\?view=access"/);
  assert.match(html, /href="\/index\.html\?view=register"/);
  assert.equal((html.match(/src="platetimer-logo\.png"/g)||[]).length, 2);
});
test('unified access retains exactly one department entry and the existing email form', () => {
  assert.equal((html.match(/id="dept-access"/g)||[]).length, 1);
  assert.match(html, /href="\/service-login\.html"/);
  assert.match(html, /id="form-login"/);
  assert.match(html, /id="login-email"/);
  assert.match(html, /id="login-password"/);
  assert.match(html, /id="form-register"/);
  assert.match(html, /id="form-forgot-password"/);
  assert.match(html, /id="form-change-password"/);
});
test('existing server-verified platform administrator routing is unchanged', () => {
  assert.match(html, /signInWithEmailAndPassword\(auth, email, password\)/);
  assert.match(html, /platformIdentity\.isPlatformAdmin === true/);
  assert.match(html, /window\.location\.replace\('\/platform-admin\.html'\)/);
  assert.match(html, /window\.location\.href = redirectTarget/);
  assert.match(html, /sessionStorage\.setItem\('ws_session_token', sessionData\.token\)/);
});
