'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  DEV_SPREADSHEET_ID,
  PROD_SPREADSHEET_ID,
  FIXTURES,
  FakeSpreadsheet,
  fixtureRecords,
  fixtureSheet,
  loadProject,
  plain,
  writableFixture,
} = require('./support/appsScript');

const ROOMMATE_HEADERS = ['roommate_id', 'name', 'email', 'active', 'created_at'];

function devProject(spreadsheets, properties = {}) {
  return loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, ...properties },
    spreadsheets,
  });
}

function setUpSpreadsheet(id, environment) {
  const spreadsheet = new FakeSpreadsheet(id);
  loadProject({ properties: { ENVIRONMENT: environment, SPREADSHEET_ID: id }, spreadsheets: [spreadsheet] }).get('setupDatabase')();
  return spreadsheet;
}

// Missing configuration

test('missing or invalid ENVIRONMENT fails before SPREADSHEET_ID is used', () => {
  for (const environment of [undefined, '', 'dev', 'STAGING']) {
    const properties = { SPREADSHEET_ID: DEV_SPREADSHEET_ID };
    if (environment !== undefined) properties.ENVIRONMENT = environment;
    const project = loadProject({ properties, spreadsheets: [new FakeSpreadsheet(DEV_SPREADSHEET_ID)] });
    assert.throws(() => project.get('SheetDb').list('ROOMMATES'), /Invalid ENVIRONMENT/);
    assert.throws(() => project.get('setupDatabase')(), /Invalid ENVIRONMENT/);
    assert.deepEqual(project.opened, []);
  }
});

test('missing or malformed SPREADSHEET_ID fails without opening a spreadsheet', () => {
  const url = `https://docs.google.com/spreadsheets/d/${DEV_SPREADSHEET_ID}/edit`;
  for (const spreadsheetId of [undefined, '', 'short', url]) {
    const project = loadProject({
      properties: spreadsheetId === undefined ? { ENVIRONMENT: 'DEV' } : { ENVIRONMENT: 'DEV', SPREADSHEET_ID: spreadsheetId },
    });
    assert.throws(() => project.get('SheetDb').list('ROOMMATES'), /Invalid SPREADSHEET_ID/);
    assert.throws(() => project.get('setupDatabase')(), /Invalid SPREADSHEET_ID/);
    assert.throws(() => project.get('diagnoseDatabase')(), /Invalid SPREADSHEET_ID/);
    assert.deepEqual(project.opened, []);
  }
});

test('data access refuses a spreadsheet that has not been set up', () => {
  const project = devProject([new FakeSpreadsheet(DEV_SPREADSHEET_ID)]);
  assert.throws(() => project.get('SheetDb').list('ROOMMATES'), /not set up/);
});

// Environment isolation

test('each project opens only the spreadsheet in its own Script Properties', () => {
  const dev = setUpSpreadsheet(DEV_SPREADSHEET_ID, 'DEV');
  const prod = setUpSpreadsheet(PROD_SPREADSHEET_ID, 'PROD');
  const devApp = devProject([dev, prod]);
  const prodApp = loadProject({ properties: { ENVIRONMENT: 'PROD', SPREADSHEET_ID: PROD_SPREADSHEET_ID }, spreadsheets: [dev, prod] });

  devApp.get('SheetDb').insert('ROOMMATES', { name: 'Dev', email: 'dev@example.com', active: true });
  prodApp.get('SheetDb').insert('ROOMMATES', { name: 'Prod', email: 'prod@example.com', active: true });

  assert.deepEqual(devApp.opened, [DEV_SPREADSHEET_ID]);
  assert.deepEqual(prodApp.opened, [PROD_SPREADSHEET_ID]);
  assert.deepEqual(plain(devApp.get('SheetDb').list('ROOMMATES').map((r) => r.name)), ['Dev']);
  assert.deepEqual(plain(prodApp.get('SheetDb').list('ROOMMATES').map((r) => r.name)), ['Prod']);
});

test('data access refuses a spreadsheet whose time zone differs from the script', () => {
  // Africa/Lagos shares Berlin's winter offset but has no daylight saving time.
  for (const timeZone of ['America/Los_Angeles', 'Etc/UTC', 'Europe/London', 'Africa/Lagos']) {
    const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, {
      marker: 'DEV',
      timeZone,
      sheets: { ROOMMATES: fixtureSheet('ROOMMATES') },
    });
    const before = spreadsheet.snapshot();
    const project = devProject([spreadsheet]);
    const message = new RegExp(`time zone ${timeZone} does not match script time zone Europe/Berlin`);
    assert.throws(() => project.get('SheetDb').list('ROOMMATES'), message);
    assert.throws(() => project.get('SheetDb').insert('ROOMMATES', writableFixture('ROOMMATES')), message);
    assert.equal(spreadsheet.snapshot(), before);

    const report = plain(project.get('diagnoseDatabase')());
    assert.equal(report.ok, false, timeZone);
    assert.equal(report.spreadsheetTimeZone, timeZone);
  }
});

