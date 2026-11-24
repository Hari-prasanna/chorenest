'use strict';

// Editing a vacation's dates (updateVacation) and returning early (endVacation).

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');
const { asSignedIn } = require('./support/appsScript');

const [ALEX, SAM] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const NOW = new Date('2026-01-07T12:00:00Z'); // Wednesday: Alex's turn (weekend 10-11 Jan) is open; Sam cleans 17-18 Jan
const berlinMidnight = (month, day, year = 2026) => new Date(Date.UTC(year, month - 1, day - 1, 23)); // winter time
const iso = (date) => date.toISOString();
const EARLY = new Date('2026-01-01T10:00:00Z'); // before the rotation started, so the engine knew about it in advance

const rowsFor = (name, records = []) => {
  const headers = fixtureSheet(name)[0];
  return [headers, ...records.map((record) => headers.map((header) => (header in record ? record[header] : '')))];
};
const stored = (overrides = {}) => ({
  vacation_id: 'v-sam',
  roommate_id: SAM,
  start_date: berlinMidnight(1, 20),
  return_date: berlinMidnight(1, 27),
  created_at: EARLY,
  cancelled_at: '',
  ...overrides,
});

function database(vacations = [], logs = []) {
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, {
    marker: 'DEV',
    sheets: {
      ROOMMATES: fixtureSheet('ROOMMATES'),
      ROTATION: fixtureSheet('ROTATION'),
      CLEANING_LOGS: rowsFor('CLEANING_LOGS', logs),
      SWAPS: rowsFor('SWAPS'),
      VACATIONS: rowsFor('VACATIONS', vacations),
    },
  });
}
const server = (spreadsheet, now = NOW, options = {}) =>
  loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now, maintenance: false, ...options });
const call = (project, name, request) => plain(project.get(name)(asSignedIn(project, request)));
const table = (spreadsheet, name) => {
  const [headers, ...rows] = spreadsheet.getSheetByName(name).values;
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]])));
};
const vacationRow = (spreadsheet, id) => table(spreadsheet, 'VACATIONS').find((row) => row.vacation_id === id);
const failed = (result, code) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
};

/** An edit request as the page sends it: the new Berlin dates and the ISO dates it showed. */
const edit = (row, start, back, overrides = {}) => ({
  roommate_id: row.roommate_id,
  vacation_id: row.vacation_id,
  start_date: start,
  return_date: back,
  seen_start: iso(row.start_date),
  seen_return: iso(row.return_date),
  ...overrides,
});
const end = (row, overrides = {}) => ({ roommate_id: row.roommate_id, vacation_id: row.vacation_id, seen_start: iso(row.start_date), seen_return: iso(row.return_date), ...overrides });

// Editing dates

test('an upcoming vacation gets new Berlin dates in place: same ID and creation time, and the rotation follows', () => {
  const row = stored();
  const spreadsheet = database([row]);
  const project = server(spreadsheet);
  const result = call(project, 'updateVacation', edit(row, '2026-01-14', '2026-01-21'));
  assert.deepEqual(result, { ok: true, changed: true });
  assert.deepEqual(project.lock.events, ['lock', 'unlock']);

  const [saved, ...others] = table(spreadsheet, 'VACATIONS');
  assert.equal(others.length, 0, 'no row is added');
  assert.equal(saved.vacation_id, 'v-sam');
  assert.equal(saved.created_at.getTime(), EARLY.getTime());
  assert.equal(saved.start_date.getTime(), berlinMidnight(1, 14).getTime());
  assert.equal(saved.return_date.getTime(), berlinMidnight(1, 21).getTime());
  assert.equal(saved.cancelled_at, '');

  const upcoming = call(project, 'getRotationSchedule').upcoming;
  assert.deepEqual(upcoming[0].skipped.map((p) => p.name), ['Sam Example'], 'Sam is now away on the 17-18 Jan weekend');
  assert.equal(table(spreadsheet, 'CLEANING_LOGS').length, 0, 'no cleaning record is written or changed');
});

test('saving the same dates changes nothing', () => {
  const row = stored();
  const spreadsheet = database([row]);
  const before = spreadsheet.snapshot();
  assert.deepEqual(call(server(spreadsheet), 'updateVacation', edit(row, '2026-01-20', '2026-01-27')), { ok: true, changed: false });
  assert.equal(spreadsheet.snapshot(), before);
});

