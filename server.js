const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const speech = require('@google-cloud/speech');
const { initializeApp: adminInitializeApp, getApps: adminGetApps, cert: adminCert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

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

// ===== Persistent Storage: Firestore Admin =====
// ONLY FIREBASE_ADMIN_SERVICE_ACCOUNT is used for Firestore — it must be a service-account
// JSON key for Firebase project app-dati-tavoli (Firebase Console → Project Settings →
// Service Accounts → Generate new private key).
//
// GOOGLE_APPLICATION_CREDENTIALS_JSON belongs to GCP project feisty-coder-461119-r0
// (Google Cloud Speech only) and is NEVER used here. The two credentials are completely
// separate and must never be mixed.
let db = null;
const STORE_COLLECTION = 'platetimer_stores';
(function initFirestoreAdmin() {
    // ── Step 1: require the dedicated Firestore credential ───────────────────
    const raw = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
    if (!raw) {
        console.warn('⚠️ [STORE] FIREBASE_ADMIN_SERVICE_ACCOUNT non impostato — Firestore non disponibile.');
        console.warn('⚠️ [STORE] I dati saranno ephemeral su Railway.');
        console.warn('⚠️ [STORE] Per la persistenza: Firebase Console → app-dati-tavoli →');
        console.warn('⚠️ [STORE]   Project Settings → Service Accounts → Genera nuova chiave privata.');
        return; // db stays null → local-file fallback in initializeDataStores()
    }

    // ── Step 2: parse JSON safely ────────────────────────────────────────────
    let svcAccount;
    try {
        svcAccount = JSON.parse(raw);
    } catch (e) {
        console.error('❌ [STORE] FIREBASE_ADMIN_SERVICE_ACCOUNT contiene JSON non valido:', e.message);
        console.error('❌ [STORE] Firestore non inizializzato — verificare il valore del secret.');
        return;
    }

    // ── Step 3: verify the credential belongs to app-dati-tavoli ────────────
    const credProjectId = svcAccount.project_id;
    if (credProjectId !== FIREBASE_PROJECT_ID) {
        console.error(`❌ [STORE] FIREBASE_ADMIN_SERVICE_ACCOUNT appartiene al progetto "${credProjectId}", non a "${FIREBASE_PROJECT_ID}".`);
        console.error(`❌ [STORE] Usare la chiave del progetto Firebase corretto (${FIREBASE_PROJECT_ID}).`);
        console.error('❌ [STORE] Nota: GOOGLE_APPLICATION_CREDENTIALS_JSON è riservato a Google Cloud Speech e non va usato qui.');
        console.error('❌ [STORE] Firestore non inizializzato.');
        return;
    }

    // ── Step 4: initialize Firestore Admin ───────────────────────────────────
    try {
        if (!adminGetApps().length) {
            adminInitializeApp({
                credential: adminCert(svcAccount),
                projectId: FIREBASE_PROJECT_ID
            });
        }
        db = getFirestore();
        db.settings({ ignoreUndefinedProperties: true });
        console.log(`✅ [STORE] Firestore Admin connected (project: ${FIREBASE_PROJECT_ID})`);
    } catch (e) {
        console.error('❌ [STORE] Firebase Admin init error:', e.message);
        db = null;
    }
})();

// ===== Department Storage =====
// DATA_DIR can be overridden via env var.
// On Railway: add a Volume mounted at /data and set DATA_DIR=/data — files will
// survive every deployment with zero extra dependencies.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DEPARTMENTS_FILE = path.join(DATA_DIR, 'departments.json');
const PLANS_FILE = path.join(DATA_DIR, 'plans.json');
const DEPARTMENT_ACCOUNTS_FILE = path.join(DATA_DIR, 'department-accounts.json');
const PLAN_LIMITS = { base: 3, medium: 5, premium: 10 };

function loadJSON(filePath) {
    try { if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (e) { console.error('Error loading', filePath, e.message); }
    return {};
}
function saveJSON(filePath, data) {
    if (db) {
        // Firestore is the single source of truth — never write local files when connected.
        // getStoreNameForFile is a hoisted function declaration; safe to call here even though
        // it is defined later in the file (all constants are set by request-time).
        try {
            const storeName = getStoreNameForFile(filePath);
            if (storeName) {
                db.collection(STORE_COLLECTION).doc(storeName)
                    .set({ store: data, updatedAt: Date.now() })
                    .catch(e => console.error(`❌ [FIRESTORE] save "${storeName}" fallito:`, e.message));
            }
        } catch (e) {
            console.error(`❌ [FIRESTORE] saveJSON errore sincrono per "${filePath}":`, e.message);
        }
    } else {
        // Firestore not configured (local dev / missing credential) — write to local file.
        // NOTE: local files are ephemeral on Railway; configure FIREBASE_ADMIN_SERVICE_ACCOUNT
        // for production persistence.
        try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); }
        catch (e) { console.error('❌ [STORE] Errore scrittura file locale', filePath, e.message); }
    }
}

// Stores start empty; initializeDataStores() populates them from Firestore
// (or local files in local-dev mode) BEFORE the HTTP server accepts connections.
let departmentsStore = {};
let plansStore = {};

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
app.use(express.json({ limit: '10mb' }));

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

// [S1.2] Resolve Department Account context for a verified uid+company pair.
// Called server-side only — uid must already be verified (Firebase REST or HMAC session).
// departmentType is read from the department record, NEVER from the account record.
// Returns a plain object with dept account fields (spread into session response),
// or an empty object {} when no Department Account is bound to this uid.
function resolveDeptAccountContext(uid, companyId) {
    // departmentAccounts is required later in the file but is always initialized
    // before any HTTP request reaches this function.
    const account = departmentAccounts.findDepartmentAccountByUid(uid);
    if (!account) return {};
    // Company isolation: account must belong to the verified company.
    // findDepartmentAccountByUid is global; discard if company mismatch.
    if (account.companyId !== companyId) return {};
    // Resolve departmentType from the department record (never from the account).
    const dept = getCompanyDepts(companyId).find(d => d.id === account.departmentId);
    const departmentType = departmentAccounts.getDepartmentType(dept || null);
    return {
        departmentAccountId:     account.id,
        departmentId:            account.departmentId,
        departmentType,          // STANDARD | CENTRAL — from department, not account
        departmentAccountStatus: account.status  // ACTIVE | SUSPENDED
    };
}

// [S1.4] Return the Department Account bound to this session's uid (same company),
// or null if the user is unbound. Callers use this to enforce department locking.
// Never trusts any client-supplied department/company value.
//
// [S2.1] Service login sessions use account.id ('depacct_…') as the token uid.
// Legacy Firebase sessions use the Firebase UID (stored in account.firebaseUid).
// Distinguish by the well-known 'depacct_' prefix so both paths coexist safely.
function getBoundDepartmentContext(session) {
    let account;
    if (session.uid && session.uid.startsWith('depacct_')) {
        // Service login session: uid IS the department account ID
        account = departmentAccounts.findDepartmentAccountById(session.uid);
    } else {
        // Legacy Firebase session: uid is the Firebase UID bound to an account
        account = departmentAccounts.findDepartmentAccountByUid(session.uid);
    }
    if (!account) return null;
    if (account.companyId !== session.companyName) return null; // company isolation
    return account; // { id, companyId, departmentId, status, … }
}

// [S1.4.1] Centralized structured error response for department access checks.
// Returns { status, body } — caller does res.status(e.status).json(e.body).
// All codes are stable strings for UI-layer branching (never parse the message).
function departmentAccessError(boundAcct) {
    if (boundAcct.status === 'SUSPENDED') {
        return { status: 403, body: { error: 'Account reparto sospeso.', code: 'ACCOUNT_SUSPENDED' } };
    }
    return { status: 403, body: { error: 'Account reparto non autorizzato a gestire i reparti.', code: 'ACCOUNT_NOT_AUTHORIZED' } };
}

// [S1.5] WebSocket delivery filter for Department Account locking.
// Returns true if the given socket should receive a message with the given destinations array.
// Bound sockets (Department Accounts) only receive messages that include their department.
// Unbound/legacy sockets receive everything (backward-compatible).
// Pass an empty/null destinations to deliver unconditionally (company-wide signals).
function wsSocketMatchesDest(socket, destinations) {
    if (!socket.boundDepartmentId) return true;          // unbound legacy: always deliver
    if (!destinations || destinations.length === 0) return true; // no dept filter: deliver
    return destinations.includes(socket.boundDepartmentId);
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

        // [SECURITY] Step 2a: If this uid has a server-side Operations membership,
        // that record's company is AUTHORITATIVE for session issuance — it was set
        // by the inviting Director (or bootstrap) and can never be chosen by the
        // client. This prevents a user from gaining a session for another company
        // by writing an arbitrary `company` value into their own Firestore profile.
        // findOpsUserByUid is a hoisted function declaration defined later in the file.
        const opsRecord = findOpsUserByUid(uid);
        if (opsRecord && opsRecord.active !== false) {
            const opsCompany = String(opsRecord.companyId).trim().toLowerCase();
            const opsToken = signSessionToken(uid, opsCompany);
            console.log(`✅ [SECURITY] Session token issued from Operations record: uid=${uid}, company="${opsCompany}"`);
            return res.json({ success: true, token: opsToken, companyName: opsCompany });
        }

        // [SECURITY] Step 2b: Otherwise fetch company name from Firestore using the
        // user's own token (legacy Service source — authoritative for non-Ops users)
        const companyName = await getCompanyFromFirestore(uid, idToken);
        if (!companyName || companyName.trim() === '') {
            console.log(`⛔ [SECURITY] /api/auth/session rejected: no company found for uid=${uid}`);
            return res.status(403).json({ error: 'No company associated with this account. Please complete your profile.' });
        }

        const normalizedCompany = companyName.trim().toLowerCase();

        // [SECURITY] Step 3: Issue a server-signed session token
        const sessionToken = signSessionToken(uid, normalizedCompany);

        console.log(`✅ [SECURITY] Session token issued: uid=${uid}, company="${normalizedCompany}"`);

        // [S1.2] Step 4: Resolve Department Account context (if any).
        // departmentType always comes from the department record — never from the account.
        const deptAccountCtx = resolveDeptAccountContext(uid, normalizedCompany);

        res.json({
            success: true,
            token: sessionToken,
            companyName: normalizedCompany,
            ...deptAccountCtx   // spreads departmentAccountId/departmentId/departmentType/departmentAccountStatus (or nothing)
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

        // [SECURITY] Validate that every destination belongs to the authenticated company.
        // '__sala__' is the virtual ID for the floor/sala page and is always permitted.
        const SALA_VIRTUAL_ID = '__sala__';
        const companyDeptsRest = getCompanyDepts(companyName);
        const activeDeptIdsRest = companyDeptsRest.filter(d => d.active).map(d => d.id);
        if (activeDeptIdsRest.length > 0) {
            for (const destId of destList) {
                if (destId !== SALA_VIRTUAL_ID && !activeDeptIdsRest.includes(destId)) {
                    console.log(`⛔ [SECURITY] Voice message rejected — invalid destination "${destId}" for company "${companyName}"`);
                    return res.status(400).json({ error: `Reparto destinatario non valido: ${destId}` });
                }
            }
            if (from && from !== SALA_VIRTUAL_ID && !activeDeptIdsRest.includes(from)) {
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
// [S1.4] Bound ACTIVE  → only the assigned department
//        Bound SUSPENDED → 403
//        Unbound legacy  → all departments (existing behaviour)
app.get('/api/departments', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;

    const boundAcct = getBoundDepartmentContext(session);
    if (boundAcct) {
        const e = departmentAccessError(boundAcct);
        if (boundAcct.status !== 'ACTIVE') return res.status(e.status).json(e.body);

        // ACTIVE bound account — return ONLY the assigned active department.
        // departmentId is always from the server-side account record — never from the client.
        const assignedDept = getCompanyDepts(companyId).find(
            d => d.id === boundAcct.departmentId && d.active
        );
        const plan = getCompanyPlan(companyId);
        const limit = getPlanLimit(plan);
        // [S1.4.1] Return explicit error instead of empty array when assigned dept is inactive.
        if (!assignedDept) {
            return res.status(410).json({ error: 'Assigned department inactive', code: 'DEPARTMENT_INACTIVE' });
        }
        return res.json({ success: true, departments: [assignedDept], plan, limit });
    }

    // Unbound legacy user — existing behaviour preserved
    const depts = getCompanyDepts(companyId);
    const plan = getCompanyPlan(companyId);
    const limit = getPlanLimit(plan);
    res.json({ success: true, departments: depts, plan, limit });
});

// POST /api/departments — create (enforces plan limit server-side)
// [S1.4] Bound Department Accounts are workstation accounts, not administrators.
app.post('/api/departments', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const boundAcct = getBoundDepartmentContext(session);
    if (boundAcct) { const e = departmentAccessError(boundAcct); return res.status(e.status).json(e.body); }
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
// [S1.4] Bound Department Accounts cannot manage departments.
app.put('/api/departments/:id', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const boundAcct = getBoundDepartmentContext(session);
    if (boundAcct) { const e = departmentAccessError(boundAcct); return res.status(e.status).json(e.body); }
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
    if (typeof active === 'boolean') {
        // [S1.1] Referential integrity: deactivating a department auto-suspends
        // its ACTIVE Department Account — no active identity may point at an
        // inactive department.
        if (active === false && depts[idx].active) {
            const suspended = departmentAccounts.suspendAccountsForDepartment(companyId, depts[idx].id);
            if (suspended) console.log(`⚠️ [DEPT-ACCOUNT] Auto-suspended account "${suspended.displayName}" (department deactivated)`);
        }
        depts[idx].active = active;
    }

    saveJSON(DEPARTMENTS_FILE, departmentsStore);
    res.json({ success: true, department: depts[idx] });
});

// DELETE /api/departments/:id — only if never used in countdowns
// [S1.4] Bound Department Accounts cannot manage departments.
app.delete('/api/departments/:id', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const boundAcct = getBoundDepartmentContext(session);
    if (boundAcct) { const e = departmentAccessError(boundAcct); return res.status(e.status).json(e.body); }
    const companyId = session.companyName;
    const depts = departmentsStore[companyId] || [];
    const idx = depts.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Department not found.' });

    // [S1.1] Referential integrity: a department referenced by any Department
    // Account (any status) cannot be deleted — accounts must never dangle.
    if (departmentAccounts.hasDepartmentAccounts(companyId, req.params.id)) {
        return res.status(409).json({ error: 'This department has department accounts bound to it and cannot be deleted. Remove or reassign its accounts first.' });
    }

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

// ===== Department Account REST API (S1.1 — TRANSITIONAL) =====
// [TRANSITIONAL] These management endpoints are company-scoped under the
// existing requireAuth session only. A real Service Admin role/permission
// model lands in a later sprint; until then ANY authenticated user of the
// company can manage its Department Accounts. companyId ALWAYS comes from
// the HMAC session — never from client body/query.

// [S2.0] safeAccount — strips passwordHash before sending to client.
// Adds hasPassword:bool so the UI knows whether a password has been set
// without ever sending the hash. Apply to every account in every response.
function safeAccount(a) {
    if (!a) return a;
    const { passwordHash, ...rest } = a;
    rest.hasPassword = !!passwordHash;
    return rest;
}

// GET /api/department-accounts — list the company's Department Accounts
app.get('/api/department-accounts', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName; // never from client input
    const accounts = departmentAccounts.getDepartmentAccounts(companyId).map(safeAccount);
    res.json({ success: true, accounts });
});

// POST /api/department-accounts — create (one account per department)
// [S2.0] Accepts optional `password`. displayName auto-derived from dept name
// when not supplied (admin UI does not expose a displayName field).
app.post('/api/department-accounts', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName; // forged companyId in body is ignored
    const { departmentId, loginIdentifier, password } = req.body || {};
    // Pass displayName through from body if supplied; createDepartmentAccount auto-derives
    // it from the dept name when absent (defense-in-depth kept here as a secondary hint).
    let { displayName } = req.body || {};
    if (!(displayName || '').trim()) {
        const dept = getCompanyDepts(companyId).find(d => d.id === departmentId);
        if (dept && dept.name) displayName = dept.name;
        // If dept not found here, createDepartmentAccount will re-derive from companyDepts.
    }
    const result = departmentAccounts.createDepartmentAccount(
        { companyId, departmentId, displayName, loginIdentifier, password, createdBy: session.uid },
        getCompanyDepts(companyId)
    );
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    console.log(`✅ [DEPT-ACCOUNT] Created "${result.account.displayName}" for company "${companyId}"`);
    res.status(201).json({ success: true, account: safeAccount(result.account) });
});

// PATCH /api/department-accounts/:id — [S2.0] update loginIdentifier and/or password.
// Status changes use PUT /:id/status (existing endpoint). Company isolation is
// structural: account lookup is scoped to session company.
app.patch('/api/department-accounts/:id', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const { loginIdentifier, password } = req.body || {};
    const result = departmentAccounts.updateDepartmentAccount(
        companyId, req.params.id, { loginIdentifier, password }
    );
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    res.json({ success: true, account: safeAccount(result.account) });
});

// PUT /api/department-accounts/:id/status — ACTIVE | SUSPENDED
app.put('/api/department-accounts/:id/status', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const result = departmentAccounts.setDepartmentAccountStatus(companyId, req.params.id, (req.body || {}).status, getCompanyDepts(companyId));
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    res.json({ success: true, account: safeAccount(result.account) });
});

// POST /api/department-accounts/bind — bind the caller's verified Firebase UID
// to an existing Department Account identified by loginIdentifier.
//
// [S1.2] Security model:
//   • Requires a valid HMAC session (requireAuth). The session.uid is the
//     Firebase-verified UID issued at POST /api/auth/session — it cannot be
//     forged by the client. We NEVER accept a uid from the request body.
//   • company isolation: the account's companyId must match session.companyName.
//   • Cross-company binding is rejected inside bindFirebaseUid (structural).
//   • Duplicate UID / already-bound account / SUSPENDED targets are all rejected.
app.post('/api/department-accounts/bind', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const uid = session.uid; // [SECURITY] server-verified — never from client payload

    const { loginIdentifier } = req.body || {};
    if (!loginIdentifier || typeof loginIdentifier !== 'string') {
        return res.status(400).json({ error: 'loginIdentifier is required.' });
    }

    // Look up the target account by loginIdentifier (global, case-insensitive).
    const account = departmentAccounts.findDepartmentAccountByLoginIdentifier(loginIdentifier.trim());
    if (!account) {
        return res.status(404).json({ error: 'Department account not found.' });
    }

    // [SECURITY] company isolation — account must belong to the session company.
    if (account.companyId !== companyId) {
        return res.status(403).json({ error: 'Department account does not belong to your company.' });
    }

    const result = departmentAccounts.bindFirebaseUid(companyId, account.id, uid);
    if (!result.ok) return res.status(result.code).json({ error: result.error });

    console.log(`✅ [DEPT-ACCOUNT] UID bound to account "${result.account.id}" (company "${companyId}")`);
    res.json({ success: true, account: result.account });
});

// GET /api/service/identity — returns the Department Account context for the
// currently authenticated session (if any). Used by dashboard clients to
// discover their departmentId / departmentType after login.
//
// Returns { success, departmentAccountId?, departmentId?, departmentType?,
//           departmentAccountStatus? }. Fields are absent when the session user
// has no Department Account binding.
app.get('/api/service/identity', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const ctx = resolveDeptAccountContext(session.uid, session.companyName);
    res.json({ success: true, ...ctx });
});

// GET /api/service/department — dedicated endpoint for bound Department Accounts.
// [S1.4.1] Returns the authenticated account's assigned department in a clean,
// purpose-built shape. Replaces relying on GET /api/departments for bound users.
//
// Response:
//   { success, departmentId, departmentName, departmentType, status, departmentAccountId }
//
// Error codes (stable, UI-layer branching):
//   NOT_BOUND           — caller has no Department Account binding
//   ACCOUNT_SUSPENDED   — account is SUSPENDED
//   DEPARTMENT_INACTIVE — assigned department no longer active (410)
//
// All values come from server-side verified records — never from the client.
app.get('/api/service/department', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;

    const boundAcct = getBoundDepartmentContext(session);
    if (!boundAcct) {
        return res.status(403).json({ error: 'No department account binding.', code: 'NOT_BOUND' });
    }
    if (boundAcct.status !== 'ACTIVE') {
        const e = departmentAccessError(boundAcct);
        return res.status(e.status).json(e.body);
    }

    // departmentId always from the server-side account record — never from the client
    const dept = getCompanyDepts(session.companyName).find(d => d.id === boundAcct.departmentId);
    if (!dept || !dept.active) {
        return res.status(410).json({ error: 'Assigned department inactive', code: 'DEPARTMENT_INACTIVE' });
    }

    const departmentType = departmentAccounts.getDepartmentType(dept);
    res.json({
        success:            true,
        departmentId:       dept.id,
        departmentName:     dept.name,
        departmentType,                    // STANDARD | CENTRAL — from dept record
        status:             boundAcct.status,
        departmentAccountId: boundAcct.id
    });
});

