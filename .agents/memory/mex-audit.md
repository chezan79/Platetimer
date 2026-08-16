---
name: Mex architecture audit constraints
description: Binding design decisions from docs/mex-architecture-audit.md for the Mex messaging feature and corrected facts about WS gates and Firestore persistence.
---

Authoritative blueprint: `docs/mex-architecture-audit.md`. Key durable facts learned during review:

- The voice-message sender fallback `ws.boundDepartmentId || ws.pageType || data.from` is impersonable for unbound sockets (pageType/from are client-controlled). Mex requires a server-verified Floor principal (`ws.isFloorPrincipal` from a signed role claim or dedicated account set in joinRoom); no existing session field distinguishes a sala session.
- `wsSocketMatchesDest` delivers to ALL unbound sockets and ignores the sender — never reuse for private messaging; use an effective-principal ∈ participants predicate.
- The seven-action WebRTC list (~server.js 5087) is only a rate-limit exemption; the only WS auth gate is `PUBLIC_ACTIONS=['ping','pong','joinRoom']` (~5139).
- With Firestore active, `saveJSON` for a file not in `getStoreNameForFile` silently persists NOWHERE (no local fallback); unregistered stores never load at startup.
- Shared single-document stores hit Firestore's 1 MiB limit; Mex mandates per-company docs (`mex_<sha256(companyId)[0:32]>`), UTF-8 byte cap 700KB via `Buffer.byteLength`, per-company promise queue + transaction with `rev` precondition (multi-instance safe), success/broadcast only after commit.
