// Read-only presentation model for the Operations Tasks page.
// The input must already be filtered and authorized by /api/operations/tasks.
(function (root, factory) {
    const value = factory();
    if (typeof module === 'object' && module.exports) module.exports = value;
    root.OpsTaskGroups = value;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const MANAGER_ROLES = new Set(['DIRECTOR', 'CHEF_CUISINE', 'ADJOINT']);

    function isManager(role) { return MANAGER_ROLES.has(role); }

    function group(tasks, users, nowMs = Date.now()) {
        const byId = new Map();
        for (const task of tasks || []) {
            // null/unassigned is one group; missing *different* IDs stay distinct.
            const id = task.assigneeId == null || task.assigneeId === '' ? null : String(task.assigneeId);
            const key = id === null ? 'unassigned' : 'id:' + id;
            if (!byId.has(key)) {
                const user = id !== null && users ? users[id] : null;
                byId.set(key, {
                    key, assigneeId: id,
                    name: (user && user.name) || task.assigneeName || (id === null ? '' : id),
                    role: (user && user.role) || '',
                    missing: id !== null && !(user && user.name) && !task.assigneeName,
                    tasks: [], total: 0, open: 0, inProgress: 0,
                    overdue: 0, completed: 0, nextDue: null, tier: 4
                });
            }
            const item = byId.get(key);
            item.tasks.push(task);
            item.total++;
            if (task.status === 'OPEN') item.open++;
            if (task.status === 'IN_PROGRESS') item.inProgress++;
            if (task.status === 'COMPLETED') item.completed++;
            if (task.effectiveStatus === 'OVERDUE') item.overdue++;
            // Only active, future-due work counts as an upcoming deadline.
            if (task.status === 'OPEN' || task.status === 'IN_PROGRESS') {
                const due = task.dueDate ? Date.parse(task.dueDate) : NaN;
                if (Number.isFinite(due) && due >= nowMs && (item.nextDue === null || due < item.nextDue))
                    item.nextDue = due;
            }
        }
        const groups = [...byId.values()];
        for (const item of groups) {
            item.tier = item.overdue ? 0 : item.inProgress ? 1 : item.open ? 2 : item.completed ? 3 : 4;
        }
        groups.sort((a, b) =>
            a.tier - b.tier ||
            (a.nextDue === null ? Infinity : a.nextDue) - (b.nextDue === null ? Infinity : b.nextDue) ||
            a.name.localeCompare(b.name) ||
            a.key.localeCompare(b.key)
        );
        return groups;
    }

    return { isManager, group };
});