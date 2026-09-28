'use strict';
// Exercises the actual department-page receipt, alarm and tick functions with
// browser audio elements. No media decoding, network or authentication required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('public/department.html', 'utf8');
const audioMarkup = ['snd-new-table', 'snd-warn', 'snd-expiry'].map(id => {
    const tag = source.match(new RegExp(`<audio\\s+id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `missing ${id} audio element`);
    return tag;
}).join('');
assert.match(audioMarkup, /id="snd-new-table" src="audio\/new-table-alert\.mp3"/);
assert.match(audioMarkup, /id="snd-warn"\s+src="alerte-346112\.mp3"/);
assert.match(audioMarkup, /id="snd-expiry" src="audio\/campana-expiry\.mp3"/);
assert.deepEqual(
    fs.readFileSync('public/audio/new-table-alert.mp3'),
    fs.readFileSync('attached_assets/Alert_5_1790591254403.mp3')
);
assert.deepEqual(
    fs.readFileSync('public/audio/campana-expiry.mp3'),
    fs.readFileSync('attached_assets/Campana_1790592360506.mp3')
);
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
    const dom = new JSDOM(audioMarkup);
    const { document } = dom.window;
    const plays = [];
    let time = Date.now(), activeExpiry = false, overlaps = 0, failExpiryOn = 0;
    class Clock extends Date { static now() { return time; } }
    for (const id of ['snd-new-table', 'snd-warn', 'snd-expiry']) {
        const audio = document.getElementById(id);
        audio.play = () => {
            plays.push(id);
            if (blocked || (id === 'snd-expiry' && plays.filter(p => p === id).length === failExpiryOn))
                return Promise.reject(new Error('NotAllowedError'));
            if (id === 'snd-expiry') {
                if (activeExpiry) overlaps++;
                activeExpiry = true;
            }
            return Promise.resolve();
        };
        audio.pause = () => { if (id === 'snd-expiry') activeExpiry = false; };
    }
    let renders = 0;
    const context = vm.createContext({
        document, console: { warn() {} }, Date: Clock,
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
        sendPending: table => vm.runInContext(`pendingSends.add(${JSON.stringify(table)})`, context),
        plays, renders: () => renders,
        setTime: value => { time = value; },
        failExpiryOn: n => { failExpiryOn = n; },
        endExpiry: () => {
            assert.equal(activeExpiry, true, 'only an active playback may end');
            activeExpiry = false;
            document.getElementById('snd-expiry').dispatchEvent(new dom.window.Event('ended'));
        },
        errorExpiry: () => {
            activeExpiry = false;
            document.getElementById('snd-expiry').dispatchEvent(new dom.window.Event('error'));
        },
        overlaps: () => overlaps,
        isPlaying: () => activeExpiry,
        isMuted: () => document.getElementById('snd-expiry').muted,
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
assert.deepEqual(bar.plays, ['snd-new-table']);
assert.deepEqual(bakery.plays, ['snd-new-table']);
assert.deepEqual(outsider.plays, []);
for (const p of [bar, bakery]) {
    p.receive(base);                 // duplicate broadcast
    p.replayRender();                // ordinary rerender
    p.receive({ ...base, live: undefined }); // reconnect replay
    p.receive({ ...base, timeRemaining: 110, endsAt: Date.now() + 110000 }); // timer update
    p.get('12').direction = 'received'; // status/card update
    p.replayRender();
    p.tick(); // ordinary tick well before 60 seconds
    assert.deepEqual(p.plays, ['snd-new-table']);
    assert.equal(p.get('12').warnedAt60, false);
}
const fresh = page('bar');
fresh.receive({ ...base, live: undefined }); // initial load of an existing table
fresh.receive({ ...base, live: undefined }); // joinPage replay
fresh.receive(base); // delayed duplicate live delivery after replay
assert.deepEqual(fresh.plays, []);
const reconnect = page('bar');
reconnect.receive({ ...base, live: undefined }); // joinRoom replay after reconnect
reconnect.receive(base);
assert.deepEqual(reconnect.plays, []);
const ownOnly = page('kitchen');
ownOnly.receive({ ...base, countdownId: 'cd-self', destinations: ['kitchen'] });
assert.deepEqual(ownOnly.plays, []);
const sender = page('bar');
sender.sendPending('12');
sender.receive({ ...base, countdownId: 'cd-sender', originDepartmentId: 'bar' });
assert.deepEqual(sender.plays, []);
assert.equal(sender.get('12').direction, 'sent');
const legacy = page('bar');
legacy.receive({ ...base, countdownId: 'cd-legacy', destinations: undefined, destination: 'bar' });
assert.deepEqual(legacy.plays, ['snd-new-table']);
const noIdentity = page('bar');
noIdentity.receive({ ...base, countdownId: undefined });
assert.deepEqual(noIdentity.plays, []);
bar.remove('12');
bar.receive({ ...base, countdownId: 'cd-second' }); // reused table, new identity
assert.deepEqual(bar.plays, ['snd-new-table', 'snd-new-table']);
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
assert.deepEqual(bar.plays, ['snd-new-table', 'snd-new-table', 'snd-warn']);
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
assert.deepEqual(blocked.plays, ['snd-new-table']); // attempted once; rejection handled
blocked.receive({ ...base, countdownId: 'cd-blocked' });
assert.equal(blocked.plays.length, 1);

// Existing gesture path primes all three audio elements, without an incoming replay.
const unlock = page('bar');
unlock.unlock();
assert.deepEqual(unlock.plays, ['snd-new-table', 'snd-warn', 'snd-expiry']);
unlock.receive({ ...base, live: undefined });
assert.equal(unlock.plays.length, 3);
for (const p of [kitchen, otherKitchen, bar, bakery, outsider, fresh, reconnect, ownOnly, sender, legacy, noIdentity, blocked, unlock]) p.close();

async function expiryChecks() {
    const p = page('bar');
    const start = Date.now();
    p.setTime(start);
    const incoming = { ...base, countdownId: 'near', tableNumber: 'near',
        endsAt: start + 800, timeRemaining: 0, live: undefined };
    p.receive(incoming);
    assert.equal(p.get('near').alarmedExpiry, false, 'near-expiry first receipt stays eligible');
    p.tick();
    assert.equal(p.get('near').timeRemaining, 0, 'display may show 0:00 early');
    assert.equal(p.get('near').expiredAt, null, 'grace does not start early');
    assert.deepEqual(p.plays, []);
    p.receive(incoming); // duplicate / reconnect update must not suppress it
    p.replayRender();
    p.setTime(start + 801); // skips the exact endsAt instant
    p.tick();
    assert.equal(p.get('near').expiredAt, incoming.endsAt);
    assert.deepEqual(p.plays, ['snd-expiry']);
    p.tick();
    p.receive(incoming);
    p.replayRender();
    assert.deepEqual(p.plays, ['snd-expiry']);

    // A second genuine expiry waits for all three ended-driven plays of the first.
    p.setTime(start + 400);
    p.receive({ ...incoming, countdownId: 'other', tableNumber: 'other', endsAt: start + 500 });
    p.setTime(start + 801);
    p.tick();
    assert.equal(p.plays.length, 1);
    p.endExpiry();
    assert.equal(p.plays.length, 2);
    p.endExpiry();
    assert.equal(p.plays.length, 3);
    p.endExpiry();
    assert.equal(p.plays.length, 4, 'queued expiry starts after first sequence ends');
    p.endExpiry();
    p.endExpiry();
    p.endExpiry();
    assert.equal(p.plays.length, 6, 'exactly three per eligible expiry');
    assert.equal(p.overlaps(), 0);
    assert.equal(p.isPlaying(), false);
    p.tick();
    assert.equal(p.plays.length, 6);

    // An actually expired first-seen replay remains silent, even on later ticks.
    const replay = page('bar');
    replay.setTime(start + 5000);
    replay.receive({ ...incoming, countdownId: 'expired', endsAt: start, timeRemaining: 0 });
    replay.tick();
    replay.receive({ ...incoming, countdownId: 'expired', endsAt: start, timeRemaining: 0 });
    assert.deepEqual(replay.plays, []);
    assert.equal(replay.get('near').expiredAt, start);

    // Completion/removal leaves no alarm state behind for a new table identity.
    p.remove('near');
    p.receive({ ...incoming, countdownId: 'reused', endsAt: start + 6000 });
    p.setTime(start + 6001);
    p.tick();
    assert.equal(p.plays.length, 7);
    p.endExpiry(); p.endExpiry(); p.endExpiry();
    assert.equal(p.plays.length, 9);

    const rejected = page('bar');
    rejected.setTime(start);
    rejected.receive({ ...incoming, countdownId: 'fail', endsAt: start + 100 });
    rejected.failExpiryOn(1);
    rejected.setTime(start + 101);
    rejected.tick();
    await new Promise(resolve => setImmediate(resolve)); // drain the VM promise rejection
    rejected.tick();
    assert.deepEqual(rejected.plays, ['snd-expiry']);
    rejected.remove('near');
    rejected.receive({ ...incoming, countdownId: 'after-fail', endsAt: start + 200 });
    rejected.setTime(start + 201);
    rejected.tick();
    assert.deepEqual(rejected.plays, ['snd-expiry', 'snd-expiry']);
    rejected.endExpiry(); rejected.endExpiry(); rejected.endExpiry();
    assert.equal(rejected.plays.length, 4);
    assert.equal(rejected.overlaps(), 0);

    const midFailure = page('bar');
    midFailure.setTime(start);
    midFailure.receive({ ...incoming, countdownId: 'mid-fail', endsAt: start + 100 });
    midFailure.failExpiryOn(2);
    midFailure.setTime(start + 101);
    midFailure.tick();
    midFailure.endExpiry();
    await new Promise(resolve => setImmediate(resolve));
    midFailure.tick();
    assert.equal(midFailure.plays.length, 2, 'failure on repeat ends the sequence');

    const mediaFailure = page('bar');
    mediaFailure.setTime(start);
    mediaFailure.receive({ ...incoming, countdownId: 'media-fail', endsAt: start + 100 });
    mediaFailure.setTime(start + 101);
    mediaFailure.tick();
    mediaFailure.errorExpiry();
    mediaFailure.tick();
    assert.equal(mediaFailure.plays.length, 1, 'media error terminates the sequence');
    mediaFailure.remove('near');
    mediaFailure.receive({ ...incoming, countdownId: 'media-next', endsAt: start + 200 });
    mediaFailure.setTime(start + 201);
    mediaFailure.tick();
    assert.equal(mediaFailure.plays.length, 2, 'media error releases the expiry channel');
    mediaFailure.endExpiry(); mediaFailure.endExpiry(); mediaFailure.endExpiry();

    // Local end-of-grace removal must also permit a new countdown on that table.
    p.setTime(start + 6000 + 120000);
    p.tick();
    assert.equal(p.get('near'), undefined);
    p.receive({ ...incoming, countdownId: 'after-grace', endsAt: start + 130000 });
    p.setTime(start + 130001);
    p.tick();
    assert.equal(p.plays.length, 10);
    p.endExpiry(); p.endExpiry(); p.endExpiry();
    // A first gesture while an autoplay-permitted bell is active must not pause
    // it or strand the second expiry in the queue.
    const gesture = page('bar');
    gesture.setTime(start);
    gesture.receive({ ...incoming, countdownId: 'gesture-a', endsAt: start + 100 });
    gesture.receive({ ...incoming, countdownId: 'gesture-b', tableNumber: 'other', endsAt: start + 100 });
    gesture.setTime(start + 101);
    gesture.tick();
    gesture.unlock();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(gesture.isPlaying(), true, 'gesture cannot pause active Campana');
    assert.equal(gesture.isMuted(), false);
    for (let i = 0; i < 6; i++) gesture.endExpiry();
    assert.equal(gesture.plays.filter(id => id === 'snd-expiry').length, 6);
    assert.equal(gesture.overlaps(), 0);

    // A gesture prime can also settle after the real expiry begins.
    const priming = page('bar');
    priming.setTime(start);
    priming.unlock();
    priming.receive({ ...incoming, countdownId: 'prime-race', endsAt: start + 100 });
    priming.setTime(start + 101);
    priming.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(priming.isPlaying(), true);
    assert.equal(priming.isMuted(), false);
    for (let i = 0; i < 3; i++) priming.endExpiry();
    assert.equal(priming.plays.filter(id => id === 'snd-expiry').length, 4);
    p.close(); replay.close(); rejected.close(); midFailure.close(); mediaFailure.close();
    gesture.close(); priming.close();
    console.log('Countdown incoming alert: browser receipt, replay, expiry sequencing and 60s checks passed.');
}
expiryChecks().catch(err => { console.error(err); process.exitCode = 1; });