'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEV_SPREADSHEET_ID,
  PROD_SPREADSHEET_ID,
  FIXTURES,
  FakeSpreadsheet,
  fixtureRecords,
  fixtureSheet,
  loadProject,
  plain,
} = require('./support/appsScript');

const ALEX = FIXTURES.ROOMMATES[0].roommate_id;
const SAM = FIXTURES.ROOMMATES[1].roommate_id;
const ALEX_SLOT = FIXTURES.ROTATION[0].rotation_id;
const SAM_SLOT = FIXTURES.ROTATION[1].rotation_id;
const NOW = new Date('2026-01-07T12:00:00.123Z'); // Wednesday: Alex's turn (weekend 10-11 Jan) is open
const due = (n) => Date.UTC(2026, 0, 11 + 7 * n, 23); // Monday 00:00 Berlin after weekend n

const rowsFor = (name, records = []) => {
  const headers = fixtureSheet(name)[0];
  return [headers, ...records.map((record) => headers.map((header) => (header in record ? record[header] : '')))];
};

/** A set-up DEV spreadsheet: roommates and rotation from the fixtures, no history unless `sheets` adds it. */
function database(sheets = {}, { marker = 'DEV', ...options } = {}) {
  const base = { ROOMMATES: fixtureSheet('ROOMMATES'), ROTATION: fixtureSheet('ROTATION') };
  for (const name of ['CLEANING_LOGS', 'SWAPS', 'VACATIONS']) base[name] = rowsFor(name);
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker, sheets: { ...base, ...sheets }, ...options });
}

function server(spreadsheet, { now = NOW, environment = 'DEV', spreadsheetId = DEV_SPREADSHEET_ID, ...options } = {}) {
  return loadProject({ properties: { ENVIRONMENT: environment, SPREADSHEET_ID: spreadsheetId }, spreadsheets: [spreadsheet], now, ...options });
}

const schedule = (project) => plain(project.get('getRotationSchedule')());
const mark = (project, request) => plain(project.get('markCleaned')(request));

/** The request the page would send for the current turn, as shown by getRotationSchedule(). */
function claimFor(project, overrides = {}) {
  const { current } = schedule(project);
  return { roommate_id: current.assignee.roommate_id, rotation_id: current.rotation_id, due_at: current.due_at, ...overrides };
}

/** The CLEANING_LOGS rows as records. */
function logRows(spreadsheet) {
  const [headers, ...rows] = spreadsheet.getSheetByName('CLEANING_LOGS').values;
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]])));
}

const failedWith = (result, code) => {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code, JSON.stringify(result));
  return result;
};

// Normal completion

test('records the actual time, the turn\'s own due date and the outcome, then the rotation moves on', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const others = JSON.stringify(['ROOMMATES', 'ROTATION', 'SWAPS', 'VACATIONS'].map((n) => spreadsheet.getSheetByName(n).values));

  const result = mark(project, claimFor(project));
  assert.deepEqual(result, { ok: true, completed_at: NOW.toISOString() });

  const [row, ...extra] = logRows(spreadsheet);
  assert.equal(extra.length, 0);
  assert.match(row.log_id, /^[0-9a-f-]{36}$/);
  assert.equal(row.rotation_id, ALEX_SLOT);
  assert.equal(row.roommate_id, ALEX);
  assert.equal(row.swap_id, '');
  assert.equal(row.due_date.getTime(), due(0));
  assert.equal(row.outcome, 'completed');
  assert.equal(row.completed_at.getTime(), NOW.getTime());
  assert.equal(row.resolved_at.getTime(), NOW.getTime());
  assert.match(row.notes, /unverified/);
  assert.equal(Object.prototype.toString.call(row.created_at), '[object Date]');
  assert.equal(JSON.stringify(['ROOMMATES', 'ROTATION', 'SWAPS', 'VACATIONS'].map((n) => spreadsheet.getSheetByName(n).values)), others);

  const next = schedule(project).current;
  assert.equal(next.assignee.roommate_id, SAM);
  assert.equal(Date.parse(next.due_at), due(1));
  assert.deepEqual(project.lock.events, ['lock', 'unlock']);
});

test('an overdue turn can still be completed, and the next turn is due on the next weekend', () => {
  const spreadsheet = database();
  const project = server(spreadsheet, { now: new Date('2026-01-20T12:00:00Z') });
  assert.equal(schedule(project).current.status, 'overdue');
  assert.equal(mark(project, claimFor(project)).ok, true);

  const result = mark(project, claimFor(project));
  assert.equal(result.ok, true);
  const rows = logRows(spreadsheet);
  assert.deepEqual(rows.map((r) => r.rotation_id), [ALEX_SLOT, SAM_SLOT]);
  assert.deepEqual(rows.map((r) => r.due_date.getTime()), [due(0), due(2)], 'the second turn is due on the next weekend after the late completion');
});

