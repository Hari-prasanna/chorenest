'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, asSignedIn, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const [ALEX, SAM, JO, KIM] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const SLOT = Object.fromEntries(FIXTURES.ROTATION.map((slot) => [slot.roommate_id, slot.rotation_id]));
const NOW = new Date('2026-01-07T12:00:00Z'); // Wednesday: Alex's turn (weekend 10-11 Jan) is open, Sam is next
const berlinMidnight = (month, day, year = 2026) => new Date(Date.UTC(year, month - 1, day - 1, 23)); // winter time

const rowsFor = (name, records = []) => {
  const headers = fixtureSheet(name)[0];
  return [headers, ...records.map((record) => headers.map((header) => (header in record ? record[header] : '')))];
};
const log = (n, roommate, outcome, dueDay, resolvedAt, extra = {}) => ({
  log_id: `log-${n}`, rotation_id: SLOT[roommate], roommate_id: roommate, due_date: dueDay, outcome, resolved_at: resolvedAt,
  completed_at: outcome === 'completed' ? resolvedAt : '', notes: outcome === 'completed' ? '' : 'Because', created_at: resolvedAt, ...extra,
});

// Sam: one completion before the deadline, one after, a vacation skip and a turn closed by the owner. Alex: one on time.
// Kim has the latest log (by resolved time), so the rotation is back at Alex for the weekend of 10-11 Jan.
const LOGS = [
  log(1, SAM, 'completed', berlinMidnight(12, 15, 2025), new Date('2025-12-14T10:00:00Z')),
  log(2, SAM, 'completed', berlinMidnight(12, 22, 2025), new Date('2025-12-22T08:00:00Z')), // Monday morning: late
  log(3, SAM, 'vacation_skipped', berlinMidnight(12, 29, 2025), new Date('2025-12-29T09:00:00Z')),
  log(4, SAM, 'admin_resolved', berlinMidnight(12, 1, 2025), new Date('2025-12-02T09:00:00Z')),
  log(5, ALEX, 'completed', berlinMidnight(12, 8, 2025), new Date('2025-12-07T10:00:00Z')),
  log(6, KIM, 'completed', berlinMidnight(1, 5), new Date('2026-01-06T10:00:00Z')),
];

function database(logs = LOGS, extra = {}) {
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, {
    marker: 'DEV',
    sheets: {
      ROOMMATES: fixtureSheet('ROOMMATES'), ROTATION: fixtureSheet('ROTATION'), CLEANING_LOGS: rowsFor('CLEANING_LOGS', logs),
      SWAPS: rowsFor('SWAPS'), VACATIONS: rowsFor('VACATIONS'), ...extra,
    },
  });
}
const server = (spreadsheet, options = {}) =>
  loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now: NOW, maintenance: false, ...options });
const as = (project, who, request) => asSignedIn(project, { roommate_id: who, ...request });
const profile = (project, who, target) => plain(project.get('getMemberProfile')({ token: as(project, who).token, roommate_id: target }));
const setAvatar = (project, who, avatar) => plain(project.get('setMyAvatar')({ token: as(project, who).token, avatar }));
const schedule = (project) => plain(project.get('getRotationSchedule')(as(project, ALEX)));
const table = (spreadsheet, name) => {
  const [headers, ...rows] = spreadsheet.getSheetByName(name).values;
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]])));
};
const failed = (result, code) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
};

// Profiles

test('a profile derives completed turns and the on-time rate from the cleaning records', () => {
  const project = server(database());
  const sam = profile(project, ALEX, SAM);
  assert.equal(sam.ok, true, JSON.stringify(sam));
  assert.deepEqual(sam.member, { roommate_id: SAM, name: 'Sam Example', avatar: null, is_you: false });
  assert.deepEqual(sam.stats, { completed: 2, on_time: 1, on_time_percent: 50 }, 'skips and owner-closed turns count neither way');
  assert.deepEqual(sam.recent.map((r) => [r.outcome, r.due_at]), [
    ['vacation_skipped', berlinMidnight(12, 29, 2025).toISOString()],
    ['completed', berlinMidnight(12, 22, 2025).toISOString()],
    ['completed', berlinMidnight(12, 15, 2025).toISOString()],
    ['admin_resolved', berlinMidnight(12, 1, 2025).toISOString()],
  ], 'only Sam’s records, newest weekend first');
  for (const entry of sam.recent) assert.deepEqual(Object.keys(entry).sort(), ['can_add_photo', 'can_delete_photo', 'completed_at', 'due_at', 'has_photo', 'log_id', 'outcome', 'resolved_at', 'swapped', 'weekend_starts_at']);

  assert.deepEqual(profile(project, SAM, ALEX).stats, { completed: 1, on_time: 1, on_time_percent: 100 });
  assert.equal(profile(project, SAM, ALEX).member.is_you, false);
  assert.equal(profile(project, SAM, SAM).member.is_you, true);
  assert.deepEqual(profile(project, SAM, JO).stats, { completed: 0, on_time: 0, on_time_percent: null }, 'no completed turn: no rate');
  assert.deepEqual(profile(project, SAM, JO).recent, []);
});

