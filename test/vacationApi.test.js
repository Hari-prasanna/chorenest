'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const [ALEX, SAM, JO] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const ALEX_SLOT = FIXTURES.ROTATION[0].rotation_id;
const NOW = new Date('2026-01-07T12:00:00Z'); // Wednesday; Alex's turn (weekend 10-11 Jan) is open
const berlinMidnight = (month, day, year = 2026) => new Date(Date.UTC(year, month - 1, day - 1, 23)); // winter time

const rowsFor = (name, records = []) => {
  const headers = fixtureSheet(name)[0];
  return [headers, ...records.map((record) => headers.map((header) => (header in record ? record[header] : '')))];
};

const stored = (overrides = {}) => ({
  vacation_id: 'v-existing',
  roommate_id: SAM,
  start_date: berlinMidnight(1, 20),
  return_date: berlinMidnight(1, 27),
  created_at: new Date('2026-01-02T10:00:00Z'),
  ...overrides,
});

function database(vacations = [], extra = {}) {
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, {
    marker: 'DEV',
    sheets: {
      ROOMMATES: fixtureSheet('ROOMMATES'),
      ROTATION: fixtureSheet('ROTATION'),
      CLEANING_LOGS: rowsFor('CLEANING_LOGS'),
      SWAPS: rowsFor('SWAPS'),
      VACATIONS: rowsFor('VACATIONS', vacations),
      ...extra,
    },
  });
}

const server = (spreadsheet, now = NOW, options = {}) =>
  loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now, maintenance: false, ...options });
const call = (project, name, request) => plain(project.get(name)(request));
const save = (project, request) => call(project, 'saveVacation', request);
const cancel = (project, request) => call(project, 'cancelVacation', request);
const list = (project) => call(project, 'listVacations');
const schedule = (project) => call(project, 'getRotationSchedule');
const table = (spreadsheet, name) => {
  const [headers, ...rows] = spreadsheet.getSheetByName(name).values;
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]])));
};
const vacations = (spreadsheet) => table(spreadsheet, 'VACATIONS');
const plan = (overrides = {}) => ({ roommate_id: ALEX, start_date: '2026-01-09', return_date: '2026-01-12', ...overrides });
const failed = (result, code) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
};

// Saving

test('saves a vacation with Berlin midnight dates, an ID and a creation time, and the schedule then skips it', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const result = save(project, plan());
  assert.equal(result.ok, true);
  assert.match(result.vacation_id, /^[0-9a-f-]{36}$/);

  const [row, ...extra] = vacations(spreadsheet);
  assert.equal(extra.length, 0);
  assert.deepEqual([row.vacation_id, row.roommate_id], [result.vacation_id, ALEX]);
  assert.equal(row.start_date.getTime(), Date.UTC(2026, 0, 8, 23), 'Friday 9 Jan 00:00 Berlin');
  assert.equal(row.return_date.getTime(), Date.UTC(2026, 0, 11, 23), 'Monday 12 Jan 00:00 Berlin, the first day back');
  assert.equal(row.created_at.getTime(), NOW.getTime());
  assert.equal(row.cancelled_at, '');
  assert.deepEqual(project.lock.events, ['lock', 'unlock']);

  // The page refresh after saving shows the effect, and the vacation list says the same.
  assert.equal(schedule(project).current.assignee.roommate_id, SAM);
  const [listed] = list(project).vacations;
  assert.deepEqual(listed.weekends.map((w) => w.status), ['skipped']);
});

test('dates are exact across the October clock change', () => {
  const spreadsheet = database();
  assert.equal(save(server(spreadsheet, new Date('2026-10-14T10:00:00Z')), plan({ start_date: '2026-10-23', return_date: '2026-10-26' })).ok, true);
  const [row] = vacations(spreadsheet);
  assert.equal(row.start_date.getTime(), Date.UTC(2026, 9, 22, 22), 'Fri 23 Oct 00:00 CEST');
  assert.equal(row.return_date.getTime(), Date.UTC(2026, 9, 25, 23), 'Mon 26 Oct 00:00 CET');
});

