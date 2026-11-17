'use strict';

// Independent platform administration gate.
// NEVER use the restaurant HMAC session token, a client-supplied email or a
// restaurant DIRECTOR membership to authorize global platform access.
const OWNER_EMAIL = 'chezan79@gmail.com';

function configuredPlatformUid(env = process.env) {
  const value = env.PLATETIMER_PLATFORM_ADMIN_UID;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  return match ? match[1] : null;
}

function createPlatformAuth({ auth, env = process.env } = {}) {
  if (!auth || typeof auth.verifyIdToken !== 'function' || typeof auth.getUser !== 'function')
    throw new TypeError('Firebase Admin authentication provider required');
  return async function authorize(header) {
    // Fail closed unless a specific verified Firebase user UID is provisioned
    // by an operator through a private environment variable.
    const expectedUid = configuredPlatformUid(env);
    if (!expectedUid) return { ok: false, status: 503, code: 'PLATFORM_ADMIN_NOT_CONFIGURED' };
    const token = getBearerToken(header);
    if (!token) return { ok: false, status: 401, code: 'FIREBASE_ID_TOKEN_REQUIRED' };
    try {
      const decoded = await auth.verifyIdToken(token, true);
      if (!decoded || decoded.uid !== expectedUid)
        return { ok: false, status: 403, code: 'PLATFORM_ADMIN_FORBIDDEN' };
      // Read the authoritative Admin SDK user record, not self-editable profile claims.
      const user = await auth.getUser(expectedUid);
      if (user.disabled || user.emailVerified !== true ||
          String(user.email || '').toLowerCase() !== OWNER_EMAIL)
        return { ok: false, status: 403, code: 'PLATFORM_ADMIN_FORBIDDEN' };
      return { ok: true, uid: expectedUid, email: OWNER_EMAIL };
    } catch (_) {
      // Do not expose Firebase details, credentials, identity or user existence.
      return { ok: false, status: 401, code: 'FIREBASE_AUTH_FAILED' };
    }
  };
}
module.exports = { OWNER_EMAIL, configuredPlatformUid, getBearerToken, createPlatformAuth };
