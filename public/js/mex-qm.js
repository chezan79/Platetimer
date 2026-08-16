/**
 * PlateTimer Mex — Quick Message (QM) shared module.
 *
 * Stable template keys are the canonical identifiers.  Display strings are
 * always resolved through the i18n system (`t_fn`).  No Italian/French/English
 * strings are hard-coded here.
 *
 * Consumed by department.html and sala.html (loaded as a plain <script> tag
 * before those pages' own inline scripts).
 */
(function (global) {
    'use strict';

    /** Ordered list of all Quick Message types. */
    const TYPES = [
        { key: 'TABLE_DELAY',  icon: '⏱' },
        { key: 'TABLE_STATUS', icon: '❓' },
        { key: 'TABLE_URGENT', icon: '🚨' },
        { key: 'TABLE_HOLD',   icon: '⏸' },
        { key: 'TABLE_SEND',   icon: '▶️' },
        { key: 'CUSTOM',       icon: '✍️' }
    ];

    /** Set of types that require a table number before sending. */
    const TABLE_TYPES = new Set(['TABLE_DELAY', 'TABLE_STATUS', 'TABLE_URGENT', 'TABLE_HOLD', 'TABLE_SEND']);

    /**
     * Returns true when templateType requires a table number.
     * @param {string} key
     */
    function isTableType(key) {
        return TABLE_TYPES.has(key);
    }

    /**
     * Validate a table number (client-side; server repeats this).
     *
     * Rules (mirrors PlateTimer's existing countdown conventions):
     *  - Required (non-empty after trim)
     *  - 1–8 characters
     *  - Only alphanumeric characters (A-Z, a-z, 0-9)
     *  - Reasonable range for integers: 1–999 (if purely numeric)
     *
     * @param {string|number} n
     * @param {function} t_fn  — i18n resolver, called with 'mex.qm.tableError' on failure
     * @returns {{ ok: boolean, error?: string, normalized?: string }}
     */
    function validateTableNum(n, t_fn) {
        const s = String(n == null ? '' : n).trim();
        if (!s) {
            return { ok: false, error: t_fn ? t_fn('mex.qm.tableError') : 'Enter a valid table number.' };
        }
        if (s.length > 8) {
            return { ok: false, error: t_fn ? t_fn('mex.qm.tableError') : 'Enter a valid table number.' };
        }
        // Only alphanumeric
        if (!/^[A-Za-z0-9]+$/.test(s)) {
            return { ok: false, error: t_fn ? t_fn('mex.qm.tableError') : 'Enter a valid table number.' };
        }
        // If all digits: must be in 1–999
        if (/^\d+$/.test(s)) {
            const n2 = parseInt(s, 10);
            if (n2 < 1 || n2 > 999) {
                return { ok: false, error: t_fn ? t_fn('mex.qm.tableError') : 'Enter a valid table number.' };
            }
        }
        return { ok: true, normalized: s };
    }

    /**
     * Render the human-readable body text for a Quick Message.
     *
     * The body template is resolved via `t_fn('mex.qm.{KEY}_body')` which
     * contains a `{n}` placeholder for the table number.
     *
     * Returns the rendered string, or null if the key is unknown or CUSTOM.
     *
     * @param {string}   templateType  — one of the stable keys
     * @param {string}   tableNumber   — required for TABLE_* types
     * @param {function} t_fn          — i18n resolver (key → string)
     * @returns {string|null}
     */
    function renderBody(templateType, tableNumber, t_fn) {
        if (templateType === 'CUSTOM') return null;
        const tmpl = t_fn ? t_fn('mex.qm.' + templateType + '_body') : null;
        if (!tmpl || tmpl === 'mex.qm.' + templateType + '_body') return null;
        if (isTableType(templateType)) {
            return tmpl.replace('{n}', String(tableNumber || '?'));
        }
        return tmpl;
    }

    /**
     * Build the button label for the QM picker (the short version, with trailing …
     * for table types to indicate the operator still needs to enter a number).
     *
     * @param {string}   key
     * @param {function} t_fn
     * @returns {string}
     */
    function buttonLabel(key, t_fn) {
        const raw = t_fn ? t_fn('mex.qm.' + key) : key;
        return (raw && raw !== 'mex.qm.' + key) ? raw : key;
    }

    global.MexQM = { TYPES, TABLE_TYPES, isTableType, validateTableNum, renderBody, buttonLabel };
})(window);
