---
name: Service individual identity target
description: Durable identity and authorization boundary for future individual Service task actions on shared devices.
---

Use a separate company-scoped worker identity as the canonical Service person. Keep the Department Account as the shared device/department principal, and require short-lived server-verified worker proof for individual task actions. An optional Operations-user link must be explicit, same-company, and must not import Operations permissions.

**Why:** Current Service authentication proves only an active Department Account and department. It has no stable person relationship, while requiring full individual Operations/Firebase login on a shared restaurant workstation would add friction, exclude Service-only staff, and encourage credential sharing.

**How to apply:** For future Service claim/start/complete work, derive device and worker context server-side, recheck live worker membership and department state on every write, preserve separate identity namespaces, and keep countdown/Mex authority department-scoped unless separately redesigned. In multi-instance production, resolve worker, device account, department, and administrative actor from shared authoritative state on every authorization decision. Keep verification throttles and worker proofs in shared atomic storage, and use a device-scoped current-proof epoch so concurrent handoffs cannot leave two valid workers.