'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlatformAuth, getBearerToken } = require('../platform-monitor/auth');
const env = { PLATETIMER_PLATFORM_ADMIN_UID: 'trusted-firebase-uid' };
const goodUser = { email: 'chezan79@gmail.com', emailVerified: true, disabled: false };
const auth = {
  verifyIdToken: async () => ({ uid: 'trusted-firebase-uid' }),
  getUser: async () => goodUser
};

test('missing provisioned UID denies access before verification', async () => {
  let called = false;
  const guard = createPlatformAuth({ env: {}, auth: {
    verifyIdToken: async () => { called = true; throw Error('unexpected'); },
    getUser: async () => { called = true; throw Error('unexpected'); }
  } });
  const result = await guard('Bearer token');
  assert.equal(result.status, 503);
  assert.equal(called, false);
});

test('invalid bearer header denied', async () => {
  const guard = createPlatformAuth({ auth, env });
  assert.equal((await guard('anything')).status, 401);
  assert.equal(getBearerToken('Bearer fake.token'), 'fake.token');
});

test('different UID denied, even when email matches', async () => {
  const guard = createPlatformAuth({ env, auth: {
    verifyIdToken: async () => ({ uid: 'restaurant-director' }),
    getUser: async () => goodUser
  } });
  assert.equal((await guard('Bearer valid')).status, 403);
});

test('unverified or disabled accounts denied', async () => {
  for (const user of [{...goodUser, emailVerified:false}, {...goodUser, disabled:true}]) {
    const guard = createPlatformAuth({ env, auth: {
      verifyIdToken: auth.verifyIdToken, getUser: async () => user
    } });
    assert.equal((await guard('Bearer valid')).status, 403);
  }
});

test('wrong authoritative email denied', async () => {
  const guard = createPlatformAuth({ env, auth: {
    verifyIdToken: auth.verifyIdToken,
    getUser: async () => ({...goodUser,email:'someoneelse@example.org'})
  } });
  assert.equal((await guard('Bearer valid')).status, 403);
});

test('revoked or invalid token denied', async () => {
  const guard = createPlatformAuth({ env, auth: {
    verifyIdToken: async () => { throw Error('expired or revoked'); },
    getUser: async () => goodUser
  } });
  assert.equal((await guard('Bearer token')).status, 401);
});

test('only exact UID plus verified owner email allowed', async () => {
  const guard = createPlatformAuth({ env, auth });
  assert.deepEqual(await guard('Bearer valid'), {
    ok:true, uid:'trusted-firebase-uid', email:'chezan79@gmail.com'
  });
});