// Who may complete

test('only the current assignee can complete, whatever the claim says', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const before = spreadsheet.snapshot();
  const claims = [
    { roommate_id: SAM },
    { roommate_id: FIXTURES.ROOMMATES[2].roommate_id },
    { roommate_id: 'admin' },
    { roommate_id: 'not-a-roommate' },
  ];
  for (const claim of claims) {
    failedWith(mark(project, claimFor(project, claim)), 'NOT_YOUR_TURN');
    assert.equal(spreadsheet.snapshot(), before);
  }
  assert.equal(project.lock.held, false);
});

test('there is no way to claim extra rights: unknown fields and malformed requests are rejected before anything runs', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const good = claimFor(project);
  const before = spreadsheet.snapshot();
  const bad = [
    undefined, null, 'x', 7, [], {}, [good],
    { ...good, role: 'admin' }, { ...good, is_admin: true }, { ...good, outcome: 'admin_resolved' }, { ...good, notes: 'x' },
    { ...good, roommate_id: '' }, { ...good, roommate_id: 5 }, { ...good, rotation_id: null }, { ...good, due_at: 'someday' },
    { ...good, due_at: 12345 }, { ...good, roommate_id: 'x'.repeat(101) },
    { roommate_id: good.roommate_id, rotation_id: good.rotation_id },
  ];
  for (const request of bad) failedWith(mark(project, request), 'INVALID_REQUEST');
  assert.equal(spreadsheet.snapshot(), before);
  assert.deepEqual(project.lock.events, [], 'invalid requests never take the lock');
});

// Duplicates and stale turns

test('a duplicate click is rejected, and only one row is ever written', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const request = claimFor(project);
  assert.equal(mark(project, request).ok, true);
  failedWith(mark(project, request), 'ALREADY_RECORDED');
  failedWith(mark(project, request), 'ALREADY_RECORDED');
  assert.equal(logRows(spreadsheet).length, 1);
  assert.deepEqual(project.lock.events, ['lock', 'unlock', 'lock', 'unlock', 'lock', 'unlock']);
});

test('a turn that was already resolved another way cannot be completed either', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const request = claimFor(project);
  const resolved = { log_id: 'x', rotation_id: ALEX_SLOT, roommate_id: ALEX, due_date: new Date(due(0)), outcome: 'admin_resolved', resolved_at: new Date('2026-01-07T09:00:00Z'), notes: 'Resolved by admin' };
  spreadsheet.getSheetByName('CLEANING_LOGS').values = rowsFor('CLEANING_LOGS', [resolved]);
  const before = spreadsheet.snapshot();
  failedWith(mark(project, request), 'ALREADY_RECORDED');
  assert.equal(spreadsheet.snapshot(), before);
});

test('a stale or altered view is rejected: another turn, another date, or a turn that has not opened', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const before = spreadsheet.snapshot();
  const current = claimFor(project);
  failedWith(mark(project, { ...current, rotation_id: SAM_SLOT }), 'STALE_TURN');
  failedWith(mark(project, { ...current, due_at: new Date(due(0) + 24 * 3600000).toISOString() }), 'STALE_TURN');
  failedWith(mark(project, { ...current, due_at: new Date(due(1)).toISOString() }), 'STALE_TURN');
  failedWith(mark(project, { roommate_id: SAM, rotation_id: SAM_SLOT, due_at: new Date(due(1)).toISOString() }), 'STALE_TURN');
  assert.equal(spreadsheet.snapshot(), before);

  // Sam's turn exists but only opens on Monday: the claim is right, the turn is not open.
  const saturday = new Date('2026-01-10T20:00:00Z');
  const done = rowsFor('CLEANING_LOGS', [
    { log_id: 'a', rotation_id: ALEX_SLOT, roommate_id: ALEX, due_date: new Date(due(0)), outcome: 'completed', resolved_at: new Date('2026-01-10T12:00:00Z'), completed_at: new Date('2026-01-10T12:00:00Z') },
  ]);
  const later = server(database({ CLEANING_LOGS: done }), { now: saturday });
  assert.equal(schedule(later).current.status, 'waiting');
  failedWith(mark(later, claimFor(later)), 'TURN_NOT_OPEN');
});