test('only real, sensible dates are accepted, and nothing is written or locked for a bad request', () => {
  const cases = [
    [{ start_date: '2026-1-9' }, 'VACATION_DATES_INVALID'], [{ start_date: '09/01/2026' }, 'VACATION_DATES_INVALID'],
    [{ start_date: '2026-02-30' }, 'VACATION_DATES_INVALID'], [{ return_date: '2026-13-01' }, 'VACATION_DATES_INVALID'],
    [{ start_date: '1999-01-01' }, 'VACATION_DATES_INVALID'], [{ return_date: '2101-01-01' }, 'VACATION_DATES_INVALID'],
    [{ start_date: 20260109 }, 'VACATION_DATES_INVALID'], [{ return_date: '' }, 'VACATION_DATES_INVALID'], [{ start_date: null }, 'VACATION_DATES_INVALID'],
    [{ start_date: '2026-01-06' }, 'VACATION_IN_PAST'],
    [{ return_date: '2026-01-09' }, 'VACATION_ORDER'], [{ return_date: '2026-01-08' }, 'VACATION_ORDER'],
    [{ return_date: '2026-05-10' }, 'VACATION_TOO_LONG'],
    [{ start_date: '2027-01-10', return_date: '2027-01-12' }, 'VACATION_TOO_FAR'],
    [{ role: 'admin' }, 'INVALID_REQUEST'], [{ is_admin: true }, 'INVALID_REQUEST'], [{ roommate_id: 'has space' }, 'INVALID_REQUEST'],
    [{ roommate_id: '' }, 'INVALID_REQUEST'], [{ roommate_id: ['a'] }, 'INVALID_REQUEST'], [{ roommate_id: 'x'.repeat(65) }, 'INVALID_REQUEST'],
  ];
  for (const [change, code] of cases) {
    const spreadsheet = database();
    const project = server(spreadsheet);
    const before = spreadsheet.snapshot();
    failed(save(project, plan(change)), code);
    assert.equal(spreadsheet.snapshot(), before, JSON.stringify(change));
    assert.deepEqual(project.lock.events, [], 'invalid requests never reach the lock');
  }
  for (const request of [null, undefined, 'x', 7, [], [plan()], {}]) failed(save(server(database()), request), 'INVALID_REQUEST');
});

test('the limits are exact: today and 120 days are fine, 366 days ahead is fine', () => {
  const ok = [plan({ start_date: '2026-01-07', return_date: '2026-01-08' }), plan({ start_date: '2026-01-09', return_date: '2026-05-09' }), plan({ start_date: '2027-01-08', return_date: '2027-01-10' })];
  for (const request of ok) assert.equal(save(server(database()), request).ok, true, JSON.stringify(request));
});

test('unknown and inactive roommates are refused under the lock, without writing', () => {
  const rows = fixtureSheet('ROOMMATES');
  rows[2][rows[0].indexOf('active')] = false; // Sam
  for (const roommate_id of ['nobody-with-this-id', SAM]) {
    const spreadsheet = database([], { ROOMMATES: rows });
    const project = server(spreadsheet);
    failed(save(project, plan({ roommate_id })), 'UNKNOWN_ROOMMATE');
    assert.equal(vacations(spreadsheet).length, 0);
    assert.deepEqual(project.lock.events, ['lock', 'unlock']);
  }
});

// Duplicates and overlaps

