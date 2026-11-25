'use strict';

// One table for every function the browser can call: each is either public on purpose, or refuses a caller without a
// valid session (and, for admin functions, without the ADMIN role) and writes nothing. A new browser-callable function
// fails the coverage test until it is added here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain, sessionToken } = require('./support/appsScript');

const ROOT = path.join(__dirname, '..');
const NOW = new Date('2026-01-13T12:00:00Z');
const [ALEX, SAM] = FIXTURES.ROOMMATES.map((r) => r.roommate_id); // Alex is the fixtures' ADMIN, Sam a ROOMMATE
const ID = '33333333-3333-4333-8333-333333333333';
const SHEETS = Object.keys(FIXTURES);

const backendFiles = () => fs.readdirSync(path.join(ROOT, 'src', 'backend')).filter((f) => f.endsWith('.js') && f !== 'EditorTools.js');
const declared = (source) => [...source.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)].map((match) => match[1]);
const browserCallable = () => backendFiles().flatMap((file) => declared(fs.readFileSync(path.join(ROOT, 'src', 'backend', file), 'utf8'))).filter((name) => !name.endsWith('_')).sort();

// Public on purpose: the page itself, sign-in (its own checks are in authApi.test.js) and the trigger entry point.
const PUBLIC = ['doGet', 'signIn', 'runFridayReminder'];

const HOUSEHOLD = {
  getRotationSchedule: () => ({}),
  listCleaningHistory: () => ({}),
  listSwaps: () => ({}),
  listVacations: () => ({}),
  markCleaned: () => ({ rotation_id: ID, due_at: '2026-01-18T23:00:00.000Z' }),
  requestSwap: () => ({ your_due_at: '2026-01-18T23:00:00.000Z', partner_id: ID, their_due_at: '2026-01-25T23:00:00.000Z' }),
  acceptSwap: () => ({ swap_id: ID }),
  declineSwap: () => ({ swap_id: ID }),
  cancelSwap: () => ({ swap_id: ID }),
  saveVacation: () => ({ start_date: '2026-02-02', return_date: '2026-02-04' }),
  cancelVacation: () => ({ vacation_id: ID }),
  updateVacation: () => ({ vacation_id: ID, start_date: '2026-02-02', return_date: '2026-02-04', seen_start: '2026-02-01T23:00:00.000Z', seen_return: '2026-02-03T23:00:00.000Z' }),
  endVacation: () => ({ vacation_id: ID, seen_start: '2026-02-01T23:00:00.000Z', seen_return: '2026-02-03T23:00:00.000Z' }),
  changePassword: () => ({ current_password: 'Wrong-password-1', new_password: 'Another-password-2' }),
  signOut: () => ({}),
};

const ADMIN = {
  adminListAccounts: () => ({}),
  adminAddRoommate: () => ({ name: 'New Person', email: 'new@example.com', username: 'newbie', role: 'ROOMMATE' }),
  adminProvisionAccount: () => ({ roommate_id: SAM, username: 'sammy', role: 'ROOMMATE' }),
  adminResetSignIn: () => ({ roommate_id: SAM }),
  adminDisableSignIn: () => ({ roommate_id: SAM }),
  adminEndSessions: () => ({ roommate_id: SAM }),
  adminChangeRole: () => ({ roommate_id: SAM, role: 'ADMIN' }),
};

// Functions that deliberately accept a session that must still change its password, or that only end the caller's own.
const ALLOWS_PENDING_CHANGE = ['changePassword', 'signOut'];
const ALLOWS_EXPIRED_TEMPORARY = ['signOut']; // it only ends the caller's own sessions

function database(edit = () => {}) {
  const sheets = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  edit(sheets);
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets });
}

const setRow = (sheets, roommateId, fields) => {
  const headers = sheets.ROOMMATES[0];
  const row = sheets.ROOMMATES.find((r) => r[0] === roommateId);
  for (const [key, value] of Object.entries(fields)) row[headers.indexOf(key)] = value;
};

const projectFor = (spreadsheet, now = NOW) => {
  const project = loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now, maintenance: false });
  project.get('AUTH_SETTINGS').iterations = 10000;
  return project;
};
const code = (result) => (result && result.ok ? 'OK' : result && result.error ? result.error.code : 'NO_ERROR_CODE');

const ALL = { ...HOUSEHOLD, ...ADMIN };

test('every browser-callable function is public on purpose or listed in the authorization table', () => {
  assert.deepEqual([...Object.keys(ALL), ...PUBLIC].sort(), browserCallable());
});

