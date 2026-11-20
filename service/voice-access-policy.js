'use strict';

// Preview-only company allowlist. Fail closed unless an explicit companyId is listed.
// Do not add a production enable switch until RTC signaling/session revocation is audited.
function isPreviewVoiceEnabled(env = process.env) {
  return env.PLATETIMER_VOICE_TEST_ENABLED === 'true' &&
    Boolean(env.REPL_ID) && env.NODE_ENV !== 'production';
}

function isCompanyVoiceAllowed(companyId, env = process.env) {
  if (typeof companyId !== 'string' || !companyId.trim()) return false;
  const allowlist = String(env.PLATETIMER_VOICE_ALLOWED_COMPANY_IDS || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  // Never support "*" or partial company-name matching.
  return allowlist.includes(companyId.trim().toLowerCase());
}

function canUsePreviewVoice(device, env = process.env) {
  return isPreviewVoiceEnabled(env) &&
    Boolean(device && device.account && device.account.status === 'ACTIVE' &&
      device.department && device.department.active === true &&
      device.companyId && device.departmentId &&
      isCompanyVoiceAllowed(device.companyId, env));
}

module.exports = { isPreviewVoiceEnabled, isCompanyVoiceAllowed, canUsePreviewVoice };
