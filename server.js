const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const speech = require('@google-cloud/speech');

const app = express();
const server = http.createServer(app);

// ===== SECURITY: Server-side Session Token (HMAC-SHA256) =====
// Secret loaded from env var; if missing, a random key is generated.
// WARNING: a random key means all tokens are invalidated on server restart.
const WS_SECRET = process.env.WS_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.WS_SESSION_SECRET) {
    console.warn('⚠️ [SECURITY] WS_SESSION_SECRET not set — random key generated. Tokens will be invalidated on server restart. Set WS_SESSION_SECRET in Secrets for production.');
}

// Firebase Web API key — technically public (same value appears in client-side config by design),
// but kept server-side as an env var so it can be rotated without a code change.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDZ0FdjenO-ngblcuXKdwWwvRV5liiR18I';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'app-dati-tavoli';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// ===== Department Storage =====
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DEPARTMENTS_FILE = path.join(DATA_DIR, 'departments.json');
const PLANS_FILE = path.join(DATA_DIR, 'plans.json');
const PLAN_LIMITS = { base: 3, medium: 5, premium: 10 };

function loadJSON(filePath) {
    try { if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (e) { console.error('Error loading', filePath, e.message); }
    return {};
}
function saveJSON(filePath, data) {
    try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('Error saving', filePath, e.message); }
}

let departmentsStore = loadJSON(DEPARTMENTS_FILE);
let plansStore = loadJSON(PLANS_FILE);

function getCompanyDepts(companyId) { return departmentsStore[companyId] || []; }
function getCompanyPlan(companyId) { return plansStore[companyId] || 'base'; }
function getPlanLimit(plan) { return PLAN_LIMITS[plan] || PLAN_LIMITS.base; }
function genDeptId() { return 'dept_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'); }

// Sign a session token using HMAC-SHA256.
// The token payload contains uid, companyName, iat, exp — never trust these from the client.
function signSessionToken(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid,
        companyName,
        iat: Date.now(),
        exp: Date.now() + SESSION_DURATION_MS
    })).toString('base64');
    const sig = crypto.createHmac('sha256', WS_SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

// Verify a session token. Returns the decoded data or null if invalid/expired.
function verifySessionToken(token) {
    try {
        if (!token || typeof token !== 'string') return null;
        const dotIndex = token.lastIndexOf('.');
        if (dotIndex === -1) return null;
        const payload = token.substring(0, dotIndex);
        const sig = token.substring(dotIndex + 1);
        // Timing-safe HMAC comparison to prevent timing attacks
        const expected = crypto.createHmac('sha256', WS_SECRET).update(payload).digest('hex');
        const sigBuf = Buffer.from(sig.length === expected.length ? sig : '0'.repeat(expected.length), 'hex');
        const expBuf = Buffer.from(expected, 'hex');
        if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
            return null; // [SECURITY] Invalid signature
        }
        const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        if (!data.uid || !data.companyName || !data.exp) return null;
        if (Date.now() > data.exp) return null; // [SECURITY] Token expired
        return data;
    } catch {
        return null;
    }
}

// Verify a Firebase ID token via Firebase REST API (no Admin SDK required).
// Returns the Firebase uid or null on failure.
async function verifyFirebaseIdToken(idToken) {
    try {
        const response = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken })
            }
        );
        if (!response.ok) return null;
        const data = await response.json();
        if (!data.users || data.users.length === 0) return null;
        return data.users[0].localId; // Firebase uid
    } catch (err) {
        console.error('❌ [SECURITY] Firebase ID token verification error:', err.message);
        return null;
    }
}