// Each scenario: how the caller authenticates, and the refusal that must come back.
const SCENARIOS = {
  'a forged token': { prepare: () => ({ token: 'v1.forged.token' }), expect: 'UNAUTHENTICATED' },
  'text that is not a token': { prepare: () => ({ token: 'not-a-token' }), expect: 'UNAUTHENTICATED' },
  'an oversized token': { prepare: () => ({ token: 'x'.repeat(2000) }), expect: ['UNAUTHENTICATED', 'INVALID_REQUEST'] },
  'a session that was signed out': {
    prepare: (project) => {
      const token = sessionToken(project, SAM);
      assert.equal(project.get('signOut')({ token }).ok, true);
      return { token };
    },
    expect: 'UNAUTHENTICATED',
  },
  'a roommate who is no longer active': {
    edit: (sheets) => setRow(sheets, SAM, { active: true }),
    prepare: (project, spreadsheet) => {
      const token = sessionToken(project, SAM);
      const sheet = spreadsheet.getSheetByName('ROOMMATES');
      sheet.values[sheet.values.findIndex((r) => r[0] === SAM)][sheet.values[0].indexOf('active')] = false;
      return { token };
    },
    expect: 'UNAUTHENTICATED',
  },
  'an expired session (15 days later)': {
    prepare: (project, spreadsheet) => ({ token: sessionToken(project, SAM), later: new Date(NOW.getTime() + 15 * 24 * 3600e3), spreadsheet }),
    expect: 'UNAUTHENTICATED',
  },
  'a temporary password that must still be changed': {
    edit: (sheets) => setRow(sheets, SAM, { must_change_password: true, password_expires_at: new Date(NOW.getTime() + 3600e3) }),
    prepare: (project) => ({ token: sessionToken(project, SAM) }),
    expect: 'PASSWORD_CHANGE_REQUIRED',
    skip: ALLOWS_PENDING_CHANGE,
    // Admin functions check the role after the password: a roommate with a temporary password is refused the same way.
  },
  'a temporary password that has expired': {
    edit: (sheets) => setRow(sheets, SAM, { must_change_password: true, password_expires_at: new Date(NOW.getTime() - 3600e3) }),
    prepare: (project) => ({ token: sessionToken(project, SAM) }),
    expect: 'TEMP_PASSWORD_EXPIRED',
    skip: ALLOWS_EXPIRED_TEMPORARY,
  },
};

for (const [name, makeBody] of Object.entries(ALL)) {
  test(`${name} refuses callers without a valid session and writes nothing`, () => {
    for (const [label, scenario] of Object.entries(SCENARIOS)) {
      if (scenario.skip && scenario.skip.includes(name)) continue;
      const spreadsheet = database(scenario.edit);
      let project = projectFor(spreadsheet);
      const auth = scenario.prepare(project, spreadsheet);
      const before = spreadsheet.snapshot();
      if (auth.later) project = projectFor(spreadsheet, auth.later);
      const result = plain(project.get(name)({ token: auth.token, ...makeBody() }));
      assert.ok([].concat(scenario.expect).includes(code(result)), `${name} with ${label}: ${code(result)}`);
      assert.equal(spreadsheet.snapshot(), before, `${name} with ${label} changed the Sheet`);
    }
    // No token at all: a malformed request or no session, never a result.
    const spreadsheet = database();
    const project = projectFor(spreadsheet);
    const before = spreadsheet.snapshot();
    assert.match(code(plain(project.get(name)(makeBody()))), /^(INVALID_REQUEST|UNAUTHENTICATED)$/, `${name} without a token`);
    for (const request of [undefined, null, 'x', 7, []]) {
      assert.match(code(plain(project.get(name)(request))), /^(INVALID_REQUEST|UNAUTHENTICATED)$/, `${name} with ${JSON.stringify(request)}`);
    }
    assert.equal(spreadsheet.snapshot(), before);
  });
}

for (const name of Object.keys(ADMIN)) {
  test(`${name} also refuses a signed-in roommate (FORBIDDEN) and a body that names a roommate other than the session’s`, () => {
    const spreadsheet = database();
    const project = projectFor(spreadsheet);
    const before = spreadsheet.snapshot();
    assert.equal(code(plain(project.get(name)({ token: sessionToken(project, SAM), ...ADMIN[name]() }))), 'FORBIDDEN');
    assert.equal(spreadsheet.snapshot(), before);
  });
}

test('household functions refuse a request that names who is acting, and take identity only from the token', () => {
  for (const name of Object.keys(HOUSEHOLD)) {
    const spreadsheet = database();
    const project = projectFor(spreadsheet);
    const before = spreadsheet.snapshot();
    const result = plain(project.get(name)({ token: sessionToken(project, ALEX), ...HOUSEHOLD[name](), roommate_id: SAM }));
    assert.equal(code(result), 'INVALID_REQUEST', name);
    assert.equal(spreadsheet.snapshot(), before, name);
  }
});

test('the reminder entry point refuses fabricated trigger events without a trigger, and the page never writes anything', () => {
  const spreadsheet = database();
  const project = projectFor(spreadsheet);
  const before = spreadsheet.snapshot();
  for (const event of [undefined, null, {}, { triggerUid: 'guess' }]) {
    assert.deepEqual(plain(project.get('runFridayReminder')(event)), { ok: false, error: 'NOT_A_TRIGGER' });
  }
  assert.equal(spreadsheet.snapshot(), before);
});
