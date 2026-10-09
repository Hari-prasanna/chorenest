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

const NOW = new Date('2026-01-13T12:00:00Z');
const SHEETS = Object.keys(FIXTURES);
const NAME = Object.fromEntries(FIXTURES.ROOMMATES.map((r) => [r.roommate_id, r.name]));

/** A set-up spreadsheet holding the fixtures, with any sheet replaced by `sheets`. */
function fixtureSpreadsheet({ id = DEV_SPREADSHEET_ID, marker = 'DEV', sheets = {}, ...options } = {}) {
  const values = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  return new FakeSpreadsheet(id, { marker, sheets: { ...values, ...sheets }, ...options });
}

function devProject(spreadsheet, properties = {}) {
  return loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, ...properties },
    spreadsheets: spreadsheet ? [spreadsheet] : [],
    now: NOW,
  });
}

function schedule(project) {
  return plain(project.get('getRotationSchedule')());
}

function errorCode(project) {
  const result = schedule(project);
  assert.equal(result.ok, false);
  return result.error.code;
}

/** Header-only sheet with `transform` applied to each fixture row, keyed by column. */
function sheetWith(name, transform) {
  const [headers, ...rows] = fixtureSheet(name);
  return [headers, ...rows.map((row) => {
    const record = transform(Object.fromEntries(headers.map((h, i) => [h, row[i]])));
    return headers.map((h) => record[h]);
  })];
}

// Success

test('returns the current turn and the next three, as computed by the rotation engine', () => {
  const project = devProject(fixtureSpreadsheet());
  const result = schedule(project);

  assert.equal(result.ok, true);
  assert.equal(result.environment, 'DEV');
  assert.equal(result.generated_at, NOW.toISOString());
  assert.equal(result.current.owner.name, 'Sam Example');
  assert.equal(result.current.assignee.name, 'Alex Example');
  assert.equal(result.current.swap_id, FIXTURES.SWAPS[0].swap_id);
  assert.equal(result.current.status, 'pending');
  assert.equal(result.current.due_at, '2026-01-18T23:00:00.000Z');
  assert.deepEqual(result.upcoming.map((t) => t.assignee.name), ['Kim Example', 'Alex Example', 'Sam Example']);
  assert.deepEqual(result.upcoming[0].skipped.map((p) => p.name), ['Jo Example']);
  assert.equal(result.upcoming.some((t) => 'status' in t), false);

  // Same answer as calling the engine directly on the fixture records.
  const data = {
    roommates: fixtureRecords('ROOMMATES'),
    rotation: fixtureRecords('ROTATION'),
    logs: fixtureRecords('CLEANING_LOGS'),
    swaps: fixtureRecords('SWAPS'),
    vacations: fixtureRecords('VACATIONS'),
  };
  const engine = plain(project.get('previewTurns_')(data, NOW, 4));
  const ids = (turns) => turns.map((t) => [t.rotation_id, t.owner_id, t.assignee_id, t.swap_id, t.due_at]);
  const api = [result.current, ...result.upcoming].map((t) => [t.rotation_id, t.owner.roommate_id, t.assignee.roommate_id, t.swap_id, t.due_at]);
  assert.deepEqual(api, ids(engine));
});

