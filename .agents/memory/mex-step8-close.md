---
name: Mex Step 8 Close/Resolve
description: Implementation and test notes for the Mex conversation close feature
---

## Rule
`createAndSend` in `service/mex-store.js` MUST use `.catch(() => {})` before `.then()` when chaining on the queue (just like `addReply` and `closeConversation` do). Without it, a rejected `addReply` (e.g. `MEX_CONVERSATION_CLOSED`) poisons the queue and the next `createAndSend` propagates that rejection as its own error, causing `mexSendAck { success: false, code: 'MEX_CONVERSATION_CLOSED' }` for a brand-new send.

**Why:** `getQueue(companyId).then(fn)` skips `fn` when the queue is in a rejected state. Adding `.catch(() => {})` resets the rejection before chaining.

## How to apply
Any new queue operation added to `mex-store.js` must follow the pattern:
```js
const prev = (queues[companyId] || Promise.resolve()).catch(() => {});
return (queues[companyId] = prev.then(async () => { ... }));
```

## Rendering test patterns
- `with(window) { ... }` means the script's own `const countdowns = new Map()` shadows `window.countdowns`. Expose via `window._scriptCountdowns = typeof countdowns !== 'undefined' ? countdowns : null` in the loadDeptFunctions injection block.
- `_mt('key')` inside the script calls the script's own `_mt` function which reads `window.I18n.t(k)`. Shim `window.I18n = { t: k => dict[k] ?? k }` (not just `window._mt`).
- `closeMexConv` reads the function-scope `ws` variable (set by `new WebSocket(url)` in DOMContentLoaded). WebSocket shim via class constructor that captures `window._fakeWsInstance` is needed for WS send assertions in rendering tests.

## Tests
- `tests/mex-step8-lifecycle.test.js` — 39 tests on port 4452
- `tests/mex-step8-render.test.js` — 36 tests (jsdom)