test('dates are exact across both clock changes', () => {
  // October: away Saturday 24 (summer time), back Tuesday 27 (winter time).
  const october = stored({ start_date: new Date('2026-10-21T22:00:00Z'), return_date: new Date('2026-10-29T23:00:00Z') });
  const autumn = database([october]);
  call(server(autumn, new Date('2026-10-20T12:00:00Z')), 'updateVacation', edit(october, '2026-10-24', '2026-10-27'));
  assert.equal(iso(vacationRow(autumn, 'v-sam').start_date), '2026-10-23T22:00:00.000Z');
  assert.equal(iso(vacationRow(autumn, 'v-sam').return_date), '2026-10-26T23:00:00.000Z');

  // March: away Saturday 27 (winter time), back Tuesday 30 (summer time).
  const march = stored({ start_date: new Date('2027-03-20T23:00:00Z'), return_date: new Date('2027-03-22T23:00:00Z') });
  const spring = database([march]);
  call(server(spring, new Date('2027-03-10T12:00:00Z')), 'updateVacation', edit(march, '2027-03-27', '2027-03-30'));
  assert.equal(iso(vacationRow(spring, 'v-sam').start_date), '2027-03-26T23:00:00.000Z');
  assert.equal(iso(vacationRow(spring, 'v-sam').return_date), '2027-03-29T22:00:00.000Z');
});

test('malformed requests are refused before locking, and bad dates are explained', () => {
  const row = stored();
  const cases = [
    [null, 'INVALID_REQUEST'],
    [edit(row, '2026-01-14', '2026-01-21', { extra: 1 }), 'INVALID_REQUEST'],
    [edit(row, '2026-01-14', '2026-01-21', { seen_start: undefined }), 'INVALID_REQUEST'],
    [edit(row, '2026-01-14', '2026-01-21', { seen_return: '2026-01-27' }), 'INVALID_REQUEST'],
    [edit(row, '2026-01-14', '2026-01-21', { vacation_id: '../x' }), 'INVALID_REQUEST'],
    [edit(row, '2026-01-14', '2026-01-21', { token: 5 }), 'INVALID_REQUEST'],
    [edit(row, '2026-02-30', '2026-03-02'), 'VACATION_DATES_INVALID'],
    [edit(row, '14.01.2026', '2026-01-21'), 'VACATION_DATES_INVALID'],
    [edit(row, '2026-01-14', ''), 'VACATION_DATES_INVALID'],
  ];
  for (const [request, code] of cases) {
    const spreadsheet = database([row]);
    const before = spreadsheet.snapshot();
    const project = server(spreadsheet);
    failed(call(project, 'updateVacation', request), code);
    assert.deepEqual(project.lock.events, [], JSON.stringify(request));
    assert.equal(spreadsheet.snapshot(), before);
  }
});

test('the usual date rules apply to the new dates, checked under the lock', () => {
  const row = stored();
  const other = stored({ vacation_id: 'v-other', start_date: berlinMidnight(2, 10), return_date: berlinMidnight(2, 15) });
  const cases = [
    [edit(row, '2026-01-06', '2026-01-21'), 'VACATION_IN_PAST'],
    [edit(row, '2026-01-21', '2026-01-21'), 'VACATION_ORDER'],
    [edit(row, '2026-01-21', '2026-01-14'), 'VACATION_ORDER'],
    [edit(row, '2026-01-20', '2026-05-21'), 'VACATION_TOO_LONG'],
    [edit(row, '2027-01-09', '2027-01-12'), 'VACATION_TOO_FAR'],
    [edit(row, '2026-01-20', '2026-02-12'), 'VACATION_OVERLAP'],
    [edit(row, '2026-01-20', '2026-01-27', { roommate_id: ALEX }), 'NOT_YOUR_VACATION'],
    [edit(row, '2026-01-20', '2026-01-28', { vacation_id: 'v-unknown' }), 'VACATION_NOT_FOUND'],
  ];
  for (const [request, code] of cases) {
    const spreadsheet = database([row, other]);
    const before = spreadsheet.snapshot();
    const project = server(spreadsheet);
    failed(call(project, 'updateVacation', request), code);
    assert.deepEqual(project.lock.events, ['lock', 'unlock'], code);
    assert.equal(spreadsheet.snapshot(), before, code);
  }
  // Back-to-back with another vacation is fine, and 120 days is the limit.
  assert.equal(call(server(database([row, other])), 'updateVacation', edit(row, '2026-01-20', '2026-02-10')).ok, true);
  assert.equal(call(server(database([row])), 'updateVacation', edit(row, '2026-01-20', '2026-05-20')).ok, true);
});

test('a cancelled or finished vacation cannot be edited', () => {
  failed(call(server(database([stored({ cancelled_at: EARLY })])), 'updateVacation', edit(stored(), '2026-01-14', '2026-01-21')), 'VACATION_NOT_FOUND');
  const over = stored({ start_date: berlinMidnight(1, 1), return_date: berlinMidnight(1, 5) });
  failed(call(server(database([over])), 'updateVacation', edit(over, '2026-01-14', '2026-01-21')), 'VACATION_ENDED');
});

