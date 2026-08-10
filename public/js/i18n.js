// i18n.js — PlateTimer shared frontend i18n helper (I18N-1).
// One centralized language system for Service + Operations pages.
//
//   I18n.t(key)             → translated string (fallback chain, never null/undefined)
//   I18n.setLanguage(lang)  → switch + persist + re-apply immediately
//   I18n.getLanguage()      → current language code ('it' | 'fr' | 'en')
//   I18n.apply(root?)       → apply data-i18n / data-i18n-placeholder / data-i18n-title
//   I18n.mountSelector(sel?)→ mount the shared IT | FR | EN selector (once per page)
//   I18n.init(opts?)        → detect language, load dictionaries, apply, mount selector
//
// Preference is stored in localStorage under 'pt_language' — routing/UI only,
// NEVER used for authorization.
// Fallback chain: saved preference → browser fr/en → Italian.
// Missing keys fall back to the Italian dictionary; as an absolute last resort
// the key itself is returned (translation tests keep dictionaries key-consistent).
//
// The file is loadable in Node (module.exports) so translation logic is testable.

(function (global) {
    'use strict';

    const STORAGE_KEY  = 'pt_language';
    const DEFAULT_LANG = 'it';
    const SUPPORTED    = ['it', 'fr', 'en'];

    let _dicts = {};              // { it: {key:text}, fr: {...}, en: {...} }
    let _lang  = DEFAULT_LANG;

    function isSupported(lang) { return SUPPORTED.indexOf(lang) !== -1; }

    // Fallback chain: saved pref → browser fr/en → Italian. Invalid saved → Italian path.
    function detectLanguage() {
        try {
            if (typeof localStorage !== 'undefined') {
                const saved = localStorage.getItem(STORAGE_KEY);
                if (saved && isSupported(saved)) return saved;
            }
        } catch (e) { /* storage unavailable — continue */ }
        try {
            if (typeof navigator !== 'undefined' && navigator.language) {
                const nav = String(navigator.language).toLowerCase();
                if (nav.indexOf('fr') === 0) return 'fr';
                if (nav.indexOf('en') === 0) return 'en';
            }
        } catch (e) { /* ignore */ }
        return DEFAULT_LANG;
    }

    function t(key) {
        const cur = _dicts[_lang];
        if (cur && typeof cur[key] === 'string') return cur[key];
        const it = _dicts[DEFAULT_LANG];
        if (it && typeof it[key] === 'string') return it[key];
        return String(key); // last resort — never undefined/null
    }

    function getLanguage() { return _lang; }

    function setLanguage(lang) {
        if (!isSupported(lang)) lang = DEFAULT_LANG;
        _lang = lang;
        try {
            if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, lang);
        } catch (e) { /* storage unavailable */ }
        if (typeof document !== 'undefined') {
            document.documentElement.lang = lang;
            apply();
            _refreshSelectors();
        }
        return _lang;
    }

    function apply(root) {
        if (typeof document === 'undefined') return;
        root = root || document;
        // If a key resolves to itself (dictionaries missing/failed to load),
        // keep the existing markup text instead of exposing raw keys.
        root.querySelectorAll('[data-i18n]').forEach(function (el) {
            const key = el.getAttribute('data-i18n');
            const v = t(key);
            if (v !== key) el.textContent = v;
        });
        root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
            const key = el.getAttribute('data-i18n-placeholder');
            const v = t(key);
            if (v !== key) el.setAttribute('placeholder', v);
        });
        root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
            const key = el.getAttribute('data-i18n-title');
            const v = t(key);
            if (v !== key) el.setAttribute('title', v);
        });
    }

    // ── Selector (implemented once here — every page shares the same logic) ──
    const SELECTOR_CSS =
        '.i18n-selector{display:inline-flex;align-items:center;gap:2px;font-family:system-ui,-apple-system,sans-serif;' +
        'background:rgba(255,255,255,.92);border:1px solid #d1d5db;border-radius:8px;padding:3px 6px;' +
        'box-shadow:0 1px 4px rgba(0,0,0,.08);}' +
        '.i18n-selector-fixed{position:fixed;top:10px;right:12px;z-index:9999;}' +
        '.i18n-lang-btn{background:none;border:none;cursor:pointer;font-size:12px;font-weight:700;' +
        'letter-spacing:.04em;color:#6b7280;padding:3px 6px;border-radius:5px;transition:background .15s,color .15s;}' +
        '.i18n-lang-btn:hover{color:#111827;}' +
        '.i18n-lang-btn.active{background:#4f46e5;color:#fff;}' +
        '.i18n-sep{color:#d1d5db;font-size:11px;user-select:none;}';

    function _injectCss() {
        if (document.getElementById('i18n-selector-style')) return;
        const st = document.createElement('style');
        st.id = 'i18n-selector-style';
        st.textContent = SELECTOR_CSS;
        document.head.appendChild(st);
    }

    function _refreshSelectors() {
        document.querySelectorAll('.i18n-lang-btn').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-lang') === _lang);
        });
    }

    // mountSelector(container?) — container may be a CSS selector string or an element.
    // With no container, a fixed selector is appended to <body> (top-right).
    function mountSelector(container) {
        if (typeof document === 'undefined') return null;
        _injectCss();
        let el = null;
        if (typeof container === 'string') el = document.querySelector(container);
        else if (container) el = container;
        if (!el) {
            el = document.createElement('div');
            el.className = 'i18n-selector-fixed';
            document.body.appendChild(el);
        }
        el.classList.add('i18n-selector');
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', 'Lingua / Langue / Language');
        el.innerHTML = SUPPORTED.map(function (l) {
            return '<button type="button" class="i18n-lang-btn" data-lang="' + l + '">' + l.toUpperCase() + '</button>';
        }).join('<span class="i18n-sep">|</span>');
        el.querySelectorAll('.i18n-lang-btn').forEach(function (b) {
            b.addEventListener('click', function () { setLanguage(b.getAttribute('data-lang')); });
        });
        _refreshSelectors();
        return el;
    }

    // Test/injection hook: set dictionaries directly (Node tests, preloaded data).
    function setDictionaries(dicts) { _dicts = dicts || {}; }

    async function loadDictionaries(basePath) {
        basePath = basePath || 'i18n/';
        const out = {};
        await Promise.all(SUPPORTED.map(async function (l) {
            try {
                const r = await fetch(basePath + l + '.json');
                out[l] = r.ok ? await r.json() : {};
            } catch (e) { out[l] = {}; }
        }));
        _dicts = out;
    }

    // init({ selector?: string|Element|false, basePath?: string })
    // selector === false → no selector mounted (non-entry pages).
    async function init(opts) {
        opts = opts || {};
        _lang = detectLanguage();
        if (typeof document !== 'undefined' && typeof fetch !== 'undefined') {
            await loadDictionaries(opts.basePath);
        }
        if (typeof document !== 'undefined') {
            document.documentElement.lang = _lang;
            apply();
            if (opts.selector !== false) mountSelector(opts.selector);
        }
        return _lang;
    }

    const I18n = {
        t: t,
        setLanguage: setLanguage,
        getLanguage: getLanguage,
        detectLanguage: detectLanguage,
        apply: apply,
        mountSelector: mountSelector,
        setDictionaries: setDictionaries,
        loadDictionaries: loadDictionaries,
        init: init,
        SUPPORTED: SUPPORTED,
        DEFAULT_LANG: DEFAULT_LANG,
        STORAGE_KEY: STORAGE_KEY
    };

    global.I18n = I18n;
    if (typeof module !== 'undefined' && module.exports) module.exports = I18n;
})(typeof window !== 'undefined' ? window : globalThis);
