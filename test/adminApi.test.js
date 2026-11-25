'use strict';

// The admin section's browser API (src/backend/AdminApi.js): ADMIN-only, verified against the Sheet on every call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain, sessionToken } = require('./support/appsScript');

const NOW = new Date('2026-01-13T12:00:00Z');
const [ALEX, SAM, JO, KIM] = FIXTURES.ROOMMATES.map((r) => r.roommate_id); // Alex is the fixtures' ADMIN
const SHEETS = Object.keys(FIXTURES);

function database(edit = () => {}) {
  const sheets = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  edit(sheets);
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets });
}

/** Sets ROOMMATES fields of one row in the sheet values. */
const setRow = (sheets, roommateId, fields) => {
  const headers = sheets.ROOMMATES[0];
  const row = sheets.ROOMMATES.find((r) => r[0] === roommateId);
  for (const [key, value] of Object.entries(fields)) row[headers.indexOf(key)] = value;
};

function app(spreadsheet, now = NOW) {
  const project = loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now, maintenance: false });
  project.get('AUTH_SETTINGS').iterations = 10000;
  return project;
}

const call = (project, name, request) => plain(project.get(name)(request));
const code = (result) => (result.ok ? 'OK' : result.error.code);
const row = (project, id) => project.get('SheetDb').list('ROOMMATES').find((r) => r.roommate_id === id);
const as = (project, id) => ({ token: sessionToken(project, id) });

const ADMIN_CALLS = {
  adminListAccounts: () => ({}),
  adminAddRoommate: () => ({ name: 'New Person', email: 'new@example.com', username: 'newbie', role: 'ROOMMATE' }),
  adminProvisionAccount: () => ({ roommate_id: SAM, username: 'sammy', role: 'ROOMMATE' }),
  adminResetSignIn: () => ({ roommate_id: SAM }),
  adminDisableSignIn: () => ({ roommate_id: SAM }),
  adminEndSessions: () => ({ roommate_id: SAM }),
  adminChangeRole: () => ({ roommate_id: SAM, role: 'ADMIN' }),
};

// ---------- who may call ----------

test('only a signed-in ADMIN may call any admin function; roommates, strangers and pending admins get nothing', () => {
  const spreadsheet = database((sheets) => setRow(sheets, KIM, { role: 'ADMIN', must_change_password: true, password_expires_at: new Date(NOW.getTime() + 3600e3) }));
  const project = app(spreadsheet);
  const before = spreadsheet.snapshot();
  const callers = { roommate: [as(project, SAM), 'FORBIDDEN'], stranger: [{ token: 'v1.forged.token' }, 'UNAUTHENTICATED'], 'admin with a temporary password': [as(project, KIM), 'PASSWORD_CHANGE_REQUIRED'] };
  for (const [name, body] of Object.entries(ADMIN_CALLS)) {
    for (const [label, [auth, expected]] of Object.entries(callers)) {
      assert.equal(code(call(project, name, { ...auth, ...body() })), expected, `${name} as ${label}`);
    }
    assert.equal(code(call(project, name, body())), 'INVALID_REQUEST', `${name} without a token`);
    assert.equal(code(call(project, name, { ...as(project, ALEX), ...body(), extra: 'x' })), 'INVALID_REQUEST', `${name} with an unknown field`);
  }
  assert.equal(spreadsheet.snapshot(), before, 'nothing was written');
});

test('the role is read from the Sheet on every call: a demoted admin loses access at once', () => {
  const project = app(database((sheets) => setRow(sheets, SAM, { role: 'ADMIN' })));
  const samToken = as(project, SAM);
  assert.equal(code(call(project, 'adminListAccounts', samToken)), 'OK');
  assert.equal(code(call(project, 'adminChangeRole', { ...as(project, ALEX), roommate_id: SAM, role: 'ROOMMATE' })), 'OK');
  assert.equal(code(call(project, 'adminListAccounts', samToken)), 'FORBIDDEN');
  assert.equal(code(call(project, 'getRotationSchedule', samToken)), 'OK', 'still a roommate');
});

// ---------- the list ----------

