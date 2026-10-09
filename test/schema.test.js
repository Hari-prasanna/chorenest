'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURES, loadProject, plain, writableFixture } = require('./support/appsScript');

const project = loadProject();
const validateRecord = project.get('validateRecord_');
const checkHeaders = project.get('checkHeaders_');
const recordToRow = project.get('recordToRow_');
const rowToRecord = project.get('rowToRecord_');
const SCHEMAS = project.get('SCHEMAS');

const roommate = () => writableFixture('ROOMMATES');

test('every schema uses snake_case columns, a stable ID column and created_at', () => {
  for (const [sheetName, schema] of Object.entries(SCHEMAS)) {
    assert.match(sheetName, /^[A-Z_]+$/);
    for (const column of schema.columns) assert.match(column, /^[a-z]+(_[a-z]+)*$/, `${sheetName}.${column}`);
    assert.equal(schema.columns[0], schema.idColumn);
    assert.ok(schema.columns.includes('created_at'));
    for (const field of schema.required) assert.ok(schema.columns.includes(field), `${sheetName}.${field}`);
  }
});

test('fixtures match the schemas and reference each other', () => {
  assert.deepEqual(Object.keys(FIXTURES), plain(Object.keys(SCHEMAS)));
  const ids = new Set();
  for (const [sheetName, records] of Object.entries(FIXTURES)) {
    for (const record of records) {
      assert.deepEqual(Object.keys(record), plain(SCHEMAS[sheetName].columns), sheetName);
      const id = record[SCHEMAS[sheetName].idColumn];
      assert.ok(!ids.has(id), `duplicate fixture ID ${id}`);
      ids.add(id);
    }
  }
  const references = ['roommate_id', 'rotation_id', 'swap_id', 'from_roommate_id', 'to_roommate_id'];
  for (const [sheetName, records] of Object.entries(FIXTURES)) {
    for (const record of records) {
      for (const field of references.filter((f) => f !== SCHEMAS[sheetName].idColumn && record[f])) {
        assert.ok(ids.has(record[field]), `${sheetName}.${field} references a missing fixture`);
      }
    }
  }
});

test('validateRecord accepts every writable fixture, with optional fields omitted', () => {
  for (const sheetName of Object.keys(FIXTURES)) {
    FIXTURES[sheetName].forEach((_, index) => validateRecord(sheetName, writableFixture(sheetName, index)));
  }
  const { swap_id, notes, ...requiredOnly } = writableFixture('CLEANING_LOGS');
  validateRecord('CLEANING_LOGS', requiredOnly);
});

test('validateRecord rejects unknown fields', () => {
  assert.throws(() => validateRecord('ROOMMATES', { ...roommate(), phone: '123' }), /unknown field phone/);
});

test('validateRecord rejects missing or blank required fields', () => {
  const { email, ...withoutEmail } = roommate();
  assert.throws(() => validateRecord('ROOMMATES', withoutEmail), /email is required/);
  assert.throws(() => validateRecord('ROOMMATES', { ...roommate(), name: '' }), /name is required/);
  assert.throws(() => validateRecord('ROOMMATES', { ...roommate(), name: null }), /name is required/);
});

test('validateRecord rejects system-managed fields', () => {
  assert.throws(() => validateRecord('ROOMMATES', { ...roommate(), roommate_id: 'x' }), /roommate_id is set automatically/);
  assert.throws(() => validateRecord('ROOMMATES', { ...roommate(), created_at: new Date() }), /created_at is set automatically/);
});

test('validateRecord rejects non-cell values and formulas', () => {
  assert.throws(() => validateRecord('ROOMMATES', { ...roommate(), name: { first: 'Alex' } }), /must be a string/);
  assert.throws(() => validateRecord('ROOMMATES', { ...roommate(), name: NaN }), /must be a string/);
  assert.throws(() => validateRecord('ROOMMATES', { ...roommate(), name: new Date('nope') }), /must be a string/);
  assert.throws(() => validateRecord('ROOMMATES', { ...roommate(), name: '=IMPORTXML("x")' }), /must not start with "="/);
});

test('validateRecord never lets an unperformed cleaning be recorded as completed', () => {
  const completed = writableFixture('CLEANING_LOGS');
  const unperformed = { ...completed, outcome: 'admin_resolved', completed_at: '', notes: 'Resolved by admin: roommate moved out' };
  validateRecord('CLEANING_LOGS', unperformed);
  validateRecord('CLEANING_LOGS', { ...unperformed, outcome: 'vacation_skipped', notes: 'Away from 2026-01-09' });

  assert.throws(() => validateRecord('CLEANING_LOGS', { ...unperformed, completed_at: completed.completed_at }), /completed_at must be blank/);
  assert.throws(() => validateRecord('CLEANING_LOGS', { ...unperformed, notes: '' }), /notes must give the reason for admin_resolved/);
  assert.throws(() => validateRecord('CLEANING_LOGS', { ...completed, completed_at: '' }), /completed_at is required/);
  assert.throws(() => validateRecord('CLEANING_LOGS', { ...completed, outcome: 'done' }), /outcome must be one of/);
  assert.throws(() => validateRecord('CLEANING_LOGS', { ...completed, outcome: '' }), /outcome is required/);
  assert.throws(() => validateRecord('CLEANING_LOGS', { ...completed, resolved_at: '' }), /resolved_at is required/);
});

test('validateRecord rejects non-objects and unknown sheets', () => {
  assert.throws(() => validateRecord('ROOMMATES', null), /record must be an object/);
  assert.throws(() => validateRecord('ROOMMATES', [roommate()]), /record must be an object/);
  assert.throws(() => validateRecord('CHORES', roommate()), /Unknown sheet: CHORES/);
});

test('checkHeaders reports missing columns separately from unfixable errors', () => {
  assert.deepEqual(plain(checkHeaders('ROTATION', ['rotation_id', 'position', 'roommate_id', 'created_at'])), {
    missing: [],
    errors: [],
  });
  assert.deepEqual(plain(checkHeaders('ROTATION', ['position', 'rotation_id'])), {
    missing: ['roommate_id', 'created_at'],
    errors: [],
  });
  assert.deepEqual(plain(checkHeaders('ROTATION', ['rotation_id', '', 'Position', 'rotation_id'])).errors, [
    'blank header in column 2',
    'unknown column: Position',
    'duplicate column: rotation_id',
  ]);
});

test('row mapping follows the sheet header order, not the schema order', () => {
  const headers = ['email', 'roommate_id', 'active', 'created_at', 'name'];
  const record = { roommate_id: 'm1', name: 'Alex', email: 'alex@example.com', active: false };
  const row = recordToRow(headers, record);
  assert.deepEqual(plain(row), ['alex@example.com', 'm1', false, '', 'Alex']);
  assert.deepEqual(plain(rowToRecord(headers, row)), { ...record, created_at: '' });
});
