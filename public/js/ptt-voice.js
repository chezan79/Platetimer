
// ptt-voice.js — Push-to-Talk WebRTC module for PlateTimer
// Security model:
//   - Signaling travels over the already-authenticated WebSocket (ws.companyRoom on server).
//   - Company isolation is enforced server-side via the verified session token.
//   - The client never sends companyId/companyName; the server derives it from ws.companyRoom.
//   - No audio is recorded or stored; all audio is live peer-to-peer only.
//
// WebSocket reference model:
//   - join() accepts a GETTER FUNCTION () => WebSocket, not a bare WebSocket object.
//   - This ensures _send() always uses the current live socket, even after reconnects.
//   - After every WS reconnect, the caller must invoke PttVoice.onWsReconnect() so the
//     server voice-room state is restored on the new connection.

'use strict';

const PttVoice = (() => {

  const VOICE_ROOM = 'main'; // one room per company; actual isolation via ws.companyRoom on server
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  // ── Private state ──────────────────────────────────────────────────────────
  let _wsGetter    = null;   // () => WebSocket  — always call this, never cache the socket
  let _myPeerId    = null;
  let _myDeptName  = '';
  let _inCall      = false;
  let _isTalking   = false;
  let _localStream = null;

  // peerId → { pc: RTCPeerConnection, audioEl: HTMLAudioElement|null }
  const _peers = new Map();

  // Callbacks set on join()
  let _onStatus  = () => {};  // (text, cssClass) → void
  let _onTalking = () => {};  // (deptName, isTalking) → void

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _genPeerId() {
    return 'pt_' + Math.random().toString(36).substr(2, 10);
  }

  // Always fetches the current socket from the getter — survives WS reconnects.
  function _send(obj) {
    const socket = _wsGetter && _wsGetter();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(obj));
    } else {
      console.warn('[ptt] _send: socket not open — action dropped:', obj.action);
    }
  }

  function _removePeer(peerId) {
    const entry = _peers.get(peerId);
    if (!entry) return;
    if (entry.audioEl) {
      entry.audioEl.srcObject = null;
      entry.audioEl.remove();
    }
    try { entry.pc.close(); } catch (_) {}
    _peers.delete(peerId);
    console.log(`[ptt] peer removed: ${peerId} (${_peers.size} remaining)`);
  }

  function _clearAllPeers() {
    _peers.forEach((_, peerId) => _removePeer(peerId));
  }

  async function _createPeerConnection(remotePeerId, isOfferer) {
    if (_peers.has(remotePeerId)) return _peers.get(remotePeerId).pc;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    _peers.set(remotePeerId, { pc, audioEl: null });

    // Add local audio tracks (initially muted until PTT pressed)
    if (_localStream) {
      _localStream.getTracks().forEach(t => pc.addTrack(t, _localStream));
    }

    // Play remote audio — resume AudioContext on first track to defeat autoplay block
    pc.ontrack = ev => {
      const audio = new Audio();
      audio.srcObject = ev.streams[0];
      audio.autoplay  = true;
      audio.volume    = 1.0;

      // Defeat autoplay policy: resume on next user interaction if blocked
      const tryPlay = () => {
        audio.play().catch(err => {
          console.warn('[ptt] autoplay blocked, will retry on next user gesture:', err.message);
          const resume = () => { audio.play().catch(() => {}); document.removeEventListener('pointerdown', resume); };
          document.addEventListener('pointerdown', resume, { once: true });
        });
      };

      document.body.appendChild(audio);
      const entry = _peers.get(remotePeerId);
      if (entry) entry.audioEl = audio;
      tryPlay();
      console.log(`[ptt] remote audio attached for peer ${remotePeerId}`);
    };

    // Forward ICE candidates
    pc.onicecandidate = ev => {
      if (ev.candidate) {
        _send({ action: 'ice-candidate', to: remotePeerId, from: _myPeerId, candidate: ev.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log(`[ptt] peer ${remotePeerId} → ${s}`);
      if (s === 'failed' || s === 'closed') {
        _removePeer(remotePeerId);
      }
    };

    if (isOfferer) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      _send({ action: 'offer', to: remotePeerId, from: _myPeerId, sdp: pc.localDescription });
    }

    return pc;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Join the intercom voice room.
   *
   * @param {Function|WebSocket} wsOrGetter  A getter function (() => WebSocket) — preferred.
   *                                          A bare WebSocket is also accepted for backwards compat
   *                                          but will NOT survive reconnects.
   * @param {string}   myDeptName  Department display name (for talkingStart label).
   * @param {Function} onStatus    (text, cssClass) → void
   * @param {Function} onTalking   (deptName, isTalking) → void
   */
  async function join(wsOrGetter, myDeptName, onStatus, onTalking) {
    if (_inCall) return true;

    // Accept either a getter function or a bare WebSocket
    _wsGetter   = (typeof wsOrGetter === 'function') ? wsOrGetter : () => wsOrGetter;
    _myDeptName = myDeptName;
    _onStatus   = onStatus  || (() => {});
    _onTalking  = onTalking || (() => {});
    _myPeerId   = _genPeerId();

    // Request microphone permission
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // Start muted — PTT model: mic only active while button is held
      _localStream.getAudioTracks().forEach(t => { t.enabled = false; });
      console.log('[ptt] microphone acquired, tracks muted until PTT press');
    } catch (e) {
      const denied = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError';
      _onStatus(denied ? '⚠️ Permesso microfono negato' : '⚠️ Errore microfono: ' + e.message, 'error');
      console.error('[ptt] getUserMedia failed:', e);
      return false;
    }

    // Join voice signaling room on server (company isolation is server-side)
    _send({ action: 'joinVoice', room: VOICE_ROOM, peerId: _myPeerId });

    _inCall = true;
    _onStatus('✅ Connesso — tieni premuto per parlare', 'connected');
    console.log(`[ptt] joined voice room as ${_myPeerId}`);
    return true;
  }

  function leave() {
    if (!_inCall) return;

    if (_isTalking) stopTalking();

    _send({ action: 'leaveVoice', peerId: _myPeerId });

    _clearAllPeers();

    if (_localStream) {
      _localStream.getTracks().forEach(t => t.stop());
      _localStream = null;
    }

    _inCall    = false;
    _isTalking = false;
    _onStatus('Non connesso', '');
    console.log('[ptt] left voice room');
  }

  function startTalking() {
    if (!_inCall || _isTalking) return;
    _isTalking = true;
    if (_localStream) _localStream.getAudioTracks().forEach(t => { t.enabled = true; });
    _send({ action: 'talkingStart', peerId: _myPeerId, deptName: _myDeptName });
    _onStatus('🔴 Stai parlando...', 'talking');
  }

  function stopTalking() {
    if (!_inCall || !_isTalking) return;
    _isTalking = false;
    if (_localStream) _localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    _send({ action: 'talkingStop', peerId: _myPeerId });
    _onStatus('✅ Connesso — tieni premuto per parlare', 'connected');
  }

  /**
   * Call this after every WebSocket reconnect completes authentication.
   * Clears stale peer connections and re-announces presence in the voice room
   * on the new socket so the server rebuilds its routing tables.
   */
  function onWsReconnect() {
    if (!_inCall) return;
    console.log('[ptt] WS reconnected — clearing stale peers and re-joining voice room');

    // Stop talking if we were mid-press (mic track stays allocated)
    if (_isTalking) {
      _isTalking = false;
      if (_localStream) _localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    }

    // Close all stale RTCPeerConnections — their ICE state is dead
    _clearAllPeers();

    // Fresh peer ID so other clients know this is a new session
    _myPeerId = _genPeerId();

    // Re-announce on the new authenticated socket
    _send({ action: 'joinVoice', room: VOICE_ROOM, peerId: _myPeerId });

    _onStatus('✅ Connesso — tieni premuto per parlare', 'connected');
    console.log(`[ptt] re-joined voice room after reconnect as ${_myPeerId}`);
  }

  // Handle WebRTC signaling messages routed from the main WS onmessage handler
  async function handleSignal(data) {
    if (!_inCall && !['talkingStart', 'talkingStop'].includes(data.action)) return;

    switch (data.action) {

      case 'voicePeers': {
        // Server sends existing peers in the room — we initiate offers to each
        const peers = data.peers || [];
        console.log(`[ptt] existing peers: ${peers.join(', ') || 'none'}`);
        for (const peerId of peers) {
          if (peerId !== _myPeerId && !_peers.has(peerId)) {
            await _createPeerConnection(peerId, true);
          }
        }
        break;
      }

      case 'voicePeerJoined':
        // A new peer joined after us; they will send us an offer — just log it
        console.log(`[ptt] new peer announced: ${data.peerId}`);
        break;

      case 'offer': {
        const from = data.from;
        if (!from || from === _myPeerId) break;
        let pc = _peers.has(from) ? _peers.get(from).pc : null;
        if (!pc) pc = await _createPeerConnection(from, false);
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        _send({ action: 'answer', to: from, from: _myPeerId, sdp: pc.localDescription });
        break;
      }

      case 'answer': {
        const pc = _peers.has(data.from) ? _peers.get(data.from).pc : null;
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        break;
      }

      case 'ice-candidate': {
        const pc = _peers.has(data.from) ? _peers.get(data.from).pc : null;
        if (pc && data.candidate) {
          try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
          catch (e) { console.warn('[ptt] addIceCandidate error:', e); }
        }
        break;
      }

      case 'voicePeerLeft':
        _removePeer(data.peerId);
        if (_inCall) _onStatus('✅ Connesso — tieni premuto per parlare', 'connected');
        break;

      case 'talkingStart': {
        const name = data.deptName || 'Reparto';
        _onTalking(name, true);
        if (_inCall) _onStatus(`🎙️ ${name} sta parlando...`, 'remote-talking');
        break;
      }

      case 'talkingStop':
        _onTalking('', false);
        if (_inCall) _onStatus('✅ Connesso — tieni premuto per parlare', 'connected');
        break;

      default:
        break;
    }
  }

  return {
    join,
    leave,
    startTalking,
    stopTalking,
    handleSignal,
    onWsReconnect,
    get inCall() { return _inCall; }
  };

})();
