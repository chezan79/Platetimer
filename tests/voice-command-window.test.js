'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {create,isCompleteWake,DURATION_MS}=require('../public/js/voice-command-window');
function fixture({available='available',localSupport=true}={}){
 let time=10000,timers=new Map(),id=0;
 class Engine{
  static async available(opts){assert.equal(opts.processLocally,true);return available;}
  constructor(){if(localSupport)this.processLocally=false;Engine.last=this;this.aborted=false;}
  start(){this.started=true;this.onstart?.();}
  abort(){this.aborted=true;this.onend?.();}
  final(text){this.onresult?.({resultIndex:0,results:[Object.assign([{transcript:text}],{isFinal:true})]});}
 }
 const statuses=[],commands=[];
 const ctrl=create({getLanguage:()=> 'it-IT',Recognition:Engine,
  onCommand:cmd=>{if(!cmd.includes('minuti'))return false;commands.push(cmd);return true;},
  onState:(state,remaining)=>statuses.push([state,remaining]),
  now:()=>time,setTimer:(fn,ms)=>{const k=++id;timers.set(k,{fn,due:time+ms});return k;},
  clearTimer:k=>timers.delete(k)});
 function advance(ms){time+=ms;const due=[...timers].filter(([k,x])=>x.due<=time);for(const [k,x] of due){timers.delete(k);x.fn();}}
 return {ctrl,Engine,statuses,commands,advance};
}
test('wake word must begin the sentence',()=>{
 assert.equal(isCompleteWake('Tavolo 12 otto minuti','it-IT'),true);
 assert.equal(isCompleteWake('Table douze huit minutes','fr-CH'),true);
 assert.equal(isCompleteWake('Tisch zwölf acht Minuten','de-CH'),true);
 assert.equal(isCompleteWake('Il tavolo 12 otto minuti','it-IT'),false);
 assert.equal(isCompleteWake('Tavolo','it-IT'),false);
});
test('local voice pauses only on a complete command and resumes',async()=>{
 const t=fixture();assert.equal((await t.ctrl.start()).ok,true);
 const engine=t.Engine.last;
 engine.final('Il tavolo dodici e pronto');
 assert.equal(t.ctrl.active(),true);assert.equal(t.commands.length,0);
 engine.final('Tavolo dodici');
 assert.equal(t.commands.length,0);assert.equal(engine.aborted,false);
 engine.final('Tavolo dodici otto minuti');
 assert.equal(t.commands.length,1);assert.equal(engine.aborted,true);
 assert.equal(t.statuses.at(-1)[0],'paused');
 assert.equal(t.ctrl.resume(),true);
 assert.equal(t.Engine.last.started,true);
 t.ctrl.stop();assert.equal(t.ctrl.active(),false);
});
test('ten minutes expires even while paused',async()=>{
 const t=fixture();await t.ctrl.start();t.Engine.last.final('Tavolo 12 otto minuti');
 t.advance(DURATION_MS);assert.equal(t.ctrl.active(),false);
 assert.equal(t.statuses.at(-1)[0],'expired');
 assert.equal(t.ctrl.resume(),false);
});
test('must not enable if local pack is unavailable',async()=>{
 const t=fixture({available:'downloadable'});assert.equal((await t.ctrl.start()).ok,false);
 assert.equal(t.ctrl.active(),false);
});
test('must not enable without local-only instance flag',async()=>{
 const t=fixture({localSupport:false});assert.equal((await t.ctrl.start()).ok,false);
 assert.equal(t.ctrl.active(),false);
});