test('a stale page cannot overwrite a newer change: the dates it saw must still be the stored ones', () => {
  const row = stored();
  const spreadsheet = database([row]);
  const project = server(spreadsheet);
  const first = edit(row, '2026-01-14', '2026-01-21');
  const second = edit(row, '2026-02-02', '2026-02-05'); // made from the same, now outdated, page
  assert.equal(call(project, 'updateVacation', first).ok, true);
  const afterFirst = spreadsheet.snapshot();
  failed(call(project, 'updateVacation', second), 'VACATION_CHANGED');
  failed(call(project, 'updateVacation', first), 'VACATION_CHANGED', 'a repeated submit is stale too');
  assert.equal(spreadsheet.snapshot(), afterFirst);
});

test('a vacation that has started keeps its first day away; its first day back can move, but not into the past', () => {
  const away = stored({ start_date: berlinMidnight(1, 5), return_date: berlinMidnight(1, 15) });
  const spreadsheet = database([away]);
  const project = server(spreadsheet);
  failed(call(project, 'updateVacation', edit(away, '2026-01-06', '2026-01-15')), 'VACATION_START_LOCKED');
  failed(call(project, 'updateVacation', edit(away, '2026-01-05', '2026-01-06')), 'VACATION_BACK_IN_PAST');
  assert.deepEqual(call(project, 'updateVacation', edit(away, '2026-01-05', '2026-01-16')), { ok: true, changed: true });
  assert.equal(vacationRow(spreadsheet, 'v-sam').start_date.getTime(), berlinMidnight(1, 5).getTime());
  assert.equal(vacationRow(spreadsheet, 'v-sam').return_date.getTime(), berlinMidnight(1, 16).getTime());
});

test('an edit that would change the current turn is refused as a conflict for the admin', () => {
  // Alex cleans this weekend (10-11 Jan). Moving Alex's planned vacation over it would hand the turn to someone else.
  const alex = stored({ vacation_id: 'v-alex', roommate_id: ALEX });
  const spreadsheet = database([alex]);
  const before = spreadsheet.snapshot();
  const project = server(spreadsheet);
  failed(call(project, 'updateVacation', edit(alex, '2026-01-09', '2026-01-12')), 'VACATION_TURN_CONFLICT');
  assert.equal(spreadsheet.snapshot(), before);
  assert.equal(call(project, 'getRotationSchedule').current.assignee.roommate_id, ALEX, 'the current turn is untouched');
  // A change that leaves this weekend alone is fine.
  assert.equal(call(project, 'updateVacation', edit(alex, '2026-01-12', '2026-01-16')).ok, true);
});

test('a recorded vacation skip is never silently undone: the vacation must keep covering that weekend', () => {
  // Alex adds a vacation over his own open turn, so the next page load records the skip.
  const spreadsheet = database();
  const project = server(spreadsheet);
  const saved = call(project, 'saveVacation', { roommate_id: ALEX, start_date: '2026-01-09', return_date: '2026-01-12' });
  call(project, 'getRotationSchedule');
  const [skip] = table(spreadsheet, 'CLEANING_LOGS');
  assert.equal(skip.outcome, 'vacation_skipped');
  const row = vacationRow(spreadsheet, saved.vacation_id);
  const before = spreadsheet.snapshot();

  failed(call(project, 'updateVacation', edit(row, '2026-01-12', '2026-01-16')), 'VACATION_SKIP_RECORDED');
  failed(call(project, 'updateVacation', edit(row, '2026-01-09', '2026-01-10')), 'VACATION_SKIP_RECORDED');
  assert.equal(spreadsheet.snapshot(), before, 'nothing changed, and the skip log is untouched');

  assert.equal(call(project, 'updateVacation', edit(row, '2026-01-09', '2026-01-14')).ok, true, 'extending it keeps the skip covered');
  assert.deepEqual(table(spreadsheet, 'CLEANING_LOGS'), [skip], 'cleaning records are never rewritten');
});

// Returning early