test('duplicates and overlaps are refused; back-to-back, other roommates and cancelled vacations are fine', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  assert.equal(save(project, plan({ start_date: '2026-01-20', return_date: '2026-01-27' })).ok, true);
  for (const [start_date, return_date] of [['2026-01-20', '2026-01-27'], ['2026-01-23', '2026-01-30'], ['2026-01-15', '2026-01-21'], ['2026-01-21', '2026-01-23'], ['2026-01-10', '2026-02-10']]) {
    failed(save(project, plan({ start_date, return_date })), 'VACATION_OVERLAP');
  }
  assert.equal(vacations(spreadsheet).length, 1);
  assert.equal(save(project, plan({ start_date: '2026-01-27', return_date: '2026-01-30' })).ok, true, 'back-to-back');
  assert.equal(save(project, plan({ roommate_id: SAM, start_date: '2026-01-20', return_date: '2026-01-27' })).ok, true, 'another roommate');

  const [first] = vacations(spreadsheet);
  assert.equal(cancel(project, { roommate_id: ALEX, vacation_id: first.vacation_id }).ok, true);
  assert.equal(save(project, plan({ start_date: '2026-01-20', return_date: '2026-01-27' })).ok, true, 'a cancelled vacation does not block');
});

test('a roommate can have at most ten planned vacations', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  for (let i = 0; i < 10; i++) {
    const day = String(10 + i * 2).padStart(2, '0');
    const month = i < 10 ? '03' : '04';
    assert.equal(save(project, plan({ start_date: `2026-${month}-${day}`, return_date: `2026-${month}-${String(Number(day) + 1).padStart(2, '0')}` })).ok, true, `vacation ${i + 1}`);
  }
  failed(save(project, plan({ start_date: '2026-06-01', return_date: '2026-06-03' })), 'VACATION_LIMIT');
  assert.equal(vacations(spreadsheet).length, 10);
});

// Concurrency and failures

test('two saves of the same dates at once: one is written, the other waits out and is refused', () => {
  const spreadsheet = database();
  const lock = { events: [], held: false, deny: false };
  const first = server(spreadsheet, NOW, { lock });
  const second = server(spreadsheet, NOW, { lock });
  const sheet = spreadsheet.getSheetByName('VACATIONS');
  const appendRow = sheet.appendRow.bind(sheet);
  let during;
  sheet.appendRow = (row) => {
    during = save(second, plan());
    appendRow(row);
  };
  assert.equal(save(first, plan()).ok, true);
  failed(during, 'BUSY');
  failed(save(second, plan()), 'VACATION_OVERLAP');
  assert.equal(vacations(spreadsheet).length, 1);
  assert.deepEqual(lock.events, ['lock', 'lock-denied', 'unlock', 'lock', 'unlock']);
});

test('a busy lock or a failed write records nothing, hides the cause, and releases the lock', () => {
  const busy = database();
  failed(save(server(busy, NOW, { lock: { events: [], held: false, deny: true } }), plan()), 'BUSY');
  assert.equal(vacations(busy).length, 0);

  const spreadsheet = database();
  const sheet = spreadsheet.getSheetByName('VACATIONS');
  const appendRow = sheet.appendRow.bind(sheet);
  sheet.appendRow = () => {
    throw new Error('Service Spreadsheets failed 1AbC-secret');
  };
  const project = server(spreadsheet);
  const result = save(project, plan());
  failed(result, 'WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(vacations(spreadsheet).length, 0);
  assert.equal(project.lock.held, false);
  sheet.appendRow = appendRow;
  assert.equal(save(project, plan()).ok, true, 'a retry works');
});

test('the checks and the write happen while the lock is held', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  for (const sheet of spreadsheet.sheets.values()) {
    const getDataRange = sheet.getDataRange.bind(sheet);
    const appendRow = sheet.appendRow.bind(sheet);
    sheet.getDataRange = () => (project.lock.events.push('read'), getDataRange());
    sheet.appendRow = (row) => (project.lock.events.push('write'), appendRow(row));
  }
  assert.equal(save(project, plan()).ok, true);
  assert.match(project.lock.events.join(' '), /^lock( read)+ write( read)* unlock$/);
});

// Cancelling