// ── [S2.2] In-memory rate limiter for POST /api/service/login ────────────────
// Keyed by `${normalizedLogin}:${clientIP}`. Max 5 failures per 5-minute window.
// Successful login clears the entry. No persistence — restarts reset counters (acceptable).
// Does NOT affect /api/auth/session (Firebase/Operations login) or any other endpoint.
const _loginFailures      = new Map();
const _LOGIN_MAX_FAILURES = 5;
const _LOGIN_WINDOW_MS    = 5 * 60 * 1000; // 5 minutes

function _getLoginRateKey(loginIdentifier, req) {
    const ip = ((req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
        .split(',')[0].trim());
    return `${(loginIdentifier || '').trim().toLowerCase()}:${ip}`;
}

function _isLoginRateLimited(key) {
    const entry = _loginFailures.get(key);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > _LOGIN_WINDOW_MS) {
        _loginFailures.delete(key);
        return false;
    }
    return entry.count >= _LOGIN_MAX_FAILURES;
}

function _recordLoginFailure(key) {
    const entry = _loginFailures.get(key);
    const now   = Date.now();
    if (!entry || now - entry.windowStart > _LOGIN_WINDOW_MS) {
        _loginFailures.set(key, { count: 1, windowStart: now });
    } else {
        entry.count++;
    }
}

function _clearLoginFailures(key) {
    _loginFailures.delete(key);
}

// POST /api/service/login — authenticate a Department Account by loginIdentifier + password.
// [S2.1] Pure Service login: no Firebase involvement.
//
// Security contract:
//   • loginIdentifier is globally unique (S2.1+) — no company ambiguity at login.
//   • Password is PBKDF2-verified against the stored hash; plaintext is never stored or logged.
//   • companyId and departmentId are resolved server-side from the account record only.
//   • Generic 401 for bad credentials — no oracle (does not reveal whether login exists).
//   • Specific 403 for SUSPENDED account or inactive department (spec-mandated messages).
//   • passwordHash intentionally excluded from every response.
//   • The issued token cannot create an Operations session (separate uid namespace).
app.post('/api/service/login', (req, res) => {
    const { loginIdentifier, password } = req.body || {};
    if (!loginIdentifier || !password) {
        return res.status(400).json({ error: 'Login e password sono obbligatori.' });
    }

    // [S2.2] Rate limit check — runs before credential lookup (no oracle).
    const rateKey = _getLoginRateKey(loginIdentifier, req);
    if (_isLoginRateLimited(rateKey)) {
        return res.status(429).json({ error: 'Troppi tentativi. Riprova tra qualche minuto.' });
    }

    const account = departmentAccounts.findDepartmentAccountByLoginIdentifier(loginIdentifier);

    // Generic credential error — same response whether login unknown or password wrong.
    // verifyPassword returns false for missing/empty passwordHash too.
    // [S2.2] Both cases count as a failure — unknown login and wrong password are identical.
    if (!account || !departmentAccounts.verifyPassword(password, account.passwordHash || '')) {
        _recordLoginFailure(rateKey);
        return res.status(401).json({ error: 'Login o password non corretti.' });
    }

    if (account.status === 'SUSPENDED') {
        // Suspended: correct credentials but blocked. Do not increment failure counter —
        // this is not a brute-force scenario; the admin needs to unsuspend the account.
        return res.status(403).json({ error: 'Account reparto sospeso. Contatta l\'amministratore.' });
    }
    if (account.status !== 'ACTIVE') {
        _recordLoginFailure(rateKey);
        return res.status(401).json({ error: 'Login o password non corretti.' });
    }

    // Verify the linked department is still active.
    const dept = getCompanyDepts(account.companyId).find(d => d.id === account.departmentId);
    if (!dept || !dept.active) {
        // Correct credentials, blocked by infrastructure. Do not increment failure counter.
        return res.status(403).json({ error: 'Reparto non disponibile. Contatta l\'amministratore.' });
    }

    // Success — clear failure counter for this key.
    _clearLoginFailures(rateKey);

    // Issue a Service session token.
    // uid = account.id ('depacct_…') — distinct from Firebase UIDs; getBoundDepartmentContext
    // detects the prefix and routes to findDepartmentAccountById instead of findDepartmentAccountByUid.
    const token = signSessionToken(account.id, account.companyId);
    console.log(`✅ [SECURITY] Service login: account=${account.id}, dept=${account.departmentId}, company="${account.companyId}"`);

    res.json({
        success:      true,
        token,
        departmentId: dept.id,          // server-derived — client must not supply this
        companyId:    account.companyId // server-derived
        // passwordHash intentionally absent
    });
});

// PUT /api/departments/:id/type — set departmentType (STANDARD | CENTRAL)
// [TRANSITIONAL] Representation only in this sprint: no permission is derived
// from CENTRAL yet. Max one CENTRAL per company (reject-until-reverted).
// [S1.4] Bound Department Accounts cannot manage departments.
app.put('/api/departments/:id/type', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const boundAcct = getBoundDepartmentContext(session);
    if (boundAcct) { const e = departmentAccessError(boundAcct); return res.status(e.status).json(e.body); }
    const companyId = session.companyName;
    const depts = departmentsStore[companyId] || [];
    const result = departmentAccounts.setDepartmentType(depts, req.params.id, (req.body || {}).departmentType);
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    saveJSON(DEPARTMENTS_FILE, departmentsStore);
    res.json({ success: true, department: result.department });
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

// =========================================================================
// ===== CALENDAR MODULE ===================================================
// =========================================================================
const CALENDAR_EVENTS_FILE = path.join(DATA_DIR, 'calendar-events.json');
const CALENDAR_NOTIF_FILE  = path.join(DATA_DIR, 'calendar-notif.json');

// Populated by initializeDataStores() at startup — do not loadJSON here.
let calendarEventsStore = {};
let calendarNotifStore  = {};

// Maps local file paths → Firestore document names used by saveJSON / initializeDataStores.
// Defined here because this is the first point where ALL four file constants exist.
function getStoreNameForFile(filePath) {
    if (filePath === DEPARTMENTS_FILE)    return 'departments';
    if (filePath === PLANS_FILE)          return 'plans';
    if (filePath === CALENDAR_EVENTS_FILE) return 'calendar_events';
    if (filePath === CALENDAR_NOTIF_FILE)  return 'calendar_notifs';
    if (filePath === DEPARTMENT_ACCOUNTS_FILE) return 'department_accounts';
    if (filePath === OPS_USERS_FILE)      return 'ops_users';
    if (filePath === OPS_TASKS_FILE)      return 'ops_tasks';
    if (filePath === OPS_TEMPLATES_FILE)  return 'ops_templates';
    if (filePath === OPS_PREFS_FILE)      return 'ops_prefs';
    return null;
}

const CALENDAR_TZ = 'Europe/Zurich';

const VALID_EVENT_TYPES = [
    'reservation','group_reservation','staff_meeting','staff_shift_note',
    'supplier_delivery','maintenance','inventory','haccp_control','training',
    'private_event','birthday','anniversary','payment_deadline','reminder','other'
];
const VALID_PRIORITIES   = ['low','normal','high','urgent'];
const VALID_STATUSES     = ['scheduled','confirmed','in_progress','completed','cancelled'];
const VALID_VISIBILITIES = ['all_company','selected_departments','managers_only'];
const VALID_RECUR_TYPES  = ['none','daily','weekly','monthly','selected_weekdays'];

function genCalId()   { return 'cal_'   + Date.now() + '_' + crypto.randomBytes(3).toString('hex'); }
function genNotifId() { return 'notif_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'); }

// Return today's YYYY-MM-DD in Zurich timezone
function todayZurich() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: CALENDAR_TZ }).format(new Date());
}

// Convert any Date / ISO string / ms to YYYY-MM-DD in Zurich
function toZurichDateStr(val) {
    const d = (val instanceof Date) ? val : new Date(val);
    return new Intl.DateTimeFormat('en-CA', { timeZone: CALENDAR_TZ }).format(d);
}

// Convert YYYY-MM-DD + HH:MM (Zurich local) → UTC ms
function zurichLocalToMs(dateStr, timeStr) {
    // Build an ambiguous-local string and use the Intl offset trick
    const isoLocal = `${dateStr}T${timeStr || '00:00'}:00`;
    // Try parsing with +01:00 and +02:00, pick the one whose Zurich repr matches
    for (const offset of ['+02:00', '+01:00']) {
        const candidate = new Date(`${isoLocal}${offset}`);
        if (toZurichDateStr(candidate) === dateStr) return candidate.getTime();
    }
    return new Date(isoLocal).getTime();
}

function getCompanyCalEvents(companyId) { return calendarEventsStore[companyId] || []; }
function saveCalEvents() { saveJSON(CALENDAR_EVENTS_FILE, calendarEventsStore); }
function getCompanyNotifs(companyId)    { return calendarNotifStore[companyId]  || []; }
function saveCalNotifs()  { saveJSON(CALENDAR_NOTIF_FILE,  calendarNotifStore); }

// Awaited Firestore save for calendar events.  Returns a resolved Promise on
// success or throws (so callers can return HTTP 500 and the frontend knows).
async function saveCalEventsAsync(companyId) {
    if (db) {
        try {
            await db.collection(STORE_COLLECTION).doc('calendar_events')
                .set({ store: calendarEventsStore, updatedAt: Date.now() });
            console.log(`[CALENDAR] Saved ${(calendarEventsStore[companyId] || []).length} events for companyId ${companyId}`);
        } catch (e) {
            console.error(`[CALENDAR] Firestore save failed: ${e.message}`);
            throw e;
        }
    } else {
        try {
            fs.writeFileSync(CALENDAR_EVENTS_FILE, JSON.stringify(calendarEventsStore, null, 2));
            console.log(`[CALENDAR] Saved ${(calendarEventsStore[companyId] || []).length} events for companyId ${companyId} (local file)`);
        } catch (e) {
            console.error(`[CALENDAR] Local file save failed: ${e.message}`);
            throw e;
        }
    }
}

// Sanitize event input — returns cleaned object or throws string error
function sanitizeEventInput(body) {
    const title = (body.title || '').trim();
    if (!title) throw 'title is required';
    if (title.length > 200) throw 'title too long (max 200)';

    const date = (body.date || '').trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw 'date must be YYYY-MM-DD';

    const eventType = (body.eventType || '').trim();
    if (!VALID_EVENT_TYPES.includes(eventType)) throw `eventType must be one of: ${VALID_EVENT_TYPES.join(', ')}`;

    const startTime = (body.startTime || '00:00').trim();
    if (!/^\d{2}:\d{2}$/.test(startTime)) throw 'startTime must be HH:MM';

    const endTime = body.endTime ? (body.endTime).trim() : null;
    if (endTime && !/^\d{2}:\d{2}$/.test(endTime)) throw 'endTime must be HH:MM';

    const priority   = VALID_PRIORITIES.includes(body.priority)   ? body.priority   : 'normal';
    const status     = VALID_STATUSES.includes(body.status)       ? body.status     : 'scheduled';
    const visibility = VALID_VISIBILITIES.includes(body.visibility)? body.visibility : 'all_company';

    const departmentIds   = Array.isArray(body.departmentIds)   ? body.departmentIds.filter(s => typeof s === 'string') : [];
    const assignedUserIds = Array.isArray(body.assignedUserIds) ? body.assignedUserIds.filter(s => typeof s === 'string') : [];

    const guestCount = body.guestCount != null ? parseInt(body.guestCount) || null : null;

    const reminders = Array.isArray(body.reminders)
        ? body.reminders
            .map(r => ({ offsetMinutes: parseInt(r.offsetMinutes) }))
            .filter(r => !isNaN(r.offsetMinutes) && r.offsetMinutes >= 0 && r.offsetMinutes <= 10080)
        : [];

    let recurrence = { type: 'none', interval: 1, weekdays: [], endDate: null };
    if (body.recurrence && typeof body.recurrence === 'object') {
        const rt = VALID_RECUR_TYPES.includes(body.recurrence.type) ? body.recurrence.type : 'none';
        const ri = parseInt(body.recurrence.interval) || 1;
        const rw = Array.isArray(body.recurrence.weekdays)
            ? body.recurrence.weekdays.filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
            : [];
        const re = body.recurrence.endDate && /^\d{4}-\d{2}-\d{2}$/.test(body.recurrence.endDate)
            ? body.recurrence.endDate : null;
        recurrence = { type: rt, interval: Math.max(1, ri), weekdays: rw, endDate: re };
    }

    return {
        title,
        description:      (body.description      || '').trim().slice(0, 2000),
        eventType,
        date,
        startTime,
        endTime:          endTime || null,
        allDay:           body.allDay === true,
        location:         (body.location         || '').trim().slice(0, 200),
        priority,
        status,
        departmentIds,
        assignedUserIds,
        guestCount:       guestCount != null && guestCount > 0 ? guestCount : null,
        tableNumber:      body.tableNumber != null ? String(body.tableNumber).slice(0, 20) : null,
        customerName:     (body.customerName      || '').trim().slice(0, 200),
        contactName:      (body.contactName       || '').trim().slice(0, 200),
        phone:            (body.phone             || '').trim().slice(0, 50),
        allergyNotes:     (body.allergyNotes      || '').trim().slice(0, 500),
        dietaryNotes:     (body.dietaryNotes      || '').trim().slice(0, 500),
        preparationNotes: (body.preparationNotes  || '').trim().slice(0, 1000),
        visibility,
        reminders,
        recurrence
    };
}

// Expand a recurring event into occurrences within [startDateStr, endDateStr]
function expandRecurrence(event, startDateStr, endDateStr) {
    if (!event.recurrence || event.recurrence.type === 'none') {
        if (event.date >= startDateStr && event.date <= endDateStr) {
            return [event];
        }
        return [];
    }
    const results = [];
    const endDate = event.recurrence.endDate
        ? (event.recurrence.endDate < endDateStr ? event.recurrence.endDate : endDateStr)
        : endDateStr;

    // Walk from event.date forward by the recurrence rule
    let current = event.date;
    let safetyLimit = 0;
    while (current <= endDate && safetyLimit++ < 500) {
        if (current >= startDateStr) {
            // For selected_weekdays, check if the day matches
            if (event.recurrence.type === 'selected_weekdays') {
                const dow = new Date(current + 'T12:00:00Z').getUTCDay(); // 0=Sun
                if (!event.recurrence.weekdays.includes(dow)) {
                    current = addDays(current, 1);
                    continue;
                }
            }
            results.push({ ...event, date: current, id: event.id + '_' + current, baseId: event.id });
        }
        // Advance
        current = advanceDate(current, event.recurrence);
    }
    return results;
}

function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function advanceDate(dateStr, recurrence) {
    const interval = recurrence.interval || 1;
    switch (recurrence.type) {
        case 'daily':            return addDays(dateStr, interval);
        case 'weekly':           return addDays(dateStr, 7 * interval);
        case 'selected_weekdays':return addDays(dateStr, 1);
        case 'monthly': {
            const d = new Date(dateStr + 'T12:00:00Z');
            d.setUTCMonth(d.getUTCMonth() + interval);
            return d.toISOString().slice(0, 10);
        }
        default: return addDays(dateStr, 1);
    }
}

// Generate notifications for an event that are due now (within the window)
function generatePendingNotifications(event, companyId) {
    if (!event.reminders || event.reminders.length === 0) return;
    if (['completed','cancelled'].includes(event.status)) return;

    const notifs = calendarNotifStore[companyId] || [];
    const now = Date.now();

    const startMs = zurichLocalToMs(event.date, event.startTime || '00:00');

    for (const reminder of event.reminders) {
        const triggerMs = startMs - reminder.offsetMinutes * 60 * 1000;
        // Only generate if trigger is in the past (it's due) but not too old (> 24h ago)
        if (triggerMs > now) continue;
        if (now - triggerMs > 24 * 60 * 60 * 1000) continue;

        const key = `${event.id}:${reminder.offsetMinutes}`;
        const alreadyExists = notifs.some(n => n.eventId === event.id && n.offsetMinutes === reminder.offsetMinutes);
        if (alreadyExists) continue;

        notifs.push({
            id: genNotifId(),
            companyId,
            eventId: event.id,
            eventTitle: event.title,
            eventDate: event.date,
            eventStartTime: event.startTime,
            eventType: event.eventType,
            offsetMinutes: reminder.offsetMinutes,
            generatedAt: now,
            deliveredAt: now,
            readBy: [],
            dismissedBy: []
        });
    }
    if (!calendarNotifStore[companyId]) calendarNotifStore[companyId] = [];
    calendarNotifStore[companyId] = notifs;
    saveCalNotifs();
}

// Run notification generation for all due events across all companies
function runNotificationGeneration() {
    const today = todayZurich();
    const yesterday = addDays(today, -1);
    for (const companyId of Object.keys(calendarEventsStore)) {
        const events = calendarEventsStore[companyId] || [];
        for (const event of events) {
            if (event.date < yesterday) continue;
            if (event.date > addDays(today, 1)) continue;
            generatePendingNotifications(event, companyId);
        }
    }
}

// Run once at startup and then every minute
runNotificationGeneration();
setInterval(runNotificationGeneration, 60 * 1000);

// Helper: broadcast a calendar event to a company room (if WebSocket room exists)
function broadcastCalendarEvent(companyId, action, payload) {
    if (!companyRooms || !companyRooms.has(companyId)) return;
    const room = companyRooms.get(companyId);
    const msg = JSON.stringify({ action, ...payload });
    room.forEach(client => {
        if (client.readyState === 1) client.send(msg);
    });
}

// ----- REST: Calendar Events -----

// GET /api/calendar/events?start=YYYY-MM-DD&end=YYYY-MM-DD
app.get('/api/calendar/events', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const uid = session.uid;

    const start = req.query.start || todayZurich();
    const end   = req.query.end   || addDays(start, 30);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        return res.status(400).json({ success: false, error: 'start/end must be YYYY-MM-DD' });
    }

    const allEvents = getCompanyCalEvents(companyId);
    const result = [];

    for (const event of allEvents) {
        // Visibility filter: managers_only events are visible to all (no separate role here)
        const occurrences = expandRecurrence(event, start, end);
        for (const occ of occurrences) {
            result.push(occ);
        }
    }

    // Sort by date then startTime
    result.sort((a, b) => {
        const d = a.date.localeCompare(b.date);
        if (d !== 0) return d;
        return (a.startTime || '00:00').localeCompare(b.startTime || '00:00');
    });

    res.json({ success: true, events: result });
});

// GET /api/calendar/events/upcoming — today + next 48h
app.get('/api/calendar/events/upcoming', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;

    const today = todayZurich();
    const in2days = addDays(today, 2);
    const now = Date.now();
    const in2hours = now + 2 * 60 * 60 * 1000;

    const allEvents = getCompanyCalEvents(companyId);
    const today_events = [];
    const next2h_events = [];
    const urgent_events = [];
    const this_week = [];
    const completed_today = [];

    const weekEnd = addDays(today, 7);

    for (const event of allEvents) {
        const occurrences = expandRecurrence(event, today, weekEnd);
        for (const occ of occurrences) {
            const startMs = zurichLocalToMs(occ.date, occ.startTime || '00:00');
            const isToday = occ.date === today;
            const isThisWeek = occ.date >= today && occ.date <= weekEnd;

            if (isToday) {
                if (occ.status === 'completed') {
                    completed_today.push(occ);
                } else {
                    today_events.push(occ);
                    if (startMs <= in2hours && startMs >= now - 30 * 60 * 1000) {
                        next2h_events.push(occ);
                    }
                    if (occ.priority === 'urgent' || occ.priority === 'high') {
                        urgent_events.push(occ);
                    }
                    // Overdue: started in the past, not completed/cancelled
                    if (startMs < now && !['completed','cancelled'].includes(occ.status)) {
                        occ._overdue = true;
                    }
                }
            } else if (isThisWeek) {
                this_week.push(occ);
            }
        }
    }

    const sortByTime = arr => arr.sort((a, b) =>
        (a.startTime || '00:00').localeCompare(b.startTime || '00:00'));

    res.json({
        success: true,
        today: sortByTime(today_events),
        next2h: sortByTime(next2h_events),
        urgent: urgent_events,
        this_week: this_week.sort((a,b) => a.date.localeCompare(b.date) || (a.startTime||'00:00').localeCompare(b.startTime||'00:00')),
        completed_today: sortByTime(completed_today),
        today_date: today
    });
});

