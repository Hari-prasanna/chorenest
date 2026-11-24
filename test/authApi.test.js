'use strict';

// The browser API for sessions (signIn, changePassword, signOut) and the session gate on every household API.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, asSignedIn, fixtureSheet, loadProject, plain, sessionToken } = require('./support/appsScript');

const NOW = new Date('2026-01-13T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const [ALEX, SAM] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const PASSWORD = 'correct horse battery';
const TEMPORARY = 'TempPassw0rdXyzK';
const SHEETS = Object.keys(FIXTURES);

/** Fixtures where Alex can sign in with PASSWORD (and `alex` overrides any of Alex's fields). */
function database(alex = {}) {
  const hasher = loadProject({ properties: { ENVIRONMENT: 'DEV' }, maintenance: false });
  hasher.get('AUTH_SETTINGS').iterations = 10000;
  const hash = hasher.get('hashPassword_')(alex.password || PASSWORD);
  const sheets = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  const headers = sheets.ROOMMATES[0];
  const fields = { password_hash: hash, ...alex };
  delete fields.password;
  sheets.ROOMMATES = sheets.ROOMMATES.map((row, i) => (i > 0 && row[0] === ALEX ? headers.map((h, j) => (h in fields ? fields[h] : row[j])) : row));
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets });
}

function app(spreadsheet, { now = NOW, environment = 'DEV' } = {}) {
  const project = loadProject({ properties: { ENVIRONMENT: environment, SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now, maintenance: false });
  project.get('AUTH_SETTINGS').iterations = 10000;
  return project;
}

const call = (project, name, request) => plain(project.get(name)(request));
const code = (result) => (result.ok ? 'OK' : result.error.code);
const alexRow = (project) => project.get('SheetDb').list('ROOMMATES').find((r) => r.roommate_id === ALEX);

// ---------- signIn / changePassword / signOut ----------

test('signIn returns a session and the viewer, and nothing else about the account', () => {
  const project = app(database());
  const result = call(project, 'signIn', { username: 'Alex', password: PASSWORD });
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'session', 'viewer']);
  assert.deepEqual(Object.keys(result.session).sort(), ['expires_at', 'token']);
  assert.equal(result.session.expires_at, new Date(NOW.getTime() + 14 * DAY).toISOString());
  assert.deepEqual(result.viewer, { roommate_id: ALEX, name: 'Alex Example', role: 'ADMIN', must_change_password: false });
  assert.doesNotMatch(JSON.stringify(result), /pbkdf2|password_hash|session_version|alex@example\.com|ALX-001/);
  assert.equal(code(call(project, 'getRotationSchedule', { token: result.session.token })), 'OK');
});

test('signIn refuses malformed requests before anything runs, and wrong passwords with the one public answer', () => {
  const project = app(database());
  for (const request of [null, undefined, 'alex', [], {}, { username: 'alex' }, { password: PASSWORD }, { username: 'alex', password: PASSWORD, role: 'ADMIN' },
    { username: 5, password: PASSWORD }, { username: 'alex', password: 'x'.repeat(513) }]) {
    assert.equal(code(call(project, 'signIn', request)), 'INVALID_REQUEST', JSON.stringify(request));
  }
  assert.deepEqual(project.lock.events, []);
  const wrong = call(project, 'signIn', { username: 'alex', password: 'not the password' });
  const unknown = call(project, 'signIn', { username: 'nobody', password: PASSWORD });
  assert.deepEqual(wrong, unknown);
  assert.equal(wrong.error.code, 'LOGIN_FAILED');
});

