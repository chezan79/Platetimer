'use strict';

// Production Agora signaling. Firestore is mandatory: invites must survive a
// Railway restart and be visible to every replica. No audio is stored here.
const crypto = require('crypto');
const { voiceWindow } = require('./voice-schedule');

const PREFIX = '/api/voice-call';
const COLLECTION = 'platetimer_voice_invites';
const RING_MS = 30000;
const WINDOW_ERROR = 'Chiamate disponibili dalle 12:00 alle 14:30 e dalle 18:30 alle 22:00 (ora svizzera).';
const safeKey = (companyId, departmentId) =>
  crypto.createHash('sha256').update(JSON.stringify([companyId, departmentId])).digest('hex');
const rtcUid = (companyId, departmentId) => {
  const raw = crypto.createHash('sha256').update(companyId + ':' + departmentId).digest();
  return raw.readUInt32BE(0) % 2147483646 + 1;
};

function mountProductionVoiceCalls(app, {
  db, requireAuth, getAuthoritativeServiceDeviceContext, isVoiceAllowed,
  now = () => Date.now(), getWindow = voiceWindow, getDepartments
}) {
  // Disabled by default: enable only after Railway secrets, Firestore, admin
  // authorization and a browser acceptance test are ready.
  const available = () => process.env.PLATETIMER_VOICE_CALLS_ENABLED === 'true' &&
    process.env.NODE_ENV === 'production' && !!db;

  function windowNow() { return getWindow(new Date(now())); }
  function invitationRef(companyId, departmentId) {
    return db.collection(COLLECTION).doc(safeKey(companyId, departmentId));
  }
  async function identity(req, res) {
    const session = requireAuth(req, res);
    if (!session) return null;
    let device;
    try { device = await getAuthoritativeServiceDeviceContext(session); }
    catch (error) {
      console.error('[PROD VOICE] device lookup failed:', error.message);
      res.status(503).json({ error:'Verifica reparto non disponibile.' }); return null;
    }
    if (!device) {
      res.status(403).json({error:'Un accesso reparto Service attivo è richiesto.'}); return null;
    }
    try {
      if (!await isVoiceAllowed(device.companyId)) {
        res.status(403).json({error:'Chiamate non autorizzate per questo ristorante.'}); return null;
      }
    } catch (error) {
      console.error('[PROD VOICE] authorization failed:', error.message);
      res.status(503).json({error:'Autorizzazione chiamate non disponibile.'}); return null;
    }
    return device;
  }
  function route(method, path, fn) {
    app[method](PREFIX + path, async (req, res) => {
      res.setHeader('Cache-Control','no-store');
      if (!available()) return res.status(503).json({error:'Chiamate in produzione non abilitate.'});
      const device = await identity(req, res);
      if (!device) return;
      const slot = windowNow();
      if (!slot.allowed || slot.secondsRemaining < 2)
        return res.status(403).json({error:WINDOW_ERROR});
      try { await fn(req, res, device, slot); }
      catch (error) {
        console.error('[PROD VOICE] ' + method + ' ' + path + ':', error.message);
        if (!res.headersSent) res.status(503).json({error:'Servizio chiamate temporaneamente non disponibile.'});
      }
    });
  }
  // A status check must not use the generic route: it is used by the UI to
  // decide whether to expose voice controls; unavailable = false.
  app.get(PREFIX + '/status', async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    if (!available()) return res.json({enabled:false});
    const device = await identity(req,res);
    if (!device) return;
    const slot=windowNow();
    return res.json({enabled:slot.allowed,timeZone:slot.timeZone,
      scheduleEnabled:slot.allowed});
  });

  route('post','/token',async (_req,res,device,slot) => {
    const appId=process.env.AGORA_APP_ID;
    const secret=process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !secret) return res.status(503).json({error:'Agora non configurato.'});
    const digest=crypto.createHash('sha256').update(device.companyId).digest('hex').slice(0,32);
    const channel='pt-prod-'+digest;
    const uid=rtcUid(device.companyId,device.departmentId);
    const seconds=Math.min(3600,slot.secondsRemaining);
    const {RtcTokenBuilder,RtcRole}=require('agora-token');
    const token=RtcTokenBuilder.buildTokenWithUid(appId,secret,channel,uid,
      RtcRole.PUBLISHER,seconds,seconds);
    return res.json({appId,channel,uid,token,departmentName:device.department.name,
      expiresInSeconds:seconds,windowEndsInSeconds:slot.secondsRemaining});
  });

  async function departmentsFor(companyId) {
    // Always read the shared Firestore store, never a stale per-replica cache.
    const all=await getDepartments(companyId);
    return Array.isArray(all)?all.filter(x=>x && x.active===true):[];
  }
  route('get','/departments',async (_req,res,device)=>{
    const departments=(await departmentsFor(device.companyId))
      .filter(x=>x.id!==device.departmentId).map(({id,name})=>({id,name}));
    return res.json({departments});
  });

  route('post','/invite',async (req,res,device,slot)=>{
    const targetId=req.body?.toDepartmentId;
    if (typeof targetId!=='string'||!targetId||targetId.length>100||
        targetId===device.departmentId)
      return res.status(400).json({error:'Destinatario non valido.'});
    const target=(await departmentsFor(device.companyId)).find(d=>d.id===targetId);
    if (!target) return res.status(404).json({error:'Reparto destinatario non disponibile.'});
    const time=now();
    const ref=invitationRef(device.companyId,targetId);
    const invitation={
      id:crypto.randomUUID(),companyId:device.companyId,
      to:targetId,from:device.departmentId,fromName:device.department.name,
      toName:target.name,createdAt:time,
      expiresAt:Math.min(time+RING_MS,time+slot.secondsRemaining*1000)
    };
    const result=await db.runTransaction(async tx=>{
      const old=await tx.get(ref);
      if (old.exists && old.data()?.expiresAt>time)
        return {conflict:true};
      tx.set(ref,invitation);
      return {conflict:false};
    });
    if(result.conflict) return res.status(409).json({error:'Reparto già chiamato. Attendi la risposta.'});
    return res.json({id:invitation.id,toName:invitation.toName,expiresAt:invitation.expiresAt});
  });

  route('get','/invites',async (_req,res,device)=>{
    const doc=await invitationRef(device.companyId,device.departmentId).get();
    const v=doc.exists?doc.data():null;
    if (!v||v.companyId!==device.companyId||v.to!==device.departmentId||v.expiresAt<=now())
      return res.json({invites:[]});
    // Do not expose company ids, session tokens, or caller account details.
    return res.json({invites:[{id:v.id,fromName:v.fromName,expiresAt:v.expiresAt}]});
  });

  route('post','/respond',async (req,res,device)=>{
    const {id,answer}=req.body||{};
    if (typeof id!=='string'||id.length>100||!['accept','decline'].includes(answer))
      return res.status(400).json({error:'Risposta non valida.'});
    const ref=invitationRef(device.companyId,device.departmentId);
    const time=now();
    const result=await db.runTransaction(async tx=>{
      const doc=await tx.get(ref);
      const invite=doc.exists?doc.data():null;
      if(!invite||invite.id!==id||invite.companyId!==device.companyId||
          invite.to!==device.departmentId||invite.expiresAt<=time)
        return null;
      tx.delete(ref);
      return {fromName:invite.fromName};
    });
    if(!result)return res.status(404).json({error:'Invito scaduto o non autorizzato.'});
    return res.json({accepted:answer==='accept',fromName:result.fromName});
  });
}
module.exports={mountProductionVoiceCalls,rtcUid,safeKey};
