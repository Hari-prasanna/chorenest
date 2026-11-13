'use strict';

// diagnoseDatabase_ lists invalid data rows in CLEANING_LOGS and SWAPS, read-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureRecords, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const ALEX = FIXTURES.ROOMMATES[0].roommate_id;
const ALEX_SLOT = FIXTURES.ROTATION[0].rotation_id;
const NOW = new Date('2026-01-13T12:00:00Z');
const ALL_SHEETS = ['ROOMMATES', 'ROTATION', 'CLEANING_LOGS', 'SWAPS', 'VACATIONS'];
const due = (n) => new Date(Date.UTC(2026, 0, 11 + 7 * n, 23)); // Monday 00:00 Berlin after weekend n
let counter = 0;
const uuid = () => `eeeeeeee-eeee-4eee-8eee-${String(++counter).padStart(12, '0')}`;

const headersOf = (name) => fixtureSheet(name)[0];
const toRow = (name, record) => headersOf(name).map((header) => (header in record ? record[header] : ''));

/** A valid log for weekend n, with overrides. */
function log(n, overrides = {}) {
  const [base] = fixtureRecords('CLEANING_LOGS');
  return { ...base, log_id: uuid(), swap_id: '', due_date: due(n), resolved_at: due(n), completed_at: due(n), ...overrides };
}

/** A valid accepted swap between Alex and Sam, with overrides. */
function swap(overrides = {}) {
  return { ...fixtureRecords('SWAPS')[0], swap_id: uuid(), ...overrides };
}

function database({ logs, swaps, rotation, sheets = {} } = {}) {
  const values = Object.fromEntries(ALL_SHEETS.map((name) => [name, fixtureSheet(name)]));
  if (rotation) values.ROTATION = [headersOf('ROTATION'), ...rotation.map((r) => toRow('ROTATION', r))];
  if (logs) values.CLEANING_LOGS = [headersOf('CLEANING_LOGS'), ...logs.map((r) => (Array.isArray(r) ? r : toRow('CLEANING_LOGS', r)))];
  if (swaps) values.SWAPS = [headersOf('SWAPS'), ...swaps.map((r) => toRow('SWAPS', r))];
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets: { ...values, ...sheets } });
}

const project = (spreadsheet) => loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now: NOW });
const diagnose = (spreadsheet) => plain(project(spreadsheet).get('diagnoseDatabase_')());
const scheduleOk = (spreadsheet) => plain(project(spreadsheet).get('getRotationSchedule')()).ok;

// Rows that make the engine throw, and rows that are wrong but harmless to the schedule.
const BAD_LOGS = {
  unknownOutcome: [log(1, { outcome: 'done' }), true, /outcome must be one of/],
  completedWithoutTime: [log(1, { completed_at: '' }), true, /completed_at is required/],
  skippedWithoutNotes: [log(1, { outcome: 'admin_resolved', completed_at: '', notes: '' }), true, /notes must give the reason/],
  dueAsText: [log(1, { due_date: '2026-01-18' }), true, /due_date must be a date/],
  resolvedBlank: [log(1, { resolved_at: '' }), true, /resolved_at must be a date/],
  unknownSlot: [log(1, { rotation_id: 'not-a-slot' }), true, /rotation_id is not in ROTATION/],
  completedAsText: [log(1, { completed_at: 'Saturday' }), false, /completed_at must be a date/],
  noRoommate: [log(1, { roommate_id: '' }), false, /roommate_id is required/],
  unknownRoommate: [log(1, { roommate_id: 'someone-else' }), false, /roommate_id is not in ROOMMATES/],
  unknownSwap: [log(1, { swap_id: 'not-a-swap' }), false, /swap_id is not in SWAPS/],
  duplicateTurn: [log(0, { rotation_id: ALEX_SLOT, due_date: due(0) }), false, /same turn is already resolved in row 2/],
};

const BAD_SWAPS = {
  createdAsText: [swap({ created_at: 'last week' }), true, /created_at must be a date/],
  dueBlank: [swap({ to_due_date: '' }), true, /to_due_date must be a date/],
  pendingDueBlank: [swap({ status: 'pending', to_due_date: '' }), false, /to_due_date is required/],
  statusBlank: [swap({ status: '' }), false, /status is required/],
  sameRoommate: [swap({ to_roommate_id: ALEX }), false, /are the same/],
  unknownRoommate: [swap({ to_roommate_id: 'someone-else', from_due_date: due(5), to_due_date: due(6) }), false, /to_roommate_id is not in ROOMMATES/],
};

test('a healthy database has no invalid rows', () => {
  const report = diagnose(database());
  assert.equal(report.ok, true);
  assert.deepEqual(report.invalidRows, { ROTATION: { count: 0, rows: [] }, CLEANING_LOGS: { count: 0, rows: [] }, SWAPS: { count: 0, rows: [] } });
  assert.deepEqual(Object.keys(report.sheets.CLEANING_LOGS).sort(), ['errors', 'exists', 'missing', 'rows'], 'the sheet summary is unchanged');
});

