// operations-realtime.js — Sprint 5 Operations real-time channel
// Reuses the existing PlateTimer WebSocket server. No second WS server created.
// Provides OpsRealtime.on(event, handler), OpsRealtime.toast(msg, type),
// and OpsRealtime.highlight(el) for animated DOM updates.
//
// [SECURITY] Company isolation is enforced server-side.
//            This file makes no trust claims about company membership.
//            The token stored in sessionStorage was issued by the server
//            after Firebase ID-token verification.
(function () {
    'use strict';

    let ws = null;
    let reconnectTimer = null;
    let initAttempts = 0;
    const handlers = {};
    let toastRoot = null;

    // [T51] Join-confirmation state. The server replies { action: 'joinedRoom' }
    // on a successful joinRoom; auth failures arrive as { action: 'error', code }.
    // Without tracking these, a rejected join is indistinguishable from a quiet room.
    let joined = false;
    let joinConfirmTimer = null;
    let authFailures = 0;
    const MAX_AUTH_FAILURES = 3;
    const JOIN_CONFIRM_TIMEOUT_MS = 5000;

    // ── Toast notifications ───────────────────────────────────────────────────
    function ensureToastRoot() {
        if (toastRoot) return;
        toastRoot = document.createElement('div');
        toastRoot.id = 'ops-rt-toasts';
        toastRoot.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:9999;' +
            'display:flex;flex-direction:column-reverse;gap:8px;' +
            'pointer-events:none;max-width:340px;';
        document.body.appendChild(toastRoot);
    }

    function showToast(msg, type) {
        ensureToastRoot();
        const palette = { ok: '#16a34a', warn: '#ca8a04', info: '#4f46e5', danger: '#dc2626' };
        const bg = palette[type] || palette.info;
        const el = document.createElement('div');
        el.style.cssText =
            `background:${bg};color:#fff;padding:10px 16px;border-radius:8px;` +
            'font-size:13px;font-weight:600;line-height:1.4;' +
            'box-shadow:0 4px 16px rgba(0,0,0,.18);' +
            'opacity:0;transition:opacity .18s ease;pointer-events:auto;';
        el.textContent = msg;
        toastRoot.appendChild(el);
        requestAnimationFrame(() => { el.style.opacity = '1'; });
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => { try { el.remove(); } catch (_) {} }, 220);
        }, 4200);
    }

    // ── DOM highlight helper ─────────────────────────────────────────────────
    function highlight(el) {
        if (!el) return;
        el.style.transition = 'background .15s ease';
        el.style.background = 'rgba(79,70,229,.1)';
        setTimeout(() => {
            el.style.background = '';
            setTimeout(() => { el.style.transition = ''; }, 350);
        }, 900);
    }

    // ── Dispatch to registered handlers ──────────────────────────────────────
    function dispatch(msg) {
        const cbs = [...(handlers[msg.action] || []), ...(handlers['*'] || [])];
        cbs.forEach(fn => {
            try { fn(msg); }
            catch (e) { console.error('[OPS-RT] handler error:', e); }
        });
    }

    // ── WebSocket connection ──────────────────────────────────────────────────
    function connect() {
        if (ws && ws.readyState <= 1) return; // already CONNECTING or OPEN

        const token = sessionStorage.getItem('ws_session_token');
        if (!token) {
            // Token not yet available — auth is async. Retry up to ~15 s.
            if (initAttempts < 30) {
                initAttempts++;
                reconnectTimer = setTimeout(connect, 500);
            }
            return;
        }
        initAttempts = 0;

        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        try {
            ws = new WebSocket(`${proto}//${location.host}/ws`);
        } catch (e) {
            console.warn('[OPS-RT] WebSocket init failed:', e.message);
            return;
        }

        ws.addEventListener('open', () => {
            // Join the authenticated company room using the stored server-issued token.
            joined = false;
            ws.send(JSON.stringify({ action: 'joinRoom', token }));
            ws.send(JSON.stringify({ action: 'joinPage', pageType: 'operations' }));
            // [T51] If the server never confirms the join, the socket is useless
            // (silent rejection or lost message) — close it and let the reconnect
            // path retry with a fresh joinRoom.
            clearTimeout(joinConfirmTimer);
            joinConfirmTimer = setTimeout(() => {
                if (!joined && ws) {
                    console.warn('[OPS-RT] joinRoom not confirmed within '
                        + JOIN_CONFIRM_TIMEOUT_MS + 'ms — reconnecting');
                    try { ws.close(); } catch (_) {}
                }
            }, JOIN_CONFIRM_TIMEOUT_MS);
        });

        ws.addEventListener('message', evt => {
            let msg;
            try { msg = JSON.parse(evt.data); } catch { return; }
            if (typeof msg.action !== 'string') return;

            // [T51] Join confirmation — realtime channel is live.
            if (msg.action === 'joinedRoom') {
                joined = true;
                authFailures = 0;
                clearTimeout(joinConfirmTimer);
                console.log('[OPS-RT] company room joined — realtime channel active');
                return;
            }

            // [T51] Surface auth errors instead of silently ignoring them.
            if (msg.action === 'error' &&
                (msg.code === 'TOKEN_REQUIRED' || msg.code === 'TOKEN_INVALID' || msg.code === 'UNAUTHENTICATED')) {
                clearTimeout(joinConfirmTimer);
                authFailures++;
                console.error('[OPS-RT] joinRoom rejected by server:', msg.code, msg.message || '');
                if (authFailures >= MAX_AUTH_FAILURES) {
                    // Token is genuinely invalid (expired or server secret rotated).
                    // The same token backs all HTTP calls, so the session is dead —
                    // route the user through the standard re-auth flow.
                    console.error('[OPS-RT] session token invalid after '
                        + authFailures + ' attempts — re-authentication required');
                    if (window.WsAuth && WsAuth.handleServerError) {
                        WsAuth.handleServerError(msg); // clears token + redirects to login
                    } else {
                        showToast('Sessione scaduta. Ricarica la pagina ed effettua il login.', 'danger');
                    }
                } else {
                    // Transient (e.g. token refreshed by another tab moments ago):
                    // retry with the freshly-read token after a short delay.
                    try { ws && ws.close(); } catch (_) {}
                }
                return;
            }

            // Only handle OPS_* actions — all other PlateTimer messages are ignored.
            if (!msg.action.startsWith('OPS_')) return;
            dispatch(msg);
        });

        ws.addEventListener('close', () => {
            ws = null;
            joined = false;
            clearTimeout(joinConfirmTimer);
            // Exponential-like back-off capped at 5 s
            const delay = Math.min(3500 + initAttempts * 300, 5000);
            initAttempts++;
            reconnectTimer = setTimeout(connect, delay);
        });

        ws.addEventListener('error', () => {
            try { ws && ws.close(); } catch (_) {}
        });
    }

    // ── Public API ────────────────────────────────────────────────────────────
    window.OpsRealtime = {
        /**
         * Start the real-time channel. Call once per page after DOM ready.
         * Safe to call multiple times — idempotent.
         */
        init: connect,

        /**
         * Force reconnect (call after the WS session token becomes available).
         */
        reconnect() {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
            initAttempts = 0;
            if (ws) { try { ws.close(); } catch (_) {} ws = null; }
            connect();
        },

        /**
         * Register a handler for an OPS_* event.
         * Use action='*' to receive all OPS events.
         */
        on(action, fn) {
            if (!handlers[action]) handlers[action] = [];
            handlers[action].push(fn);
        },

        /** Remove a previously registered handler. */
        off(action, fn) {
            if (!handlers[action]) return;
            handlers[action] = handlers[action].filter(h => h !== fn);
        },

        /** Show a lightweight auto-dismissing toast. type: 'ok'|'warn'|'info'|'danger' */
        toast: showToast,

        /** Briefly highlight a DOM element to signal an in-place update. */
        highlight,
    };
}());
