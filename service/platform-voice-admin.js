'use strict';
const crypto = require('crypto');

const COLLECTION = 'platetimer_platform_voice_access';
const normalize = id => String(id || '').trim().toLowerCase();
const keyFor = id => crypto.createHash('sha256').update(normalize(id)).digest('hex');

function createVoiceAccess({ db }) {
  async function enabled(companyId) {
    const id = normalize(companyId);
    if (!id || !db) return false;
    const doc = await db.collection(COLLECTION).doc(keyFor(id)).get();
    return doc.exists && doc.data().companyId === id && doc.data().enabled === true;
  }
  async function read(companyId) {
    const id = normalize(companyId);
    if (!id || !db) return false;
    return enabled(id);
  }
  async function write(companyId, value, adminUid) {
    if (!db) throw new Error('Firestore unavailable');
    const id = normalize(companyId);
    if (!id || typeof value !== 'boolean') throw new Error('Invalid feature setting');
    await db.collection(COLLECTION).doc(keyFor(id)).set({
      companyId: id, enabled: value,
      updatedAt: new Date().toISOString(), updatedByUid: adminUid
    });
  }
  return { enabled, read, write };
}

function mountPlatformVoiceAdmin(app, { db, lookupFirebaseAccount, getCompanies, voiceAccess }) {
  async function guard(req, res) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Firebase token required' });
      return null;
    }
    const fb = await lookupFirebaseAccount(header.slice(7).trim());
    const configuredUid = String(process.env.PLATETIMER_PLATFORM_ADMIN_UID || '').trim();
    if (!configuredUid || !fb || fb.localId !== configuredUid ||
        fb.emailVerified !== true || fb.disabled === true) {
      res.status(403).json({ error: 'Platform administrator required' });
      return null;
    }
    return fb.localId;
  }
  app.get('/api/platform/voice-access', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const uid = await guard(req, res);
      if (!uid) return;
      if (!db) return res.status(503).json({ error: 'Firestore unavailable' });
      const companies = getCompanies();
      const restaurants = await Promise.all(companies.map(async item => ({
        companyId: item.companyId,
        departments: item.departments,
        enabled: await voiceAccess.read(item.companyId)
      })));
      return res.json({ restaurants });
    } catch (err) {
      console.error('[PLATFORM VOICE] list failed:', err.message);
      return res.status(503).json({ error: 'Voice configuration unavailable' });
    }
  });
  app.put('/api/platform/voice-access', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const uid = await guard(req, res);
      if (!uid) return;
      if (!db) return res.status(503).json({ error: 'Firestore unavailable' });
      const id = normalize(req.body && req.body.companyId);
      const enabled = req.body && req.body.enabled;
      if (typeof enabled !== 'boolean' || !id)
        return res.status(400).json({ error: 'Invalid settings' });
      if (!getCompanies().some(item => item.companyId === id))
        return res.status(404).json({ error: 'Restaurant not registered' });
      await voiceAccess.write(id, enabled, uid);
      return res.json({ companyId: id, enabled });
    } catch (err) {
      console.error('[PLATFORM VOICE] update failed:', err.message);
      return res.status(503).json({ error: 'Voice setting not saved' });
    }
  });
}
module.exports = { createVoiceAccess, mountPlatformVoiceAdmin };
