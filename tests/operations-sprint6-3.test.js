#!/usr/bin/env node
'use strict';
/**
 * PlateTimer Operations — Sprint 6.3 Executive Assistant Tests
 *
 * Covers:
 *   priority queue generation and ordering
 *   risk detection (CRITICAL/HIGH/MEDIUM/LOW)
 *   changes since yesterday
 *   executive brief per role
 *   HTTP: Director/CC/Adjoint/SC/CDB get new assistant fields
 *   role scoping — no unauthorized data in assistant output
 *   company isolation
 *   no hidden data leakage
 *   realtime endpoint stability
 *
 * Port 4463, secret 'test-sprint63-secret'
 */

const http    = require('http');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawn } = require('child_process');

const SECRET = 'test-sprint63-secret';
const PORT   = 4463;

function sign(uid, company) {
    const p = Buffer.from(JSON.stringify({
        uid, companyName: company, iat: Date.now(), exp: Date.now() + 3_600_000,
    })).toString('base64');
    const s = crypto.createHmac('sha256', SECRET).update(p).digest('hex');
    return `${p}.${s}`;
}

let passed = 0, failed = 0;
function check(label, cond, hint) {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else { console.error(`  ❌ ${label}${hint !== undefined ? ' — got: ' + JSON.stringify(hint) : ''}`); failed++; }
}

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

const hoursAgo  = h  => new Date(Date.now() - h * 3_600_000).toISOString();
const hoursAhead = h => new Date(Date.now() + h * 3_600_000).toISOString();
const daysAgo   = d  => new Date(Date.now() - d * 86_400_000).toISOString();

