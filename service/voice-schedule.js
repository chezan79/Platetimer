'use strict';

// Restaurant-local time: Europe/Zurich handles CET/CEST transitions.
const TIME_ZONE = 'Europe/Zurich';
const WINDOWS = Object.freeze([
  Object.freeze({ start: '12:00', end: '14:30' }),
  Object.freeze({ start: '18:30', end: '22:00' })
]);
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit',
  second: '2-digit', hourCycle: 'h23'
});
function zurichSecondOfDay(at = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(at)
    .filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return parts.hour * 3600 + parts.minute * 60 + parts.second;
}
function fromClock(clock) {
  const [h, m] = clock.split(':').map(Number);
  return h * 3600 + m * 60;
}
function voiceWindow(at = new Date()) {
  const time = zurichSecondOfDay(at);
  for (const w of WINDOWS) {
    const start = fromClock(w.start), end = fromClock(w.end);
    if (time >= start && time < end) {
      return { allowed: true, secondsRemaining: end - time,
        start: w.start, end: w.end, timeZone: TIME_ZONE };
    }
  }
  return { allowed: false, secondsRemaining: 0, timeZone: TIME_ZONE };
}
module.exports = { TIME_ZONE, WINDOWS, voiceWindow };
