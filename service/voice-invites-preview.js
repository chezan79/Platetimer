'use strict';

// Preview-only, in-memory signaling. This is deliberately NOT production calling:
// restart clears pending invites; deployment remains disabled.
const crypto = require('crypto');
const RING_MS = 30000;
const pending = new Map();

function mountVoiceInvites(app, { enabled, requireAuth, getAuthoritativeServiceDeviceContext, getCompanyDepts }) {
  async function deviceFor(req, res) {
    const session = requireAuth(req, res);
    if (!session) return null;
    try {
      const device = await getAuthoritativeServiceDeviceContext(session);
      if (!device) {
        res.status(403).json({ error: 'Reparto Service attivo richiesto.' });
        return null;
      }
      return device;
    } catch (error) {
      console.error('[VOICE INVITES] lookup:', error.message);
      res.status(503).json({ error: 'Verifica reparto non disponibile.' });
      return null;
    }
  }
  function sweep(now = Date.now()) {
    for (const [id, invite] of pending) {
      if (invite.expiresAt <= now || invite.createdAt + 120000 <= now) pending.delete(id);
    }
  }
  function route(method, path, handler) {
    app[method](path, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!enabled()) return res.status(404).json({ error: 'Test Voice non abilitato.' });
      const device = await deviceFor(req, res);
      if (!device) return;
      sweep();
      return handler(req, res, device);
    });
  }
  route('get', '/api/voice-test/departments', (_req, res, device) => {
    const availableDepts = getCompanyDepts(device.companyId)
      .filter(dept => dept.active === true && dept.id !== device.departmentId)
      .map(({id, name}) => ({id, name}));
    res.json({ departments: availableDepts });
  });
  route('post', '/api/voice-test/invite', (req, res, device) => {
    const to = req.body && req.body.toDepartmentId;
    if (typeof to !== 'string' || to.length > 100 || to === device.departmentId)
      return res.status(400).json({ error: 'Destinatario non valido.' });
    const target = getCompanyDepts(device.companyId).find(dept => dept.id === to && dept.active === true);
    if (!target) return res.status(404).json({ error: 'Reparto destinatario non disponibile.' });
    for (const invite of pending.values()) {
      if (invite.companyId === device.companyId && invite.to === to && invite.from === device.departmentId)
        return res.status(409).json({ error: 'Invito già in corso.' });
    }
    const now = Date.now();
    const invite = {
      id: crypto.randomUUID(), companyId: device.companyId,
      from: device.departmentId, fromName: device.department.name,
      to: target.id, toName: target.name, createdAt: now, expiresAt: now + RING_MS
    };
    pending.set(invite.id, invite);
    return res.json({ id: invite.id, expiresAt: invite.expiresAt, toName: invite.toName });
  });
  route('get', '/api/voice-test/invites', (_req, res, device) => {
    const invites = Array.from(pending.values())
      .filter(x => x.companyId === device.companyId && x.to === device.departmentId)
      .map(({ id, fromName, expiresAt }) => ({ id, fromName, expiresAt }));
    return res.json({ invites });
  });
  route('post', '/api/voice-test/respond', (req, res, device) => {
    const id = req.body && req.body.id;
    const answer = req.body && req.body.answer;
    if (typeof id !== 'string' || !['accept', 'decline'].includes(answer))
      return res.status(400).json({ error: 'Risposta non valida.' });
    const invite = pending.get(id);
    if (!invite || invite.companyId !== device.companyId || invite.to !== device.departmentId)
      return res.status(404).json({ error: 'Invito scaduto o non autorizzato.' });
    pending.delete(id);
    return res.json({ accepted: answer === 'accept', fromName: invite.fromName });
  });
}
module.exports = { mountVoiceInvites };
