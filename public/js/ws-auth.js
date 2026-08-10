
// ws-auth.js — WebSocket Authentication Helper
// Handles session token storage and authenticated joinRoom for all station pages.
// The server signs a session token after verifying the Firebase ID token and fetching
// the company from Firestore. This token is passed on every joinRoom to prove identity.
// The server NEVER trusts a companyName sent directly by the client.

const WsAuth = (() => {
    const SESSION_TOKEN_KEY = 'ws_session_token';
    // [S2.2] Non-sensitive routing hint — set by storeToken(), cleared by clearToken().
    // ONLY used to decide which login page to show when no token is present.
    // NEVER used for authorization, company resolution, department resolution,
    // API access, or WebSocket room access.
    const LOGIN_TYPE_KEY = '_pt_login_type';

    // Retrieve the stored session token from sessionStorage
    function getStoredToken() {
        return sessionStorage.getItem(SESSION_TOKEN_KEY);
    }

    // Store a session token (called by the login page after exchange).
    // [S2.2] Also writes a non-sensitive routing hint derived from the token payload.
    function storeToken(token) {
        sessionStorage.setItem(SESSION_TOKEN_KEY, token);
        // Decode payload (no secret needed — routing only, not auth).
        try {
            const p = JSON.parse(atob(token.split('.')[0]));
            const type = (p && p.uid && p.uid.startsWith('depacct_')) ? 'service' : 'admin';
            sessionStorage.setItem(LOGIN_TYPE_KEY, type);
        } catch {
            sessionStorage.setItem(LOGIN_TYPE_KEY, 'admin');
        }
    }

    // Clear the stored session token (on logout).
    // [S2.2] Also clears the routing hint.
    function clearToken() {
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        sessionStorage.removeItem(LOGIN_TYPE_KEY);
    }

    // [S2.2] Returns true when the stored token belongs to a Department Account session
    // (token uid starts with 'depacct_'). Safe to call with no token (returns false).
    // Used for routing only — server-side session is always authoritative for access.
    function isServiceSession() {
        const t = getStoredToken();
        if (!t) return false;
        try {
            const p = JSON.parse(atob(t.split('.')[0]));
            return !!(p && p.uid && p.uid.startsWith('depacct_'));
        } catch { return false; }
    }

    // [S2.2] Returns the correct login page for the current (or last-known) session.
    // If a token exists: derives type from the token payload (most reliable).
    // If no token:       falls back to the routing hint written by storeToken().
    // If no hint either: defaults to 'index.html' (safe for legacy flows).
    // NEVER used for authorization.
    function getLoginDestination() {
        const t = getStoredToken();
        if (t) {
            return isServiceSession() ? 'service-login.html' : 'index.html';
        }
        const hint = sessionStorage.getItem(LOGIN_TYPE_KEY);
        return hint === 'service' ? 'service-login.html' : 'index.html';
    }

    // Exchange a Firebase ID token for a server-signed session token.
    // Returns the session token string, or null on failure.
    async function exchangeFirebaseToken(firebaseIdToken) {
        try {
            const response = await fetch('/api/auth/session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${firebaseIdToken}`
                }
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                console.error('[WS-AUTH] Session exchange failed:', err.error || response.status);
                return null;
            }
            const data = await response.json();
            if (data.token) {
                storeToken(data.token); // also sets routing hint
                console.log('[WS-AUTH] Session token stored successfully');
            }
            return data.token || null;
        } catch (err) {
            console.error('[WS-AUTH] Network error during session exchange:', err.message);
            return null;
        }
    }

    // Send an authenticated joinRoom message over the given WebSocket.
    // Then, after a short delay, sends joinPage if pageType is provided.
    // Redirects to the appropriate login page if no token is found.
    // onJoined(companyName) is called after the joinRoom message is sent.
    function joinRoom(ws, pageType, onJoined) {
        const token = getStoredToken();

        if (!token) {
            console.error('[WS-AUTH] No session token found — redirecting to login');
            alert('Sessione scaduta. Effettua nuovamente il login.');
            // [S2.2] Route to the correct login page — never depends on document.referrer.
            window.location.href = '/' + getLoginDestination();
            return;
        }

        if (ws.readyState !== WebSocket.OPEN) {
            console.warn('[WS-AUTH] WebSocket not open, cannot send joinRoom');
            return;
        }

        // [SECURITY] Send the server-signed token — company is extracted server-side
        ws.send(JSON.stringify({
            action: 'joinRoom',
            token: token
        }));

        if (pageType) {
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        action: 'joinPage',
                        pageType: pageType
                    }));
                    console.log(`[WS-AUTH] Sent joinPage: ${pageType}`);
                }
            }, 200);
        }

        if (onJoined) onJoined();
    }

    // Handle authentication errors received from the server via WebSocket.
    // Returns true if the error was an auth error (caller should stop processing).
    // [S2.2] Redirects to service-login.html for Department Account sessions,
    //        index.html for Admin/legacy sessions.
    function handleServerError(data) {
        if (data && (data.code === 'UNAUTHENTICATED' || data.code === 'TOKEN_REQUIRED' || data.code === 'TOKEN_INVALID')) {
            console.error('[WS-AUTH] Server auth error:', data.code, data.message);
            const dest = getLoginDestination(); // read before clearToken() removes token
            clearToken();
            alert('Sessione scaduta. Effettua nuovamente il login.');
            window.location.href = '/' + dest;
            return true;
        }
        return false;
    }

    return {
        getStoredToken,
        storeToken,
        clearToken,
        isServiceSession,
        getLoginDestination,
        exchangeFirebaseToken,
        joinRoom,
        handleServerError
    };
})();