test('the claim is checked against the Sheet as it is now, so a turn that moved on while the page was open is stale', () => {
  const spreadsheet = database();
  const page = server(spreadsheet);
  const request = claimFor(page); // what Alex's page shows
  // Meanwhile the vacation known before the turn opened moves it to someone else.
  const vacation = { vacation_id: 'v', roommate_id: ALEX, start_date: new Date('2026-01-09T00:00:00Z'), return_date: new Date('2026-01-13T00:00:00Z'), created_at: new Date('2026-01-05T09:00:00Z') };
  spreadsheet.getSheetByName('VACATIONS').values = rowsFor('VACATIONS', [vacation]);
  const before = spreadsheet.snapshot();
  failedWith(mark(page, request), 'STALE_TURN');
  assert.equal(spreadsheet.snapshot(), before);
});

// Swaps

test('a swapped turn is completed by the partner, keeps its swap_id, and the owner cannot complete it', () => {
  const values = Object.fromEntries(Object.keys(FIXTURES).map((name) => [name, fixtureSheet(name)]));
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets: values });
  const project = server(spreadsheet, { now: new Date('2026-01-13T12:00:00Z') });
  const { current } = schedule(project);
  assert.equal(current.owner.roommate_id, SAM);
  assert.equal(current.assignee.roommate_id, ALEX);

  failedWith(mark(project, claimFor(project, { roommate_id: SAM })), 'NOT_YOUR_TURN');
  assert.equal(mark(project, claimFor(project)).ok, true);

  const rows = logRows(spreadsheet);
  const added = rows[rows.length - 1];
  assert.equal(added.roommate_id, ALEX);
  assert.equal(added.rotation_id, SAM_SLOT);
  assert.equal(added.swap_id, FIXTURES.SWAPS[0].swap_id);
  assert.equal(added.due_date.getTime(), due(1));

  const next = schedule(project);
  assert.equal(next.current.assignee.name, 'Kim Example');
  assert.deepEqual(next.current.skipped.map((p) => p.name), ['Jo Example']);
  failedWith(mark(project, claimFor(project, { roommate_id: ALEX })), 'NOT_YOUR_TURN');
});

// Dates

test('the recorded due date is always the turn\'s own deadline, however early or late the cleaning, and the next turn stays on a weekend', () => {
  const cases = [
    ['early (Saturday)', '2026-01-10T12:00:00.500Z', due(1)],
    ['late (a few days)', '2026-01-14T12:00:00Z', due(1)],
    ['very late (five weeks)', '2026-02-11T12:00:00Z', Date.UTC(2026, 1, 15, 23)],
  ];
  for (const [label, nowIso, nextDue] of cases) {
    const spreadsheet = database();
    const project = server(spreadsheet, { now: new Date(nowIso) });
    assert.equal(mark(project, claimFor(project)).ok, true, label);
    const [row] = logRows(spreadsheet);
    assert.equal(row.due_date.getTime(), due(0), label);
    assert.equal(row.completed_at.getTime(), Date.parse(nowIso), label);
    assert.equal(row.resolved_at.getTime(), Date.parse(nowIso), label);
    assert.equal(Date.parse(schedule(project).current.due_at), nextDue, label);
  }
});

test('the due date is correct across the clock change in March', () => {
  const rotation = fixtureRecords('ROTATION').map((slot) => ({ ...slot, created_at: new Date('2026-03-25T09:00:00Z') }));
  const spreadsheet = database({ ROTATION: rowsFor('ROTATION', rotation) });
  const project = server(spreadsheet, { now: new Date('2026-03-27T12:00:00Z') });
  assert.equal(mark(project, claimFor(project)).ok, true);
  assert.equal(logRows(spreadsheet)[0].due_date.getTime(), Date.UTC(2026, 2, 29, 22), 'Monday 00:00 CEST');
});

// Failed writes and concurrency

test('a failed write records nothing, hides the cause, releases the lock, and can be retried', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const sheet = spreadsheet.getSheetByName('CLEANING_LOGS');
  const appendRow = sheet.appendRow.bind(sheet);
  sheet.appendRow = () => {
    throw new Error('Service Spreadsheets failed at row 9 of 1AbC-secret');
  };
  const before = spreadsheet.snapshot();

  const failed = failedWith(mark(project, claimFor(project)), 'WRITE_FAILED');
  assert.match(failed.error.message, /Nothing was recorded/);
  assert.doesNotMatch(JSON.stringify(failed), /secret|row 9|Spreadsheets failed/);
  assert.equal(spreadsheet.snapshot(), before);
  assert.deepEqual(project.lock.events, ['lock', 'unlock']);

  sheet.appendRow = appendRow;
  assert.equal(mark(project, claimFor(project)).ok, true);
  assert.equal(logRows(spreadsheet).length, 1);
});

