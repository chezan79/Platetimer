'use strict';

const BUSINESS_TIME_ZONE = 'Europe/Zurich';
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE
});

function isValidCalendarDate(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

// Preserve canonical date-only values as authored. ISO date-time values are
// instants and therefore convert to their Europe/Zurich business date.
// Missing, non-string, impossible date-only, and malformed values are rejected.
function normalizeBusinessDate(val) {
    if (typeof val !== 'string') return null;
    const value = val.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [year, month, day] = value.split('-').map(Number);
        return isValidCalendarDate(year, month, day) ? value : null;
    }

    // Explicit offsets avoid host-timezone-dependent parsing of local values.
    const match = value.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2}))$/
    );
    if (!match) return null;
    const [, year, month, day, hour, minute, second = '0', , , offsetHour = '0', offsetMinute = '0'] = match;
    if (!isValidCalendarDate(Number(year), Number(month), Number(day)) ||
        Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
        Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null;

    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? dateFormatter.format(milliseconds) : null;
}

module.exports = { BUSINESS_TIME_ZONE, normalizeBusinessDate };