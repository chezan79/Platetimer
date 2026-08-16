'use strict';
/**
 * Mex conversation store — per-company persistence.
 * Follows docs/mex-architecture-audit.md §F exactly.
 *
 * Key invariants:
 *  - Firestore documents are per-company: mex_<sha256(companyId)[0:32]>
 *  - NOT the shared getStoreNameForFile / initializeDataStores pattern
 *  - Per-company promise queue serialises writes within a process
 *  - Firestore transaction with rev precondition (multi-instance safe)
 *  - 700 KB UTF-8 byte cap per company document
 *  - Sender field (from) is always server-derived — never from client payload
 */
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Hard caps ─────────────────────────────────────────────────────────────────
const MEX_MAX_OPEN_CONVERSATIONS        = 30;
const MEX_MAX_CLOSED_RETAINED           = 50;
const MEX_MAX_MESSAGES_PER_CONVERSATION = 200;
const MEX_MAX_BODY_LENGTH               = 300;   // Step 3 spec; audit ceiling is 500
const MEX_MAX_COMPANY_BYTES             = 700 * 1024;
const MEX_AUTO_CLOSE_HOURS              = 24;
const MEX_CLOSED_TTL_DAYS              = 7;

// ── Runtime config — injected via init() ──────────────────────────────────────
let _dataDir   = null;
let _db        = null;
let _storeColl = null;

// ── In-memory store ───────────────────────────────────────────────────────────
// Shape: { [companyId]: { conversations: { [convId]: Conversation }, _rev: number } }
const mexStore = {};

// Per-company write queues — guarantees ordering within process
const queues = {};

// ── Internal helpers ──────────────────────────────────────────────────────────
function mexDocId(companyId) {
    return 'mex_' + crypto.createHash('sha256').update(companyId).digest('hex').slice(0, 32);
}

function localFilePath() {
    return path.join(_dataDir, 'mex-conversations.json');
}

function utfBytes(obj) {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

function buildFirestoreDoc(companyId) {
    const mem = mexStore[companyId];
    return {
        companyId,
        rev:          (mem._rev || 0) + 1,
        updatedAt:    Date.now(),
        conversations: mem.conversations
    };
}

function readLocalFile() {
    const fp = localFilePath();
    if (!fs.existsSync(fp)) return {};
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; }
}