test('Arctic/Longyearbyen is accepted as the IANA link to Europe/Berlin', () => {
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, { timeZone: 'Arctic/Longyearbyen' });
  const project = devProject([spreadsheet]);
  project.get('setupDatabase')();
  const stored = project.get('SheetDb').insert('ROOMMATES', writableFixture('ROOMMATES'));
  assert.equal(project.get('SheetDb').list('ROOMMATES')[0].roommate_id, stored.roommate_id);

  const report = plain(project.get('diagnoseDatabase')());
  assert.equal(report.ok, true);
  assert.equal(report.spreadsheetTimeZone, 'Arctic/Longyearbyen');
  assert.equal(report.scriptTimeZone, 'Europe/Berlin');

  const timeZonesMatch = project.get('timeZonesMatch_');
  assert.equal(timeZonesMatch('Europe/Berlin', 'Arctic/Longyearbyen'), true);
  assert.equal(timeZonesMatch('Arctic/Longyearbyen', 'America/Los_Angeles'), false);
  assert.equal(timeZonesMatch('Europe/Oslo', 'Europe/Berlin'), false);
});

test('DEV configured with the PROD spreadsheet ID refuses to read, write or set up', () => {
  const prod = setUpSpreadsheet(PROD_SPREADSHEET_ID, 'PROD');
  const before = prod.snapshot();
  const devApp = devProject([prod], { SPREADSHEET_ID: PROD_SPREADSHEET_ID });

  assert.throws(() => devApp.get('SheetDb').list('ROOMMATES'), /belongs to PROD, not DEV/);
  assert.throws(
    () => devApp.get('SheetDb').insert('ROOMMATES', { name: 'X', email: 'x@example.com', active: true }),
    /belongs to PROD, not DEV/
  );
  assert.throws(() => devApp.get('setupDatabase')(), /belongs to PROD, not DEV/);
  assert.equal(prod.snapshot(), before);
});

test('diagnoseDatabase is DEV-only and read-only', () => {
  const prod = setUpSpreadsheet(PROD_SPREADSHEET_ID, 'PROD');
  const prodApp = loadProject({ properties: { ENVIRONMENT: 'PROD', SPREADSHEET_ID: PROD_SPREADSHEET_ID }, spreadsheets: [prod] });
  assert.throws(() => prodApp.get('diagnoseDatabase')(), /only available in DEV/);
  assert.deepEqual(prodApp.opened, []);

  const blank = new FakeSpreadsheet(DEV_SPREADSHEET_ID);
  const before = blank.snapshot();
  const report = plain(devProject([blank]).get('diagnoseDatabase')());
  assert.equal(report.ok, false);
  assert.equal(report.environmentMarker, null);
  assert.deepEqual(report.sheets.ROOMMATES, { exists: false });
  assert.equal(blank.snapshot(), before);
});

test('diagnoseDatabase reports a healthy DEV database', () => {
  const report = plain(devProject([setUpSpreadsheet(DEV_SPREADSHEET_ID, 'DEV')]).get('diagnoseDatabase')());
  assert.equal(report.ok, true);
  assert.equal(report.spreadsheetId, DEV_SPREADSHEET_ID);
  assert.equal(report.spreadsheetTimeZone, report.scriptTimeZone);
  assert.deepEqual(report.sheets.ROTATION, { exists: true, rows: 0, missing: [], errors: [] });
});

// Admin entry points

test('admin functions reject web app visitors other than the owner', () => {
  for (const activeUser of ['', 'roommate@example.com']) {
    const project = loadProject({
      properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID },
      spreadsheets: [new FakeSpreadsheet(DEV_SPREADSHEET_ID)],
      activeUser,
    });
    for (const name of ['setupDatabase', 'diagnoseDatabase']) {
      assert.throws(() => project.get(name)(), /only be run by the script owner/, `${name} as ${JSON.stringify(activeUser)}`);
    }
    assert.deepEqual(project.opened, []);
  }
});

test('the web app executes as the deploying owner, which the admin owner check relies on', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'appsscript.json'), 'utf8'));
  assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
});

// Setup

