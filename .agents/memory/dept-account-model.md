---
name: Department Account model (Service)
description: Durable invariants of the Service department-account foundation
---
- The department owns its role: type/centrality (`departmentType` STANDARD|CENTRAL, absent=STANDARD) lives ONLY on the department record. Accounts never carry type/role/central data — permissions inherit from the referenced department.
- Invariants: one ACTIVE account per department; loginIdentifier globally unique (lowercased); max one CENTRAL department per company (reject-until-reverted); firebaseUid stays null until a login-binding sprint.
- Referential integrity: departments with bound accounts (any status) cannot be deleted; deactivating a department auto-suspends its ACTIVE account; account re-activation requires an active department.
- **Why:** accounts must never smuggle privileges or dangle without a department; CENTRAL is representation-only until an enforcement sprint derives permissions from it.
- **How to apply:** all department-account logic goes through the dedicated Service module's helpers — never inline lookups in server.js. Management endpoints are TRANSITIONAL (any company user) until Service Admin authz lands.