// GET /api/calendar/events/:id
app.get('/api/calendar/events/:id', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const events = getCompanyCalEvents(companyId);
    // Also search by baseId for recurring occurrences
    const event = events.find(e => e.id === req.params.id || e.id === req.params.id.split('_').slice(0, -1).join('_'));
    if (!event) return res.status(404).json({ success: false, error: 'Event not found' });
    res.json({ success: true, event });
});

// POST /api/calendar/events
app.post('/api/calendar/events', async (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    console.log(`[CALENDAR] Creating event for companyId ${companyId}`);

    let cleaned;
    try { cleaned = sanitizeEventInput(req.body); }
    catch (err) { return res.status(400).json({ success: false, error: String(err) }); }

    const now = Date.now();
    const event = {
        id: genCalId(),
        companyId,
        ...cleaned,
        createdBy: session.uid,
        createdAt: now,
        updatedAt: now
    };

    if (!calendarEventsStore[companyId]) calendarEventsStore[companyId] = [];
    calendarEventsStore[companyId].push(event);

    try {
        await saveCalEventsAsync(companyId);
    } catch (e) {
        calendarEventsStore[companyId].pop(); // rollback in-memory
        return res.status(500).json({ success: false, error: '[CALENDAR] Firestore save failed: ' + e.message });
    }

    // Generate any immediate notifications
    generatePendingNotifications(event, companyId);

    // Broadcast
    broadcastCalendarEvent(companyId, 'calendarEventCreated', { event });

    console.log(`[CALENDAR] Saved event ${event.id} for companyId ${companyId}`);
    res.status(201).json({ success: true, event });
});

// PUT /api/calendar/events/:id
app.put('/api/calendar/events/:id', async (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    console.log(`[CALENDAR] Updating event ${req.params.id} for companyId ${companyId}`);

    const events = calendarEventsStore[companyId] || [];
    // Support both base IDs and occurrence IDs (strip trailing _YYYY-MM-DD suffix if needed)
    const resolveIdx = id => {
        let i = events.findIndex(e => e.id === id);
        if (i === -1) {
            const base = id.replace(/_\d{4}-\d{2}-\d{2}$/, '');
            if (base !== id) i = events.findIndex(e => e.id === base);
        }
        return i;
    };
    const idx = resolveIdx(req.params.id);
    if (idx === -1) {
        console.warn(`[CALENDAR] PUT 404: event "${req.params.id}" not found for company "${companyId}" (${(calendarEventsStore[companyId]||[]).length} events in store)`);
        return res.status(404).json({ success: false, error: 'Event not found' });
    }

    let cleaned;
    try { cleaned = sanitizeEventInput({ ...events[idx], ...req.body }); }
    catch (err) { return res.status(400).json({ success: false, error: String(err) }); }

    const prevEvent = { ...events[idx] };
    const updated = {
        ...events[idx],
        ...cleaned,
        id: events[idx].id,
        companyId,
        createdBy: events[idx].createdBy,
        createdAt: events[idx].createdAt,
        updatedAt: Date.now()
    };

    calendarEventsStore[companyId][idx] = updated;

    try {
        await saveCalEventsAsync(companyId);
    } catch (e) {
        calendarEventsStore[companyId][idx] = prevEvent; // rollback in-memory
        return res.status(500).json({ success: false, error: '[CALENDAR] Firestore save failed: ' + e.message });
    }

    broadcastCalendarEvent(companyId, 'calendarEventUpdated', { event: updated });

    console.log(`[CALENDAR] Saved event ${updated.id} for companyId ${companyId}`);
    res.json({ success: true, event: updated });
});

// PATCH /api/calendar/events/:id/status — mark completed / cancelled / other status
app.patch('/api/calendar/events/:id/status', async (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;

    const events = calendarEventsStore[companyId] || [];
    const resolveIdx = id => {
        let i = events.findIndex(e => e.id === id);
        if (i === -1) {
            const base = id.replace(/_\d{4}-\d{2}-\d{2}$/, '');
            if (base !== id) i = events.findIndex(e => e.id === base);
        }
        return i;
    };
    const idx = resolveIdx(req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Event not found' });

    const newStatus = req.body.status;
    if (!VALID_STATUSES.includes(newStatus)) {
        return res.status(400).json({ success: false, error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const prevStatus    = events[idx].status;
    const prevUpdatedAt = events[idx].updatedAt;
    events[idx].status    = newStatus;
    events[idx].updatedAt = Date.now();
    if (newStatus === 'completed') events[idx].completedAt = Date.now();

    try {
        await saveCalEventsAsync(companyId);
    } catch (e) {
        events[idx].status    = prevStatus;    // rollback in-memory
        events[idx].updatedAt = prevUpdatedAt;
        if (newStatus === 'completed') delete events[idx].completedAt;
        return res.status(500).json({ success: false, error: '[CALENDAR] Firestore save failed: ' + e.message });
    }

    console.log(`[CALENDAR] Saved event ${events[idx].id} for companyId ${companyId}`);
    const action = newStatus === 'completed' ? 'calendarEventCompleted' : 'calendarEventCancelled';
    broadcastCalendarEvent(companyId, action, { eventId: events[idx].id, status: newStatus, event: events[idx] });

    res.json({ success: true, event: events[idx] });
});

// POST /api/calendar/events/:id/duplicate
app.post('/api/calendar/events/:id/duplicate', async (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;

    const events = getCompanyCalEvents(companyId);
    const resolveEvent = id => {
        let ev = events.find(e => e.id === id);
        if (!ev) {
            const base = id.replace(/_\d{4}-\d{2}-\d{2}$/, '');
            if (base !== id) ev = events.find(e => e.id === base);
        }
        return ev;
    };
    const source = resolveEvent(req.params.id);
    if (!source) return res.status(404).json({ success: false, error: 'Event not found' });

    const now = Date.now();
    const copy = {
        ...source,
        id: genCalId(),
        title: source.title + ' (copia)',
        status: 'scheduled',
        createdBy: session.uid,
        createdAt: now,
        updatedAt: now,
        completedAt: undefined
    };
    delete copy.completedAt;

    if (!calendarEventsStore[companyId]) calendarEventsStore[companyId] = [];
    calendarEventsStore[companyId].push(copy);

    try {
        await saveCalEventsAsync(companyId);
    } catch (e) {
        calendarEventsStore[companyId].pop(); // rollback in-memory
        return res.status(500).json({ success: false, error: '[CALENDAR] Firestore save failed: ' + e.message });
    }

    console.log(`[CALENDAR] Saved event ${copy.id} for companyId ${companyId}`);
    res.status(201).json({ success: true, event: copy });
});

// DELETE /api/calendar/events/:id
app.delete('/api/calendar/events/:id', async (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const requestedId = req.params.id;
    console.log(`[CALENDAR DELETE] company=${companyId} requestedId=${requestedId}`);

    const events = calendarEventsStore[companyId] || [];

    // Resolve: support occurrence IDs by stripping trailing _YYYY-MM-DD date suffix
    const resolveIdx = id => {
        let i = events.findIndex(e => e.id === id);
        if (i === -1) {
            const base = id.replace(/_\d{4}-\d{2}-\d{2}$/, '');
            if (base !== id) i = events.findIndex(e => e.id === base);
        }
        return i;
    };
    const idx = resolveIdx(requestedId);
    if (idx === -1) {
        console.warn(`[CALENDAR DELETE] Failed status=404 reason=event not found (${events.length} events in store for company "${companyId}")`);
        return res.status(404).json({ success: false, error: 'Event not found' });
    }

    const event = events[idx];
    const resolvedId = event.id;
    console.log(`[CALENDAR DELETE] Event found resolvedId=${resolvedId}`);

    // Step 1 — build the updated array WITHOUT mutating the live store yet
    const updatedEvents = events.filter((_, i) => i !== idx);

    // Step 2 — persist to Firestore (or local file) first; only then commit to memory
    const prevEvents = calendarEventsStore[companyId];
    calendarEventsStore[companyId] = updatedEvents;

    try {
        await saveCalEventsAsync(companyId);
        console.log(`[CALENDAR DELETE] Firestore save completed`);
    } catch (e) {
        // Restore in-memory state — event is NOT deleted
        calendarEventsStore[companyId] = prevEvents;
        console.error(`[CALENDAR DELETE] Failed status=500 reason=${e.message}`);
        return res.status(500).json({ success: false, error: 'Errore nel salvataggio. Riprova.' });
    }

    // Step 3 — notification cleanup (non-fatal: failures must never block the deletion)
    try {
        if (calendarNotifStore[companyId]) {
            calendarNotifStore[companyId] = calendarNotifStore[companyId]
                .filter(n => n.eventId !== resolvedId && n.eventId !== requestedId);
            saveCalNotifs();
        }
    } catch (notifErr) {
        console.error(`[CALENDAR DELETE] Notification cleanup error (non-fatal): ${notifErr.message}`);
    }

    // Step 4 — broadcast and respond
    broadcastCalendarEvent(companyId, 'calendarEventDeleted', { eventId: resolvedId });

    console.log(`[CALENDAR DELETE] Response 200 eventId=${resolvedId}`);
    res.json({ success: true });
});

// ----- REST: Calendar Notifications -----

// GET /api/calendar/notifications
app.get('/api/calendar/notifications', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const uid = session.uid;

    // Trigger generation for any due reminders
    const today = todayZurich();
    const events = getCompanyCalEvents(companyId);
    for (const event of events) {
        if (event.date >= addDays(today, -1) && event.date <= addDays(today, 1)) {
            generatePendingNotifications(event, companyId);
        }
    }

    const notifs = getCompanyNotifs(companyId);
    const result = notifs
        .filter(n => !n.dismissedBy.includes(uid))
        .map(n => ({
            ...n,
            read: n.readBy.includes(uid),
            dismissed: n.dismissedBy.includes(uid)
        }))
        .sort((a, b) => b.generatedAt - a.generatedAt)
        .slice(0, 50);

    const unreadCount = result.filter(n => !n.read).length;
    res.json({ success: true, notifications: result, unreadCount });
});

// PATCH /api/calendar/notifications/:id/read
app.patch('/api/calendar/notifications/:id/read', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const uid = session.uid;

    const notifs = calendarNotifStore[companyId] || [];
    const notif = notifs.find(n => n.id === req.params.id);
    if (!notif) return res.status(404).json({ success: false, error: 'Notification not found' });

    if (!notif.readBy.includes(uid)) notif.readBy.push(uid);
    saveCalNotifs();
    res.json({ success: true });
});

// PATCH /api/calendar/notifications/:id/dismiss
app.patch('/api/calendar/notifications/:id/dismiss', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const uid = session.uid;

    const notifs = calendarNotifStore[companyId] || [];
    const notif = notifs.find(n => n.id === req.params.id);
    if (!notif) return res.status(404).json({ success: false, error: 'Notification not found' });

    if (!notif.dismissedBy.includes(uid)) notif.dismissedBy.push(uid);
    if (!notif.readBy.includes(uid)) notif.readBy.push(uid);
    saveCalNotifs();
    res.json({ success: true });
});

// PATCH /api/calendar/notifications/read-all
app.patch('/api/calendar/notifications/read-all', (req, res) => {
    const session = requireAuth(req, res);
    if (!session) return;
    const companyId = session.companyName;
    const uid = session.uid;

    const notifs = calendarNotifStore[companyId] || [];
    notifs.forEach(n => { if (!n.readBy.includes(uid)) n.readBy.push(uid); });
    saveCalNotifs();
    res.json({ success: true });
});

// =========================================================================
// ===== END CALENDAR MODULE ===============================================
// =========================================================================

// =========================================================================
// ===== PLATETIMER OPERATIONS MODULE (Sprint 1) ===========================
// Task management for kitchen brigades. Shares auth + company identity with
// the Service side, but has fully separate stores, logic and UI.
// All hierarchy rules live in operations/ops-auth.js (centralized).
// =========================================================================
// Department Account module (Service side) — S1.1 foundation.
const departmentAccounts = require('./service/department-accounts');
departmentAccounts.setPersist(() => saveJSON(DEPARTMENT_ACCOUNTS_FILE, departmentAccounts.getStore()));

const opsAuth         = require('./operations/ops-auth');
const opsEmail        = require('./operations/ops-email');
const opsRecurring    = require('./operations/ops-recurring');
const opsScheduler    = require('./operations/ops-scheduler');
const opsIntelligence = require('./operations/ops-intelligence');
const opsSnapshots    = require('./operations/ops-snapshots');
const opsTrends       = require('./operations/ops-trends');
const opsAssistant    = require('./operations/ops-assistant');
const opsPerformance  = require('./operations/ops-performance');
const opsExceptions   = require('./operations/ops-exceptions');
const opsVisits       = require('./operations/ops-visits');

const OPS_USERS_FILE = path.join(DATA_DIR, 'ops-users.json');
const OPS_TASKS_FILE = path.join(DATA_DIR, 'ops-tasks.json');

// Populated by initializeDataStores() at startup.
// Shape: { [companyId]: [ user, ... ] } / { [companyId]: [ task, ... ] }
let opsUsersStore = {};
let opsTasksStore = {};

const OPS_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
// OVERDUE is computed dynamically (never stored). CANCELLED = soft-deleted.
const OPS_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

const PRIORITY_ORDER = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const EFF_STATUS_ORDER = { OVERDUE: 0, IN_PROGRESS: 1, OPEN: 2, COMPLETED: 3, CANCELLED: 4 };

function genOpsUserId()      { return 'opsu_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'); }
function genOpsTaskId()      { return 'opst_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'); }
function genOpsCommentId()   { return 'opsc_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'); }
function genOpsAttachmentId(){ return 'opsa_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'); }
function genInviteCode()     { return crypto.randomBytes(16).toString('hex'); }

// ── Sprint 3: recurring-template and preference stores ─────────────────────
const OPS_TEMPLATES_FILE = path.join(DATA_DIR, 'ops-templates.json');
const OPS_PREFS_FILE     = path.join(DATA_DIR, 'ops-prefs.json');

// Shape: { [companyId]: [ template, ... ] }
let opsTemplatesStore = {};
// Shape: { [companyId]: { defaults: {...}, users: { [userId]: {...} } } }
let opsPrefsStore = {};

function genTemplateId()    { return opsRecurring.genTemplateId(); }

function getOpsTemplates(companyId) { return opsTemplatesStore[companyId] || []; }
function getOpsUsers(companyId)     { return opsUsersStore[companyId]     || []; }
function getOpsTasks(companyId)     { return opsTasksStore[companyId]     || []; }
function saveOpsUsers()     { saveJSON(OPS_USERS_FILE,     opsUsersStore);     }
function saveOpsTasks()     { saveJSON(OPS_TASKS_FILE,     opsTasksStore);     }
function saveOpsTemplates() { saveJSON(OPS_TEMPLATES_FILE, opsTemplatesStore); }
function saveOpsPrefs()     { saveJSON(OPS_PREFS_FILE,     opsPrefsStore);     }

// Find the ops user record bound to a Firebase uid (across all companies —
// invited users may belong to a company different from their session company).
function findOpsUserByUid(uid) {
    for (const companyId of Object.keys(opsUsersStore)) {
        const u = (opsUsersStore[companyId] || []).find(x => x.uid === uid);
        if (u) return u;
    }
    return null;
}

// [SECURITY] Operations auth guard. Verifies the HMAC session token (shared
// mechanism with the Service side), then resolves the server-side ops user
// record. companyId ALWAYS comes from the server-side record — never from the
// client. Bootstrap rule: if the session's company has no Operations users yet,
// the authenticated account owner becomes its first DIRECTOR.
function requireOpsAuth(req, res) {
    const session = requireAuth(req, res);
    if (!session) return null;

    let opsUser = findOpsUserByUid(session.uid);
    if (!opsUser) {
        const companyId = session.companyName; // verified server-side at token issue time
        if (getOpsUsers(companyId).length === 0) {
            // Bootstrap: existing account owner becomes the company's first Director
            opsUser = {
                id: genOpsUserId(),
                companyId,
                uid: session.uid,
                name: 'Direttore',
                email: null,
                role: 'DIRECTOR',
                active: true,
                status: 'ACTIVE',
                createdAt: Date.now()
            };
            if (!opsUsersStore[companyId]) opsUsersStore[companyId] = [];
            opsUsersStore[companyId].push(opsUser);
            saveOpsUsers();
            console.log(`✅ [OPS] Bootstrapped first DIRECTOR for company "${companyId}" (uid=${session.uid})`);
        } else {
            res.status(403).json({ error: 'Non sei membro di PlateTimer Operations per questa azienda. Chiedi al Direttore un invito.' });
            return null;
        }
    }
    // Status-specific messages must be checked before the generic active flag,
    // because suspend/archive both set active=false.
    if (opsUser.status === 'SUSPENDED') {
        res.status(403).json({ error: 'Account Operations sospeso. Contatta il Direttore.' });
        return null;
    }
    if (opsUser.status === 'ARCHIVED') {
        res.status(403).json({ error: 'Account Operations archiviato. Contatta il Direttore.' });
        return null;
    }
    if (opsUser.active === false) {
        res.status(403).json({ error: 'Account Operations disattivato. Contatta il Direttore.' });
        return null;
    }
    return { session, opsUser };
}

function opsUsersById(companyId) {
    const map = {};
    getOpsUsers(companyId).forEach(u => { map[u.id] = u; });
    return map;
}

function publicOpsUser(u) {
    return {
        id: u.id, name: u.name, email: u.email, role: u.role,
        active: u.active !== false, status: u.status, createdAt: u.createdAt,
        // hasFirebaseAccount: whether this user has a bound Firebase UID.
        // Used by the frontend to warn that Firebase Auth is NOT deleted on record deletion.
        hasFirebaseAccount: !!u.uid,
    };
}

// Compute effective status. OVERDUE if not completed/cancelled and dueDate passed.
function opsTaskWithComputedStatus(t) {
    let effectiveStatus = t.status;
    if (t.status !== 'COMPLETED' && t.status !== 'CANCELLED' && t.dueDate) {
        const due = new Date(t.dueDate).getTime();
        if (!isNaN(due) && Date.now() > due) effectiveStatus = 'OVERDUE';
    }
    return { ...t, effectiveStatus };
}

// [SECURITY] Audit history events are ALWAYS created server-side.
// actorId/actorName come from the verified ops-user session record — never from the client.
function addHistory(task, type, actorId, actorName, data) {
    if (!Array.isArray(task.history)) task.history = [];
    task.history.push({ type, actorId, actorName, at: Date.now(), ...(data || {}) });
}

// Lookup a task by id within a company — returns null for cross-company or missing.
function findOpsTask(companyId, taskId) {
    return (getOpsTasks(companyId) || []).find(t => t.id === taskId) || null;
}

// ── GET /api/operations/me — current ops profile (bootstraps first Director) ──
app.get('/api/operations/me', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    // Allow the user to set their own display name once (harmless, self-only)
    const name = (req.query.name || '').toString().trim();
    if (name && (ctx.opsUser.name === 'Direttore' || !ctx.opsUser.name)) {
        ctx.opsUser.name = name.substring(0, 80);
        saveOpsUsers();
    }
    res.json({ success: true, user: publicOpsUser(ctx.opsUser), companyId: ctx.opsUser.companyId, emailTransport: opsEmail.TRANSPORT });
});

// ── GET /api/operations/users — Director only: full team list ──
// Query: ?status=active|invited|suspended|archived|all
// Default (no param): ACTIVE + INVITED + SUSPENDED — archived excluded from normal view.
app.get('/api/operations/users', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) {
        return res.status(403).json({ error: 'Solo il Direttore può gestire gli utenti.' });
    }
    const statusFilter = (req.query.status || '').toLowerCase();
    let users = getOpsUsers(ctx.opsUser.companyId);
    if      (statusFilter === 'active')    users = users.filter(u => u.status === 'ACTIVE');
    else if (statusFilter === 'invited')   users = users.filter(u => u.status === 'INVITED');
    else if (statusFilter === 'suspended') users = users.filter(u => u.status === 'SUSPENDED');
    else if (statusFilter === 'archived')  users = users.filter(u => u.status === 'ARCHIVED');
    else if (statusFilter === 'all')       { /* no filter */ }
    else    users = users.filter(u => u.status !== 'ARCHIVED'); // default: hide archived
    const result = users.map(u => ({
        ...publicOpsUser(u),
        inviteCode: u.status === 'INVITED' ? u.inviteCode : undefined
    }));
    res.json({ success: true, users: result });
});

