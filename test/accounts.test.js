'use strict';

// Owner-only account provisioning (src/backend/Accounts.js): create an account for an existing roommate, reset a
// password, and the one-time temporary-password hand-over.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { DEV_SPREADSHEET_ID, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');
const tempPassword = require('../scripts/temp-password');

const ROOT = path.join(__dirname, '..');
const SECRET = crypto.randomBytes(32).toString('base64url');
const PEPPER = crypto.randomBytes(32).toString('base64url');
const NOW = new Date('2026-12-01T10:00:00Z');
const ALEX_ID = '11111111-1111-4111-8111-111111111111';
const SHEETS = ['ROOMMATES', 'ROTATION', 'CLEANING_LOGS', 'SWAPS', 'VACATIONS'];

const AUTH_COLUMNS = ['username', 'role', 'password_hash', 'must_change_password', 'session_version', 'failed_logins', 'locked_until', 'password_expires_at'];

/** The fixtures, with every roommate's account fields blank (nobody has an account yet). */
function database(edit = () => {}) {
  const sheets = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  const headers = sheets.ROOMMATES[0];
  sheets.ROOMMATES = [headers, ...sheets.ROOMMATES.slice(1).map((row) => row.map((value, i) => (AUTH_COLUMNS.includes(headers[i]) ? '' : value)))];
  edit(sheets.ROOMMATES);
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets });
}

function owner(spreadsheet, request = {}, options = {}) {
  const project = loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, SESSION_SECRET: SECRET, PASSWORD_PEPPER: PEPPER, ...request },
    spreadsheets: [spreadsheet],
    now: NOW,
    ...options,
  });
  project.get('AUTH_SETTINGS').iterations = 10000;
  return project;
}

