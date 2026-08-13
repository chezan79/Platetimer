---
name: Operations login & activation binding
description: Durable rules for how Operations accounts authenticate, how routing decides Service home vs Operations, and how stuck invitations are repaired.
---

# Operations login & activation binding

- **Rule:** Operations identity is always resolved server-side via the session exchange; the client must never gate Operations routing on the presence/absence of a Firestore `users/{uid}` Service document (the activation page creates one *without* a company field, so doc-existence is a false signal).
  **Why:** doc-based gating stranded activated/repaired ops users on the Service home ("Documento utente non trovato" era the fatal variant).
  **How to apply:** login/home pages exchange the Firebase token for a server session first and route on the server's `isOperations`/`opsRole` flags; DIRECTOR keeps the Service home, all other ops roles go to the Operations role router.
- **Rule:** activation is idempotent — a retry by the same uid with a matching verified email succeeds even after the invite code is consumed. **Why:** a failed post-activation step must not leave the user facing "invito già utilizzato".
- **Rule:** stuck INVITED/uid-null records are repaired only via the explicit Director-only repair endpoint (dry-run first), matching by exact VERIFIED email via Firebase Admin, refusing ambiguous or unverified matches. Never repair automatically. See `docs/ops-account-repair.md`.
- Test hook: `TEST_FIREBASE_AUTH_MOCK=1` lets the server accept locally-decoded mock Firebase tokens (`mockfb.<base64 JSON>`); repair reads a mock user directory from the data dir. Never set in production.
- Real e2e is possible: the Admin credential can create email-verified Firebase users for full activation/login verification, then delete them.
