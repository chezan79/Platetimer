# Operations account repair — stuck INVITED / uid=null

## When is repair needed?
An Operations invitation normally becomes ACTIVE when the invitee opens the
activation link and completes `POST /api/operations/activate`. If the person
created their Firebase account outside the activation page (e.g. via the normal
register form), the ops record stays `INVITED` with `uid: null` and their login
cannot resolve an Operations identity.

Check for stuck accounts (Director session):

```
GET /api/operations/users?status=invited
```

Any record whose person already has a Firebase account (they can log in on
index.html) is a repair candidate. Otherwise, simply resend the invite.

## Repair endpoint (Director only, explicit, idempotent, non-destructive)

```
POST /api/operations/users/:id/repair-binding
Authorization: Bearer <director session token>
Body: { "dryRun": true }   ← always run first
```

- `dryRun: true` reports whether a safe match exists **without writing anything**.
- Without `dryRun`, the server binds the Firebase UID and sets the record ACTIVE,
  persisting via the normal datastore/Firestore mirror.

## Safety rules enforced server-side
- Only the Director of the same company can invoke it.
- Match is by **exact email** against Firebase Auth, and the Firebase email must
  be **verified** — otherwise refused (account-takeover protection).
- Refused if that Firebase UID is already bound to any other Operations record
  (ambiguous match), in any company.
- Already ACTIVE+bound records return success with `alreadyBound: true` (no-op).
- Never runs automatically; never deletes or overwrites existing bindings.
- Requires `FIREBASE_ADMIN_SERVICE_ACCOUNT` (Admin SDK); returns 503 otherwise.

## Alternative (no repair needed)
If the person has NOT yet created a Firebase account, do not repair — resend the
invitation (`POST /api/operations/users/:id/resend-invite`) and let them use the
activation link, which is now idempotent (a retry after a partial failure
succeeds instead of erroring).
