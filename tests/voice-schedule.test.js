'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { voiceWindow, WINDOWS, TIME_ZONE } = require('../service/voice-schedule');

const check = (iso, expected) => assert.equal(voiceWindow(new Date(iso)).allowed, expected, iso);
test('default service windows match the required Swiss time slots', () => {
  assert.deepEqual(WINDOWS.map(x=>[x.start,x.end]),[['12:00','14:30'],['18:30','22:00']]);
  assert.equal(TIME_ZONE,'Europe/Zurich');
});
test('winter: boundaries are inclusive start, exclusive end', () => {
  // Swiss winter time: UTC+1.
  check('2026-11-20T10:59:59Z',false); // 11:59:59
  check('2026-11-20T11:00:00Z',true);  // 12:00
  check('2026-11-20T13:29:59Z',true);  // 14:29:59
  check('2026-11-20T13:30:00Z',false); // 14:30
  check('2026-11-20T17:29:59Z',false); // 18:29:59
  check('2026-11-20T17:30:00Z',true);  // 18:30
  check('2026-11-20T20:59:59Z',true);  // 21:59:59
  check('2026-11-20T21:00:00Z',false); // 22:00
});
test('summer daylight-saving time is interpreted in Zurich', () => {
  // Swiss summer time: UTC+2.
  check('2026-07-20T09:59:59Z',false);
  check('2026-07-20T10:00:00Z',true);
  check('2026-07-20T12:30:00Z',false);
  check('2026-07-20T16:30:00Z',true);
  check('2026-07-20T20:00:00Z',false);
});
test('returns the exact seconds remaining to prevent over-long tokens', () => {
  assert.equal(voiceWindow(new Date('2026-11-20T13:29:59Z')).secondsRemaining,1);
  assert.equal(voiceWindow(new Date('2026-11-20T11:00:00Z')).secondsRemaining,9000);
  assert.equal(voiceWindow(new Date('2026-11-20T21:00:00Z')).secondsRemaining,0);
});
