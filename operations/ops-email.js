// operations/ops-email.js — Email/notification abstraction for PlateTimer Operations.
//
// Transport selection (checked at startup):
//   SMTP:  SMTP_HOST + SMTP_USER + SMTP_PASS  (all three required)
//   SMTP port:   SMTP_PORT  (default 587)
//   SMTP secure: SMTP_SECURE='true' for port 465 TLS
//   From address: EMAIL_FROM or SMTP_FROM or SMTP_USER
//   Base URL for links: APP_BASE_URL  (e.g. https://yourapp.up.railway.app)
//
// If SMTP env vars are absent, a logging-only transport is used (development).
// Email failure is NEVER fatal — task/invitation persistence is always the source of truth.

const nodemailer = require('nodemailer');

// ── Result enum ────────────────────────────────────────────────────────────────
const RESULT = Object.freeze({ SENT: 'SENT', FAILED: 'FAILED', SKIPPED: 'SKIPPED' });

// ── Transport detection ────────────────────────────────────────────────────────
function detectTransport() {
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
    return 'logging';
}

const TRANSPORT = detectTransport();

// Lazy singleton — created once when first needed, not at require() time so tests
// can inject env vars before import resolution.
let _transporter = null;
function getTransporter() {
    if (_transporter) return _transporter;
    if (TRANSPORT !== 'smtp') return null;
    _transporter = nodemailer.createTransport({
        host:   process.env.SMTP_HOST,
        port:   parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS   // read from env, never logged
        }
    });
    return _transporter;
}

const FROM = () =>
    process.env.EMAIL_FROM ||
    process.env.SMTP_FROM  ||
    process.env.SMTP_USER  ||
    'PlateTimer Operations <noreply@platetimer.app>';

// ── Safe helpers ───────────────────────────────────────────────────────────────

// Mask email for logs: user@domain → u***@domain
function maskEmail(email) {
    if (!email || !email.includes('@')) return '(none)';
    const [local, domain] = email.split('@');
    return `${(local[0] || '?')}***@${domain}`;
}

