'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { snapshot, mountPlatformMonitor } = require('../admin-monitor/monitor-api');

function socket(companyRoom, department, extras = {}) {
  return {
    readyState: WebSocket.OPEN, isAuthenticated: true, lastPong: 100000,
    companyRoom, boundDepartmentId: department,
    departmentAccountStatus: department ? 'ACTIVE' : null,
    ...extras
  };
}
const dependencies = () => ({
  wss: { clients: new Set([
    socket('pizzeria molino molard', 'd1'),
    socket('pizzeria molino molard', 'd1'),
    socket('pizzeria molino molard', 'd2'),
    socket('molino bern', 'd3', {lastPong: 1}),
    socket('molino balexert', 'd4', {isAuthenticated:false}),
    socket('molino la praille', null, {readyState:WebSocket.CLOSED})
  ])},
  getCompanies: () => [
    {companyId:'pizzeria molino molard',departments:3},
    {companyId:'molino bern',departments:2},
    {companyId:'molino balexert',departments:2},
    {companyId:'molino la praille',departments:2}
  ],
  getCountdowns: name => name === 'pizzeria molino molard' ? 6 : 0,
  now: 100010
});
test('counts only authenticated, fresh WebSockets per restaurant', () => {
  const result = snapshot(dependencies());
  assert.deepEqual(result.totals, {
    registered:4, online:1, connections:3, connectedDepartments:2, activeCountdowns:6
  });
  assert.equal(result.restaurants.find(r=>r.companyId==='molino bern').online,false);
  assert.equal(result.restaurants.find(r=>r.companyId==='pizzeria molino molard').connections,3);
  assert.equal(JSON.stringify(result).includes('authenticatedUid'),false);
});
function app() {
  const routes={};
  return {routes,get:(p,fn)=>{routes[p]=fn;}};
}
async function request(handler, token) {
  const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(x){this.data=x;return this;}};
  await handler({headers:{authorization:token ? 'Bearer '+token : ''}},res);
  return res;
}
test('only verified platform admin UID can access monitor', async () => {
  const old=process.env.PLATETIMER_PLATFORM_ADMIN_UID;
  process.env.PLATETIMER_PLATFORM_ADMIN_UID='platform-admin';
  try {
    const application=app();
    const args=dependencies();
    mountPlatformMonitor(application,{
      ...args,lookupFirebaseAccount: async token => ({
        localId:token,emailVerified:token!=='unverified',disabled:false
      })
    });
    const handler=application.routes['/api/platform/monitor/live'];
    assert.equal((await request(handler,null)).statusCode,401);
    assert.equal((await request(handler,'restaurant-uid')).statusCode,403);
    const allowed=await request(handler,'platform-admin');
    assert.equal(allowed.statusCode,200);
    assert.equal(allowed.data.totals.online,1);
  } finally {
    if(old===undefined)delete process.env.PLATETIMER_PLATFORM_ADMIN_UID;
    else process.env.PLATETIMER_PLATFORM_ADMIN_UID=old;
  }
});