test('cancels a future vacation without deleting it, and the rotation stops skipping it', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const { vacation_id } = save(project, plan({ start_date: '2026-01-20', return_date: '2026-01-27' }));
  const before = table(spreadsheet, 'VACATIONS');

  assert.deepEqual(cancel(project, { roommate_id: ALEX, vacation_id }), { ok: true });
  const rows = vacations(spreadsheet);
  assert.equal(rows.length, before.length, 'the row is kept as an audit trail');
  assert.equal(rows[0].cancelled_at.getTime(), NOW.getTime());
  assert.deepEqual({ ...rows[0], cancelled_at: '' }, { ...before[0], cancelled_at: '' }, 'nothing else changed');
  assert.deepEqual(list(project).vacations, []);
  assert.equal(project.lock.held, false);

  failed(cancel(project, { roommate_id: ALEX, vacation_id }), 'VACATION_NOT_FOUND');
});

test('a cancelled vacation no longer skips anyone', () => {
  const spreadsheet = database([stored({ vacation_id: 'v-alex', roommate_id: ALEX, start_date: berlinMidnight(1, 9), return_date: berlinMidnight(1, 12), created_at: new Date('2026-01-02T10:00:00Z') })]);
  const project = server(spreadsheet);
  assert.equal(schedule(project).current.assignee.roommate_id, SAM, 'skipped while the vacation is planned');
  assert.equal(cancel(server(database([stored({ vacation_id: 'v-alex', roommate_id: ALEX, start_date: berlinMidnight(1, 9), return_date: berlinMidnight(1, 12), created_at: new Date('2026-01-02T10:00:00Z') })])), { roommate_id: ALEX, vacation_id: 'v-alex' }).ok, true);

  const cancelled = database([stored({ vacation_id: 'v-alex', roommate_id: ALEX, start_date: berlinMidnight(1, 9), return_date: berlinMidnight(1, 12), created_at: new Date('2026-01-02T10:00:00Z'), cancelled_at: new Date('2026-01-03T10:00:00Z') })]);
  assert.equal(schedule(server(cancelled)).current.assignee.roommate_id, ALEX);
});

test('only your own, not-yet-started, not-yet-used vacation can be cancelled', () => {
  const started = stored({ vacation_id: 'v-started', roommate_id: ALEX, start_date: berlinMidnight(1, 5), return_date: berlinMidnight(1, 12) });
  const future = stored({ vacation_id: 'v-future', roommate_id: ALEX });
  const spreadsheet = database([started, future]);
  const project = server(spreadsheet);
  const before = spreadsheet.snapshot();

  failed(cancel(project, { roommate_id: SAM, vacation_id: 'v-future' }), 'NOT_YOUR_VACATION');
  failed(cancel(project, { roommate_id: ALEX, vacation_id: 'v-started' }), 'VACATION_STARTED');
  failed(cancel(project, { roommate_id: ALEX, vacation_id: 'v-missing' }), 'VACATION_NOT_FOUND');
  for (const request of [null, {}, { roommate_id: ALEX }, { vacation_id: 'v-future' }, { roommate_id: ALEX, vacation_id: 'bad id!' }, { roommate_id: ALEX, vacation_id: 'v-future', role: 'admin' }]) {
    failed(cancel(project, request), 'INVALID_REQUEST');
  }
  assert.equal(spreadsheet.snapshot(), before, 'every refusal leaves the Sheet untouched');
});

test('a vacation that has already skipped a turn cannot be cancelled', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const { vacation_id } = save(project, plan());
  assert.equal(schedule(project).current.assignee.roommate_id, SAM, 'this page load records the skip');
  assert.equal(table(spreadsheet, 'CLEANING_LOGS').length, 1);
  const before = spreadsheet.snapshot();
  failed(cancel(project, { roommate_id: ALEX, vacation_id }), 'VACATION_IN_USE');
  assert.equal(spreadsheet.snapshot(), before);
  assert.equal(list(project).vacations[0].cancellable, false);
});

