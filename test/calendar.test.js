'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./support/appsScript');

const project = loadProject();
const berlinOffsetMs = project.get('berlinOffsetMs_');
const weekendAfter = project.get('weekendAfter_');
const saturdayOfDue = project.get('saturdayOfDue_');

const HOUR = 60 * 60 * 1000;
const utc = (...parts) => Date.UTC(...parts);

test('the daylight-saving rule agrees with the time zone database for 2025-2031', () => {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'longOffset' });
  const offsetOf = (ms) => {
    const name = format.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value;
    return name === 'GMT+02:00' ? 2 * HOUR : name === 'GMT+01:00' ? HOUR : NaN;
  };
  for (let ms = utc(2025, 0, 1); ms < utc(2032, 0, 1); ms += HOUR) {
    assert.equal(berlinOffsetMs(ms), offsetOf(ms), new Date(ms).toISOString());
  }
});

test('the weekend after a date starts on the next Saturday and ends Monday 00:00 Berlin', () => {
  const weekend = weekendAfter(utc(2026, 0, 7, 12), -Infinity);
  assert.equal(weekend.startsAt, utc(2026, 0, 9, 23));
  assert.equal(weekend.dueAt, utc(2026, 0, 11, 23));
  assert.equal(weekend.weekStartsAt, utc(2026, 0, 4, 23));
});

test('a weekend that has started is skipped; one that starts later that day is not', () => {
  const startsAt = utc(2026, 0, 9, 23);
  assert.equal(weekendAfter(startsAt - 1, -Infinity).startsAt, startsAt);
  assert.equal(weekendAfter(startsAt, -Infinity).startsAt, utc(2026, 0, 16, 23));
  assert.equal(weekendAfter(utc(2026, 0, 11, 15), -Infinity).startsAt, utc(2026, 0, 16, 23));
});

test('a minimum Saturday overrides an earlier weekend', () => {
  const minSaturday = weekendAfter(utc(2026, 0, 7), -Infinity).saturday + 7;
  assert.equal(weekendAfter(utc(2026, 0, 5), minSaturday).startsAt, utc(2026, 0, 16, 23));
});

test('weekend boundaries follow the clock changes', () => {
  const spring = weekendAfter(utc(2026, 2, 25), -Infinity);
  assert.equal(spring.startsAt, utc(2026, 2, 27, 23));
  assert.equal(spring.dueAt, utc(2026, 2, 29, 22));

  const autumn = weekendAfter(utc(2026, 9, 21), -Infinity);
  assert.equal(autumn.startsAt, utc(2026, 9, 23, 22));
  assert.equal(autumn.dueAt, utc(2026, 9, 25, 23));
});

test('a due date maps back to its Saturday, even if Sheets lost some milliseconds', () => {
  for (const monday of [utc(2026, 0, 11, 23), utc(2026, 2, 29, 22), utc(2026, 9, 25, 23)]) {
    const saturday = weekendAfter(monday - 3 * 24 * HOUR, -Infinity).saturday;
    for (const noise of [0, -1, 1, -999, 999]) assert.equal(saturdayOfDue(monday + noise), saturday);
  }
});
