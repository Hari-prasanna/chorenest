'use strict';

// Owner-only resolution of an overdue turn (resolveOverdueTurn_), run from the Apps Script editor.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, PROD_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const ALEX = FIXTURES.ROOMMATES[0].roommate_id;
const SAM = FIXTURES.ROOMMATES[1].roommate_id;
const ALEX_SLOT = FIXTURES.ROTATION[0].rotation_id;
const SWAP_ID = FIXTURES.SWAPS[0].swap_id;
const OVERDUE = new Date('2026-01-13T12:00:00Z'); // Tuesday: Alex's turn (weekend 10-11 Jan) ended on Sunday
const PENDING = new Date('2026-01-07T12:00:00Z'); // Wednesday before that weekend
const ALEX_LAST_DAY = '2026-01-11';
const due = (n) => Date.UTC(2026, 0, 11 + 7 * n, 23); // Monday 00:00 Berlin after weekend n

const rowsFor = (name, records = []) => {
  const headers = fixtureSheet(name)[0];
  return [headers, ...records.map((record) => headers.map((header) => (header in record ? record[header] : '')))];
};

/** Roommates and rotation from the fixtures, no history unless `sheets` adds it. */
function database(sheets = {}, { marker = 'DEV', id = DEV_SPREADSHEET_ID } = {}) {
  const base = { ROOMMATES: fixtureSheet('ROOMMATES'), ROTATION: fixtureSheet('ROTATION') };
  for (const name of ['CLEANING_LOGS', 'SWAPS', 'VACATIONS']) base[name] = rowsFor(name);
  return new FakeSpreadsheet(id, { marker, sheets: { ...base, ...sheets } });
}

function editor(spreadsheet, { now = OVERDUE, day = ALEX_LAST_DAY, reason = 'Away sick, agreed in the group chat', properties = {}, ...options } = {}) {
  const props = { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, ...properties };
  if (day !== null) props.RESOLVE_DUE_DAY = day;
  if (reason !== null) props.RESOLVE_REASON = reason;
  return loadProject({ properties: props, spreadsheets: [spreadsheet], now, ...options });
}

const resolve = (project) => project.get('resolveOverdueTurn_')();
const withCode = (code) => (error) => error.code === code;

function logRows(spreadsheet) {
  const [headers, ...rows] = spreadsheet.getSheetByName('CLEANING_LOGS').values;
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]])));
}

test('records admin_resolved for the overdue turn with the reason, and the rotation moves on as after a completion', () => {
  const spreadsheet = database();
  const others = JSON.stringify(['ROOMMATES', 'ROTATION', 'SWAPS', 'VACATIONS'].map((n) => spreadsheet.getSheetByName(n).values));
  const project = editor(spreadsheet);
  assert.equal(plain(project.get('getRotationSchedule')()).current.status, 'overdue');

  const summary = resolve(project);
  assert.match(summary, /Resolved the overdue turn of Alex Example \(last day 2026-01-11\) as admin_resolved/);
  assert.deepEqual(project.lock.events, ['lock', 'unlock']);

  const [row, ...extra] = logRows(spreadsheet);
  assert.equal(extra.length, 0);
  assert.match(row.log_id, /^[0-9a-f-]{36}$/);
  assert.equal(row.rotation_id, ALEX_SLOT);
  assert.equal(row.roommate_id, ALEX);
  assert.equal(row.swap_id, '');
  assert.equal(row.due_date.getTime(), due(0));
  assert.equal(row.outcome, 'admin_resolved');
  assert.equal(row.resolved_at.getTime(), OVERDUE.getTime());
  assert.equal(row.completed_at, '', 'nobody cleaned, so there is no completion time');
  assert.equal(row.notes, 'Resolved by the owner: Away sick, agreed in the group chat');
  assert.equal(JSON.stringify(['ROOMMATES', 'ROTATION', 'SWAPS', 'VACATIONS'].map((n) => spreadsheet.getSheetByName(n).values)), others);

  const { current } = plain(project.get('getRotationSchedule')());
  assert.equal(current.assignee.roommate_id, SAM);
  assert.equal(current.status, 'pending');
  assert.equal(Date.parse(current.due_at), due(1), 'the resolved weekend is used up, like a completion');

  assert.equal(project.properties.RESOLVE_REASON, 'Away sick, agreed in the group chat', 'Script Properties are left for the owner to delete');
  assert.equal(project.properties.RESOLVE_DUE_DAY, ALEX_LAST_DAY);
});

test('running it again closes nothing else: the next turn is not overdue', () => {
  const spreadsheet = database();
  const project = editor(spreadsheet);
  resolve(project);
  assert.throws(() => resolve(project), withCode('TURN_NOT_OVERDUE'));
  assert.equal(logRows(spreadsheet).length, 1);
  assert.equal(project.lock.held, false);
});