test('a failed cancel changes nothing and releases the lock', () => {
  const spreadsheet = database([stored({ vacation_id: 'v-future', roommate_id: ALEX })]);
  const project = server(spreadsheet);
  const sheet = spreadsheet.getSheetByName('VACATIONS');
  const getRange = sheet.getRange.bind(sheet);
  sheet.getRange = () => {
    throw new Error('Service Spreadsheets failed 1AbC-secret');
  };
  const before = spreadsheet.snapshot();
  const result = cancel(project, { roommate_id: ALEX, vacation_id: 'v-future' });
  failed(result, 'WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(spreadsheet.snapshot(), before);
  assert.equal(project.lock.held, false);
  sheet.getRange = getRange;
  assert.equal(cancel(project, { roommate_id: ALEX, vacation_id: 'v-future' }).ok, true);
});

// Listing

test('the list shows current and planned vacations with affected weekends and their skip status, and hides the rest', () => {
  const early = new Date('2026-01-02T10:00:00Z'); // before the turns were assigned, so the engine skips silently
  const rows = [
    stored({ vacation_id: 'v-sam', roommate_id: SAM, start_date: berlinMidnight(1, 9), return_date: berlinMidnight(1, 26), created_at: early }),
    stored({ vacation_id: 'v-far', roommate_id: JO, start_date: berlinMidnight(7, 1), return_date: berlinMidnight(7, 8), created_at: early }),
    stored({ vacation_id: 'v-cancelled', roommate_id: JO, start_date: berlinMidnight(2, 1), return_date: berlinMidnight(2, 8), cancelled_at: early }),
    stored({ vacation_id: 'v-ended', roommate_id: JO, start_date: berlinMidnight(12, 1, 2025), return_date: berlinMidnight(12, 20, 2025) }),
    stored({ vacation_id: 'v-nobody', roommate_id: 'nobody', start_date: berlinMidnight(2, 1), return_date: berlinMidnight(2, 8) }),
    stored({ vacation_id: 'v-bad', roommate_id: JO, start_date: 'next week', return_date: berlinMidnight(2, 8) }),
    stored({ vacation_id: '', roommate_id: JO, start_date: berlinMidnight(3, 2), return_date: berlinMidnight(3, 4), created_at: early }),
  ];
  const spreadsheet = database(rows);
  const before = spreadsheet.snapshot();
  const project = server(spreadsheet);
  const result = list(project);
  assert.equal(result.ok, true);
  assert.equal(spreadsheet.snapshot(), before, 'listing is read-only');
  assert.deepEqual(project.lock.events, []);

  assert.deepEqual(result.vacations.map((v) => v.vacation_id), ['v-sam', null, 'v-far']);
  const sam = result.vacations[0];
  assert.deepEqual([sam.name, sam.state, sam.cancellable], ['Sam Example', 'upcoming', true]);
  assert.equal(Date.parse(sam.start_date), berlinMidnight(1, 9).getTime());
  assert.equal(Date.parse(sam.return_date), berlinMidnight(1, 26).getTime());
  // Weekends of 10-11, 17-18 and 24-25 Jan: Alex, Sam and Jo clean; Sam's own turn is the 17th.
  assert.deepEqual(sam.weekends.map((w) => [w.due_at, w.status]), [
    ['2026-01-11T23:00:00.000Z', 'not_their_turn'],
    ['2026-01-18T23:00:00.000Z', 'skipped'],
    ['2026-01-25T23:00:00.000Z', 'not_their_turn'],
  ]);
  assert.equal(result.vacations[1].cancellable, false, 'a hand-typed row without an ID cannot be cancelled');
  assert.deepEqual(result.vacations[2].weekends.map((w) => w.status), ['later'], 'beyond the 20-turn forecast');
});

test('a vacation that is under way is "away" and cannot be cancelled', () => {
  const spreadsheet = database([stored({ vacation_id: 'v-now', roommate_id: SAM, start_date: berlinMidnight(1, 5), return_date: berlinMidnight(1, 12), created_at: new Date('2026-01-01T10:00:00Z') })]);
  const [vacation] = list(server(spreadsheet)).vacations;
  assert.deepEqual([vacation.state, vacation.cancellable], ['away', false]);
  assert.deepEqual(vacation.weekends.map((w) => w.due_at), ['2026-01-11T23:00:00.000Z'], 'only weekends still ahead are listed');
});

test('a recorded skip is shown as skipped, and the response holds names and dates only', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  save(project, plan());
  schedule(project); // records the skip
  const raw = project.get('listVacations')();
  const result = plain(raw);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'vacations']);
  for (const vacation of result.vacations) {
    assert.deepEqual(Object.keys(vacation).sort(), ['cancellable', 'name', 'return_date', 'roommate_id', 'start_date', 'state', 'vacation_id', 'weekends']);
    for (const weekend of vacation.weekends) assert.deepEqual(Object.keys(weekend).sort(), ['due_at', 'status', 'weekend_starts_at']);
  }
  assert.deepEqual(result.vacations[0].weekends.map((w) => w.status), ['skipped']);
  const json = JSON.stringify(raw);
  for (const roommate of FIXTURES.ROOMMATES) assert.equal(json.includes(roommate.email), false);
  assert.deepEqual(JSON.parse(json), result);
  void ALEX_SLOT;
});

