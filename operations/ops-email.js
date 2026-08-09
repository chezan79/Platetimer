// operations/ops-email.js — Email/notification abstraction for PlateTimer Operations.
//
// NO EMAIL PROVIDER IS CONFIGURED in this environment. To enable real delivery,
// set one of the following and implement the matching transport below:
//   • SMTP:        SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   • or SendGrid: SENDGRID_API_KEY + FROM address
// Until then, the logging transport records the full message so the flow can be
// verified end-to-end. Failures here are logged and NEVER affect task persistence.

function detectTransport() {
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp-unimplemented';
    if (process.env.SENDGRID_API_KEY) return 'sendgrid-unimplemented';
    return 'logging';
}

const TRANSPORT = detectTransport();

// Send a task-assignment notification. Fire-and-forget: caller must NOT await
// persistence decisions on this. Returns a promise resolving to { sent, transport }.
async function sendTaskAssignmentEmail({ to, toName, task, assignedByName, appUrl }) {
    const subject = `[PlateTimer Operations] Nuovo compito: ${task.title}`;
    const body = [
        `Ciao ${toName || ''},`,
        ``,
        `${assignedByName} ti ha assegnato un compito su PlateTimer Operations:`,
        ``,
        `  Titolo:      ${task.title}`,
        `  Descrizione: ${task.description || '—'}`,
        `  Priorità:    ${task.priority}`,
        `  Scadenza:    ${task.dueDate || '—'}`,
        ``,
        `Apri PlateTimer Operations: ${appUrl || '/operations.html'}`
    ].join('\n');

    if (TRANSPORT === 'logging') {
        console.log(`📧 [OPS-EMAIL] (logging transport — no provider configured) To: ${to || '(no email on record)'}\nSubject: ${subject}\n${body}`);
        return { sent: false, transport: 'logging' };
    }
    // Provider env vars detected but transport intentionally not implemented in
    // Sprint 1 — do not invent credentials/providers. Log loudly instead.
    console.warn(`📧 [OPS-EMAIL] Provider env vars detected (${TRANSPORT}) but no transport implemented in Sprint 1. Message logged only.`);
    console.log(`📧 [OPS-EMAIL] To: ${to}\nSubject: ${subject}\n${body}`);
    return { sent: false, transport: TRANSPORT };
}

module.exports = { sendTaskAssignmentEmail, TRANSPORT };
