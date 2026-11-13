/* Preview-only PlateTimer Voice panel, loaded only on department.html.
   Never connects or requests microphone until the operator clicks Entra. */
(() => {
  'use strict';
  const button = document.getElementById('pt-voice-test-open');
  const panel = document.getElementById('pt-voice-test-panel');
  if (!button || !panel || typeof WsAuth === 'undefined') return;
  const join = panel.querySelector('[data-voice="join"]');
  const leave = panel.querySelector('[data-voice="leave"]');
  const mute = panel.querySelector('[data-voice="mute"]');
  const close = panel.querySelector('[data-voice="close"]');
  const message = panel.querySelector('[data-voice="message"]');
  const peers = panel.querySelector('[data-voice="peers"]');
  let rtc = null, mic = null, connected = false, busy = false, muted = false, sdkLoad = null;
  const say = text => { message.textContent = text; };
  const controls = () => {
    join.disabled = busy || connected;
    leave.disabled = busy || !connected;
    mute.disabled = busy || !connected;
    mute.textContent = muted ? 'Attiva microfono' : 'Disattiva microfono';
  };
  const countPeers = () => { peers.textContent = rtc ? 'Altri reparti collegati: ' + rtc.remoteUsers.length : ''; };
  const loadSdk = () => {
    if (window.AgoraRTC) return Promise.resolve();
    if (sdkLoad) return sdkLoad;
    sdkLoad = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'https://cdn.jsdelivr.net/npm/agora-rtc-sdk-ng@4.24.9/AgoraRTC_N-production.js';
      tag.onload = () => window.AgoraRTC ? resolve() : reject(new Error('Agora SDK non disponibile'));
      tag.onerror = () => reject(new Error('Impossibile caricare Agora SDK'));
      document.head.appendChild(tag);
    }).catch(error => { sdkLoad = null; throw error; });
    return sdkLoad;
  };
  async function disconnect() {
    busy = true; controls();
    try {
      if (mic) { mic.stop(); mic.close(); mic = null; }
      if (rtc) { await rtc.leave(); rtc.removeAllListeners(); rtc = null; }
      connected = false; muted = false;
      say('Chiamata terminata.');
    } catch (error) { say('Errore in uscita: ' + error.message); }
    finally { busy = false; controls(); countPeers(); }
  }
  async function connect() {
    busy = true; controls(); say('Connessione Agora...');
    try {
      const session = WsAuth.getStoredToken();
      if (!session || !WsAuth.isServiceSession()) throw new Error('Accesso reparto Service richiesto.');
      const response = await fetch('/api/voice-test/token', {
        method: 'POST', headers: { Authorization: 'Bearer ' + session }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Accesso alla chiamata negato.');
      await loadSdk();
      rtc = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      rtc.on('user-published', async (user, mediaType) => {
        try {
          await rtc.subscribe(user, mediaType);
          if (mediaType === 'audio') user.audioTrack.play();
          countPeers();
        } catch (error) { say('Errore ricezione audio: ' + error.message); }
      });
      rtc.on('user-unpublished', countPeers);
      rtc.on('user-left', countPeers);
      await rtc.join(data.appId, data.channel, data.token, data.uid);
      mic = await AgoraRTC.createMicrophoneAudioTrack({ encoderConfig: 'speech_standard', AEC: true, ANS: true, AGC: true });
      await rtc.publish([mic]);
      connected = true; muted = false;
      say('Collegato: ' + data.departmentName + '. Microfono attivo.');
      countPeers();
    } catch (error) {
      say('Connessione non riuscita: ' + error.message);
      if (mic) { mic.stop(); mic.close(); mic = null; }
      if (rtc) { try { await rtc.leave(); } catch (_) {} rtc.removeAllListeners(); rtc = null; }
      connected = false;
    } finally { busy = false; controls(); }
  }
  join.addEventListener('click', connect);
  leave.addEventListener('click', disconnect);
  mute.addEventListener('click', async () => {
    if (!mic || busy) return;
    busy = true; controls();
    try { await mic.setEnabled(muted); muted = !muted; say(muted ? 'Microfono spento.' : 'Microfono attivo.'); }
    catch (error) { say('Errore microfono: ' + error.message); }
    finally { busy = false; controls(); }
  });
  button.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  close.addEventListener('click', () => { panel.hidden = true; });
  window.addEventListener('pagehide', () => {
    if (mic) { mic.stop(); mic.close(); mic = null; }
    if (rtc) rtc.leave().catch(() => {});
  });
  fetch('/api/voice-test/status', {cache:'no-store'}).then(r => r.ok ? r.json() : null)
    .then(data => { if (data && data.enabled && WsAuth.isServiceSession()) button.hidden = false; })
    .catch(() => {});
  controls();
})();