// Environment safeguards and SheetDb.update

test('the environment and time zone safeguards apply to every vacation function', () => {
  const makers = [
    ['DATABASE_ENVIRONMENT_MISMATCH', () => new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'PROD' })],
    ['DATABASE_NOT_SET_UP', () => new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: null })],
    ['TIMEZONE_MISMATCH', () => new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', timeZone: 'America/Los_Angeles' })],
  ];
  for (const [code, make] of makers) {
    const spreadsheet = make();
    const before = spreadsheet.snapshot();
    const project = server(spreadsheet);
    failed(save(project, plan()), code);
    failed(cancel(project, { roommate_id: ALEX, vacation_id: 'v1' }), code);
    failed(list(project), code);
    assert.equal(spreadsheet.snapshot(), before);
  }
});

test('SheetDb.update changes only allowed fields of the right row, and never deletes', () => {
  const spreadsheet = database([stored({ vacation_id: 'a', roommate_id: ALEX }), stored({ vacation_id: 'b', roommate_id: SAM })]);
  const sheet = spreadsheet.getSheetByName('VACATIONS');
  sheet.values.splice(2, 0, []); // a blank row between the two records
  const db = server(spreadsheet).get('SheetDb');
  const before = JSON.stringify(sheet.values);

  for (const changes of [{ vacation_id: 'x' }, { created_at: new Date() }, { phone: '1' }, { cancelled_at: '=1+1' }, { cancelled_at: { a: 1 } }]) {
    assert.throws(() => db.update('VACATIONS', 'b', changes), /cannot be changed|must/);
  }
  assert.throws(() => db.update('VACATIONS', 'missing', { cancelled_at: NOW }), (error) => error.code === 'RECORD_NOT_FOUND');
  assert.equal(JSON.stringify(sheet.values), before, 'rejected updates change nothing');

  db.update('VACATIONS', 'b', { cancelled_at: NOW });
  const rows = table(spreadsheet, 'VACATIONS').filter((row) => row.vacation_id);
  assert.equal(rows.find((row) => row.vacation_id === 'a').cancelled_at, '');
  assert.equal(rows.find((row) => row.vacation_id === 'b').cancelled_at.getTime(), NOW.getTime());
  assert.equal(sheet.values.length, 4, 'no row was removed or added');
  db.update('VACATIONS', 'b', { cancelled_at: '' });
  assert.equal(table(spreadsheet, 'VACATIONS').find((row) => row.vacation_id === 'b').cancelled_at, '');
});
