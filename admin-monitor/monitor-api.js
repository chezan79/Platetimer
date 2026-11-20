'use strict';

/**
 * READ-ONLY platform monitor. This module never modifies PlateTimer's WebSocket,
 * countdown, or restaurant state and is not mounted unless explicitly integrated.
 * No usernames, tokens, IP addresses or message bodies are returned.
 */
const WebSocket = require('ws');

function snapshot({ wss, getCompanies, getCountdowns, now = Date.now() }) {
  const registered = getCompanies();
  const connectionsByCompany = new Map();
  const departmentsByCompany = new Map();
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN ||
        ws.isAuthenticated !== true || !ws.companyRoom ||
        !Number.isFinite(ws.lastPong) || now - ws.lastPong > 90000) continue;
    const id = String(ws.companyRoom).trim().toLowerCase();
    connectionsByCompany.set(id, (connectionsByCompany.get(id) || 0) + 1);
    if (ws.boundDepartmentId && ws.departmentAccountStatus === 'ACTIVE') {
      if (!departmentsByCompany.has(id)) departmentsByCompany.set(id, new Set());
      departmentsByCompany.get(id).add(ws.boundDepartmentId);
    }
  }
  const restaurants = registered.map(({ companyId, departments }) => {
    const id = String(companyId).trim().toLowerCase();
    const connections = connectionsByCompany.get(id) || 0;
    const activeDepartments = departmentsByCompany.get(id)?.size || 0;
    const countdowns = getCountdowns(id);
    return {
      companyId: id,
      departments: Number.isInteger(departments) ? departments : 0,
      online: connections > 0,
      connections,
      connectedDepartments: activeDepartments,
      activeCountdowns: Number.isInteger(countdowns) ? countdowns : 0
    };
  }).sort((a, b) => a.companyId.localeCompare(b.companyId));
  return {
    updatedAt: new Date(now).toISOString(),
    freshnessSeconds: 90,
    restaurants,
    totals: {
      registered: restaurants.length,
      online: restaurants.filter(r => r.online).length,
      connections: restaurants.reduce((n,r) => n + r.connections, 0),
      connectedDepartments: restaurants.reduce((n,r) => n + r.connectedDepartments, 0),
      activeCountdowns: restaurants.reduce((n,r) => n + r.activeCountdowns, 0)
    }
  };
}

function mountPlatformMonitor(app, { wss, getCompanies, getCountdowns, lookupFirebaseAccount, now = () => Date.now() }) {
  if (!app || !wss || typeof getCompanies !== 'function' ||
      typeof getCountdowns !== 'function' || typeof lookupFirebaseAccount !== 'function')
    throw new TypeError('Platform monitor requires authoritative server dependencies');

  app.get('/api/platform/monitor/live', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const value = req.headers.authorization || '';
    if (!value.startsWith('Bearer ') || !value.slice(7).trim())
      return res.status(401).json({ error: 'Firebase token required' });
    try {
      const account = await lookupFirebaseAccount(value.slice(7).trim());
      const adminUid = String(process.env.PLATETIMER_PLATFORM_ADMIN_UID || '').trim();
      if (!adminUid || !account || account.localId !== adminUid ||
          account.emailVerified !== true || account.disabled === true)
        return res.status(403).json({ error: 'Platform administrator required' });
      return res.json(snapshot({ wss, getCompanies, getCountdowns, now: now() }));
    } catch (error) {
      console.error('[PLATFORM MONITOR] Unable to collect status:', error.message);
      return res.status(503).json({ error: 'Monitoring temporarily unavailable' });
    }
  });
}
module.exports = { snapshot, mountPlatformMonitor };