test('only the five latest records are returned, and nothing is stored or written', () => {
  const many = Array.from({ length: 8 }, (_, i) => log(10 + i, JO, 'completed', berlinMidnight(11, 3 + 7 * i, 2025), new Date(Date.UTC(2025, 10, 2 + 7 * i, 10))));
  const spreadsheet = database([...many, LOGS[5]]);
  const project = server(spreadsheet);
  const before = spreadsheet.snapshot();
  const jo = profile(project, ALEX, JO);
  assert.equal(jo.stats.completed, 8);
  assert.equal(jo.recent.length, 5);
  assert.ok(jo.recent.every((r, i) => i === 0 || Date.parse(jo.recent[i - 1].due_at) > Date.parse(r.due_at)));
  assert.equal(spreadsheet.snapshot(), before, 'reading a profile writes nothing');
  assert.deepEqual(project.lock.events, []);
});

test('next is the first turn ahead for that roommate, the current one included', () => {
  const project = server(database());
  const current = schedule(project).current;
  assert.equal(current.assignee.roommate_id, ALEX);
  const alex = profile(project, SAM, ALEX).next;
  assert.deepEqual([alex.current, alex.weekend_starts_at, alex.due_at, alex.covering], [true, current.weekend_starts_at, current.due_at, null]);

  const sam = profile(project, ALEX, SAM).next;
  const upcoming = schedule(project).upcoming.find((turn) => turn.assignee.roommate_id === SAM);
  assert.deepEqual([sam.current, sam.weekend_starts_at, sam.due_at], [false, upcoming.weekend_starts_at, upcoming.due_at]);
  assert.deepEqual(Object.keys(sam).sort(), ['covering', 'current', 'due_at', 'weekend_starts_at']);
});

test('a swapped turn says whose turn it was; a roommate with no turn ahead gets null', () => {
  const swap = { swap_id: 'swap-1', from_roommate_id: ALEX, to_roommate_id: SAM, from_due_date: berlinMidnight(1, 12), to_due_date: berlinMidnight(1, 19), status: 'accepted', created_at: new Date('2026-01-05T10:00:00Z') };
  const project = server(database(LOGS, { SWAPS: rowsFor('SWAPS', [swap]) }));
  const sam = profile(project, ALEX, SAM).next;
  assert.equal(sam.current, true, 'Sam covers the open weekend');
  assert.deepEqual(plain(sam.covering), { roommate_id: ALEX, name: 'Alex Example' });

  const broken = database(LOGS, { ROTATION: rowsFor('ROTATION') }); // an empty rotation: the engine cannot work
  const result = profile(server(broken), ALEX, SAM);
  assert.equal(result.ok, true);
  assert.equal(result.next, null);
  assert.equal(result.stats.completed, 2, 'the statistics do not depend on the rotation');
});

test('a profile never contains private or account fields', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const raw = project.get('getMemberProfile')({ token: as(project, ALEX).token, roommate_id: SAM });
  const json = JSON.stringify(raw);
  for (const roommate of FIXTURES.ROOMMATES) {
    for (const field of ['email', 'telegram_username', 'username', 'password_hash', 'member_code']) {
      if (roommate[field]) assert.equal(json.includes(roommate[field]), false, `${field} of ${roommate.name}`);
    }
  }
  assert.doesNotMatch(json, /pbkdf2|session|role|"notes"|"email"/);
  assert.deepEqual(Object.keys(plain(raw)).sort(), ['member', 'next', 'ok', 'recent', 'stats']);
});

test('a profile needs a session, a valid target and nothing else', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const token = as(project, ALEX).token;
  const before = spreadsheet.snapshot();
  failed(plain(project.get('getMemberProfile')({ token: 'v1.unsigned.token', roommate_id: SAM })), 'UNAUTHENTICATED');
  failed(plain(project.get('getMemberProfile')({ token: '', roommate_id: SAM })), 'UNAUTHENTICATED');
  failed(plain(project.get('getMemberProfile')({ token, roommate_id: 'nobody-with-this-id' })), 'UNKNOWN_ROOMMATE');
  for (const request of [null, undefined, 'x', [], {}, { token }, { roommate_id: SAM }, { token, roommate_id: 5 }, { token, roommate_id: 'bad id!' }, { token, roommate_id: SAM, extra: 1 }, { token, id: SAM }]) {
    failed(plain(project.get('getMemberProfile')(request)), 'INVALID_REQUEST');
  }
  assert.equal(spreadsheet.snapshot(), before);

  const rows = fixtureSheet('ROOMMATES');
  rows[2][rows[0].indexOf('active')] = false; // Sam moved out
  const moved = server(database(LOGS, { ROOMMATES: rows }));
  failed(plain(moved.get('getMemberProfile')({ token: as(moved, ALEX).token, roommate_id: SAM })), 'UNKNOWN_ROOMMATE');
});

// Avatars

