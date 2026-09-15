/* Shared-device Service worker identity.
 *
 * The proof intentionally lives only in sessionStorage.  This helper is
 * scoped to the worker identity endpoints; countdowns, Mex, voice, calendar
 * and read-only task requests continue to use the department session alone.
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'service_worker_identity';
  const INACTIVITY_MS = 5 * 60 * 1000;
  let options = {};
  let inactivityTimer = null;
  let activityBound = false;
  let roster = [];
  let disabled = false;
  let lastServerTouchAt = 0;

  function storage() {
    try { return root.sessionStorage; } catch (_) { return null; }
  }

  function read() {
    const store = storage();
    if (!store) return null;
    try {
      const value = JSON.parse(store.getItem(STORAGE_KEY) || 'null');
      return value && value.proof && value.worker ? value : null;
    } catch (_) {
      return null;
    }
  }

  function write(value) {
    const store = storage();
    if (!store) return;
    store.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  function clearLocal() {
    const store = storage();
    if (store) store.removeItem(STORAGE_KEY);
    if (inactivityTimer) {
      root.clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    render(null);
  }

  function absoluteMillis(value) {
    if (value === undefined || value === null || value === '') return 0;
    if (typeof value === 'number' || /^\d+$/.test(String(value))) {
      const n = Number(value);
      return n < 100000000000 ? n * 1000 : n;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function expired(value, now) {
    const at = absoluteMillis(value);
    return at > 0 && at <= (now || Date.now());
  }

  function valid(value) {
    if (!value || !value.proof || !value.worker) return false;
    const now = Date.now();
    const absoluteExpiry = absoluteMillis(value.expiresAt);
    const inactivityExpiry = absoluteMillis(value.inactivityExpiresAt);
    if (!absoluteExpiry || absoluteExpiry <= now ||
        (value.inactivityExpiresAt && (!inactivityExpiry || inactivityExpiry <= now))) return false;
    const lastActivity = Number(value.lastActivityAt || 0);
    return !lastActivity || now - lastActivity < INACTIVITY_MS;
  }

  function state() {
    const value = read();
    if (value && !valid(value)) {
      clearLocal();
      return null;
    }
    return value;
  }

  function token() {
    return root.WsAuth && typeof root.WsAuth.getStoredToken === 'function'
      ? root.WsAuth.getStoredToken() : null;
  }

  function headers(withProof) {
    const result = { 'Content-Type': 'application/json' };
    const sessionToken = token();
    if (sessionToken) result.Authorization = `Bearer ${sessionToken}`;
    const current = state();
    if (withProof && current) result['X-Worker-Proof'] = current.proof;
    return result;
  }

  function isFatal(response) {
    return response && [401, 403, 410].includes(response.status);
  }

  function failClosed(message) {
    disabled = true;
    clearLocal();
    const status = document.getElementById('worker-identity-status');
    if (status) status.textContent = message || 'Identità non disponibile su questo dispositivo.';
    const open = document.getElementById('worker-open-btn');
    if (open) open.disabled = true;
  }

  function scheduleExpiry() {
    if (inactivityTimer) root.clearTimeout(inactivityTimer);
    const current = read();
    if (!current) return;
    const now = Date.now();
    const absolute = absoluteMillis(current.expiresAt);
    const inactivity = absoluteMillis(current.inactivityExpiresAt);
    const local = Number(current.lastActivityAt || now) + INACTIVITY_MS;
    const deadlines = [local, absolute, inactivity].filter(n => n > now);
    const delay = Math.max(1, Math.min.apply(Math, deadlines) - now);
    inactivityTimer = root.setTimeout(function () {
      if (!state()) return;
      scheduleExpiry();
    }, delay);
  }

  function touch() {
    const current = state();
    if (!current) return;
    current.lastActivityAt = Date.now();
    write(current);
    scheduleExpiry();
    if (Date.now() - lastServerTouchAt > 60 * 1000) {
      lastServerTouchAt = Date.now();
      loadCurrent();
    }
  }

  function emitChange(current) {
    if (typeof root.dispatchEvent !== 'function') return;
    const detail = {
      worker: current && current.worker
        ? { id: current.worker.id, displayName: current.worker.displayName }
        : null
    };
    if (typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('service-worker-identity-change', { detail: detail }));
    }
  }

  function render(current) {
    const banner = document.getElementById('worker-identity-banner');
    const name = document.getElementById('worker-current-name');
    const status = document.getElementById('worker-identity-status');
    const clear = document.getElementById('worker-clear-btn');
    if (!banner) {
      emitChange(current);
      return;
    }
    banner.classList.toggle('has-worker', !!current);
    if (name) name.textContent = current && current.worker
      ? current.worker.displayName : 'Nessun lavoratore selezionato';
    if (status) status.textContent = current
      ? 'Operatore attivo' : (disabled ? 'Identità non disponibile' : 'Dispositivo reparto');
    if (clear) clear.style.display = current ? '' : 'none';
    emitChange(current);
  }

  function closeModal() {
    const modal = document.getElementById('worker-roster-modal');
    if (modal) modal.classList.remove('open');
  }

  function openModal() {
    if (disabled) return;
    const modal = document.getElementById('worker-roster-modal');
    if (!modal) return;
    modal.classList.add('open');
    const pin = document.getElementById('worker-pin');
    if (pin) { pin.value = ''; pin.focus(); }
    loadRoster();
  }

  function showModalError(message) {
    const error = document.getElementById('worker-verify-error');
    if (error) error.textContent = message || '';
  }

  function renderRoster() {
    const list = document.getElementById('worker-roster-list');
    if (!list) return;
    if (!roster.length) {
      list.innerHTML = '<div class="worker-empty">Nessun operatore disponibile.</div>';
      return;
    }
    list.innerHTML = roster.map(function (worker) {
      const id = String(worker.id).replace(/[&<>"']/g, '');
      const displayName = String(worker.displayName || worker.id).replace(/[&<>"']/g, '');
      return `<button type="button" class="worker-roster-item" data-worker-id="${id}">${displayName}</button>`;
    }).join('');
    list.querySelectorAll('[data-worker-id]').forEach(function (button) {
      button.addEventListener('click', function () {
        list.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
        button.classList.add('selected');
        list.dataset.selectedWorkerId = button.dataset.workerId;
        showModalError('');
      });
    });
  }

  async function loadRoster() {
    showModalError('');
    const list = document.getElementById('worker-roster-list');
    if (list) list.innerHTML = '<div class="worker-empty">Caricamento operatori...</div>';
    try {
      const response = await root.fetch('/api/service/workers/roster', {
        headers: headers(false)
      });
      if (isFatal(response)) {
        failClosed('Sessione dispositivo non valida. Seleziona nuovamente il reparto.');
        closeModal();
        return [];
      }
      if (!response.ok) throw new Error('roster');
      const data = await response.json();
      roster = Array.isArray(data.workers) ? data.workers : [];
      renderRoster();
      return roster;
    } catch (_) {
      roster = [];
      const target = document.getElementById('worker-roster-list');
      if (target) target.innerHTML = '<div class="worker-empty error">Impossibile caricare gli operatori.</div>';
      return [];
    }
  }

  async function verify(workerId, pin) {
    if (!workerId || !pin || disabled) return false;
    showModalError('');
    try {
      const response = await root.fetch('/api/service/workers/verify', {
        method: 'POST',
        headers: headers(false),
        body: JSON.stringify({ workerId: workerId, pin: pin })
      });
      const failure = !response.ok ? await response.json().catch(() => ({})) : null;
      if (isFatal(response) && failure && failure.code !== 'VERIFICATION_FAILED') {
        failClosed('Verifica non disponibile. Il dispositivo deve essere autenticato di nuovo.');
        closeModal();
        return false;
      }
      if (!response.ok) {
        showModalError(response.status === 429
          ? 'Troppi tentativi. Attendi prima di riprovare.'
          : 'PIN non valido o operatore non disponibile.');
        return false;
      }
      const data = await response.json();
      if (!data.worker || !data.proof || !data.expiresAt ||
          !absoluteMillis(data.expiresAt) || absoluteMillis(data.expiresAt) <= Date.now()) {
        failClosed('Risposta di verifica non valida.');
        return false;
      }
      write({
        worker: { id: data.worker.id, displayName: data.worker.displayName },
        proof: data.proof,
        expiresAt: data.expiresAt,
        inactivityExpiresAt: data.inactivityExpiresAt || null,
        lastActivityAt: Date.now()
      });
      disabled = false;
      scheduleExpiry();
      render(state());
      closeModal();
      return true;
    } catch (_) {
      showModalError('Verifica non riuscita. Riprova.');
      return false;
    }
  }

  async function clear() {
    const current = state();
    if (!current) { render(null); return true; }
    let fatal = false;
    try {
      const response = await root.fetch('/api/service/workers/clear', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({})
      });
      if (isFatal(response)) {
        fatal = true;
        failClosed('Sessione dispositivo non valida.');
      }
    } catch (_) {
      // Clearing locally is fail-safe even when the network is unavailable.
    }
    clearLocal();
    if (!fatal) disabled = false;
    return true;
  }

  async function loadCurrent() {
    if (!state() || disabled) return null;
    try {
      const response = await root.fetch('/api/service/workers/current', {
        headers: headers(true)
      });
      if (response.status === 401) {
        clearLocal();
        disabled = false;
        render(null);
        return null;
      }
      if (isFatal(response)) {
        failClosed('Identità operatore scaduta. Seleziona nuovamente un operatore.');
        return null;
      }
      if (!response.ok) return state();
      const data = await response.json();
      if (data.worker) {
        const current = state();
        if (current) {
          current.worker = { id: data.worker.id, displayName: data.worker.displayName };
          if (data.expiresAt !== undefined) current.expiresAt = data.expiresAt;
          if (data.inactivityExpiresAt !== undefined) {
            current.inactivityExpiresAt = data.inactivityExpiresAt;
          }
          write(current);
          lastServerTouchAt = Date.now();
        }
      }
      render(state());
      return state();
    } catch (_) {
      return state();
    }
  }

  function bindActivity() {
    if (activityBound || !root.document) return;
    activityBound = true;
    ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(function (eventName) {
      root.document.addEventListener(eventName, function () { touch(); }, { passive: true });
    });
  }

  function init(initOptions) {
    options = initOptions || {};
    if (!root.document) return;
    const banner = root.document.getElementById('worker-identity-banner');
    const serviceSession = root.WsAuth && root.WsAuth.isServiceSession &&
      root.WsAuth.isServiceSession();
    if (!serviceSession) {
      if (banner) banner.style.display = 'none';
      return;
    }
    if (banner) banner.style.display = '';
    bindActivity();
    const open = root.document.getElementById('worker-open-btn');
    const clearButton = root.document.getElementById('worker-clear-btn');
    const close = root.document.getElementById('worker-modal-close');
    const form = root.document.getElementById('worker-verify-form');
    if (open) open.addEventListener('click', openModal);
    if (clearButton) clearButton.addEventListener('click', function () {
      if (root.confirm && !root.confirm('Disconnettere l’operatore corrente?')) return;
      clear();
    });
    if (close) close.addEventListener('click', closeModal);
    const modal = root.document.getElementById('worker-roster-modal');
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    if (form) form.addEventListener('submit', function (event) {
      event.preventDefault();
      const list = root.document.getElementById('worker-roster-list');
      const pin = root.document.getElementById('worker-pin');
      verify(list && list.dataset.selectedWorkerId, pin && pin.value);
    });
    render(state());
    scheduleExpiry();
    loadCurrent();
  }

  root.ServiceWorkerIdentity = {
    init: init,
    getState: state,
    isValid: function () { return !!state(); },
    loadRoster: loadRoster,
    fetchRoster: loadRoster,
    verify: verify,
    verifyWorker: verify,
    clear: clear,
    clearWorker: clear,
    loadCurrent: loadCurrent,
    getCurrent: loadCurrent,
    getStoredIdentity: state,
    touch: touch,
    clearLocal: clearLocal,
    handoff: clear,
    clearDevice: async function () {
      try {
        await root.fetch('/api/service/workers/clear-device', {
          method: 'POST',
          headers: headers(false),
          body: JSON.stringify({})
        });
      } catch (_) {}
      clearLocal();
    },
    constants: { STORAGE_KEY: STORAGE_KEY, INACTIVITY_MS: INACTIVITY_MS }
  };
})(window);