test('I’m back makes today (Berlin) the first day back, keeps the ID, and the vacation is then over', () => {
  const away = stored({ start_date: berlinMidnight(1, 5), return_date: berlinMidnight(1, 20) });
  const spreadsheet = database([away]);
  const project = server(spreadsheet);
  assert.deepEqual(call(project, 'endVacation', end(away)), { ok: true, changed: true });
  assert.deepEqual(project.lock.events, ['lock', 'unlock']);
  const saved = vacationRow(spreadsheet, 'v-sam');
  assert.equal(saved.start_date.getTime(), berlinMidnight(1, 5).getTime());
  assert.equal(saved.return_date.getTime(), berlinMidnight(1, 7).getTime(), 'Wednesday 7 Jan 00:00 Berlin');
  assert.equal(saved.created_at.getTime(), EARLY.getTime());
  const [listed] = call(project, 'listVacations').vacations;
  assert.equal(listed.state, 'returned');
  assert.deepEqual(call(project, 'getRotationSchedule').upcoming[0].skipped, [], 'Sam cleans the 17-18 Jan weekend again');
  failed(call(project, 'endVacation', end(away)), 'VACATION_CHANGED', 'a second tap from the same page is stale');
});

test('I’m back on the day of the October clock change uses that Berlin midnight', () => {
  const away = stored({ start_date: new Date('2026-10-19T22:00:00Z'), return_date: new Date('2026-11-01T23:00:00Z') });
  const spreadsheet = database([away]);
  call(server(spreadsheet, new Date('2026-10-25T10:00:00Z')), 'endVacation', end(away));
  assert.equal(iso(vacationRow(spreadsheet, 'v-sam').return_date), '2026-10-24T22:00:00.000Z', 'Sunday 25 Oct 00:00, still summer time');
});

test('I’m back is refused for a vacation that has not started, started today, is over, or is someone else’s', () => {
  const cases = [
    [stored(), 'VACATION_NOT_STARTED'],
    [stored({ start_date: berlinMidnight(1, 7), return_date: berlinMidnight(1, 12) }), 'VACATION_JUST_STARTED'],
    [stored({ start_date: berlinMidnight(1, 1), return_date: berlinMidnight(1, 5) }), 'VACATION_ENDED'],
  ];
  for (const [row, code] of cases) {
    const spreadsheet = database([row]);
    const before = spreadsheet.snapshot();
    failed(call(server(spreadsheet), 'endVacation', end(row)), code);
    assert.equal(spreadsheet.snapshot(), before, code);
  }
  const away = stored({ start_date: berlinMidnight(1, 5) });
  failed(call(server(database([away])), 'endVacation', end(away, { roommate_id: ALEX })), 'NOT_YOUR_VACATION');
  failed(call(server(database([away])), 'endVacation', end(away, { seen_return: iso(berlinMidnight(1, 28)) })), 'VACATION_CHANGED');
  failed(call(server(database([away])), 'endVacation', end(away, { start_date: '2026-01-05' })), 'INVALID_REQUEST');
});

test('I’m back that would change the current turn, or uncover a recorded skip, is a conflict for the admin', () => {
  // Alex was known to be away, so Sam took this weekend. Coming back now would hand it back to Alex.
  const known = stored({ vacation_id: 'v-alex', roommate_id: ALEX, start_date: berlinMidnight(1, 5), return_date: berlinMidnight(1, 20) });
  const first = database([known]);
  const project = server(first);
  assert.equal(call(project, 'getRotationSchedule').current.assignee.roommate_id, SAM);
  const before = first.snapshot();
  failed(call(project, 'endVacation', end(known)), 'VACATION_TURN_CONFLICT');
  assert.equal(first.snapshot(), before);

  // Alex added a vacation over his open turn late, and the skip is recorded. Ending it before that weekend would undo it.
  const late = stored({ vacation_id: 'v-late', roommate_id: ALEX, start_date: berlinMidnight(1, 6), return_date: berlinMidnight(1, 14), created_at: new Date('2026-01-06T12:00:00Z') });
  const second = database([late]);
  const app = server(second);
  call(app, 'getRotationSchedule'); // records the skip for 10-11 Jan
  assert.equal(table(second, 'CLEANING_LOGS')[0].notes, 'Skipped for vacation v-late');
  const recorded = second.snapshot();
  failed(call(app, 'endVacation', end(late)), 'VACATION_SKIP_RECORDED');
  assert.equal(second.snapshot(), recorded);
});

test('a busy lock or a failed write changes nothing, hides the cause, and releases the lock', () => {
  const row = stored();
  const busy = database([row]);
  const before = busy.snapshot();
  failed(call(server(busy, NOW, { lock: { events: [], held: false, deny: true } }), 'updateVacation', edit(row, '2026-01-14', '2026-01-21')), 'BUSY');
  assert.equal(busy.snapshot(), before);

  const broken = database([row]);
  broken.getSheetByName('VACATIONS').getRange = () => {
    throw new Error('Service Spreadsheets failed 1AbC-secret');
  };
  const project = server(broken);
  const result = call(project, 'updateVacation', edit(row, '2026-01-14', '2026-01-21'));
  failed(result, 'WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret|Spreadsheets/);
  assert.equal(project.lock.held, false);
});