test('unexpected failures are a generic error, and nothing is written when the database cannot be read', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  spreadsheet.getSheetByName('ROTATION').getDataRange = () => {
    throw new Error('internal detail 1AbC-secret');
  };
  const result = failedWith(mark(project, claimFor(server(database()))), 'INTERNAL_ERROR');
  assert.deepEqual(result, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Try again later.' } });
  assert.equal(logRows(spreadsheet).length, 0);
  assert.equal(project.lock.held, false);
});

test('while another save holds the lock the call is refused without reading or writing', () => {
  const spreadsheet = database();
  const lock = { events: [], held: false, deny: true };
  const project = server(spreadsheet, { lock });
  const request = claimFor(server(database()));
  const before = spreadsheet.snapshot();
  failedWith(mark(project, request), 'BUSY');
  assert.equal(spreadsheet.snapshot(), before);
  assert.deepEqual(project.opened, [], 'the spreadsheet is not even opened');
  assert.deepEqual(lock.events, ['lock-denied']);
});

test('two saves racing for the same turn: one wins, the other waits out and sees it done', () => {
  const spreadsheet = database();
  const lock = { events: [], held: false, deny: false };
  const first = server(spreadsheet, { lock });
  const second = server(spreadsheet, { lock });
  const request = claimFor(first);

  // The second request arrives while the first is in the middle of writing.
  const sheet = spreadsheet.getSheetByName('CLEANING_LOGS');
  const appendRow = sheet.appendRow.bind(sheet);
  let duringWrite;
  sheet.appendRow = (row) => {
    duringWrite = mark(second, request);
    appendRow(row);
  };

  assert.equal(mark(first, request).ok, true);
  failedWith(duringWrite, 'BUSY');
  failedWith(mark(second, request), 'ALREADY_RECORDED');
  assert.equal(logRows(spreadsheet).length, 1);
  assert.deepEqual(lock.events, ['lock', 'lock-denied', 'unlock', 'lock', 'unlock']);
});

test('the turn is read and checked while the lock is held', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  for (const sheet of spreadsheet.sheets.values()) {
    const getDataRange = sheet.getDataRange.bind(sheet);
    const appendRow = sheet.appendRow.bind(sheet);
    sheet.getDataRange = () => (project.lock.events.push('read'), getDataRange());
    sheet.appendRow = (row) => (project.lock.events.push('write'), appendRow(row));
  }
  const request = claimFor(server(database()));
  assert.equal(mark(project, request).ok, true);
  assert.match(project.lock.events.join(' '), /^lock( read)+ write unlock$/);
});

// Environment safeguards

test('the environment and time zone safeguards still apply to writes', () => {
  const cases = [
    ['CONFIG_INVALID', { environment: 'staging' }, database()],
    ['DATABASE_ENVIRONMENT_MISMATCH', { environment: 'PROD' }, database()],
    ['TIMEZONE_MISMATCH', {}, database({}, { timeZone: 'America/Los_Angeles' })],
    ['DATABASE_NOT_SET_UP', {}, database({}, { marker: null })],
  ];
  const request = claimFor(server(database()));
  for (const [code, options, spreadsheet] of cases) {
    const before = spreadsheet.snapshot();
    failedWith(mark(server(spreadsheet, options), request), code);
    assert.equal(spreadsheet.snapshot(), before, code);
  }
  const prod = new FakeSpreadsheet(PROD_SPREADSHEET_ID, { marker: 'PROD' });
  const wrongSheet = server(database(), { environment: 'PROD', spreadsheetId: DEV_SPREADSHEET_ID });
  failedWith(mark(wrongSheet, request), 'DATABASE_ENVIRONMENT_MISMATCH');
  assert.equal(prod.snapshot(), new FakeSpreadsheet(PROD_SPREADSHEET_ID, { marker: 'PROD' }).snapshot());
});

test('the response is browser-safe JSON with nothing but the outcome', () => {
  const project = server(database());
  const raw = project.get('markCleaned')(claimFor(project));
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), plain(raw));
  assert.deepEqual(Object.keys(raw).sort(), ['completed_at', 'ok']);
  const failure = project.get('markCleaned')(null);
  assert.deepEqual(Object.keys(failure).sort(), ['error', 'ok']);
});