test('a roommate sets and clears only their own avatar, and the schedule shows it', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const before = table(spreadsheet, 'ROOMMATES');

  assert.deepEqual(setAvatar(project, SAM, 'flame'), { ok: true, avatar: 'flame' });
  const after = table(spreadsheet, 'ROOMMATES');
  assert.deepEqual(after.map((r) => r.avatar), ['', 'flame', '', '']);
  assert.deepEqual(after.map(({ avatar, ...rest }) => rest), before.map(({ avatar, ...rest }) => rest), 'nothing else in any row changed');
  assert.deepEqual(project.lock.events, ['lock', 'unlock']);

  const roommates = Object.fromEntries(schedule(project).roommates.map((r) => [r.roommate_id, r.avatar]));
  assert.deepEqual(roommates, { [ALEX]: null, [SAM]: 'flame', [JO]: null, [KIM]: null });
  assert.equal(profile(project, ALEX, SAM).member.avatar, 'flame');

  assert.deepEqual(setAvatar(project, SAM, 'moon'), { ok: true, avatar: 'moon' });
  assert.deepEqual(setAvatar(project, SAM, null), { ok: true, avatar: null });
  assert.equal(table(spreadsheet, 'ROOMMATES')[1].avatar, '');
});

test('the avatar request cannot name someone else, carries only bundled IDs, and a bad one writes nothing', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const token = as(project, SAM).token;
  const before = spreadsheet.snapshot();
  for (const request of [
    { token, avatar: 'sun', roommate_id: ALEX }, { token, avatar: 'sun', roommate_id: SAM }, { token }, { avatar: 'sun' }, { token, avatar: undefined },
    { token, avatar: '' }, { token, avatar: 'Sun' }, { token, avatar: 'sun ' }, { token, avatar: '=HYPERLINK("x")' }, { token, avatar: '<b>x</b>' }, { token, avatar: 7 }, { token, avatar: ['sun'] },
    { token, avatar: { id: 'sun' } }, null, undefined, 'sun', [],
  ]) {
    failed(plain(project.get('setMyAvatar')(request)), 'INVALID_REQUEST');
  }
  assert.equal(spreadsheet.snapshot(), before);
  assert.deepEqual(project.lock.events, [], 'invalid requests never reach the lock');
});

test('the avatar call refuses anyone without a working session, under the lock and without writing', () => {
  const rows = fixtureSheet('ROOMMATES');
  rows[2][rows[0].indexOf('active')] = false; // Sam
  for (const token of ['v1.unsigned.token', null]) {
    const spreadsheet = database();
    const project = server(spreadsheet);
    const before = spreadsheet.snapshot();
    failed(plain(project.get('setMyAvatar')({ token: token || '', avatar: 'sun' })), 'UNAUTHENTICATED');
    assert.equal(spreadsheet.snapshot(), before);
  }
  const spreadsheet = database(LOGS, { ROOMMATES: rows });
  const project = server(spreadsheet);
  const before = spreadsheet.snapshot();
  failed(plain(project.get('setMyAvatar')({ token: as(project, SAM).token, avatar: 'sun' })), 'UNAUTHENTICATED');
  assert.equal(spreadsheet.snapshot(), before, 'a roommate who moved out cannot change anything');
});

test('a busy lock or a failed write records nothing, hides the cause and releases the lock', () => {
  const busy = database();
  failed(setAvatar(server(busy, { lock: { events: [], held: false, deny: true } }), SAM, 'sun'), 'BUSY');
  assert.equal(table(busy, 'ROOMMATES')[1].avatar, '');

  const spreadsheet = database();
  const project = server(spreadsheet);
  const sheet = spreadsheet.getSheetByName('ROOMMATES');
  const getRange = sheet.getRange.bind(sheet);
  sheet.getRange = () => {
    throw new Error('Service Spreadsheets failed 1AbC-secret');
  };
  const result = setAvatar(project, SAM, 'sun');
  failed(result, 'WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(project.lock.held, false);
  sheet.getRange = getRange;
  assert.equal(setAvatar(project, SAM, 'sun').ok, true, 'a retry works');
});

test('a hand-typed avatar in the Sheet shows as no avatar', () => {
  const rows = fixtureSheet('ROOMMATES');
  rows[2][rows[0].indexOf('avatar')] = 'not-bundled';
  const project = server(database(LOGS, { ROOMMATES: rows }));
  assert.equal(profile(project, ALEX, SAM).member.avatar, null);
  assert.equal(schedule(project).roommates.find((r) => r.roommate_id === SAM).avatar, null);
});

test('the avatar IDs the server accepts are exactly the ones the page can draw', () => {
  const server_ = loadProject();
  const accepted = [...server_.get('AVATAR_IDS')];
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'frontend', 'ScheduleView.html'), 'utf8');
  const drawn = [...page.matchAll(/^\s+\{ id: '([a-z]+)', label: '[^']+', tone: \d, glyph: /gm)].map((m) => m[1]);
  assert.deepEqual(drawn, accepted);
});
