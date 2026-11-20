'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPreviewVoiceEnabled, isCompanyVoiceAllowed, canUsePreviewVoice } =
  require('../service/voice-access-policy');

const env = {
  PLATETIMER_VOICE_TEST_ENABLED: 'true',
  REPL_ID: 'preview-instance',
  NODE_ENV: 'development',
  PLATETIMER_VOICE_ALLOWED_COMPANY_IDS: 'molard-company-id'
};
const device = {
  companyId: 'molard-company-id', departmentId: 'dept-cucina',
  account: { status: 'ACTIVE' }, department: { active: true }
};

test('preview voice requires explicit enable and a preview runtime', () => {
  assert.equal(isPreviewVoiceEnabled(env), true);
  assert.equal(isPreviewVoiceEnabled({ ...env, NODE_ENV: 'production' }), false);
  assert.equal(isPreviewVoiceEnabled({ ...env, REPL_ID: '' }), false);
  assert.equal(isPreviewVoiceEnabled({ ...env, PLATETIMER_VOICE_TEST_ENABLED: 'false' }), false);
});

test('deny all companies by default, including company name guesses', () => {
  assert.equal(isCompanyVoiceAllowed(device.companyId, { ...env, PLATETIMER_VOICE_ALLOWED_COMPANY_IDS: '' }), false);
  assert.equal(isCompanyVoiceAllowed(device.companyId, { ...env, PLATETIMER_VOICE_ALLOWED_COMPANY_IDS: '*' }), false);
  assert.equal(isCompanyVoiceAllowed('molard', env), false);
});

test('only exact allowlisted company ID is accepted', () => {
  assert.equal(isCompanyVoiceAllowed(device.companyId, env), true);
  assert.equal(isCompanyVoiceAllowed('another-restaurant', env), false);
  assert.equal(isCompanyVoiceAllowed('molard-company-id-other', env), false);
  assert.equal(isCompanyVoiceAllowed('molard-company-id', { ...env, PLATETIMER_VOICE_ALLOWED_COMPANY_IDS: ' another-restaurant, molard-company-id ' }), true);
});

test('active, authenticated department device required', () => {
  assert.equal(canUsePreviewVoice(device, env), true);
  assert.equal(canUsePreviewVoice(null, env), false);
  assert.equal(canUsePreviewVoice({ ...device, account: { status: 'SUSPENDED' } }, env), false);
  assert.equal(canUsePreviewVoice({ ...device, department: { active: false } }, env), false);
  assert.equal(canUsePreviewVoice({ ...device, companyId: 'another-restaurant' }, env), false);
  assert.equal(canUsePreviewVoice({ ...device, departmentId: '' }, env), false);
});

test('production remains blocked even when allowlist includes company', () => {
  assert.equal(canUsePreviewVoice(device, { ...env, NODE_ENV: 'production' }), false);
});
