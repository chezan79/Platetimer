// service/department-accounts.js — Department Account model (Service side).
// Sprint S1.1 — FOUNDATION ONLY.
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
//   loginIdentifier string  unique across all companies — METADATA ONLY in
//                           this sprint (no login flow, no password, no hash)
//   firebaseUid     null    (stays null until a later sprint binds Firebase Auth)
//   status          'ACTIVE' | 'SUSPENDED'
//   createdAt       number (ms)
//   createdBy       string (uid of the creating session)
//
// NO passwords or password hashes are ever stored on these records.

const crypto = require('crypto');

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

// ── Mutations ────────────────────────────────────────────────────────────

// Creates a Department Account. Enforces:
//  • department exists, belongs to the actor company, and is active
//  • max ONE ACTIVE account per department
//  • loginIdentifier unique across all companies
// Returns { ok, account } or { ok:false, code, error }.
function createDepartmentAccount({ companyId, departmentId, displayName, loginIdentifier, createdBy }, companyDepts) {
    const v = validateDepartmentAccountDepartment(companyId, departmentId, companyDepts);
    if (!v.ok) return v;

    const name = (displayName || '').trim();
    if (!name) return { ok: false, code: 400, error: 'displayName is required.' };
    if (name.length > 80) return { ok: false, code: 400, error: 'displayName too long (max 80).' };

    const login = (loginIdentifier || '').trim().toLowerCase();
    if (!login) return { ok: false, code: 400, error: 'loginIdentifier is required.' };
    if (login.length > 120) return { ok: false, code: 400, error: 'loginIdentifier too long (max 120).' };

    if (findDepartmentAccountByDepartment(companyId, departmentId)) {
        return { ok: false, code: 409, error: 'This department already has an ACTIVE account. Suspend it first.' };
    }
    if (findDepartmentAccountByLoginIdentifier(login)) {
        return { ok: false, code: 409, error: 'loginIdentifier already in use.' };
    }

    const account = {
        id: genAccountId(),
        companyId,
        departmentId,
        displayName: name,
        loginIdentifier: login,
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
    createDepartmentAccount,
    setDepartmentAccountStatus,
    hasDepartmentAccounts,
    suspendAccountsForDepartment,
    isValidDepartmentType,
    getDepartmentType,
    setDepartmentType,
};
