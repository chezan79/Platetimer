'use strict';
// Exercises the actual department-page receipt, alarm and tick functions with
// browser audio elements. No media decoding, network or authentication required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('public/department.html', 'utf8');
function segment(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, `missing page section: ${start}`);
    return source.slice(a, b);
}
const code = [
    segment('let _audioUnlocked = false;', '// ── Voice-message auto-play queue'),
    segment('function playAlarm(id) {', '// ── Utility'),
    segment('function handleIncomingCountdown(data){', 'function handleCountdownError(data){'),
    segment('function tick(){', '// ── [Task 66] Operations tasks')
].join('\n');

function page(dept, blocked = false) {
    const dom = new JSDOM('<audio id="snd-warn"></audio><audio id="snd-expiry"></audio>');
    const { document } = dom.window;
    const plays = [];
    for (const id of ['snd-warn', 'snd-expiry']) {
        const audio = document.getElementById(id);
        audio.play = () => {
            plays.push(id);
            return blocked ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
        };
        audio.pause = () => {};
    }
    let renders = 0;
    const context = vm.createContext({
        document, console: { warn() {} }, Date,
        nowTime: () => '12:00', renderCards: () => { renders++; },
        _vmPlaying: false, _vmQueue: [], _vmPlayNext: () => {},
        myDeptId: dept
    });
    vm.runInContext(`
      const countdowns = new Map();
      const pendingSends = new Set();
      const seenCountdownIds = new Set();
      ${code}
    `, context);
    return {
        receive: data => context.handleIncomingCountdown(data),
        tick: () => context.tick(),
        get: table => vm.runInContext(`countdowns.get(${JSON.stringify(table)})`, context),
        remove: table => vm.runInContext(`countdowns.delete(${JSON.stringify(table)})`, context),
        replayRender: () => context.renderCards(),
        plays, renders: () => renders,
        unlock: () => document.dispatchEvent(new dom.window.Event('pointerdown')),
        close: () => dom.window.close()
    };
}

const base = {
    action: 'startCountdown', countdownId: 'cd-first', tableNumber: '12',
    timeRemaining: 120, endsAt: Date.now() + 120000,
    destinations: ['kitchen', 'bar', 'bakery'], originDepartmentId: 'kitchen',
    live: true
};
const kitchen = page('kitchen'), otherKitchen = page('kitchen');
const bar = page('bar'), bakery = page('bakery'), outsider = page('outside');
for (const p of [kitchen, otherKitchen, bar, bakery, outsider]) p.receive(base);
assert.deepEqual(kitchen.plays, []);
assert.deepEqual(otherKitchen.plays, []);
assert.deepEqual(bar.plays, ['snd-warn']);
assert.deepEqual(bakery.plays, ['snd-warn']);
assert.deepEqual(outsider.plays, []);
for (const p of [bar, bakery]) {
    p.receive(base);                 // duplicate broadcast
    p.replayRender();                // ordinary rerender
    p.receive({ ...base, live: undefined }); // reconnect replay
    assert.deepEqual(p.plays, ['snd-warn']);
    assert.equal(p.get('12').warnedAt60, false);
}
const fresh = page('bar');
fresh.receive({ ...base, live: undefined }); // refresh and joinRoom replay
fresh.receive({ ...base, live: undefined }); // joinPage replay
fresh.receive(base); // delayed duplicate live delivery after replay
assert.deepEqual(fresh.plays, []);
const ownOnly = page('kitchen');
ownOnly.receive({ ...base, countdownId: 'cd-self', destinations: ['kitchen'] });
assert.deepEqual(ownOnly.plays, []);
bar.remove('12');
bar.receive({ ...base, countdownId: 'cd-second' }); // reused table, new identity
assert.deepEqual(bar.plays, ['snd-warn', 'snd-warn']);
assert.equal(bar.get('12').countdownId, 'cd-second');
bar.receive({ ...base, countdownId: 'cd-second' });
assert.equal(bar.plays.length, 2);
bar.receive(base); // delayed duplicate of old table identity cannot roll back card
assert.equal(bar.get('12').countdownId, 'cd-second');
assert.equal(bar.plays.length, 2);

// 60-second and expiry warnings are still independent of the incoming alert.
const cd = bar.get('12');
cd.endsAt = Date.now() + 59000;
bar.tick();
assert.deepEqual(bar.plays, ['snd-warn', 'snd-warn', 'snd-warn']);
assert.equal(cd.warnedAt60, true);
bar.tick();
assert.equal(bar.plays.length, 3);
cd.endsAt = Date.now() - 1000;
bar.tick();
assert.equal(bar.plays.at(-1), 'snd-expiry');
assert.equal(cd.timeRemaining, 0);
assert.equal(cd.alarmedExpiry, true);

const blocked = page('bar', true);
blocked.receive({ ...base, countdownId: 'cd-blocked' });
assert.deepEqual(blocked.plays, ['snd-warn']); // attempted once; rejection handled
blocked.receive({ ...base, countdownId: 'cd-blocked' });
assert.equal(blocked.plays.length, 1);

// Existing gesture path still primes both audio elements, without an incoming replay.
const unlock = page('bar');
unlock.unlock();
assert.deepEqual(unlock.plays, ['snd-warn', 'snd-expiry']);
unlock.receive({ ...base, live: undefined });
assert.equal(unlock.plays.length, 2);
for (const p of [kitchen, otherKitchen, bar, bakery, outsider, fresh, ownOnly, blocked, unlock]) p.close();
console.log('Countdown incoming alert: browser receipt, replay, audio and 60s checks passed.');