// ── GET /api/operations/assignees — users the actor may assign tasks to (UX) ──
app.get('/api/operations/assignees', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const allowed = opsAuth.allowedAssignees(ctx.opsUser, getOpsUsers(ctx.opsUser.companyId));
    res.json({ success: true, assignees: allowed.map(publicOpsUser) });
});

// ── POST /api/operations/users — Director only: invite a new team member ──
// [SECURITY] companyId ALWAYS from the Director's server-side record. role
// validated server-side. Client-supplied companyId/uid are ignored.
app.post('/api/operations/users', async (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) {
        console.log(`⛔ [OPS-SECURITY] user-create rejected — actor role ${ctx.opsUser.role} (uid=${ctx.session.uid})`);
        return res.status(403).json({ error: 'Solo il Direttore può creare utenti.' });
    }
    const companyId = ctx.opsUser.companyId; // never from client
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const role = (req.body.role || '').trim();

    if (!name) return res.status(400).json({ error: 'Nome obbligatorio.' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email non valida.' });
    if (!opsAuth.isValidRole(role)) return res.status(400).json({ error: `Ruolo non valido. Ruoli ammessi: ${opsAuth.ROLES.join(', ')}` });
    if (getOpsUsers(companyId).some(u => u.email === email)) {
        return res.status(409).json({ error: 'Esiste già un utente con questa email in azienda.' });
    }

    const user = {
        id: genOpsUserId(),
        companyId,
        uid: null,               // bound at activation — invitee can never choose company
        name: name.substring(0, 80),
        email,
        role,
        active: true,
        status: 'INVITED',
        inviteCode: genInviteCode(),
        invitedBy: ctx.opsUser.id,
        createdAt: Date.now()
    };
    if (!opsUsersStore[companyId]) opsUsersStore[companyId] = [];
    opsUsersStore[companyId].push(user);
    saveOpsUsers();
    console.log(`✅ [OPS] User invited: ${email} (${role}) in company "${companyId}" by ${ctx.opsUser.id}`);

    // [SECURITY] Activation link is built from APP_BASE_URL (trusted server config),
    // never from request headers or client-supplied host. Relative path used as
    // fallback for development; production must set APP_BASE_URL.
    const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const activationPath = `/operations-activate.html?code=${user.inviteCode}`;
    const activationUrl = baseUrl ? `${baseUrl}${activationPath}` : activationPath;

    // Attempt invitation email AFTER persist. Failure is non-fatal and logged.
    let emailResult = { result: opsEmail.RESULT.FAILED, transport: opsEmail.TRANSPORT, reason: 'not attempted' };
    try {
        emailResult = await opsEmail.sendInvitationEmail({
            to: email,
            toName: name,
            role,
            invitedByName: ctx.opsUser.name,
            activationUrl
        });
    } catch (e) {
        console.error('📧 [OPS-EMAIL] invite email unexpected error (non-fatal):', e.message);
    }
    console.log(`📧 [OPS] Invitation email result: ${emailResult.result} (transport: ${emailResult.transport}) for ${email}`);

    broadcastOps(companyId, { action: 'OPS_USER_CREATED', user: publicOpsUser(user) });
    res.status(201).json({
        success: true,
        user: { ...publicOpsUser(user), inviteCode: user.inviteCode },
        activationUrl: activationPath,       // relative path — always safe to return to Director
        emailResult: emailResult.result,     // SENT | FAILED
        emailNote: emailResult.result === opsEmail.RESULT.SENT
            ? 'Email di invito inviata.'
            : (opsEmail.TRANSPORT === 'logging'
                ? 'Nessun provider email configurato: condividi manualmente il link di attivazione.'
                : 'Invio email non riuscito: condividi manualmente il link di attivazione.')
    });
});

// ── POST /api/operations/users/:id/resend-invite — Director only: resend invitation email ──
// Rules: Director only, same company, invitation still INVITED status, no new user, no role/company change.
app.post('/api/operations/users/:id/resend-invite', async (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) {
        return res.status(403).json({ error: 'Solo il Direttore può reinviare gli inviti.' });
    }
    const companyId = ctx.opsUser.companyId;
    const users = getOpsUsers(companyId);
    const target = users.find(u => u.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Utente non trovato.' });
    if (target.status !== 'INVITED') {
        return res.status(400).json({ error: 'L\'utente ha già attivato l\'account o non è in stato di invito.' });
    }
    // Build activation URL from trusted server config — never from request headers.
    const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const activationPath = `/operations-activate.html?code=${target.inviteCode}`;
    const activationUrl = baseUrl ? `${baseUrl}${activationPath}` : activationPath;

    let emailResult = { result: opsEmail.RESULT.FAILED, transport: opsEmail.TRANSPORT };
    try {
        emailResult = await opsEmail.sendInvitationEmail({
            to: target.email,
            toName: target.name,
            role: target.role,
            invitedByName: ctx.opsUser.name,
            activationUrl
        });
    } catch (e) {
        console.error('📧 [OPS-EMAIL] resend invite unexpected error (non-fatal):', e.message);
    }
    console.log(`📧 [OPS] Resend invite result: ${emailResult.result} → ${target.email} by Director ${ctx.opsUser.id}`);

    res.json({
        success: true,
        emailResult: emailResult.result,
        emailNote: emailResult.result === opsEmail.RESULT.SENT
            ? 'Email di invito reinviata.'
            : 'Reinvio email non riuscito. Condividi il link manualmente.',
        activationUrl: activationPath
    });
});

// ── PUT /api/operations/users/:id — Director only: edit user fields ──
// Editable: name (all statuses), role (all, not self), email (INVITED only — no Firebase uid yet).
// Legacy: {active: boolean} still accepted for backwards compat with older clients.
app.put('/api/operations/users/:id', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) {
        return res.status(403).json({ error: 'Solo il Direttore può gestire gli utenti.' });
    }
    const companyId = ctx.opsUser.companyId;
    const users = getOpsUsers(companyId); // company isolation: only own company searched
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Utente non trovato.' });

    // Legacy: active toggle (kept for backwards compatibility)
    if (typeof req.body.active === 'boolean') {
        if (user.id === ctx.opsUser.id && req.body.active === false) {
            return res.status(400).json({ error: 'Non puoi disattivare il tuo stesso account.' });
        }
        user.active = req.body.active;
    }

    // Name
    if (req.body.name !== undefined) {
        const name = req.body.name.toString().trim().substring(0, 80);
        if (!name) return res.status(400).json({ error: 'Nome obbligatorio.' });
        user.name = name;
    }

    // Email — editable only for INVITED users (no Firebase uid bound yet).
    // Once the user activates (uid set), their Firebase email is the identity; changing
    // it here would desync the ops record from Firebase Auth.
    if (req.body.email !== undefined) {
        if (user.status !== 'INVITED' || user.uid) {
            return res.status(400).json({ error: 'L\'email non è modificabile per utenti già attivati (account Firebase già collegato).' });
        }
        const email = req.body.email.toString().trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Email non valida.' });
        }
        if (users.some(u => u.email === email && u.id !== user.id)) {
            return res.status(409).json({ error: 'Esiste già un utente con questa email in azienda.' });
        }
        user.email = email;
    }

    // Role — [SECURITY] cannot change own role; validates against known roles.
    if (req.body.role !== undefined) {
        const role = req.body.role.toString().trim();
        if (!opsAuth.isValidRole(role)) {
            return res.status(400).json({ error: `Ruolo non valido. Ruoli ammessi: ${opsAuth.ROLES.join(', ')}` });
        }
        if (user.id === ctx.opsUser.id) {
            return res.status(400).json({ error: 'Non puoi modificare il tuo stesso ruolo.' });
        }
        user.role = role;
    }

    user.updatedAt = Date.now();
    saveOpsUsers();
    console.log(`✅ [OPS] User ${user.id} updated by Director ${ctx.opsUser.id} (company "${companyId}")`);
    broadcastOps(companyId, { action: 'OPS_USER_UPDATED', user: publicOpsUser(user) });
    res.json({ success: true, user: publicOpsUser(user) });
});

// ── POST /api/operations/users/:id/suspend — Director only ──
app.post('/api/operations/users/:id/suspend', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può sospendere gli utenti.' });
    const companyId = ctx.opsUser.companyId;
    const user = getOpsUsers(companyId).find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Utente non trovato.' });
    if (!opsAuth.canManageOpsUser(ctx.opsUser, user)) return res.status(403).json({ error: 'Non puoi sospendere questo utente.' });
    if (user.status === 'SUSPENDED') return res.status(400).json({ error: 'L\'utente è già sospeso.' });
    // Count open tasks so Director is aware
    const openTasks = getOpsTasks(companyId).filter(t =>
        t.assigneeId === user.id && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
    ).length;
    user.status = 'SUSPENDED';
    user.active = false;
    user.suspendedAt = Date.now();
    user.updatedAt   = Date.now();
    saveOpsUsers();
    console.log(`✅ [OPS] User ${user.id} suspended by Director ${ctx.opsUser.id} (company "${companyId}", openTasks=${openTasks})`);
    broadcastOps(companyId, { action: 'OPS_USER_SUSPENDED', user: publicOpsUser(user) });
    res.json({ success: true, user: publicOpsUser(user), openTasks });
});

// ── POST /api/operations/users/:id/reactivate — Director only (SUSPENDED → ACTIVE) ──
app.post('/api/operations/users/:id/reactivate', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può riattivare gli utenti.' });
    const companyId = ctx.opsUser.companyId;
    const user = getOpsUsers(companyId).find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Utente non trovato.' });
    if (!opsAuth.canManageOpsUser(ctx.opsUser, user)) return res.status(403).json({ error: 'Non puoi riattivare questo utente.' });
    if (user.status !== 'SUSPENDED') return res.status(400).json({ error: 'L\'utente non è sospeso.' });
    user.status = 'ACTIVE';
    user.active = true;
    user.reactivatedAt = Date.now();
    user.updatedAt     = Date.now();
    saveOpsUsers();
    console.log(`✅ [OPS] User ${user.id} reactivated by Director ${ctx.opsUser.id} (company "${companyId}")`);
    broadcastOps(companyId, { action: 'OPS_USER_RESTORED', user: publicOpsUser(user) });
    res.json({ success: true, user: publicOpsUser(user) });
});

// ── POST /api/operations/users/:id/archive — Director only ──
app.post('/api/operations/users/:id/archive', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può archiviare gli utenti.' });
    const companyId = ctx.opsUser.companyId;
    const user = getOpsUsers(companyId).find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Utente non trovato.' });
    if (!opsAuth.canManageOpsUser(ctx.opsUser, user)) return res.status(403).json({ error: 'Non puoi archiviare questo utente.' });
    if (user.status === 'ARCHIVED') return res.status(400).json({ error: 'L\'utente è già archiviato.' });
    user.status = 'ARCHIVED';
    user.active = false;
    user.archivedAt = Date.now();
    user.updatedAt  = Date.now();
    saveOpsUsers();
    console.log(`✅ [OPS] User ${user.id} archived by Director ${ctx.opsUser.id} (company "${companyId}")`);
    broadcastOps(companyId, { action: 'OPS_USER_ARCHIVED', user: publicOpsUser(user) });
    res.json({ success: true, user: publicOpsUser(user) });
});

// ── POST /api/operations/users/:id/restore — Director only (ARCHIVED → ACTIVE) ──
app.post('/api/operations/users/:id/restore', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può ripristinare gli utenti.' });
    const companyId = ctx.opsUser.companyId;
    const user = getOpsUsers(companyId).find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Utente non trovato.' });
    if (!opsAuth.canManageOpsUser(ctx.opsUser, user)) return res.status(403).json({ error: 'Non puoi ripristinare questo utente.' });
    if (user.status !== 'ARCHIVED') return res.status(400).json({ error: 'L\'utente non è archiviato.' });
    user.status = 'ACTIVE';
    user.active = true;
    user.restoredAt = Date.now();
    user.updatedAt  = Date.now();
    saveOpsUsers();
    console.log(`✅ [OPS] User ${user.id} restored by Director ${ctx.opsUser.id} (company "${companyId}")`);
    broadcastOps(companyId, { action: 'OPS_USER_RESTORED', user: publicOpsUser(user) });
    res.json({ success: true, user: publicOpsUser(user) });
});

// ── DELETE /api/operations/users/:id — Director only: permanent deletion ──
// [SECURITY] Only allowed when the user has NO historical/operational dependencies.
// If the user has a Firebase uid, the Firebase Auth account is NOT deleted here —
// Firebase Admin Auth is not configured for this project. The ops record is removed,
// preventing Operations access; the Firebase account becomes an orphan but cannot
// re-enter the system (bootstrap only fires for companies with zero ops users).
app.delete('/api/operations/users/:id', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può eliminare gli utenti.' });
    const companyId = ctx.opsUser.companyId;
    const users = getOpsUsers(companyId);
    const idx   = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Utente non trovato.' });
    const user = users[idx];
    if (!opsAuth.canDeleteOpsUser(ctx.opsUser, user)) {
        return res.status(403).json({ error: 'Non puoi eliminare questo utente.' });
    }
    const hasDeps = opsAuth.hasUserDependencies(user.id, getOpsTasks(companyId), getOpsTemplates(companyId));
    if (hasDeps) {
        return res.status(409).json({
            error: 'Questo utente possiede dati storici. Archivialo invece di eliminarlo.',
            suggestArchive: true
        });
    }
    const hadFirebaseAccount = !!user.uid;
    opsUsersStore[companyId].splice(idx, 1);
    saveOpsUsers();
    console.log(`✅ [OPS] User ${user.id} permanently deleted by Director ${ctx.opsUser.id} (company "${companyId}", hadFirebase=${hadFirebaseAccount})`);
    broadcastOps(companyId, { action: 'OPS_USER_DELETED', userId: user.id });
    res.json({
        success: true,
        firebaseNote: hadFirebaseAccount
            ? 'Account Operations eliminato. L\'account Firebase Authentication associato NON è stato eliminato — richiede intervento manuale nella Firebase Console.'
            : null
    });
});

// ── GET /api/operations/invitations/:code — public info for the activation page ──
// The invite code itself is the secret; reveals only what the invitee needs.
app.get('/api/operations/invitations/:code', (req, res) => {
    const code = (req.params.code || '').trim();
    for (const companyId of Object.keys(opsUsersStore)) {
        const u = (opsUsersStore[companyId] || []).find(x => x.inviteCode === code && x.status === 'INVITED');
        if (u) return res.json({ success: true, invitation: { name: u.name, email: u.email, role: u.role, companyId } });
    }
    res.status(404).json({ error: 'Invito non valido o già utilizzato.' });
});

// ── POST /api/operations/activate — invitee binds their Firebase account ──
// [SECURITY] Requires a valid Firebase ID token; the token's email must match
// the invitation email. companyId stays what the Director set — the invitee
// can never choose or change it.
app.post('/api/operations/activate', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Firebase ID token richiesto.' });
        }
        const idToken = authHeader.substring(7).trim();
        const code = (req.body.code || '').trim();
        if (!code) return res.status(400).json({ error: 'Codice invito mancante.' });

        // Verify Firebase token and get uid + email
        const lookupResp = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
        );
        if (!lookupResp.ok) return res.status(401).json({ error: 'Token Firebase non valido.' });
        const lookupData = await lookupResp.json();
        const fbUser = lookupData.users && lookupData.users[0];
        if (!fbUser) return res.status(401).json({ error: 'Token Firebase non valido.' });
        const uid = fbUser.localId;

        // Find invitation
        let invited = null, invitedCompany = null;
        for (const companyId of Object.keys(opsUsersStore)) {
            const u = (opsUsersStore[companyId] || []).find(x => x.inviteCode === code && x.status === 'INVITED');
            if (u) { invited = u; invitedCompany = companyId; break; }
        }
        // [SECURITY] Centralized activation validation: invitation must exist,
        // token email must match AND be VERIFIED (prevents account takeover via
        // unverified Firebase accounts created for someone else's address).
        const validation = opsAuth.validateActivationAccount(fbUser, invited);
        if (!validation.ok) {
            console.log(`⛔ [OPS-SECURITY] activation rejected (${validation.code}) for uid=${uid}`);
            return res.status(validation.code).json({ error: validation.error, needsEmailVerification: validation.code === 403 && fbUser.emailVerified !== true });
        }
        if (findOpsUserByUid(uid)) {
            return res.status(409).json({ error: 'Questo account è già collegato a PlateTimer Operations.' });
        }

        invited.uid = uid;
        invited.status = 'ACTIVE';
        delete invited.inviteCode;
        invited.activatedAt = Date.now();
        saveOpsUsers();
        console.log(`✅ [OPS] Invitation activated → company "${invitedCompany}" (uid=${uid})`);
        broadcastOps(invitedCompany, { action: 'OPS_INVITATION_ACCEPTED', userId: invited.id, role: invited.role });
        res.json({ success: true, companyId: invitedCompany, role: invited.role });
    } catch (e) {
        console.error('❌ [OPS] activation error:', e);
        res.status(500).json({ error: 'Errore interno durante l\'attivazione.' });
    }
});

// ── Task input sanitizers ──
function sanitizeOpsTaskInput(body) {
    const title = (body.title || '').trim();
    if (!title) throw 'Titolo obbligatorio.';
    if (title.length > 200) throw 'Titolo troppo lungo (max 200).';
    const description = (body.description || '').toString().trim().substring(0, 2000);
    const priority = OPS_PRIORITIES.includes(body.priority) ? body.priority : 'MEDIUM';
    let dueDate = null;
    if (body.dueDate) {
        const d = new Date(body.dueDate);
        if (isNaN(d.getTime())) throw 'Data di scadenza non valida.';
        dueDate = body.dueDate;
    }
    const department = body.department ? body.department.toString().trim().substring(0, 80) : null;
    const notes = body.notes !== undefined ? body.notes.toString().trim().substring(0, 5000) : undefined;
    return { title, description, priority, dueDate, department, ...(notes !== undefined ? { notes } : {}) };
}

// Patch sanitizer — only the fields present in the body are sanitized/returned.
function sanitizeOpsTaskPatch(body) {
    const out = {};
    if (body.title !== undefined) {
        const t = body.title.toString().trim();
        if (!t) throw 'Titolo obbligatorio.';
        if (t.length > 200) throw 'Titolo troppo lungo (max 200).';
        out.title = t;
    }
    if (body.description !== undefined) out.description = body.description.toString().trim().substring(0, 2000);
    if (body.priority !== undefined) {
        if (!OPS_PRIORITIES.includes(body.priority)) throw `Priorità non valida. Valori ammessi: ${OPS_PRIORITIES.join(', ')}`;
        out.priority = body.priority;
    }
    if (body.dueDate !== undefined) {
        if (body.dueDate === null || body.dueDate === '') { out.dueDate = null; }
        else {
            const d = new Date(body.dueDate);
            if (isNaN(d.getTime())) throw 'Data di scadenza non valida.';
            out.dueDate = body.dueDate;
        }
    }
    if (body.department !== undefined) out.department = body.department ? body.department.toString().trim().substring(0, 80) : null;
    if (body.notes !== undefined) out.notes = body.notes.toString().trim().substring(0, 5000);
    return out;
}

