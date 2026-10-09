// TEMPORARY: delete together with src/backend/DevSeed.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, PROD_SPREADSHEET_ID, FakeSpreadsheet, loadProject, plain } = require('./support/appsScript');

const NOW = new Date('2026-10-12T12:00:00Z');

/** An empty, set-up DEV database, optionally with extra rows inserted first. */
function devDatabase(prepare = () => {}) {
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID);
  const project = loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now: NOW });
  project.get('setupDatabase')();
  prepare(project.get('SheetDb'));
  return { spreadsheet, project, SheetDb: project.get('SheetDb') };
}

const rotationNames = (SheetDb) => {
  const names = Object.fromEntries(SheetDb.list('ROOMMATES').map((r) => [r.roommate_id, r.name]));
  return plain(SheetDb.list('ROTATION').map((s) => [s.position, names[s.roommate_id]]).sort((a, b) => a[0] - b[0]));
};

test('adds Hari, Jijo and Arun at positions 1-3, and the schedule starts with Hari', () => {
  const { project, SheetDb, spreadsheet } = devDatabase();
  assert.equal(plain(project.get('getRotationSchedule')()).error.code, 'ROTATION_EMPTY');

  const summary = plain(project.get('seedDevRotation')());
  assert.deepEqual(summary, [
    'Hari: added roommate, added position 1',
    'Jijo: added roommate, added position 2',
    'Arun: added roommate, added position 3',
  ]);
  assert.deepEqual(rotationNames(SheetDb), [[1, 'Hari'], [2, 'Jijo'], [3, 'Arun']]);
  assert.ok(SheetDb.list('ROOMMATES').every((r) => r.active === true && r.email.endsWith('@chorenest.invalid')));
  for (const sheet of ['CLEANING_LOGS', 'SWAPS', 'VACATIONS']) assert.equal(spreadsheet.getSheetByName(sheet).values.length, 1, sheet);

  const schedule = plain(project.get('getRotationSchedule')());
  assert.equal(schedule.ok, true);
  assert.equal(schedule.current.assignee.name, 'Hari');
  assert.deepEqual(schedule.upcoming.map((t) => t.assignee.name), ['Jijo', 'Arun', 'Hari']);
});

test('reruns change nothing', () => {
  const { project, spreadsheet } = devDatabase();
  project.get('seedDevRotation')();
  const before = spreadsheet.snapshot();
  assert.deepEqual(plain(project.get('seedDevRotation')()), [
    'Hari: existing roommate, existing position 1',
    'Jijo: existing roommate, existing position 2',
    'Arun: existing roommate, existing position 3',
  ]);
  assert.equal(spreadsheet.snapshot(), before);
});

test('keeps unrelated rows and reuses a seed roommate that already exists', () => {
  let other;
  let hari;
  const { project, SheetDb, spreadsheet } = devDatabase((db) => {
    other = db.insert('ROOMMATES', { name: 'Existing', email: 'existing@example.com', active: true });
    db.insert('ROTATION', { position: 4, roommate_id: other.roommate_id });
    hari = db.insert('ROOMMATES', { name: 'Hari', email: 'hari@chorenest.invalid', active: true });
  });
  const roommateRows = JSON.stringify(spreadsheet.getSheetByName('ROOMMATES').values);
  const rotationRows = JSON.stringify(spreadsheet.getSheetByName('ROTATION').values);

  assert.equal(plain(project.get('seedDevRotation')())[0], 'Hari: existing roommate, added position 1');
  assert.deepEqual(rotationNames(SheetDb), [[1, 'Hari'], [2, 'Jijo'], [3, 'Arun'], [4, 'Existing']]);
  assert.equal(SheetDb.list('ROOMMATES').filter((r) => r.name === 'Hari').length, 1);
  assert.equal(SheetDb.list('ROTATION').find((s) => s.position === 1).roommate_id, hari.roommate_id);
  assert.ok(JSON.stringify(spreadsheet.getSheetByName('ROOMMATES').values).startsWith(roommateRows.slice(0, -1)));
  assert.ok(JSON.stringify(spreadsheet.getSheetByName('ROTATION').values).startsWith(rotationRows.slice(0, -1)));
});

test('writes nothing when a seed position belongs to someone else', () => {
  const { project, spreadsheet } = devDatabase((db) => {
    const other = db.insert('ROOMMATES', { name: 'Existing', email: 'existing@example.com', active: true });
    db.insert('ROTATION', { position: 2, roommate_id: other.roommate_id });
  });
  const before = spreadsheet.snapshot();
  assert.throws(() => project.get('seedDevRotation')(), /position 2 is already used. No changes made/);
  assert.equal(spreadsheet.snapshot(), before);
});

test('writes nothing when a seed email matches more than one roommate', () => {
  const { project, spreadsheet } = devDatabase((db) => {
    db.insert('ROOMMATES', { name: 'Arun', email: 'arun@chorenest.invalid', active: true });
    db.insert('ROOMMATES', { name: 'Arun again', email: 'arun@chorenest.invalid', active: true });
  });
  const before = spreadsheet.snapshot();
  assert.throws(() => project.get('seedDevRotation')(), /More than one roommate has email arun@chorenest.invalid/);
  assert.equal(spreadsheet.snapshot(), before);
});

test('refuses to run in PROD without opening the spreadsheet', () => {
  const project = loadProject({
    properties: { ENVIRONMENT: 'PROD', SPREADSHEET_ID: PROD_SPREADSHEET_ID },
    spreadsheets: [new FakeSpreadsheet(PROD_SPREADSHEET_ID, { marker: 'PROD' })],
  });
  assert.throws(() => project.get('seedDevRotation')(), /only available in DEV/);
  assert.deepEqual(project.opened, []);
});