test('the response is browser-safe: JSON only, ISO dates, names but no emails', () => {
  const raw = devProject(fixtureSpreadsheet()).get('getRotationSchedule')();
  const json = JSON.stringify(raw);
  assert.deepEqual(JSON.parse(json), plain(raw));
  const walk = (value) => {
    assert.notEqual(Object.prototype.toString.call(value), '[object Date]');
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(raw);
  for (const roommate of FIXTURES.ROOMMATES) assert.equal(json.includes(roommate.email), false);
  assert.match(plain(raw).current.opens_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('reads without changing the spreadsheet and opens only this environment\'s spreadsheet, once', () => {
  const dev = fixtureSpreadsheet();
  const prod = fixtureSpreadsheet({ id: PROD_SPREADSHEET_ID, marker: 'PROD' });
  const before = dev.snapshot();
  const project = loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID },
    spreadsheets: [dev, prod],
    now: NOW,
  });
  schedule(project);
  schedule(project);
  assert.equal(dev.snapshot(), before);
  assert.deepEqual(project.opened, [DEV_SPREADSHEET_ID, DEV_SPREADSHEET_ID]);
});

test('PROD reads its own spreadsheet', () => {
  const project = loadProject({
    properties: { ENVIRONMENT: 'PROD', SPREADSHEET_ID: PROD_SPREADSHEET_ID },
    spreadsheets: [fixtureSpreadsheet(), fixtureSpreadsheet({ id: PROD_SPREADSHEET_ID, marker: 'PROD' })],
    now: NOW,
  });
  assert.equal(schedule(project).environment, 'PROD');
  assert.deepEqual(project.opened, [PROD_SPREADSHEET_ID]);
});

// Incomplete configuration

test('invalid configuration is reported as CONFIG_INVALID without opening a spreadsheet', () => {
  for (const properties of [{ ENVIRONMENT: undefined }, { ENVIRONMENT: 'dev' }, { SPREADSHEET_ID: undefined }, { SPREADSHEET_ID: 'not-an-id' }]) {
    const project = loadProject({
      properties: Object.fromEntries(
        Object.entries({ ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, ...properties }).filter(([, v]) => v !== undefined)
      ),
      spreadsheets: [fixtureSpreadsheet()],
      now: NOW,
    });
    assert.equal(errorCode(project), 'CONFIG_INVALID', JSON.stringify(properties));
    assert.deepEqual(project.opened, []);
  }
});

test('a spreadsheet that cannot be opened is SPREADSHEET_UNAVAILABLE', () => {
  assert.equal(errorCode(devProject(null)), 'SPREADSHEET_UNAVAILABLE');
});

test('database safeguards keep their own codes', () => {
  const cases = {
    DATABASE_NOT_SET_UP: fixtureSpreadsheet({ marker: null }),
    DATABASE_ENVIRONMENT_MISMATCH: fixtureSpreadsheet({ marker: 'PROD' }),
    TIMEZONE_MISMATCH: fixtureSpreadsheet({ timeZone: 'America/Los_Angeles' }),
  };
  for (const [code, spreadsheet] of Object.entries(cases)) {
    const before = spreadsheet.snapshot();
    assert.equal(errorCode(devProject(spreadsheet)), code);
    assert.equal(spreadsheet.snapshot(), before);
  }
});

test('a missing sheet or column asks for setupDatabase; other header problems are SCHEMA_INVALID', () => {
  const withoutVacations = fixtureSpreadsheet();
  withoutVacations.sheets.delete('VACATIONS');
  assert.equal(errorCode(devProject(withoutVacations)), 'DATABASE_NOT_SET_UP');

  const [logHeaders, ...logRows] = fixtureSheet('CLEANING_LOGS');
  const keep = logHeaders.map((h, i) => (h === 'outcome' ? -1 : i)).filter((i) => i >= 0);
  const oldLogs = [keep.map((i) => logHeaders[i]), ...logRows.map((row) => keep.map((i) => row[i]))];
  assert.equal(errorCode(devProject(fixtureSpreadsheet({ sheets: { CLEANING_LOGS: oldLogs } }))), 'DATABASE_NOT_SET_UP');

  const [swapHeaders, ...swapRows] = fixtureSheet('SWAPS');
  const oldSwaps = [[...swapHeaders, 'due_date'], ...swapRows.map((row) => [...row, ''])];
  const result = schedule(devProject(fixtureSpreadsheet({ sheets: { SWAPS: oldSwaps } })));
  assert.equal(result.error.code, 'SCHEMA_INVALID');
  assert.match(result.error.message, /unknown column: due_date/);
});

// Empty database and invalid rotation data

test('an empty database is ROTATION_EMPTY', () => {
  const headersOnly = Object.fromEntries(SHEETS.map((name) => [name, [fixtureSheet(name)[0]]]));
  assert.equal(errorCode(devProject(fixtureSpreadsheet({ sheets: headersOnly }))), 'ROTATION_EMPTY');

  const inactive = sheetWith('ROOMMATES', (r) => ({ ...r, active: false }));
  assert.equal(errorCode(devProject(fixtureSpreadsheet({ sheets: { ROOMMATES: inactive } }))), 'ROTATION_EMPTY');
});

test('invalid rotation data is ROTATION_DATA_INVALID with the engine\'s reason', () => {
  const cases = [
    [{ ROTATION: sheetWith('ROTATION', (s) => ({ ...s, position: 1 })) }, /Duplicate rotation position 1/],
    [{ ROTATION: sheetWith('ROTATION', (s) => ({ ...s, position: String(s.position) })) }, /position must be a number/],
    [{ CLEANING_LOGS: sheetWith('CLEANING_LOGS', (l) => ({ ...l, completed_at: '' })) }, /completed_at is required/],
    [{ VACATIONS: sheetWith('VACATIONS', (v) => ({ ...v, return_date: 'next week' })) }, /return_date must be a date/],
  ];
  for (const [sheets, message] of cases) {
    const result = schedule(devProject(fixtureSpreadsheet({ sheets })));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ROTATION_DATA_INVALID');
    assert.match(result.error.message, message);
  }
});

test('unexpected failures are INTERNAL_ERROR without internal details', () => {
  const spreadsheet = fixtureSpreadsheet();
  spreadsheet.getSheetByName('ROTATION').getDataRange = () => {
    throw new Error('Service Spreadsheets failed at row 42 of 1AbC-secret');
  };
  const result = schedule(devProject(spreadsheet));
  assert.deepEqual(result, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Try again later.' } });
});

test('error responses are browser-safe JSON', () => {
  const raw = devProject(fixtureSpreadsheet({ marker: null })).get('getRotationSchedule')();
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), plain(raw));
  assert.deepEqual(Object.keys(raw).sort(), ['error', 'ok']);
});