test('each invalid CLEANING_LOGS row is listed by its sheet row, with its problem and whether it breaks the schedule', () => {
  for (const [name, [row, breaks, problem]] of Object.entries(BAD_LOGS)) {
    const spreadsheet = database({ logs: [fixtureRecords('CLEANING_LOGS')[0], row] });
    const before = spreadsheet.snapshot();
    const report = diagnose(spreadsheet);
    assert.equal(spreadsheet.snapshot(), before, `${name}: read-only`);
    assert.equal(report.ok, false, name);
    assert.equal(report.invalidRows.CLEANING_LOGS.count, 1, name);
    const [found] = report.invalidRows.CLEANING_LOGS.rows;
    assert.equal(found.row, 3, name);
    assert.equal(found.id, row.log_id, name);
    assert.equal(found.breaksSchedule, breaks, name);
    assert.ok(found.problems.some((text) => problem.test(text)), `${name}: ${found.problems}`);
    // The flag matches what the app really does with the row.
    assert.equal(scheduleOk(spreadsheet), !breaks, `${name}: schedule`);
  }
});

test('each invalid SWAPS row is listed the same way', () => {
  for (const [name, [row, breaks, problem]] of Object.entries(BAD_SWAPS)) {
    const spreadsheet = database({ swaps: [fixtureRecords('SWAPS')[0], row] });
    const before = spreadsheet.snapshot();
    const report = diagnose(spreadsheet);
    assert.equal(spreadsheet.snapshot(), before, `${name}: read-only`);
    assert.equal(report.invalidRows.SWAPS.count, 1, name);
    const [found] = report.invalidRows.SWAPS.rows;
    assert.equal(found.row, 3, name);
    assert.equal(found.breaksSchedule, breaks, name);
    assert.ok(found.problems.some((text) => problem.test(text)), `${name}: ${found.problems}`);
    assert.equal(scheduleOk(spreadsheet), !breaks, `${name}: schedule`);
  }
});

test('each invalid ROTATION row is listed the same way; a bad created_at only breaks a rotation with no logs yet', () => {
  const cases = {
    positionAsText: [{ position: '4' }, true, /position must be a number/],
    duplicatePosition: [{ position: 1 }, true, /position 1 is already used in row 2/],
    repeatedRoommate: [{ roommate_id: ALEX }, true, /roommate_id is already in row 2/],
    createdAsText: [{ created_at: 'yesterday' }, false, /created_at must be a date/],
    createdAsTextNoLogs: [{ created_at: 'yesterday' }, true, /created_at must be a date/, { logs: [] }],
    noRotationId: [{ rotation_id: '' }, false, /rotation_id is required/],
    unknownRoommate: [{ roommate_id: 'someone-else' }, false, /roommate_id is not in ROOMMATES/],
  };
  for (const [name, [overrides, breaks, problem, extra = {}]] of Object.entries(cases)) {
    const rotation = fixtureRecords('ROTATION').map((slot, i) => (i === 3 ? { ...slot, ...overrides } : slot));
    const spreadsheet = database({ rotation, ...extra });
    const before = spreadsheet.snapshot();
    const report = diagnose(spreadsheet);
    assert.equal(spreadsheet.snapshot(), before, `${name}: read-only`);
    assert.equal(report.ok, false, name);
    assert.equal(report.invalidRows.ROTATION.count, 1, name);
    const [found] = report.invalidRows.ROTATION.rows;
    assert.equal(found.row, 5, name);
    assert.equal(found.breaksSchedule, breaks, name);
    assert.ok(found.problems.some((text) => problem.test(text)), `${name}: ${found.problems}`);
    assert.equal(scheduleOk(spreadsheet), !breaks, `${name}: schedule`);
  }
});

test('row numbers count blank rows, and rows without an ID are still reported', () => {
  const blank = Array(headersOf('CLEANING_LOGS').length).fill('');
  const spreadsheet = database({ logs: [fixtureRecords('CLEANING_LOGS')[0], blank, blank, log(1, { log_id: '', outcome: 'done' })] });
  const [found] = diagnose(spreadsheet).invalidRows.CLEANING_LOGS.rows;
  assert.equal(found.row, 5);
  assert.equal(found.id, null);
});

test('the list is capped, but the count is complete', () => {
  const logs = Array.from({ length: 60 }, (_, i) => log(i + 1, { outcome: 'done' }));
  const { invalidRows } = diagnose(database({ logs }));
  assert.equal(invalidRows.CLEANING_LOGS.count, 60);
  assert.equal(invalidRows.CLEANING_LOGS.rows.length, 50);
});

test('a sheet with header problems is reported by the schema check and its rows are not checked', () => {
  const extraColumn = fixtureSheet('SWAPS').map((row, i) => [...row, i === 0 ? 'oops' : '']);
  const report = diagnose(database({ sheets: { SWAPS: extraColumn }, logs: [log(1, { swap_id: 'not-a-swap' })] }));
  assert.equal(report.ok, false);
  assert.deepEqual(report.sheets.SWAPS.errors, ['unknown column: oops']);
  assert.equal('SWAPS' in report.invalidRows, false);
  assert.equal(report.invalidRows.CLEANING_LOGS.count, 0, 'without readable SWAPS, swap references are not judged');
});

test('admin_resolved rows written by resolveOverdueTurn are valid', () => {
  const spreadsheet = database({ logs: [], swaps: [] });
  const app = loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, RESOLVE_DUE_DAY: '2026-01-11', RESOLVE_REASON: 'Moved out early' },
    spreadsheets: [spreadsheet],
    now: NOW,
  });
  app.get('resolveOverdueTurn_')();
  const report = plain(app.get('diagnoseDatabase_')());
  assert.equal(report.ok, true, JSON.stringify(report.invalidRows));
  assert.equal(report.sheets.CLEANING_LOGS.rows, 1);
});