// Sanitize error messages — strip any credential-looking fragments before logging.
function sanitizeError(msg) {
    return (msg || 'unknown error')
        .replace(/pass(?:word)?[^,;)"\s]*/gi, '[REDACTED]')
        .replace(/auth[^,;)"\s]*/gi, '[REDACTED]')
        .slice(0, 300);
}

// ── Core send ──────────────────────────────────────────────────────────────────
async function _send({ to, subject, text, html }) {
    if (TRANSPORT === 'logging') {
        // Development fallback — log intent but never expose secrets.
        // In production this branch must never silently claim SENT.
        console.log(`📧 [OPS-EMAIL] SKIPPED (logging transport — SMTP not configured) | To: ${maskEmail(to)} | Subject: ${subject}`);
        return { result: RESULT.FAILED, transport: 'logging', reason: 'No SMTP configured' };
    }

    const transporter = getTransporter();
    if (!transporter) {
        console.warn(`📧 [OPS-EMAIL] FAILED — transporter unavailable | To: ${maskEmail(to)}`);
        return { result: RESULT.FAILED, transport: TRANSPORT, reason: 'Transporter unavailable' };
    }

    try {
        await transporter.sendMail({ from: FROM(), to, subject, text, html });
        console.log(`📧 [OPS-EMAIL] SENT | To: ${maskEmail(to)} | Subject: ${subject} | ts: ${new Date().toISOString()}`);
        return { result: RESULT.SENT, transport: TRANSPORT };
    } catch (err) {
        const safe = sanitizeError(err.message);
        console.error(`📧 [OPS-EMAIL] FAILED | To: ${maskEmail(to)} | ${safe}`);
        return { result: RESULT.FAILED, transport: TRANSPORT, reason: safe };
    }
}

// ── Shared HTML wrapper ────────────────────────────────────────────────────────
function htmlWrapper(bodyContent) {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PlateTimer Operations</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:system-ui,-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td align="center">
<table width="100%" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;">
<tr><td style="background:#4f46e5;padding:20px 28px;">
  <h2 style="margin:0;color:#fff;font-size:18px;font-weight:700;">PlateTimer Operations</h2>
</td></tr>
<tr><td style="padding:28px;">
${bodyContent}
<p style="margin:28px 0 0;font-size:11px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
  PlateTimer Operations — messaggio automatico. Non rispondere a questa email.
</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function btn(href, label) {
    return `<p style="text-align:center;margin:24px 0;">
  <a href="${href}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 28px;border-radius:7px;font-weight:700;font-size:15px;display:inline-block;">${label}</a>
</p>`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Send a task-assignment notification email.
 * Fire-and-forget safe: never throws; always returns { result, transport }.
 * Returns SKIPPED if assignee === actor (self-assigned).
 */
async function sendTaskAssignmentEmail({ to, toName, task, assignedByName, appUrl }) {
    const taskUrl = (process.env.APP_BASE_URL || '') + (appUrl || '/operations-tasks.html');
    const subject = `[PlateTimer Operations] Nuovo compito: ${task.title}`;

    const text = [
        `Ciao ${toName || ''},`,
        ``,
        `${assignedByName} ti ha assegnato un compito su PlateTimer Operations:`,
        ``,
        `  Titolo:      ${task.title}`,
        `  Descrizione: ${task.description || '—'}`,
        `  Priorità:    ${task.priority || '—'}`,
        `  Scadenza:    ${task.dueDate || '—'}`,
        ``,
        `Apri i miei compiti: ${taskUrl}`,
        ``,
        `PlateTimer Operations`
    ].join('\n');

    const html = htmlWrapper(`
<p style="margin:0 0 16px;">Ciao <strong>${toName || ''}</strong>,</p>
<p style="margin:0 0 16px;"><strong>${assignedByName}</strong> ti ha assegnato un nuovo compito:</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px;">
  <tr><td style="padding:9px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;width:110px;font-size:13px;">Titolo</td>
      <td style="padding:9px 12px;border:1px solid #e2e8f0;font-size:14px;">${task.title}</td></tr>
  ${task.description ? `<tr><td style="padding:9px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;font-size:13px;">Descrizione</td>
      <td style="padding:9px 12px;border:1px solid #e2e8f0;font-size:14px;">${task.description}</td></tr>` : ''}
  <tr><td style="padding:9px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;font-size:13px;">Priorità</td>
      <td style="padding:9px 12px;border:1px solid #e2e8f0;font-size:14px;">${task.priority || '—'}</td></tr>
  <tr><td style="padding:9px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;font-size:13px;">Scadenza</td>
      <td style="padding:9px 12px;border:1px solid #e2e8f0;font-size:14px;">${task.dueDate || '—'}</td></tr>
</table>
${btn(taskUrl, 'Apri i miei compiti')}`);

    try {
        return await _send({ to, subject, text, html });
    } catch (e) {
        console.error('📧 [OPS-EMAIL] sendTaskAssignmentEmail unexpected error (non-fatal):', sanitizeError(e.message));
        return { result: RESULT.FAILED, transport: TRANSPORT, reason: sanitizeError(e.message) };
    }
}

/**
 * Send an invitation email to a newly-created Operations user.
 * activationUrl must be an absolute URL built server-side from APP_BASE_URL.
 * Never throws; always returns { result, transport }.
 */
async function sendInvitationEmail({ to, toName, role, invitedByName, activationUrl }) {
    const subject = `[PlateTimer Operations] Sei stato invitato`;

    const text = [
        `Ciao ${toName || ''},`,
        ``,
        `${invitedByName} ti ha invitato a PlateTimer Operations nel ruolo di ${role}.`,
        ``,
        `Clicca il link per attivare il tuo account:`,
        activationUrl,
        ``,
        `Usa l'indirizzo email ${to} per accedere.`,
        ``,
        `PlateTimer Operations`
    ].join('\n');

    const html = htmlWrapper(`
<p style="margin:0 0 16px;">Ciao <strong>${toName || ''}</strong>,</p>
<p style="margin:0 0 8px;"><strong>${invitedByName}</strong> ti ha invitato a PlateTimer Operations nel ruolo di <strong>${role}</strong>.</p>
<p style="margin:0 0 20px;color:#475569;font-size:14px;">Clicca il pulsante per creare o collegare il tuo account e iniziare.</p>
${btn(activationUrl, 'Attiva il mio account')}
<p style="font-size:13px;color:#64748b;text-align:center;">Accedi con l'indirizzo <strong>${to}</strong> per completare l'attivazione.</p>`);

    try {
        return await _send({ to, subject, text, html });
    } catch (e) {
        console.error('📧 [OPS-EMAIL] sendInvitationEmail unexpected error (non-fatal):', sanitizeError(e.message));
        return { result: RESULT.FAILED, transport: TRANSPORT, reason: sanitizeError(e.message) };
    }
}

module.exports = { sendTaskAssignmentEmail, sendInvitationEmail, RESULT, TRANSPORT };
