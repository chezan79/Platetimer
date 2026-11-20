'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceAccess, mountPlatformVoiceAdmin } = require('../service/platform-voice-admin');

function mockDb() {
  const storage = new Map();
  return {
    collection: () => ({
      doc: key => ({
        get: async () => ({
          exists: storage.has(key),
          data: () => storage.get(key)
        }),
        set: async value => { storage.set(key, value); }
      })
    })
  };
}
function makeApp() {
  const routes = {};
  return {
    routes,
    get: (path, fn) => { routes['GET '+path] = fn; },
    put: (path, fn) => { routes['PUT '+path] = fn; }
  };
}
async function call(fn, { uid, body } = {}) {
  const req = { headers: { authorization: 'Bearer '+(uid || 'other') }, body };
  const res = {
    statusCode: 200, headers: {},
    setHeader(k,v) { this.headers[k] = v; },
    status(n) { this.statusCode = n; return this; },
    json(v) { this.body = v; return this; }
  };
  await fn(req, res);
  return res;
}
test('Agora is disabled by default and isolated by restaurant', async () => {
  const voice = createVoiceAccess({db:mockDb()});
  assert.equal(await voice.enabled('pizzeria molino molard'),false);
  await voice.write('pizzeria molino molard',true,'admin-uid');
  assert.equal(await voice.enabled('pizzeria molino molard'),true);
  assert.equal(await voice.enabled('molino bern'),false);
  await voice.write('pizzeria molino molard',false,'admin-uid');
  assert.equal(await voice.enabled('pizzeria molino molard'),false);
});
test('missing Firebase denies all voice access', async () => {
  const voice = createVoiceAccess({db:null});
  assert.equal(await voice.enabled('pizzeria molino molard'),false);
  await assert.rejects(() => voice.write('pizzeria molino molard',true,'admin'));
});
test('only verified platform UID can read and write voice settings', async () => {
  const old = process.env.PLATETIMER_PLATFORM_ADMIN_UID;
  process.env.PLATETIMER_PLATFORM_ADMIN_UID='admin-uid';
  try {
    const db=mockDb(), voice=createVoiceAccess({db}), app=makeApp();
    mountPlatformVoiceAdmin(app,{
      db,voiceAccess:voice,
      lookupFirebaseAccount:async token=>({localId:token,emailVerified:token==='admin-uid',disabled:false}),
      getCompanies:()=>[{companyId:'pizzeria molino molard',departments:3},{companyId:'molino bern',departments:2}]
    });
    const put=app.routes['PUT /api/platform/voice-access'];
    const get=app.routes['GET /api/platform/voice-access'];
    assert.equal((await call(put,{uid:'other',body:{companyId:'pizzeria molino molard',enabled:true}})).statusCode,403);
    assert.equal((await call(put,{uid:'admin-uid',body:{companyId:'unknown',enabled:true}})).statusCode,404);
    assert.equal((await call(put,{uid:'admin-uid',body:{companyId:'pizzeria molino molard',enabled:'true'}})).statusCode,400);
    assert.equal((await call(put,{uid:'admin-uid',body:{companyId:'pizzeria molino molard',enabled:true}})).statusCode,200);
    assert.equal((await call(get,{uid:'other'})).statusCode,403);
    const list=await call(get,{uid:'admin-uid'});
    assert.equal(list.statusCode,200);
    assert.deepEqual(list.body.restaurants.map(x=>x.enabled),[true,false]);
  } finally {
    if(old===undefined)delete process.env.PLATETIMER_PLATFORM_ADMIN_UID;
    else process.env.PLATETIMER_PLATFORM_ADMIN_UID=old;
  }
});