const run = (project, name) => {
  try {
    return { ok: true, summary: project.get(name)() };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
};
const row = (project, id = ALEX_ID) => project.get('SheetDb').list('ROOMMATES').find((r) => r.roommate_id === id);
const otherSheets = (spreadsheet) => JSON.stringify(SHEETS.slice(1).map((name) => spreadsheet.getSheetByName(name).values));

test('createAccount gives an existing roommate an account, adds no roommate, and stores only a hash', () => {
  const spreadsheet = database();
  const temporary = tempPassword.temporaryPassword();
  const before = { others: otherSheets(spreadsheet), roommates: spreadsheet.getSheetByName('ROOMMATES').values.length, ids: plain(owner(spreadsheet).get('SheetDb').list('ROOMMATES').map((r) => r.roommate_id)) };
  const project = owner(spreadsheet, { ACCOUNT_MEMBER_CODE: ' alx-001 ', ACCOUNT_USERNAME: ' Alex ', ACCOUNT_ROLE: 'admin', ACCOUNT_TEMP_PASSWORD: ` ${temporary} ` });

  const result = run(project, 'createAccount');
  assert.equal(result.ok, true, result.message);
  assert.equal(result.summary, 'Created the ADMIN account "alex" for ALX-001 (Alex Example). Give them the temporary password in person; they must change it at the first sign-in, within 72 hours.');
  const alex = row(project);
  assert.deepEqual({ ...plain(alex), password_hash: undefined, created_at: undefined }, {
    ...plain(alex), password_hash: undefined, created_at: undefined,
    username: 'alex', role: 'ADMIN', must_change_password: true, session_version: 1, failed_logins: 0, locked_until: '',
  });
  assert.equal(project.get('verifyPassword_')(temporary, alex.password_hash), true);

  assert.equal(spreadsheet.getSheetByName('ROOMMATES').values.length, before.roommates, 'no roommate row added');
  assert.deepEqual(plain(project.get('SheetDb').list('ROOMMATES').map((r) => r.roommate_id)), before.ids, 'IDs unchanged');
  assert.equal(otherSheets(spreadsheet), before.others, 'rotation, logs, swaps and vacations untouched');
  for (const key of ['ACCOUNT_MEMBER_CODE', 'ACCOUNT_USERNAME', 'ACCOUNT_ROLE', 'ACCOUNT_TEMP_PASSWORD']) assert.equal(key in project.properties, false, key);
  assert.ok(!spreadsheet.snapshot().includes(temporary) && !JSON.stringify(project.properties).includes(temporary), 'no plaintext anywhere');

  // The temporary password signs in, but only to change it.
  const session = project.get('signInWithPassword_')('alex', temporary);
  assert.equal(session.mustChangePassword, true);
  assert.equal(session.role, 'ADMIN');
});

test('the role defaults to ROOMMATE', () => {
  const project = owner(database(), { ACCOUNT_MEMBER_CODE: 'SMA-002', ACCOUNT_USERNAME: 'sam', ACCOUNT_TEMP_PASSWORD: tempPassword.temporaryPassword() });
  assert.equal(run(project, 'createAccount').ok, true);
  assert.equal(row(project, '22222222-2222-4222-8222-222222222222').role, 'ROOMMATE');
});

test('bad requests change nothing in the Sheet, and the temporary password is always consumed', () => {
  const withAccounts = (values) => {
    const headers = values[0];
    values[2][headers.indexOf('username')] = 'sam';
    values[2][headers.indexOf('role')] = 'ROOMMATE';
    values[3][headers.indexOf('active')] = false;
  };
  const good = { ACCOUNT_MEMBER_CODE: 'ALX-001', ACCOUNT_USERNAME: 'alex', ACCOUNT_ROLE: 'ROOMMATE' };
  const cases = [
    ['unknown member code', { ...good, ACCOUNT_MEMBER_CODE: 'ZZZ-999' }, 'ACCOUNT_INVALID'],
    ['malformed member code', { ...good, ACCOUNT_MEMBER_CODE: 'alex' }, 'ACCOUNT_INVALID'],
    ['deactivated roommate', { ...good, ACCOUNT_MEMBER_CODE: 'JOX-003', ACCOUNT_USERNAME: 'jo' }, 'ACCOUNT_INVALID'],
    ['already has an account', { ...good, ACCOUNT_MEMBER_CODE: 'SMA-002', ACCOUNT_USERNAME: 'sammy' }, 'ACCOUNT_EXISTS'],
    ['username taken', { ...good, ACCOUNT_USERNAME: 'SAM' }, 'USERNAME_TAKEN'],
    ['bad username', { ...good, ACCOUNT_USERNAME: '1x' }, 'ACCOUNT_INVALID'],
    ['bad role', { ...good, ACCOUNT_ROLE: 'OWNER' }, 'ACCOUNT_INVALID'],
    ['no temporary password', { ...good, ACCOUNT_TEMP_PASSWORD: '' }, 'ACCOUNT_INVALID'],
    ['self-made weak password', { ...good, ACCOUNT_TEMP_PASSWORD: 'password12345678' }, 'ACCOUNT_INVALID'],
    ['too short', { ...good, ACCOUNT_TEMP_PASSWORD: 'abcdefgh2345' }, 'ACCOUNT_INVALID'],
    ['repeated character', { ...good, ACCOUNT_TEMP_PASSWORD: 'aaaaaaaaaaaaaaaa' }, 'ACCOUNT_INVALID'],
  ];
  for (const [label, request, code] of cases) {
    const spreadsheet = database(withAccounts);
    const before = spreadsheet.snapshot();
    const temporary = 'ACCOUNT_TEMP_PASSWORD' in request ? request.ACCOUNT_TEMP_PASSWORD : tempPassword.temporaryPassword();
    const project = owner(spreadsheet, { ...request, ACCOUNT_TEMP_PASSWORD: temporary });
    const result = run(project, 'createAccount');
    assert.equal(result.code, code, label);
    assert.match(result.message, /Nothing was changed/, label);
    if (temporary) assert.ok(!result.message.includes(temporary), `${label}: the password is never echoed`);
    assert.equal(spreadsheet.snapshot(), before, label);
    assert.equal('ACCOUNT_TEMP_PASSWORD' in project.properties, false, `${label}: consumed`);
  }
});

test('resetAccountPassword revokes every session, clears a lock and forces a change; it needs an existing account', () => {
  const spreadsheet = database();
  const first = tempPassword.temporaryPassword();
  const created = owner(spreadsheet, { ACCOUNT_MEMBER_CODE: 'ALX-001', ACCOUNT_USERNAME: 'alex', ACCOUNT_TEMP_PASSWORD: first });
  assert.equal(run(created, 'createAccount').ok, true);
  const oldToken = created.get('signInWithPassword_')('alex', first).token;
  created.get('SheetDb').update('ROOMMATES', ALEX_ID, { failed_logins: 0, locked_until: new Date(NOW.getTime() + 600000) });

  const second = tempPassword.temporaryPassword();
  const reset = owner(spreadsheet, { ACCOUNT_MEMBER_CODE: 'ALX-001', ACCOUNT_TEMP_PASSWORD: second });
  const result = run(reset, 'resetAccountPassword');
  assert.equal(result.ok, true, result.message);
  assert.match(result.summary, /^Reset the password of "alex" \(ALX-001 \(Alex Example\)\)\. All their sessions have ended\./);
  const alex = row(reset);
  assert.equal(alex.must_change_password, true);
  assert.equal(alex.session_version, 2);
  assert.equal(alex.failed_logins, 0);
  assert.equal(alex.locked_until, '');
  assert.equal(alex.username, 'alex');
  const roommates = reset.get('SheetDb').list('ROOMMATES');
  assert.throws(() => reset.get('validateSession_')(oldToken, roommates, NOW), /revoked/);
  assert.equal(reset.get('verifyPassword_')(first, alex.password_hash), false);
  assert.equal(reset.get('verifyPassword_')(second, alex.password_hash), true);

  const missing = owner(database(), { ACCOUNT_MEMBER_CODE: 'SMA-002', ACCOUNT_TEMP_PASSWORD: tempPassword.temporaryPassword() });
  assert.equal(run(missing, 'resetAccountPassword').code, 'ACCOUNT_MISSING');
});

test('outside the maintenance window or for anyone but the owner, nothing runs and nothing is consumed', () => {
  const temporary = tempPassword.temporaryPassword();
  for (const options of [{ maintenance: false }, { activeUser: '' }, { activeUser: 'roommate@example.com' }]) {
    for (const name of ['createAccount', 'resetAccountPassword']) {
      const spreadsheet = database();
      const before = spreadsheet.snapshot();
      const project = owner(spreadsheet, { ACCOUNT_MEMBER_CODE: 'ALX-001', ACCOUNT_USERNAME: 'alex', ACCOUNT_TEMP_PASSWORD: temporary }, options);
      assert.equal(run(project, name).ok, false);
      assert.equal(spreadsheet.snapshot(), before);
      assert.deepEqual(project.opened, []);
      assert.equal(project.properties.ACCOUNT_TEMP_PASSWORD, temporary, 'a refused caller cannot even delete it');
    }
  }
});

test('the slow hash runs outside the script lock, and the checks are repeated under it', () => {
  const spreadsheet = database();
  const project = owner(spreadsheet, { ACCOUNT_MEMBER_CODE: 'ALX-001', ACCOUNT_USERNAME: 'alex', ACCOUNT_TEMP_PASSWORD: tempPassword.temporaryPassword() });
  const global = project.get('globalThis');
  const real = global.nobleHashes_;
  let underLock = 0;
  global.nobleHashes_ = () => {
    const library = real();
    return { sha256: library.sha256, pbkdf2: (...args) => {
      if (project.lock.held) underLock += 1;
      // Someone else takes the username while this run is hashing.
      project.get('SheetDb').update('ROOMMATES', '22222222-2222-4222-8222-222222222222', { username: 'alex', role: 'ROOMMATE' });
      return library.pbkdf2(...args);
    } };
  };
  const result = run(project, 'createAccount');
  assert.equal(underLock, 0);
  assert.equal(result.code, 'USERNAME_TAKEN', 'the re-check under the lock sees the new conflict');
  assert.equal(row(project).username, '');
});

test('temporary passwords from "npm run temp-password" match the server format and policy, and never go to a pipe', () => {
  const project = owner(database());
  assert.equal(tempPassword.ALPHABET, project.get('TEMP_PASSWORD_ALPHABET'));
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const value = tempPassword.temporaryPassword();
    assert.equal(project.get('isTemporaryPasswordFormat_')(value), true);
    project.get('assertPasswordPolicy_')(value, 'alex');
    seen.add(value);
  }
  assert.equal(seen.size, 200);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'temp-password.js')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('Accounts.js logs only the summary and never the temporary password', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'backend', 'Accounts.js'), 'utf8');
  assert.deepEqual([...source.matchAll(/console\.\w+\(([^)]*)\)/g)].map((m) => m[1]), ['summary']);
  assert.doesNotMatch(source, /Logger\./);
  assert.match(source, /deleteProperty\(ACCOUNT_TEMP_PASSWORD_KEY\)/);
});
