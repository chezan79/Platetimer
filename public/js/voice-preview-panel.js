/* PlateTimer voice panel. Production calls and Replit Preview have separate
   authenticated API endpoints. Microphone only starts after user action. */
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
  let endOfWindowAt = 0, windowTimer = null, checkingWindow = false;
  let nextServerCheckAt = 0;
  const swissClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  function isSwissServiceOpen() {
    const parts = Object.fromEntries(swissClock.formatToParts(new Date())
      .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const minutes = parts.hour * 60 + parts.minute;
    return (minutes >= 720 && minutes < 870) || (minutes >= 1110 && minutes < 1320);
  }
  const destination = panel.querySelector('[data-voice="destination"]');
  const callButton = panel.querySelector('[data-voice="call"]');
  const incoming = panel.querySelector('[data-voice="incoming"]');
  const caller = panel.querySelector('[data-voice="caller"]');
  const remaining = panel.querySelector('[data-voice="remaining"]');
  const accept = panel.querySelector('[data-voice="accept"]');
  const decline = panel.querySelector('[data-voice="decline"]');
  let currentInvite = null, inviteTimer = null, pollTimer = null, toneContext = null;
  let apiPrefix = '/api/voice-test';
  let prodMode = false;
  let currentCallId = null;
  function authHeaders() {
    return { Authorization: 'Bearer ' + (WsAuth.getStoredToken() || '') };
  }
  async function api(path, { method = 'GET', body } = {}) {
    const r = await fetch(apiPrefix + '/' + path, {
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
    // The repeating timer must remain installed for subsequent invitations.
    // A sound is emitted only when currentInvite is present and unexpired.
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
      if (prodMode) {
        if (connected) throw new Error('Concludi la chiamata corrente prima di chiamare un altro reparto.');
        const data = await api('invite', {method:'POST',body:{toDepartmentId:destination.value}});
        currentCallId = data.id;
        await connect(data.id);
        if (!connected) {
          await api('hangup', {method:'POST',body:{callId:data.id}}).catch(()=>{});
          currentCallId = null;
          return;
        }
        say('Chiamata a ' + data.toName + '. Invito valido fino a 30 secondi.');
      } else {
        // Preview-only legacy conference behavior.
        if (!connected) await connect();
        if (!connected) return;
        const data = await api('invite', {method:'POST',body:{toDepartmentId:destination.value}});
        say('Collegato. Invito inviato a ' + data.toName + '. Scade tra 30 secondi.');
      }
    } catch (error) { say('Chiamata non inviata: ' + error.message); }
    finally { callButton.disabled = false; }
  });
  async function answerInvite(answer) {
    if (!currentInvite) return;
    if (prodMode && answer === 'accept' && (connected || busy)) {
      say('Concludi la chiamata attuale prima di accettarne un’altra.');
      return;
    }
    const id = currentInvite.id;
    accept.disabled = true; decline.disabled = true;
    try {
      const result = await api('respond', {method:'POST', body:{id, answer}});
      currentInvite = null; renderIncoming();
      if (result.accepted) await connect(prodMode ? id : undefined);
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
  // Invitation polling starts only after backend feature authorization.

  const say = text => { message.textContent = text; };
  const controls = () => {
    join.disabled = busy || connected;
    leave.disabled = busy || !connected;
    mute.disabled = busy || !connected;
    mute.textContent = muted ? 'Attiva microfono' : 'Disattiva microfono';
    if (prodMode) {callButton.disabled = busy || connected; destination.disabled = busy || connected;}
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
  async function disconnect(reason = 'Chiamata terminata.') {
    if (windowTimer) { clearInterval(windowTimer); windowTimer = null; }
    endOfWindowAt = 0;
    checkingWindow = false;
    busy = true; controls();
    const oldMic = mic, oldRtc = rtc;
    const endingCallId = currentCallId;
    currentCallId = null;
    mic = null;
    rtc = null;
    connected = false;
    muted = false;
    // Stop local audio before awaiting network operations, even if Agora leave fails.
    if (prodMode && endingCallId) {
      void api('hangup',{method:'POST',body:{callId:endingCallId}}).catch(()=>{});
    }
    try { if (oldMic) { oldMic.stop(); oldMic.close(); } }
    catch (error) { console.warn('[VOICE] Microphone cleanup:', error); }
    try {
      if (oldRtc) {
        await oldRtc.leave();
        oldRtc.removeAllListeners();
      }
    } catch (error) { console.warn('[VOICE] Agora leave:', error); }
    finally { busy = false; controls(); countPeers(); say(reason); }
  }
  async function enforceVoiceWindow() {
    if (!connected || checkingWindow) return;
    if (!isSwissServiceOpen() || Date.now() >= endOfWindowAt) {
      await disconnect('Fascia oraria conclusa. Chiamata terminata.');
      button.hidden = true;
      panel.hidden = true;
      return;
    }
    if (Date.now() < nextServerCheckAt) return;
    checkingWindow = true;
    nextServerCheckAt = Date.now() + 5000;
    try {
      const status = await api('status');
      if (connected && (status.enabled !== true || status.scheduleEnabled === false)) {
        await disconnect('Chiamata terminata: fuori orario o autorizzazione revocata.');
      } else if (connected && prodMode && currentCallId) {
        const session = await api('session?id=' + encodeURIComponent(currentCallId));
        if (!session.active) await disconnect('Chiamata terminata dall’altro reparto.');
      }
    } catch (error) {
      // Authorization cannot be verified: fail closed rather than keeping audio open.
      if (connected) await disconnect('Chiamata terminata: verifica autorizzazione non disponibile.');
    } finally { checkingWindow = false; }
  }
  async function connect(callId) {
    if (prodMode && !callId) {say('Seleziona un reparto e premi Chiama.');return;}
    if (prodMode) currentCallId = callId;
    busy = true; controls(); say('Connessione Agora...');
    try {
      const session = WsAuth.getStoredToken();
      if (!session || !WsAuth.isServiceSession()) throw new Error('Accesso reparto Service richiesto.');
      const response = await fetch(apiPrefix + '/token', {
        method: 'POST', headers: { Authorization: 'Bearer ' + session,
          'Content-Type':'application/json' },
        ...(prodMode ? {body:JSON.stringify({callId})} : {})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Accesso alla chiamata negato.');
      await loadSdk();
      rtc = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      if (prodMode) rtc.on('token-privilege-will-expire', async () => {
        try {
          if (!currentCallId || !rtc) return;
          const renewed = await api('token',{method:'POST',body:{callId:currentCallId}});
          if (rtc) await rtc.renewToken(renewed.token);
        } catch (_) { await disconnect('Chiamata terminata: autorizzazione scaduta.'); }
      });
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
      // Enforce after every join, and re-check after mobile background/foreground.
      endOfWindowAt = Date.now() + data.windowEndsInSeconds * 1000;
      nextServerCheckAt = 0;
      if (windowTimer) clearInterval(windowTimer);
      windowTimer = setInterval(enforceVoiceWindow, 1000);
      void enforceVoiceWindow();
      say('Collegato: ' + data.departmentName + '. Microfono attivo.');
      countPeers();
    } catch (error) {
      if (windowTimer) { clearInterval(windowTimer); windowTimer = null; }
      endOfWindowAt = 0;
      say('Connessione non riuscita: ' + error.message);
      if (mic) { mic.stop(); mic.close(); mic = null; }
      if (rtc) { try { await rtc.leave(); } catch (_) {} rtc.removeAllListeners(); rtc = null; }
      connected = false;
      if (prodMode && currentCallId) {
        const failedCallId = currentCallId;
        currentCallId = null;
        void api('hangup',{method:'POST',body:{callId:failedCallId}}).catch(()=>{});
      }
    } finally { busy = false; controls(); }
  }
  join.addEventListener('click', connect);
  leave.addEventListener('click', () => disconnect());
  mute.addEventListener('click', async () => {
    if (!mic || busy) return;
    busy = true; controls();
    try { await mic.setEnabled(muted); muted = !muted; say(muted ? 'Microfono spento.' : 'Microfono attivo.'); }
    catch (error) { say('Errore microfono: ' + error.message); }
    finally { busy = false; controls(); }
  });
  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    // Browsers require a direct user gesture to unlock audible call alerts.
    try {
      if (!toneContext) toneContext = new (window.AudioContext || window.webkitAudioContext)();
      if (toneContext.state === 'suspended') void toneContext.resume().catch(()=>{});
    } catch (_) {}
  });
  close.addEventListener('click', () => { panel.hidden = true; });
  document.addEventListener('visibilitychange', () => {
    // In production, do not leave the microphone publishing in the background.
    if (document.hidden && prodMode && connected) void disconnect('Chiamata terminata: pagina in background.');
    else if (!document.hidden) void enforceVoiceWindow();
  });
  window.addEventListener('focus', () => { void enforceVoiceWindow(); });
  window.addEventListener('pagehide', () => {
    clearInterval(pollTimer); clearInterval(inviteTimer);
    if (windowTimer) clearInterval(windowTimer);
    if (toneContext) toneContext.close().catch(() => {});
    if (mic) { mic.stop(); mic.close(); mic = null; }
    if (rtc) rtc.leave().catch(() => {});
    if (prodMode && currentCallId) {
      const id = currentCallId;
      currentCallId = null;
      // keepalive is best-effort; expiry and participant checks also protect calls.
      fetch(apiPrefix+'/hangup',{method:'POST',keepalive:true,
        headers:{...authHeaders(),'Content-Type':'application/json'},
        body:JSON.stringify({callId:id})}).catch(()=>{});
    }
  });
  async function bootVoice() {
    if (!WsAuth.getStoredToken() || !WsAuth.isServiceSession()) return;
    try {
      // Production has priority: never fall back to the preview endpoints
      // when a production authorization/connection attempt fails.
      const response = await fetch('/api/voice-call/status', {
        cache:'no-store', headers:authHeaders()
      });
      const production = response.ok ? await response.json() : null;
      if (production && production.enabled) {
        prodMode = true;
        apiPrefix = '/api/voice-call';
        const title = panel.querySelector('strong');
        if (title) title.textContent = '🎧 PlateTimer · Chiamate';
        const note = panel.querySelector('p');
        if (note) note.textContent = 'Chiamate autorizzate tra reparti. Orari: 12:00–14:30 e 18:30–22:00 (Svizzera).';
        button.textContent = '📞 Chiamate';
        join.hidden = true;
        controls();
      } else if (production && production.enabled === false) {
        // Only a disabled production feature may use preview, and preview
        // itself is restricted server-side to a Replit test environment.
        const preview = await fetch('/api/voice-test/status', {
          cache:'no-store', headers:authHeaders()
        });
        const test = preview.ok ? await preview.json() : null;
        if (!test?.enabled) return;
      } else {
        return; // Auth and authorization errors fail closed.
      }
      button.hidden = false;
      await refreshDepartments();
      await checkInvites();
      pollTimer = setInterval(checkInvites, 2000);
    } catch (error) {
      console.warn('[VOICE] initialization failed:', error.message);
    }
  }
  void bootVoice();
  controls();
})();
