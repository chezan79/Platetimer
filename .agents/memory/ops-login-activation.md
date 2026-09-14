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
- **Rule:** first-Director bootstrap requires the server-controlled Firebase custom claims `plateTimerCompanyAdmin: true` and `plateTimerCompanyId`; signed session provenance must remain explicit and floor/direct-Service principals can never bootstrap.
  **Why:** a self-written Firestore company profile or a re-signed Floor token otherwise lets an ordinary user become the first Director of a tenant.
  **How to apply:** issue `ops-bootstrap` provenance only from verified custom claims, preserve provenance when deriving tokens, and require an existing ACTIVE Director record for Department Account administration.
- **Rule:** public signup must provision company membership through the server transaction, never through a client Firestore write.
  **Why:** company is an authorization boundary, but signup still needs to create a usable Service tenant without leaving an orphaned Firebase Auth user.
  **How to apply:** reserve the normalized company and write the user profile with Admin SDK atomically; client rules forbid company changes and the browser deletes the new Auth user if provisioning fails.
- **Rule:** department creation, rename, activation, deletion, and type changes are company administration and require the same ACTIVE Director authority as Department Account management.
  **Why:** department deactivation auto-suspends its account, so a weaker department guard bypasses the account-status guard.
  **How to apply:** keep read-only Service department access separate; route every department mutation through server-side Operations Director authorization.
- Test hook: `TEST_FIREBASE_AUTH_MOCK=1` lets the server accept locally-decoded mock Firebase tokens (`mockfb.<base64 JSON>`); repair reads a mock user directory from the data dir. Never set in production.
- Real e2e is possible: the Admin credential can create email-verified Firebase users for full activation/login verification, then delete them.
