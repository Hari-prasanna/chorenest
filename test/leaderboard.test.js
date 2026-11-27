'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, asSignedIn, fixtureSheet, loadProject, plain } = require('./support/appsScript');

// Only Alex and Sam ever sign in here; Jo and Kim appear as data only.
const [ALEX, SAM, JO, KIM] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const SLOT = Object.fromEntries(FIXTURES.ROTATION.map((slot) => [slot.roommate_id, slot.rotation_id]));
// Monday 30 March 2026, the day after summer time began: the current Berlin month is March.
const NOW = new Date('2026-03-30T10:00:00Z');
const utc = (text) => new Date(text);

const rowsFor = (name, records = []) => {
  const headers = fixtureSheet(name)[0];
  return [headers, ...records.map((record) => headers.map((header) => (header in record ? record[header] : '')))];
};
let next = 0;
// `due` is the turn's deadline as stored: Monday 00:00 Berlin (23:00Z in winter, 22:00Z in summer).
const log = (roommate, outcome, due, markedAt, extra = {}) => ({
  log_id: `log-${++next}`, rotation_id: SLOT[roommate], roommate_id: roommate, due_date: utc(due), outcome, resolved_at: utc(markedAt),
  completed_at: outcome === 'completed' ? utc(markedAt) : '', notes: outcome === 'completed' ? '' : 'Because', created_at: utc(markedAt), ...extra,
});

const LOGS = [
  // Sam: February on time; then in March on time (the weekend of 28 Feb - 1 Mar counts for March, by its Sunday), late,
  // and on time on the weekend summer time began (deadline Monday 00:00 CEST = 22:00Z).
  log(SAM, 'completed', '2026-02-01T23:00:00Z', '2026-02-01T10:00:00Z'),
  log(SAM, 'completed', '2026-03-01T23:00:00Z', '2026-03-01T22:30:00Z'),
  log(SAM, 'completed', '2026-03-15T23:00:00Z', '2026-03-16T08:00:00Z'),
  log(SAM, 'completed', '2026-03-29T22:00:00Z', '2026-03-29T21:59:00Z'),
  // Alex: a vacation skip in February, on time in March, and Jo's turn by swap: Alex cleaned it, so Alex scores.
  log(ALEX, 'vacation_skipped', '2026-02-22T23:00:00Z', '2026-02-23T09:00:00Z'),
  log(ALEX, 'completed', '2026-03-08T23:00:00Z', '2026-03-08T12:00:00Z'),
  log(ALEX, 'completed', '2026-03-22T23:00:00Z', '2026-03-22T12:00:00Z', { rotation_id: SLOT[JO], swap_id: 'swap-1' }),
  // Jo: on time in February, then a turn closed by the owner in March.
  log(JO, 'completed', '2026-02-08T23:00:00Z', '2026-02-08T12:00:00Z'),
  log(JO, 'admin_resolved', '2026-03-08T23:00:00Z', '2026-03-09T09:00:00Z'),
  // Left out: a record naming nobody in ROOMMATES, and a malformed one.
  log('nobody-with-this-id', 'completed', '2026-03-08T23:00:00Z', '2026-03-08T12:00:00Z'),
  { ...log(SAM, 'completed', '2026-03-08T23:00:00Z', '2026-03-08T12:00:00Z'), due_date: 'soon' },
];

function database({ logs = LOGS, roommates = fixtureSheet('ROOMMATES') } = {}) {
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, {
    marker: 'DEV',
    sheets: { ROOMMATES: roommates, ROTATION: fixtureSheet('ROTATION'), CLEANING_LOGS: rowsFor('CLEANING_LOGS', logs), SWAPS: rowsFor('SWAPS'), VACATIONS: rowsFor('VACATIONS') },
  });
}
const server = (spreadsheet, now = NOW) =>
  loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now, maintenance: false });
const board = (project, request = {}, who = ALEX) => plain(project.get('getLeaderboard')(asSignedIn(project, { roommate_id: who, ...request })));
const byName = (result) => Object.fromEntries(result.entries.map((entry) => [entry.roommate.name.split(' ')[0], entry]));
const failed = (result, code) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
};