// Fetch the user's company name from Firestore using their own ID token.
// This is authoritative — the company comes from the database, not from the client.
async function getCompanyFromFirestore(uid, idToken) {
    try {
        const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${idToken}` }
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.fields?.company?.stringValue || null;
    } catch (err) {
        console.error('❌ [SECURITY] Firestore company lookup error:', err.message);
        return null;
    }
}

// Configura il WebSocket Server
const wss = new WebSocket.Server({ 
    server,
    path: '/ws' // Percorso per le connessioni WebSocket
});

// Modalità manutenzione - impostare su true per attivare
const MAINTENANCE_MODE = false; // Cambiare a true per attivare la manutenzione

// Middleware per modalità manutenzione
// Shared auth guard — call at the top of any protected route handler.
// Returns the verified session object or sends 401 and returns null.
function requireAuth(req, res) {
    const h = req.headers['authorization'];
    if (!h || !h.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Authentication required. Please log in again.' });
        return null;
    }
    const session = verifySessionToken(h.substring(7).trim());
    if (!session) {
        res.status(401).json({ error: 'Session token invalid or expired. Please log in again.' });
        return null;
    }
    return session;
}

app.use((req, res, next) => {
    if (MAINTENANCE_MODE) {
        // Permetti solo l'accesso alla pagina di manutenzione e ai suoi assets
        if (req.path === '/maintenance.html' || 
            req.path.startsWith('/css/') || 
            req.path.startsWith('/js/') || 
            req.path.startsWith('/images/') ||
            req.path.endsWith('.css') ||
            req.path.endsWith('.js') ||
            req.path.endsWith('.png') ||
            req.path.endsWith('.jpg') ||
            req.path.endsWith('.ico')) {
            return next();
        }
        
        // Reindirizza tutto il resto alla pagina di manutenzione
        return res.redirect('/maintenance.html');
    }
    next();
});

// Force fresh fetch for HTML — prevents stale UI after deploys
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Serve i file statici dalla directory "public"
app.use(express.static('public'));

// Middleware per parsing JSON
app.use(express.json());

// Configura Google Cloud Speech
let speechClient = null;
try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
        const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
        speechClient = new speech.SpeechClient({
            projectId: credentials.project_id,
            credentials: credentials
        });
        console.log('✅ Google Cloud Speech configurato correttamente');
    } else {
        console.log('⚠️ Credenziali Google Cloud Speech non trovate');
    }
} catch (error) {
    console.error('❌ Errore configurazione Google Cloud Speech:', error.message);
}

// ===== SECURITY: Session Token Exchange Endpoint =====
// The frontend calls this after Firebase login to get a server-signed session token.
// The server verifies the Firebase ID token, fetches the company from Firestore
// (authoritative source — never trusts the client-supplied companyName),
// then returns a short-lived HMAC-signed token used for all subsequent WS messages.
app.post('/api/auth/session', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Firebase ID token required in Authorization header' });
        }

        const idToken = authHeader.substring(7).trim();
        if (!idToken) {
            return res.status(401).json({ error: 'Firebase ID token is empty' });
        }

        // [SECURITY] Step 1: Verify the Firebase ID token via Firebase REST API
        const uid = await verifyFirebaseIdToken(idToken);
        if (!uid) {
            console.log('⛔ [SECURITY] /api/auth/session rejected: invalid Firebase token');
            return res.status(401).json({ error: 'Invalid or expired Firebase token' });
        }

        // [SECURITY] Step 2: Fetch company name from Firestore using the user's own token
        // This is the authoritative source — the client cannot forge this value
        const companyName = await getCompanyFromFirestore(uid, idToken);
        if (!companyName || companyName.trim() === '') {
            console.log(`⛔ [SECURITY] /api/auth/session rejected: no company found for uid=${uid}`);
            return res.status(403).json({ error: 'No company associated with this account. Please complete your profile.' });
        }

        const normalizedCompany = companyName.trim().toLowerCase();

        // [SECURITY] Step 3: Issue a server-signed session token
        const sessionToken = signSessionToken(uid, normalizedCompany);

        console.log(`✅ [SECURITY] Session token issued: uid=${uid}, company="${normalizedCompany}"`);

        res.json({
            success: true,
            token: sessionToken,
            companyName: normalizedCompany
        });

    } catch (error) {
        console.error('❌ [SECURITY] /api/auth/session error:', error);
        res.status(500).json({ error: 'Internal server error during authentication' });
    }
});

// Endpoint per salvare messaggi vocali
// [SECURITY] Requires a valid server-signed session token in Authorization: Bearer header.
// Company is always taken from the verified token — never from the request body.
app.post('/api/voice-message', (req, res) => {
    try {
        // [SECURITY] Extract and verify the session token
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log(`⛔ [SECURITY] POST /api/voice-message rejected — no token (IP: ${req.ip})`);
            return res.status(401).json({ error: 'Authentication required. Please log in again.' });
        }

        const token = authHeader.substring(7).trim();
        const session = verifySessionToken(token);
        if (!session) {
            console.log(`⛔ [SECURITY] POST /api/voice-message rejected — invalid or expired token (IP: ${req.ip})`);
            return res.status(401).json({ error: 'Session token invalid or expired. Please log in again.' });
        }

        // [SECURITY] Company always comes from the verified token — never from req.body
        const companyName = session.companyName;

        const { audioData, messageId, destinations, destination, from } = req.body;

        // Accept either destinations[] array or legacy single destination string
        const destList = (Array.isArray(destinations) && destinations.length > 0)
            ? destinations
            : (destination ? [destination] : []);

        if (!audioData || !messageId || destList.length === 0) {
            return res.status(400).json({ error: 'Dati mancanti' });
        }

        // [SECURITY] Validate that every destination belongs to the authenticated company
        const companyDeptsRest = getCompanyDepts(companyName);
        const activeDeptIdsRest = companyDeptsRest.filter(d => d.active).map(d => d.id);
        if (activeDeptIdsRest.length > 0) {
            for (const destId of destList) {
                if (!activeDeptIdsRest.includes(destId)) {
                    console.log(`⛔ [SECURITY] Voice message rejected — invalid destination "${destId}" for company "${companyName}"`);
                    return res.status(400).json({ error: `Reparto destinatario non valido: ${destId}` });
                }
            }
            if (from && !activeDeptIdsRest.includes(from)) {
                console.log(`⛔ [SECURITY] Voice message rejected — invalid source "${from}" for company "${companyName}"`);
                return res.status(400).json({ error: 'Reparto mittente non valido' });
            }
        }

        console.log(`🎤 [SECURITY] Messaggio vocale ricevuto: ID ${messageId}, Da: ${from}, Company: "${companyName}", Per: [${destList.join(', ')}] (uid: ${session.uid})`);

        // Broadcast to WebSocket clients inside the verified company room only
        if (companyRooms.has(companyName)) {
            const roomClients = companyRooms.get(companyName);
            const broadcastPayload = JSON.stringify({
                action: 'voiceMessage',
                message: `Messaggio vocale`,
                messageId,
                from,
                sourceDepartmentId: from || '',
                destinations: destList,
                destination: destList[0],
                audioData,
                hasAudio: true,
                timestamp: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
            });

            let sentCount = 0;
            roomClients.forEach(client => {
                if (client.readyState === 1 /* OPEN */ && client !== req._ws) {
                    client.send(broadcastPayload);
                    sentCount++;
                }
            });
            console.log(`📢 [SECURITY] Voice message broadcast to ${sentCount} clients in company room "${companyName}" for depts [${destList.join(', ')}]`);
        }

        res.json({ 
            success: true, 
            messageId: messageId,
            destinations: destList
        });

    } catch (error) {
        console.error('❌ Errore salvataggio messaggio vocale:', error);
        res.status(500).json({ error: 'Errore interno server' });
    }
});

// Payment functionality removed

// ===== Department REST API =====

// GET /api/departments — list company's departments + plan info
app.get('/api/departments', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const depts = getCompanyDepts(companyId);
    const plan = getCompanyPlan(companyId);
    const limit = getPlanLimit(plan);
    res.json({ success: true, departments: depts, plan, limit });
});

// POST /api/departments — create (enforces plan limit server-side)
app.post('/api/departments', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name is required.' });

    const depts = getCompanyDepts(companyId);
    const plan = getCompanyPlan(companyId);
    const limit = getPlanLimit(plan);
    const activeCount = depts.filter(d => d.active).length;

    if (activeCount >= limit) {
        return res.status(403).json({
            error: `Plan limit reached. Your ${plan} plan allows up to ${limit} active departments. Deactivate one or upgrade your plan.`
        });
    }

    const dept = { id: genDeptId(), name, active: true, usedInCountdowns: false, createdAt: Date.now() };
    if (!departmentsStore[companyId]) departmentsStore[companyId] = [];
    departmentsStore[companyId].push(dept);
    saveJSON(DEPARTMENTS_FILE, departmentsStore);
    console.log(`✅ Department created: "${name}" for company "${companyId}"`);
    res.status(201).json({ success: true, department: dept });
});

// PUT /api/departments/:id — update name and/or active status
app.put('/api/departments/:id', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const depts = departmentsStore[companyId] || [];
    const idx = depts.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Department not found.' });

    const { name, active } = req.body;

    // Enforce plan limit when re-activating
    if (active === true && !depts[idx].active) {
        const plan = getCompanyPlan(companyId);
        const limit = getPlanLimit(plan);
        const currentActive = depts.filter(d => d.active).length;
        if (currentActive >= limit) {
            return res.status(403).json({
                error: `Plan limit reached. Your ${plan} plan allows up to ${limit} active departments.`
            });
        }
    }

    if (typeof name === 'string' && name.trim()) depts[idx].name = name.trim();
    if (typeof active === 'boolean') depts[idx].active = active;

    saveJSON(DEPARTMENTS_FILE, departmentsStore);
    res.json({ success: true, department: depts[idx] });
});

// DELETE /api/departments/:id — only if never used in countdowns
app.delete('/api/departments/:id', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const depts = departmentsStore[companyId] || [];
    const idx = depts.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Department not found.' });

    if (depts[idx].usedInCountdowns) {
        return res.status(409).json({ error: 'This department has been used in countdowns and cannot be deleted. Deactivate it instead.' });
    }
    // Also block if it has an active countdown right now
    if (activeCountdowns.has(companyId)) {
        for (const [, cd] of activeCountdowns.get(companyId)) {
            if (cd.destinations && cd.destinations.includes(req.params.id)) {
                return res.status(409).json({ error: 'This department has active countdowns. Deactivate it instead.' });
            }
        }
    }

    departmentsStore[companyId].splice(idx, 1);
    saveJSON(DEPARTMENTS_FILE, departmentsStore);
    res.json({ success: true });
});

// GET /api/subscription — return company's current plan and limit
app.get('/api/subscription', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const plan = getCompanyPlan(companyId);
    const limit = getPlanLimit(plan);
    const activeCount = getCompanyDepts(companyId).filter(d => d.active).length;
    res.json({ success: true, plan, limit, activeCount });
});

// Endpoint per il riconoscimento vocale
app.post('/api/speech-to-text', async (req, res) => {
    try {
        // [SECURITY] Require a valid server session token — prevents unauthenticated callers
        // from consuming Google Cloud Speech API quota at the restaurant's expense.
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log(`⛔ [SECURITY] POST /api/speech-to-text rejected — no token (IP: ${req.ip})`);
            return res.status(401).json({ error: 'Authentication required. Please log in again.' });
        }
        const sttToken = authHeader.substring(7).trim();
        const sttSession = verifySessionToken(sttToken);
        if (!sttSession) {
            console.log(`⛔ [SECURITY] POST /api/speech-to-text rejected — invalid or expired token (IP: ${req.ip})`);
            return res.status(401).json({ error: 'Session token invalid or expired. Please log in again.' });
        }

        if (!speechClient) {
            return res.status(500).json({ 
                error: 'Google Cloud Speech non configurato',
                details: 'Controlla le credenziali nei Secrets'
            });
        }

        const { audioData, config = {} } = req.body;

        if (!audioData) {
            return res.status(400).json({ error: 'Audio data richiesto' });
        }

        // Configurazione per il riconoscimento
        const request = {
            audio: {
                content: audioData
            },
            config: {
                encoding: config.encoding || 'WEBM_OPUS',
                sampleRateHertz: config.sampleRateHertz || 48000,
                languageCode: config.languageCode || 'it-IT',
                model: 'command_and_search',
                useEnhanced: true,
                ...config
            }
        };

        // Effettua il riconoscimento
        const [response] = await speechClient.recognize(request);
        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join('\n');

        console.log('🎤 Trascrizione:', transcription);

        res.json({
            transcription: transcription,
            confidence: response.results[0]?.alternatives[0]?.confidence || 0
        });

    } catch (error) {
        console.error('❌ Errore Speech-to-Text:', error);
        res.status(500).json({ 
            error: 'Errore nel riconoscimento vocale',
            details: error.message
        });
    }
});

// REST API endpoint to get active countdowns.
// [SECURITY] Bearer token is mandatory. Company is always extracted from the verified token —
// the ?company= query param is accepted but ignored. Unauthenticated requests receive HTTP 401.
app.get('/api/countdowns', (req, res) => {
    try {
        const status = req.query.status || 'active';

        // [SECURITY] Bearer token is now mandatory — the company is always extracted from the
        // verified token, never from a client-supplied query param. This closes the cross-company
        // data exposure window where any caller knowing a company name could read its countdowns.
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log(`⛔ [SECURITY] GET /api/countdowns rejected — no token (IP: ${req.ip})`);
            return res.status(401).json({
                success: false,
                error: 'Authentication required. Pass a valid session token in the Authorization header.'
            });
        }

        const cdToken = authHeader.substring(7).trim();
        const cdSession = verifySessionToken(cdToken);
        if (!cdSession) {
            console.log(`⛔ [SECURITY] GET /api/countdowns rejected — invalid or expired token (IP: ${req.ip})`);
            return res.status(401).json({
                success: false,
                error: 'Session token invalid or expired. Please log in again.'
            });
        }

        // [SECURITY] Company always comes from the verified token — the ?company= query param is ignored
        const companyName = cdSession.companyName;

        const normalizedCompany = companyName.trim().toLowerCase();
        const result = [];
        const currentTime = Date.now();

        // Return only the requested company's countdowns
        if (activeCountdowns.has(normalizedCompany)) {
            const companyCountdowns = activeCountdowns.get(normalizedCompany);

            companyCountdowns.forEach((countdown, tableNumber) => {
                const elapsed = Math.floor((currentTime - countdown.startTime) / 1000);
                const remainingTime = Math.max(0, countdown.initialDuration - elapsed);

                if (status === 'active' && remainingTime > 0) {
                    result.push({
                        tableNumber: countdown.tableNumber,
                        remainingTime: remainingTime,
                        initialDuration: countdown.initialDuration,
                        destinations: countdown.destinations,
                        startedAt: new Date(countdown.startTime).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
                        startTime: countdown.startTime,
                        endsAt: countdown.startTime + (countdown.initialDuration * 1000),
                        status: remainingTime > 0 ? 'active' : 'finished'
                    });
                }
            });
        }

        res.json({
            success: true,
            countdowns: result,
            count: result.length,
            timestamp: currentTime
        });

    } catch (error) {
        console.error('❌ Errore API countdowns:', error);
        res.status(500).json({
            success: false,
            error: 'Errore nel recupero dei countdown',
            details: error.message
        });
    }
});

// Store per le room delle aziende
const companyRooms = new Map();

// Store per i countdown attivi per ogni azienda
const activeCountdowns = new Map();

// Mappa per sessioni autenticate
const authenticatedSessions = new Map();

// Rate limiting per prevenire spam
const rateLimiter = new Map();

// Funzione per validare il nome dell'azienda
function isValidCompanyName(companyName) {
    if (!companyName || typeof companyName !== 'string') return false;
    if (companyName.length < 2 || companyName.length > 50) return false;
    // Solo caratteri alfanumerici, spazi e alcuni caratteri speciali
    return /^[a-zA-Z0-9\s\-_àáâãäåçèéêëìíîïðñòóôõöùúûüýÿ]+$/i.test(companyName);
}

// Funzione per validare il numero del tavolo
function isValidTableNumber(tableNumber) {
    const num = parseInt(tableNumber);
    return !isNaN(num) && num > 0 && num <= 999;
}

// Funzione per validare il tempo
function isValidTime(timeRemaining) {
    const time = parseInt(timeRemaining);
    return !isNaN(time) && time > 0 && time <= 7200; // Max 2 ore
}

// Funzione per il rate limiting
function checkRateLimit(clientId) {
    const now = Date.now();
    const limit = rateLimiter.get(clientId) || { count: 0, resetTime: now + 60000 };

    if (now > limit.resetTime) {
        limit.count = 1;
        limit.resetTime = now + 60000;
    } else {
        limit.count++;
    }

    rateLimiter.set(clientId, limit);
    return limit.count <= 10; // Max 10 richieste per minuto
}

// Gestisci le connessioni WebSocket
wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log(`🔗 Nuova connessione WebSocket da IP: ${clientIp}`);

    // Verifica modalità manutenzione
    if (MAINTENANCE_MODE) {
        console.log('🚫 Connessione WebSocket rifiutata - modalità manutenzione attiva');
        ws.send(JSON.stringify({
            action: 'maintenanceMode',
            message: 'Sistema in manutenzione. Connessioni temporaneamente disabilitate.',
            redirectTo: '/maintenance.html'
        }));
        ws.close(1001, 'Sistema in manutenzione');
        return;
    }

    ws.companyRoom = null; // Inizialmente non assegnato a nessuna room
    ws.pageType = null; // Tipo di pagina (cucina, pizzeria, insalata)
    ws.lastPing = Date.now();
    ws.lastPong = Date.now();
    ws.isAlive = true;
    ws.clientIp = clientIp;
    // [SECURITY] Authentication state — false until a valid session token is verified via joinRoom
    ws.isAuthenticated = false;
    ws.authenticatedUid = null;

    // Rate limiting per prevenire spam
    ws.messageCount = 0;
    ws.lastMessageTime = Date.now();

    // Invia un ping iniziale per testare la connessione
    setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
                action: 'connectionConfirmed', 
                timestamp: Date.now(),
                message: 'Connessione WebSocket stabilita con successo'
            }));
            ws.send(JSON.stringify({ action: 'ping', timestamp: Date.now() }));
        }
    }, 500);

    ws.on('message', (message) => {
            try {
                // Validazione messaggio base
                if (!message || message.length === 0) {
                    console.log('⚠️ Messaggio vuoto ignorato');
                    return;
                }

                let data;
                try {
                    data = JSON.parse(message);
                } catch (parseError) {
                    console.error('❌ Errore parsing JSON:', parseError.message);
                    return;
                }

                // Rate limiting più rigoroso: max 5 messaggi per 2 secondi
                // Escludi messaggi WebRTC (possono arrivare molto rapidamente durante handshake)
                const isVoiceMessage = data.action && (
                    data.action === 'ice-candidate' || 
                    data.action === 'offer' || 
                    data.action === 'answer' ||
                    data.action === 'voice_join' ||
                    data.action === 'voice_leave'
                );
                
                const now = Date.now();
                if (!isVoiceMessage && now - ws.lastMessageTime < 400) { // 400ms tra messaggi
                    ws.messageCount++;
                    if (ws.messageCount > 5) {
                        console.log('⚠️ Rate limit superato, messaggio scartato');
                        return;
                    }
                } else {
                    ws.messageCount = 0;
                    ws.lastMessageTime = now;
                }

                if (!data || typeof data !== 'object') {
                    console.log('⚠️ Dati messaggio non validi');
                    return;
                }

                console.log('📨 Messaggio ricevuto:', data);

            // Validazione dati rigorosa
            if (!data.action) {
                console.log('⚠️ Messaggio senza action ignorato');
                return;
            }

            // Gestisci ping/pong per heartbeat
            if (data.action === 'ping') {
                ws.lastPing = Date.now();
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ action: 'pong', timestamp: ws.lastPing }));
                }
                return;
            }

            if (data.action === 'pong') {
                // Pong ricevuto, connessione attiva
                ws.lastPong = Date.now();
                return;
            }

            // [SECURITY] Block all actions except ping/pong/joinRoom for unauthenticated clients.
            // A client must complete joinRoom with a valid server-signed session token first.
            const PUBLIC_ACTIONS = ['ping', 'pong', 'joinRoom'];
            if (!PUBLIC_ACTIONS.includes(data.action) && !ws.isAuthenticated) {
                console.log(`⛔ [SECURITY] Action "${data.action}" blocked — client not authenticated (IP: ${ws.clientIp})`);
                ws.send(JSON.stringify({
                    action: 'error',
                    code: 'UNAUTHENTICATED',
                    message: 'Authentication required. Please log in again.'
                }));
                return;
            }

            if (data.action === 'joinRoom') {
                // [SECURITY] Require a server-signed session token — reject bare companyName claims.
                // The company is ALWAYS extracted from the verified token, never from data.companyName.
                if (!data.token || typeof data.token !== 'string') {
                    console.log(`⛔ [SECURITY] joinRoom rejected — no session token (IP: ${ws.clientIp})`);
                    ws.send(JSON.stringify({
                        action: 'error',
                        code: 'TOKEN_REQUIRED',
                        message: 'Session token required. Please log in again.'
                    }));
                    return;
                }

                // [SECURITY] Verify HMAC signature and expiry of the session token
                const session = verifySessionToken(data.token);
                if (!session) {
                    console.log(`⛔ [SECURITY] joinRoom rejected — invalid or expired token (IP: ${ws.clientIp})`);
                    ws.send(JSON.stringify({
                        action: 'error',
                        code: 'TOKEN_INVALID',
                        message: 'Session token invalid or expired. Please log in again.'
                    }));
                    return;
                }

                // [SECURITY] Company comes from the verified token — the client cannot forge this
                const companyName = session.companyName;
                ws.isAuthenticated = true;
                ws.authenticatedUid = session.uid;
                console.log(`🔑 [SECURITY] joinRoom authenticated: uid=${session.uid}, company="${companyName}" (IP: ${ws.clientIp})`);

                // Rimuovi il client dalla room precedente se esistente
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const oldRoom = companyRooms.get(ws.companyRoom);
                    oldRoom.delete(ws);
                    if (oldRoom.size === 0) {
                        companyRooms.delete(ws.companyRoom);
                    }
                }

                // Aggiungi il client alla nuova room
                ws.companyRoom = companyName;
                if (!companyRooms.has(companyName)) {
                    companyRooms.set(companyName, new Set());
                }
                companyRooms.get(companyName).add(ws);

                console.log(`✅ Client aggiunto alla room: ${companyName} (${companyRooms.get(companyName).size} client)`);

                // Invia tutti i countdown attivi al nuovo client (Soluzione 1 - con destinazioni multiple)
                if (activeCountdowns.has(companyName)) {
                    const companyCountdowns = activeCountdowns.get(companyName);
                    const countdownsToDelete = [];

                    companyCountdowns.forEach((countdown, tableNumber) => {
                        // Calcola il tempo rimanente attuale
                        const currentTime = Date.now();
                        const elapsed = Math.floor((currentTime - countdown.startTime) / 1000);
                        const remainingTime = Math.max(0, countdown.initialDuration - elapsed);

                        if (remainingTime > 0) {
                            // Invia un countdown per ogni destinazione
                            countdown.destinations.forEach(destination => {
                                const syncMessage = {
                                    action: 'startCountdown',
                                    tableNumber: tableNumber,
                                    timeRemaining: remainingTime,
                                    destination: destination
                                };
                                ws.send(JSON.stringify(syncMessage));
                                console.log(`📡 Countdown sincronizzato inviato: Tavolo ${tableNumber}, Destinazione: ${destination}, ${Math.floor(remainingTime/60)}:${(remainingTime%60).toString().padStart(2, '0')}`);
                            });
                        } else {
                            // Marca per eliminazione i countdown scaduti
                            countdownsToDelete.push(tableNumber);
                        }
                    });

                    // Rimuovi countdown scaduti dalla memoria
                    countdownsToDelete.forEach(tableNumber => {
                        companyCountdowns.delete(tableNumber);
                        console.log(`🗑️ Countdown scaduto rimosso durante sincronizzazione: Tavolo ${tableNumber}`);
                    });
                }

            } else if (data.action === 'joinPage') {
                // Gestisce l'ingresso in una specifica pagina (department ID)
                if (!data.pageType || typeof data.pageType !== 'string' || !data.pageType.trim()) {
                    console.log('⚠️ Tipo pagina non valido');
                    return;
                }
                // Any non-empty string is accepted — department IDs are dynamic per company.
                // Security is already enforced: connection is authenticated and company-scoped.
                ws.pageType = data.pageType;

                // Conta quanti utenti sono attualmente sulla stessa pagina
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const samePageClients = Array.from(roomClients).filter(client => 
                        client.pageType === data.pageType && client !== ws
                    );

                    console.log(`📄 Client entrato in pagina ${data.pageType}: ${samePageClients.length} altri utenti già presenti`);

                    // Sincronizza countdown specifici per la pagina (Soluzione 1 - filtro per destinazioni)
                    if (ws.companyRoom && activeCountdowns.has(ws.companyRoom)) {
                        const companyCountdowns = activeCountdowns.get(ws.companyRoom);
                        const countdownsToDelete = [];
                        let syncedCount = 0;

                        companyCountdowns.forEach((countdown, tableNumber) => {
                            // Filtra countdown che includono la destinazione della pagina corrente
                            if (countdown.destinations.includes(data.pageType)) {
                                const currentTime = Date.now();
                                const elapsed = Math.floor((currentTime - countdown.startTime) / 1000);
                                const remainingTime = Math.max(0, countdown.initialDuration - elapsed);

                                if (remainingTime > 0) {
                                    const syncMessage = {
                                        action: 'startCountdown',
                                        tableNumber: tableNumber,
                                        timeRemaining: remainingTime,
                                        destination: data.pageType
                                    };
                                    ws.send(JSON.stringify(syncMessage));
                                    syncedCount++;
                                    console.log(`📡 Countdown ${data.pageType}-specifico inviato: Tavolo ${tableNumber}, ${Math.floor(remainingTime/60)}:${(remainingTime%60).toString().padStart(2, '0')}`);
                                } else {
                                    countdownsToDelete.push(tableNumber);
                                }
                            }
                        });

                        // Rimuovi countdown scaduti
                        countdownsToDelete.forEach(tableNumber => {
                            companyCountdowns.delete(tableNumber);
                            console.log(`🗑️ Countdown scaduto rimosso per ${data.pageType}: Tavolo ${tableNumber}`);
                        });

                        console.log(`📊 Sincronizzazione ${data.pageType}: ${syncedCount} countdown inviati, ${countdownsToDelete.length} scaduti rimossi`);
                    }

                    // Se ci sono altri utenti sulla stessa pagina, invia un avviso
                    if (samePageClients.length > 0) {
                        const warningMessage = {
                            action: 'pageOccupied',
                            pageType: data.pageType,
                            otherUsersCount: samePageClients.length,
                            message: `⚠️ Attenzione: ${samePageClients.length} altro/i utente/i sta/stanno già utilizzando la pagina ${data.pageType.toUpperCase()}`
                        };

                        ws.send(JSON.stringify(warningMessage));

                        // Informa anche gli altri utenti che qualcuno si è collegato
                        const newUserMessage = {
                            action: 'newUserJoined',
                            pageType: data.pageType,
                            totalUsers: samePageClients.length + 1,
                            message: `👥 Un nuovo utente si è collegato alla pagina ${data.pageType.toUpperCase()} (${samePageClients.length + 1} utenti totali)`
                        };

                        samePageClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify(newUserMessage));
                            }
                        });
                    }
                }

            } else if (data.action === 'startCountdown') {
                // Validazione dati countdown
                if (!data.tableNumber || !data.timeRemaining) {
                    console.log('⚠️ Dati countdown non validi');
                    return;
                }

                if (typeof data.tableNumber !== 'string' && typeof data.tableNumber !== 'number') {
                    console.log('⚠️ Numero tavolo non valido');
                    return;
                }

                if (typeof data.timeRemaining !== 'number' || data.timeRemaining <= 0) {
                    console.log('⚠️ Tempo rimanente non valido');
                    return;
                }

                // Validate destination against this company's active departments
                const destination = data.destination;
                if (!destination || typeof destination !== 'string') {
                    console.log('⚠️ Destinazione mancante');
                    return;
                }
                const companyDepts = getCompanyDepts(ws.companyRoom);
                const activeDeptIds = companyDepts.filter(d => d.active).map(d => d.id);
                if (activeDeptIds.length > 0 && !activeDeptIds.includes(destination)) {
                    console.log(`⚠️ Destinazione "${destination}" non è un reparto valido per "${ws.companyRoom}"`);
                    ws.send(JSON.stringify({ action: 'error', message: 'Destination department not found.' }));
                    return;
                }
                // Mark this department as used so it cannot be deleted later
                const deptIdx = (departmentsStore[ws.companyRoom] || []).findIndex(d => d.id === destination);
                if (deptIdx !== -1 && !departmentsStore[ws.companyRoom][deptIdx].usedInCountdowns) {
                    departmentsStore[ws.companyRoom][deptIdx].usedInCountdowns = true;
                    saveJSON(DEPARTMENTS_FILE, departmentsStore);
                }

                // Memorizza il countdown attivo con logica unificata (Soluzione 1)
                if (ws.companyRoom) {
                    if (!activeCountdowns.has(ws.companyRoom)) {
                        activeCountdowns.set(ws.companyRoom, new Map());
                    }

                    const companyCountdowns = activeCountdowns.get(ws.companyRoom);
                    const tableKey = data.tableNumber.toString(); // Chiave semplice: solo numero tavolo
                    
                    // Verifica se esiste già un countdown per questo tavolo
                    if (companyCountdowns.has(tableKey)) {
                        const existingCountdown = companyCountdowns.get(tableKey);
                        
                        // Aggiungi la destinazione se non è già presente
                        if (!existingCountdown.destinations.includes(destination)) {
                            existingCountdown.destinations.push(destination);
                            console.log(`📝 Aggiunta destinazione "${destination}" al tavolo ${data.tableNumber} esistente. Destinazioni: [${existingCountdown.destinations.join(', ')}]`);
                        } else {
                            console.log(`⚠️ Destinazione "${destination}" già presente per tavolo ${data.tableNumber}, aggiornato il countdown`);
                        }
                        
                        // Aggiorna il tempo con il nuovo countdown (l'ultimo ricevuto)
                        existingCountdown.startTime = Date.now();
                        existingCountdown.initialDuration = data.timeRemaining;
                    } else {
                        // Crea nuovo countdown con array di destinazioni
                        companyCountdowns.set(tableKey, {
                            startTime: Date.now(),
                            initialDuration: data.timeRemaining,
                            tableNumber: data.tableNumber,
                            destinations: [destination] // Array di destinazioni
                        });
                        console.log(`💾 Nuovo countdown creato per tavolo ${data.tableNumber} con destinazione: [${destination}]`);
                    }

                    console.log(`💾 Countdown memorizzato per azienda "${ws.companyRoom}": Tavolo ${data.tableNumber}, Destinazioni totali: [${companyCountdowns.get(tableKey).destinations.join(', ')}]`);
                }

                // Invia solo ai client della stessa room/azienda
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const messageToSend = JSON.stringify({
                        ...data,
                        destination: destination
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(messageToSend);
                            sentCount++;
                        }
                    });

                    console.log(`📡 Countdown inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): Tavolo ${data.tableNumber}, Destinazione: ${destination}, ${Math.floor(data.timeRemaining/60)}:${(data.timeRemaining%60).toString().padStart(2, '0')}`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room');
                }

            } else if (data.action === 'deleteCountdown') {
                // Validazione dati eliminazione
                if (!data.tableNumber) {
                    console.log('⚠️ Numero tavolo mancante per eliminazione');
                    return;
                }

                // Rimuovi countdown dalla memoria del server (Soluzione 1 - chiave unificata)
                if (ws.companyRoom && activeCountdowns.has(ws.companyRoom)) {
                    const companyCountdowns = activeCountdowns.get(ws.companyRoom);
                    const tableKey = data.tableNumber.toString();
                    
                    if (companyCountdowns.has(tableKey)) {
                        const removedCountdown = companyCountdowns.get(tableKey);
                        companyCountdowns.delete(tableKey);
                        
                        console.log(`🗑️ Countdown tavolo ${data.tableNumber} rimosso dalla memoria server`);
                        console.log(`📋 Destinazioni eliminate: [${removedCountdown.destinations.join(', ')}]`);
                        console.log(`📊 Countdown rimanenti per azienda "${ws.companyRoom}": ${companyCountdowns.size}`);
                    } else {
                        console.log(`⚠️ Nessun countdown trovato per tavolo ${data.tableNumber} nella memoria server`);
                    }
                }

                // Invia eliminazione a tutti i client della room (incluso chi ha eliminato per conferma)
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const deleteMessage = JSON.stringify(data);

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(deleteMessage);
                            sentCount++;
                        }
                    });

                    console.log(`🗑️ Eliminazione inviata alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): Tavolo ${data.tableNumber}`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per eliminazione');
                }

            } else if (data.action === 'voiceMessage') {
                // Validazione messaggio vocale
                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio vocale mancante');
                    return;
                }

                // Accept destinations[] array or legacy single destination string
                const vmDestList = (Array.isArray(data.destinations) && data.destinations.length > 0)
                    ? data.destinations
                    : (data.destination ? [data.destination] : []);

                if (vmDestList.length === 0) {
                    console.log('⚠️ Destinazione messaggio vocale mancante');
                    return;
                }

                // [SECURITY] Validate every destination against company's active departments
                const vmCompanyDepts = getCompanyDepts(ws.companyRoom);
                const vmActiveDeptIds = vmCompanyDepts.filter(d => d.active).map(d => d.id);
                if (vmActiveDeptIds.length > 0) {
                    for (const destId of vmDestList) {
                        if (!vmActiveDeptIds.includes(destId)) {
                            console.log(`⛔ [SECURITY] voiceMessage rejected — invalid destination "${destId}" for "${ws.companyRoom}"`);
                            ws.send(JSON.stringify({ action: 'error', message: 'Destination department not found.' }));
                            return;
                        }
                    }
                }

                // sourceDepartmentId comes from the authenticated ws.pageType — never trust client's from field for routing
                const vmSourceDeptId = ws.pageType || data.from || '';

                // Invia messaggio vocale a tutti i client della room (filtro lato client per destinazione)
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const voiceMessage = JSON.stringify({
                        action: 'voiceMessage',
                        message: data.message || 'Messaggio vocale',
                        messageId: data.messageId,
                        timestamp: new Date().toLocaleTimeString('it-IT'),
                        from: vmSourceDeptId,
                        sourceDepartmentId: vmSourceDeptId,
                        destinations: vmDestList,
                        destination: vmDestList[0],
                        audioData: data.audioData || null,
                        hasAudio: data.hasAudio || false
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(voiceMessage);
                            sentCount++;
                        }
                    });

                    console.log(`📢 Messaggio vocale inviato alla room "${ws.companyRoom}" per [${vmDestList.join(', ')}] (${sentCount}/${roomClients.size} client)`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per messaggio vocale');
                }

            } else if (data.action === 'deleteVoiceMessage') {
                // Validazione eliminazione messaggio vocale
                if (!data.messageId) {
                    console.log('⚠️ ID messaggio vocale mancante per eliminazione');
                    return;
                }

                // Invia eliminazione messaggio vocale a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const deleteMessage = JSON.stringify({
                        action: 'deleteVoiceMessage',
                        messageId: data.messageId
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(deleteMessage);
                            sentCount++;
                        }
                    });

                    console.log(`🗑️ Eliminazione messaggio vocale inviata alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): ID ${data.messageId}`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per eliminazione messaggio vocale');
                }

            } else if (data.action === 'pausaCucina') {
                // Validazione richiesta pausa cucina
                if (!data.durataMinuti || typeof data.durataMinuti !== 'number') {
                    console.log('⚠️ Durata pausa non valida');
                    return;
                }

                if (data.durataMinuti < 1 || data.durataMinuti > 30) {
                    console.log('⚠️ Durata pausa fuori range (1-30 minuti)');
                    return;
                }

                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio pausa mancante');
                    return;
                }

                // Invia messaggio di pausa a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const pausaMessage = JSON.stringify({
                        action: 'pausaCucina',
                        messageId: data.messageId,
                        durataMinuti: data.durataMinuti,
                        from: data.from || 'Pizzeria',
                        timestamp: data.timestamp || new Date().toLocaleTimeString('it-IT')
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(pausaMessage);
                            sentCount++;
                        }
                    });

                    console.log(`⏸️ Messaggio pausa cucina inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): ${data.durataMinuti} minuti`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per pausa cucina');
                }

            } else if (data.action === 'annullaPausaCucina') {
                // Validazione richiesta annullamento pausa cucina
                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio annullamento pausa mancante');
                    return;
                }

                // Invia messaggio di annullamento pausa a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const annullaPausaMessage = JSON.stringify({
                        action: 'annullaPausaCucina',
                        messageId: data.messageId,
                        from: data.from || 'Pizzeria',
                        timestamp: data.timestamp || new Date().toLocaleTimeString('it-IT')
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(annullaPausaMessage);
                            sentCount++;
                        }
                    });

                    console.log(`❌ Messaggio annullamento pausa cucina inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client)`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per annullamento pausa cucina');
                }

            } else if (data.action === 'pausaInsalata') {
                // Validazione richiesta pausa insalata
                if (!data.durataMinuti || typeof data.durataMinuti !== 'number') {
                    console.log('⚠️ Durata pausa insalata non valida');
                    return;
                }

                if (data.durataMinuti < 1 || data.durataMinuti > 30) {
                    console.log('⚠️ Durata pausa insalata fuori range (1-30 minuti)');
                    return;
                }

                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio pausa insalata mancante');
                    return;
                }

                // Invia messaggio di pausa insalata a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const pausaMessage = JSON.stringify({
                        action: 'pausaInsalata',
                        messageId: data.messageId,
                        durataMinuti: data.durataMinuti,
                        from: data.from || 'Insalata',
                        timestamp: data.timestamp || new Date().toLocaleTimeString('it-IT')
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(pausaMessage);
                            sentCount++;
                        }
                    });

                    console.log(`⏸️ Messaggio pausa insalata inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): ${data.durataMinuti} minuti`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per pausa insalata');
                }

            } else if (data.action === 'annullaPausaInsalata') {
                // Validazione richiesta annullamento pausa insalata
                if (!data.messageId || typeof data.messageId !== 'string') {
                    console.log('⚠️ ID messaggio annullamento pausa insalata mancante');
                    return;
                }

                // Invia messaggio di annullamento pausa insalata a tutti i client della room
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const annullaPausaMessage = JSON.stringify({
                        action: 'annullaPausaInsalata',
                        messageId: data.messageId,
                        from: data.from || 'Insalata',
                        timestamp: data.timestamp || new Date().toLocaleTimeString('it-IT')
                    });

                    let sentCount = 0;
                    roomClients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(annullaPausaMessage);
                            sentCount++;
                        }
                    });

                    console.log(`❌ Messaggio annullamento pausa insalata inviato alla room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client)`);
                } else {
                    console.log('⚠️ Client non assegnato a nessuna room per annullamento pausa insalata');
                }
            } else if (data.action === 'joinVoice') {
                // WebRTC Voice Call: Join voice room
                if (!data.room || !data.peerId) {
                    console.log('⚠️ Room o peerId mancante per joinVoice');
                    return;
                }

                // Normalizza anche la voice room per case-insensitive matching
                ws.voiceRoom = data.room.toLowerCase();
                ws.voicePeerId = data.peerId;

                console.log(`🎙️ [VOICE] Peer ${data.peerId} entrato nella room vocale: ${data.room} (normalizzato: ${ws.voiceRoom})`);

                // Invia la lista dei peer esistenti al nuovo peer
                if (companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const existingPeers = [];

                    roomClients.forEach((client) => {
                        if (client !== ws && client.voicePeerId && client.voiceRoom === ws.voiceRoom) {
                            existingPeers.push(client.voicePeerId);
                        }
                    });

                    // Invia ai nuovi peer la lista dei peer esistenti
                    ws.send(JSON.stringify({
                        action: 'voicePeers',
                        peers: existingPeers
                    }));

                    // Notifica gli altri peer del nuovo arrivo
                    roomClients.forEach((client) => {
                        if (client !== ws && client.voiceRoom === data.room && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                action: 'voicePeerJoined',
                                peerId: data.peerId
                            }));
                        }
                    });

                    console.log(`🎙️ [VOICE] Peer ${data.peerId} sincronizzato con ${existingPeers.length} peer esistenti`);
                }
            } else if (data.action === 'offer') {
                // WebRTC Voice Call: Forward offer
                if (!data.to || !data.from || !data.sdp) {
                    console.log('⚠️ Dati offer incompleti');
                    return;
                }

                console.log(`🎙️ [VOICE] Forwarding offer da ${data.from} a ${data.to}`);

                // Trova il destinatario e invia l'offer
                if (companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    roomClients.forEach((client) => {
                        if (client.voicePeerId === data.to && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                action: 'offer',
                                from: data.from,
                                sdp: data.sdp
                            }));
                        }
                    });
                }
            } else if (data.action === 'answer') {
                // WebRTC Voice Call: Forward answer
                if (!data.to || !data.from || !data.sdp) {
                    console.log('⚠️ Dati answer incompleti');
                    return;
                }

                console.log(`🎙️ [VOICE] Forwarding answer da ${data.from} a ${data.to}`);

                // Trova il destinatario e invia l'answer
                if (companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    roomClients.forEach((client) => {
                        if (client.voicePeerId === data.to && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                action: 'answer',
                                from: data.from,
                                sdp: data.sdp
                            }));
                        }
                    });
                }
            } else if (data.action === 'ice-candidate') {
                // WebRTC Voice Call: Forward ICE candidate
                if (!data.to || !data.from || !data.candidate) {
                    console.log('⚠️ Dati ICE candidate incompleti');
                    return;
                }

                // Trova il destinatario e invia il candidato
                if (companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    roomClients.forEach((client) => {
                        if (client.voicePeerId === data.to && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                action: 'ice-candidate',
                                from: data.from,
                                candidate: data.candidate
                            }));
                        }
                    });
                }
            } else if (data.action === 'leaveVoice') {
                // WebRTC Voice Call: Leave voice room
                if (!data.peerId) {
                    console.log('⚠️ PeerId mancante per leaveVoice');
                    return;
                }

                console.log(`🎙️ [VOICE] Peer ${data.peerId} lascia la room vocale`);

                // Notifica gli altri peer
                if (companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    roomClients.forEach((client) => {
                        if (client !== ws && client.voiceRoom === ws.voiceRoom && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                action: 'voicePeerLeft',
                                peerId: data.peerId
                            }));
                        }
                    });
                }

                ws.voiceRoom = null;
                ws.voicePeerId = null;
            } else if (data.action === 'mute' || data.action === 'unmute') {
                // WebRTC Voice Call: Mute/Unmute status
                if (!data.peerId) {
                    console.log('⚠️ PeerId mancante per mute/unmute');
                    return;
                }

                console.log(`🎙️ [VOICE] Peer ${data.peerId} ${data.action === 'mute' ? 'muted' : 'unmuted'}`);

                // Notifica gli altri peer dello stato mute
                if (companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    roomClients.forEach((client) => {
                        if (client !== ws && client.voiceRoom === ws.voiceRoom && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                action: data.action,
                                peerId: data.peerId
                            }));
                        }
                    });
                }
            }
        } catch (error) {
            console.error('❌ Errore nel parsing del messaggio:', error);
        }
    });

    ws.on('close', (code, reason) => {
            try {
                // Notifica gli altri utenti se qualcuno lascia la stessa pagina
                if (ws.companyRoom && ws.pageType && companyRooms.has(ws.companyRoom)) {
                    const room = companyRooms.get(ws.companyRoom);
                    const samePageClients = Array.from(room).filter(client => 
                        client.pageType === ws.pageType && client !== ws && client.readyState === WebSocket.OPEN
                    );

                    if (samePageClients.length > 0) {
                        const userLeftMessage = {
                            action: 'userLeft',
                            pageType: ws.pageType,
                            remainingUsers: samePageClients.length,
                            message: `Un utente ha lasciato la pagina ${ws.pageType.toUpperCase()} (${samePageClients.length} utente${samePageClients.length !== 1 ? 'i' : ''} rimanente${samePageClients.length !== 1 ? 'i' : ''})`
                        };

                        samePageClients.forEach(client => {
                            client.send(JSON.stringify(userLeftMessage));
                        });

                        console.log(`👋 Notificato ${samePageClients.length} utenti dell'uscita dalla pagina ${ws.pageType}`);
                    }
                }

                // Rimuovi il client dalla room quando si disconnette
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const room = companyRooms.get(ws.companyRoom);
                    if (room) {
                        room.delete(ws);
                        if (room.size === 0) {
                            companyRooms.delete(ws.companyRoom);
                            console.log(`🗑️ Room "${ws.companyRoom}" eliminata (vuota)`);
                        } else {
                            console.log(`👋 Client disconnesso dalla room "${ws.companyRoom}" (${room.size} client rimanenti)`);
                        }
                    }
                }

                // Cleanup delle risorse del client
                ws.companyRoom = null;
                ws.pageType = null;
                ws.isAlive = false;

                console.log(`🔌 Connessione WebSocket chiusa - Code: ${code}, Reason: ${reason || 'Non specificato'}`);
            } catch (closeError) {
                console.error('❌ Errore durante cleanup connessione:', closeError.message);
            }
        });

        ws.on('error', (error) => {
            console.error('❌ Errore WebSocket:', error.message || error);

            // Cleanup in caso di errore
            try {
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const room = companyRooms.get(ws.companyRoom);
                    if (room) {
                        room.delete(ws);
                        if (room.size === 0) {
                            companyRooms.delete(ws.companyRoom);
                        }
                    }
                }
                ws.isAlive = false;
            } catch (cleanupError) {
                console.error('❌ Errore cleanup dopo errore WebSocket:', cleanupError.message);
            }
        });
    });

