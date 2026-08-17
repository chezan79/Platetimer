# Operations Onboarding Email Flow — Read-Only Audit

Audit date: 2026-08-16 · Scope: why an invited Operations user receives BOTH a PlateTimer/Resend
invitation email AND a Firebase-branded verification email. No code, config, or tests were modified.

Env vars referenced (presence only, values never printed):
`RESEND_API_KEY` PRESENT · `APP_BASE_URL` PRESENT · `EMAIL_FROM` PRESENT · `SMTP_HOST/USER/PASS/PORT/SECURE` PRESENT ·
`FIREBASE_ADMIN_SERVICE_ACCOUNT` PRESENT · `OPERATIONS_MAIL_FROM` not set (falls back to hard-coded default sender).

---

## A. Exact step-by-step current onboarding sequence

1. **Director invites** — `POST /api/operations/users` (`server.js:2639`). Server creates an ops record
   `{status:'INVITED', uid:null, inviteCode: <32-hex single-use>}`, persists it, then builds
   `activationUrl = APP_BASE_URL + /operations-activate.html?code=<inviteCode>` (`server.js:2679–2681`).
2. **Email #1 (PlateTimer/Resend)** — `opsEmail.sendInvitationEmail(...)` (`server.js:2688`), sent from
   `PlateTimer Operations <operations@notifications.platetimer.com>`, subject `[PlateTimer Operations] Sei stato invitato`.
   Failure is non-fatal; the Director gets `emailStatus` + the relative activation path for manual sharing.
3. **Invitee opens link** — `public/operations-activate.html` loads; `loadInvitation()` calls
   `GET /api/operations/invitations/:code` (`server.js:3090`) to show name/role/company and prefill email.
4. **Invitee sets password** — `window.activate()` (`operations-activate.html:158`) calls Firebase client SDK
   `createUserWithEmailAndPassword` + `updateProfile`, then `finishActivation(cred.user)`.
   (Existing account path: `doLoginActivate()` → `signInWithEmailAndPassword` → `finishActivation`.)
5. **Email #2 (Firebase verification)** — inside `finishActivation()` (`operations-activate.html:84–89`):
   `user.reload()`; if `!user.emailVerified`, fire-and-forget `sendEmailVerification(user).catch(()=>{})` (line 88).
   This is the Firebase-branded email the user sees. Activation does NOT wait for it.
6. **Server binding** — `POST /api/operations/activate` with the Firebase ID token (`server.js:3103`):
   token → `lookupFirebaseAccount()` → `validateActivationAccount()` → bind `uid`, set `ACTIVE`,
   delete `inviteCode`, broadcast `OPS_INVITATION_ACCEPTED`.
7. **Firestore profile** — client creates minimal `users/{uid}` doc (name/email only; never `company`).
8. **Session exchange** — `POST /api/auth/session` → HMAC session token → redirect to `/operations.html`.

## B. Every Resend email trigger

Resend is used **only** for Operations invitations (`operations/ops-email.js:44–55`; `hasResend()` gates on `RESEND_API_KEY`).

| Trigger | File / function | When it fires |
|---|---|---|
| Invitation | `server.js:2688` → `sendInvitationEmail` (`ops-email.js:217`) → `_sendViaResend` (`ops-email.js:60`) | Director creates a user |
| Invitation resend | `server.js:2762` (`POST /api/operations/users/:id/resend-invite`, line 2740) | Director resends, only while status is `INVITED` |

Sender: `OPERATIONS_MAIL_FROM` or default `PlateTimer Operations <operations@notifications.platetimer.com>` (`ops-email.js:53–55`).
All other ops emails (task assignment `ops-email.js:170`, reminder `:273`, escalation `:318`, daily digest `:369`) use SMTP via nodemailer `_send()` (`:108`) or logging fallback — never Resend, never Firebase.

## C. Every Firebase email trigger

| Trigger | File / function / line | When it fires |
|---|---|---|
| **Verification email** | `public/operations-activate.html:88` — `sendEmailVerification(user)` in `finishActivation()` | Every activation where `user.emailVerified === false` (i.e. every fresh signup) — **this is the mystery email** |
| Password reset | `public/index.html:260` — `sendPasswordResetEmail(auth, email)` | User clicks "forgot password" on login page (not part of onboarding) |
| Action handlers (receive-side only) | `public/auth-actions.js:28` `applyActionCode`, `:38` `confirmPasswordReset`; `public/password-reset.html:70/143` `verifyPasswordResetCode`/`confirmPasswordReset` | Consume Firebase `oobCode` links; do not send email |

Server-side: **no** Firebase Admin action-code APIs are used anywhere (`generateEmailVerificationLink`,
`generatePasswordResetLink`, `sendOobCode` — zero occurrences in `server.js`/`operations/`).

## D. Precise call chain for the Firebase verification email

`public/operations-activate.html` → `activate()` (line 158) or `doLoginActivate()` (line 182)
→ `finishActivation(user)` (line 84) → `await user.reload()` (line 85) → `if (!user.emailVerified)` (line 86)
→ `try { sendEmailVerification(user).catch(() => {}); } catch (_) {}` (**line 88**, fire-and-forget, errors swallowed).

