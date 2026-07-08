
// ptt-voice.js — Push-to-Talk WebRTC module for PlateTimer
// Security model:
//   - Signaling travels over the already-authenticated WebSocket (ws.companyRoom on server).
//   - Company isolation is enforced server-side via the verified session token.
//   - The client never sends companyId/companyName; the server derives it from ws.companyRoom.
//   - No audio is recorded or stored; all audio is live peer-to-peer only.

'use strict';

const PttVoice = (() => {

  const VOICE_ROOM = 'main'; // one room per company; actual isolation via ws.companyRoom on server
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  // ── Private state ──────────────────────────────────────────────────────────
  let _ws          = null;
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

  function _send(obj) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify(obj));
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

  async function _createPeerConnection(remotePeerId, isOfferer) {
    if (_peers.has(remotePeerId)) return _peers.get(remotePeerId).pc;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    _peers.set(remotePeerId, { pc, audioEl: null });

    // Add local audio tracks (initially muted until PTT pressed)
    if (_localStream) {
      _localStream.getTracks().forEach(t => pc.addTrack(t, _localStream));
    }

    // Play remote audio
    pc.ontrack = ev => {
      const audio = new Audio();
      audio.srcObject = ev.streams[0];
      audio.autoplay  = true;
      audio.volume    = 1.0;
      document.body.appendChild(audio);
      const entry = _peers.get(remotePeerId);
      if (entry) entry.audioEl = audio;
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

  async function join(ws, myDeptName, onStatus, onTalking) {
    if (_inCall) return true;

    _ws         = ws;
    _myDeptName = myDeptName;
    _onStatus   = onStatus  || (() => {});
    _onTalking  = onTalking || (() => {});
    _myPeerId   = _genPeerId();

    // Request microphone permission
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // Start muted — PTT model: mic only active while button is held
      _localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    } catch (e) {
      const denied = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError';
      _onStatus(denied ? '⚠️ Permesso microfono negato' : '⚠️ Errore microfono', 'error');
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

    _peers.forEach((_, peerId) => _removePeer(peerId));

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
    get inCall() { return _inCall; }
  };

})();