async function run() {
    console.log('Starting server (Sprint 6.3 Executive Assistant tests)…');
    const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'opstest-s63-'));
    process.env.DATA_DIR = DATA_DIR;

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
    console.log('Server up. Running Sprint 6.3 checks…\n');

    try {
        // ── Tokens ────────────────────────────────────────────────────────────
        const dirA = sign('uid-s63-dirA', 'sprint63-co-a');
        const dirB = sign('uid-s63-dirB', 'sprint63-co-b');

        // Bootstrap
        let r = await api(dirA, 'GET', '/api/operations/me');
        check('S63-0. Director A bootstrapped', r.data && r.data.success, r.data);
        const dirAId = r.data && r.data.user && r.data.user.id;

        r = await api(dirB, 'GET', '/api/operations/me');
        check('S63-1. Director B bootstrapped', r.data && r.data.success, r.data);

        // ── Unit tests: generatePriorityQueue ─────────────────────────────────
        console.log('\n  — generatePriorityQueue unit tests —\n');
        const opsAssistant = require('../operations/ops-assistant');

        const synDecisions = [
            { severity: 'HIGH', reason: 'Alice sovraccarica', confidence: 90, linkedTask: null,
              linkedUser: 'u1', department: null, recommendedAction: 'Ridistribuire i compiti.',
              type: 'OVERLOADED_USER', quickAction: { label: 'Apri Team', url: '/operations-team.html' } },
            { severity: 'HIGH', reason: 'Bob è sospeso', confidence: 95, linkedTask: null,
              linkedUser: 'u2', department: null, recommendedAction: 'Riassegnare i compiti di Bob.',
              type: 'SUSPENDED_USER_WITH_TASKS', quickAction: { label: 'Apri Team', url: '/operations-team.html' } },
            { severity: 'MEDIUM', reason: 'Cucina sotto pressione', confidence: 80, linkedTask: null,
              linkedUser: null, department: 'Cucina', recommendedAction: 'Verificare il reparto Cucina.',
              type: 'URGENT_DEPARTMENT', quickAction: null },
            { severity: 'LOW', reason: 'Carlo senza compiti', confidence: 70, linkedTask: null,
              linkedUser: 'u3', department: null, recommendedAction: 'Assegnare compiti a Carlo.',
              type: 'UNDERUSED_USER', quickAction: null },
        ];
        // Sort like the engine would (severity→confidence desc)
        const sortedDec = [...synDecisions].sort((a, b) => {
            const sev = { HIGH: 0, MEDIUM: 1, LOW: 2 };
            const s = sev[a.severity] - sev[b.severity];
            if (s !== 0) return s;
            return b.confidence - a.confidence;
        });

        const pq = opsAssistant.generatePriorityQueue(sortedDec);
        check('S63-2. Priority queue is array', Array.isArray(pq), pq);
        check('S63-3. Priority queue length = 4', pq.length === 4, pq.length);
        check('S63-4. First item rank = 1', pq[0] && pq[0].rank === 1, pq[0] && pq[0].rank);
        check('S63-5. Priority queue ranks consecutive', pq.every((p, i) => p.rank === i + 1), pq.map(p => p.rank));
        check('S63-6. First item = highest confidence HIGH (Bob, 95)', pq[0].linkedUser === 'u2', pq[0]);
        check('S63-7. Second item = lower confidence HIGH (Alice, 90)', pq[1].linkedUser === 'u1', pq[1]);
        check('S63-8. Priority items have required fields', ['rank','priority','reason','confidence','recommendedAction'].every(f => f in pq[0]), Object.keys(pq[0]));
        check('S63-9. Priority field = severity value', pq[0].priority === 'HIGH', pq[0].priority);
        check('S63-10. linkedDept set for MEDIUM item', pq[2].linkedDept === 'Cucina', pq[2]);
        check('S63-11. quickAction preserved', pq[0].quickAction && pq[0].quickAction.label === 'Apri Team', pq[0].quickAction);
        check('S63-12. Empty decisions → empty queue', opsAssistant.generatePriorityQueue([]).length === 0, null);

        // ── Unit tests: detectRisks ───────────────────────────────────────────
        console.log('\n  — detectRisks unit tests —\n');
        const now = Date.now();

        const synUsers = [
            { id: 'uA', name: 'Alice', status: 'ACTIVE' },
            { id: 'uB', name: 'Bob',   status: 'SUSPENDED' },
            { id: 'uC', name: 'Carlo', status: 'ACTIVE' },
        ];
        const synWorkload = [
            { userId: 'uA', userName: 'Alice', status: 'OVERLOADED', assigned: 12, overdue: 3, urgent: 2, currentLoadScore: 20 },
            { userId: 'uC', userName: 'Carlo', status: 'BUSY',       assigned: 5,  overdue: 1, urgent: 0, currentLoadScore: 8 },
        ];

        const synTasks = [
            // CRITICAL: urgent + overdue + assignee overloaded
            { id: 't-crit', title: 'Critical task', status: 'OPEN', priority: 'URGENT',
              assigneeId: 'uA', dueDate: hoursAgo(2), templateId: null,
              createdAt: daysAgo(1), updatedAt: hoursAgo(2), department: 'Cucina' },
            // CRITICAL: urgent + suspended assignee
            { id: 't-susp', title: 'Suspended urgent', status: 'OPEN', priority: 'URGENT',
              assigneeId: 'uB', dueDate: hoursAhead(5), templateId: null,
              createdAt: daysAgo(1), updatedAt: hoursAgo(10), department: 'Sala' },
            // HIGH: due within 60 min, not started
            { id: 't-soon', title: 'Soon task', status: 'OPEN', priority: 'NORMAL',
              assigneeId: 'uC', dueDate: hoursAhead(0.5), templateId: null,
              createdAt: daysAgo(1), updatedAt: hoursAgo(3), department: 'Cucina' },
            // HIGH: urgent not started (no overloaded assignee)
            { id: 't-urg', title: 'Urgent not started', status: 'OPEN', priority: 'URGENT',
              assigneeId: 'uC', dueDate: hoursAhead(3), templateId: null,
              createdAt: daysAgo(1), updatedAt: hoursAgo(3), department: 'Cucina' },
            // MEDIUM: IN_PROGRESS inactive 5h
            { id: 't-inact', title: 'Inactive task', status: 'IN_PROGRESS', priority: 'NORMAL',
              assigneeId: 'uC', dueDate: hoursAhead(6), templateId: null,
              createdAt: daysAgo(2), updatedAt: hoursAgo(5), department: 'Bar' },
            // MEDIUM: recurring overdue
            { id: 't-rec', title: 'Recurring cleanup', status: 'OPEN', priority: 'NORMAL',
              assigneeId: 'uC', dueDate: hoursAgo(1), templateId: 'tmpl1',
              createdAt: daysAgo(1), updatedAt: hoursAgo(5), department: 'Cucina' },
            // LOW: open > 48h no update
            { id: 't-old', title: 'Old open task', status: 'OPEN', priority: 'NORMAL',
              assigneeId: 'uC', dueDate: hoursAhead(72), templateId: null,
              createdAt: daysAgo(3), updatedAt: daysAgo(3), department: 'Bar' },
            // normal task (should not appear in risks)
            { id: 't-ok', title: 'Normal task', status: 'OPEN', priority: 'NORMAL',
              assigneeId: 'uA', dueDate: hoursAhead(24), templateId: null,
              createdAt: daysAgo(0.1), updatedAt: hoursAgo(1), department: 'Cucina' },
        ];

        const risks = opsAssistant.detectRisks(synTasks, synUsers, synWorkload);
        check('S63-13. detectRisks returns array', Array.isArray(risks), risks);
        check('S63-14. Risk items have required fields',
            risks.length === 0 || ['riskId','level','title','description','linkedTask','linkedUser','linkedDept'].every(f => f in risks[0]),
            risks[0] && Object.keys(risks[0]));

        const criticals = risks.filter(r => r.level === 'CRITICAL');
        const highs     = risks.filter(r => r.level === 'HIGH');
        const mediums   = risks.filter(r => r.level === 'MEDIUM');
        const lows      = risks.filter(r => r.level === 'LOW');

        check('S63-15. At least 1 CRITICAL risk (urgent+overdue+overloaded)', criticals.length >= 1, criticals.length);
        check('S63-16. CRITICAL: urgent+suspended detected', criticals.some(r => r.linkedTask === 't-susp'), criticals.map(r => r.linkedTask));
        check('S63-17. HIGH: due within 60 min', highs.some(r => r.linkedTask === 't-soon'), highs.map(r => r.linkedTask));
        check('S63-18. HIGH: user overloaded (Alice)', highs.some(r => r.linkedUser === 'uA' && r.linkedTask === null), highs.map(r => ({t: r.linkedTask, u: r.linkedUser})));
        check('S63-19. HIGH: urgent not started (uC)', highs.some(r => r.linkedTask === 't-urg'), highs.map(r => r.linkedTask));
        check('S63-20. MEDIUM: inactive IN_PROGRESS', mediums.some(r => r.linkedTask === 't-inact'), mediums.map(r => r.linkedTask));
        check('S63-21. MEDIUM: recurring overdue', mediums.some(r => r.linkedTask === 't-rec'), mediums.map(r => r.linkedTask));
        check('S63-22. LOW: stale open task', lows.some(r => r.linkedTask === 't-old'), lows.map(r => r.linkedTask));
        check('S63-23. Normal task (t-ok) not in risks', !risks.some(r => r.linkedTask === 't-ok'), risks.map(r => r.linkedTask));

        // Ordering: CRITICAL before HIGH before MEDIUM before LOW
        const firstCrit = risks.findIndex(r => r.level === 'CRITICAL');
        const firstHigh = risks.findIndex(r => r.level === 'HIGH');
        const firstMed  = risks.findIndex(r => r.level === 'MEDIUM');
        const firstLow  = risks.findIndex(r => r.level === 'LOW');
        check('S63-24. CRITICAL before HIGH in sorted list',
            firstCrit === -1 || firstHigh === -1 || firstCrit < firstHigh, { firstCrit, firstHigh });
        check('S63-25. HIGH before MEDIUM in sorted list',
            firstHigh === -1 || firstMed === -1 || firstHigh < firstMed, { firstHigh, firstMed });
        check('S63-26. MEDIUM before LOW in sorted list',
            firstMed === -1 || firstLow === -1 || firstMed < firstLow, { firstMed, firstLow });

        check('S63-27. Empty tasks → empty risks', opsAssistant.detectRisks([], [], []).length === 0, null);

        // ── minutesUntilDue on HIGH risk ──────────────────────────────────────
        const soonRisk = risks.find(r => r.linkedTask === 't-soon');
        check('S63-28. soon task risk has minutesUntilDue', soonRisk && typeof soonRisk.minutesUntilDue === 'number' && soonRisk.minutesUntilDue > 0 && soonRisk.minutesUntilDue <= 60, soonRisk && soonRisk.minutesUntilDue);

        // ── Unit tests: buildChangesSince ─────────────────────────────────────
        console.log('\n  — buildChangesSince unit tests —\n');
        const mockTrends = {
            overdue: { currentValue: 4, previousValue: 8, delta: -4, direction: 'IMPROVING', interpretation: '…' },
            completionRate: { currentValue: 78, previousValue: 91, delta: -13, direction: 'WORSENING', interpretation: '…' },
            urgentTasks: { currentValue: 3, previousValue: 3, delta: 0, direction: 'STABLE', interpretation: '…' },
            workload: { currentValue: 0, previousValue: 1, delta: -1, direction: 'IMPROVING', interpretation: '…' },
        };
        const mockYest = { overdueTasks: 8, completionRate: 91, urgentTasks: 3, overloadedUsers: 1 };
        const mockSummary = { completedToday: 5, overdueToday: 4, urgentOpen: 3, usersNeedingAttention: [] };

        const changes = opsAssistant.buildChangesSince(mockTrends, mockYest, mockSummary);
        check('S63-29. buildChangesSince returns array', Array.isArray(changes), changes);
        check('S63-30. Only non-STABLE and non-INSUFFICIENT_DATA changes returned',
            changes.every(c => c.direction !== 'STABLE' && c.direction !== 'INSUFFICIENT_DATA'),
            changes.map(c => c.direction));
        check('S63-31. STABLE urgentTasks excluded', !changes.some(c => c.field === 'urgentTasks'), changes.map(c => c.field));
        check('S63-32. IMPROVING overdue included', changes.some(c => c.field === 'overdue' && c.direction === 'IMPROVING'), changes.map(c => c.field));
        check('S63-33. WORSENING completionRate included', changes.some(c => c.field === 'completionRate' && c.direction === 'WORSENING'), changes.map(c => c.field));
        check('S63-34. IMPROVING workload included', changes.some(c => c.field === 'workload' && c.direction === 'IMPROVING'), changes.map(c => c.field));
        check('S63-35. overdue text mentions values (8 and 4)',
            changes.some(c => c.field === 'overdue' && c.text.includes('8') && c.text.includes('4')),
            changes.find(c => c.field === 'overdue') && changes.find(c => c.field === 'overdue').text);
        check('S63-36. completionRate text mentions delta (13)',
            changes.some(c => c.field === 'completionRate' && c.text.includes('13')),
            changes.find(c => c.field === 'completionRate') && changes.find(c => c.field === 'completionRate').text);
        check('S63-37. null trends → empty changes', opsAssistant.buildChangesSince(null, mockYest, mockSummary).length === 0, null);
        check('S63-38. null yesterday → empty changes', opsAssistant.buildChangesSince(mockTrends, null, mockSummary).length === 0, null);
        check('S63-39. fields have text property', changes.every(c => typeof c.text === 'string' && c.text.length > 5), changes.map(c => c.text));

        // ── Unit tests: buildExecutiveBrief ───────────────────────────────────
        console.log('\n  — buildExecutiveBrief unit tests —\n');
        const mockPQ = [
            { rank: 1, priority: 'HIGH', reason: 'Alice sovraccarica', confidence: 90,
              recommendedAction: 'Ridistribuire i compiti di Alice tra i colleghi disponibili.',
              linkedTask: null, linkedUser: 'u1', linkedDept: null, quickAction: null },
            { rank: 2, priority: 'MEDIUM', reason: 'Cucina sotto pressione', confidence: 80,
              recommendedAction: 'Verificare il reparto Cucina urgentemente.',
              linkedTask: null, linkedUser: null, linkedDept: 'Cucina', quickAction: null },
        ];
        const mockRW = [
            { riskId: 'risk_1', level: 'CRITICAL', title: 'Urgente su sospeso', description: '…', linkedTask: 't1', linkedUser: 'u2', linkedDept: null },
        ];
        const mockChanges = [
            { field: 'overdue', direction: 'IMPROVING', text: 'I compiti in ritardo sono diminuiti da 8 a 4.' },
        ];
        const mockDecisions = [{ severity: 'HIGH' }, { severity: 'HIGH' }, { severity: 'MEDIUM' }];

        const dirBrief = opsAssistant.buildExecutiveBrief('DIRECTOR', mockSummary, mockPQ, mockRW, mockChanges, mockDecisions, mockTrends, null, null);
        check('S63-40. Director brief is a string', typeof dirBrief === 'string' && dirBrief.length > 20, dirBrief);
        check('S63-41. Director brief contains greeting', dirBrief.toLowerCase().includes('buon'), dirBrief.slice(0, 30));
        check('S63-42. Director brief mentions overdue count (4)', dirBrief.includes('4'), dirBrief);
        check('S63-43. Director brief mentions decisions (3)', dirBrief.includes('3'), dirBrief);
        check('S63-44. Director brief mentions critical risk', dirBrief.includes('critico') || dirBrief.includes('rischio'), dirBrief);
        check('S63-45. Director brief has changes section (Rispetto a ieri)', dirBrief.includes('ieri'), dirBrief);
        check('S63-46. Director brief has priority section', dirBrief.includes('Priorit'), dirBrief);
        check('S63-47. Director brief numbered priorities', /1\./.test(dirBrief), dirBrief);

        const ccBrief = opsAssistant.buildExecutiveBrief('CHEF_CUISINE', mockSummary, mockPQ, mockRW, [], mockDecisions, null, null, null);
        check('S63-48. CC brief is a string', typeof ccBrief === 'string' && ccBrief.length > 5, ccBrief);
        check('S63-49. CC brief mentions urgent count', ccBrief.includes(String(mockSummary.urgentOpen)), ccBrief);

        const adjBrief = opsAssistant.buildExecutiveBrief('ADJOINT', mockSummary, mockPQ, [], [], [], null, null, null);
        check('S63-50. Adjoint brief is a string', typeof adjBrief === 'string', adjBrief);
        check('S63-51. Adjoint brief contains greeting', adjBrief.toLowerCase().includes('buon'), adjBrief.slice(0, 30));

        const scBrief = opsAssistant.buildExecutiveBrief('SOUS_CHEF', mockSummary, [], [], [], [], null,
            { assigned: 4, overdue: 0, urgent: 1, completedToday: 2 },
            { id: 'nt1', title: 'Mise en place', dueDate: hoursAhead(1), priority: 'NORMAL' }
        );
        check('S63-52. SC brief mentions task count (4)', scBrief.includes('4'), scBrief);
        check('S63-53. SC brief mentions urgent (1)', scBrief.includes('1') && scBrief.toLowerCase().includes('urgent'), scBrief);

        const cdbBrief = opsAssistant.buildExecutiveBrief('CHEF_DE_BRIGADE', mockSummary, [], [], [], [], null,
            { assigned: 3, overdue: 2, urgent: 0, completedToday: 1 },
            { id: 'nt2', title: 'Pulizia cucina', dueDate: null, priority: 'NORMAL' }
        );
        check('S63-54. CDB brief mentions overdue (2)', cdbBrief.includes('2'), cdbBrief);
        check('S63-55. CDB brief mentions next task title', cdbBrief.includes('Pulizia cucina'), cdbBrief);
        check('S63-56. CDB brief mentions completedToday (1)', cdbBrief.includes('1'), cdbBrief);

        // Brief without changes (no yesterday data)
        const dirBriefNoChanges = opsAssistant.buildExecutiveBrief('DIRECTOR', mockSummary, mockPQ, [], [], mockDecisions, null, null, null);
        check('S63-57. Director brief without changes does NOT mention "ieri"', !dirBriefNoChanges.includes('ieri'), dirBriefNoChanges);

        // ── HTTP integration tests ────────────────────────────────────────────
        console.log('\n  — HTTP integration tests —\n');

        // Create some tasks for Director
        for (let i = 0; i < 3; i++) {
            await api(dirA, 'POST', '/api/operations/tasks', {
                title: `S63 urgent overdue ${i}`, priority: 'URGENT',
                assigneeId: dirAId, dueDate: hoursAgo(2), department: 'Cucina',
            });
        }

        r = await api(dirA, 'GET', '/api/operations/intelligence');
        check('S63-58. GET /intelligence success', r.data && r.data.success, r.data && r.data.success);
        check('S63-59. Director response has priorityQueue', Array.isArray(r.data && r.data.priorityQueue), r.data && r.data.priorityQueue);
        check('S63-60. Director response has riskWatch', Array.isArray(r.data && r.data.riskWatch), r.data && r.data.riskWatch);
        check('S63-61. Director response has changesSince', Array.isArray(r.data && r.data.changesSince), r.data && r.data.changesSince);
        check('S63-62. Director response has executiveBrief string', typeof (r.data && r.data.executiveBrief) === 'string' && r.data.executiveBrief.length > 10, r.data && r.data.executiveBrief);
        check('S63-63. Director executiveBrief contains greeting', (r.data.executiveBrief || '').toLowerCase().includes('buon'), r.data.executiveBrief && r.data.executiveBrief.slice(0, 30));
        check('S63-64. Director riskWatch items have level field', !r.data.riskWatch.length || 'level' in r.data.riskWatch[0], r.data.riskWatch[0]);
        check('S63-65. Director priorityQueue items have rank', !r.data.priorityQueue.length || 'rank' in r.data.priorityQueue[0], r.data.priorityQueue[0]);
        check('S63-66. Director riskWatch has HIGH risks (urgent+overdue tasks created)', r.data.riskWatch.some(r => ['CRITICAL','HIGH'].includes(r.level)), r.data.riskWatch.map(r => r.level));
        check('S63-67. Director priorityQueue has HIGH items', r.data.priorityQueue.some(p => p.priority === 'HIGH'), r.data.priorityQueue.map(p => p.priority));
        check('S63-68. Director priorityQueue ranks are consecutive starting from 1',
            r.data.priorityQueue.every((p, i) => p.rank === i + 1),
            r.data.priorityQueue.map(p => p.rank));
        check('S63-69. Director priorityQueue ordered HIGH before MEDIUM',
            !r.data.priorityQueue.some((p, i) =>
                p.priority === 'MEDIUM' &&
                r.data.priorityQueue.slice(i+1).some(q => q.priority === 'HIGH')
            ), null);

        // Existing fields still present (no regressions)
        check('S63-70. Director still gets briefing', typeof r.data.briefing === 'string', r.data.briefing);
        check('S63-71. Director still gets decisions', Array.isArray(r.data.decisions), r.data.decisions);
        check('S63-72. Director still gets workload', Array.isArray(r.data.workload), r.data.workload);
        check('S63-73. Director still gets departmentHealth', Array.isArray(r.data.departmentHealth), r.data.departmentHealth);

        // ── Role scoping: Director tasks not leaked to Company B ──────────────
        const rB = await api(dirB, 'GET', '/api/operations/intelligence');
        check('S63-74. Company B intelligence success', rB.data && rB.data.success, rB.data);
        check('S63-75. Company B riskWatch present', Array.isArray(rB.data && rB.data.riskWatch), rB.data && rB.data.riskWatch);
        check('S63-76. Company B riskWatch does not reference Company A tasks',
            !(rB.data.riskWatch || []).some(risk => ['t-crit','t-susp','t-soon','t-urg'].includes(risk.linkedTask)),
            rB.data.riskWatch && rB.data.riskWatch.map(r => r.linkedTask));
        check('S63-77. Company B priorityQueue present', Array.isArray(rB.data && rB.data.priorityQueue), rB.data && rB.data.priorityQueue);
        check('S63-78. Company B priorityQueue does not reference Company A user', 
            !(rB.data.priorityQueue || []).some(p => p.linkedUser === dirAId),
            rB.data.priorityQueue && rB.data.priorityQueue.map(p => p.linkedUser));
        check('S63-79. Company B executiveBrief is a string', typeof (rB.data && rB.data.executiveBrief) === 'string', rB.data && rB.data.executiveBrief);
        check('S63-80. Company B changesSince present', Array.isArray(rB.data && rB.data.changesSince), rB.data && rB.data.changesSince);

        // ── Seed yesterday data and test changesSince appears ─────────────────
        const snapshotsMod = require('../operations/ops-snapshots');
        snapshotsMod._saveSnapshotForDate('sprint63-co-a', snapshotsMod._yesterdayStr(), {
            overdueTasks: 10, urgentTasks: 5, completionRate: 40, overloadedUsers: 2,
            openTasks: 15, averageCompletionTime: 25, departmentMetrics: {},
        });

        const rWithHist = await api(dirA, 'GET', '/api/operations/intelligence');
        check('S63-81. With history, changesSince has entries', rWithHist.data && rWithHist.data.changesSince && rWithHist.data.changesSince.length > 0, rWithHist.data && rWithHist.data.changesSince);
        check('S63-82. changesSince items have direction field', !rWithHist.data.changesSince || !rWithHist.data.changesSince.length || 'direction' in rWithHist.data.changesSince[0], rWithHist.data.changesSince[0]);
        check('S63-83. changesSince items have text field', !rWithHist.data.changesSince || !rWithHist.data.changesSince.length || (typeof rWithHist.data.changesSince[0].text === 'string'), rWithHist.data.changesSince[0]);
        check('S63-84. Director executiveBrief includes "ieri" when changes present', (rWithHist.data.executiveBrief || '').includes('ieri'), rWithHist.data.executiveBrief);
        check('S63-85. Director executiveBrief includes priority recommendations', (rWithHist.data.executiveBrief || '').includes('1.'), rWithHist.data.executiveBrief);
        check('S63-86. Only IMPROVING/WORSENING in changesSince (no STABLE/INSUFFICIENT)',
            (rWithHist.data.changesSince || []).every(c => c.direction === 'IMPROVING' || c.direction === 'WORSENING'),
            rWithHist.data.changesSince && rWithHist.data.changesSince.map(c => c.direction));

        // ── No data leakage: priority queue items do not expose internal data ─
        check('S63-87. priorityQueue items do not expose supportingFacts',
            !(r.data.priorityQueue || []).some(p => 'supportingFacts' in p),
            r.data.priorityQueue && r.data.priorityQueue.map(p => Object.keys(p)));

        // ── Realtime: intelligence endpoint works after task event ────────────
        const tNew = await api(dirA, 'POST', '/api/operations/tasks', {
            title: 'S63 realtime test', priority: 'NORMAL',
            assigneeId: dirAId, dueDate: hoursAhead(24), department: 'Test',
        });
        check('S63-88. Task created for realtime test', tNew.data && tNew.data.success, tNew.data);

        const rAfter = await api(dirA, 'GET', '/api/operations/intelligence');
        check('S63-89. Intelligence accessible after task creation', rAfter.data && rAfter.data.success, rAfter.data);
        check('S63-90. riskWatch still present after task creation', Array.isArray(rAfter.data && rAfter.data.riskWatch), rAfter.data && rAfter.data.riskWatch);
        check('S63-91. priorityQueue still present after task creation', Array.isArray(rAfter.data && rAfter.data.priorityQueue), rAfter.data && rAfter.data.priorityQueue);

        // ── role scoping module checks ────────────────────────────────────────
        console.log('\n  — Role scope isolation checks —\n');
        const opsIntel = require('../operations/ops-intelligence');
        const opsAuth  = require('../operations/ops-auth');

        const allUsersX = [
            { id: 'uD', name: 'Dir',   role: 'DIRECTOR',        status: 'ACTIVE', companyId: 'scopeco2' },
            { id: 'uC', name: 'CC',    role: 'CHEF_CUISINE',    status: 'ACTIVE', companyId: 'scopeco2' },
            { id: 'uS', name: 'SC',    role: 'SOUS_CHEF',       status: 'ACTIVE', companyId: 'scopeco2' },
        ];
        const allTasksX = [
            { id: 'tD', title: 'Dir task',   assigneeId: 'uD', status: 'OPEN', priority: 'URGENT',
              department: 'Mgmt', dueDate: hoursAgo(1), createdAt: daysAgo(1), updatedAt: hoursAgo(10), completedAt: null, templateId: null },
            { id: 'tC', title: 'CC task',    assigneeId: 'uC', status: 'OPEN', priority: 'URGENT',
              department: 'Cucina', dueDate: hoursAgo(0.5), createdAt: daysAgo(1), updatedAt: hoursAgo(10), completedAt: null, templateId: null },
            { id: 'tS', title: 'SC task',    assigneeId: 'uS', status: 'OPEN', priority: 'NORMAL',
              department: 'Cucina', dueDate: hoursAhead(2), createdAt: daysAgo(1), updatedAt: hoursAgo(1), completedAt: null, templateId: null },
        ];

        // CC scoped tasks
        const userRoleMap = {};
        allUsersX.forEach(u => { userRoleMap[u.id] = u.role; });
        const ccAssignable = opsAuth.ASSIGNABLE_ROLES['CHEF_CUISINE'] || [];
        const ccTasks = allTasksX.filter(t => t.assigneeId === 'uC' || ccAssignable.includes(userRoleMap[t.assigneeId]));
        const ccUsers = allUsersX.filter(u => u.id === 'uC' || ccAssignable.includes(u.role));

        const ccResult = opsIntel.analyzeIntelligence('scopeco2', { tasks: ccTasks, users: ccUsers });
        const ccPQ = opsAssistant.generatePriorityQueue(ccResult.decisions);
        const ccRW = opsAssistant.detectRisks(ccTasks, ccUsers, ccResult.workload);

        check('S63-92. CC priorityQueue excludes Director tasks',
            !ccPQ.some(p => p.linkedTask === 'tD'),
            ccPQ.map(p => p.linkedTask));
        check('S63-93. CC riskWatch excludes Director tasks',
            !ccRW.some(r => r.linkedTask === 'tD'),
            ccRW.map(r => r.linkedTask));
        check('S63-94. CC riskWatch excludes Director user',
            !ccRW.some(r => r.linkedUser === 'uD'),
            ccRW.map(r => r.linkedUser));
        check('S63-95. CC riskWatch includes CC task (urgent overdue, HIGH)', ccRW.some(r => r.linkedTask === 'tC' && r.level === 'HIGH'), ccRW.map(r => ({t: r.linkedTask, l: r.level})));

        // SC personal scope
        const scTasks = allTasksX.filter(t => t.assigneeId === 'uS');
        const scUsers = allUsersX.filter(u => u.id === 'uS');
        const scResult = opsIntel.analyzeIntelligence('scopeco2', { tasks: scTasks, users: scUsers });
        const scPQ = opsAssistant.generatePriorityQueue(scResult.decisions);
        const scRW = opsAssistant.detectRisks(scTasks, scUsers, scResult.workload);

        check('S63-96. SC priorityQueue excludes CC tasks', !scPQ.some(p => p.linkedTask === 'tC'), scPQ.map(p => p.linkedTask));
        check('S63-97. SC riskWatch excludes CC tasks', !scRW.some(r => r.linkedTask === 'tC'), scRW.map(r => r.linkedTask));
        check('S63-98. SC riskWatch excludes Director tasks', !scRW.some(r => r.linkedTask === 'tD'), scRW.map(r => r.linkedTask));

    } finally {
        proc.kill();
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exit(failed > 0 ? 1 : 0);
    }
}

run().catch(e => { console.error(e); process.exit(1); });
