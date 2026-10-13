'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FakeSpreadsheet, fixtureSheet, loadProject } = require('./support/appsScript');

// Maintenance gate

const NOW = new Date('2026-10-13T10:00:00Z');
const inMinutes = (minutes) => new Date(NOW.getTime() + minutes * 60 * 1000).toISOString();

function maintenanceProject(until, options = {}) {
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID);
  const properties = { ENVIRONMENT: options.environment || 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID };
  if (until !== undefined) properties.MAINTENANCE_UNTIL = until;
  const project = loadProject({ properties, spreadsheets: [spreadsheet], now: NOW, maintenance: false, ...options });
  return { project, spreadsheet };
}

test('maintenance is closed unless the owner opens a window of at most an hour', () => {
  const closed = [undefined, '', 'soon', 'null', inMinutes(-1), inMinutes(0), inMinutes(61), inMinutes(60 * 24 * 365)];
  for (const until of closed) {
    for (const name of ['setupDatabase_', 'diagnoseDatabase_']) {
      const { project, spreadsheet } = maintenanceProject(until);
      const before = spreadsheet.snapshot();
      assert.throws(() => project.get(name)(), /Maintenance is closed/, `${name} with ${until}`);
      assert.deepEqual(project.opened, [], 'the spreadsheet is never opened while closed');
      assert.equal(spreadsheet.snapshot(), before);
    }
  }
});

test('inside the window the owner can run maintenance, and a stranger still cannot', () => {
  for (const minutes of [1, 30, 60]) {
    const { project, spreadsheet } = maintenanceProject(inMinutes(minutes));
    assert.deepEqual(JSON.parse(JSON.stringify(project.get('setupDatabase_')())).length, 5);
    assert.ok(spreadsheet.getSheetByName('ROOMMATES'));
  }
  for (const activeUser of ['', 'roommate@example.com']) {
    const { project, spreadsheet } = maintenanceProject(inMinutes(30), { activeUser });
    const before = spreadsheet.snapshot();
    for (const name of ['setupDatabase_', 'diagnoseDatabase_']) assert.throws(() => project.get(name)(), /only be run by the script owner/);
    assert.deepEqual(project.opened, []);
    assert.equal(spreadsheet.snapshot(), before);
  }
});

test('diagnoseDatabase stays DEV-only even inside the window', () => {
  const { project } = maintenanceProject(inMinutes(30), { environment: 'PROD' });
  assert.throws(() => project.get('diagnoseDatabase_')(), /only available in DEV/);
});

test('the schedule and cleaning APIs do not depend on the maintenance window', () => {
  const values = Object.fromEntries(['ROOMMATES', 'ROTATION', 'CLEANING_LOGS', 'SWAPS', 'VACATIONS'].map((n) => [n, fixtureSheet(n)]));
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets: values });
  const project = loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID },
    spreadsheets: [spreadsheet],
    now: new Date('2026-01-13T12:00:00Z'),
    maintenance: false,
  });
  assert.equal(JSON.parse(JSON.stringify(project.get('getRotationSchedule')())).ok, true);
  assert.equal(JSON.parse(JSON.stringify(project.get('markCleaned')(null))).error.code, 'INVALID_REQUEST');
});