test('a temporary password works for 72 hours and only to change it; expired or undated ones are refused', () => {
  const fresh = { password: TEMPORARY, must_change_password: true, password_expires_at: new Date(NOW.getTime() + 72 * HOUR) };
  const spreadsheet = database(fresh);
  const project = app(spreadsheet);
  const signedIn = call(project, 'signIn', { username: 'alex', password: TEMPORARY });
  assert.equal(signedIn.viewer.must_change_password, true);
  const { token } = signedIn.session;
  for (const [name, request] of [['getRotationSchedule', { token }], ['listVacations', { token }], ['saveVacation', { token, start_date: '2026-02-01', return_date: '2026-02-03' }]]) {
    assert.equal(code(call(project, name, request)), 'PASSWORD_CHANGE_REQUIRED', name);
  }

  const later = app(spreadsheet, { now: new Date(NOW.getTime() + 73 * HOUR) });
  assert.equal(code(call(later, 'getRotationSchedule', { token })), 'TEMP_PASSWORD_EXPIRED', 'an open temporary session ends with the expiry');
  assert.equal(code(call(later, 'signIn', { username: 'alex', password: TEMPORARY })), 'TEMP_PASSWORD_EXPIRED');
  assert.equal(code(call(later, 'changePassword', { token, current_password: TEMPORARY, new_password: 'our cosy flat 2026' })), 'TEMP_PASSWORD_EXPIRED');
  assert.equal(code(call(later, 'signIn', { username: 'alex', password: 'wrong guess here' })), 'LOGIN_FAILED', 'only the right password learns that it expired');

  const undated = app(database({ password: TEMPORARY, must_change_password: true, password_expires_at: '' }));
  assert.equal(code(call(undated, 'signIn', { username: 'alex', password: TEMPORARY })), 'TEMP_PASSWORD_EXPIRED', 'no recorded expiry counts as expired');
});

test('changing the temporary password opens the household and ends every other session', () => {
  const spreadsheet = database({ password: TEMPORARY, must_change_password: true, password_expires_at: new Date(NOW.getTime() + DAY) });
  const project = app(spreadsheet);
  const first = call(project, 'signIn', { username: 'alex', password: TEMPORARY }).session.token;
  const second = call(project, 'signIn', { username: 'alex', password: TEMPORARY }).session.token;
  for (const request of [{ token: first }, { token: first, current_password: TEMPORARY }, { token: first, current_password: TEMPORARY, new_password: 'x', extra: 1 }]) {
    assert.equal(code(call(project, 'changePassword', request)), 'INVALID_REQUEST');
  }
  const changed = call(project, 'changePassword', { token: first, current_password: TEMPORARY, new_password: 'our cosy flat 2026' });
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.viewer, { roommate_id: ALEX, name: 'Alex Example', role: 'ADMIN', must_change_password: false });
  assert.equal(alexRow(project).password_expires_at, '');
  assert.equal(code(call(project, 'getRotationSchedule', { token: changed.session.token })), 'OK');
  assert.equal(code(call(project, 'getRotationSchedule', { token: first })), 'UNAUTHENTICATED');
  assert.equal(code(call(project, 'getRotationSchedule', { token: second })), 'UNAUTHENTICATED');
  assert.equal(code(call(project, 'signIn', { username: 'alex', password: 'our cosy flat 2026' })), 'OK');
});

test('signOut ends this roommate’s sessions on every device and leaves everyone else signed in', () => {
  const project = app(database());
  const phone = call(project, 'signIn', { username: 'alex', password: PASSWORD }).session.token;
  const laptop = call(project, 'signIn', { username: 'alex', password: PASSWORD }).session.token;
  const sam = sessionToken(project, SAM);
  assert.deepEqual(call(project, 'signOut', { token: phone }), { ok: true });
  for (const token of [phone, laptop]) assert.equal(code(call(project, 'getRotationSchedule', { token })), 'UNAUTHENTICATED');
  assert.equal(code(call(project, 'getRotationSchedule', { token: sam })), 'OK');
  assert.equal(code(call(project, 'signOut', { token: phone })), 'UNAUTHENTICATED', 'an ended session cannot end anything');
  assert.equal(code(call(project, 'signOut', { token: 'v1.forged.token' })), 'UNAUTHENTICATED');
  assert.equal(code(call(project, 'signOut', {})), 'INVALID_REQUEST');
});

// ---------- the session gate on every household API ----------

const HOUSEHOLD = {
  getRotationSchedule: () => ({}),
  listVacations: () => ({}),
  markCleaned: () => ({ rotation_id: '44444444-4444-4444-8444-444444444444', due_at: '2026-01-18T23:00:00.000Z' }),
  saveVacation: () => ({ start_date: '2026-02-01', return_date: '2026-02-03' }),
  cancelVacation: () => ({ vacation_id: 'v1' }),
  updateVacation: () => ({ vacation_id: 'v1', start_date: '2026-02-01', return_date: '2026-02-03', seen_start: NOW.toISOString(), seen_return: NOW.toISOString() }),
  endVacation: () => ({ vacation_id: 'v1', seen_start: NOW.toISOString(), seen_return: NOW.toISOString() }),
};

