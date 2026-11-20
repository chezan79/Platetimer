'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceSession, DEFAULT_SESSION_MS } = require('../public/js/voice-session-10min');

class FakeTimers {
  constructor() { this.now = 0; this.id = 0; this.events = new Map(); }
  set(fn, delay) { const id=++this.id; this.events.set(id,{at:this.now+delay,fn}); return id; }
  clear(id) { this.events.delete(id); }
  advance(ms) {
    const end = this.now+ms;
    for (;;) {
      const next = [...this.events].sort((a,b)=>a[1].at-b[1].at)[0];
      if (!next || next[1].at>end) break;
      this.events.delete(next[0]); this.now=next[1].at; next[1].fn();
    }
    this.now=end;
  }
}
class Recorder {
  static started = 0;
  constructor(stream) { this.stream=stream; this.state='inactive'; this.mimeType='audio/webm'; }
  start() { this.state='recording'; Recorder.started++; }
  stop() {
    if (this.state!=='recording') return;
    this.state='inactive';
    this.ondataavailable?.({data:new Blob(['spoken-command'],{type:this.mimeType})});
    this.onstop?.();
  }
}
function fixture(onClip) {
  const time = new FakeTimers();
  let stopped=0;
  const mediaDevices={getUserMedia:async()=>({
    getTracks:()=>[{stop(){stopped++;},addEventListener(){}}]
  })};
  const states=[];
  const session=createVoiceSession({
    mediaDevices,Recorder,onClip,clipMs:5000,sessionMs:600000,
    clock:()=>time.now,schedule:(f,n)=>time.set(f,n),
    cancel:id=>time.clear(id),
    onState:value=>states.push(value.status)
  });
  return {time,session,states,getStopped:()=>stopped};
}
test('one activation records successive voice clips without new clicks',async()=>{
  Recorder.started=0;
  const clips=[];
  const x=fixture(async(blob,ctx)=>clips.push([blob.size,ctx.isCurrent()]));
  assert.equal(await x.session.start(),true);
  assert.equal(Recorder.started,1);
  x.time.advance(5000);
  await new Promise(setImmediate);
  assert.equal(Recorder.started,2);
  assert.equal(clips.length,1);
  x.time.advance(5000);
  await new Promise(setImmediate);
  assert.equal(Recorder.started,3);
  assert.equal(clips.length,2);
  assert.equal(x.session.active,true);
  x.session.stop();
  assert.equal(x.getStopped(),1);
});
test('expires at ten minutes and closes the microphone',async()=>{
  Recorder.started=0;
  const x=fixture(async()=>{});
  await x.session.start();
  x.time.advance(DEFAULT_SESSION_MS);
  await new Promise(setImmediate);
  assert.equal(x.session.active,false);
  assert.equal(x.getStopped(),1);
  assert.ok(x.states.includes('expired'));
  const total=Recorder.started;
  x.time.advance(30000);
  assert.equal(Recorder.started,total);
});
test('stop invalidates pending transcription so it cannot dispatch late',async()=>{
  let release;
  const late=new Promise(resolve=>release=resolve);
  const results=[];
  const x=fixture(async(_blob,ctx)=>{
    await late;
    results.push(ctx.isCurrent());
  });
  await x.session.start();
  x.time.advance(5000);
  await new Promise(setImmediate);
  x.session.stop();
  release();
  await new Promise(setImmediate);
  assert.deepEqual(results,[false]);
  assert.equal(x.session.active,false);
});
