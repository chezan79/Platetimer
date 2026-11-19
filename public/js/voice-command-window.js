/* PlateTimer optional 10-minute voice window.
 * Privacy-first: available ONLY with verified on-device Web Speech language packs.
 * Never silently enable browser/cloud-hosted SpeechRecognition.
 * Browser permissions and page visibility may stop the session at any time.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.PlateVoiceWindow=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const DURATION_MS=10*60*1000;
const ERRORS=Object.freeze({unsupported:'LOCAL_RECOGNITION_UNAVAILABLE',language:'LOCAL_LANGUAGE_PACK_UNAVAILABLE',notAllowed:'MICROPHONE_DENIED'});
const WAKE=Object.freeze({'it-IT':'tavolo','fr-CH':'table','de-CH':'tisch'});
function isCompleteWake(text,lang){
  const keyword=WAKE[lang];
  if(!keyword||typeof text!=='string')return false;
  const t=text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  // A spoken table number must immediately follow the wake word.
  // The parser will perform the final semantic/department validation.
  return new RegExp('^'+keyword+' (?:\\d{1,4}|[\\p{L}]+)(?: |$)','u').test(t);
}
function create({getLanguage,onCommand,onState,onError,Recognition,now,setTimer,clearTimer}){
  if(typeof getLanguage!=='function'||typeof onCommand!=='function'||typeof onState!=='function')throw Error('voice window callbacks required');
  const clock=now||(()=>Date.now());
  const later=setTimer||((f,ms)=>setTimeout(f,ms));
  const cancel=clearTimer||((t)=>clearTimeout(t));
  const Engine=Recognition||((typeof window!=='undefined')&&(window.SpeechRecognition||window.webkitSpeechRecognition));
  let engine=null,deadline=0,started=false,paused=false,shouldRestart=false;
  let expiryTimer=null,restartTimer=null,launchToken=0,opening=false;
  let lastPhrase='',lastPhraseAt=0;
  function emit(state){onState(state,Math.max(0,deadline-clock()));}
  function clearTimers(){if(expiryTimer!==null){cancel(expiryTimer);expiryTimer=null;}if(restartTimer!==null){cancel(restartTimer);restartTimer=null;}}
  function safeAbort(){
    if(!engine)return;
    const previous=engine;engine=null;
    previous.onresult=null;previous.onerror=null;previous.onend=null;previous.onstart=null;
    try{previous.abort();}catch(e){}
  }
  function stop(reason='stopped'){
    ++launchToken;started=false;paused=false;shouldRestart=false;opening=false;deadline=0;
    clearTimers();safeAbort();emit(reason);
  }
  function active(){return started&&clock()<deadline;}
  function timeout(){if(started&&clock()>=deadline)stop('expired');}
  function scheduleRestart(){
    if(!active()||paused||!shouldRestart)return;
    if(restartTimer!==null)cancel(restartTimer);
    restartTimer=later(()=>{restartTimer=null;openEngine();},500);
  }
  function openEngine(){
    if(!active()||paused||engine||opening)return;
    opening=true;
    try{
      const rec=new Engine();
      engine=rec;
      rec.lang=getLanguage();
      rec.continuous=true;rec.interimResults=false;rec.maxAlternatives=1;
      rec.processLocally=true;
      rec.onstart=()=>{opening=false;if(active()&&!paused)emit('listening');};
      rec.onresult=event=>{
        if(!active()||paused||!shouldRestart)return;
        for(let i=event.resultIndex;i<event.results.length;i++){
          const result=event.results[i];if(!result||!result.isFinal)continue;
          const text=result[0]?.transcript?.trim();
          if(!isCompleteWake(text,getLanguage()))continue;
          const t=clock();
          if(text===lastPhrase&&t-lastPhraseAt<5000)continue;
          lastPhrase=text;lastPhraseAt=t;
          pause();
          onCommand(text);
          break;
        }
      };
      rec.onerror=event=>{
        const code=event?.error||'recognition-error';
        opening=false;
        if(code==='no-speech'||code==='aborted')return;
        // Terminal errors: never retry invisibly after permissions/service errors.
        if(['not-allowed','service-not-allowed','language-not-supported','audio-capture','network'].includes(code)){
          stop('error');
          if(onError)onError(code);
        }
      };
      rec.onend=()=>{
        if(engine!==rec)return;
        engine=null;opening=false;
        scheduleRestart();
      };
      rec.start();
    }catch(e){
      opening=false;engine=null;
      stop('error');
      if(onError)onError(e.message||'recognition-error');
    }
  }
  async function start(){
    if(started)return {ok:false,code:'ALREADY_ACTIVE'};
    const lang=getLanguage();
    if(!WAKE[lang])return {ok:false,code:'INVALID_LANGUAGE'};
    // processLocally alone is insufficient: without availability() engines may
    // silently fall back to cloud recognition. Fail closed instead.
    if(!Engine||typeof Engine.available!=='function')return {ok:false,code:ERRORS.unsupported};
    const ticket=++launchToken;
    emit('checking');
    let availability;
    try{availability=await Engine.available({langs:[lang],processLocally:true});}
    catch(e){return {ok:false,code:ERRORS.unsupported};}
    if(ticket!==launchToken)return {ok:false,code:'CANCELLED'};
    if(availability!=='available')return {ok:false,code:ERRORS.language,availability};
    started=true;paused=false;shouldRestart=true;
    deadline=clock()+DURATION_MS;
    expiryTimer=later(timeout,DURATION_MS);
    openEngine();
    return {ok:started,code:started?'OK':'START_FAILED'};
  }
  function pause(){
    if(!active()||paused)return;
    paused=true;shouldRestart=false;
    if(restartTimer!==null){cancel(restartTimer);restartTimer=null;}
    safeAbort();opening=false;emit('paused');
  }
  function resume(){
    if(!active())return false;
    if(!paused)return true;
    paused=false;shouldRestart=true;openEngine();return true;
  }
  function getRemainingMs(){return active()?Math.max(0,deadline-clock()):0;}
  return Object.freeze({start,stop,pause,resume,active,getRemainingMs});
}
return Object.freeze({create,isCompleteWake,WAKE,DURATION_MS,ERRORS});
});
