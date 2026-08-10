---
name: i18n foundation
description: Durable rules for PlateTimer's IT/FR/EN language system
---
- Language preference lives in localStorage `pt_language` and is routing/UI only — never authorization.
- Fallback chain is fixed: saved pref → browser fr/en → Italian; missing keys fall back to Italian, and the DOM keeps its existing text if dictionaries fail to load (never show raw keys).
- **Why:** the sprint plan forbids per-page language-switching code and undefined/raw-key leakage; a static-file failure must degrade to Italian markup.
- **How to apply:** migrate new pages via data-i18n attributes + the shared helper's init; keys stay namespaced (never visible Italian text as keys); server-generated texts and emails need a server-side strategy using the *recipient's* stored language, not the device preference.
- Gotchas: the repo `.gitignore` ignores `*.json` — new JSON assets need an explicit `!` exception or they silently vanish from commits. Node ≥21's global `navigator` is read-only; tests override it with `Object.defineProperty`.