test('this month: 15 points on time, 10 late, 0 for skips and owner-closed turns, counted for the roommate who cleaned', () => {
  const result = board(server(database()));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.period, result.month], ['month', '2026-03'], 'the default is the current Berlin month');
  const { Sam, Alex, Jo, Kim } = byName(result);
  assert.deepEqual(
    [Sam.points, Sam.completed, Sam.on_time, Sam.late, Sam.missed, Sam.skipped, Sam.on_time_percent],
    [40, 3, 2, 1, 0, 0, 67], 'on time on 1 Mar (the Sunday decides the month) and on the clock-change weekend, late on 15 Mar'
  );
  assert.deepEqual([Alex.points, Alex.completed, Alex.on_time], [30, 2, 2], 'Alex scores the swapped turn he cleaned; the February skip is not this month');
  assert.deepEqual([Jo.points, Jo.completed, Jo.missed], [0, 0, 1], 'the swapped turn on Jo’s slot is not Jo’s');
  assert.deepEqual([Kim.points, Kim.completed, Kim.on_time_percent, Kim.best_streak, Kim.current_streak], [0, 0, null, 0, 0], 'no turns: zeros and no rate');
});

test('ranks follow points; equal points share a rank, and names order a tie', () => {
  const result = board(server(database()));
  assert.deepEqual(result.entries.map((e) => [e.rank, e.roommate.name, e.points]), [
    [1, 'Sam Example', 40], [2, 'Alex Example', 30], [3, 'Jo Example', 0], [3, 'Kim Example', 0],
  ]);

  const tied = board(server(database({ logs: [
    log(SAM, 'completed', '2026-03-08T23:00:00Z', '2026-03-08T12:00:00Z'),
    log(ALEX, 'completed', '2026-03-15T23:00:00Z', '2026-03-15T12:00:00Z'),
    log(KIM, 'completed', '2026-03-22T23:00:00Z', '2026-03-23T08:00:00Z'),
  ] })));
  assert.deepEqual(tied.entries.map((e) => [e.rank, e.roommate.name, e.points]), [
    [1, 'Alex Example', 15], [1, 'Sam Example', 15], [3, 'Kim Example', 10], [4, 'Jo Example', 0],
  ]);

  const empty = board(server(database({ logs: [] })));
  assert.deepEqual(empty.entries.map((e) => [e.rank, e.points]), [[1, 0], [1, 0], [1, 0], [1, 0]], 'nobody has cleaned: everyone shares first place');
});

test('streaks: on time extends, late and owner-closed reset, a vacation skip leaves it; the current streak runs across months', () => {
  const { Sam, Alex, Jo } = byName(board(server(database())));
  assert.deepEqual([Sam.best_streak, Sam.current_streak], [1, 1], 'this month: on time, late, on time');
  assert.deepEqual([Alex.best_streak, Alex.current_streak], [2, 2]);
  assert.deepEqual([Jo.best_streak, Jo.current_streak], [0, 0], 'the owner-closed turn ended the February streak');

  const all = byName(board(server(database()), { period: 'all' }));
  assert.deepEqual([all.Sam.best_streak, all.Sam.current_streak], [2, 1], 'February and 1 March in a row, then late');
  assert.deepEqual([all.Jo.best_streak, all.Jo.current_streak], [1, 0]);

  const skips = board(server(database({ logs: [
    log(SAM, 'completed', '2026-03-01T23:00:00Z', '2026-03-01T12:00:00Z'),
    log(SAM, 'vacation_skipped', '2026-03-08T23:00:00Z', '2026-03-09T09:00:00Z'),
    log(SAM, 'completed', '2026-03-15T23:00:00Z', '2026-03-15T12:00:00Z'),
    log(SAM, 'vacation_skipped', '2026-03-22T23:00:00Z', '2026-03-23T09:00:00Z'),
  ] })));
  const sam = byName(skips).Sam;
  assert.deepEqual([sam.points, sam.skipped, sam.best_streak, sam.current_streak], [30, 2, 2, 2], 'skips neither break nor extend it');
});

test('all time adds every month, and lists a roommate who moved out only with records', () => {
  const rows = fixtureSheet('ROOMMATES');
  rows[4][rows[0].indexOf('active')] = false; // Kim moved out
  const withKim = [...LOGS, log(KIM, 'completed', '2026-01-11T23:00:00Z', '2026-01-11T12:00:00Z')];

  const all = board(server(database({ logs: withKim, roommates: rows })), { period: 'all' });
  assert.deepEqual([all.period, all.month], ['all', null]);
  assert.deepEqual(all.entries.map((e) => [e.rank, e.roommate.name, e.points, e.roommate.active]), [
    [1, 'Sam Example', 55, true], [2, 'Alex Example', 30, true], [3, 'Jo Example', 15, true], [3, 'Kim Example', 15, false],
  ]);
  assert.equal(byName(all).Alex.skipped, 1);

  const month = board(server(database({ logs: withKim, roommates: rows })));
  assert.deepEqual(month.entries.map((e) => e.roommate.name), ['Sam Example', 'Alex Example', 'Jo Example'], 'no March records: Kim is not listed this month');
  const none = board(server(database({ logs: [], roommates: rows })), { period: 'all' });
  assert.equal(none.entries.some((e) => e.roommate.roommate_id === KIM), false);
});

