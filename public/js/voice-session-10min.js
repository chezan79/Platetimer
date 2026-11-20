/* PlateTimer continuous voice capture (10-minute session).
 * Standalone recording lifecycle. No countdown, authentication or Agora logic.
 * The caller owns speech recognition and must check isCurrent() before dispatch.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PlateTimerVoiceSession = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const DEFAULT_SESSION_MS = 10 * 60 * 1000;
  const DEFAULT_CLIP_MS = 5000;

  function createVoiceSession({
    mediaDevices, Recorder, getMimeType = () => '',
    onClip, onState = () => {},
    sessionMs = DEFAULT_SESSION_MS, clipMs = DEFAULT_CLIP_MS,
    clock = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = id => clearTimeout(id)
  }) {
    if (!mediaDevices || !Recorder || typeof onClip !== 'function')
      throw new TypeError('Voice session requires a microphone, Recorder and onClip');
    let active = false, starting = false, stream = null, recorder = null;
    let segmentTimer = null, expiryTimer = null, ticker = null, expiresAt = 0;
    let epoch = 0, queued = 0, processing = Promise.resolve();
    const isCurrent = id => active && epoch === id && clock() < expiresAt;
    const remainingMs = () => active ? Math.max(0, expiresAt - clock()) : 0;
    function clearTimers() {
      for (const id of [segmentTimer, expiryTimer, ticker]) if (id != null) cancel(id);
      segmentTimer = expiryTimer = ticker = null;
    }
    function stop(reason = 'stopped') {
      if (!active && !starting && !stream) return;
      epoch++;
      active = false;
      starting = false;
      clearTimers();
      const currentRecorder = recorder;
      recorder = null;
      if (currentRecorder && currentRecorder.state === 'recording') {
        try { currentRecorder.stop(); } catch (_) {}
      }
      if (stream) {
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch (_) {}
        }
        stream = null;
      }
      expiresAt = 0;
      onState({ status: reason, remainingMs: 0 });
    }
    function startClip(id) {
      if (!isCurrent(id) || !stream) { if (active) stop('expired'); return; }
      const options = getMimeType();
      let instance;
      try {
        instance = options ? new Recorder(stream, { mimeType: options }) : new Recorder(stream);
      } catch (error) {
        stop('recorder-error');
        return;
      }
      recorder = instance;
      const chunks = [];
      instance.ondataavailable = event => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      instance.onerror = () => stop('recorder-error');
      instance.onstop = () => {
        if (recorder === instance) recorder = null;
        if (segmentTimer != null) { cancel(segmentTimer); segmentTimer = null; }
        if (!isCurrent(id)) return;
        const type = instance.mimeType || options || 'audio/webm';
        const blob = new Blob(chunks, { type });
        // Rearm recording *before* awaiting transcription so another command
        // can be dictated without another button press.
        startClip(id);
        if (!blob.size || queued >= 2) return;
        queued++;
        processing = processing.then(async () => {
          if (!isCurrent(id)) return;
          await onClip(blob, { isCurrent: () => isCurrent(id), remainingMs });
        }).catch(error => {
          if (isCurrent(id)) onState({ status:'clip-error', error, remainingMs:remainingMs() });
        }).finally(() => { queued--; });
      };
      try {
        instance.start();
        const duration = Math.min(clipMs, remainingMs());
        segmentTimer = schedule(() => {
          if (recorder === instance && instance.state === 'recording') {
            try { instance.stop(); } catch (_) { stop('recorder-error'); }
          }
        }, duration);
      } catch (_) {
        stop('recorder-error');
      }
    }
    async function start() {
      if (active || starting) return false;
      const id = ++epoch;
      starting = true;
      onState({ status: 'requesting-microphone', remainingMs: sessionMs });
      let mic;
      try {
        mic = await mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        if (epoch === id) {
          starting = false;
          onState({ status: 'microphone-error', error, remainingMs:0 });
        }
        return false;
      }
      if (epoch !== id || !starting) {
        mic.getTracks().forEach(track => track.stop());
        return false;
      }
      stream = mic;
      starting = false;
      active = true;
      expiresAt = clock() + sessionMs;
      for (const track of mic.getTracks()) {
        track.addEventListener?.('ended', () => { if (isCurrent(id)) stop('microphone-ended'); });
      }
      expiryTimer = schedule(() => stop('expired'), sessionMs);
      const tick = () => {
        if (!isCurrent(id)) { if (active) stop('expired'); return; }
        onState({ status:'listening', remainingMs:remainingMs() });
        ticker = schedule(tick, 1000);
      };
      tick();
      startClip(id);
      return active;
    }
    return {
      start, stop, remainingMs,
      get active() { return active; },
      get starting() { return starting; }
    };
  }
  return { createVoiceSession, DEFAULT_SESSION_MS, DEFAULT_CLIP_MS };
});
