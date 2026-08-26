// tests/operations-quick-notes.test.js — personal Operations Quick Notes.
//
// Covers creator/company isolation, server-owned note fields, text and voice
// capture, dismissal, and conversion only after a normal task succeeds.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRET = 'test-secret-quick-notes';
const PORT = 5087;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-notes-'));

function sign(uid, companyName) {
    const payload = Buffer.from(JSON.stringify({
        uid, companyName, iat: Date.now(), exp: Date.now() + 3600000
    })).toString('base64');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

async function api(token, method, endpoint, body) {
    const response = await fetch(BASE + endpoint, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
}

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${label}`);
    } else {
        failed++;
        console.error(`  ❌ ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
    }
}

function activeUser(id, uid, name, companyId) {
    return { id, uid, name, companyId, role: 'DIRECTOR', active: true, status: 'ACTIVE', createdAt: Date.now() };
}

async function main() {
    const company = 'quick-notes-company';
    const otherCompany = 'quick-notes-other';
    fs.writeFileSync(path.join(DATA_DIR, 'ops-users.json'), JSON.stringify({
        [company]: [
            activeUser('opsu-notes-a', 'uid-notes-a', 'Anna', company),
            activeUser('opsu-notes-a2', 'uid-notes-a2', 'Ari', company),
            activeUser('opsu-notes-recovered', 'uid-notes-recovered', 'Rita', company)
        ],
        [otherCompany]: [activeUser('opsu-notes-b', 'uid-notes-b', 'Bruno', otherCompany)]
    }));
    // Simulate an abrupt stop after the local conversion journal was written.
    // Startup must complete its target state before serving any requests.
    fs.writeFileSync(path.join(DATA_DIR, 'ops-note-conversion-journal.json'), JSON.stringify({
        tasks: {},
        notes: {
            [company]: [{
                id: 'opsn-recovered', companyId: company, creatorUid: 'uid-notes-recovered',
                creatorOpsUserId: 'opsu-notes-recovered', creatorName: 'Rita',
                text: 'Recovered conversion state', createdAt: 1, updatedAt: 1, status: 'INBOX', source: 'TEXT'
            }]
        }
    }));

    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(PORT),
            WS_SESSION_SECRET: SECRET,
            DATA_DIR,
            FIREBASE_ADMIN_SERVICE_ACCOUNT: '',
            SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', RESEND_API_KEY: '', RESEND_API_BASE: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('server start timeout')), 15000);
        server.stdout.on('data', data => {
            if (data.toString().includes('Server avviato')) {
                clearTimeout(timeout);
                resolve();
            }
        });
    });

    try {
        const a = sign('uid-notes-a', company);
        const a2 = sign('uid-notes-a2', company);
        const b = sign('uid-notes-b', otherCompany);
        const recovered = sign('uid-notes-recovered', company);

        let r = await api(recovered, 'GET', '/api/operations/notes');
        check('Startup recovers an interrupted local conversion journal',
            r.status === 200 && r.data.count === 1 && r.data.notes[0].id === 'opsn-recovered' &&
            !fs.existsSync(path.join(DATA_DIR, 'ops-note-conversion-journal.json')), r.data);

        r = await api(null, 'POST', '/api/operations/notes', { text: 'Unauthenticated' });
        check('Unauthenticated note creation is rejected', r.status === 401);

        r = await api(a, 'POST', '/api/operations/notes', {
            text: 'Check the oven temperature',
            companyId: otherCompany,
            creatorUid: 'forged',
            status: 'CONVERTED',
            source: 'VOICE',
            convertedTaskId: 'forged-task'
        });
        const textNote = r.data.note;
        check('Text note is created', r.status === 201 && textNote && textNote.text === 'Check the oven temperature', r.data);
        check('Create ignores client-owned source and status fields', textNote && textNote.source === 'TEXT' && textNote.status === 'INBOX', textNote);
        check('Public note does not expose creator UID or company ID', textNote && !('creatorUid' in textNote) && !('companyId' in textNote), textNote);

        r = await api(a, 'POST', '/api/operations/notes', { text: '   ' });
        check('Blank note is rejected', r.status === 400);

        await new Promise(resolve => setTimeout(resolve, 3));
        r = await api(a, 'POST', '/api/operations/notes/voice', { text: 'Voice transcript only' });
        const voiceNote = r.data.note;
        check('Voice transcript creates a voice-sourced text-only note', r.status === 201 && voiceNote && voiceNote.source === 'VOICE' && !('audio' in voiceNote), voiceNote);

        r = await api(a, 'GET', '/api/operations/notes');
        check('Inbox count and newest-first ordering are returned', r.status === 200 && r.data.count === 2 && r.data.notes[0].id === voiceNote.id, r.data);

        r = await api(a2, 'GET', `/api/operations/notes/${textNote.id}`);
        check('A different user in the same company cannot read a note', r.status === 404);
        r = await api(a2, 'PATCH', `/api/operations/notes/${textNote.id}`, { text: 'forged edit' });
        check('A different user in the same company cannot update a note', r.status === 404);
        r = await api(b, 'POST', `/api/operations/notes/${textNote.id}/dismiss`);
        check('A user in another company cannot dismiss a note', r.status === 404);
        r = await api(a2, 'POST', `/api/operations/notes/${textNote.id}/convert`, { taskId: 'forged' });
        check('A different user cannot convert a note', r.status === 404);

        r = await api(a, 'PATCH', `/api/operations/notes/${textNote.id}`, {
            text: 'Check oven before service', source: 'VOICE', status: 'DISMISSED'
        });
        check('Owner can edit only the text while source/status remain server-owned',
            r.status === 200 && r.data.note.text === 'Check oven before service' &&
            r.data.note.source === 'TEXT' && r.data.note.status === 'INBOX', r.data);

        r = await api(a, 'POST', '/api/operations/tasks', {
            title: '', sourceNoteId: textNote.id
        });
        check('Failed task creation leaves source note unresolved', r.status === 400);
        r = await api(a, 'GET', `/api/operations/notes/${textNote.id}`);
        check('Source note remains inbox after failed task validation', r.data.note && r.data.note.status === 'INBOX', r.data);

        r = await api(a, 'POST', '/api/operations/tasks', {
            title: 'Check oven before service',
            description: 'Edited independently from the note',
            sourceNoteId: textNote.id
        });
        const task = r.data.task;
        check('Normal task creation succeeds with an owned source note', r.status === 201 && task && task.sourceNoteId === textNote.id, r.data);
        check('Task history records note conversion provenance',
            task && task.history.some(event => event.type === 'NOTE_CONVERTED' && event.sourceNoteId === textNote.id), task && task.history);

        r = await api(a, 'GET', `/api/operations/notes/${textNote.id}`);
        check('Source note converts only after the task succeeds',
            r.status === 200 && r.data.note.status === 'CONVERTED' && r.data.note.convertedTaskId === task.id && r.data.note.convertedAt, r.data);

        r = await api(a, 'POST', `/api/operations/notes/${voiceNote.id}/dismiss`);
        check('Owner can dismiss an unresolved note', r.status === 200 && r.data.note.status === 'DISMISSED', r.data);
        r = await api(a, 'GET', '/api/operations/notes/count');
        check('Count excludes converted and dismissed notes', r.status === 200 && r.data.count === 0, r.data);
    } finally {
        server.kill('SIGTERM');
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\nOperations Quick Notes: ${passed} passed, ${failed} failed.`);
    process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});