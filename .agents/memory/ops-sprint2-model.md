---
name: Operations Sprint 2 task model
description: Key architecture decisions from Sprint 2 — extended task schema, explicit endpoints, auth rule change in canEditTask, audit history design.
---

# Operations Sprint 2 — Architecture decisions

## canEditTask rule change (IMPORTANT)
Creator can edit their task ONLY if they still have `canAssignTaskTo` rights over the current assignee. If the assignee is moved to a role the creator can't manage, the creator loses edit rights. Director always has full edit rights. This is intentional (spec §5).

**Why:** Prevents a lower-level user from editing a task that has been reassigned to a role above them in the hierarchy.

**How to apply:** Any time canEditTask is called or tested, remember this dual gate: canViewTask AND (Director OR (createdBy=actor AND canAssignTaskTo(actor, assignee))).

## Extended task schema fields (Sprint 2 additions)
New fields on all tasks (old tasks get defaults): `assigneeName`, `createdByName`, `notes`, `completionPercent`, `startedAt`, `attachments:[]`, `comments:[]`, `history:[]`.

**Why:** Backward compatible via defaults; avoids migration of existing stored tasks.

## Explicit action endpoints (Sprint 2)
New endpoints: GET /:id, PATCH /:id, POST /:id/start, POST /:id/progress, POST /:id/complete, POST /:id/reassign, POST /:id/cancel, POST /:id/comments, POST /:id/attachments, GET /stats. Old PUT /:id kept for backward compat (Sprint 1 tests use it).

## Audit history design
History stored as array on the task object itself (not separate store). Events created server-side only — PATCH, reassign, etc. all ignore client-supplied `history` field. addHistory() helper in server.js is the only write path.

## Attachment metadata
Attachments array stores metadata only (no actual file upload). POST /:id/attachments returns 501 if no storagePath provided. Firebase Storage not yet configured — Sprint 3 work.

## Status transitions
OPEN → IN_PROGRESS (via /start or progress>0) → COMPLETED (via /complete or progress=100) | CANCELLED (Director only via /cancel). CANCELLED never becomes OVERDUE. Completing a completed task is idempotent.

## Tests
Suite totals: 36 Sprint 1 security + 22 Sprint 1.1 email + 54 Sprint 2 = 112 total. All passing.
