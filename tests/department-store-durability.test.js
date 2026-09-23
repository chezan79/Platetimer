'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDepartmentStore } = require('../service/department-store');
const { setDepartmentType } = require('../service/department-accounts');

class FakeFirestore {
    constructor() { this.value = {}; this.queue = Promise.resolve(); this.fail = false; }
    collection() { return { doc: () => ({ get: async () => this.snapshot() }) }; }
    snapshot() {
        const value = JSON.parse(JSON.stringify(this.value));
        return { exists: true, data: () => ({ store: value }) };
    }
    async runTransaction(callback) {
        const run = async () => {
            const writes = [];
            const result = await callback({
                get: async () => this.snapshot(),
                set: (_ref, value) => writes.push(value)
            });
            if (this.fail) throw new Error('write rejected');
            if (writes.length) this.value = JSON.parse(JSON.stringify(writes[0].store));
            return result;
        };
        const pending = this.queue.then(run);
        this.queue = pending.catch(() => {});
        return pending;
    }
}

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'department-durable-'));
    const file = path.join(dir, 'departments.json');
    try {
        const db = new FakeFirestore();
        db.value = { co: [{ id: 'a', active: true, departmentType: 'CENTRAL' },
            { id: 'b', active: true }] };
        let memory;
        const repo = createDepartmentStore({ firestore: db, file, initial: db.value,
            onCommit: value => { memory = value; } });
        const change = (id, type) => repo.mutate('co', depts => setDepartmentType(depts, id, type));
        db.fail = true;
        await assert.rejects(change('a', 'STANDARD'), /write rejected/);
        assert.equal(db.value.co[0].departmentType, 'CENTRAL');
        assert.equal(memory, undefined, 'failed write cannot publish candidate memory');
        db.fail = false;
        assert.equal((await change('a', 'STANDARD')).ok, true);
        assert.equal(db.value.co[0].departmentType, 'STANDARD');
        db.fail = true;
        await assert.rejects(change('a', 'CENTRAL'), /write rejected/);
        assert.equal(db.value.co[0].departmentType, 'STANDARD', 'failed promotion is not published');
        db.fail = false;
        await repo.refresh();
        assert.equal(memory.co[0].departmentType, 'STANDARD');
        const second = createDepartmentStore({ firestore: db, file,
            initial: { co: [{ id: 'a', departmentType: 'CENTRAL' }] }, onCommit: () => {} });
        await second.mutate('co', depts => {
            depts[1].name = 'Updated using an old in-memory snapshot';
            return { ok: true };
        });
        assert.equal(db.value.co[0].departmentType, 'STANDARD', 'stale writer must merge on authority');
        const [promote, otherPromotion] = await Promise.all([
            change('a', 'CENTRAL'), second.mutate('co', depts => setDepartmentType(depts, 'b', 'CENTRAL'))
        ]);
        assert.equal(promote.ok, true);
        assert.equal(otherPromotion.code, 409);
        const local = createDepartmentStore({ file, initial: db.value, onCommit: () => {} });
        await local.mutate('co', depts => setDepartmentType(depts, 'a', 'STANDARD'));
        const reloaded = JSON.parse(fs.readFileSync(file));
        assert.equal(reloaded.co[0].departmentType, 'STANDARD', 'local restart sees committed demotion');
        fs.unlinkSync(file);
        fs.mkdirSync(file); // rename to a directory fails even under privileged test runners
        await assert.rejects(local.mutate('co', depts => setDepartmentType(depts, 'a', 'CENTRAL')));
        assert.equal(reloaded.co[0].departmentType, 'STANDARD');
        console.log('department-store durability: confirmed writes, failures, reload, stale writer and competing promotions passed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });