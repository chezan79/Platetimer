'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {mountProductionVoiceCalls,safeKey,rtcUid,channelFor} = require('../service/voice-calls-production');

function makeDb() {
  const data = new Map();
  const doc = key => ({
    async get() {return {exists:data.has(key),data:()=>data.get(key)};},
    _key:key
  });
  return {
    data,
    collection(name) {
      return {doc(id) {return doc(name+'/'+id);}};
    },
    async runTransaction(fn) {
      const writes=[];
      const tx={
        get:r=>r.get(),
        set:(r,v)=>writes.push(()=>data.set(r._key,v)),
        delete:r=>writes.push(()=>data.delete(r._key))
      };
      const result=await fn(tx);
      writes.forEach(f=>f());
      return result;
    }
  };
}
function fixture({clock=Date.now(),allowed=true,open=true}={}) {
  const routes={};
  const app={
    get:(path,fn)=>routes['GET '+path]=fn,
    post:(path,fn)=>routes['POST '+path]=fn
  };
  const db=makeDb();
  let time=clock;
  let company='molard';
  let departmentId='pizzeria';
  const depts=[
    {id:'pizzeria',name:'Pizzeria',active:true},
    {id:'cucina',name:'Cucina',active:true},
    {id:'inactive',name:'Inattivo',active:false}
  ];
  mountProductionVoiceCalls(app,{
    db,
    requireAuth: (req,res)=>{
      if(req.headers.authorization!=='Bearer valid') {
        res.status(401).json({error:'no session'});return null;
      }
      return {uid:'acct'};
    },
    getAuthoritativeServiceDeviceContext: async()=>({
      companyId:company,departmentId,
      department:depts.find(x=>x.id===departmentId)||{id:departmentId,name:departmentId}
    }),
    isVoiceAllowed: async()=>allowed,
    now:()=>time,
    getWindow:()=>({allowed:open,secondsRemaining:1800,timeZone:'Europe/Zurich'}),
    getDepartments:async id=>id==='molard'?depts:[{id:'cucina',name:'Cucina B',active:true}]
  });
  async function request(method,path,body,auth='Bearer valid') {
    const response={
      statusCode:200,headers:{},jsonBody:null,
      setHeader(k,v){this.headers[k]=v;},
      status(n){this.statusCode=n;return this;},
      json(v){this.jsonBody=v;return this;},
      get headersSent(){return this.jsonBody!==null;}
    };
    const handler=routes[method+' /api/voice-call'+path];
    assert.ok(handler,'route exists '+path);
    await handler({headers:{authorization:auth},body:body||{},query:body||{}},response);
    return {status:response.statusCode,...response.jsonBody};
  }
  return {db,request,setCompany:v=>company=v,setDept:v=>departmentId=v,
    advance:ms=>time+=ms,setOpen:v=>open=v,setAllowed:v=>allowed=v};
}
const oldNode=process.env.NODE_ENV;
const oldFlag=process.env.PLATETIMER_VOICE_CALLS_ENABLED;
test.before(()=>{process.env.NODE_ENV='production';process.env.PLATETIMER_VOICE_CALLS_ENABLED='true';});
test.after(()=>{
  if(oldNode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldNode;
  if(oldFlag===undefined)delete process.env.PLATETIMER_VOICE_CALLS_ENABLED;
  else process.env.PLATETIMER_VOICE_CALLS_ENABLED=oldFlag;
});
test('production calls require explicit opt-in plus authenticated authorized Service device',async()=>{
  const f=fixture();
  assert.equal((await f.request('GET','/status')).enabled,true);
  assert.equal((await f.request('GET','/status',null,'bad')).status,401);
  f.setAllowed(false);
  assert.equal((await f.request('GET','/status')).status,403);
  f.setAllowed(true);
  process.env.PLATETIMER_VOICE_CALLS_ENABLED='false';
  assert.deepEqual(await f.request('GET','/status'),{status:200,enabled:false});
  process.env.PLATETIMER_VOICE_CALLS_ENABLED='true';
});
test('invites are stored in Firestore and scoped to the target department and company',async()=>{
  const f=fixture({clock:100000});
  assert.deepEqual((await f.request('GET','/departments')).departments,
    [{id:'cucina',name:'Cucina'}]);
  const sent=await f.request('POST','/invite',{toDepartmentId:'cucina'});
  assert.equal(sent.status,200);
  assert.equal(sent.expiresAt,130000);
  assert.equal((await f.request('POST','/invite',{toDepartmentId:'cucina'})).status,409);
  f.setDept('cucina');
  const received=await f.request('GET','/invites');
  assert.equal(received.invites.length,1);
  assert.equal(received.invites[0].id,sent.id);
  assert.equal((await f.request('GET','/session',{id:sent.id})).active,false);
  f.setCompany('bern');
  assert.deepEqual((await f.request('GET','/invites')).invites,[]);
  assert.equal((await f.request('POST','/respond',{id:sent.id,answer:'accept'})).status,404);
  f.setCompany('molard');
  assert.equal((await f.request('POST','/respond',{id:sent.id,answer:'accept'})).accepted,true);
  assert.equal((await f.request('GET','/session',{id:sent.id})).active,true);
  assert.equal((await f.request('POST','/respond',{id:sent.id,answer:'accept'})).status,404);
  f.setDept('pizzeria');
  assert.equal((await f.request('GET','/session',{id:sent.id})).active,true);
  assert.equal((await f.request('POST','/hangup',{callId:sent.id})).ended,true);
  assert.equal((await f.request('GET','/session',{id:sent.id})).active,false);
});
test('expired invitations cannot be accepted; new invitation may replace expired',async()=>{
  const f=fixture({clock:200000});
  const a=await f.request('POST','/invite',{toDepartmentId:'cucina'});
  f.advance(30001);
  f.setDept('cucina');
  assert.deepEqual((await f.request('GET','/invites')).invites,[]);
  assert.equal((await f.request('POST','/respond',{id:a.id,answer:'accept'})).status,404);
  f.setDept('pizzeria');
  assert.equal((await f.request('POST','/invite',{toDepartmentId:'cucina'})).status,200);
});
test('cross-company invitations, disabled targets and off-hours calls are rejected',async()=>{
  const f=fixture();
  assert.equal((await f.request('POST','/invite',{toDepartmentId:'inactive'})).status,404);
  assert.equal((await f.request('POST','/invite',{toDepartmentId:'pizzeria'})).status,400);
  assert.equal((await f.request('POST','/invite',{toDepartmentId:'anything'})).status,404);
  f.setOpen(false);
  assert.equal((await f.request('GET','/status')).scheduleEnabled,false);
  assert.equal((await f.request('POST','/invite',{toDepartmentId:'cucina'})).status,403);
  assert.equal((await f.request('POST','/token')).status,403);
});
test('production RTC uses one private channel per invited call, never one shared restaurant room',()=>{
  assert.notEqual(channelFor('molard','a'),channelFor('molard','b'));
  assert.notEqual(channelFor('molard','a'),channelFor('bern','a'));
});
test('caller cannot retain unanswered call beyond 30 seconds',async()=>{
  const f=fixture({clock:250000});
  const invite=await f.request('POST','/invite',{toDepartmentId:'cucina'});
  assert.equal((await f.request('GET','/session',{id:invite.id})).active,true);
  f.advance(30001);
  assert.equal((await f.request('GET','/session',{id:invite.id})).active,false);
});
test('company and department derive deterministic separate Agora identities',()=>{
  assert.notEqual(safeKey('molard','cucina'),safeKey('bern','cucina'));
  assert.notEqual(rtcUid('molard','cucina'),rtcUid('molard','pizzeria'));
});
