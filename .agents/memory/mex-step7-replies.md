---
name: Mex Step 7 Replies
description: Quick Reply (QR) implementation — convId-keyed cards, addReply store, WS events, countdowns.js callback extension.
---

## Key decisions

**Cards keyed by conversationId (not messageId)**: Both `mexCdCards` maps (department.html and sala.html) are now keyed by `conv.convId || msg.id`. This lets reply events update the existing card in-place and lets the original sender get a card when their first `mexReplyIncoming` arrives.

**Why:** Reply events only carry `conversationId`; if cards were keyed by `messageId`, replies couldn't find the right card.

**How to apply:** Any code that inserts or looks up a Mex card must use `convId` as the key.

---

## addReply queue resilience

`addReply` in `service/mex-store.js` uses `.catch(() => {})` on the previous queue promise before chaining:
```js
const prev = (queues[companyId] || Promise.resolve()).catch(() => {});
return (queues[companyId] = prev.then(async () => { ... }));
```
`getInboxForDept` also uses `.catch(() => {})` when awaiting the queue.

**Why:** A rejected security check (e.g. MEX_NOT_PARTICIPANT) would poison the queue, causing all subsequent operations to re-throw the same error without executing. This fix makes each operation independent.

---

## countdowns.js callback extension pattern

When adding a new WS action that sala.html must handle:
1. Add the callback name to the destructured `config` in `subscribeCountdowns()`
2. Add a dispatch branch in `ws.onmessage`
3. Add the named callback in sala.html's `subscribeToUpdates()` call

`onMexReplyAck` and `onMexReplyIncoming` follow this pattern (added in Step 7).

---

## sala.html onclick escaping pitfall

When Python writes JS string literals into HTML files, backslash-escaped single quotes (`\'`) inside single-quoted strings can be stripped if the Python string is not a raw string (`r"""..."""`). Always use raw strings in Python when writing JS with `\'` sequences, or use double quotes for the outer JS string instead.

---

## Test counts

- `tests/mex-step7-qr.test.js`: 66 unit tests (MexQR module, addReply, i18n)
- `tests/mex-step7-ws.test.js`: 38 WS integration tests on port 4450