Because a freshly-created Firebase account always has `emailVerified === false`, **every normal onboarding
sends this email**. Firebase sends it from its default template: sender `noreply@app-dati-tavoli.firebaseapp.com`
(project branding), link to `https://app-dati-tavoli.firebaseapp.com/__/auth/action?...`.

## E. `emailVerified` dependency

- **Normal invite-code activation: NOT required.**
  - Client: activation proceeds immediately after firing the email (`operations-activate.html:82–90`, comment lines 81–83).
  - Server: `validateActivationAccount()` (`operations/ops-auth.js:123–131`) checks token validity, invitation status,
    and email match only — no `emailVerified` check (rationale in comments `ops-auth.js:117–122`).
  - Idempotent retry path also skips it (`server.js:3125–3135`).
  - Session exchange works with `emailVerified:false` (test 2.1, `tests/operations-activation-login.test.js:140`).
- **`POST /api/operations/users/:id/repair-binding` (`server.js:2836`): REQUIRED.**
  `if (fbMatch.emailVerified !== true) return 403` (`server.js:2865–2867`). Here verification IS the security proof,
  because repair binds an arbitrary pre-existing Firebase account by email match with no invite-code possession.
- Note: the server comment at `server.js:3139` ("must match AND be VERIFIED") is **stale** — the code below it does not
  enforce verification; `needsEmailVerification` in the 403 response (`server.js:3143`) only annotates email-mismatch failures.
- `showVerifyStep()` (`operations-activate.html:137`) is now dead-in-practice UI: reachable only if the server returns
  `needsEmailVerification:true`, which normal flow no longer produces.

## F. What the user sees today

1. **Email 1** — PlateTimer invitation via Resend: branded HTML, sender `operations@notifications.platetimer.com`,
   subject `[PlateTimer Operations] Sei stato invitato`, activation button. Expected, useful.
2. **Email 2** — Firebase default verification email, arriving seconds after they set a password:
   sender `noreply@app-dati-tavoli.firebaseapp.com`, generic Firebase template mentioning the project,
   link to `.../__/auth/action?mode=verifyEmail&oobCode=...`. Unexpected, unbranded, and **clicking it is not
   required** — activation already completed. This is the confusing "second email".

## G. Security dependencies that must not be broken

1. **Invite code is the primary proof** — single-use, 32-byte-hex, Director-generated, consumed atomically on activation.
2. **Email match** (`validateActivationAccount`) — prevents a code-holder from binding a different Firebase account.
3. **Company fixed server-side** — companyId comes from the invitation record; client never chooses (`server.js:3101–3102`).
4. **repair-binding MUST keep its `emailVerified === true` requirement** — without an invite code, verified email is the
   only ownership proof; also its ambiguity refusal (uid already bound → 409, `server.js:2869–2872`).
5. **Activation URL built from `APP_BASE_URL` only**, never request headers (`server.js:2676–2681`).
6. **Session issuance derives company from the server-side ops record**, never the token claim (test 4.8).
7. `users/{uid}` Firestore doc must never carry a client-written `company` field (`operations-activate.html:107–110`).
8. Email failures must stay non-fatal (persistence is source of truth, `ops-email.js:11`).

## H. Options

### Option A — Customize Firebase email branding (templates + custom domain/action URL)
- **Changes:** Firebase Console only (template text, sender name, custom SMTP/action URL); optionally point action URL at `auth-actions.js`/`password-reset.html`.
- **Pros:** zero code risk; nothing in the activation chain changes; password-reset emails get branded too.
- **Cons:** still **two emails**; Firebase template customization is limited (sender domain change requires DNS work);
  verification email remains functionally pointless for onboarding.
- **Risk:** minimal. Does not fix the duplication complaint, only the branding one.

### Option B — Generate Firebase verification link server-side (Admin `generateEmailVerificationLink`) and deliver it inside the Resend invitation
- **Changes:** remove `sendEmailVerification` from `operations-activate.html:88`; add Admin link generation at invite time
  or activation time; embed/send via Resend. Problem: at **invite time** the Firebase account does not exist yet
  (account is created by the invitee on the activation page), so the link would have to be sent in a *third* email
  post-activation, or activation must move to server-created accounts.
- **Pros:** fully branded; one sender domain.
- **Cons:** significant restructuring (server-side account pre-creation or a second post-activation email);
  Admin SDK link generation ties email delivery to `FIREBASE_ADMIN_SERVICE_ACCOUNT` availability; more moving parts.
- **Risk:** medium-high — touches the activation ordering that is heavily tested and idempotency-sensitive.

### Option C — Stop sending the client verification email; treat the Resend activation link itself as the verification event (mark verified server-side, or simply don't verify)
- **Changes (minimal form):** delete/guard the fire-and-forget at `operations-activate.html:88`. Optionally, in
  `POST /api/operations/activate`, after successful invite-code + email-match validation, set `emailVerified: true`
  via Admin SDK (`admin.auth().updateUser(uid, {emailVerified:true})`) — justified because the user proved control of
  the mailbox by clicking the Resend activation link sent to that address.