test('setupDatabase creates all sheets with headers and marks the environment', () => {
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID);
  const summary = plain(devProject([spreadsheet]).get('setupDatabase')());
  assert.deepEqual(summary, [
    'ROOMMATES: created',
    'ROTATION: created',
    'CLEANING_LOGS: created',
    'SWAPS: created',
    'VACATIONS: created',
  ]);
  assert.deepEqual(spreadsheet.getSheetByName('ROOMMATES').values, [ROOMMATE_HEADERS]);
  assert.equal(spreadsheet.getSheetByName('SWAPS').frozenRows, 1);
  assert.deepEqual(spreadsheet.metadata, [{ key: 'chorenest_environment', value: 'DEV' }]);
});

test('setupDatabase is repeatable and keeps existing data', () => {
  const spreadsheet = setUpSpreadsheet(DEV_SPREADSHEET_ID, 'DEV');
  const project = devProject([spreadsheet]);
  project.get('SheetDb').insert('ROOMMATES', { name: 'Alex', email: 'alex@example.com', active: true });
  const before = spreadsheet.snapshot();

  const summary = plain(project.get('setupDatabase')());
  assert.ok(summary.every((line) => line.endsWith('unchanged')));
  assert.equal(spreadsheet.snapshot(), before);
});

test('setupDatabase appends missing columns without moving existing data', () => {
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, {
    sheets: { ROOMMATES: [['name', 'roommate_id'], ['Alex', 'm1']] },
  });
  const summary = plain(devProject([spreadsheet]).get('setupDatabase')());
  assert.equal(summary[0], 'ROOMMATES: added email, active, created_at');
  assert.deepEqual(spreadsheet.getSheetByName('ROOMMATES').values, [
    ['name', 'roommate_id', 'email', 'active', 'created_at'],
    ['Alex', 'm1'],
  ]);
});

test('setupDatabase changes nothing if any sheet has an unfixable problem', () => {
  const cases = {
    'unknown column': [['roommate_id', 'nickname']],
    'data in row 1': [['Alex', 'alex@example.com']],
    'data without a header': [['roommate_id'], ['m1', 'stray']],
  };
  for (const [label, values] of Object.entries(cases)) {
    const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, { sheets: { ROOMMATES: values } });
    const before = spreadsheet.snapshot();
    assert.throws(() => devProject([spreadsheet]).get('setupDatabase')(), /made no changes/, label);
    assert.equal(spreadsheet.snapshot(), before, label);
  }
});

// Mapping through SheetDb

test('insert assigns a stable ID and created_at and maps by the sheet header order', () => {
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, {
    marker: 'DEV',
    sheets: { ROOMMATES: [['email', 'created_at', 'active', 'name', 'roommate_id']] },
  });
  const SheetDb = devProject([spreadsheet]).get('SheetDb');

  const stored = SheetDb.insert('ROOMMATES', { name: 'Alex', email: 'alex@example.com', active: true });
  assert.match(stored.roommate_id, /^[0-9a-f-]{36}$/);
  const row = spreadsheet.getSheetByName('ROOMMATES').values[1];
  assert.deepEqual([row[0], row[2], row[3], row[4]], ['alex@example.com', true, 'Alex', stored.roommate_id]);
  assert.equal(Object.prototype.toString.call(row[1]), '[object Date]');

  assert.deepEqual(plain(SheetDb.list('ROOMMATES').map(({ created_at, ...rest }) => rest)), [
    { email: 'alex@example.com', active: true, name: 'Alex', roommate_id: stored.roommate_id },
  ]);
});

test('list maps every fixture sheet by header name, whatever the column order', () => {
  const sheets = Object.fromEntries(
    Object.keys(FIXTURES).map((name) => [name, fixtureSheet(name, Object.keys(FIXTURES[name][0]).reverse())])
  );
  const SheetDb = devProject([new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets })]).get('SheetDb');
  for (const name of Object.keys(FIXTURES)) {
    assert.deepEqual(plain(SheetDb.list(name)), plain(fixtureRecords(name)), name);
  }
});

test('insert rejects invalid records before touching the spreadsheet', () => {
  const project = devProject([]);
  assert.throws(() => project.get('SheetDb').insert('ROOMMATES', { name: 'Alex', phone: '1' }), /unknown field phone/);
  assert.deepEqual(project.opened, []);
});

test('list skips blank rows and rejects sheets with schema problems', () => {
  const spreadsheet = setUpSpreadsheet(DEV_SPREADSHEET_ID, 'DEV');
  spreadsheet.getSheetByName('ROTATION').values.push(['', '', '', ''], ['r1', 1, 'm1', '']);
  const SheetDb = devProject([spreadsheet]).get('SheetDb');
  assert.deepEqual(plain(SheetDb.list('ROTATION')), [{ rotation_id: 'r1', position: 1, roommate_id: 'm1', created_at: '' }]);

  spreadsheet.getSheetByName('SWAPS').values[0].push('notes');
  assert.throws(() => SheetDb.list('SWAPS'), /unknown column: notes/);
});
