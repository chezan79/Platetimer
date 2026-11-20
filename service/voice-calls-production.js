'use strict';

// Production-only, two-party Agora signaling. Firestore is mandatory so
// invitations and call authorization work across Railway replicas/restarts.
// Raw audio is never stored by this module.
const crypto = require('crypto');
const {voiceWindow} = require('./voice-schedule');

const PREFIX = '/api/voice-call';
const INVITES = 'platetimer_voice_invites';
const CALLS = 'platetimer_voice_sessions';
const RING_MS = 30000;
const WINDOW_ERROR = 'Chiamate disponibili dalle 12:00 alle 14:30 e dalle 18:30 alle 22:00 (ora svizzera).';
const safeKey = (companyId, departmentId) =>
  crypto.createHash('sha256').update(JSON.stringify([companyId,departmentId])).digest('hex');
const rtcUid = (companyId, departmentId) => {
  const hash = crypto.createHash('sha256').update(companyId+':'+departmentId).digest();
  return hash.readUInt32BE(0)%2147483646+1;
};
const channelFor = (companyId, callId) =>
  'pt-call-'+crypto.createHash('sha256').update(JSON.stringify([companyId,callId])).digest('hex').slice(0,32);

function mountProductionVoiceCalls(app, {
  db, requireAuth, getAuthoritativeServiceDeviceContext, isVoiceAllowed,
  now=()=>Date.now(), getWindow=voiceWindow, getDepartments
}) {
  const enabled = () => process.env.PLATETIMER_VOICE_CALLS_ENABLED === 'true' &&
    process.env.NODE_ENV === 'production' && !!db;
  const windowNow = () => getWindow(new Date(now()));
  const inviteRef = (company,dept) => db.collection(INVITES).doc(safeKey(company,dept));
  const callRef = id => db.collection(CALLS).doc(id);
  const validId = id => typeof id==='string' && /^[0-9a-f-]{36}$/.test(id);

  async function identity(req,res) {
    const session=requireAuth(req,res);
    if(!session)return null;
    let device;
    try {device=await getAuthoritativeServiceDeviceContext(session);}
    catch(e) {
      console.error('[VOICE PROD] device lookup:',e.message);
      res.status(503).json({error:'Verifica reparto non disponibile.'});return null;
    }
    if(!device){res.status(403).json({error:'Accesso reparto Service attivo richiesto.'});return null;}
    try {
      if(!await isVoiceAllowed(device.companyId)) {
        res.status(403).json({error:'Chiamate non autorizzate per questo ristorante.'});
        return null;
      }
    }catch(e) {
      console.error('[VOICE PROD] feature authorization:',e.message);
      res.status(503).json({error:'Autorizzazione chiamate non disponibile.'});return null;
    }
    return device;
  }
  function route(method,path,handler) {
    app[method](PREFIX+path,async(req,res)=>{
      res.setHeader('Cache-Control','no-store');
      if(!enabled())return res.status(503).json({error:'Chiamate in produzione non abilitate.'});
      const device=await identity(req,res);
      if(!device)return;
      const slot=windowNow();
      if(!slot.allowed||slot.secondsRemaining<2)
        return res.status(403).json({error:WINDOW_ERROR});
      try {await handler(req,res,device,slot);}
      catch(e){
        console.error('[VOICE PROD] '+path+':',e.message);
        if(!res.headersSent)res.status(503).json({error:'Servizio chiamate temporaneamente non disponibile.'});
      }
    });
  }
  async function activeCall(callId,device,{recipientMustAccept=true}={}) {
    if(!validId(callId))return null;
    const snapshot=await callRef(callId).get();
    if(!snapshot.exists)return null;
    const call=snapshot.data();
    if(call.companyId!==device.companyId||
      (call.from!==device.departmentId&&call.to!==device.departmentId)||
      !['ringing','accepted'].includes(call.state)||
      call.endsAt<=now()||
      (call.state==='ringing'&&call.ringExpiresAt<=now())||
      (recipientMustAccept&&call.to===device.departmentId&&call.state!=='accepted'))return null;
    return call;
  }
  app.get(PREFIX+'/status',async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(!enabled())return res.json({enabled:false});
    const device=await identity(req,res);
    if(!device)return;
    const slot=windowNow();
    // Authorized operators can see the entry even outside service hours.
    return res.json({enabled:true,scheduleEnabled:slot.allowed,timeZone:slot.timeZone});
  });
  route('get','/departments',async(_req,res,device)=>{
    const all=await getDepartments(device.companyId);
    const departments=(Array.isArray(all)?all:[])
      .filter(d=>d?.active===true&&d.id!==device.departmentId)
      .map(({id,name})=>({id,name}));
    return res.json({departments});
  });
  route('post','/invite',async(req,res,device,slot)=>{
    const to=req.body?.toDepartmentId;
    if(typeof to!=='string'||!to||to.length>100||to===device.departmentId)
      return res.status(400).json({error:'Destinatario non valido.'});
    const all=await getDepartments(device.companyId);
    const target=(Array.isArray(all)?all:[]).find(d=>d?.active===true&&d.id===to);
    if(!target)return res.status(404).json({error:'Reparto destinatario non disponibile.'});
    const t=now(),id=crypto.randomUUID(),endsAt=t+slot.secondsRemaining*1000;
    // Firestore TTL can remove minimal signaling metadata after the call window.
    // TTL must be enabled on 'purgeAt' for both collections in Firebase.
    const purgeAt=new Date(endsAt+24*60*60*1000);
    const invitation={id,companyId:device.companyId,to,from:device.departmentId,
      fromName:device.department.name,toName:target.name,createdAt:t,
      expiresAt:Math.min(t+RING_MS,endsAt),purgeAt};
    const call={id,companyId:device.companyId,to,from:device.departmentId,
      fromName:device.department.name,toName:target.name,createdAt:t,
      ringExpiresAt:invitation.expiresAt,endsAt,state:'ringing',purgeAt};
    const ref=inviteRef(device.companyId,to);
    const result=await db.runTransaction(async tx=>{
      const old=await tx.get(ref);
      if(old.exists&&old.data()?.expiresAt>t)return {conflict:true};
      tx.set(ref,invitation);
      tx.set(callRef(id),call);
      return {conflict:false};
    });
    if(result.conflict)return res.status(409).json({error:'Reparto già chiamato. Attendi la risposta.'});
    return res.json({id,toName:target.name,expiresAt:invitation.expiresAt});
  });
  route('get','/invites',async(_req,res,device)=>{
    const snapshot=await inviteRef(device.companyId,device.departmentId).get();
    const invitation=snapshot.exists?snapshot.data():null;
    if(!invitation||invitation.companyId!==device.companyId||
       invitation.to!==device.departmentId||invitation.expiresAt<=now())
      return res.json({invites:[]});
    return res.json({invites:[{id:invitation.id,fromName:invitation.fromName,
      expiresAt:invitation.expiresAt}]});
  });
  route('post','/respond',async(req,res,device)=>{
    const {id,answer}=req.body||{};
    if(!validId(id)||!['accept','decline'].includes(answer))
      return res.status(400).json({error:'Risposta non valida.'});
    const ref=inviteRef(device.companyId,device.departmentId);
    const callDoc=callRef(id),t=now();
    const result=await db.runTransaction(async tx=>{
      const inviteSnap=await tx.get(ref);
      const callSnap=await tx.get(callDoc);
      const inv=inviteSnap.exists?inviteSnap.data():null;
      const call=callSnap.exists?callSnap.data():null;
      if(!inv||inv.id!==id||inv.companyId!==device.companyId||
         inv.to!==device.departmentId||inv.expiresAt<=t||
         !call||call.companyId!==device.companyId||
         call.to!==device.departmentId||call.state!=='ringing'||
         call.ringExpiresAt<=t||call.endsAt<=t)
        return null;
      tx.delete(ref);
      tx.set(callDoc,{...call,state:answer==='accept'?'accepted':'declined',updatedAt:t});
      return {fromName:inv.fromName};
    });
    if(!result)return res.status(404).json({error:'Invito scaduto o non autorizzato.'});
    return res.json({accepted:answer==='accept',fromName:result.fromName,id});
  });
  route('post','/token',async(req,res,device,slot)=>{
    const call=await activeCall(req.body?.callId,device);
    if(!call)return res.status(403).json({error:'Chiamata non autorizzata o conclusa.'});
    const appId=process.env.AGORA_APP_ID,secret=process.env.AGORA_APP_CERTIFICATE;
    if(!appId||!secret)return res.status(503).json({error:'Agora non configurato.'});
    const seconds=Math.min(3600,slot.secondsRemaining,Math.floor((call.endsAt-now())/1000));
    if(seconds<2)return res.status(403).json({error:'Fascia oraria conclusa.'});
    const {RtcTokenBuilder,RtcRole}=require('agora-token');
    const uid=rtcUid(device.companyId,device.departmentId);
    const token=RtcTokenBuilder.buildTokenWithUid(appId,secret,channelFor(device.companyId,call.id),uid,
      RtcRole.PUBLISHER,seconds,seconds);
    return res.json({appId,channel:channelFor(device.companyId,call.id),
      uid,token,departmentName:device.department.name,
      expiresInSeconds:seconds,windowEndsInSeconds:slot.secondsRemaining});
  });
  route('get','/session',async(req,res,device)=>{
    const call=await activeCall(req.query?.id,device);
    if(!call)return res.json({active:false});
    return res.json({active:true,accepted:call.state==='accepted'});
  });
  route('post','/hangup',async(req,res,device)=>{
    const id=req.body?.callId;
    if(!validId(id))return res.status(400).json({error:'Chiamata non valida.'});
    const ref=callRef(id),t=now();
    const ok=await db.runTransaction(async tx=>{
      const snapshot=await tx.get(ref);
      const call=snapshot.exists?snapshot.data():null;
      if(!call||call.companyId!==device.companyId||
        (call.from!==device.departmentId&&call.to!==device.departmentId))return false;
      if(call.state==='ended')return true;
      tx.set(ref,{...call,state:'ended',updatedAt:t});
      return true;
    });
    if(!ok)return res.status(404).json({error:'Chiamata non trovata.'});
    return res.json({ended:true});
  });
}

module.exports={mountProductionVoiceCalls,rtcUid,safeKey,channelFor};
