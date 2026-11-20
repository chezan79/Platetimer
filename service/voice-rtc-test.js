'use strict';

const crypto = require('crypto');
const { isPreviewVoiceEnabled, canUsePreviewVoice } = require('./voice-access-policy');

// Preview-only audio connectivity test. Not the production calling feature.
// Uses the existing authenticated Service device as the sole room principal.
function mountVoiceRtcTest(app, { requireAuth, getAuthoritativeServiceDeviceContext }) {
  function available() { return isPreviewVoiceEnabled(); }

  // Status is scoped to the authenticated, active department instead of leaking
  // an environment-wide feature flag to every tenant.
  app.get('/api/voice-test/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!available()) return res.json({ enabled: false });
    const session = requireAuth(req, res);
    if (!session) return;
    try {
      const device = await getAuthoritativeServiceDeviceContext(session);
      return res.json({ enabled: canUsePreviewVoice(device) });
    } catch (error) {
      console.error('[VOICE TEST] Status department lookup failed:', error.message);
      return res.status(503).json({ enabled: false, error: 'Department lookup unavailable.' });
    }
  });

  app.post('/api/voice-test/token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!available()) return res.status(404).json({ error: 'Voice test disabled.' });
    const session = requireAuth(req, res);
    if (!session) return;
    let device;
    try {
      device = await getAuthoritativeServiceDeviceContext(session);
    } catch (error) {
      console.error('[VOICE TEST] Unable to resolve Service device:', error.message);
      return res.status(503).json({ error: 'Department lookup unavailable.' });
    }
    if (!device) return res.status(403).json({ error: 'An active Service department login is required.' });
    if (!canUsePreviewVoice(device)) return res.status(403).json({ error: 'Voice calls are not enabled for this restaurant.' });
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !appCertificate) return res.status(503).json({ error: 'Agora is not configured.' });

    // The room derives ONLY from the verified company; there is no client-supplied channel.
    const digest = crypto.createHash('sha256').update(device.companyId).digest('hex').slice(0, 32);
    const channel = 'pt-preview-' + digest;
    // RTC UID is deterministic per department so the same station identity can rejoin.
    const rawUid = crypto.createHash('sha256').update(device.companyId + ':' + device.departmentId).digest();
    const uid = (rawUid.readUInt32BE(0) % 2147483646) + 1;
    let token;
    try {
      const { RtcTokenBuilder, RtcRole } = require('agora-token');
      const ttlSeconds = 3600;
      token = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channel, uid,
        RtcRole.PUBLISHER, ttlSeconds, ttlSeconds);
    } catch (error) {
      console.error('[VOICE TEST] Token generation failed:', error.message);
      return res.status(503).json({ error: 'Token generation unavailable.' });
    }
    return res.json({ appId, channel, uid, token, departmentName: device.department.name,
      expiresInSeconds: 3600 });
  });
}

module.exports = { mountVoiceRtcTest };
