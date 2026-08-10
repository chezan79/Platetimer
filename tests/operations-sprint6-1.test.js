#!/usr/bin/env node
'use strict';
/**
 * PlateTimer Operations — Sprint 6.1 Decision Support Engine Tests
 *
 * Verifies: decision types, reason generation, supporting facts, confidence
 * calculation, sorting, quick action mapping, Director-only, company isolation,
 * no card below confidence threshold.
 *
 * Mix of HTTP integration tests (real server) and module-level unit tests
 * (direct call to analyzeIntelligence / generateDecisions with synthetic data).
 *
 * Run: node tests/operations-sprint6-1.test.js
 */

const http    = require('http');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawn } = require('child_process');

const SECRET  = 'test-sprint61-secret';
const PORT    = 4461;

// ── HMAC token ────────────────────────────────────────────────────────────────
function sign(uid, company) {
    const p = Buffer.from(JSON.stringify({
        uid, companyName: company, iat: Date.now(), exp: Date.now() + 3_600_000,
    })).toString('base64');
    const s = crypto.createHmac('sha256', SECRET).update(p).digest('hex');
    return `${p}.${s}`;
}

// ── Result tracking ───────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else { console.error(`  ❌ ${label}${hint !== undefined ? ' — got: ' + JSON.stringify(hint) : ''}`); failed++; }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function api(token, method, p, body) {
    return new Promise((resolve, reject) => {
        const buf = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...(buf ? { 'Content-Length': Buffer.byteLength(buf) } : {}),
            },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
                catch { resolve({ status: res.statusCode, data: d }); }
            });
        });
        req.on('error', reject);
        if (buf) req.write(buf);
        req.end();
    });
}

// ── Date helpers ──────────────────────────────────────────────────────────────
const hoursAgo = h => new Date(Date.now() - h * 3_600_000).toISOString();
const tomorrow  = ()  => new Date(Date.now() + 24 * 3_600_000).toISOString();

