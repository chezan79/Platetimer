// operations/ops-auth.js — Centralized authorization for PlateTimer Operations.
// All hierarchy rules live HERE and only here. Every Operations endpoint must
// use these functions; company is always derived from the verified session /
// server-side ops user record — never from client payloads.

const ROLES = ['DIRECTOR', 'CHEF_CUISINE', 'ADJOINT', 'SOUS_CHEF', 'CHEF_DE_BRIGADE'];

// Assignment / visibility matrix: for each actor role, the set of TARGET ROLES
// whose tasks the actor may see and to whom the actor may assign tasks.
// 'SELF' means only themselves regardless of role.
const ASSIGNABLE_ROLES = {
    DIRECTOR:        ['DIRECTOR', 'CHEF_CUISINE', 'ADJOINT', 'SOUS_CHEF', 'CHEF_DE_BRIGADE'],
    CHEF_CUISINE:    ['SOUS_CHEF', 'CHEF_DE_BRIGADE'], // + self, never DIRECTOR/ADJOINT
    ADJOINT:         ['CHEF_DE_BRIGADE'],              // + self
    SOUS_CHEF:       [],                               // self only
    CHEF_DE_BRIGADE: []                                // self only
};

function isValidRole(role) {
    return ROLES.includes(role);
}

// May `actor` assign a task to `target`? Both are ops user records
// ({ id, companyId, role }). Company isolation enforced first.
function canAssignTaskTo(actor, target) {
    if (!actor || !target) return false;
    if (actor.companyId !== target.companyId) return false;
    if (actor.id === target.id) return true; // self-assignment always allowed
    return (ASSIGNABLE_ROLES[actor.role] || []).includes(target.role);
}

// May `actor` view `task`? usersById maps ops user id → record (same company).
function canViewTask(actor, task, usersById) {
    if (!actor || !task) return false;
    if (actor.companyId !== task.companyId) return false;
    if (actor.role === 'DIRECTOR') return true;
    if (task.assigneeId === actor.id || task.createdBy === actor.id) return true;
    const assignee = usersById[task.assigneeId];
    if (!assignee) return false;
    return canAssignTaskTo(actor, assignee);
}

// May `actor` edit `task` (title, description, priority, due date, notes)?
// Director: may edit any visible task in their company.
// Creator: may edit only if they still have assignment rights over the current assignee.
//   (Spec §5: "can edit their own created task if they still have permission over the assignee.")
// This prevents a creator from editing after the assignee has been moved to a role
// they can no longer manage.
function canEditTask(actor, task, usersById) {
    if (!canViewTask(actor, task, usersById)) return false;
    if (actor.role === 'DIRECTOR') return true;
    if (task.createdBy === actor.id) {
        const assignee = (usersById || {})[task.assigneeId];
        if (!assignee) return false;
        return canAssignTaskTo(actor, assignee);
    }
    return false;
}

// May `actor` complete `task`? Assignee only (per Sprint 1 rules).
function canCompleteTask(actor, task) {
    if (!actor || !task) return false;
    if (actor.companyId !== task.companyId) return false;
    return task.assigneeId === actor.id;
}

// May `actor` manage users (create/list/deactivate)? Director only.
function canManageUsers(actor) {
    return !!actor && actor.role === 'DIRECTOR';
}

// May `actor` edit or perform status actions on `target`?
// Director + same company + never self (Director cannot manage their own account via these actions).
function canManageOpsUser(actor, target) {
    if (!actor || !target) return false;
    if (actor.companyId !== target.companyId) return false;
    if (actor.id === target.id) return false;
    return actor.role === 'DIRECTOR';
}

// May `actor` permanently delete `target`? Same rules as canManageOpsUser.
// Dependency check (hasUserDependencies) must be performed separately before deletion.
function canDeleteOpsUser(actor, target) {
    return canManageOpsUser(actor, target);
}

// Does `target` user have any historical/operational dependencies that prevent hard deletion?
// Checks tasks (assigned, created, comments, history entries) and recurring templates.
// `tasks` and `templates` must be the company's own arrays (caller enforces company isolation).
function hasUserDependencies(targetId, tasks, templates) {
    const taskDep = (tasks || []).some(t =>
        t.assigneeId === targetId ||
        t.createdBy  === targetId ||
        (t.comments || []).some(c => c.authorId === targetId) ||
        (t.history  || []).some(h => h.actorId  === targetId)
    );
    const tplDep = (templates || []).some(t =>
        t.defaultAssigneeId === targetId ||
        t.createdBy         === targetId
    );
    return taskDep || tplDep;
}

// List of company users the actor may assign tasks to (for the UX dropdown —
// backend still enforces on every request).
function allowedAssignees(actor, companyUsers) {
    return (companyUsers || []).filter(u => u.active !== false && canAssignTaskTo(actor, u));
}

// Validate that a Firebase account may activate an invitation.
// fbUser: record from Firebase accounts:lookup ({ localId, email, emailVerified }).
// invitation: server-side ops user record with status INVITED.
// [SECURITY] Requires a VERIFIED email that matches the invitation exactly —
// anyone can create an unverified Firebase account for any address, so an
// unverified match must never grant the invited role (account-takeover risk).
function validateActivationAccount(fbUser, invitation) {
    if (!fbUser || !fbUser.localId) return { ok: false, code: 401, error: 'Token Firebase non valido.' };
    if (!invitation || invitation.status !== 'INVITED') return { ok: false, code: 404, error: 'Invito non valido o già utilizzato.' };
    const fbEmail = (fbUser.email || '').toLowerCase();
    if (!fbEmail || fbEmail !== invitation.email) {
        return { ok: false, code: 403, error: 'L\'email dell\'account non corrisponde all\'invito.' };
    }
    if (fbUser.emailVerified !== true) {
        return { ok: false, code: 403, error: 'Devi prima verificare la tua email: controlla la casella di posta e clicca il link di verifica, poi riprova.' };
    }
    return { ok: true };
}

// May `actor` update completionPercent on `task`?
// Assignee can always update their own task's progress.
// Anyone who can edit the task (Director / task creator) may also update progress.
function canUpdateProgress(actor, task, usersById) {
    if (!actor || !task) return false;
    if (actor.companyId !== task.companyId) return false;
    if (task.assigneeId === actor.id) return true;
    return canEditTask(actor, task, usersById || {});
}

// May `actor` cancel (soft-delete) a task? Director only.
function canCancelTask(actor) {
    return !!actor && actor.role === 'DIRECTOR';
}

// ── Escalation chain ────────────────────────────────────────────────────────
// Maps assignee role → ordered list of roles to notify on escalation.
// Escalation never changes permissions — notification only.
const ESCALATION_CHAIN = {
    CHEF_DE_BRIGADE: ['ADJOINT', 'DIRECTOR'],
    SOUS_CHEF:       ['CHEF_CUISINE', 'DIRECTOR'],
    CHEF_CUISINE:    ['DIRECTOR'],
    ADJOINT:         ['DIRECTOR'],
    DIRECTOR:        [],
};

function getEscalationChain(role) {
    return ESCALATION_CHAIN[role] || [];
}

module.exports = {
    validateActivationAccount,
    ROLES,
    ASSIGNABLE_ROLES,
    ESCALATION_CHAIN,
    isValidRole,
    canAssignTaskTo,
    canViewTask,
    canEditTask,
    canCompleteTask,
    canUpdateProgress,
    canCancelTask,
    canManageUsers,
    canManageOpsUser,
    canDeleteOpsUser,
    hasUserDependencies,
    allowedAssignees,
    getEscalationChain,
};
