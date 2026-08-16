---
name: Task 66 Ack — service-dept acknowledgement
description: Acknowledgement store design, endpoint guards, and client behaviour for the Service-side "Presa visione" feature.
---

# Task 66 Ack: Service-department acknowledgement

## Rule
The acknowledgement is per-(companyId, taskId, serviceDepartmentId) tuple.
It is completely independent of the canonical Operations task — no field on the task is ever modified.

**Why:** Operations is the single source of truth. Service staff can only record that they have seen the task; they cannot change its lifecycle.

## How to apply
- Store: `opsAckStore` → `data/ops-ack.json` → Firestore key `ops_ack`.
  Helpers: `getOpsAcks(companyId)`, `saveOpsAcks()`, `isTaskAcknowledgedBy(companyId, taskId, deptId)`.
- Endpoint: `POST /api/service/ops-tasks/:taskId/acknowledge`
  — derives companyId + departmentId from `getBoundDepartmentContext(session)` only
  — validates task is OPEN|IN_PROGRESS + publishToService=true + correct dept (returns 404 otherwise)
  — idempotent (no duplicate records, 200 on repeat)
  — does NOT call saveOpsTasks(); calls saveOpsAcks() only
- GET `/api/service/ops-tasks` filters out acked tasks via `isTaskAcknowledgedBy`.
- Client: `acknowledgeOpsTask(taskId)` in `public/department.html` — disables button, POST, on success deletes from `opsTasks` Map + `renderOpsTasks()`.
- The ack persists even if the task is moved to a different dept and moved back — it stays hidden for the acking dept forever (no expiry mechanism in V1).

## Edge cases tested
- Completed/cancelled tasks → 404 (not OPEN/IN_PROGRESS)
- Unpublished tasks → 404
- Cross-company → 404
- Deactivated dept (auto-suspends account) → 403/410
- Survives server restart (opsAckStore loaded via initializeDataStores)