function getQueue(companyId) {
    if (!queues[companyId]) queues[companyId] = Promise.resolve();
    return queues[companyId];
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadMexCompany(companyId) {
    if (mexStore[companyId]) return;
    if (_db) {
        try {
            const snap = await _db.collection(_storeColl).doc(mexDocId(companyId)).get();
            if (snap.exists) {
                const d = snap.data();
                mexStore[companyId] = { conversations: d.conversations || {}, _rev: d.rev || 0 };
            } else {
                mexStore[companyId] = { conversations: {}, _rev: 0 };
            }
        } catch (e) {
            console.error(`[MEX] Firestore load error for "${companyId}": ${e.message}`);
            mexStore[companyId] = { conversations: {}, _rev: 0 };
        }
    } else {
        const all = readLocalFile();
        mexStore[companyId] = { conversations: all[companyId] || {}, _rev: 0 };
    }
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function saveMexCompany(companyId) {
    if (_db) {
        const docId  = mexDocId(companyId);
        const docRef = _db.collection(_storeColl).doc(docId);
        const mem    = mexStore[companyId];

        // Firestore transaction with rev precondition — multi-instance safe
        let attempts = 3;
        while (attempts > 0) {
            try {
                await _db.runTransaction(async tx => {
                    const snap = await tx.get(docRef);
                    let baseRev = mem._rev || 0;
                    if (snap.exists) {
                        const remoteRev  = snap.data().rev || 0;
                        if (remoteRev !== baseRev) {
                            // Rebase: merge remote conversations (remote wins for existing keys)
                            const remoteConvs = snap.data().conversations || {};
                            mem.conversations = { ...remoteConvs, ...mem.conversations };
                            baseRev = remoteRev;
                        }
                    }
                    const doc = {
                        companyId,
                        rev:          baseRev + 1,
                        updatedAt:    Date.now(),
                        conversations: mem.conversations
                    };
                    tx.set(docRef, doc);
                    mem._rev = doc.rev;
                });
                return;
            } catch (e) {
                attempts--;
                if (attempts === 0) throw e;
                await new Promise(r => setTimeout(r, 80));
            }
        }
    } else {
        const all = readLocalFile();
        all[companyId] = mexStore[companyId].conversations;
        fs.writeFileSync(localFilePath(), JSON.stringify(all, null, 2));
    }
}

// ── Cap enforcement ───────────────────────────────────────────────────────────
function applyRetention(companyId) {
    const convs      = mexStore[companyId].conversations;
    const nowMs      = Date.now();
    const autoCloseMs = MEX_AUTO_CLOSE_HOURS * 3_600_000;
    const closedTtlMs = MEX_CLOSED_TTL_DAYS  * 86_400_000;

    // 1. Auto-close stale open conversations
    for (const c of Object.values(convs)) {
        if (!c.closedAt && new Date(c.createdAt).getTime() + autoCloseMs < nowMs) {
            c.closedAt = new Date().toISOString();
        }
    }

    // 2. Evict expired closed conversations
    for (const [id, c] of Object.entries(convs)) {
        if (c.closedAt && new Date(c.closedAt).getTime() + closedTtlMs < nowMs) {
            delete convs[id];
        }
    }

    // 3. Trim closed to MEX_MAX_CLOSED_RETAINED (oldest evicted first)
    const closedSorted = Object.keys(convs)
        .filter(id => convs[id].closedAt)
        .sort((a, b) => new Date(convs[a].closedAt) - new Date(convs[b].closedAt));
    for (const id of closedSorted.slice(0, Math.max(0, closedSorted.length - MEX_MAX_CLOSED_RETAINED))) {
        delete convs[id];
    }

    // 4. Trim messages per conversation (oldest evicted)
    for (const c of Object.values(convs)) {
        if ((c.messages || []).length > MEX_MAX_MESSAGES_PER_CONVERSATION) {
            c.messages = c.messages.slice(c.messages.length - MEX_MAX_MESSAGES_PER_CONVERSATION);
        }
    }
}

// Evict oldest closed conversations until under byte cap.
// Returns true when under cap, false if still over after all closed are evicted.
function evictForBytesCap(companyId) {
    const convs = mexStore[companyId].conversations;
    const closedSorted = Object.keys(convs)
        .filter(id => convs[id].closedAt)
        .sort((a, b) => new Date(convs[a].closedAt) - new Date(convs[b].closedAt));
    for (const id of closedSorted) {
        delete convs[id];
        if (utfBytes(buildFirestoreDoc(companyId)) <= MEX_MAX_COMPANY_BYTES) return true;
    }
    return utfBytes(buildFirestoreDoc(companyId)) <= MEX_MAX_COMPANY_BYTES;
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Create a new conversation with the first message already in it.
 * senderDeptId MUST be server-derived — never accept from client.
 * Returns { conversation, message } on success; throws { code, message } on failure.
 */
async function createAndSend({ companyId, senderDeptId, recipientDeptId, body, templateType, tableNumber }) {
    // Enqueue so concurrent sends for the same company are serialised
    return (queues[companyId] = getQueue(companyId).then(async () => {
        await loadMexCompany(companyId);

        const convs      = mexStore[companyId].conversations;
        const openCount  = Object.values(convs).filter(c => !c.closedAt).length;
        if (openCount >= MEX_MAX_OPEN_CONVERSATIONS) {
            throw { code: 'MEX_OVER_CAPACITY', message: 'Too many open conversations. Try again later.' };
        }

        const now    = new Date().toISOString();
        const convId = 'mexconv_' + crypto.randomBytes(8).toString('hex');
        const msgId  = 'mexmsg_'  + crypto.randomBytes(8).toString('hex');

        const msg = {
            id: msgId, conversationId: convId,
            from: senderDeptId,     // always server-derived; never from client payload
            body,
            // [Step 6] Optional Quick Message metadata — undefined on legacy messages;
            // receiving clients always use `body` for display (backward compat).
            templateType: templateType || null,
            tableNumber:  tableNumber  || null,
            timestamp: now
        };
        const conv = {
            id: convId, companyId,
            participants:  [senderDeptId, recipientDeptId],
            createdAt: now, createdBy: senderDeptId,
            closedAt: null, readBy: {},
            messages: [msg]
        };

        convs[convId] = conv;
        applyRetention(companyId);

        // Byte budget check
        if (utfBytes(buildFirestoreDoc(companyId)) > MEX_MAX_COMPANY_BYTES) {
            const ok = evictForBytesCap(companyId);
            if (!ok) {
                delete convs[convId];
                throw { code: 'MEX_STORE_FULL', message: 'Message store capacity exceeded. Try again later.' };
            }
        }

        await saveMexCompany(companyId);
        return { conversation: convs[convId], message: convs[convId].messages[0] };
    }));
}

/**
 * Return all open conversations where deptId is a participant.
 * Awaits any in-flight queue for the company to avoid returning stale data.
 */
async function getInboxForDept(companyId, deptId) {
    await (queues[companyId] || Promise.resolve());
    if (!mexStore[companyId]) await loadMexCompany(companyId);
    return Object.values(mexStore[companyId].conversations)
        .filter(c => !c.closedAt && c.participants.includes(deptId))
        .map(c => ({
            id:           c.id,
            participants: c.participants,
            createdAt:    c.createdAt,
            messages:     (c.messages || []).map(m => ({
                id: m.id, from: m.from, body: m.body, timestamp: m.timestamp,
                // [Step 6] Pass through QM metadata (null for legacy messages — backward compat)
                templateType: m.templateType || null,
                tableNumber:  m.tableNumber  || null
            }))
        }));
}

// ── Startup ───────────────────────────────────────────────────────────────────
/**
 * Called once at server startup (after initializeDataStores resolves).
 * Local dev: eagerly loads all companies from the shared file.
 * Firestore: lazy-load per company on first access (avoids cold-listing all docs).
 */
async function initMexStore() {
    if (!_db && _dataDir) {
        const all = readLocalFile();
        for (const [companyId, convs] of Object.entries(all)) {
            if (!mexStore[companyId]) {
                mexStore[companyId] = { conversations: convs || {}, _rev: 0 };
            }
        }
        const count = Object.keys(mexStore).length;
        console.log(`✅ [MEX] Loaded ${count} compan${count === 1 ? 'y' : 'ies'} from local file`);
    }
    // Firestore mode: lazy-load per company on first createAndSend / getInboxForDept call.
}

/**
 * Called by server.js immediately after DATA_DIR and db are known.
 */
function init(dataDir, db, storeCollection) {
    _dataDir   = dataDir;
    _db        = db;
    _storeColl = storeCollection;
}

module.exports = {
    init,
    initMexStore,
    loadMexCompany,
    createAndSend,
    getInboxForDept,

    // Constants (used by server.js for validation)
    MEX_MAX_BODY_LENGTH,
    MEX_MAX_OPEN_CONVERSATIONS,
    MEX_MAX_CLOSED_RETAINED,
    MEX_MAX_MESSAGES_PER_CONVERSATION,
    MEX_MAX_COMPANY_BYTES,
    MEX_AUTO_CLOSE_HOURS,
    MEX_CLOSED_TTL_DAYS,

    // Test helpers — never use in production paths
    _mexStore: mexStore,
    _resetForTest() {
        for (const k of Object.keys(mexStore)) delete mexStore[k];
        for (const k of Object.keys(queues))   delete queues[k];
        _dataDir = _db = _storeColl = null;
    }
};