test('every household API refuses a missing, forged, expired, revoked or foreign session, and writes nothing', () => {
  const spreadsheet = database();
  const project = app(spreadsheet);
  const valid = sessionToken(project, ALEX);
  const [version, payload] = valid.split('.');
  const prod = app(database(), { environment: 'PROD' });
  const tokens = {
    'no token': undefined,
    'empty token': '',
    'forged signature': `${version}.${payload}.${'A'.repeat(43)}`,
    'someone made up': 'v1.eyJyIjoiMTExIn0.abc',
    'other environment': (() => {
      try {
        return prod.get('issueSessionToken_')(alexRow(project), NOW);
      } catch (error) {
        return 'v1.prod.token';
      }
    })(),
  };
  const before = spreadsheet.snapshot();
  for (const [name, body] of Object.entries(HOUSEHOLD)) {
    for (const [label, token] of Object.entries(tokens)) {
      const request = token === undefined ? body() : { token, ...body() };
      const result = call(project, name, request);
      assert.ok(['UNAUTHENTICATED', 'INVALID_REQUEST'].includes(code(result)), `${name}, ${label}: ${code(result)}`);
      if (token !== undefined && token !== '') assert.equal(code(result), 'UNAUTHENTICATED', `${name}, ${label}`);
    }
  }
  assert.equal(spreadsheet.snapshot(), before);

  const twoWeeks = app(spreadsheet, { now: new Date(NOW.getTime() + 14 * DAY) });
  for (const [name, body] of Object.entries(HOUSEHOLD)) assert.equal(code(call(twoWeeks, name, { token: valid, ...body() })), 'UNAUTHENTICATED', `${name}: expired after 14 days`);

  project.get('SheetDb').update('ROOMMATES', ALEX, { session_version: 1 });
  for (const [name, body] of Object.entries(HOUSEHOLD)) assert.equal(code(call(project, name, { token: valid, ...body() })), 'UNAUTHENTICATED', `${name}: revoked`);
});

test('a deactivated roommate is signed out everywhere at once', () => {
  const project = app(database());
  const token = sessionToken(project, SAM);
  assert.equal(code(call(project, 'getRotationSchedule', { token })), 'OK');
  project.get('SheetDb').update('ROOMMATES', SAM, { active: false });
  assert.equal(code(call(project, 'getRotationSchedule', { token })), 'UNAUTHENTICATED');
  assert.equal(code(call(project, 'signIn', { username: 'sam', password: PASSWORD })), 'LOGIN_FAILED');
});

test('one roommate can never act on another’s vacation or turn, whatever the request says', () => {
  const spreadsheet = database();
  const project = app(spreadsheet);
  const saved = call(project, 'saveVacation', asSignedIn(project, { roommate_id: ALEX, start_date: '2026-03-02', return_date: '2026-03-05' }));
  assert.equal(saved.ok, true);
  const row = project.get('SheetDb').list('VACATIONS').find((v) => v.vacation_id === saved.vacation_id);
  assert.equal(row.roommate_id, ALEX, 'the vacation belongs to the signed-in roommate');

  const asSam = { token: sessionToken(project, SAM) };
  const seen = { seen_start: row.start_date.toISOString(), seen_return: row.return_date.toISOString() };
  assert.equal(code(call(project, 'cancelVacation', { ...asSam, vacation_id: saved.vacation_id })), 'NOT_YOUR_VACATION');
  assert.equal(code(call(project, 'updateVacation', { ...asSam, vacation_id: saved.vacation_id, start_date: '2026-03-02', return_date: '2026-03-09', ...seen })), 'NOT_YOUR_VACATION');
  assert.equal(code(call(project, 'endVacation', { ...asSam, vacation_id: saved.vacation_id, ...seen })), 'NOT_YOUR_VACATION');
  assert.equal(code(call(project, 'cancelVacation', { ...asSam, vacation_id: saved.vacation_id, roommate_id: ALEX })), 'INVALID_REQUEST', 'a claim to be Alex is refused outright');

  const { current } = call(project, 'getRotationSchedule', { token: sessionToken(project, ALEX) });
  const turn = { rotation_id: current.rotation_id, due_at: current.due_at };
  const assignee = current.assignee.roommate_id;
  const someoneElse = FIXTURES.ROOMMATES.map((r) => r.roommate_id).find((id) => id !== assignee && id !== FIXTURES.ROOMMATES[2].roommate_id);
  assert.equal(code(call(project, 'markCleaned', { token: sessionToken(project, someoneElse), ...turn })), 'NOT_YOUR_TURN');
  assert.equal(code(call(project, 'markCleaned', { token: sessionToken(project, assignee), ...turn })), 'OK');
});
