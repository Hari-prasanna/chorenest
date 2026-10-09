// Pure weekend calendar for the household time zone (Europe/Berlin), without Intl or Utilities.
// A weekend is identified by its Saturday as a local day number (days since 1970-01-01).

const CALENDAR_DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// EU rule: summer time runs from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October.
function berlinOffsetMs_(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  const summerStart = lastSundayUtc_(year, 2) + HOUR_MS;
  const summerEnd = lastSundayUtc_(year, 9) + HOUR_MS;
  return (utcMs >= summerStart && utcMs < summerEnd ? 2 : 1) * HOUR_MS;
}

function lastSundayUtc_(year, month) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  return lastDay.getTime() - lastDay.getUTCDay() * CALENDAR_DAY_MS;
}

function berlinDay_(utcMs) {
  return Math.floor((utcMs + berlinOffsetMs_(utcMs)) / CALENDAR_DAY_MS);
}

// Midnight is never close to a clock change, so the offset one hour earlier is the right one.
function berlinMidnight_(day) {
  const local = day * CALENDAR_DAY_MS;
  return local - berlinOffsetMs_(local - HOUR_MS);
}

function weekendFromSaturday_(saturday) {
  return {
    saturday: saturday,
    weekStartsAt: berlinMidnight_(saturday - 5),
    startsAt: berlinMidnight_(saturday),
    dueAt: berlinMidnight_(saturday + 2),
  };
}

/** The first weekend that starts after `afterMs`, and not before the Saturday `minSaturday`. */
function weekendAfter_(afterMs, minSaturday) {
  const tomorrow = berlinDay_(afterMs) + 1;
  const weekday = (tomorrow + 4) % 7;
  const saturday = tomorrow + ((6 - weekday + 7) % 7);
  return weekendFromSaturday_(Math.max(saturday, minSaturday));
}

/** The Saturday of the weekend that ends at `dueAtMs`. Rounds, so lost milliseconds in Sheets are harmless. */
function saturdayOfDue_(dueAtMs) {
  return Math.round((dueAtMs + berlinOffsetMs_(dueAtMs)) / CALENDAR_DAY_MS) - 2;
}
