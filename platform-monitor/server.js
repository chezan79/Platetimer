'use strict';

// Standalone and OFF by default. NOT imported by PlateTimer server.js.
// Listen only on loopback: no external exposure, no write access to Firestore,
// no countdown/Mex/Voice route or WebSocket changes.
const http = require('node:http');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { createPlatformAuth, configuredPlatformUid } = require('./auth');

function buildFirebaseAuth(env) {
  const raw = env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_ADMIN_SERVICE_ACCOUNT is required');
  const creds = JSON.parse(raw);
  const app = getApps().find(a => a.name === 'platetimer-platform-monitor') ||
    initializeApp({ credential: cert(creds) }, 'platetimer-platform-monitor');
  return getAuth(app);
}

function createMonitorServer({ authorize }) {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'"
      });
      res.end(JSON.stringify(body));
    };
    if (req.url !== '/api/platform-monitor/whoami' || req.method !== 'GET')
      return send(404, { error: 'NOT_FOUND' });
    let result;
    try { result = await authorize(req.headers.authorization); }
    catch (_) { return send(503, { error: 'AUTH_SERVICE_UNAVAILABLE' }); }
    if (!result.ok) return send(result.status, { error: result.code });
    return send(200, { role: 'PLATFORM_ADMIN', email: result.email });
  });
}

if (require.main === module) {
  if (process.env.PLATETIMER_PLATFORM_MONITOR_ENABLED !== 'true' ||
      !configuredPlatformUid()) {
    console.error('Platform Monitor disabled; no listener started.');
    process.exitCode = 1;
  } else {
    try {
      const auth = buildFirebaseAuth(process.env);
      const server = createMonitorServer({
        authorize: createPlatformAuth({ auth })
      });
      // Bound to loopback, not accessible from Replit Preview or Railway.
      server.listen(5090, '127.0.0.1', () =>
        console.log('[PLATFORM MONITOR] Local-only auth check on 127.0.0.1:5090'));
    } catch (error) {
      console.error('[PLATFORM MONITOR] Startup blocked:', error.message);
      process.exitCode = 1;
    }
  }
}
module.exports = { createMonitorServer };