// Heartbeat ottimizzato - meno frequente per ridurre carico
setInterval(() => {
    const now = Date.now();
    let activeClients = 0;

    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            // Solo se non ha fatto pong negli ultimi 45 secondi
            if (now - ws.lastPong > 45000) {
                ws.send(JSON.stringify({ action: 'ping', timestamp: now }));
                ws.lastPing = now;
            }
            activeClients++;
        }
    });

    if (activeClients > 0) {
        console.log(`💓 Heartbeat per ${activeClients} client attivi`);
    }
}, 30000); // Ogni 30 secondi

// Pulizia periodica ottimizzata - più frequente per evitare accumulo
setInterval(() => {
    const now = Date.now();

    // Pulisci connessioni WebSocket morte (nessun pong per più di 60 secondi)
    let deadConnections = 0;
    wss.clients.forEach((ws) => {
        if (now - ws.lastPong > 60000) { // 60 secondi senza pong
            console.log(`🗑️ Connessione morta rilevata, terminazione...`);
            ws.terminate();
            deadConnections++;
        }
    });

    // Pulisci rate limiter scaduti
    for (const [clientId, limit] of rateLimiter.entries()) {
        if (now > limit.resetTime + 120000) { // 2 minuti di grazia
            rateLimiter.delete(clientId);
        }
    }

    // Pulisci countdown scaduti (Soluzione 1 - con destinazioni multiple)
    let totalActiveCountdowns = 0;
    activeCountdowns.forEach((companyCountdowns, companyName) => {
        companyCountdowns.forEach((countdown, tableNumber) => {
            const elapsed = Math.floor((now - countdown.startTime) / 1000);
            const remainingTime = countdown.initialDuration - elapsed;

            if (remainingTime <= -30) { // 30 secondi dopo la scadenza
                companyCountdowns.delete(tableNumber);
                console.log(`🗑️ Countdown scaduto rimosso: Azienda "${companyName}", Tavolo ${tableNumber}, Destinazioni: [${countdown.destinations.join(', ')}]`);
            } else {
                totalActiveCountdowns++;
            }
        });

        if (companyCountdowns.size === 0) {
            activeCountdowns.delete(companyName);
        }
    });

    if (deadConnections > 0 || totalActiveCountdowns > 20) {
        console.log(`🧹 Cleanup: ${deadConnections} conn. morte, ${rateLimiter.size} rate limits, ${totalActiveCountdowns} countdown, ${wss.clients.size} client`);
    }
}, 60000); // Ogni 1 minuto