test('the account list shows name, code, username, role, position and status, and nothing private', () => {
  const project = app(database((sheets) => {
    setRow(sheets, SAM, { username: '', role: '', password_hash: '', must_change_password: '', session_version: '', failed_logins: '', locked_until: '' });
    setRow(sheets, JO, { locked_until: new Date(NOW.getTime() + 600e3) });
    setRow(sheets, KIM, { must_change_password: true, password_expires_at: new Date(NOW.getTime() - 1) });
  }));
  const result = call(project, 'adminListAccounts', as(project, ALEX));
  assert.equal(result.ok, true);
  for (const view of result.accounts) assert.deepEqual(Object.keys(view).sort(), ['is_you', 'member_code', 'name', 'position', 'role', 'roommate_id', 'status', 'username']);
  const byName = Object.fromEntries(result.accounts.map((v) => [v.name, v]));
  assert.deepEqual(byName['Alex Example'], { roommate_id: ALEX, name: 'Alex Example', member_code: 'ALX-001', username: 'alex', role: 'ADMIN', status: 'active', position: byName['Alex Example'].position, is_you: true });
  assert.equal(byName['Sam Example'].status, 'none');
  assert.equal(byName['Sam Example'].username, null);
  assert.equal(byName['Jo Example'].status, 'locked');
  assert.equal(byName['Kim Example'].status, 'temporary_expired');
  const json = JSON.stringify(result);
  for (const secret of ['pbkdf2', '@example.com', 'password_hash', 'session_version', 'failed_logins', 'token', 'telegram']) assert.ok(!json.includes(secret), secret);
});

// ---------- onboarding and accounts ----------