// ── POST /api/operations/tasks — create (hierarchy-enforced assignment) ──
// [SECURITY] companyId + createdBy from the server-side ops record; forged
// companyId/createdBy/status/completedAt in the payload are ignored.
app.post('/api/operations/tasks', async (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const companyId = actor.companyId;

    let clean;
    try { clean = sanitizeOpsTaskInput(req.body); }
    catch (msg) { return res.status(400).json({ error: msg }); }

    const assigneeId = (req.body.assigneeId || actor.id).toString();
    const byId = opsUsersById(companyId); // only own-company users resolvable
    const assignee = byId[assigneeId];
    if (!assignee || assignee.active === false) {
        console.log(`⛔ [OPS-SECURITY] task-create rejected — assignee "${assigneeId}" not found/active in company "${companyId}"`);
        return res.status(400).json({ error: 'Assegnatario non valido.' });
    }
    if (!opsAuth.canAssignTaskTo(actor, assignee)) {
        console.log(`⛔ [OPS-SECURITY] task-create rejected — ${actor.role} cannot assign to ${assignee.role} (company "${companyId}")`);
        return res.status(403).json({ error: `Il tuo ruolo (${actor.role}) non può assegnare compiti a ${assignee.role}.` });
    }

    const now = Date.now();
    const task = {
        id: genOpsTaskId(),
        companyId,
        title: clean.title,
        description: clean.description,
        assigneeId: assignee.id,
        assigneeName: assignee.name,   // snapshot for display/search
        createdBy: actor.id,           // always from session — never from payload
        createdByName: actor.name,     // snapshot
        priority: clean.priority,
        status: 'OPEN',
        dueDate: clean.dueDate,
        department: clean.department,
        notes: '',
        completionPercent: 0,
        startedAt: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        attachments: [],               // metadata only — actual upload not yet wired
        comments: [],
        history: [],
        // Sprint 3: recurring template link (null for manually created tasks)
        templateId:       null,
        occurrenceKey:    null,
        // Sprint 3: reminder — days before dueDate to send reminder email (null = none)
        reminderDays:     req.body.reminderDays != null ? Number(req.body.reminderDays) : null,
        reminderSentAt:   null,
        // Sprint 3: escalation config
        escalation: {
            enabled:                req.body.escalation && req.body.escalation.enabled === true,
            waitHoursAfterDue:      Number((req.body.escalation || {}).waitHoursAfterDue)    || 24,
            waitHoursBetweenLevels: Number((req.body.escalation || {}).waitHoursBetweenLevels) || 24,
        },
        escalationLevel:    0,
        escalationSentAt:   null,
        escalationNotified: [],
    };
    addHistory(task, 'TASK_CREATED', actor.id, actor.name, {
        assigneeId: assignee.id, assigneeName: assignee.name,
        priority: task.priority, dueDate: task.dueDate
    });
    if (!opsTasksStore[companyId]) opsTasksStore[companyId] = [];
    opsTasksStore[companyId].push(task);
    saveOpsTasks(); // persist FIRST …
    console.log(`✅ [OPS] Task created: "${task.title}" → ${assignee.name} (${assignee.role}) in "${companyId}"`);

    // … THEN notify (failures logged, NEVER affect the saved task).
    // RESULT enum: SENT | FAILED | SKIPPED (self-assigned)
    let notificationResult = opsEmail.RESULT.SKIPPED;
    if (assignee.id !== actor.id) {
        try {
            const emailRes = await opsEmail.sendTaskAssignmentEmail({
                to: assignee.email,
                toName: assignee.name,
                task,
                assignedByName: actor.name,
                appUrl: '/operations-tasks.html'
            });
            notificationResult = emailRes.result;
        } catch (e) {
            console.error('📧 [OPS-EMAIL] task notification unexpected error (non-fatal):', e.message);
            notificationResult = opsEmail.RESULT.FAILED;
        }
        console.log(`📧 [OPS] Task notification: ${notificationResult} → ${assignee.email} (task: ${task.id})`);
    }

    broadcastOps(companyId, { action: 'OPS_TASK_CREATED', task: opsTaskWithComputedStatus(task) });
    res.status(201).json({ success: true, task: opsTaskWithComputedStatus(task), notificationResult });
});

// ── GET /api/operations/tasks — list, SERVER-FILTERED per hierarchy ──
// Query params (applied AFTER visibility — cannot expose unauthorized data):
//   my=1         → only assigned to me
//   status=OPEN|IN_PROGRESS|COMPLETED|CANCELLED|OVERDUE
//   priority=LOW|MEDIUM|HIGH|URGENT
//   assigneeId=<id>
//   department=<string>   (substring match)
//   q=<text>              (title+description+assigneeName+department)
//   sort=dueDate|priority|createdAt|status|assignee  (default: smart)
app.get('/api/operations/tasks', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const byId = opsUsersById(actor.companyId);

    // Visibility is always server-enforced first
    let tasks = getOpsTasks(actor.companyId)
        .filter(t => opsAuth.canViewTask(actor, t, byId))
        .map(opsTaskWithComputedStatus);

    const { status, priority, assigneeId, department, q, sort, my: myOnly } = req.query;
    if (myOnly === '1') tasks = tasks.filter(t => t.assigneeId === actor.id);
    if (status) {
        const s = status.toUpperCase();
        tasks = tasks.filter(t => s === 'OVERDUE' ? t.effectiveStatus === 'OVERDUE' : t.status === s);
    }
    if (priority && OPS_PRIORITIES.includes(priority.toUpperCase()))
        tasks = tasks.filter(t => t.priority === priority.toUpperCase());
    if (assigneeId) tasks = tasks.filter(t => t.assigneeId === assigneeId);
    if (department) tasks = tasks.filter(t => (t.department || '').toLowerCase().includes(department.toLowerCase()));
    if (q) {
        const lq = q.toLowerCase();
        tasks = tasks.filter(t =>
            t.title.toLowerCase().includes(lq) ||
            (t.description || '').toLowerCase().includes(lq) ||
            (t.assigneeName || '').toLowerCase().includes(lq) ||
            (t.department || '').toLowerCase().includes(lq));
    }

    switch ((sort || '').toLowerCase()) {
        case 'priority': tasks.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)); break;
        case 'createdat': tasks.sort((a, b) => b.createdAt - a.createdAt); break;
        case 'duedate': tasks.sort((a, b) => (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1); break;
        case 'assignee': tasks.sort((a, b) => (a.assigneeName || '').localeCompare(b.assigneeName || '')); break;
        case 'status': tasks.sort((a, b) => (EFF_STATUS_ORDER[a.effectiveStatus] ?? 9) - (EFF_STATUS_ORDER[b.effectiveStatus] ?? 9)); break;
        default: // smart: OVERDUE → due-soon IN_PROGRESS → OPEN → COMPLETED → CANCELLED
            tasks.sort((a, b) => {
                const sa = EFF_STATUS_ORDER[a.effectiveStatus] ?? 9;
                const sb = EFF_STATUS_ORDER[b.effectiveStatus] ?? 9;
                if (sa !== sb) return sa - sb;
                return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1;
            });
    }

    const usersPublic = {};
    Object.values(byId).forEach(u => { usersPublic[u.id] = { id: u.id, name: u.name, role: u.role }; });
    res.json({ success: true, tasks, users: usersPublic, me: publicOpsUser(actor) });
});

// ── PUT /api/operations/tasks/:id — legacy combined endpoint (kept for backward compat) ──
// New callers should prefer the explicit action endpoints below.
app.put('/api/operations/tasks/:id', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const companyId = actor.companyId;
    const tasks = getOpsTasks(companyId);
    const task = tasks.find(t => t.id === req.params.id);
    const byId = opsUsersById(companyId);
    if (!task || !opsAuth.canViewTask(actor, task, byId)) {
        return res.status(404).json({ error: 'Compito non trovato.' });
    }

    const wantsComplete = req.body.status === 'COMPLETED';
    const wantsStatus = typeof req.body.status === 'string' && !wantsComplete;
    const wantsEdit = ['title', 'description', 'priority', 'dueDate', 'assigneeId', 'department']
        .some(k => req.body[k] !== undefined);

    if (wantsComplete) {
        if (!opsAuth.canCompleteTask(actor, task)) {
            console.log(`⛔ [OPS-SECURITY] complete rejected — actor ${actor.id} is not assignee of ${task.id}`);
            return res.status(403).json({ error: 'Solo l\'assegnatario può completare il compito.' });
        }
        if (task.status !== 'COMPLETED') {
            const prevStatus = task.status;
            task.status = 'COMPLETED';
            task.completedAt = Date.now();
            if (typeof task.completionPercent !== 'number' || task.completionPercent < 100) task.completionPercent = 100;
            addHistory(task, 'TASK_COMPLETED', actor.id, actor.name, { from: prevStatus, to: 'COMPLETED' });
        }
    } else if (wantsStatus) {
        if (!OPS_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Stato non valido.' });
        if (!opsAuth.canCompleteTask(actor, task) && !opsAuth.canEditTask(actor, task, byId)) {
            return res.status(403).json({ error: 'Non autorizzato a modificare lo stato.' });
        }
        const prevStatus = task.status;
        if (task.status === 'COMPLETED' && req.body.status !== 'COMPLETED') { task.completedAt = null; task.completionPercent = 0; }
        if (req.body.status === 'IN_PROGRESS' && !task.startedAt) task.startedAt = Date.now();
        task.status = req.body.status;
        if (prevStatus !== task.status) addHistory(task, 'STATUS_CHANGED', actor.id, actor.name, { from: prevStatus, to: task.status });
    }

    if (wantsEdit) {
        if (!opsAuth.canEditTask(actor, task, byId)) {
            return res.status(403).json({ error: 'Non autorizzato a modificare questo compito.' });
        }
        try {
            if (req.body.title !== undefined || req.body.description !== undefined ||
                req.body.priority !== undefined || req.body.dueDate !== undefined ||
                req.body.department !== undefined) {
                const prevPriority = task.priority, prevDue = task.dueDate;
                const clean = sanitizeOpsTaskInput({ ...task, ...req.body });
                task.title = clean.title;
                task.description = clean.description;
                task.priority = clean.priority;
                task.dueDate = clean.dueDate;
                task.department = clean.department;
                addHistory(task, 'TASK_EDITED', actor.id, actor.name, {
                    ...(prevPriority !== task.priority ? { priorityFrom: prevPriority, priorityTo: task.priority } : {}),
                    ...(prevDue !== task.dueDate ? { dueDateFrom: prevDue, dueDateTo: task.dueDate } : {})
                });
            }
        } catch (msg) { return res.status(400).json({ error: msg }); }

        if (req.body.assigneeId !== undefined) {
            const newAssignee = byId[req.body.assigneeId];
            if (!newAssignee || newAssignee.active === false) return res.status(400).json({ error: 'Assegnatario non valido.' });
            if (!opsAuth.canAssignTaskTo(actor, newAssignee)) {
                console.log(`⛔ [OPS-SECURITY] reassign rejected — ${actor.role} → ${newAssignee.role}`);
                return res.status(403).json({ error: `Il tuo ruolo non può assegnare compiti a ${newAssignee.role}.` });
            }
            const oldAssigneeId = task.assigneeId;
            const oldAssigneeName = task.assigneeName;
            task.assigneeId = newAssignee.id;
            task.assigneeName = newAssignee.name;
            if (newAssignee.id !== oldAssigneeId) {
                addHistory(task, 'ASSIGNEE_CHANGED', actor.id, actor.name, {
                    from: oldAssigneeId, fromName: oldAssigneeName,
                    to: newAssignee.id, toName: newAssignee.name
                });
            }
            if (newAssignee.id !== actor.id && newAssignee.id !== oldAssigneeId) {
                setImmediate(() => {
                    opsEmail.sendTaskAssignmentEmail({
                        to: newAssignee.email, toName: newAssignee.name, task,
                        assignedByName: actor.name, appUrl: '/operations-tasks.html'
                    }).catch(e => console.error('📧 [OPS-EMAIL] reassignment notification failed (non-fatal):', e.message));
                });
            }
        }
    }

    task.updatedAt = Date.now();
    saveOpsTasks();
    broadcastOps(companyId, { action: 'OPS_TASK_UPDATED', task: opsTaskWithComputedStatus(task) });
    res.json({ success: true, task: opsTaskWithComputedStatus(task) });
});

// =========================================================================
// ===== SPRINT 2 — EXPLICIT TASK ACTION ENDPOINTS =========================
// =========================================================================

// Helper — find task visible to actor or 404
function requireOpsTask(req, res, ctx) {
    const actor = ctx.opsUser;
    const byId = opsUsersById(actor.companyId);
    const task = findOpsTask(actor.companyId, req.params.id);
    if (!task || !opsAuth.canViewTask(actor, task, byId)) {
        res.status(404).json({ error: 'Compito non trovato.' });
        return null;
    }
    return { task, byId };
}

// ── GET /api/operations/tasks/:id — full task detail (history + comments) ──
app.get('/api/operations/tasks/:id', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const r = requireOpsTask(req, res, ctx);
    if (!r) return;
    const usersPublic = {};
    Object.values(r.byId).forEach(u => { usersPublic[u.id] = { id: u.id, name: u.name, role: u.role }; });
    res.json({ success: true, task: opsTaskWithComputedStatus(r.task), users: usersPublic, me: publicOpsUser(ctx.opsUser) });
});

// ── PATCH /api/operations/tasks/:id — field-level edit (canEditTask) ──
// [SECURITY] Only explicit approved fields patched — no bulk object replacement.
// Immutable fields (companyId, createdBy, history, etc.) are never touched here.
app.patch('/api/operations/tasks/:id', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const r = requireOpsTask(req, res, ctx);
    if (!r) return;
    const { task, byId } = r;

    if (!opsAuth.canEditTask(actor, task, byId)) {
        console.log(`⛔ [OPS-SECURITY] PATCH rejected — ${actor.role} ${actor.id} cannot edit task ${task.id}`);
        return res.status(403).json({ error: 'Non autorizzato a modificare questo compito.' });
    }

    let patch;
    try { patch = sanitizeOpsTaskPatch(req.body); }
    catch (msg) { return res.status(400).json({ error: msg }); }

    if (Object.keys(patch).length === 0)
        return res.status(400).json({ error: 'Nessun campo modificabile fornito.' });

    const histData = {};
    if (patch.priority !== undefined && patch.priority !== task.priority)
        histData.priorityFrom = task.priority, histData.priorityTo = patch.priority;
    if (patch.dueDate !== undefined && patch.dueDate !== task.dueDate)
        histData.dueDateFrom = task.dueDate, histData.dueDateTo = patch.dueDate;
    if (patch.title !== undefined && patch.title !== task.title) histData.titleChanged = true;
    if (patch.description !== undefined && patch.description !== task.description) histData.descriptionChanged = true;
    if (patch.notes !== undefined && patch.notes !== task.notes) histData.notesChanged = true;
    if (patch.department !== undefined && patch.department !== task.department)
        histData.departmentFrom = task.department, histData.departmentTo = patch.department;

    Object.assign(task, patch);
    addHistory(task, 'TASK_EDITED', actor.id, actor.name, histData);
    task.updatedAt = Date.now();
    saveOpsTasks();
    console.log(`✅ [OPS] Task patched: ${task.id} by ${actor.id} — fields: ${Object.keys(patch).join(',')}`);
    broadcastOps(actor.companyId, { action: 'OPS_TASK_UPDATED', task: opsTaskWithComputedStatus(task) });
    res.json({ success: true, task: opsTaskWithComputedStatus(task) });
});

// ── POST /api/operations/tasks/:id/start — assignee starts task ──
app.post('/api/operations/tasks/:id/start', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const r = requireOpsTask(req, res, ctx);
    if (!r) return;
    const { task } = r;

    if (!opsAuth.canCompleteTask(actor, task)) // assignee-only guard reused
        return res.status(403).json({ error: 'Solo l\'assegnatario può avviare il compito.' });
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED')
        return res.status(400).json({ error: 'Il compito non può essere avviato in questo stato.' });

    const prevStatus = task.status;
    task.status = 'IN_PROGRESS';
    if (!task.startedAt) task.startedAt = Date.now();
    if ((task.completionPercent || 0) === 0) task.completionPercent = 0; // stays 0 — updated separately
    addHistory(task, 'TASK_STARTED', actor.id, actor.name, { from: prevStatus });
    task.updatedAt = Date.now();
    saveOpsTasks();
    broadcastOps(actor.companyId, { action: 'OPS_TASK_UPDATED', task: opsTaskWithComputedStatus(task) });
    res.json({ success: true, task: opsTaskWithComputedStatus(task) });
});

// ── POST /api/operations/tasks/:id/progress — update completion percent ──
// [SECURITY] canUpdateProgress: assignee OR editor (Director/creator with visibility)
app.post('/api/operations/tasks/:id/progress', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const r = requireOpsTask(req, res, ctx);
    if (!r) return;
    const { task, byId } = r;

    if (!opsAuth.canUpdateProgress(actor, task, byId))
        return res.status(403).json({ error: 'Non autorizzato ad aggiornare il progresso.' });
    if (task.status === 'CANCELLED')
        return res.status(400).json({ error: 'Impossibile aggiornare un compito cancellato.' });

    const pct = parseInt(req.body.completionPercent, 10);
    if (isNaN(pct) || pct < 0 || pct > 100)
        return res.status(400).json({ error: 'completionPercent deve essere un intero tra 0 e 100.' });

    const prevPct = task.completionPercent || 0;
    const prevStatus = task.status;
    task.completionPercent = pct;

    // Auto-transition rules (spec §4)
    if (pct === 100) {
        task.status = 'COMPLETED';
        if (!task.completedAt) task.completedAt = Date.now();
        if (!task.startedAt) task.startedAt = task.completedAt;
        addHistory(task, 'TASK_COMPLETED', actor.id, actor.name, { from: prevStatus, to: 'COMPLETED' });
    } else if (pct > 0 && task.status === 'OPEN') {
        task.status = 'IN_PROGRESS';
        if (!task.startedAt) task.startedAt = Date.now();
        addHistory(task, 'TASK_STARTED', actor.id, actor.name, { from: 'OPEN' });
    } else if (pct === 0 && task.status === 'IN_PROGRESS') {
        // Allow reverting to OPEN if progress is reset to 0
        task.status = 'OPEN';
        task.startedAt = null;
    }
    if (prevPct !== pct)
        addHistory(task, 'PROGRESS_CHANGED', actor.id, actor.name, { from: prevPct, to: pct });

    task.updatedAt = Date.now();
    saveOpsTasks();
    // Emit COMPLETED if progress hit 100 (auto-completed), else PROGRESS
    broadcastOps(actor.companyId, {
        action: task.status === 'COMPLETED' ? 'OPS_TASK_COMPLETED' : 'OPS_TASK_PROGRESS',
        task: opsTaskWithComputedStatus(task)
    });
    res.json({ success: true, task: opsTaskWithComputedStatus(task) });
});

// ── POST /api/operations/tasks/:id/complete — assignee completes task ──
app.post('/api/operations/tasks/:id/complete', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const r = requireOpsTask(req, res, ctx);
    if (!r) return;
    const { task } = r;

    if (!opsAuth.canCompleteTask(actor, task)) {
        console.log(`⛔ [OPS-SECURITY] complete rejected — ${actor.id} is not assignee of ${task.id}`);
        return res.status(403).json({ error: 'Solo l\'assegnatario può completare il compito.' });
    }
    if (task.status === 'CANCELLED')
        return res.status(400).json({ error: 'Impossibile completare un compito cancellato.' });

    const prevStatus = task.status;
    if (task.status !== 'COMPLETED') {
        task.status = 'COMPLETED';
        task.completionPercent = 100;
        task.completedAt = Date.now();
        if (!task.startedAt) task.startedAt = task.completedAt;
        addHistory(task, 'TASK_COMPLETED', actor.id, actor.name, { from: prevStatus, to: 'COMPLETED' });
    }
    task.updatedAt = Date.now();
    saveOpsTasks();
    broadcastOps(actor.companyId, { action: 'OPS_TASK_COMPLETED', task: opsTaskWithComputedStatus(task) });
    res.json({ success: true, task: opsTaskWithComputedStatus(task) });
});

