// service/department-accounts.js — Department Account model (Service side).
// Sprints S1.1–S2.0.
//
// A Department Account binds ONE Service identity to exactly ONE company and
// ONE department. The account carries NO type/role/central data of its own:
// all permissions are inherited from the referenced department record.
// The department owns its role via `departmentType` (STANDARD | CENTRAL);
// an absent field is treated as STANDARD so existing data keeps working.
//
// All Department Account logic lives HERE and only here (mirroring how
// operations/ops-auth.js isolates Operations logic). Do not scatter lookups
// in server.js. Company is always derived from the verified HMAC session —
// never from client payloads.
//
// Schema (per account record):
//   id              string  'depacct_<ts>_<rand>'
//   companyId       string  (normalized company name from session)
//   departmentId    string  (must reference a department of the SAME company)
//   displayName     string
//   loginIdentifier string  unique within the company (S2.0+)
//   passwordHash    string  '<salt>:<hex>' — PBKDF2-SHA256, admin-set (S2.0+)
//   firebaseUid     null    (stays null until a later sprint binds Firebase Auth)
//   status          'ACTIVE' | 'SUSPENDED'
//   createdAt       number (ms)
//   createdBy       string (uid of the creating session)

const crypto = require('crypto');

// ── Password Hashing ─────────────────────────────────────────────────────
// Simple PBKDF2-SHA256. Not a user-facing security boundary — these are
// workstation PINs set by an admin. Using a proper hash anyway.

function _hashPassword(password, salt) {
    return crypto.pbkdf2Sync(String(password), salt, 10000, 32, 'sha256').toString('hex');
}
function createPasswordHash(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `${salt}:${_hashPassword(password, salt)}`;
}
function verifyPassword(password, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, hash] = stored.split(':');
    return _hashPassword(password, salt) === hash;
}

const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED'];
const DEPARTMENT_TYPES = ['STANDARD', 'CENTRAL'];

// ── Store ────────────────────────────────────────────────────────────────
// Company-keyed map: { [companyId]: [accountRecord, ...] }.
// Populated at startup by the server's initializeDataStores() via setStore();
// persisted by the server through the injected save callback (file-store +
// Firestore mirror, same conventions as departments/calendar stores).
let store = {};

// The server injects its persistence function (saveJSON bound to the
// department-accounts file). Defaults to a no-op so unit use never crashes.
let persist = () => {};

function setStore(v) { store = (v && typeof v === 'object') ? v : {}; }
function getStore() { return store; }
function setPersist(fn) { if (typeof fn === 'function') persist = fn; }

