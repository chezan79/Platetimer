/**
 * PlateTimer Mex — Quick Reply (QR) shared module.
 *
 * Stable internal keys are the canonical identifiers.
 * Display strings are always resolved through the i18n system (`t_fn`).
 * No Italian/French/English strings are hard-coded here.
 *
 * Consumed by department.html and sala.html (loaded as a plain <script> tag
 * before those pages' own inline scripts).
 */
(function (global) {
    'use strict';

    /** Ordered list of all Quick Reply types. */
    const TYPES = [
        { key: 'ACK',     icon: '👍' },
        { key: 'MIN_2',   icon: '⏱' },
        { key: 'MIN_5',   icon: '⏱' },
        { key: 'READY',   icon: '✅' },
        { key: 'PROBLEM', icon: '⚠️' },
        { key: 'CUSTOM',  icon: '✍️' }
    ];

    /** Reply types that have a pre-rendered body (all except CUSTOM). */
    const BODY_TYPES = new Set(['ACK', 'MIN_2', 'MIN_5', 'READY', 'PROBLEM']);

    /**
     * Returns true when the reply type is CUSTOM (requires free-text input).
     * @param {string} key
     */
    function isCustom(key) {
        return key === 'CUSTOM';
    }

    /**
     * Render the human-readable body for a Quick Reply.
     * Resolves `mex.qr.{KEY}_body` via t_fn.
     * Returns the body string, or null for CUSTOM or unknown keys.
     *
     * @param {string}   replyType — one of the stable keys
     * @param {function} t_fn      — i18n resolver (key → string)
     * @returns {string|null}
     */
    function renderBody(replyType, t_fn) {
        if (!BODY_TYPES.has(replyType)) return null;
        const raw = t_fn ? t_fn('mex.qr.' + replyType + '_body') : null;
        if (!raw || raw === 'mex.qr.' + replyType + '_body') return null;
        return raw;
    }

    /**
     * Build the button label shown in the QR grid.
     * Resolves `mex.qr.{KEY}` via t_fn, falling back to the key itself.
     *
     * @param {string}   key
     * @param {function} t_fn
     * @returns {string}
     */
    function buttonLabel(key, t_fn) {
        const raw = t_fn ? t_fn('mex.qr.' + key) : key;
        return (raw && raw !== 'mex.qr.' + key) ? raw : key;
    }

    global.MexQR = { TYPES, BODY_TYPES, isCustom, renderBody, buttonLabel };
})(window);
