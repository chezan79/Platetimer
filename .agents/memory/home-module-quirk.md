---
name: home.html module script quirk
description: Gotchas in home.html's mixed script loading that must be preserved.
---

# home.html module script quirks

## The setup
- `home.html` uses `<script type="module">` for Firebase SDK imports (ESM)
- `ws-auth.js` is a plain (non-module) script that exposes `window.WsAuth`
- ws-auth.js MUST be loaded as `<script src="js/ws-auth.js"></script>` BEFORE the module script; otherwise `WsAuth` is undefined when `loadDepartmentsGrid()` calls `WsAuth.getStoredToken()`

## updateCompanyName() unreachable from onAuthStateChanged
- `updateCompanyName()` is defined inside `document.addEventListener('DOMContentLoaded', function() { ... })`
- It is called from inside `onAuthStateChanged` at a line like `updateCompanyName()`
- This is technically a ReferenceError scope issue but it silently fails in practice (DOMContentLoaded fires before the auth callback resolves)
- **Do not fix** this without also wiring up the function correctly — it's used in a DOMContentLoaded-scoped way throughout and touches multiple calls

## buttonGrid opacity guard
- On page load, `const buttonGrid = document.querySelector('.button-grid')` → points to `#dept-grid` (first match)
- Opacity is set to 0.3 initially; `loadDepartmentsGrid()` restores it to 1
- A 5-second safety timeout also restores opacity in case auth fails
- The second `.button-grid` (Sala + Gestione Reparti) is NOT dimmed — intentional

**Why:** Mixed module/classic scripts need careful ordering; ESM defers execution but classic scripts run in-order at parse time.