function genAccountId() {
    return 'depacct_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

// ── Lookups ──────────────────────────────────────────────────────────────

function getDepartmentAccounts(companyId) {
    return store[companyId] || [];
}

function findDepartmentAccountByUid(uid) {
    if (!uid) return null;
    for (const companyId of Object.keys(store)) {
        const hit = (store[companyId] || []).find(a => a.firebaseUid === uid);
        if (hit) return hit;
    }
    return null;
}

// Returns the ACTIVE account bound to a department (max one by invariant).
function findDepartmentAccountByDepartment(companyId, departmentId) {
    return (store[companyId] || []).find(
        a => a.departmentId === departmentId && a.status === 'ACTIVE'
    ) || null;
}

// loginIdentifier is unique ACROSS companies (it is a future login handle).
function findDepartmentAccountByLoginIdentifier(loginIdentifier) {
    if (!loginIdentifier) return null;
    const needle = String(loginIdentifier).trim().toLowerCase();
    for (const companyId of Object.keys(store)) {
        const hit = (store[companyId] || []).find(
            a => (a.loginIdentifier || '').toLowerCase() === needle
        );
        if (hit) return hit;
    }
    return null;
}

// ── Validation ───────────────────────────────────────────────────────────

// Validates that `departmentId` references an EXISTING, ACTIVE department of
// `companyId`. `companyDepts` must be the acting company's own department
// array (caller passes getCompanyDepts(session company) — company isolation
// is therefore structural: another company's department can never match).
function validateDepartmentAccountDepartment(companyId, departmentId, companyDepts) {
    if (!departmentId || typeof departmentId !== 'string') {
        return { ok: false, code: 400, error: 'departmentId is required.' };
    }
    const dept = (companyDepts || []).find(d => d.id === departmentId);
    if (!dept) {
        // Covers both "does not exist" and "belongs to another company":
        // lookups only ever run against the session company's own departments.
        return { ok: false, code: 404, error: 'Department not found in your company.' };
    }
    if (!dept.active) {
        return { ok: false, code: 409, error: 'Department is not active.' };
    }
    return { ok: true, department: dept };
}

// ── UID Binding ──────────────────────────────────────────────────────────

// Binds a verified Firebase UID to a Department Account.
//
// Security guarantees:
//   • uid must come from a server-verified source (session token or Firebase
//     REST verification); callers must NEVER accept uid from a client payload.
//   • One UID may only be bound to one account (any status) across all companies.
//   • One account may only have one uid (enforced by the null guard below).
//   • company isolation: the caller must pass the companyId from the verified
//     session; the account lookup is company-scoped so cross-company binding
//     is structurally impossible.
//   • ACTIVE-only binding: SUSPENDED accounts cannot receive a new UID.
//
// Returns { ok, account } or { ok:false, code, error }.
function bindFirebaseUid(companyId, accountId, uid) {
    if (!uid || typeof uid !== 'string') {
        return { ok: false, code: 400, error: 'uid is required.' };
    }
    // Global uniqueness: UID already bound somewhere?
    const existing = findDepartmentAccountByUid(uid);
    if (existing) {
        if (existing.id === accountId) return { ok: true, account: existing }; // idempotent re-bind
        return { ok: false, code: 409, error: 'This Firebase UID is already bound to another Department Account.' };
    }
    // Company-scoped account lookup (cross-company isolation is structural)
    const account = (store[companyId] || []).find(a => a.id === accountId);
    if (!account) return { ok: false, code: 404, error: 'Department account not found.' };
    if (account.firebaseUid !== null) {
        return { ok: false, code: 409, error: 'This Department Account already has a Firebase UID bound.' };
    }
    if (account.status !== 'ACTIVE') {
        return { ok: false, code: 409, error: 'Only ACTIVE Department Accounts can be bound to a Firebase UID.' };
    }
    account.firebaseUid = uid;
    persist();
    return { ok: true, account };
}

// ── Mutations ────────────────────────────────────────────────────────────

// Creates a Department Account. Enforces:
//  • department exists, belongs to the actor company, and is active
//  • max ONE account per department (any status) — S2.0 tightened from ACTIVE-only
//  • loginIdentifier unique within the company — S2.0 (was global; bind endpoint
//    still uses global findDepartmentAccountByLoginIdentifier for its lookup)
//  • password is hashed with PBKDF2; absence leaves passwordHash undefined
// Returns { ok, account } or { ok:false, code, error }.
function createDepartmentAccount({ companyId, departmentId, displayName, loginIdentifier, password, createdBy }, companyDepts) {
    const v = validateDepartmentAccountDepartment(companyId, departmentId, companyDepts);
    if (!v.ok) return v;

    const name = (displayName || '').trim();
    if (!name) return { ok: false, code: 400, error: 'displayName is required.' };
    if (name.length > 80) return { ok: false, code: 400, error: 'displayName too long (max 80).' };

    const login = (loginIdentifier || '').trim().toLowerCase();
    if (!login) return { ok: false, code: 400, error: 'loginIdentifier is required.' };
    if (login.length > 120) return { ok: false, code: 400, error: 'loginIdentifier too long (max 120).' };

    // One account per department (any status) — S2.0 rule
    const existingForDept = (store[companyId] || []).find(a => a.departmentId === departmentId);
    if (existingForDept) {
        return { ok: false, code: 409, error: 'This department already has a Department Account.' };
    }
    // Login unique within the company — S2.0 rule
    const loginTaken = (store[companyId] || []).some(
        a => (a.loginIdentifier || '').toLowerCase() === login
    );
    if (loginTaken) {
        return { ok: false, code: 409, error: 'loginIdentifier already in use.' };
    }

    const account = {
        id: genAccountId(),
        companyId,
        departmentId,
        displayName: name,
        loginIdentifier: login,
        ...(password ? { passwordHash: createPasswordHash(String(password)) } : {}),
        firebaseUid: null, // bound in a later sprint — never set here
        status: 'ACTIVE',
        createdAt: Date.now(),
        createdBy: createdBy || null
        // NOTE: intentionally NO type/role/central field — the department owns its role.
    };
    if (!store[companyId]) store[companyId] = [];
    store[companyId].push(account);
    persist();
    return { ok: true, account };
}

// Updates a Department Account's loginIdentifier and/or password.
// Login uniqueness is enforced within the company (excluding self).
// An empty/absent field is skipped — callers only send what they want changed.
// Returns { ok, account } or { ok:false, code, error }.
function updateDepartmentAccount(companyId, accountId, { loginIdentifier, password }) {
    const account = (store[companyId] || []).find(a => a.id === accountId);
    if (!account) return { ok: false, code: 404, error: 'Department account not found.' };

    if (loginIdentifier !== undefined) {
        const login = String(loginIdentifier).trim().toLowerCase();
        if (!login) return { ok: false, code: 400, error: 'loginIdentifier is required.' };
        if (login.length > 120) return { ok: false, code: 400, error: 'loginIdentifier too long (max 120).' };
        const loginTaken = (store[companyId] || []).some(
            a => a.id !== accountId && (a.loginIdentifier || '').toLowerCase() === login
        );
        if (loginTaken) return { ok: false, code: 409, error: 'loginIdentifier already in use.' };
        account.loginIdentifier = login;
    }

    if (password !== undefined) {
        const pass = String(password).trim();
        if (!pass) return { ok: false, code: 400, error: 'password is required.' };
        account.passwordHash = createPasswordHash(pass);
    }

    persist();
    return { ok: true, account };
}

// Updates an account's status (ACTIVE | SUSPENDED). Re-activating enforces
// the one-ACTIVE-per-department invariant.
// `companyDepts` (optional) — when provided, re-activation also requires the
// bound department to still exist and be active (referential integrity).
function setDepartmentAccountStatus(companyId, accountId, status, companyDepts) {
    if (!ACCOUNT_STATUSES.includes(status)) {
        return { ok: false, code: 400, error: `status must be one of: ${ACCOUNT_STATUSES.join(', ')}` };
    }
    const account = (store[companyId] || []).find(a => a.id === accountId);
    if (!account) return { ok: false, code: 404, error: 'Department account not found.' };

    if (status === 'ACTIVE' && account.status !== 'ACTIVE') {
        const existing = findDepartmentAccountByDepartment(companyId, account.departmentId);
        if (existing && existing.id !== account.id) {
            return { ok: false, code: 409, error: 'Another ACTIVE account already exists for this department.' };
        }
        if (companyDepts) {
            const dept = companyDepts.find(d => d.id === account.departmentId);
            if (!dept || !dept.active) {
                return { ok: false, code: 409, error: 'The bound department is missing or inactive. Reactivate the department first.' };
            }
        }
    }
    account.status = status;
    persist();
    return { ok: true, account };
}

// ── Referential integrity with the departments store ────────────────────
// A Department Account is meaningless without its department. These helpers
// let the department lifecycle endpoints preserve the binding:
//  • deletion of a department is REJECTED while ANY account (any status)
//    references it — accounts must be removed/re-pointed in a later sprint;
//  • deactivating a department auto-SUSPENDS its ACTIVE account, so no
//    active identity ever points at an inactive department.

// True if any account of the company references the department (any status).
function hasDepartmentAccounts(companyId, departmentId) {
    return (store[companyId] || []).some(a => a.departmentId === departmentId);
}

// Suspend the ACTIVE account bound to a department (if any). Used when the
// department is deactivated. Returns the suspended account or null.
function suspendAccountsForDepartment(companyId, departmentId) {
    const account = findDepartmentAccountByDepartment(companyId, departmentId);
    if (!account) return null;
    account.status = 'SUSPENDED';
    persist();
    return account;
}

// ── departmentType helpers ───────────────────────────────────────────────
// The type lives ONLY on the department record. Absent field == STANDARD.
// CENTRAL is representation only in this sprint — no permission is derived
// from it yet. Name/position/index have no bearing; Floor/sala is NOT central.

function isValidDepartmentType(t) {
    return DEPARTMENT_TYPES.includes(t);
}

function getDepartmentType(dept) {
    return (dept && dept.departmentType === 'CENTRAL') ? 'CENTRAL' : 'STANDARD';
}

// Sets a department's type, enforcing MAX ONE CENTRAL per company with the
// reject-until-reverted strategy: setting a second CENTRAL is rejected until
// the existing CENTRAL department is explicitly reverted to STANDARD.
// `companyDepts` must be the session company's own array (mutated in place);
// the caller persists the departments store on success.
function setDepartmentType(companyDepts, departmentId, departmentType) {
    if (!isValidDepartmentType(departmentType)) {
        return { ok: false, code: 400, error: `departmentType must be one of: ${DEPARTMENT_TYPES.join(', ')}` };
    }
    const dept = (companyDepts || []).find(d => d.id === departmentId);
    if (!dept) return { ok: false, code: 404, error: 'Department not found.' };

    if (departmentType === 'CENTRAL') {
        const existingCentral = companyDepts.find(
            d => d.id !== departmentId && getDepartmentType(d) === 'CENTRAL'
        );
        if (existingCentral) {
            return {
                ok: false, code: 409,
                error: `Company already has a CENTRAL department ("${existingCentral.name}"). Revert it to STANDARD first.`
            };
        }
    }
    dept.departmentType = departmentType;
    return { ok: true, department: dept };
}

module.exports = {
    ACCOUNT_STATUSES,
    DEPARTMENT_TYPES,
    setStore,
    getStore,
    setPersist,
    getDepartmentAccounts,
    findDepartmentAccountByUid,
    findDepartmentAccountByDepartment,
    findDepartmentAccountByLoginIdentifier,
    validateDepartmentAccountDepartment,
    bindFirebaseUid,
    createDepartmentAccount,
    updateDepartmentAccount,
    setDepartmentAccountStatus,
    hasDepartmentAccounts,
    suspendAccountsForDepartment,
    isValidDepartmentType,
    getDepartmentType,
    setDepartmentType,
    createPasswordHash,
    verifyPassword,
};
