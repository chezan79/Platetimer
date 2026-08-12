---
name: Sibling-department directory
description: How bound department accounts list other company departments without weakening S1.4 locking
---

**Rule:** Any client feature that needs the list of a company's other departments (voice destinations, countdown destinations, future messaging) must use `GET /api/voice-recipients` — the lightweight directory returning `{id,name}` of ACTIVE departments of the server-resolved session company. Never build such lists from `GET /api/departments`, which for bound accounts returns only the assigned department (S1.4 locking, intentional).

**Why:** After S1.4, `department.html` destination lists built from `/api/departments` went empty for bound accounts (self filtered out → nothing left). Voice was fixed first with the directory endpoint; countdown followed the same pattern.

**How to apply:** Client pattern in `department.html` (`buildVoiceDestList`, `buildDestList`): fetch `/api/voice-recipients`, filter out `myDeptId`, fall back to the legacy `departmentMap` only when the fetch yields nothing (unbound sessions). Server `startCountdown` (WS) already validates destinations against the company's active departments and only requires the bound dept to be among the destinations — sibling depts are accepted; no server change needed. Semantics: SUSPENDED account → 403, inactive assigned dept → 410 DEPARTMENT_INACTIVE (same as other locked endpoints).
