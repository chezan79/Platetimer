---
name: Operations user management
description: Full status lifecycle (ACTIVE/SUSPENDED/ARCHIVED/INVITED), team page UX, server endpoints, Firebase deletion behavior.
---

# Status model

| Status | active flag | Operations access | Assignee eligible | Scheduler emails |
|---|---|---|---|---|
| INVITED | true | blocked (no uid) | no | no |
| ACTIVE | true | ✅ | ✅ (per hierarchy) | ✅ |
| SUSPENDED | false | 403 "sospeso" | no | no |
| ARCHIVED | false | 403 "archiviato" | no | no |

Scheduler already uses `status === 'ACTIVE'` guards — no scheduler changes were needed.

# ops-auth.js additions

- `canManageOpsUser(actor, target)` — Director + same company + not self
- `canDeleteOpsUser(actor, target)` — same as above
- `hasUserDependencies(targetId, tasks, templates)` — checks: assigneeId, createdBy, comments[].authorId, history[].actorId, templates.defaultAssigneeId/createdBy

# Server endpoints

| Method | Path | Action |
|---|---|---|
| PUT | `/api/operations/users/:id` | Edit name / role / email (INVITED-only); legacy active toggle kept |
| POST | `/api/operations/users/:id/suspend` | ACTIVE/INVITED → SUSPENDED; returns openTasks count |
| POST | `/api/operations/users/:id/reactivate` | SUSPENDED → ACTIVE |
| POST | `/api/operations/users/:id/archive` | any → ARCHIVED |
| POST | `/api/operations/users/:id/restore` | ARCHIVED → ACTIVE |
| DELETE | `/api/operations/users/:id` | Permanent delete; 409 if hasUserDependencies |
| GET | `/api/operations/users?status=` | Filter: active/invited/suspended/archived/all; default excludes archived |

# publicOpsUser additions

Added `hasFirebaseAccount: !!u.uid` to the public shape — frontend uses this to show the Firebase-orphan warning on deletion.

# Firebase deletion behavior

Firebase Admin SDK is configured for Firestore only — NOT for `admin.auth().deleteUser()`. Deleting an ops record for a user with a Firebase uid removes Operations access (no ops record → 403 on requireOpsAuth) but leaves the Firebase Auth account as an orphan. The response includes `firebaseNote` warning when this occurs.

**Why:** Chose deletion-with-warning over blocking, since the orphaned Firebase account cannot re-enter the system (bootstrap only fires for zero-user companies). Manual cleanup via Firebase Console is required for the Firebase account itself.

# requireOpsAuth order

Status-specific messages added BEFORE the generic `active === false` check:
1. SUSPENDED → 403 "sospeso"
2. ARCHIVED → 403 "archiviato"
3. active === false → 403 "disattivato" (legacy fallback)

# Email field editability

Email is editable only for INVITED users with `uid === null` (no Firebase account bound). Once the user activates, their Firebase email is the identity; the field becomes read-only in both frontend and backend.

# Test counts

- User management: 57/57
- Sprint 4 regression: 109/109
- Sprint 3 regression: 94/94
- Sprint 2 regression: 54/54
- Email regression: 22/22
- Security regression: 36/36
- Total: **372/372**