// ── POST /api/operations/tasks/:id/reassign — reassign to a different user ──
// [SECURITY] Same hierarchy as task creation. persist → audit → email.
app.post('/api/operations/tasks/:id/reassign', async (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const r = requireOpsTask(req, res, ctx);
    if (!r) return;
    const { task, byId } = r;

    // canEditTask covers Director + creator with hierarchy
    if (!opsAuth.canEditTask(actor, task, byId)) {
        console.log(`⛔ [OPS-SECURITY] reassign rejected (no edit rights) — ${actor.role} ${actor.id}`);
        return res.status(403).json({ error: 'Non autorizzato a riassegnare questo compito.' });
    }
    if (task.status === 'CANCELLED')
        return res.status(400).json({ error: 'Impossibile riassegnare un compito cancellato.' });

    const newAssigneeId = (req.body.assigneeId || '').toString().trim();
    if (!newAssigneeId) return res.status(400).json({ error: 'assigneeId obbligatorio.' });

    const newAssignee = byId[newAssigneeId];
    if (!newAssignee || newAssignee.active === false) {
        console.log(`⛔ [OPS-SECURITY] reassign rejected — assignee "${newAssigneeId}" not found/active in "${actor.companyId}"`);
        return res.status(400).json({ error: 'Assegnatario non valido.' });
    }
    if (!opsAuth.canAssignTaskTo(actor, newAssignee)) {
        console.log(`⛔ [OPS-SECURITY] reassign rejected — ${actor.role} cannot assign to ${newAssignee.role}`);
        return res.status(403).json({ error: `Il tuo ruolo non può assegnare compiti a ${newAssignee.role}.` });
    }

    const oldAssigneeId = task.assigneeId;
    const oldAssigneeName = task.assigneeName || '';
    const isReallyChanged = newAssignee.id !== oldAssigneeId;

    task.assigneeId = newAssignee.id;
    task.assigneeName = newAssignee.name;

    if (isReallyChanged) {
        addHistory(task, 'ASSIGNEE_CHANGED', actor.id, actor.name, {
            from: oldAssigneeId, fromName: oldAssigneeName,
            to: newAssignee.id, toName: newAssignee.name
        });
    }

    task.updatedAt = Date.now();
    saveOpsTasks(); // persist FIRST

    // Then email (failure never rolls back the persisted change)
    let notificationResult = opsEmail.RESULT.SKIPPED;
    if (isReallyChanged && newAssignee.id !== actor.id) {
        try {
            const emailRes = await opsEmail.sendTaskAssignmentEmail({
                to: newAssignee.email, toName: newAssignee.name, task,
                assignedByName: actor.name, appUrl: '/operations-tasks.html'
            });
            notificationResult = emailRes.result;
        } catch (e) {
            console.error('📧 [OPS-EMAIL] reassign notification failed (non-fatal):', e.message);
            notificationResult = opsEmail.RESULT.FAILED;
        }
        console.log(`📧 [OPS] Reassign notification: ${notificationResult} → ${newAssignee.email} (task: ${task.id})`);
    }

    console.log(`✅ [OPS] Task ${task.id} reassigned: ${oldAssigneeId} → ${newAssignee.id} by ${actor.id}`);
    broadcastOps(actor.companyId, { action: 'OPS_TASK_REASSIGNED', task: opsTaskWithComputedStatus(task), prevAssigneeId: oldAssigneeId });
    res.json({ success: true, task: opsTaskWithComputedStatus(task), notificationResult });
});

// ── POST /api/operations/tasks/:id/cancel — soft-cancel (Director only) ──
app.post('/api/operations/tasks/:id/cancel', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    if (!opsAuth.canManageUsers(actor)) // Director only
        return res.status(403).json({ error: 'Solo il Direttore può cancellare compiti.' });
    const r = requireOpsTask(req, res, ctx);
    if (!r) return;
    const { task } = r;

    if (task.status === 'CANCELLED')
        return res.status(400).json({ error: 'Il compito è già cancellato.' });

    const prevStatus = task.status;
    task.status = 'CANCELLED';
    const reason = (req.body.reason || '').toString().trim().substring(0, 500);
    addHistory(task, 'STATUS_CHANGED', actor.id, actor.name, { from: prevStatus, to: 'CANCELLED', reason });
    task.updatedAt = Date.now();
    saveOpsTasks();
    console.log(`✅ [OPS] Task ${task.id} cancelled by Director ${actor.id}`);
    broadcastOps(actor.companyId, { action: 'OPS_TASK_UPDATED', task: opsTaskWithComputedStatus(task) });
    res.json({ success: true, task: opsTaskWithComputedStatus(task) });
});

// ── POST /api/operations/tasks/:id/comments — add comment ──
// [SECURITY] authorId/companyId always from server-side session — never from client.
// Anyone who can view the task may comment (canViewTask enforced by requireOpsTask).
app.post('/api/operations/tasks/:id/comments', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const r = requireOpsTask(req, res, ctx);
    if (!r) return;
    const { task } = r;

    const text = (req.body.text || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'Il testo del commento è obbligatorio.' });
    if (text.length > 2000) return res.status(400).json({ error: 'Commento troppo lungo (max 2000 caratteri).' });

    if (!Array.isArray(task.comments)) task.comments = [];
    const comment = {
        id: genOpsCommentId(),
        authorId: actor.id,        // always from session
        authorName: actor.name,
        text,
        createdAt: Date.now()
    };
    task.comments.push(comment);
    addHistory(task, 'COMMENT_ADDED', actor.id, actor.name, { commentId: comment.id, preview: text.substring(0, 80) });
    task.updatedAt = Date.now();
    saveOpsTasks();
    broadcastOps(actor.companyId, { action: 'OPS_COMMENT_ADDED', taskId: task.id, comment, task: opsTaskWithComputedStatus(task) });
    res.json({ success: true, comment, task: opsTaskWithComputedStatus(task) });
});

// ── POST /api/operations/tasks/:id/attachments — register attachment metadata ──
// Actual file upload requires Firebase Storage (not yet configured).
// This endpoint stores metadata only; the client must supply a pre-obtained storagePath
// from the upload provider. Sprint 3 will wire the full upload flow.
app.post('/api/operations/tasks/:id/attachments', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    if (!opsAuth.canEditTask(actor, null, {})) { // Director or creator — use canManageUsers as proxy
        // Actually check: actor must be editor (Director or task creator)
    }
    const r = requireOpsTask(req, res, ctx);
    if (!r) return;
    const { task, byId } = r;

    if (!opsAuth.canEditTask(actor, task, byId))
        return res.status(403).json({ error: 'Non autorizzato ad aggiungere allegati.' });

    const { filename, mimeType, size, storagePath } = req.body;
    if (!filename || !filename.toString().trim()) return res.status(400).json({ error: 'filename obbligatorio.' });
    if (!storagePath || !storagePath.toString().trim())
        return res.status(501).json({ error: 'Upload file non ancora configurato. Fornire storagePath da Firebase Storage.' });

    if (!Array.isArray(task.attachments)) task.attachments = [];
    const attachment = {
        id: genOpsAttachmentId(),
        filename: filename.toString().trim().substring(0, 255),
        mimeType: (mimeType || 'application/octet-stream').toString().substring(0, 100),
        size: typeof size === 'number' ? size : null,
        storagePath: storagePath.toString().substring(0, 1000),
        uploadedBy: actor.id,
        uploadedByName: actor.name,
        uploadedAt: Date.now()
    };
    task.attachments.push(attachment);
    addHistory(task, 'ATTACHMENT_ADDED', actor.id, actor.name, { filename: attachment.filename, id: attachment.id });
    task.updatedAt = Date.now();
    saveOpsTasks();
    res.json({ success: true, attachment, task: opsTaskWithComputedStatus(task) });
});

// ── GET /api/operations/stats — dashboard summary per actor ──
app.get('/api/operations/stats', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const byId = opsUsersById(actor.companyId);
    const tasks = getOpsTasks(actor.companyId)
        .filter(t => opsAuth.canViewTask(actor, t, byId))
        .map(opsTaskWithComputedStatus);

    const todayStr = new Date().toISOString().slice(0, 10);
    const mine = tasks.filter(t => t.assigneeId === actor.id);
    const myOpen = mine.filter(t => t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
    const myInProgress = mine.filter(t => t.status === 'IN_PROGRESS');

    const stats = {
        my:         myOpen.length,
        myInProgress: myInProgress.length,
        today:      myOpen.filter(t => t.dueDate && t.dueDate.slice(0, 10) === todayStr).length,
        overdue:    mine.filter(t => t.effectiveStatus === 'OVERDUE').length,
        completed:  mine.filter(t => t.status === 'COMPLETED').length,
        open:       tasks.filter(t => t.status === 'OPEN').length,
        inProgress: tasks.filter(t => t.status === 'IN_PROGRESS').length,
        urgent:     tasks.filter(t => t.priority === 'URGENT' && t.status !== 'COMPLETED' && t.status !== 'CANCELLED').length,
        avgCompletion: (() => {
            const active = tasks.filter(t => t.status !== 'CANCELLED');
            if (!active.length) return 0;
            return Math.round(active.reduce((s, t) => s + (t.completionPercent || 0), 0) / active.length);
        })()
    };

    // Team workload: per visible subordinate, count of active tasks (Directors + managers)
    let workload = null;
    if (actor.role !== 'SOUS_CHEF' && actor.role !== 'CHEF_DE_BRIGADE') {
        const subordinates = Object.values(byId)
            .filter(u => u.id !== actor.id && u.active !== false && opsAuth.canAssignTaskTo(actor, u));
        workload = subordinates.map(u => ({
            userId: u.id, name: u.name, role: u.role,
            activeTasks: tasks.filter(t => t.assigneeId === u.id && t.status !== 'COMPLETED' && t.status !== 'CANCELLED').length
        }));
    }

    res.json({ success: true, stats, workload, me: publicOpsUser(actor) });
});

// ── Intelligence Engine ────────────────────────────────────────────────────
// ── Role-scope helpers (Sprint 6.2) ─────────────────────────────────────────
// Tasks visible to an actor in intelligence context.
// Uses the same ASSIGNABLE_ROLES matrix that governs task assignment.
function getScopedTasks(actor, allTasks, allUsers) {
    if (actor.role === 'DIRECTOR') return allTasks;
    const userRoleMap = {};
    allUsers.forEach(u => { userRoleMap[u.id] = u.role; });
    const assignable = opsAuth.ASSIGNABLE_ROLES[actor.role] || [];
    // Actor sees their own tasks plus tasks whose assignee role falls in their matrix.
    return allTasks.filter(t =>
        t.assigneeId === actor.id ||
        assignable.includes(userRoleMap[t.assigneeId])
    );
}

// Users visible to an actor in intelligence context.
function getScopedUsers(actor, allUsers) {
    if (actor.role === 'DIRECTOR') return allUsers;
    const assignable = opsAuth.ASSIGNABLE_ROLES[actor.role] || [];
    return allUsers.filter(u => u.id === actor.id || assignable.includes(u.role));
}

// GET /api/operations/intelligence — all active operations roles (server-scoped)
// Role, companyId, and scope are NEVER taken from the request body or query string.
app.get('/api/operations/intelligence', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor     = ctx.opsUser;
    const companyId = actor.companyId;

    const allTasks = getOpsTasks(companyId);
    const allUsers = getOpsUsers(companyId);

    // ── Scope tasks and users by role ────────────────────────────────────────
    const scopedTasks = getScopedTasks(actor, allTasks, allUsers);
    const scopedUsers = getScopedUsers(actor, allUsers);

    // ── Run scoped intelligence analysis ─────────────────────────────────────
    const result = opsIntelligence.analyzeIntelligence(companyId, {
        tasks: scopedTasks,
        users: scopedUsers,
    });

    // ── Snapshot (idempotent — company-wide, Director triggers generation) ───
    if (actor.role === 'DIRECTOR') {
        opsSnapshots.generateSnapshot(companyId, {
            tasks: allTasks,
            users: allUsers,
            workload: result.workload,
        });
    }

    // ── Trends (Director only — requires company-wide history) ───────────────
    const yesterdaySnap = opsSnapshots.getYesterdaySnapshot(companyId);
    const recentSnaps   = opsSnapshots.getRecentSnapshots(companyId, 7);
    const trends = actor.role === 'DIRECTOR'
        ? opsTrends.analyzeTrends(result.summary, yesterdaySnap, recentSnaps)
        : null;

    // ── Department health (Director + CC + Adjoint) ──────────────────────────
    const departmentHealth = ['DIRECTOR','CHEF_CUISINE','ADJOINT'].includes(actor.role)
        ? opsIntelligence.getDepartmentHealth(scopedTasks, yesterdaySnap)
        : null;

    // ── Personal metrics (Sous Chef / Chef de Brigade) ───────────────────────
    let myMetrics = null;
    let nextTask  = null;
    if (['SOUS_CHEF','CHEF_DE_BRIGADE'].includes(actor.role)) {
        const wl = result.workload.find(w => w.userId === actor.id) || {};
        myMetrics = {
            assigned:       wl.assigned       || 0,
            overdue:        wl.overdue         || 0,
            urgent:         wl.urgent          || 0,
            completedToday: wl.completedToday  || 0,
        };
        // next task: first open non-cancelled, ordered by urgency then due date
        const now = Date.now();
        const openTasks = scopedTasks
            .filter(t => !['COMPLETED','CANCELLED'].includes(t.status))
            .sort((a, b) => {
                const aUrgent = a.priority === 'URGENT' ? 0 : 1;
                const bUrgent = b.priority === 'URGENT' ? 0 : 1;
                if (aUrgent !== bUrgent) return aUrgent - bUrgent;
                if (!a.dueDate) return 1;
                if (!b.dueDate) return -1;
                return new Date(a.dueDate) - new Date(b.dueDate);
            });
        const nt = openTasks[0] || null;
        nextTask = nt ? { id: nt.id, title: nt.title, dueDate: nt.dueDate, priority: nt.priority } : null;
    }

    // ── Sprint 6.3: Executive Assistant ──────────────────────────────────────
    // ── Sprint 6.3.1: read previous visit BEFORE computing response ──────────
    const prevVisitRecord = opsVisits.getLastVisit(companyId, actor.id);
    const previousVisitAt = prevVisitRecord ? prevVisitRecord.lastVisitAt : null;

    const priorityQueue  = opsAssistant.generatePriorityQueue(result.decisions);
    const riskWatch      = opsAssistant.detectRisks(scopedTasks, scopedUsers, result.workload);
    const changesSince   = opsAssistant.buildChangesSince(trends, yesterdaySnap, result.summary);
    const executiveBrief = opsAssistant.buildExecutiveBrief(
        actor.role, result.summary, priorityQueue, riskWatch, changesSince,
        result.decisions, trends, myMetrics, nextTask
    );

    // ── Sprint 6.3.1: new-since-last-visit (computed before updating lastVisitAt) ─
    const newSinceLastVisit = opsAssistant.buildNewSinceLastVisit({
        riskWatch,
        decisions: result.decisions,
        tasks:     scopedTasks,
        previousVisitAt,
        now:       Date.now(),
    });

    // ── Briefing (Sprint 6.2 — kept for backward compat) ─────────────────────
    const briefing = opsIntelligence.generateBriefing(actor.role, {
        summary:       result.summary,
        decisionsCount: result.decisions.length,
        trends,
        myMetrics,
        nextTask,
    });

    // ── Build role-appropriate response ──────────────────────────────────────
    const base = { success: true, briefing, executiveBrief, role: actor.role };

    // ── Sprint 6.3.1: update lastVisitAt AFTER computing response (never before) ─
    // This ensures "new since last visit" reflects the *previous* session, not the
    // current one.  Only update on intentional dashboard load, not on realtime
    // re-fetches.  The "isRealtime" query param is set by the client's WS refresh
    // callbacks to suppress the visit update.
    const isRealtime = req.query.isRealtime === '1';
    if (!isRealtime) {
        opsVisits.updateLastVisit(companyId, actor.id);
    }

    if (['SOUS_CHEF','CHEF_DE_BRIGADE'].includes(actor.role)) {
        return res.json({ ...base, myTasks: myMetrics, nextTask, priorityQueue, riskWatch, newSinceLastVisit });
    }

    const response = {
        ...base,
        attention:    result.attention,
        workload:     result.workload,
        suggestions:  result.suggestions,
        summary:      result.summary,
        decisions:    result.decisions,
        departmentHealth,
        priorityQueue,
        riskWatch,
        changesSince,
        newSinceLastVisit,
    };
    if (trends) response.trends = trends;

    return res.json(response);
});

// =========================================================================
// ===== PLATETIMER OPERATIONS — SPRINT 3: RECURRING / SCHEDULER ===========
// =========================================================================

// =========================================================================
// ===== SPRINT 6.4 — PERFORMANCE & COACHING CENTER ========================
// =========================================================================

// Helper: can actor view performance profile of target ops-user?
// Director: any; CC: own ASSIGNABLE_ROLES + self; Adjoint: own ASSIGNABLE_ROLES + self; SC/CDB: self only.
function canViewPerformance(actor, targetUser) {
    if (!actor || !targetUser) return false;
    if (actor.companyId !== targetUser.companyId) return false;
    if (actor.id === targetUser.id) return true;
    if (actor.role === 'DIRECTOR') return true;
    if (['CHEF_CUISINE','ADJOINT'].includes(actor.role))
        return (opsAuth.ASSIGNABLE_ROLES[actor.role] || []).includes(targetUser.role);
    return false; // SC/CDB: self only
}

// GET /api/operations/performance/:userId — individual performance profile
app.get('/api/operations/performance/:userId', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor     = ctx.opsUser;
    const companyId = actor.companyId;

    // Resolve target — 'me' is a convenience alias
    const rawId     = req.params.userId;
    const byId      = opsUsersById(companyId);
    const targetUser = rawId === 'me' ? actor : byId[rawId];

    if (!targetUser || targetUser.companyId !== companyId) {
        return res.status(404).json({ error: 'Utente non trovato.' });
    }
    if (!canViewPerformance(actor, targetUser)) {
        console.log(`⛔ [OPS-SECURITY] performance rejected — ${actor.role} cannot view ${targetUser.role} (company "${companyId}")`);
        return res.status(403).json({ error: 'Non autorizzato a visualizzare questo profilo.' });
    }

    const period    = (req.query.period || '30d').trim();
    const periodMs  = opsPerformance.parsePeriod(period, req.query.from, req.query.to);

    const allTasks  = getOpsTasks(companyId);
    const userExc   = opsExceptions.getExceptionsForUser(companyId, targetUser.id);

    // Enrich exceptions with task title
    const taskById  = {};
    allTasks.forEach(t => { taskById[t.id] = t; });
    const enrichedExc = userExc.map(e => ({
        ...e,
        taskTitle: taskById[e.taskId] ? taskById[e.taskId].title : e.taskId,
    }));

    const metrics      = opsPerformance.computeMetrics(allTasks, targetUser.id, periodMs, userExc);
    const reliability  = opsPerformance.computeReliabilityIndex(metrics);
    const strengths    = opsPerformance.generateStrengths(metrics, reliability);
    const coaching     = opsPerformance.generateCoachingOpportunities(metrics, reliability);
    const evolution    = opsPerformance.computeEvolution(allTasks, targetUser.id, userExc);
    const workloadHistory = opsPerformance.computeWorkloadHistory(allTasks, targetUser.id);
    const relatedTasks = opsPerformance.getUserRelatedTasks(allTasks, targetUser.id);
    const taskHistory  = opsPerformance.buildTaskHistory(relatedTasks, targetUser.id, userExc, 30);

    // Workload status: derive from current open tasks
    const openCount   = relatedTasks.filter(t => t.assigneeId === targetUser.id && !['COMPLETED','CANCELLED'].includes(t.status)).length;
    const wlScore     = openCount;
    const workloadStatus = wlScore >= 10 ? 'SOVRACCARICO' : wlScore >= 5 ? 'OCCUPATO' : 'NORMALE';

    res.json({
        user: {
            id:          targetUser.id,
            name:        targetUser.name,
            role:        targetUser.role,
            department:  targetUser.department || null,
            status:      targetUser.status,
            createdAt:   targetUser.createdAt,
        },
        periodLabel:     periodMs.label,
        metrics,
        reliability,
        strengths,
        coaching,
        evolution,
        workloadHistory,
        taskHistory,
        exceptions:      enrichedExc,
        workloadStatus,
    });
});

