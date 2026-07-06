
// ws-auth.js — WebSocket Authentication Helper
// Handles session token storage and authenticated joinRoom for all station pages.
// The server signs a session token after verifying the Firebase ID token and fetching
// the company from Firestore. This token is passed on every joinRoom to prove identity.
// The server NEVER trusts a companyName sent directly by the client.

const WsAuth = (() => {
    const SESSION_TOKEN_KEY = 'ws_session_token';

    // Retrieve the stored session token from sessionStorage
    function getStoredToken() {
        return sessionStorage.getItem(SESSION_TOKEN_KEY);
    }

    // Store a session token (called by the login page after exchange)
    function storeToken(token) {
        sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    }

    // Clear the stored session token (on logout)
    function clearToken() {
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
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
                storeToken(data.token);
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
    // Redirects to login if no token is found.
    // onJoined(companyName) is called after the joinRoom message is sent.
    function joinRoom(ws, pageType, onJoined) {
        const token = getStoredToken();

        if (!token) {
            console.error('[WS-AUTH] No session token found — redirecting to login');
            alert('Sessione scaduta. Effettua nuovamente il login.');
            window.location.href = '/index.html';
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
    function handleServerError(data) {
        if (data && (data.code === 'UNAUTHENTICATED' || data.code === 'TOKEN_REQUIRED' || data.code === 'TOKEN_INVALID')) {
            console.error('[WS-AUTH] Server auth error:', data.code, data.message);
            clearToken();
            alert('Sessione scaduta. Effettua nuovamente il login.');
            window.location.href = '/index.html';
            return true;
        }
        return false;
    }

    return {
        getStoredToken,
        storeToken,
        clearToken,
        exchangeFirebaseToken,
        joinRoom,
        handleServerError
    };
})();