// Gestione errori globali per prevenire crash
process.on('uncaughtException', (error) => {
    console.error('❌ Errore non gestito:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rifiutata non gestita:', reason);
});

// Monitoraggio carico ogni 5 minuti
setInterval(() => {
    const stats = {
        clients: wss.clients.size,
        rooms: companyRooms.size,
        countdowns: Array.from(activeCountdowns.values()).reduce((sum, map) => sum + map.size, 0),
        rateLimits: rateLimiter.size,
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    };

    console.log(`📊 Stats: ${stats.clients} client, ${stats.rooms} rooms, ${stats.countdowns} countdown, ${stats.memoryUsage}MB RAM`);

    // Alert se troppo carico
    if (stats.clients > 50 || stats.memoryUsage > 100) {
        console.warn(`⚠️ SOVRACCARICO: ${stats.clients} client, ${stats.memoryUsage}MB RAM`);
    }
}, 300000); // Ogni 5 minuti


// Avvia il server (unica versione corretta per Railway)
const PORT = process.env.PORT || 3000;

server
  .listen(PORT, '0.0.0.0', () => {
    console.log(`🛡️ Server avviato su http://0.0.0.0:${PORT}`);
    console.log('✅ Autenticazione WebSocket attiva');
    console.log('✅ Validazione dati attiva');
    console.log('✅ Rate limiting ottimizzato');
  })
  .on('error', (error) => {
    console.error('❌ Errore avvio server:', error);
  });