// POST /api/operations/exceptions — record a non-standard task outcome
// Only Director, CC, Adjoint may record exceptions.
app.post('/api/operations/exceptions', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor     = ctx.opsUser;
    const companyId = actor.companyId;

    if (!['DIRECTOR','CHEF_CUISINE','ADJOINT'].includes(actor.role)) {
        console.log(`⛔ [OPS-SECURITY] exception-create rejected — role ${actor.role}`);
        return res.status(403).json({ error: 'Solo i manager possono registrare eccezioni.' });
    }

    const { taskId, userId, type, reason } = req.body;
    if (!taskId || !userId || !type) {
        return res.status(400).json({ error: 'taskId, userId e type sono obbligatori.' });
    }

    // Validate task belongs to company
    const task = findOpsTask(companyId, taskId);
    if (!task) return res.status(404).json({ error: 'Compito non trovato.' });

    // Validate userId belongs to company and actor can view their performance
    const byId = opsUsersById(companyId);
    const targetUser = byId[userId];
    if (!targetUser) return res.status(404).json({ error: 'Utente non trovato.' });
    if (!canViewPerformance(actor, targetUser)) {
        return res.status(403).json({ error: 'Non autorizzato per questo utente.' });
    }

    try {
        const record = opsExceptions.createException(companyId, {
            taskId,
            userId,
            type: String(type).toUpperCase(),
            reason: reason || '',
            recordedBy:     actor.id,
            recordedByName: actor.name,
        });
        res.json({ success: true, exception: record });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// GET /api/operations/exceptions — list exceptions for a user
app.get('/api/operations/exceptions', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor     = ctx.opsUser;
    const companyId = actor.companyId;

    const userId = req.query.userId || actor.id;
    const byId   = opsUsersById(companyId);
    const targetUser = byId[userId];
    if (!targetUser) return res.status(404).json({ error: 'Utente non trovato.' });
    if (!canViewPerformance(actor, targetUser)) {
        return res.status(403).json({ error: 'Non autorizzato.' });
    }

    const exceptions = opsExceptions.getExceptionsForUser(companyId, userId);
    res.json({ exceptions });
});

// ── Template CRUD ──────────────────────────────────────────────────────────

// GET /api/operations/templates — Director only: list company templates
app.get('/api/operations/templates', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può gestire i template.' });
    const templates = getOpsTemplates(ctx.opsUser.companyId);
    res.json({ success: true, templates });
});

// POST /api/operations/templates — Director only: create recurring template
app.post('/api/operations/templates', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può creare template.' });
    const actor     = ctx.opsUser;
    const companyId = actor.companyId;

    const errors = opsRecurring.validateTemplateInput(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    // Validate defaultAssigneeId if provided
    if (req.body.defaultAssigneeId) {
        const byId  = opsUsersById(companyId);
        const asgn  = byId[req.body.defaultAssigneeId];
        if (!asgn || asgn.active === false) return res.status(400).json({ error: 'defaultAssigneeId non valido.' });
        if (!opsAuth.canAssignTaskTo(actor, asgn)) return res.status(403).json({ error: `Non puoi assegnare compiti a ${asgn.role}.` });
    }

    const clean = opsRecurring.sanitizeTemplateInput(req.body);
    const now   = Date.now();
    const template = {
        id:              genTemplateId(),
        companyId,
        ...clean,
        defaultAssigneeName: (() => {
            if (!clean.defaultAssigneeId) return null;
            const u = opsUsersById(companyId)[clean.defaultAssigneeId];
            return u ? u.name : null;
        })(),
        active:          true,
        createdBy:       actor.id,
        createdByName:   actor.name,
        createdAt:       now,
        updatedAt:       now,
        generatedCount:  0,
        lastGeneratedAt: null,
    };
    if (!opsTemplatesStore[companyId]) opsTemplatesStore[companyId] = [];
    opsTemplatesStore[companyId].push(template);
    saveOpsTemplates();
    console.log(`✅ [OPS] Template created: "${template.title}" (${template.frequency}) by ${actor.id} in "${companyId}"`);
    res.status(201).json({ success: true, template });
});

// GET /api/operations/templates/:id
app.get('/api/operations/templates/:id', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può visualizzare i template.' });
    const tpl = getOpsTemplates(ctx.opsUser.companyId).find(t => t.id === req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template non trovato.' });
    res.json({ success: true, template: tpl });
});

// PATCH /api/operations/templates/:id — affects future occurrences only; never modifies past tasks
app.patch('/api/operations/templates/:id', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può modificare i template.' });
    const companyId = ctx.opsUser.companyId;
    const tpl = getOpsTemplates(companyId).find(t => t.id === req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template non trovato.' });

    let patch;
    try { patch = opsRecurring.sanitizeTemplatePatch(req.body); }
    catch (msg) { return res.status(400).json({ error: msg }); }

    // Validate defaultAssigneeId if changing
    if (patch.defaultAssigneeId) {
        const byId = opsUsersById(companyId);
        const asgn = byId[patch.defaultAssigneeId];
        if (!asgn || asgn.active === false) return res.status(400).json({ error: 'defaultAssigneeId non valido.' });
        if (!opsAuth.canAssignTaskTo(ctx.opsUser, asgn)) return res.status(403).json({ error: `Non puoi assegnare compiti a ${asgn.role}.` });
        patch.defaultAssigneeName = asgn.name;
    }

    Object.assign(tpl, patch, { updatedAt: Date.now() });
    saveOpsTemplates();
    console.log(`✅ [OPS] Template patched: "${tpl.id}" by ${ctx.opsUser.id}`);
    res.json({ success: true, template: tpl });
});

// DELETE /api/operations/templates/:id — soft-deactivate; keeps all generated tasks
app.delete('/api/operations/templates/:id', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può eliminare i template.' });
    const tpl = getOpsTemplates(ctx.opsUser.companyId).find(t => t.id === req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template non trovato.' });
    tpl.active    = false;
    tpl.updatedAt = Date.now();
    saveOpsTemplates();
    console.log(`✅ [OPS] Template deactivated: "${tpl.id}" by ${ctx.opsUser.id}`);
    res.json({ success: true, message: 'Template disattivato. I compiti già generati rimangono invariati.' });
});

// POST /api/operations/templates/:id/generate-now — force generation immediately (Director, for testing)
app.post('/api/operations/templates/:id/generate-now', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può forzare la generazione.' });
    const companyId = ctx.opsUser.companyId;
    const tpl = getOpsTemplates(companyId).find(t => t.id === req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template non trovato.' });

    const existingKeys = new Set(
        getOpsTasks(companyId).filter(t => t.templateId === tpl.id && t.occurrenceKey).map(t => t.occurrenceKey)
    );
    const usersById = opsUsersById(companyId);
    const newTasks  = opsRecurring.generateTasksForTemplate(tpl, companyId, existingKeys, usersById, addHistory);
    if (newTasks.length > 0) {
        if (!opsTasksStore[companyId]) opsTasksStore[companyId] = [];
        for (const t of newTasks) opsTasksStore[companyId].push(t);
        saveOpsTasks();
        tpl.generatedCount  = (tpl.generatedCount || 0) + newTasks.length;
        tpl.lastGeneratedAt = Date.now();
        saveOpsTemplates();
    }
    res.json({ success: true, generated: newTasks.length, tasks: newTasks.map(t => ({ id: t.id, dueDate: t.dueDate, occurrenceKey: t.occurrenceKey })) });
});

// ── Task reminder / escalation settings ────────────────────────────────────

// PATCH /api/operations/tasks/:id/reminder — set/clear task reminder
app.patch('/api/operations/tasks/:id/reminder', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const task  = findOpsTask(actor.companyId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Compito non trovato.' });
    if (!opsAuth.canEditTask(actor, task, opsUsersById(actor.companyId))) {
        return res.status(403).json({ error: 'Non autorizzato a modificare questo compito.' });
    }
    const days = req.body.reminderDays;
    if (days !== null && days !== undefined) {
        const d = Number(days);
        if (!Number.isInteger(d) || d < 0 || d > 365) return res.status(400).json({ error: 'reminderDays deve essere 0-365.' });
        task.reminderDays   = d || null;
    } else {
        task.reminderDays = null;
    }
    task.reminderSentAt = null; // reset so a new reminder can fire
    task.updatedAt      = Date.now();
    saveOpsTasks();
    res.json({ success: true, task: opsTaskWithComputedStatus(task) });
});

// PATCH /api/operations/tasks/:id/escalation — configure task escalation
app.patch('/api/operations/tasks/:id/escalation', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const actor = ctx.opsUser;
    const task  = findOpsTask(actor.companyId, req.params.id);
    if (!task) return res.status(404).json({ error: 'Compito non trovato.' });
    if (!opsAuth.canEditTask(actor, task, opsUsersById(actor.companyId))) {
        return res.status(403).json({ error: 'Non autorizzato a modificare questo compito.' });
    }
    const { enabled, waitHoursAfterDue, waitHoursBetweenLevels } = req.body;
    if (!task.escalation) task.escalation = { enabled: false, waitHoursAfterDue: 24, waitHoursBetweenLevels: 24 };
    if (enabled !== undefined) task.escalation.enabled = enabled === true;
    if (waitHoursAfterDue !== undefined) {
        const h = Number(waitHoursAfterDue);
        if (isNaN(h) || h < 0 || h > 720) return res.status(400).json({ error: 'waitHoursAfterDue deve essere 0-720.' });
        task.escalation.waitHoursAfterDue = h;
    }
    if (waitHoursBetweenLevels !== undefined) {
        const h = Number(waitHoursBetweenLevels);
        if (isNaN(h) || h < 0 || h > 720) return res.status(400).json({ error: 'waitHoursBetweenLevels deve essere 0-720.' });
        task.escalation.waitHoursBetweenLevels = h;
    }
    // Reset escalation state when re-configuring
    task.escalationLevel    = 0;
    task.escalationSentAt   = null;
    task.escalationNotified = [];
    task.updatedAt = Date.now();
    saveOpsTasks();
    res.json({ success: true, task: opsTaskWithComputedStatus(task) });
});

// ── Notification preferences ────────────────────────────────────────────────

// GET /api/operations/preferences — current user's preferences
app.get('/api/operations/preferences', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    const prefs = opsScheduler.getUserPrefs(opsPrefsStore, ctx.opsUser.companyId, ctx.opsUser.id);
    res.json({ success: true, preferences: prefs });
});

// PATCH /api/operations/preferences — update current user's preferences
app.patch('/api/operations/preferences', (req, res) => {
    const ctx       = requireOpsAuth(req, res);
    if (!ctx) return;
    const companyId = ctx.opsUser.companyId;
    const userId    = ctx.opsUser.id;
    const VALID_BOOL_KEYS = ['emailReminders', 'taskAssignment', 'escalationEmails', 'dailyDigest'];
    const updates = {};
    for (const key of VALID_BOOL_KEYS) {
        if (req.body[key] !== undefined) updates[key] = req.body[key] === true;
    }
    if (!opsPrefsStore[companyId]) opsPrefsStore[companyId] = { defaults: opsScheduler.DEFAULT_PREFS(), users: {} };
    if (!opsPrefsStore[companyId].users) opsPrefsStore[companyId].users = {};
    if (!opsPrefsStore[companyId].users[userId]) opsPrefsStore[companyId].users[userId] = {};
    Object.assign(opsPrefsStore[companyId].users[userId], updates);
    saveOpsPrefs();
    res.json({ success: true, preferences: opsScheduler.getUserPrefs(opsPrefsStore, companyId, userId) });
});

// GET /api/operations/company-preferences — Director: get company defaults
app.get('/api/operations/company-preferences', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può gestire le preferenze aziendali.' });
    const prefs = opsScheduler.getCompanyPrefs(opsPrefsStore, ctx.opsUser.companyId);
    res.json({ success: true, preferences: prefs });
});

// PATCH /api/operations/company-preferences — Director: set company-wide defaults
app.patch('/api/operations/company-preferences', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può modificare le preferenze aziendali.' });
    const companyId   = ctx.opsUser.companyId;
    const VALID_BOOL_KEYS = ['emailReminders', 'taskAssignment', 'escalationEmails', 'dailyDigest'];
    const updates = {};
    for (const key of VALID_BOOL_KEYS) {
        if (req.body[key] !== undefined) updates[key] = req.body[key] === true;
    }
    if (!opsPrefsStore[companyId]) opsPrefsStore[companyId] = { defaults: opsScheduler.DEFAULT_PREFS(), users: {} };
    if (!opsPrefsStore[companyId].defaults) opsPrefsStore[companyId].defaults = opsScheduler.DEFAULT_PREFS();
    Object.assign(opsPrefsStore[companyId].defaults, updates);
    saveOpsPrefs();
    res.json({ success: true, preferences: opsScheduler.getCompanyPrefs(opsPrefsStore, companyId) });
});

// ── Escalation dashboard (Director only) ────────────────────────────────────

// GET /api/operations/escalation-status
app.get('/api/operations/escalation-status', (req, res) => {
    const ctx = requireOpsAuth(req, res);
    if (!ctx) return;
    if (!opsAuth.canManageUsers(ctx.opsUser)) return res.status(403).json({ error: 'Solo il Direttore può vedere il pannello escalation.' });
    const companyId  = ctx.opsUser.companyId;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const tasks = getOpsTasks(companyId).map(opsTaskWithComputedStatus);

    const escalated = tasks.filter(t => t.escalationLevel > 0 && t.status !== 'COMPLETED' && t.status !== 'CANCELLED');
    const requiresEscalation = tasks.filter(t =>
        t.effectiveStatus === 'OVERDUE' &&
        t.escalation && t.escalation.enabled &&
        t.escalationLevel === 0 &&
        t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
    );
    const escalatedToday = escalated.filter(t =>
        t.escalationSentAt && t.escalationSentAt >= todayStart.getTime() && t.escalationSentAt <= todayEnd.getTime()
    ).length;

    // Overdue by department
    const overdueByDepartment = {};
    for (const t of tasks.filter(t => t.effectiveStatus === 'OVERDUE' && t.status !== 'CANCELLED')) {
        const dept = t.department || '(nessun reparto)';
        overdueByDepartment[dept] = (overdueByDepartment[dept] || 0) + 1;
    }

    res.json({
        success: true,
        escalated:         escalated.map(t => ({ id: t.id, title: t.title, assigneeName: t.assigneeName, dueDate: t.dueDate, escalationLevel: t.escalationLevel, priority: t.priority, department: t.department })),
        requiresEscalation: requiresEscalation.map(t => ({ id: t.id, title: t.title, assigneeName: t.assigneeName, dueDate: t.dueDate, priority: t.priority, department: t.department })),
        escalatedToday,
        overdueByDepartment,
    });
});

// =========================================================================
// ===== END PLATETIMER OPERATIONS MODULE ==================================
// =========================================================================

// Store per le room delle aziende
const companyRooms = new Map();

// ── OPS real-time broadcast helper ───────────────────────────────────────────
// Sends an OPS_* event to every authenticated WS client in a company room.
// [SECURITY] companyId always comes from the verified server-side session;
//            never from client-supplied payload.
// Failures are intentionally silent — WS delivery is best-effort;
// HTTP persistence is the source of truth.
function broadcastOps(companyId, payload) {
    const room = companyRooms.get(companyId);
    if (!room || room.size === 0) return;
    const msg = JSON.stringify(payload);
    let sent = 0;
    room.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try { client.send(msg); sent++; }
            catch (_) { /* ignore per-client send errors */ }
        }
    });
    if (sent > 0)
        console.log(`📡 [OPS-RT] ${payload.action} → "${companyId}" (${sent} client${sent !== 1 ? 's' : ''})`);
}

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