test('a turn that is not overdue, or a day that does not match the overdue turn, is refused without writing', () => {
  for (const [now, day, code] of [
    [PENDING, ALEX_LAST_DAY, 'TURN_NOT_OVERDUE'],
    [OVERDUE, '2026-01-04', 'RESOLVE_MISMATCH'],
    [OVERDUE, '2026-01-18', 'RESOLVE_MISMATCH'],
    [OVERDUE, '2026-01-12', 'RESOLVE_MISMATCH'], // the exclusive Monday boundary is not the last day
  ]) {
    const spreadsheet = database();
    const before = spreadsheet.snapshot();
    const project = editor(spreadsheet, { now, day });
    assert.throws(() => resolve(project), withCode(code), `${now.toISOString()} ${day}`);
    assert.equal(spreadsheet.snapshot(), before);
    assert.equal(project.lock.held, false);
  }
});

test('the day and a reason are required and checked before anything is opened or locked', () => {
  const cases = [
    { day: null },
    { reason: null },
    { reason: '   ' },
    { reason: '!!! ???' },
    { reason: 'x'.repeat(301) },
    { day: '' },
    { day: '11.01.2026' },
    { day: '2026-02-30' },
    { day: '2026-1-11' },
  ];
  for (const overrides of cases) {
    const spreadsheet = database();
    const project = editor(spreadsheet, overrides);
    assert.throws(() => resolve(project), withCode('RESOLVE_INVALID'), JSON.stringify(overrides));
    assert.deepEqual(project.opened, []);
    assert.deepEqual(project.lock.events, []);
  }
  // 300 characters, with line breaks folded into spaces, is fine.
  const spreadsheet = database();
  resolve(editor(spreadsheet, { reason: '  Away\nsick  ' + 'x'.repeat(290) }));
  assert.equal(logRows(spreadsheet)[0].notes, 'Resolved by the owner: Away sick ' + 'x'.repeat(290));
});

test('a reason that looks like a formula is stored as text', () => {
  const spreadsheet = database();
  resolve(editor(spreadsheet, { reason: '=HYPERLINK("http://example.com")' }));
  assert.equal(logRows(spreadsheet)[0].notes, 'Resolved by the owner: =HYPERLINK("http://example.com")');
});

test('only the owner, inside the maintenance window, can resolve a turn', () => {
  for (const [options, pattern] of [
    [{ maintenance: false }, /Maintenance is closed/],
    [{ activeUser: '' }, /only be run by the script owner/],
    [{ activeUser: 'roommate@example.com' }, /only be run by the script owner/],
  ]) {
    const spreadsheet = database();
    const before = spreadsheet.snapshot();
    const project = editor(spreadsheet, options);
    assert.throws(() => resolve(project), pattern);
    assert.throws(() => project.get('resolveOverdueTurn')(), pattern, 'the editor wrapper is guarded the same way');
    assert.deepEqual(project.opened, []);
    assert.equal(spreadsheet.snapshot(), before);
  }
});

test('a swapped turn is resolved for the partner who covers it, keeping the swap id', () => {
  const spreadsheet = database({ SWAPS: fixtureSheet('SWAPS') });
  resolve(editor(spreadsheet));
  const [row] = logRows(spreadsheet);
  assert.equal(row.rotation_id, ALEX_SLOT);
  assert.equal(row.roommate_id, SAM);
  assert.equal(row.swap_id, SWAP_ID);
});

test('a turn that a vacation skips automatically is left to the vacation skip', () => {
  const vacation = {
    vacation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    roommate_id: ALEX,
    start_date: new Date('2026-01-12T23:00:00Z'),
    return_date: new Date('2026-01-20T23:00:00Z'),
    created_at: new Date('2026-01-12T10:00:00Z'),
    cancelled_at: '',
  };
  const spreadsheet = database({ VACATIONS: rowsFor('VACATIONS', [vacation]) });
  const before = spreadsheet.snapshot();
  assert.throws(() => resolve(editor(spreadsheet)), withCode('RESOLVE_MISMATCH'));
  assert.equal(spreadsheet.snapshot(), before);
});

test('a busy lock writes nothing', () => {
  const spreadsheet = database();
  const before = spreadsheet.snapshot();
  const project = editor(spreadsheet, { lock: { events: [], held: false, deny: true } });
  assert.throws(() => resolve(project), withCode('BUSY'));
  assert.equal(spreadsheet.snapshot(), before);
});

test('DEV/PROD isolation applies: DEV cannot resolve a turn in the PROD spreadsheet', () => {
  const prod = database({}, { marker: 'PROD', id: PROD_SPREADSHEET_ID });
  const before = prod.snapshot();
  const project = editor(prod, { properties: { SPREADSHEET_ID: PROD_SPREADSHEET_ID } });
  assert.throws(() => resolve(project), /belongs to PROD, not DEV/);
  assert.equal(prod.snapshot(), before);
  assert.equal(project.lock.held, false);
});
