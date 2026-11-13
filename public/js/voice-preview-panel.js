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
  const destination = panel.querySelector('[data-voice="destination"]');
  const callButton = panel.querySelector('[data-voice="call"]');
  const incoming = panel.querySelector('[data-voice="incoming"]');
  const caller = panel.querySelector('[data-voice="caller"]');
  const remaining = panel.querySelector('[data-voice="remaining"]');
  const accept = panel.querySelector('[data-voice="accept"]');
  const decline = panel.querySelector('[data-voice="decline"]');
  let currentInvite = null, inviteTimer = null, pollTimer = null, toneContext = null;
  function authHeaders() {
    return { Authorization: 'Bearer ' + (WsAuth.getStoredToken() || '') };
  }
  async function api(path, { method = 'GET', body } = {}) {
    const r = await fetch('/api/voice-test/' + path, {
      method, cache:'no-store',
      headers: { ...authHeaders(), ...(body ? { 'Content-Type':'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Operazione non riuscita');
    return data;
  }
  async function refreshDepartments() {
    try {
      const data = await api('departments');
      const previous = destination.value;
      destination.replaceChildren(new Option('Seleziona reparto', ''));
      for (const dep of data.departments) destination.add(new Option(dep.name, dep.id));
      destination.value = previous;
    } catch(error) { say('Reparti non disponibili: ' + error.message); }
  }
  function stopTone() {
    if (inviteTimer) { clearInterval(inviteTimer); inviteTimer = null; }
  }
  function renderIncoming() {
    if (!currentInvite || currentInvite.expiresAt <= Date.now()) {
      currentInvite = null; incoming.hidden = true; stopTone(); return;
    }
    incoming.hidden = false;
    caller.textContent = 'Chiamata da ' + currentInvite.fromName;
    remaining.textContent = 'Scade tra ' + Math.ceil((currentInvite.expiresAt - Date.now()) / 1000) + ' secondi';
  }
  function soundRing() {
    // Best effort: browser may suspend WebAudio until user gesture.
    try {
      if (!toneContext) toneContext = new (window.AudioContext || window.webkitAudioContext)();
      if (toneContext.state !== 'running') return;
      const oscillator = toneContext.createOscillator();
      const gain = toneContext.createGain();
      gain.gain.value = 0.035; oscillator.frequency.value = 660;
      oscillator.connect(gain).connect(toneContext.destination);
      oscillator.start(); oscillator.stop(toneContext.currentTime + 0.12);
    } catch (_) {}
  }
  async function checkInvites() {
    if (!WsAuth.getStoredToken() || !WsAuth.isServiceSession()) return;
    try {
      const data = await api('invites');
      const next = data.invites[0] || null;
      if (next && (!currentInvite || next.id !== currentInvite.id)) {
        currentInvite = next;
        panel.hidden = false;
      } else if (!next) currentInvite = null;
      renderIncoming();
    } catch (_) { /* avoid noisy UI on network interruptions */ }
  }
  callButton.addEventListener('click', async () => {
    if (!destination.value) return say('Scegli il reparto da chiamare.');
    callButton.disabled = true;
    try {
      // Start caller audio first: the recipient must never accept an empty room.
      if (!connected) await connect();
      if (!connected) return;
      const data = await api('invite', {
        method: 'POST', body: {toDepartmentId: destination.value}
      });
      say('Collegato. Invito inviato a ' + data.toName + '. Scade tra 30 secondi.');
    } catch (error) { say('Chiamata non inviata: ' + error.message); }
    finally { callButton.disabled = false; }
  });
  async function answerInvite(answer) {
    if (!currentInvite) return;
    const id = currentInvite.id;
    accept.disabled = true; decline.disabled = true;
    try {
      const result = await api('respond', {method:'POST', body:{id, answer}});
      currentInvite = null; renderIncoming();
      if (result.accepted) await connect();
      else say('Chiamata rifiutata.');
    } catch(error) { say('Risposta non riuscita: ' + error.message); }
    finally { accept.disabled = false; decline.disabled = false; }
  }
  accept.addEventListener('click', () => answerInvite('accept'));
  decline.addEventListener('click', () => answerInvite('decline'));
  inviteTimer = setInterval(() => {
    if (!currentInvite) return;
    renderIncoming();
    if (currentInvite) soundRing();
  }, 1000);
  pollTimer = setInterval(checkInvites, 2000);

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
    clearInterval(pollTimer); clearInterval(inviteTimer);
    if (toneContext) toneContext.close().catch(() => {});
    if (mic) { mic.stop(); mic.close(); mic = null; }
    if (rtc) rtc.leave().catch(() => {});
  });
  fetch('/api/voice-test/status', {cache:'no-store'}).then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && data.enabled && WsAuth.isServiceSession()) {
        button.hidden = false;
        refreshDepartments();
        checkInvites();
      } else {
        clearInterval(pollTimer); clearInterval(inviteTimer);
      }
    })
    .catch(() => {});
  controls();
})();
