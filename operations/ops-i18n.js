'use strict';
/**
 * Server-side i18n helper for Operations generated texts.
 * Loads the same JSON dictionaries used by the browser (public/i18n/*.json).
 * Falls back to Italian for any missing key.
 *
 *   t(lang, key, vars?)   → translated string with {placeholder} substitution
 */

const fs   = require('fs');
const path = require('path');

const SUPPORTED   = ['it', 'fr', 'en'];
const DEFAULT_LANG = 'it';
let _dicts = null;          // lazy-loaded once

function _load() {
    if (_dicts) return;
    _dicts = {};
    const base = path.join(__dirname, '..', 'public', 'i18n');
    for (const lang of SUPPORTED) {
        try {
            _dicts[lang] = JSON.parse(fs.readFileSync(path.join(base, `${lang}.json`), 'utf8'));
        } catch {
            _dicts[lang] = {};
        }
    }
}

/**
 * Translate a key for the given language, substituting {var} placeholders.
 * @param {string} lang  - 'it' | 'fr' | 'en' (default 'it')
 * @param {string} key   - dot-separated key from the i18n JSON
 * @param {object} [vars] - optional substitution map  { varName: value }
 * @returns {string}
 */
function t(lang, key, vars) {
    _load();
    if (!SUPPORTED.includes(lang)) lang = DEFAULT_LANG;
    const dict = _dicts[lang] || {};
    const itDict = _dicts[DEFAULT_LANG] || {};
    let str = Object.prototype.hasOwnProperty.call(dict, key)   ? dict[key]
            : Object.prototype.hasOwnProperty.call(itDict, key) ? itDict[key]
            : key;  // last resort — return key itself
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            str = str.split(`{${k}}`).join(String(v));
        }
    }
    return str;
}

/** Convenience: pick one of two strings based on count (1 = singular, else plural). */
function plural(lang, count, key1, keyN, vars) {
    return t(lang, count === 1 ? key1 : keyN, vars);
}

/** Sanitize lang to one of the supported values, defaulting to 'it'. */
function sanitizeLang(lang) {
    return SUPPORTED.includes(lang) ? lang : DEFAULT_LANG;
}

// For tests: reset loaded dictionaries (e.g. after modifying JSON in-process)
function _reset() { _dicts = null; }

module.exports = { t, plural, sanitizeLang, _reset, SUPPORTED, DEFAULT_LANG };
