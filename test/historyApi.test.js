'use strict';

// listCleaningHistory (src/backend/HistoryApi.js): the read-only History tab.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, asSignedIn, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const NOW = new Date('2026-03-20T12:00:00Z');
const [ALEX, SAM, JO] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const SHEETS = Object.keys(FIXTURES);
const due = (n) => new Date(Date.UTC(2026, 0, 11 + 7 * n, 23)); // Monday 00:00 Berlin after weekend n (winter time)

function log(n, extra = {}) {
  return {
    log_id: `log-${n}`, rotation_id: 'slot', roommate_id: ALEX, swap_id: '', due_date: due(n), outcome: 'completed',
    resolved_at: new Date(due(n).getTime() - 5 * 3600e3), completed_at: new Date(due(n).getTime() - 5 * 3600e3), notes: 'private note', created_at: due(n), ...extra,
  };
}

function database(logs) {
  const sheets = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  const headers = sheets.CLEANING_LOGS[0];
  sheets.CLEANING_LOGS = [headers, ...logs.map((record) => headers.map((h) => (h in record ? record[h] : '')))];
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets });
}

const app = (spreadsheet) => loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now: NOW, maintenance: false });
const history = (project, request = asSignedIn(project, { roommate_id: SAM })) => plain(project.get('listCleaningHistory')(request));

test('any signed-in roommate sees the latest ten records, newest weekend first', () => {
  const logs = Array.from({ length: 12 }, (_, n) => log(n)).reverse(); // stored oldest last, to prove the sort
  const result = history(app(database(logs)));
  assert.equal(result.ok, true);
  assert.equal(result.limit, 10);
  assert.deepEqual(result.entries.map((e) => e.log_id), ['log-11', 'log-10', 'log-9', 'log-8', 'log-7', 'log-6', 'log-5', 'log-4', 'log-3', 'log-2']);
});

test('each entry has the roommate, the cleaning weekend, the outcome and when it was done, and nothing else', () => {
  const project = app(database([
    log(0),
    log(1, { roommate_id: SAM, outcome: 'vacation_skipped', completed_at: '', notes: 'Skipped: away' }),
    log(2, { roommate_id: JO, outcome: 'admin_resolved', completed_at: '', notes: 'Resolved by the owner: flat was empty', swap_id: 'swap-1' }),
  ]));
  const [resolved, skipped, completed] = history(project).entries;
  assert.deepEqual(completed, {
    log_id: 'log-0', roommate: { roommate_id: ALEX, name: 'Alex Example' }, weekend_starts_at: '2026-01-09T23:00:00.000Z', due_at: '2026-01-11T23:00:00.000Z',
    outcome: 'completed', completed_at: '2026-01-11T18:00:00.000Z', resolved_at: '2026-01-11T18:00:00.000Z', swapped: false,
  });
  assert.equal(skipped.outcome, 'vacation_skipped');
  assert.equal(skipped.completed_at, null);
  assert.equal(skipped.roommate.name, 'Sam Example');
  assert.equal(resolved.outcome, 'admin_resolved');
  assert.equal(resolved.swapped, true);
  const json = JSON.stringify(history(project));
  for (const hidden of ['private note', 'flat was empty', '@example.com', 'notes', 'rotation_id', 'created_at']) assert.ok(!json.includes(hidden), hidden);
});

test('the weekend is right across the March clock change', () => {
  // Weekend of Sat 28 – Sun 29 Mar 2026: Berlin switches to summer time on the Sunday, so the deadline is 22:00Z.
  const result = history(app(database([log(0, { due_date: new Date('2026-03-29T22:00:00.000Z'), resolved_at: new Date('2026-03-29T10:00:00Z'), completed_at: new Date('2026-03-29T10:00:00Z') })])));
  assert.equal(result.entries[0].weekend_starts_at, '2026-03-27T23:00:00.000Z');
  assert.equal(result.entries[0].due_at, '2026-03-29T22:00:00.000Z');
});

test('malformed rows are left out instead of breaking the page; an empty log is an empty list', () => {
  const result = history(app(database([log(0), log(1, { outcome: 'cleaned' }), log(2, { due_date: 'soon' }), log(3, { resolved_at: '' }), log(4, { roommate_id: '' })])));
  assert.deepEqual(result.entries.map((e) => e.log_id), ['log-0']);
  assert.deepEqual(history(app(database([]))), { ok: true, entries: [], limit: 10 });
  const gone = history(app(database([log(0, { roommate_id: 'someone-deleted' })])));
  assert.deepEqual(gone.entries[0].roommate, { roommate_id: 'someone-deleted', name: null });
});

test('it needs a valid session, takes nothing else, and never writes or locks', () => {
  const spreadsheet = database([log(0)]);
  const project = app(spreadsheet);
  const before = spreadsheet.snapshot();
  assert.equal(history(project, null).error.code, 'INVALID_REQUEST');
  assert.equal(history(project, { token: 'v1.forged.token' }).error.code, 'UNAUTHENTICATED');
  assert.equal(history(project, { ...asSignedIn(project), roommate_id: SAM }).error.code, 'INVALID_REQUEST');
  assert.equal(history(project).ok, true);
  assert.deepEqual(project.lock.events, []);
  assert.equal(spreadsheet.snapshot(), before, 'read-only');

  const pending = app(database([log(0)]));
  pending.get('SheetDb').update('ROOMMATES', SAM, { must_change_password: true, password_expires_at: new Date(NOW.getTime() + 3600e3) });
  assert.equal(history(pending).error.code, 'PASSWORD_CHANGE_REQUIRED');
});
