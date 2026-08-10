#!/usr/bin/env node
'use strict';
/**
 * PlateTimer Operations — Sprint 6.0 Intelligence Engine Tests
 *
 * Verifies: attention generation, workload calculation, load score formula,
 * suggestions, daily summary, company isolation, Director-only access,
 * empty company, overloaded users, suspended-user alerts.
 *
 * Auth pattern (same as Sprint 2–5): HMAC token in Authorization header.
 * Run: node tests/operations-sprint6.test.js
 */

const http    = require('http');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawn } = require('child_process');

const SECRET  = 'test-sprint6-secret';
const PORT    = 4460;

// ── HMAC token ────────────────────────────────────────────────────────────────
function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3_600_000,
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
    console.log('Starting server (Sprint 6 Intelligence tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstest-s6-'));
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
    console.log('Server up. Running Sprint 6 intelligence checks…\n');

    try {
        // ── Tokens ────────────────────────────────────────────────────────────
        const dirA  = sign('uid-s6-dirA', 'sprint6-co-a');
        const dirB  = sign('uid-s6-dirB', 'sprint6-co-b');

        // ── S6-0 / S6-1: Bootstrap directors ─────────────────────────────────
        let r = await api(dirA, 'GET', '/api/operations/me');
        check('S6-0. Director A bootstrapped', r.data && r.data.success, r.data);
        const dirAId = r.data && r.data.user && r.data.user.id;

        r = await api(dirB, 'GET', '/api/operations/me');
        check('S6-1. Director B bootstrapped (isolation company)', r.data && r.data.success, r.data);

        // ── S6-2 – S6-7: Basic endpoint contract ──────────────────────────────
        r = await api(dirA, 'GET', '/api/operations/intelligence');
        check('S6-2. GET /api/operations/intelligence returns 200', r.status === 200, r.status);
        check('S6-3. Response success:true', r.data && r.data.success === true, r.data);
        check('S6-4. Response has attention array',   Array.isArray(r.data && r.data.attention),   r.data);
        check('S6-5. Response has workload array',    Array.isArray(r.data && r.data.workload),    r.data);
        check('S6-6. Response has suggestions array', Array.isArray(r.data && r.data.suggestions), r.data);
        check('S6-7. Response has summary object',
            r.data && typeof r.data.summary === 'object' && r.data.summary !== null, r.data);

        // ── S6-8 – S6-12: Summary fields ──────────────────────────────────────
        const sum0 = r.data && r.data.summary;
        check('S6-8.  summary.completedToday present',          sum0 && 'completedToday'        in sum0, sum0);
        check('S6-9.  summary.overdueToday present',            sum0 && 'overdueToday'          in sum0, sum0);
        check('S6-10. summary.urgentOpen present',              sum0 && 'urgentOpen'            in sum0, sum0);
        check('S6-11. summary.completionRate present',          sum0 && 'completionRate'        in sum0, sum0);
        check('S6-12. summary.usersNeedingAttention is array',  sum0 && Array.isArray(sum0.usersNeedingAttention), sum0);

        // ── S6-13: Director-only enforcement ─────────────────────────────────
        // Strategy: use a UID that is not in the ops store but company already has
        // users. requireOpsAuth will return 403 ("not a member of this company").
        // Also verify via module that canManageUsers is Director-only.
        const opsAuth = require('../operations/ops-auth');
        const ghostR = await api(sign('uid-s6-ghost', 'sprint6-co-a'), 'GET', '/api/operations/intelligence');
        check('S6-13. Non-member token gets 403 on intelligence endpoint', ghostR.status === 403, ghostR.status);
        check('S6-13b. canManageUsers returns false for CHEF_CUISINE',
            opsAuth.canManageUsers({ role: 'CHEF_CUISINE' }) === false, true);

        // ── S6-14: Unauthenticated gets 401 ──────────────────────────────────
        r = await api('invalid-token', 'GET', '/api/operations/intelligence');
        check('S6-14. Invalid token returns 401', r.status === 401 || r.status === 403, r.status);

        // ── S6-15 / S6-16: Empty company (B) ─────────────────────────────────
        const bR = await api(dirB, 'GET', '/api/operations/intelligence');
        check('S6-15. Empty company: attention array is empty',
            bR.data && Array.isArray(bR.data.attention) && bR.data.attention.length === 0,
            bR.data && bR.data.attention);
        check('S6-16. Empty company: suggestions array is empty',
            bR.data && Array.isArray(bR.data.suggestions) && bR.data.suggestions.length === 0,
            bR.data && bR.data.suggestions);

        // ── Create scenario tasks for company A ───────────────────────────────
        // Task 1: URGENT + OPEN (not started) + due tomorrow → "urgent not started" HIGH alert
        const t1R = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Urgent task not started', priority: 'URGENT',
            assigneeId: dirAId, dueDate: tomorrow(), department: 'Cucina',
        });
        const task1 = t1R.data && t1R.data.task;
        check('S6-17. Task 1 created (URGENT/OPEN/tomorrow)', !!task1, t1R.data && t1R.data.error);

        // Task 2: URGENT + OPEN + overdue (2h ago) → "overdue" HIGH alert
        const t2R = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'Overdue urgent task', priority: 'URGENT',
            assigneeId: dirAId, dueDate: hoursAgo(2), department: 'Cucina',
        });
        const task2 = t2R.data && t2R.data.task;
        check('S6-18. Task 2 created (URGENT/OPEN/overdue)', !!task2, t2R.data && t2R.data.error);

        // ── S6-19 – S6-24: Attention alerts ──────────────────────────────────
        r = await api(dirA, 'GET', '/api/operations/intelligence');
        const att = r.data && r.data.attention;

        check('S6-19. attention array non-empty after adding tasks', att && att.length > 0, att && att.length);

        const highAlerts = att && att.filter(a => a.severity === 'HIGH');
        check('S6-20. At least one HIGH alert present', highAlerts && highAlerts.length > 0, highAlerts && highAlerts.length);

        const overdueAlert = att && att.find(
            a => a.severity === 'HIGH' && a.linkedTask === (task2 && task2.id)
        );
        check('S6-21. Overdue task generates HIGH alert with correct linkedTask', !!overdueAlert, overdueAlert);

        const urgentAlert = att && att.find(
            a => a.severity === 'HIGH' && a.linkedTask === (task1 && task1.id)
        );
        check('S6-22. Urgent not-started task generates HIGH alert', !!urgentAlert, urgentAlert);

        // All required alert fields present
        const ALERT_FIELDS = ['id', 'severity', 'title', 'description', 'recommendedAction',
                              'linkedTask', 'linkedUser', 'department', 'timestamp'];
        const firstAlert = att && att[0];
        check('S6-23. Alert object has all required fields',
            firstAlert && ALERT_FIELDS.every(f => f in firstAlert),
            firstAlert && ALERT_FIELDS.filter(f => !(f in firstAlert)));

        // Alerts must be sorted HIGH → MEDIUM → LOW
        const SEV_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };
        let sortedOk = true;
        if (att && att.length > 1) {
            for (let i = 1; i < att.length; i++) {
                if (SEV_ORDER[att[i - 1].severity] > SEV_ORDER[att[i].severity]) {
                    sortedOk = false; break;
                }
            }
        }
        check('S6-24. Attention alerts sorted HIGH → MEDIUM → LOW', sortedOk,
            att && att.map(a => a.severity));

        // ── S6-25 – S6-29: Workload calculation ──────────────────────────────
        const wl = r.data && r.data.workload;
        check('S6-25. Workload array contains at least one entry', wl && wl.length > 0, wl && wl.length);

        const dirEntry = wl && wl.find(w => w.userId === dirAId);
        check('S6-26. Director entry present in workload', !!dirEntry, wl && wl.map(w => w.userId));
        check('S6-27. Director workload.assigned ≥ 2', dirEntry && dirEntry.assigned >= 2, dirEntry && dirEntry.assigned);
        check('S6-28. Director workload.overdue ≥ 1',  dirEntry && dirEntry.overdue  >= 1, dirEntry && dirEntry.overdue);
        check('S6-29. Director workload.urgent ≥ 1',   dirEntry && dirEntry.urgent   >= 1, dirEntry && dirEntry.urgent);

        // ── S6-30 – S6-31: Load score formula ────────────────────────────────
        if (dirEntry) {
            const expected = dirEntry.assigned * 1 + dirEntry.overdue * 3 + dirEntry.urgent * 2;
            check('S6-30. Load score = assigned×1 + overdue×3 + urgent×2',
                dirEntry.currentLoadScore === expected,
                `score=${dirEntry.currentLoadScore} expected=${expected}`);
        } else {
            check('S6-30. Load score formula', false, 'no director entry');
        }

        // averageCompletionTime = 0 when no completed tasks
        check('S6-31. averageCompletionTime = 0 when no completed tasks',
            dirEntry && dirEntry.averageCompletionTime === 0,
            dirEntry && dirEntry.averageCompletionTime);

        // ── S6-32 – S6-34: Push director to OVERLOADED ────────────────────────
        // Add 3 more URGENT/overdue tasks → score will be ≥ 10 → OVERLOADED
        for (let i = 0; i < 3; i++) {
            await api(dirA, 'POST', '/api/operations/tasks', {
                title: `Extra overdue urgent ${i + 1}`, priority: 'URGENT',
                assigneeId: dirAId, dueDate: hoursAgo(3), department: 'Cucina',
            });
        }

        r = await api(dirA, 'GET', '/api/operations/intelligence');
        const wl2      = r.data && r.data.workload;
        const dirE2    = wl2 && wl2.find(w => w.userId === dirAId);
        const att2     = r.data && r.data.attention;

        check('S6-32. OVERLOADED status when score ≥ 10',
            dirE2 && dirE2.currentLoadScore >= 10 && dirE2.status === 'OVERLOADED',
            dirE2 && { score: dirE2.currentLoadScore, status: dirE2.status });

        const overloadedAlert = att2 && att2.find(
            a => a.severity === 'MEDIUM' && a.linkedUser === dirAId
        );
        check('S6-33. Overloaded user generates MEDIUM attention alert', !!overloadedAlert, overloadedAlert);

        // MEDIUM alert for dept with many urgent tasks (Cucina has ≥ 2 urgent tasks)
        const deptAlert = att2 && att2.find(
            a => a.severity === 'MEDIUM' && a.department === 'Cucina'
        );
        check('S6-34. MEDIUM alert for dept with ≥ 2 urgent tasks', !!deptAlert, att2 && att2.filter(a => a.severity === 'MEDIUM'));

        // ── S6-35 – S6-36: Suggestions ───────────────────────────────────────
        const sugs2 = r.data && r.data.suggestions;
        check('S6-35. Suggestions array non-empty when issues exist', sugs2 && sugs2.length > 0, sugs2 && sugs2.length);

        const REQUIRED_SUG = ['id', 'type', 'title', 'description', 'linkedTask', 'linkedUser', 'targetUser', 'department'];
        const firstSug = sugs2 && sugs2[0];
        check('S6-36. Suggestion object has all required fields',
            firstSug && REQUIRED_SUG.every(f => f in firstSug),
            firstSug && REQUIRED_SUG.filter(f => !(f in firstSug)));

        // ── S6-37 – S6-39: Summary counts ─────────────────────────────────────
        const sum2 = r.data && r.data.summary;
        check('S6-37. summary.overdueToday ≥ 4', sum2 && sum2.overdueToday >= 4, sum2 && sum2.overdueToday);
        check('S6-38. summary.urgentOpen ≥ 2',   sum2 && sum2.urgentOpen   >= 2, sum2 && sum2.urgentOpen);
        check('S6-39. summary.completionRate = 0 (no completions yet)',
            sum2 && sum2.completionRate === 0, sum2 && sum2.completionRate);

        // ── S6-40 – S6-42: Suspended user scenario ────────────────────────────
        // Invite a Sous Chef (INVITED status) — no Firebase activation needed.
        // The suspend endpoint works on any user in the ops store that is not
        // already suspended, regardless of activation status.
        const inv2R = await api(dirA, 'POST', '/api/operations/users', {
            name: 'Suspended SC', email: 'sc-s6@test.example', role: 'SOUS_CHEF',
        });
        let suspUserId = inv2R.data && inv2R.data.user && inv2R.data.user.id;

        if (suspUserId) {
            // Assign a task to the Sous Chef
            await api(dirA, 'POST', '/api/operations/tasks', {
                title: 'Task for suspended user', priority: 'NORMAL',
                assigneeId: suspUserId, dueDate: tomorrow(), department: 'Sala',
            });

            // Suspend them
            await api(dirA, 'POST', `/api/operations/users/${suspUserId}/suspend`, {
                reason: 'Test suspension sprint6',
            });

            r = await api(dirA, 'GET', '/api/operations/intelligence');
            const att3 = r.data && r.data.attention;
            const suspAlert = att3 && att3.find(
                a => a.severity === 'HIGH' && a.linkedUser === suspUserId
            );
            check('S6-40. Suspended user with active tasks → HIGH alert', !!suspAlert, suspAlert);

            const sugs3   = r.data && r.data.suggestions;
            const suspSug = sugs3 && sugs3.find(s => s.type === 'REASSIGN_SUSPENDED' && s.linkedUser === suspUserId);
            check('S6-41. Suggestion generated for suspended user tasks', !!suspSug, sugs3 && sugs3.map(s => s.type));

            const sum3      = r.data && r.data.summary;
            const needsAttn = sum3 && sum3.usersNeedingAttention.find(u => u.userId === suspUserId);
            check('S6-42. Suspended user in summary.usersNeedingAttention', !!needsAttn,
                sum3 && sum3.usersNeedingAttention);
        } else {
            check('S6-40. Suspended user with active tasks → HIGH alert', false, 'SC activation failed');
            check('S6-41. Suggestion generated for suspended user tasks',   false, 'skipped');
            check('S6-42. Suspended user in summary.usersNeedingAttention', false, 'skipped');
        }

        // ── S6-43: BUSY status (score 5–9) ────────────────────────────────────
        // Verify BUSY workload level by creating a user at that score level.
        // A user with 5 assigned, 0 overdue, 0 urgent → score 5 → BUSY
        // We'll check that the engine correctly uses the status thresholds by
        // looking at the module-level exports directly.
        const intel = require('../operations/ops-intelligence');
        check('S6-43. loadStatus NORMAL at score 4',     intel._loadStatus(intel._computeLoadScore({ assigned: 4, overdue: 0, urgent: 0 })) === 'NORMAL',    intel._loadStatus(4));
        check('S6-44. loadStatus BUSY at score 5',       intel._loadStatus(intel._computeLoadScore({ assigned: 5, overdue: 0, urgent: 0 })) === 'BUSY',       intel._loadStatus(5));
        check('S6-45. loadStatus OVERLOADED at score 10',intel._loadStatus(intel._computeLoadScore({ assigned: 10,overdue: 0, urgent: 0 })) === 'OVERLOADED', intel._loadStatus(10));
        check('S6-46. Load score 0 overdue 1 → score 3', intel._computeLoadScore({ assigned: 0, overdue: 1, urgent: 0 }) === 3, intel._computeLoadScore({ assigned: 0, overdue: 1, urgent: 0 }));
        check('S6-47. Load score formula mixed', intel._computeLoadScore({ assigned: 2, overdue: 1, urgent: 2 }) === 2 + 3 + 4, intel._computeLoadScore({ assigned: 2, overdue: 1, urgent: 2 }));

        // ── S6-48: Company B isolation ────────────────────────────────────────
        const bR2 = await api(dirB, 'GET', '/api/operations/intelligence');
        check('S6-48. Company B: no attention from company A',
            bR2.data && Array.isArray(bR2.data.attention) && bR2.data.attention.length === 0,
            bR2.data && bR2.data.attention);
        check('S6-49. Company B: no suggestions from company A',
            bR2.data && Array.isArray(bR2.data.suggestions) && bR2.data.suggestions.length === 0,
            bR2.data && bR2.data.suggestions);
        // Company B workload contains only company B's own users (the Director
        // bootstrapped above). Verify no company A user IDs appear there.
        const bWlIds = bR2.data && bR2.data.workload && bR2.data.workload.map(w => w.userId);
        check('S6-50. Company B: workload contains no company A user IDs',
            bWlIds && !bWlIds.includes(dirAId),
            { bWlIds, dirAId });

    } finally {
        proc.kill();
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exit(failed > 0 ? 1 : 0);
    }
}

run().catch(e => { console.error(e); process.exit(1); });