- **Pros:** exactly **one email**; smallest diff; consistent with the existing security stance ("invite code is the proof",
  Director vetted the address); keeps repair-binding working (accounts become verified at activation, so repair's
  `emailVerified` gate is *more* often satisfiable, not less).
- **Cons:** users who never receive the invitation email via Resend but get the raw link from the Director still get
  verified without a mailbox round-trip (acceptable: same trust level as today's activation, which already ignores
  verification); password-reset emails remain Firebase-branded (separate concern).
- **Risk:** low. Only guarded lines removed client-side; optional server-side flag set is additive and idempotent.

## I. Recommended safest direction

**Option C** (drop the client-side `sendEmailVerification`, optionally mark `emailVerified` server-side during
activation using the Admin SDK), **optionally combined with Option A's console-only template branding** for the
remaining password-reset emails. It eliminates the duplicate email with the smallest, most testable diff, preserves
every security dependency in §G, and strengthens (not weakens) the repair-binding path.

## J. Files a future fix would touch (Option C)

- `public/operations-activate.html` — remove lines 86–89 (verification fire-and-forget); possibly remove
  `sendEmailVerification` import (line 44) and dead `showVerifyStep()` (lines 137–156).
- `server.js` — optionally add `emailVerified:true` flagging inside `POST /api/operations/activate` (~line 3149),
  guarded on Admin SDK availability; fix the stale comment at line 3139.
- `tests/operations-activation-login.test.js` — checks 7.7/7.8 (lines 291–296) assert the page **still contains**
  `sendEmailVerification`; 7.8 must be inverted/updated.
- No changes to `operations/ops-email.js`, `operations/ops-auth.js`, `public/auth-actions.js`, `public/password-reset.html`.

## K. Tests required before changing the flow

1. Activation still succeeds end-to-end with `emailVerified:false` (exists: 1.6, 1.9, 2.x — must keep passing).
2. Page-contract test updated: activation page does **not** call `sendEmailVerification` (inverse of current 7.8).
3. If server-side verified-flagging is added: after activation, Firebase account reports `emailVerified:true`
   (needs an Admin-mock extension of `TEST_FIREBASE_AUTH_MOCK` / `mock-firebase-users.json`), and flagging failure is non-fatal.
4. repair-binding regression: unverified account still 403 (exists: 6.2), verified path still works (6.3–6.9).
5. Resend invitation regression suite unchanged (`tests/operations-invite-resend.test.js` — 12 points incl. sender,
   token-in-link, APP_BASE_URL, single-use code).
6. **Coverage gaps found (currently untested):**
   - No test asserts that exactly one email reaches the user during onboarding (no assertion that *no* Firebase
     verification is triggered — only the opposite, 7.8).
   - `showVerifyStep()` / `needsEmailVerification` branch has no test.
   - No test for the password-reset flow (`index.html:260`, `password-reset.html`) at all.
   - No test for `auth-actions.js` action handling.
   - Session exchange with a *verified* freshly-activated account (post-Option-C state) untested.

---

### Branding exposure points (supporting detail for F/H)

End users can see Firebase project identity in:
- Verification email sender/template: `app-dati-tavoli` project name, `noreply@app-dati-tavoli.firebaseapp.com`.
- Action links: `https://app-dati-tavoli.firebaseapp.com/__/auth/action?...` (verification + password reset).
- Client config in page source (by design, not an email issue): `authDomain: app-dati-tavoli.firebaseapp.com`,
  `messagingSenderId: 267339065819` in `operations-activate.html:47–54`, `auth-actions.js:7–15`, `password-reset.html:35–43`.

### Classification of each Firebase email-capable action (supporting §C/§5)

| Action | Location | Classification |
|---|---|---|
| `sendEmailVerification` at activation | `operations-activate.html:88` | **REDUNDANT** — activation neither waits for nor requires it; invite code is the proof |
| `showVerifyStep()` verify-then-retry UI | `operations-activate.html:137` | **LEGACY** — unreachable in the normal flow since the emailVerified requirement was removed |
| `sendPasswordResetEmail` | `index.html:260` | **REQUIRED** — only self-service password recovery mechanism |
| `applyActionCode` / `confirmPasswordReset` handlers | `auth-actions.js`, `password-reset.html` | **CURRENTLY REQUIRED** — consume Firebase links; needed while any Firebase emails exist |
| repair-binding `emailVerified===true` gate | `server.js:2865` | **REQUIRED** — sole ownership proof in the no-invite-code repair path |

### Duplicate-email matrix (normal onboarding)

| # | Sender | Purpose | Trigger | Necessary? |
|---|---|---|---|---|
| 1 | `operations@notifications.platetimer.com` (Resend) | Invitation + activation link | Director creates/resends invite | Yes |
| 2 | `noreply@app-dati-tavoli.firebaseapp.com` (Firebase) | Email verification | Client fire-and-forget at activation | **No** — duplication; verifying accomplishes nothing for onboarding or login |
