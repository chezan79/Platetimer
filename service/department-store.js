'use strict';

const fs = require('fs');

// One document per legacy store, so every department writer must participate
// in the same transaction. Firestore retries the callback on write conflicts.
function createDepartmentStore({ firestore, collection = 'platetimer_stores', file, initial, onCommit }) {
    let local = initial || {};
    let queue = Promise.resolve();
    let generation = 0;
    const ref = firestore && firestore.collection(collection).doc('departments');

    function copy(value) { return JSON.parse(JSON.stringify(value)); }

    async function mutate(companyId, change) {
        const run = async () => {
            let output;
            let next;
            if (ref) {
                await firestore.runTransaction(async tx => {
                    const snapshot = await tx.get(ref);
                    next = copy(snapshot.exists && snapshot.data().store || {});
                    const company = next[companyId] || [];
                    output = change(company, next);
                    if (output && output.ok === false) return;
                    tx.set(ref, { store: next, updatedAt: Date.now() });
                });
            } else {
                next = copy(local);
                output = change(next[companyId] || [], next);
                if (!output || output.ok !== false) {
                    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
                    try {
                        fs.writeFileSync(temp, JSON.stringify(next, null, 2));
                        fs.renameSync(temp, file);
                    } finally {
                        try { fs.unlinkSync(temp); } catch (_) {}
                    }
                }
            }
            if (!output || output.ok !== false) {
                local = next;
                generation++;
                onCommit(next);
            }
            return output;
        };
        const pending = queue.then(run);
        queue = pending.catch(() => {});
        return pending;
    }

    async function refresh() {
        if (!ref) return;
        // An in-flight read taken before our own commit must not replace it.
        const before = generation;
        const snapshot = await ref.get();
        if (before !== generation) return refresh();
        local = snapshot.exists && snapshot.data().store &&
            typeof snapshot.data().store === 'object' ? snapshot.data().store : {};
        onCommit(local);
    }

    function setInitial(value) {
        local = value || {};
        generation++;
        onCommit(local);
    }

    return { mutate, refresh, setInitial };
}

module.exports = { createDepartmentStore };