// Normalizza il numero tavolo: rimuove gli zeri iniziali per numeri puri,
// lowercase per identificatori alfanumerici.
// Esempi: "012" → "12", "21" → "21", "A12" → "a12"
function normalizeTableNumber(tableNumber) {
    const str = String(tableNumber).trim();
    if (/^\d+$/.test(str)) return String(parseInt(str, 10));
    return str.toLowerCase();
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
                    data.action === 'joinVoice' ||
                    data.action === 'leaveVoice' ||
                    data.action === 'talkingStart' ||
                    data.action === 'talkingStop'
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

                // [S1.5] Resolve Department Account binding server-side.
                // Never trust client-supplied department values — always derive from the
                // verified session uid.  Initialise to null so unbound legacy sockets
                // remain unchanged (wsSocketMatchesDest returns true for null).
                ws.boundDepartmentId       = null;
                ws.departmentAccountId     = null;
                ws.departmentAccountStatus = null;
                ws.boundDepartmentName     = null;

                const wsBoundAcct = getBoundDepartmentContext(session);
                if (wsBoundAcct) {
                    if (wsBoundAcct.status === 'SUSPENDED') {
                        console.log(`⛔ [S1.5] WS joinRoom rejected — SUSPENDED account: uid=${session.uid}, company="${companyName}"`);
                        ws.send(JSON.stringify({
                            action: 'error',
                            code:   'ACCOUNT_SUSPENDED',
                            message: 'Your department account is suspended. Contact your administrator.'
                        }));
                        ws.close();
                        return;
                    }
                    // ACTIVE bound account — lock socket to server-verified department
                    ws.boundDepartmentId       = wsBoundAcct.departmentId;
                    ws.departmentAccountId     = wsBoundAcct.id;
                    ws.departmentAccountStatus = wsBoundAcct.status;
                    const wsBoundDept = getCompanyDepts(companyName).find(d => d.id === wsBoundAcct.departmentId);
                    ws.boundDepartmentName = wsBoundDept ? wsBoundDept.name : null;
                    // Pre-lock pageType so joinPage cannot override it
                    ws.pageType = wsBoundAcct.departmentId;
                    console.log(`🔒 [S1.5] WS socket locked to dept "${ws.boundDepartmentId}" (${ws.boundDepartmentName}), company="${companyName}"`);
                }

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

                // Invia tutti i countdown attivi al nuovo client — un messaggio per tavolo.
                // Criteri lifecycle: includi se Date.now() < endsAt + 15000 ms,
                // allineato con duplicate-check e cleanup periodico.
                if (activeCountdowns.has(companyName)) {
                    const companyCountdowns = activeCountdowns.get(companyName);
                    const countdownsToDelete = [];

                    companyCountdowns.forEach((countdown, tableNumber) => {
                        const endsAt = countdown.endsAt || (countdown.startTime + countdown.initialDuration * 1000);
                        const nowMs  = Date.now();
                        if (nowMs < endsAt + 15000) {
                            const remaining = Math.max(0, Math.floor((endsAt - nowMs) / 1000));
                            const syncMessage = {
                                action:          'startCountdown',
                                tableNumber:     tableNumber,
                                timeRemaining:   remaining,
                                endsAt:          endsAt,
                                initialDuration: countdown.initialDuration,
                                destinations:    countdown.destinations
                            };
                            // [S1.5] Bound sockets only receive countdowns targeting their dept
                            if (wsSocketMatchesDest(ws, countdown.destinations)) {
                                ws.send(JSON.stringify(syncMessage));
                                console.log(`📡 Sync joinRoom: Tavolo ${tableNumber} → [${countdown.destinations.join(', ')}], rem=${remaining}s`);
                            }
                        } else {
                            countdownsToDelete.push(tableNumber);
                        }
                    });

                    countdownsToDelete.forEach(tableNumber => {
                        companyCountdowns.delete(tableNumber);
                        console.log(`🗑️ Countdown rimosso in joinRoom (lifecycle scaduto): Tavolo ${tableNumber}`);
                    });
                }

            } else if (data.action === 'joinPage') {
                // Gestisce l'ingresso in una specifica pagina (department ID)
                if (!data.pageType || typeof data.pageType !== 'string' || !data.pageType.trim()) {
                    console.log('⚠️ Tipo pagina non valido');
                    return;
                }
                // [S1.5] Bound accounts: pageType is always the server-verified boundDepartmentId.
                // Client-supplied values are ignored to prevent department impersonation.
                // Unbound/legacy accounts keep the existing behaviour.
                if (ws.boundDepartmentId) {
                    ws.pageType = ws.boundDepartmentId; // already set in joinRoom; re-assert here
                } else {
                    ws.pageType = data.pageType;
                }
                // Use the effective pageType (server-derived for bound, client for unbound)
                const effectivePageType = ws.pageType;

                // Conta quanti utenti sono attualmente sulla stessa pagina
                if (ws.companyRoom && companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const samePageClients = Array.from(roomClients).filter(client => 
                        client.pageType === effectivePageType && client !== ws
                    );

                    console.log(`📄 Client entrato in pagina ${data.pageType}: ${samePageClients.length} altri utenti già presenti`);

                    // Sincronizza TUTTI i countdown dell'azienda alla pagina — un messaggio per tavolo.
                    // Ogni pagina dipartimento mostra tutti i countdown della company room;
                    // destinations[] è metadato (non un filtro di visibilità).
                    if (ws.companyRoom && activeCountdowns.has(ws.companyRoom)) {
                        const companyCountdowns = activeCountdowns.get(ws.companyRoom);
                        const countdownsToDelete = [];
                        let syncedCount = 0;

                        companyCountdowns.forEach((countdown, tableNumber) => {
                            const endsAt = countdown.endsAt || (countdown.startTime + countdown.initialDuration * 1000);
                            const nowMs  = Date.now();
                            if (nowMs < endsAt + 15000) {
                                const remaining = Math.max(0, Math.floor((endsAt - nowMs) / 1000));
                                const syncMessage = {
                                    action:          'startCountdown',
                                    tableNumber:     tableNumber,
                                    timeRemaining:   remaining,
                                    endsAt:          endsAt,
                                    initialDuration: countdown.initialDuration,
                                    destinations:    countdown.destinations
                                };
                                // [S1.5] Bound sockets only receive countdowns targeting their dept
                                if (wsSocketMatchesDest(ws, countdown.destinations)) {
                                    ws.send(JSON.stringify(syncMessage));
                                    syncedCount++;
                                    console.log(`📡 Sync joinPage (${effectivePageType}): Tavolo ${tableNumber} → [${countdown.destinations.join(', ')}], rem=${remaining}s`);
                                }
                            } else {
                                countdownsToDelete.push(tableNumber);
                            }
                        });

                        countdownsToDelete.forEach(tableNumber => {
                            companyCountdowns.delete(tableNumber);
                            console.log(`🗑️ Countdown rimosso in joinPage (lifecycle scaduto): Tavolo ${tableNumber}`);
                        });

                        console.log(`📊 Sincronizzazione joinPage (${effectivePageType}): ${syncedCount} countdown inviati, ${countdownsToDelete.length} rimossi`);
                    }

                    // Se ci sono altri utenti sulla stessa pagina, invia un avviso
                    if (samePageClients.length > 0) {
                        const warningMessage = {
                            action: 'pageOccupied',
                            pageType: effectivePageType,
                            otherUsersCount: samePageClients.length,
                            message: `⚠️ Attenzione: ${samePageClients.length} altro/i utente/i sta/stanno già utilizzando la pagina ${effectivePageType.toUpperCase()}`
                        };

                        ws.send(JSON.stringify(warningMessage));

                        // Informa anche gli altri utenti che qualcuno si è collegato
                        const newUserMessage = {
                            action: 'newUserJoined',
                            pageType: effectivePageType,
                            totalUsers: samePageClients.length + 1,
                            message: `👥 Un nuovo utente si è collegato alla pagina ${effectivePageType.toUpperCase()} (${samePageClients.length + 1} utenti totali)`
                        };

                        samePageClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify(newUserMessage));
                            }
                        });
                    }
                }

            } else if (data.action === 'startCountdown') {
                // ── Validate basic fields ───────────────────────────────────────────────
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

                // Accept destinations array (new protocol) or single destination string (backward compat)
                const destinations = Array.isArray(data.destinations)
                    ? data.destinations
                    : (data.destination ? [data.destination] : []);
                if (destinations.length === 0) {
                    console.log('⚠️ Nessuna destinazione specificata');
                    return;
                }

                // Validate every destination against the company's active departments
                const companyDepts = getCompanyDepts(ws.companyRoom);
                const activeDeptIds = companyDepts.filter(d => d.active).map(d => d.id);
                for (const dest of destinations) {
                    if (typeof dest !== 'string' || !dest.trim()) {
                        console.log(`⚠️ Destinazione non valida: "${dest}"`);
                        return;
                    }
                    if (activeDeptIds.length > 0 && !activeDeptIds.includes(dest)) {
                        console.log(`⚠️ Destinazione "${dest}" non è un reparto valido per "${ws.companyRoom}"`);
                        ws.send(JSON.stringify({ action: 'error', message: 'Destination department not found.' }));
                        return;
                    }
                }

                // [S1.5] Bound accounts must include their own department in destinations.
                // Prevents a bound dept from starting countdowns that bypass their dept.
                // Cross-department coordination (CENTRAL role) is a future sprint.
                if (ws.boundDepartmentId && !destinations.includes(ws.boundDepartmentId)) {
                    console.log(`⛔ [S1.5] startCountdown rejected — bound dept "${ws.boundDepartmentId}" not in destinations [${destinations.join(',')}]`);
                    ws.send(JSON.stringify({ action: 'error', code: 'DEPT_NOT_IN_DESTINATIONS', message: 'Your department must be included in countdown destinations.' }));
                    return;
                }

                if (!ws.companyRoom) {
                    console.log('⚠️ Client non assegnato a nessuna room');
                    return;
                }

                if (!activeCountdowns.has(ws.companyRoom)) {
                    activeCountdowns.set(ws.companyRoom, new Map());
                }
                const companyCountdowns = activeCountdowns.get(ws.companyRoom);

                // Normalize table number: strip leading zeros for purely numeric identifiers;
                // lowercase for alphanumeric names.  "012" → "12", "A12" → "a12".
                const tableKey = normalizeTableNumber(data.tableNumber);

                // ── Duplicate-table check ─────────────────────────────────────────────
                // Authoritative lifecycle: a table is occupied until endsAt + 15000 ms —
                // the same 15-second expired-display window the client shows at 00:00.
                // After that exact moment the entry is stale and a new countdown may replace it.
                // Node.js single-threaded event loop makes the check+set below atomic.
                if (companyCountdowns.has(tableKey)) {
                    const existingCd     = companyCountdowns.get(tableKey);
                    const existingEndsAt = existingCd.endsAt || (existingCd.startTime + existingCd.initialDuration * 1000);

                    if (Date.now() < existingEndsAt + 15000) {
                        // Still within active + expired window — reject
                        const msLeft = Math.ceil((existingEndsAt + 15000 - Date.now()) / 1000);
                        console.log(`⚠️ TABLE_ALREADY_ACTIVE tavolo "${tableKey}" (${msLeft}s rimanenti nel lifecycle) — rifiutato`);
                        ws.send(JSON.stringify({
                            action:      'countdownError',
                            code:        'TABLE_ALREADY_ACTIVE',
                            tableNumber: data.tableNumber,
                            message:     `A countdown is already active for table ${data.tableNumber}.`
                        }));
                        return;
                    } else {
                        // Lifecycle elapsed — remove stale entry; allow new creation
                        companyCountdowns.delete(tableKey);
                        console.log(`🗑️ Stale countdown rimosso per tavolo "${tableKey}" (lifecycle scaduto) — nuova creazione consentita`);
                    }
                }

                // ── Create countdown ────────────────────────────────────────────────────
                // endsAt is stored on the object so all lifecycle logic (duplicate check,
                // sync on join, periodic cleanup) shares the same authoritative source.
                const startTime    = Date.now();
                const serverEndsAt = startTime + data.timeRemaining * 1000;
                companyCountdowns.set(tableKey, {
                    startTime,
                    initialDuration: data.timeRemaining,
                    endsAt:          serverEndsAt,
                    tableNumber:     data.tableNumber,
                    destinations
                });
                console.log(`💾 Countdown creato per azienda "${ws.companyRoom}": Tavolo ${tableKey}, endsAt +${data.timeRemaining}s, Destinazioni: [${destinations.join(', ')}]`);

                // Mark all destination departments as used (prevents accidental deletion)
                let depsChanged = false;
                for (const dest of destinations) {
                    const deptIdx = (departmentsStore[ws.companyRoom] || []).findIndex(d => d.id === dest);
                    if (deptIdx !== -1 && !departmentsStore[ws.companyRoom][deptIdx].usedInCountdowns) {
                        departmentsStore[ws.companyRoom][deptIdx].usedInCountdowns = true;
                        depsChanged = true;
                    }
                }
                if (depsChanged) saveJSON(DEPARTMENTS_FILE, departmentsStore);

                // ── Broadcast ONE message to the entire company room ──────────────────
                // Single message with destinations[] array replaces the previous N-per-destination
                // broadcast.  All authenticated clients in the room receive it; company
                // isolation is enforced via ws.companyRoom (server-verified session token).
                if (companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    const msg = JSON.stringify({
                        action:          'startCountdown',
                        tableNumber:     data.tableNumber,
                        timeRemaining:   data.timeRemaining,
                        endsAt:          serverEndsAt,
                        initialDuration: data.timeRemaining,
                        destinations
                    });
                    let sentCount = 0;
                    roomClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN &&
                            wsSocketMatchesDest(client, destinations)) { // [S1.5] dept filter
                            client.send(msg);
                            sentCount++;
                        }
                    });
                    console.log(`📡 Room "${ws.companyRoom}" (${sentCount}/${roomClients.size} client): Tavolo ${tableKey} → [${destinations.join(', ')}], ${Math.floor(data.timeRemaining/60)}:${(data.timeRemaining%60).toString().padStart(2,'0')}`);
                } else {
                    console.log('⚠️ Room non trovata per broadcast');
                }

            } else if (data.action === 'deleteCountdown') {
                // Validazione dati eliminazione
                if (!data.tableNumber) {
                    console.log('⚠️ Numero tavolo mancante per eliminazione');
                    return;
                }

                // Rimuovi countdown dalla memoria del server (Soluzione 1 - chiave unificata)
                // [S1.5] Capture destinations before deletion so the broadcast can be filtered.
                let deletedDestinations = null;
                if (ws.companyRoom && activeCountdowns.has(ws.companyRoom)) {
                    const companyCountdowns = activeCountdowns.get(ws.companyRoom);
                    // [S1.5] Use same normalization as startCountdown so the key matches
                    const tableKey = normalizeTableNumber(data.tableNumber);
                    
                    if (companyCountdowns.has(tableKey)) {
                        const removedCountdown = companyCountdowns.get(tableKey);
                        deletedDestinations = removedCountdown.destinations || null;
                        companyCountdowns.delete(tableKey);
                        
                        console.log(`🗑️ Countdown tavolo ${data.tableNumber} rimosso dalla memoria server`);
                        console.log(`📋 Destinazioni eliminate: [${(deletedDestinations || []).join(', ')}]`);
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
                        if (client.readyState === WebSocket.OPEN &&
                            wsSocketMatchesDest(client, deletedDestinations)) { // [S1.5] dept filter
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

                // [SECURITY] Validate every destination against company's active departments.
                // '__sala__' is the virtual ID for the floor/sala page and is always permitted.
                const vmSalaVirtualId = '__sala__';
                const vmCompanyDepts = getCompanyDepts(ws.companyRoom);
                const vmActiveDeptIds = vmCompanyDepts.filter(d => d.active).map(d => d.id);
                if (vmActiveDeptIds.length > 0) {
                    for (const destId of vmDestList) {
                        if (destId !== vmSalaVirtualId && !vmActiveDeptIds.includes(destId)) {
                            console.log(`⛔ [SECURITY] voiceMessage rejected — invalid destination "${destId}" for "${ws.companyRoom}"`);
                            ws.send(JSON.stringify({ action: 'error', message: 'Destination department not found.' }));
                            return;
                        }
                    }
                }

                // [S1.5] Source department is server-derived for bound accounts.
                // Never trust client's `from` field — a bound account cannot impersonate
                // another department as the voice message sender.
                const vmSourceDeptId = ws.boundDepartmentId || ws.pageType || data.from || '';

                // Invia messaggio vocale ai client della room
                // [S1.5] Bound sockets receive only if their dept is a destination or the source.
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
                            // Bound clients: deliver if their dept is a destination or they are the source
                            if (!client.boundDepartmentId ||
                                vmDestList.includes(client.boundDepartmentId) ||
                                client.boundDepartmentId === vmSourceDeptId) {
                                client.send(voiceMessage);
                                sentCount++;
                            }
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

                // [S1.5] Bound accounts: voice room is locked to their server-verified dept.
                // This prevents joining another department's WebRTC voice channel by
                // supplying a forged room name.  Unbound legacy clients keep existing behaviour.
                ws.voiceRoom = ws.boundDepartmentId
                    ? ws.boundDepartmentId
                    : data.room.toLowerCase();
                ws.voicePeerId = data.peerId;

                console.log(`🎙️ [VOICE] Peer ${data.peerId} entrato nella room vocale: ${ws.voiceRoom} (bound: ${!!ws.boundDepartmentId})`);

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
                        if (client !== ws && client.voiceRoom === ws.voiceRoom && client.readyState === WebSocket.OPEN) {
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
            } else if (data.action === 'talkingStart') {
                // PTT: broadcast "this peer started talking" to all same-room same-company peers
                if (!data.peerId || !data.deptName) {
                    console.log('⚠️ talkingStart: peerId o deptName mancante');
                    return;
                }
                // [S1.5] deptName in the outgoing broadcast is server-derived for bound accounts.
                // A bound client cannot claim to be another department in PTT metadata.
                const pttDeptName = ws.boundDepartmentName || data.deptName;
                if (companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    roomClients.forEach((client) => {
                        if (client !== ws && client.voiceRoom === ws.voiceRoom && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                action: 'talkingStart',
                                peerId: data.peerId,
                                deptName: pttDeptName   // [S1.5] server-derived for bound accounts
                            }));
                        }
                    });
                }
                console.log(`🎙️ [PTT] talkingStart da peer ${data.peerId} (${pttDeptName})`);

            } else if (data.action === 'talkingStop') {
                // PTT: broadcast "this peer stopped talking" to all same-room same-company peers
                if (!data.peerId) {
                    console.log('⚠️ talkingStop: peerId mancante');
                    return;
                }
                if (companyRooms.has(ws.companyRoom)) {
                    const roomClients = companyRooms.get(ws.companyRoom);
                    roomClients.forEach((client) => {
                        if (client !== ws && client.voiceRoom === ws.voiceRoom && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                action: 'talkingStop',
                                peerId: data.peerId
                            }));
                        }
                    });
                }
                console.log(`🔇 [PTT] talkingStop da peer ${data.peerId}`);

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

    // Pulisci countdown scaduti — criterio: endsAt + 15000 ms (allineato con duplicate-check e client)
    // La vecchia regola "remainingTime <= -30" è stata rimossa: usava un calcolo indipendente
    // che creava una finestra (15-30s) in cui il client vedeva il tavolo libero ma il server lo bloccava.
    let totalActiveCountdowns = 0;
    activeCountdowns.forEach((companyCountdowns, companyName) => {
        companyCountdowns.forEach((countdown, tableNumber) => {
            const endsAt = countdown.endsAt || (countdown.startTime + countdown.initialDuration * 1000);
            if (now >= endsAt + 15000) {
                companyCountdowns.delete(tableNumber);
                console.log(`🗑️ Cleanup: Tavolo ${tableNumber} (${companyName}) rimosso — endsAt+15s scaduto`);
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


// ===== Data-store initialisation =====
// Runs once at startup, BEFORE the HTTP server starts accepting connections.
//
// When Firestore is configured (FIREBASE_ADMIN_SERVICE_ACCOUNT set):
//   • Firestore is the SOLE persistent source of truth.
//   • Local files are checked only if Firestore has no data yet (one-time migration).
//   • After migration, local files play no further role — Firestore handles everything.
//
// When Firestore is NOT configured (local dev / missing credential):
//   • Falls back to local JSON files with a loud warning.
//   • Data is ephemeral on Railway; configure the secret for production.
async function initializeDataStores() {
    const stores = [
        { name: 'departments',     file: DEPARTMENTS_FILE,     setter: v => { departmentsStore    = v; } },
        { name: 'plans',           file: PLANS_FILE,           setter: v => { plansStore          = v; } },
        { name: 'department_accounts', file: DEPARTMENT_ACCOUNTS_FILE, setter: v => { departmentAccounts.setStore(v); } },
        { name: 'calendar_events', file: CALENDAR_EVENTS_FILE, setter: v => { calendarEventsStore = v; } },
        { name: 'calendar_notifs', file: CALENDAR_NOTIF_FILE,  setter: v => { calendarNotifStore  = v; } },
        { name: 'ops_users',       file: OPS_USERS_FILE,       setter: v => { opsUsersStore       = v; } },
        { name: 'ops_tasks',       file: OPS_TASKS_FILE,       setter: v => { opsTasksStore       = v; } },
        { name: 'ops_templates',   file: OPS_TEMPLATES_FILE,   setter: v => { opsTemplatesStore   = v; } },
        { name: 'ops_prefs',       file: OPS_PREFS_FILE,       setter: v => { opsPrefsStore       = v; } },
    ];

    if (!db) {
        // ── Local-dev / no-credential fallback ──────────────────────────────
        console.warn('');
        console.warn('⚠️  ─────────────────────────────────────────────────────────');
        console.warn('⚠️  FIRESTORE NON CONFIGURATO — caricamento da file locali.');
        console.warn('⚠️  I dati NON sopravvivono ai deploy Railway.');
        console.warn('⚠️  Per la persistenza in produzione:');
        console.warn('⚠️    1. Firebase Console → app-dati-tavoli → Project Settings');
        console.warn('⚠️       → Service Accounts → Genera nuova chiave privata');
        console.warn('⚠️    2. In Railway: aggiungi il secret FIREBASE_ADMIN_SERVICE_ACCOUNT');
        console.warn('⚠️       con il contenuto JSON del file scaricato.');
        console.warn('⚠️  ─────────────────────────────────────────────────────────');
        console.warn('');
        for (const store of stores) {
            store.setter(loadJSON(store.file));
        }
        return;
    }

    // ── Firestore mode ───────────────────────────────────────────────────────
    for (const store of stores) {
        try {
            const doc = await db.collection(STORE_COLLECTION).doc(store.name).get();
            const fsData = doc.exists ? doc.data()?.store : null;

            if (fsData && Object.keys(fsData).length > 0) {
                // ── Firestore has data → sole authority, ignore local files ──
                store.setter(fsData);
                console.log(`✅ [STORE] "${store.name}" caricato da Firestore (${Object.keys(fsData).length} ristoranti)`);
                if (store.name === 'calendar_events') {
                    const total = Object.values(calendarEventsStore)
                        .reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
                    console.log(`[CALENDAR] Loaded ${total} events for ${Object.keys(calendarEventsStore).length} companies from Firestore`);
                }
            } else {
                // ── Firestore empty → one-time migration from local file ──────
                const localData = loadJSON(store.file);
                const localCount = Object.keys(localData).length;
                if (localCount > 0) {
                    await db.collection(STORE_COLLECTION).doc(store.name)
                        .set({ store: localData, updatedAt: Date.now() });
                    store.setter(localData);
                    console.log(`✅ [STORE] "${store.name}" migrato da file locale → Firestore (${localCount} ristoranti). File locale non più necessario.`);
                } else {
                    store.setter({});
                    console.log(`✅ [STORE] "${store.name}" inizializzato vuoto in Firestore`);
                }
            }
        } catch (e) {
            // Individual store failure — emergency fallback to local file for this store only.
            console.error(`❌ [STORE] Errore caricamento "${store.name}" da Firestore:`, e.message);
            const localData = loadJSON(store.file);
            store.setter(localData);
            console.warn(`⚠️ [STORE] "${store.name}" caricato da file locale come emergenza — verificare le credenziali Firestore.`);
        }
    }
}

// Avvia il server (unica versione corretta per Railway)
const PORT = process.env.PORT || 3000;

// ── Sprint 3 scheduler ───────────────────────────────────────────────────────
// Idempotent — safe to call repeatedly; each phase guards against duplicates.
const opsSchedulerInstance = opsScheduler.createScheduler(
    () => ({ opsTasksStore, opsUsersStore, opsTemplatesStore, opsPrefsStore }),
    () => ({ saveOpsTasks, saveOpsTemplates, saveOpsPrefs }),
    opsEmail,
    addHistory
);

initializeDataStores().then(() => {
    // Kick off the first scheduler run shortly after startup, then every 5 minutes.
    setTimeout(() => {
        opsSchedulerInstance.run().catch(e => console.error('[SCHEDULER] Initial run error:', e.message));
    }, 2000);
    setInterval(() => {
        opsSchedulerInstance.run().catch(e => console.error('[SCHEDULER] Periodic run error:', e.message));
    }, 5 * 60 * 1000);

    server
        .listen(PORT, '0.0.0.0', () => {
            console.log(`🛡️ Server avviato su http://0.0.0.0:${PORT}`);
            console.log('✅ Autenticazione WebSocket attiva');
            console.log('✅ Validazione dati attiva');
            console.log('✅ Rate limiting ottimizzato');
            console.log('✅ Scheduler ricorrente attivo (ogni 5 min)');
        })
        .on('error', (error) => {
            console.error('❌ Errore avvio server:', error);
        });
}).catch(err => {
    // Catastrophic failure in initializeDataStores (should not happen — errors are caught per-store).
    console.error('❌ [STORE] initializeDataStores fallito completamente:', err.message);
    console.error('❌ [STORE] Il server si avvia con store vuoti — i dati non sono garantiti.');
    server
        .listen(PORT, '0.0.0.0', () => {
            console.log(`🛡️ Server avviato su http://0.0.0.0:${PORT}`);
            console.warn('⚠️ Avviato con store vuoti — verificare le credenziali Firestore.');
        })
        .on('error', (error) => {
            console.error('❌ Errore avvio server:', error);
        });
});