test('adding a roommate puts them at the end of the rotation with a new account and a one-time temporary password', () => {
  const spreadsheet = database();
  const project = app(spreadsheet);
  const history = JSON.stringify(['CLEANING_LOGS', 'SWAPS', 'VACATIONS'].map((n) => spreadsheet.getSheetByName(n).values));
  const ids = plain(project.get('SheetDb').list('ROOMMATES').map((r) => r.roommate_id));
  const result = call(project, 'adminAddRoommate', { ...as(project, ALEX), name: '  John   Smith ', email: 'John@Example.com', telegram: '@john_smith', username: 'John', role: 'ROOMMATE' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(result).sort(), ['account', 'expires_at', 'ok', 'temporary_password']);
  assert.match(result.temporary_password, /^[A-Za-z0-9]{16}$/);
  assert.equal(result.expires_at, new Date(NOW.getTime() + 72 * 3600e3).toISOString());
  assert.deepEqual({ ...result.account, roommate_id: 'x' }, { roommate_id: 'x', name: 'John Smith', member_code: 'JHN-005', username: 'john', role: 'ROOMMATE', status: 'temporary', position: 5, is_you: false });

  const john = row(project, result.account.roommate_id);
  assert.equal(john.email, 'john.smith@example.com'.replace('.smith', ''), 'email stored in lower case');
  assert.equal(project.get('verifyPassword_')(result.temporary_password, john.password_hash), true);
  assert.ok(!spreadsheet.snapshot().includes(result.temporary_password), 'only the hash is stored');
  const after = plain(project.get('SheetDb').list('ROOMMATES').map((r) => r.roommate_id));
  assert.deepEqual(after.slice(0, ids.length), ids, 'existing roommates keep their IDs');
  assert.equal(JSON.stringify(['CLEANING_LOGS', 'SWAPS', 'VACATIONS'].map((n) => spreadsheet.getSheetByName(n).values)), history, 'history untouched');

  const signedIn = call(project, 'signIn', { username: 'john', password: result.temporary_password });
  assert.equal(signedIn.viewer.must_change_password, true);
});

test('adding refuses duplicates and bad details before writing anything', () => {
  const cases = [
    [{ email: 'alex@example.com' }, 'ACCOUNT_EXISTS'],
    [{ username: 'Sam' }, 'USERNAME_TAKEN'],
    [{ username: '1x' }, 'ACCOUNT_INVALID'],
    [{ name: '' }, 'ONBOARDING_INVALID'],
    [{ name: '=SUM(A1)' }, 'ROOMMATE_INVALID'],
    [{ email: 'not an email' }, 'ROOMMATE_INVALID'],
    [{ role: 'OWNER' }, 'INVALID_REQUEST'],
    [{ name: 'x'.repeat(300) }, 'INVALID_REQUEST'],
  ];
  for (const [change, expected] of cases) {
    const spreadsheet = database();
    const project = app(spreadsheet);
    const before = spreadsheet.snapshot();
    const result = call(project, 'adminAddRoommate', { ...as(project, ALEX), ...ADMIN_CALLS.adminAddRoommate(), ...change });
    assert.equal(code(result), expected, JSON.stringify(change));
    assert.equal(spreadsheet.snapshot(), before, JSON.stringify(change));
  }
});

test('an existing roommate without an account gets one; one with an account, or deactivated, does not', () => {
  const spreadsheet = database((sheets) => {
    setRow(sheets, SAM, { username: '', role: '', password_hash: '', session_version: '' });
    setRow(sheets, JO, { username: '', role: '', password_hash: '', active: false });
  });
  const project = app(spreadsheet);
  const admin = as(project, ALEX);
  assert.equal(code(call(project, 'adminProvisionAccount', { ...admin, roommate_id: SAM, username: 'alex', role: 'ROOMMATE' })), 'USERNAME_TAKEN');
  assert.equal(code(call(project, 'adminProvisionAccount', { ...admin, roommate_id: JO, username: 'jo2', role: 'ROOMMATE' })), 'ACCOUNT_INVALID');
  assert.equal(code(call(project, 'adminProvisionAccount', { ...admin, roommate_id: KIM, username: 'kimmy', role: 'ROOMMATE' })), 'ACCOUNT_EXISTS');
  const made = call(project, 'adminProvisionAccount', { ...admin, roommate_id: SAM, username: 'Sammy', role: 'ADMIN' });
  assert.equal(made.ok, true);
  assert.deepEqual({ username: made.account.username, role: made.account.role, status: made.account.status }, { username: 'sammy', role: 'ADMIN', status: 'temporary' });
  assert.equal(code(call(project, 'adminProvisionAccount', { ...admin, roommate_id: SAM, username: 'sammy2', role: 'ROOMMATE' })), 'ACCOUNT_EXISTS', 'no second account');
  assert.equal(row(project, SAM).roommate_id, SAM, 'same roommate row, same ID');
});

test('a new temporary password ends every session, clears a lock, re-enables a disabled sign-in, and works once', () => {
  const project = app(database((sheets) => setRow(sheets, SAM, { locked_until: new Date(NOW.getTime() + 600e3) })));
  const oldToken = as(project, SAM);
  const reset = call(project, 'adminResetSignIn', { ...as(project, ALEX), roommate_id: SAM });
  assert.equal(reset.ok, true);
  assert.equal(reset.account.status, 'temporary');
  assert.equal(code(call(project, 'getRotationSchedule', oldToken)), 'UNAUTHENTICATED');
  assert.equal(row(project, SAM).locked_until, '');
  const signIn = call(project, 'signIn', { username: 'sam', password: reset.temporary_password });
  assert.equal(signIn.viewer.must_change_password, true);

  assert.equal(code(call(project, 'adminDisableSignIn', { ...as(project, ALEX), roommate_id: SAM })), 'OK');
  assert.equal(code(call(project, 'signIn', { username: 'sam', password: reset.temporary_password })), 'LOGIN_FAILED');
  const again = call(project, 'adminResetSignIn', { ...as(project, ALEX), roommate_id: SAM });
  assert.equal(again.account.status, 'temporary', 're-enabled');
  assert.notEqual(again.temporary_password, reset.temporary_password);
  assert.equal(code(call(project, 'adminResetSignIn', { ...as(project, ALEX), roommate_id: 'nobody' })), 'ACCOUNT_INVALID');
});

test('disabling sign-in ends the sessions and blocks the account without touching the rotation', () => {
  const spreadsheet = database();
  const project = app(spreadsheet);
  const rotation = JSON.stringify(spreadsheet.getSheetByName('ROTATION').values);
  const samToken = as(project, SAM);
  const result = call(project, 'adminDisableSignIn', { ...as(project, ALEX), roommate_id: SAM });
  assert.equal(result.account.status, 'disabled');
  assert.equal(code(call(project, 'getRotationSchedule', samToken)), 'UNAUTHENTICATED');
  assert.equal(row(project, SAM).active, true, 'still a roommate in the rotation');
  assert.equal(row(project, SAM).password_hash, '');
  assert.equal(JSON.stringify(spreadsheet.getSheetByName('ROTATION').values), rotation);
});

test('ending sessions signs the roommate out everywhere but keeps their password', () => {
  const project = app(database());
  const samToken = as(project, SAM);
  const hash = row(project, SAM).password_hash;
  assert.equal(code(call(project, 'adminEndSessions', { ...as(project, ALEX), roommate_id: SAM })), 'OK');
  assert.equal(code(call(project, 'getRotationSchedule', samToken)), 'UNAUTHENTICATED');
  assert.equal(row(project, SAM).password_hash, hash);
  assert.equal(code(call(project, 'getRotationSchedule', as(project, SAM))), 'OK', 'a new sign-in works');
});

test('an admin cannot disable, demote or sign out their own account, and there is always an admin left', () => {
  const project = app(database());
  const admin = as(project, ALEX);
  for (const [name, body] of [['adminDisableSignIn', {}], ['adminEndSessions', {}], ['adminChangeRole', { role: 'ROOMMATE' }]]) {
    assert.equal(code(call(project, name, { ...admin, roommate_id: ALEX, ...body })), 'SELF_CHANGE', name);
  }
  assert.equal(row(project, ALEX).role, 'ADMIN');
  // The guard itself: the last admin who can sign in can never be disabled or demoted.
  const roommates = project.get('SheetDb').list('ROOMMATES');
  assert.equal(project.get('remainingAdmins_')(roommates, ALEX, { role: 'ROOMMATE' }), 0);
  assert.throws(() => project.get('assertAdminRemains_')(roommates, ALEX, { password_hash: '' }), (error) => error.code === 'LAST_ADMIN');
  assert.equal(project.get('remainingAdmins_')(roommates, SAM, { role: 'ADMIN' }), 2);
});

test('roles change only through an admin, and promotions take effect at once', () => {
  const project = app(database());
  assert.equal(code(call(project, 'adminChangeRole', { ...as(project, SAM), roommate_id: SAM, role: 'ADMIN' })), 'FORBIDDEN', 'no self-promotion');
  assert.equal(code(call(project, 'adminChangeRole', { ...as(project, ALEX), roommate_id: SAM, role: 'ADMIN' })), 'OK');
  assert.equal(code(call(project, 'adminListAccounts', as(project, SAM))), 'OK');
  assert.equal(code(call(project, 'adminChangeRole', { ...as(project, SAM), roommate_id: ALEX, role: 'ROOMMATE' })), 'OK', 'another admin may demote Alex');
  assert.equal(code(call(project, 'adminListAccounts', as(project, ALEX))), 'FORBIDDEN');
});

test('the slow password hash never runs under the script lock', () => {
  const project = app(database((sheets) => setRow(sheets, SAM, { username: '', role: '', password_hash: '' })));
  const global = project.get('globalThis');
  const real = global.nobleHashes_;
  let underLock = 0;
  global.nobleHashes_ = () => {
    const library = real();
    return { sha256: library.sha256, pbkdf2: (...args) => {
      if (project.lock.held) underLock += 1;
      return library.pbkdf2(...args);
    } };
  };
  assert.equal(code(call(project, 'adminProvisionAccount', { ...as(project, ALEX), roommate_id: SAM, username: 'sammy', role: 'ROOMMATE' })), 'OK');
  assert.equal(code(call(project, 'adminResetSignIn', { ...as(project, ALEX), roommate_id: SAM })), 'OK');
  assert.equal(code(call(project, 'adminAddRoommate', { ...as(project, ALEX), ...ADMIN_CALLS.adminAddRoommate() })), 'OK');
  assert.equal(underLock, 0);
});

test('AdminApi.js never logs or stores a temporary password, and only returns it in that one answer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'backend', 'AdminApi.js'), 'utf8');
  for (const [, logged] of source.matchAll(/console\.\w+\(([^;]*)\);/g)) assert.doesNotMatch(logged, /temporary|password|token|hash/i, logged);
  assert.doesNotMatch(source, /PropertiesService|CacheService/);
  const project = app(database());
  const listed = JSON.stringify(call(project, 'adminListAccounts', as(project, ALEX)));
  const reset = call(project, 'adminResetSignIn', { ...as(project, ALEX), roommate_id: SAM });
  assert.ok(!JSON.stringify(call(project, 'adminListAccounts', as(project, ALEX))).includes(reset.temporary_password));
  assert.ok(!listed.includes('temporary_password'));
});