test('the month changes at Berlin midnight, not UTC midnight', () => {
  const lastEvening = board(server(database(), new Date('2026-03-31T21:30:00Z'))); // 23:30 on 31 March in Berlin
  assert.equal(lastEvening.month, '2026-03');
  assert.equal(byName(lastEvening).Sam.points, 40);
  const april = board(server(database(), new Date('2026-03-31T22:30:00Z'))); // 00:30 on 1 April in Berlin, still 31 March in UTC
  assert.equal(april.month, '2026-04');
  assert.ok(april.entries.every((e) => e.points === 0 && e.rank === 1));

  const winter = board(server(database(), new Date('2026-02-28T23:30:00Z'))); // 00:30 on 1 March in Berlin (winter time)
  assert.equal(winter.month, '2026-03');
});

test('the deadline is the stored Monday 00:00 Berlin instant, across the clock change', () => {
  const marked = (at) => byName(board(server(database({ logs: [log(SAM, 'completed', '2026-03-29T22:00:00Z', at)] })))).Sam;
  assert.deepEqual([marked('2026-03-29T21:59:59Z').points, marked('2026-03-29T21:59:59Z').on_time], [15, 1], 'Sunday 23:59 CEST');
  assert.deepEqual([marked('2026-03-29T22:00:00Z').points, marked('2026-03-29T22:00:00Z').late], [10, 1], 'Monday 00:00 CEST is late');
});

test('the member profile uses the same scoring', () => {
  const project = server(database());
  const all = byName(board(project, { period: 'all' }));
  for (const [name, id] of [['Sam', SAM], ['Alex', ALEX], ['Jo', JO]]) {
    const profile = plain(project.get('getMemberProfile')({ token: asSignedIn(project, { roommate_id: ALEX }).token, roommate_id: id }));
    assert.deepEqual(profile.stats, { completed: all[name].completed, on_time: all[name].on_time, on_time_percent: all[name].on_time_percent }, name);
  }
});

test('the response holds names, avatars and counts only, marks the viewer, and reading writes nothing', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const before = spreadsheet.snapshot();
  const raw = project.get('getLeaderboard')(asSignedIn(project, { roommate_id: SAM }));
  const result = plain(raw);
  assert.deepEqual(Object.keys(result).sort(), ['entries', 'month', 'ok', 'period']);
  for (const entry of result.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['best_streak', 'completed', 'current_streak', 'is_you', 'late', 'missed', 'on_time', 'on_time_percent', 'points', 'rank', 'roommate', 'skipped']);
    assert.deepEqual(Object.keys(entry.roommate).sort(), ['active', 'avatar', 'name', 'roommate_id']);
  }
  assert.deepEqual(result.entries.filter((e) => e.is_you).map((e) => e.roommate.roommate_id), [SAM]);
  const json = JSON.stringify(raw);
  for (const roommate of FIXTURES.ROOMMATES) {
    for (const field of ['email', 'telegram_username', 'username', 'password_hash', 'member_code']) {
      if (roommate[field]) assert.equal(json.includes(`"${roommate[field]}"`), false, `${field} of ${roommate.name}`);
    }
  }
  assert.doesNotMatch(json, /pbkdf2|"role"|session|Because|swap-1|log-\d|nobody-with-this-id/);
  assert.equal(spreadsheet.snapshot(), before);
  assert.deepEqual(project.lock.events, [], 'read-only: no lock');
});

test('it needs a valid session and a known period, and nothing else in the request', () => {
  const project = server(database());
  const { token } = asSignedIn(project, { roommate_id: ALEX });
  const call = (request) => plain(project.get('getLeaderboard')(request));
  failed(call({ token: 'v1.unsigned.token' }), 'UNAUTHENTICATED');
  failed(call({ token: '' }), 'UNAUTHENTICATED');
  for (const request of [null, undefined, 'x', [], {}, { period: 'all' }, { token, period: 'week' }, { token, period: 'MONTH' }, { token, period: null }, { token, roommate_id: ALEX }, { token, month: '2026-02' }, { token: 7 }]) {
    failed(call(request), 'INVALID_REQUEST');
  }
  assert.equal(call({ token, period: 'all' }).ok, true);

  const rows = fixtureSheet('ROOMMATES');
  rows[2][rows[0].indexOf('active')] = false; // Sam moved out
  const moved = server(database({ roommates: rows }));
  failed(plain(moved.get('getLeaderboard')(asSignedIn(moved, { roommate_id: SAM }))), 'UNAUTHENTICATED');
});