// ── Required decision fields ──────────────────────────────────────────────────
const DEC_FIELDS = [
    'id', 'type', 'severity', 'title', 'reason', 'recommendedAction',
    'confidence', 'supportingFacts', 'linkedTask', 'linkedUser',
    'department', 'quickAction', 'generatedAt',
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
    console.log('Starting server (Sprint 6.1 Decision Support tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstest-s61-'));
    const proc = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT), WS_SESSION_SECRET: SECRET, DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
        proc.stdout.on('data', d => {
            if (d.toString().includes('Server avviato')) { clearTimeout(t); resolve(); }
        });
    });
    console.log('Server up. Running Sprint 6.1 decision checks…\n');

    try {
        // ── Tokens & bootstrap ────────────────────────────────────────────────
        const dirA = sign('uid-s61-dirA', 'sprint61-co-a');
        const dirB = sign('uid-s61-dirB', 'sprint61-co-b');

        let r = await api(dirA, 'GET', '/api/operations/me');
        check('S61-0. Director A bootstrapped', r.data && r.data.success, r.data);
        const dirAId = r.data && r.data.user && r.data.user.id;

        r = await api(dirB, 'GET', '/api/operations/me');
        check('S61-1. Director B bootstrapped (isolation)', r.data && r.data.success, r.data);

        // ── S61-2: Response now includes decisions field ───────────────────────
        r = await api(dirA, 'GET', '/api/operations/intelligence');
        check('S61-2. Response includes decisions array', Array.isArray(r.data && r.data.decisions), r.data);

        // ── S61-3: Backward compat — attention/workload/suggestions/summary still present
        check('S61-3a. attention still present',   Array.isArray(r.data && r.data.attention),   r.data);
        check('S61-3b. workload still present',    Array.isArray(r.data && r.data.workload),    r.data);
        check('S61-3c. suggestions still present', Array.isArray(r.data && r.data.suggestions), r.data);
        check('S61-3d. summary still present',     typeof (r.data && r.data.summary) === 'object', r.data);

        // ── Create tasks to trigger decisions ─────────────────────────────────
        // 5 URGENT + overdue tasks on director → OVERLOADED, OPENING_NOT_STARTED,
        // URGENT_DEPARTMENT (≥2 in Cucina), CHECK_DEPARTMENT (≥2 overdue in Cucina)
        for (let i = 0; i < 5; i++) {
            await api(dirA, 'POST', '/api/operations/tasks', {
                title: `Overdue urgent task ${i + 1}`, priority: 'URGENT',
                assigneeId: dirAId, dueDate: hoursAgo(2), department: 'Cucina',
            });
        }

        // One URGENT + OPEN + future due (OPENING_NOT_STARTED, lower confidence)
        const t1R = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Urgent future task', priority: 'URGENT',
            assigneeId: dirAId, dueDate: tomorrow(), department: 'Cucina',
        });
        const task1 = t1R.data && t1R.data.task;

        r = await api(dirA, 'GET', '/api/operations/intelligence');
        const decs = r.data && r.data.decisions;

        check('S61-4. decisions array non-empty after adding tasks', decs && decs.length > 0, decs && decs.length);

        // ── S61-5: All required fields present ───────────────────────────────
        const firstDec = decs && decs[0];
        check('S61-5. Decision card has all required fields',
            firstDec && DEC_FIELDS.every(f => f in firstDec),
            firstDec && DEC_FIELDS.filter(f => !(f in firstDec)));

        // ── S61-6: confidence is a number ≥ 50 ──────────────────────────────
        check('S61-6. confidence is number ≥ 50',
            firstDec && typeof firstDec.confidence === 'number' && firstDec.confidence >= 50,
            firstDec && firstDec.confidence);

        // ── S61-7: supportingFacts is a non-empty array ───────────────────────
        check('S61-7. supportingFacts is non-empty array',
            firstDec && Array.isArray(firstDec.supportingFacts) && firstDec.supportingFacts.length > 0,
            firstDec && firstDec.supportingFacts);

        // ── S61-8: reason is a non-empty string with actual data ─────────────
        check('S61-8. reason is a non-empty string', typeof firstDec.reason === 'string' && firstDec.reason.length > 10, firstDec && firstDec.reason);

        // ── S61-9: quickAction has label and url ─────────────────────────────
        check('S61-9a. quickAction.label present',
            firstDec && firstDec.quickAction && typeof firstDec.quickAction.label === 'string',
            firstDec && firstDec.quickAction);
        check('S61-9b. quickAction.url present',
            firstDec && firstDec.quickAction && typeof firstDec.quickAction.url === 'string',
            firstDec && firstDec.quickAction);

        // ── S61-10: OVERLOADED_USER decision generated ───────────────────────
        const overloadedDec = decs && decs.find(d => d.type === 'OVERLOADED_USER');
        check('S61-10. OVERLOADED_USER decision generated', !!overloadedDec, overloadedDec);
        check('S61-10b. OVERLOADED_USER severity is HIGH', overloadedDec && overloadedDec.severity === 'HIGH', overloadedDec && overloadedDec.severity);
        check('S61-10c. OVERLOADED_USER confidence ≥ 80',  overloadedDec && overloadedDec.confidence >= 80,  overloadedDec && overloadedDec.confidence);
        check('S61-10d. OVERLOADED_USER reason contains user name',
            overloadedDec && r.data.workload.some(w => w.status === 'OVERLOADED' && overloadedDec.reason.includes(w.userName)),
            overloadedDec && overloadedDec.reason);
        check('S61-10e. OVERLOADED_USER quickAction links to team page',
            overloadedDec && overloadedDec.quickAction && overloadedDec.quickAction.url.includes('operations-team'),
            overloadedDec && overloadedDec.quickAction);

        // ── S61-11: OPENING_NOT_STARTED decision generated ───────────────────
        const openingDec = decs && decs.find(d => d.type === 'OPENING_NOT_STARTED');
        check('S61-11. OPENING_NOT_STARTED decision generated', !!openingDec, openingDec);
        check('S61-11b. OPENING_NOT_STARTED severity is HIGH', openingDec && openingDec.severity === 'HIGH', openingDec && openingDec.severity);
        check('S61-11c. OPENING_NOT_STARTED linkedTask set',   openingDec && !!openingDec.linkedTask, openingDec);
        check('S61-11d. OPENING_NOT_STARTED quickAction links to task page',
            openingDec && openingDec.quickAction && openingDec.quickAction.url.includes('operations-tasks'),
            openingDec && openingDec.quickAction);

        // ── S61-12: URGENT_DEPARTMENT decision generated (≥2 urgent in Cucina) ─
        const urgDeptDec = decs && decs.find(d => d.type === 'URGENT_DEPARTMENT' && d.department === 'Cucina');
        check('S61-12. URGENT_DEPARTMENT decision generated for Cucina', !!urgDeptDec, urgDeptDec);
        check('S61-12b. URGENT_DEPARTMENT confidence = 80', urgDeptDec && urgDeptDec.confidence === 80, urgDeptDec && urgDeptDec.confidence);
        check('S61-12c. URGENT_DEPARTMENT supportingFacts include urgent count',
            urgDeptDec && urgDeptDec.supportingFacts && urgDeptDec.supportingFacts.some(f => f.includes('Urgenti') && /\d+/.test(f)),
            urgDeptDec && urgDeptDec.supportingFacts);

        // ── S61-13: CHECK_DEPARTMENT decision generated (≥2 overdue in Cucina) ─
        const chkDeptDec = decs && decs.find(d => d.type === 'CHECK_DEPARTMENT' && d.department === 'Cucina');
        check('S61-13. CHECK_DEPARTMENT decision generated for Cucina', !!chkDeptDec, chkDeptDec);
        check('S61-13b. CHECK_DEPARTMENT reason contains actual minutes',
            chkDeptDec && /\d+ minuti/.test(chkDeptDec.reason),
            chkDeptDec && chkDeptDec.reason);

        // ── S61-14: Sorting — HIGH before MEDIUM, then confidence desc ────────
        const sortOk = (() => {
            if (!decs || decs.length < 2) return true;
            const SEV = { HIGH: 0, MEDIUM: 1, LOW: 2 };
            for (let i = 1; i < decs.length; i++) {
                const s = SEV[decs[i-1].severity] - SEV[decs[i].severity];
                if (s > 0) return false; // lower severity before higher = wrong
                if (s === 0 && decs[i-1].confidence < decs[i].confidence) return false; // lower conf before higher = wrong
            }
            return true;
        })();
        check('S61-14. Decisions sorted severity→confidence desc', sortOk, decs && decs.map(d => `${d.severity}/${d.confidence}`));

        // ── S61-15: No decision with confidence < MIN_CONFIDENCE ─────────────
        const belowThreshold = decs && decs.filter(d => d.confidence < 50);
        check('S61-15. No decision with confidence < 50',
            belowThreshold && belowThreshold.length === 0, belowThreshold);

        // ── S61-16: Suspended user → SUSPENDED_USER_WITH_TASKS decision ──────
        const inv2R = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Suspended User S61', email: 'susp-s61@test.example', role: 'SOUS_CHEF',
        });
        const suspUserId = inv2R.data && inv2R.data.user && inv2R.data.user.id;
        if (suspUserId) {
            await api(dirA, 'POST', '/api/operations/tasks', {
                title: 'Task for suspended S61', priority: 'NORMAL',
                assigneeId: suspUserId, dueDate: tomorrow(), department: 'Sala',
            });
            await api(dirA, 'POST', `/api/operations/users/${suspUserId}/suspend`, {
                reason: 'Sprint 6.1 test',
            });
            r = await api(dirA, 'GET', '/api/operations/intelligence');
            const suspDec = r.data.decisions.find(d => d.type === 'SUSPENDED_USER_WITH_TASKS' && d.linkedUser === suspUserId);
            check('S61-16. SUSPENDED_USER_WITH_TASKS decision generated', !!suspDec, suspDec);
            check('S61-16b. confidence = 95', suspDec && suspDec.confidence === 95, suspDec && suspDec.confidence);
            check('S61-16c. severity is HIGH', suspDec && suspDec.severity === 'HIGH', suspDec && suspDec.severity);
            check('S61-16d. reason contains user name',
                suspDec && suspDec.reason.includes('Suspended User S61'), suspDec && suspDec.reason);
            check('S61-16e. quickAction links to team page',
                suspDec && suspDec.quickAction && suspDec.quickAction.url.includes('operations-team'),
                suspDec && suspDec.quickAction);
        } else {
            ['S61-16','S61-16b','S61-16c','S61-16d','S61-16e'].forEach(id =>
                check(id + '. SUSPENDED_USER_WITH_TASKS', false, 'invite failed'));
        }

        // ── S61-17: Company isolation ─────────────────────────────────────────
        const bR = await api(dirB, 'GET', '/api/operations/intelligence');
        check('S61-17. Company B decisions empty (no company A data)',
            bR.data && Array.isArray(bR.data.decisions) && bR.data.decisions.length === 0,
            bR.data && bR.data.decisions);

        // ── S61-18: Director-only (ghost UID → 403) ───────────────────────────
        const ghostR = await api(sign('uid-s61-ghost', 'sprint61-co-a'), 'GET', '/api/operations/intelligence');
        check('S61-18. Ghost UID gets 403', ghostR.status === 403, ghostR.status);

        // ── S61-19 – S61-38: Module-level unit tests (synthetic data) ─────────
        console.log('\n  — Module-level unit tests —\n');
        const intel = require('../operations/ops-intelligence');
        const now   = Date.now();

        // Synthetic active users
        const uActive1 = { id: 'u1', name: 'Mario', role: 'CHEF_CUISINE', status: 'ACTIVE',
                           companyId: 'test-co' };
        const uActive2 = { id: 'u2', name: 'Luca',  role: 'SOUS_CHEF',   status: 'ACTIVE',
                           companyId: 'test-co' };
        const uSusp    = { id: 'u3', name: 'Anna',  role: 'SOUS_CHEF',   status: 'SUSPENDED',
                           companyId: 'test-co' };

        // Synthetic overdue task
        const overdueTask = {
            id: 't1', title: 'Pulizia cucina', status: 'OPEN', priority: 'URGENT',
            assigneeId: 'u1', assigneeName: 'Mario',
            dueDate: new Date(now - 90 * 60_000).toISOString(), // 90 min ago
            department: 'Cucina', createdAt: new Date(now - 3 * 3_600_000).toISOString(),
            completedAt: null, updatedAt: new Date(now - 2 * 3_600_000).toISOString(),
            templateId: null,
        };
        // Synthetic non-urgent open task on u1 (movable for REASSIGN_TASK)
        const normalTask = {
            id: 't2', title: 'Stoccaggio merce', status: 'OPEN', priority: 'LOW',
            assigneeId: 'u1', assigneeName: 'Mario',
            dueDate: new Date(now + 5 * 3_600_000).toISOString(),
            department: 'Magazzino', createdAt: new Date(now - 3_600_000).toISOString(),
            completedAt: null, updatedAt: new Date(now - 3_600_000).toISOString(),
            templateId: null,
        };
        // Synthetic recurring overdue task
        const recurringTask = {
            id: 't3', title: 'Checklist apertura', status: 'OPEN', priority: 'NORMAL',
            assigneeId: 'u1', assigneeName: 'Mario',
            dueDate: new Date(now - 45 * 60_000).toISOString(),
            department: 'Cucina', createdAt: new Date(now - 4 * 3_600_000).toISOString(),
            completedAt: null, updatedAt: new Date(now - 4 * 3_600_000).toISOString(),
            templateId: 'tmpl_1', // marks it as recurring
        };
        // Task for suspended user
        const suspTask = {
            id: 't4', title: 'Task di Anna', status: 'OPEN', priority: 'NORMAL',
            assigneeId: 'u3', assigneeName: 'Anna',
            dueDate: new Date(now + 3_600_000).toISOString(),
            department: 'Sala', createdAt: new Date(now - 3_600_000).toISOString(),
            completedAt: null, updatedAt: new Date(now - 3_600_000).toISOString(),
            templateId: null,
        };

        // u1 gets score ≥ 10: 3 tasks (3×1) + 1 overdue (1×3) + 2 urgent (2×2) = 3+3+4=10 exactly
        // Use: overdueTask (urgent+overdue), normalTask (non-urgent), plus we'll add more tasks synthetically
        // Easier: compute directly from analyzeIntelligence with many tasks on u1
        const synTasks = [overdueTask, normalTask, recurringTask, suspTask];
        // Add 2 more urgents on u1 to guarantee OVERLOADED
        for (let i = 0; i < 3; i++) {
            synTasks.push({
                id: `t_extra_${i}`, title: `Extra urgent ${i}`, status: 'OPEN', priority: 'URGENT',
                assigneeId: 'u1', assigneeName: 'Mario',
                dueDate: new Date(now - (i + 1) * 30 * 60_000).toISOString(),
                department: 'Cucina', createdAt: new Date(now - 3_600_000).toISOString(),
                completedAt: null, updatedAt: new Date(now - 3_600_000).toISOString(),
                templateId: null,
            });
        }

        const synResult = intel.analyzeIntelligence('test-co', {
            tasks: synTasks,
            users: [uActive1, uActive2, uSusp],
        });
        const synDecs = synResult.decisions;

        check('S61-19. analyzeIntelligence returns decisions',
            Array.isArray(synDecs), synDecs);

        // REVIEW_RECURRING generated for recurringTask (templateId set)
        const recDec = synDecs.find(d => d.type === 'REVIEW_RECURRING' && d.linkedTask === 't3');
        check('S61-20. REVIEW_RECURRING decision for recurring overdue task', !!recDec, recDec);
        check('S61-21. REVIEW_RECURRING confidence = 85', recDec && recDec.confidence === 85, recDec && recDec.confidence);
        check('S61-21b. REVIEW_RECURRING supportingFacts includes tipo ricorrente',
            recDec && recDec.supportingFacts && recDec.supportingFacts.some(f => f.toLowerCase().includes('ricorrente')),
            recDec && recDec.supportingFacts);

        // SUSPENDED_USER_WITH_TASKS — synthetic
        const synSuspDec = synDecs.find(d => d.type === 'SUSPENDED_USER_WITH_TASKS' && d.linkedUser === 'u3');
        check('S61-22. SUSPENDED_USER_WITH_TASKS generated for Anna', !!synSuspDec, synSuspDec);
        check('S61-23. SUSPENDED_USER confidence = 95', synSuspDec && synSuspDec.confidence === 95, synSuspDec && synSuspDec.confidence);

        // REASSIGN_TASK — u1 is OVERLOADED, u2 (Luca) has 0 tasks → NORMAL
        const reassignDec = synDecs.find(d => d.type === 'REASSIGN_TASK');
        check('S61-24. REASSIGN_TASK generated (overloaded → normal)', !!reassignDec, reassignDec);
        check('S61-25. REASSIGN_TASK confidence = 75', reassignDec && reassignDec.confidence === 75, reassignDec && reassignDec.confidence);
        check('S61-25b. REASSIGN_TASK reason uses user names',
            reassignDec && reassignDec.reason.includes('Mario') && reassignDec.reason.includes('Luca'),
            reassignDec && reassignDec.reason);
        check('S61-25c. REASSIGN_TASK reason uses score values',
            reassignDec && /score \d+/.test(reassignDec.reason),
            reassignDec && reassignDec.reason);

        // UNDERUSED_USER — u2 (Luca) has 0 tasks while team has overdue
        const underDec = synDecs.find(d => d.type === 'UNDERUSED_USER' && d.linkedUser === 'u2');
        check('S61-26. UNDERUSED_USER generated for Luca', !!underDec, underDec);
        check('S61-27. UNDERUSED_USER confidence = 70', underDec && underDec.confidence === 70, underDec && underDec.confidence);
        check('S61-28. UNDERUSED_USER reason contains user name',
            underDec && underDec.reason.includes('Luca'), underDec && underDec.reason);
        check('S61-29. UNDERUSED_USER reason contains overdue count',
            underDec && /\d+ compiti? in ritardo/.test(underDec.reason), underDec && underDec.reason);
        check('S61-30. UNDERUSED_USER severity is LOW', underDec && underDec.severity === 'LOW', underDec && underDec.severity);

        // OVERLOADED_USER — u1 (Mario) is OVERLOADED
        const synOverDec = synDecs.find(d => d.type === 'OVERLOADED_USER' && d.linkedUser === 'u1');
        check('S61-31. OVERLOADED_USER generated for Mario', !!synOverDec, synOverDec);
        check('S61-32. OVERLOADED_USER reason contains actual data values',
            synOverDec && /\d+ compiti/.test(synOverDec.reason) && synOverDec.reason.includes('Mario'),
            synOverDec && synOverDec.reason);
        check('S61-33. OVERLOADED_USER supportingFacts includes assigned count',
            synOverDec && synOverDec.supportingFacts && synOverDec.supportingFacts.some(f => f.startsWith('Compiti attivi:')),
            synOverDec && synOverDec.supportingFacts);
        check('S61-34. OVERLOADED_USER supportingFacts includes urgent count',
            synOverDec && synOverDec.supportingFacts && synOverDec.supportingFacts.some(f => f.startsWith('Urgenti:')),
            synOverDec && synOverDec.supportingFacts);

        // Confidence rule: only workload (no overdue, no urgent) → 70
        const onlyWlResult = intel.analyzeIntelligence('test-wl', {
            tasks: Array.from({ length: 10 }, (_, i) => ({
                id: `wl_${i}`, title: `Task ${i}`, status: 'OPEN', priority: 'LOW',
                assigneeId: 'uwl', assigneeName: 'Test',
                dueDate: new Date(Date.now() + (i + 1) * 3_600_000).toISOString(), // all future
                department: 'Test', createdAt: new Date().toISOString(),
                completedAt: null, updatedAt: new Date().toISOString(), templateId: null,
            })),
            users: [{ id: 'uwl', name: 'Test', role: 'CHEF_CUISINE', status: 'ACTIVE', companyId: 'test-wl' }],
        });
        const wlOnlyDec = onlyWlResult.decisions.find(d => d.type === 'OVERLOADED_USER');
        check('S61-35. OVERLOADED workload-only confidence = 70',
            wlOnlyDec && wlOnlyDec.confidence === 70, wlOnlyDec && wlOnlyDec.confidence);

        // Confidence rule: overdue + urgent → 80 (but not both + no recent comp → needs 90)
        const overdueOnlyResult = intel.analyzeIntelligence('test-ov', {
            tasks: Array.from({ length: 5 }, (_, i) => ({
                id: `ov_${i}`, title: `Overdue ${i}`, status: 'OPEN',
                priority: i < 2 ? 'URGENT' : 'LOW', // 2 urgent, 3 non-urgent
                assigneeId: 'uov', assigneeName: 'OvTest',
                dueDate: new Date(Date.now() - 3_600_000).toISOString(), // past → overdue
                department: 'Test', createdAt: new Date().toISOString(),
                completedAt: null, updatedAt: new Date().toISOString(), templateId: null,
            })),
            users: [{ id: 'uov', name: 'OvTest', role: 'CHEF_CUISINE', status: 'ACTIVE', companyId: 'test-ov' }],
        });
        const ovDec = overdueOnlyResult.decisions.find(d => d.type === 'OVERLOADED_USER');
        check('S61-36. OVERLOADED overdue+urgent confidence ≥ 80',
            ovDec && ovDec.confidence >= 80, ovDec && ovDec.confidence);

        // Decisions below MIN_CONFIDENCE suppressed
        // OPENING_NOT_STARTED with no due date → confidence 60 (≥50, should appear)
        // We can't easily force below 50, but we verify the threshold constant
        check('S61-37. MIN_CONFIDENCE constant is 50',
            intel._MIN_CONFIDENCE === 50, intel._MIN_CONFIDENCE);

        // Sorting: SUSPENDED (HIGH/95) should come before UNDERUSED (LOW/70)
        const hiIdx  = synDecs.findIndex(d => d.type === 'SUSPENDED_USER_WITH_TASKS');
        const loIdx  = synDecs.findIndex(d => d.type === 'UNDERUSED_USER');
        check('S61-38. HIGH/95 card sorted before LOW/70 card',
            hiIdx !== -1 && loIdx !== -1 && hiIdx < loIdx, { hiIdx, loIdx });

        // quickAction url convention checks
        const qaTask = synDecs.find(d => d.quickAction && d.quickAction.url.includes('operations-tasks'));
        const qaTeam = synDecs.find(d => d.quickAction && d.quickAction.url.includes('operations-team'));
        check('S61-39. quickAction url references operations-tasks for task decisions', !!qaTask, qaTask && qaTask.type);
        check('S61-40. quickAction url references operations-team for user decisions', !!qaTeam, qaTeam && qaTeam.type);

    } finally {
        proc.kill();
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exit(failed > 0 ? 1 : 0);
    }
}

run().catch(e => { console.error(e); process.exit(1); });
