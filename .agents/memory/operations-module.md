---
name: PlateTimer Operations module
description: Durable security decisions for the Operations (brigade task management) module
---

- Role-hierarchy and activation-validation rules stay centralized in one server-side authorization module; never inline role checks in endpoints.
- **Why:** the assignment/visibility matrix is a mandatory business rule enforced server-side on every request; scattering checks invites drift.
- Company identity for any user with an Operations membership is the server-side ops record (set by the inviting Director or bootstrap) — it takes precedence over the client-writable Firestore profile at session issuance. Clients must never write a `company` value that influences authorization.
- **Why:** Firestore rules let users write their own profile, so a profile-derived company is forgeable; a review caught a cross-tenant takeover path through the activation page.
- Bootstrap rule: first authenticated user of a company with no ops users becomes DIRECTOR.
- Invitation activation requires a VERIFIED Firebase email matching the invite; unverified matches are an account-takeover vector. Invite codes are secrets — never log them or embed them in notification bodies.
