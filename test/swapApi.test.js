'use strict';

// Temporary turn swaps (src/backend/SwapApi.js), checked with the real rotation engine.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain, sessionToken } = require('./support/appsScript');

const NOW = new Date('2026-01-13T12:00:00Z'); // a Tuesday
const [ALEX, SAM, JO, KIM] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const SHEETS = Object.keys(FIXTURES);
const iso = (date) => new Date(date).toISOString();

/** The fixtures' household and rotation, with no cleaning history, swaps or vacations yet (plus `extra` sheets). */
function database(extra = {}) {
  const sheets = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  for (const name of ['CLEANING_LOGS', 'SWAPS', 'VACATIONS']) sheets[name] = [sheets[name][0]];
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets: { ...sheets, ...extra } });
}

const app = (spreadsheet, now = NOW, options = {}) =>
  loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now, maintenance: false, ...options });
const call = (project, name, roommateId, body = {}) => plain(project.get(name)({ token: sessionToken(project, roommateId), ...body }));
const code = (result) => (result.ok ? 'OK' : result.error.code);

/** The next turns as the engine sees them now: { owner, assignee, due, starts, swap }. */
function turns(project, count = 12) {
  const data = project.get('toRotationData_')(project.get('SheetDb').listMany(['ROOMMATES', 'ROTATION', 'CLEANING_LOGS', 'SWAPS', 'VACATIONS']));
  return plain(project.get('previewTurns_')(data, project.get('new Date()'), count)).map((t) => ({ owner: t.owner_id, assignee: t.assignee_id, due: t.due_at, starts: t.weekend_starts_at, swap: t.swap_id }));
}
const turnOf = (list, owner, nth = 0) => list.filter((t) => t.owner === owner && Date.parse(t.starts) > NOW.getTime())[nth];
const rows = (spreadsheet, name) => {
  const [headers, ...values] = spreadsheet.getSheetByName(name).values;
  return values.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
};

/** Alex asks Sam: Alex gives his next turn and takes Sam's next one. */
function ask(project, from = ALEX, to = SAM) {
  const list = turns(project);
  const mine = turnOf(list, from);
  const theirs = turnOf(list, to);
  return { mine, theirs, result: call(project, 'requestSwap', from, { your_due_at: mine.due, partner_id: to, their_due_at: theirs.due }) };
}

test('a request is pending and changes nothing until the other roommate accepts it', () => {
  const spreadsheet = database();
  const project = app(spreadsheet);
  const before = turns(project);
  const { mine, theirs, result } = ask(project);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual({ ...result.swap, swap_id: 'x', created_at: 'x' }, {
    swap_id: 'x', status: 'pending', direction: 'outgoing', partner: { roommate_id: SAM, name: 'Sam Example' }, your_due_at: mine.due, their_due_at: theirs.due,
    your_weekend_starts_at: mine.starts, their_weekend_starts_at: theirs.starts, not_applied: false, created_at: 'x',
  });
  const [row] = rows(spreadsheet, 'SWAPS');
  assert.deepEqual([row.from_roommate_id, row.to_roommate_id, iso(row.from_due_date), iso(row.to_due_date), row.status], [ALEX, SAM, mine.due, theirs.due, 'pending']);
  assert.deepEqual(turns(project), before, 'a pending request assigns nothing');
});

test('accepting swaps exactly those two weekends; ownership, the rotation order and later turns stay as they were', () => {
  const spreadsheet = database();
  const project = app(spreadsheet);
  const rotation = JSON.stringify(spreadsheet.getSheetByName('ROTATION').values);
  const before = turns(project, 12);
  const { mine, theirs, result } = ask(project);
  const accepted = call(project, 'acceptSwap', SAM, { swap_id: result.swap.swap_id });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.swap.direction, 'incoming');
  assert.equal(rows(spreadsheet, 'SWAPS')[0].status, 'accepted');

  const after = turns(project, 12);
  assert.deepEqual(after.map((t) => [t.owner, t.due]), before.map((t) => [t.owner, t.due]), 'same owners on the same weekends');
  after.forEach((turn, i) => {
    const expected = turn.due === mine.due ? SAM : turn.due === theirs.due ? ALEX : before[i].assignee;
    assert.equal(turn.assignee, expected, turn.due);
  });
  assert.equal(JSON.stringify(spreadsheet.getSheetByName('ROTATION').values), rotation, 'ROTATION is never written');
  assert.deepEqual(rows(spreadsheet, 'CLEANING_LOGS'), [], 'history is never written');
});

test('only the receiving roommate can accept or decline, and an answered request stays answered', () => {
  const project = app(database());
  const { result } = ask(project);
  const id = { swap_id: result.swap.swap_id };
  for (const [who, name] of [[ALEX, 'acceptSwap'], [JO, 'acceptSwap'], [ALEX, 'declineSwap'], [KIM, 'declineSwap']]) {
    assert.equal(code(call(project, name, who, id)), 'SWAP_NOT_YOURS', `${name} by ${who}`);
  }
  assert.equal(code(call(project, 'declineSwap', SAM, id)), 'OK');
  for (const name of ['acceptSwap', 'declineSwap']) assert.equal(code(call(project, name, SAM, id)), 'SWAP_NOT_PENDING');
  assert.equal(code(call(project, 'cancelSwap', ALEX, id)), 'SWAP_NOT_PENDING');
  assert.equal(code(call(project, 'acceptSwap', SAM, { swap_id: 'missing' })), 'SWAP_NOT_FOUND');
});

test('only the requester can cancel, and only while it is pending', () => {
  const spreadsheet = database();
  const project = app(spreadsheet);
  const { result } = ask(project);
  const id = { swap_id: result.swap.swap_id };
  assert.equal(code(call(project, 'cancelSwap', SAM, id)), 'SWAP_NOT_YOURS');
  assert.equal(code(call(project, 'cancelSwap', ALEX, id)), 'OK');
  assert.equal(rows(spreadsheet, 'SWAPS')[0].status, 'cancelled');
  assert.equal(code(call(project, 'acceptSwap', SAM, id)), 'SWAP_NOT_PENDING');
  assert.equal(ask(project).result.ok, true, 'the turns are free again');
});

test('a swap needs two different roommates’ own upcoming turns that have not started', () => {
  const project = app(database());
  const list = turns(project);
  const alex = turnOf(list, ALEX);
  const sam = turnOf(list, SAM);
  const jo = turnOf(list, JO);
  const request = (who, body) => code(call(project, 'requestSwap', who, body));
  assert.equal(request(ALEX, { your_due_at: alex.due, partner_id: ALEX, their_due_at: turnOf(list, ALEX, 1).due }), 'SWAP_SELF');
  assert.equal(request(ALEX, { your_due_at: sam.due, partner_id: SAM, their_due_at: alex.due }), 'SWAP_TURN_NOT_FOUND', 'you can only give away your own turn');
  assert.equal(request(ALEX, { your_due_at: alex.due, partner_id: SAM, their_due_at: jo.due }), 'SWAP_TURN_NOT_FOUND', 'and only take the partner’s own turn');
  assert.equal(request(ALEX, { your_due_at: alex.due, partner_id: 'nobody', their_due_at: sam.due }), 'SWAP_TURN_NOT_FOUND');
  assert.equal(request(ALEX, { your_due_at: '2025-01-05T23:00:00.000Z', partner_id: SAM, their_due_at: sam.due }), 'SWAP_TURN_NOT_FOUND', 'a past date');
  for (const body of [{}, { your_due_at: alex.due, partner_id: SAM }, { your_due_at: 'next week', partner_id: SAM, their_due_at: sam.due },
    { your_due_at: alex.due, partner_id: SAM, their_due_at: sam.due, roommate_id: SAM }, { your_due_at: alex.due, partner_id: 'has space', their_due_at: sam.due }]) {
    assert.equal(request(ALEX, body), 'INVALID_REQUEST', JSON.stringify(body));
  }

  // The current turn is Alex's, overdue since Sunday: it stays with its assignee and cannot be swapped away.
  const current = list[0];
  assert.equal(current.owner, ALEX);
  assert.ok(Date.parse(current.due) < NOW.getTime(), 'overdue');
  assert.equal(request(ALEX, { your_due_at: current.due, partner_id: SAM, their_due_at: sam.due }), 'SWAP_TURN_STARTED');
});

test('a turn can be in only one pending or accepted swap, so duplicates and conflicts are refused', () => {
  const project = app(database());
  const { mine, theirs, result } = ask(project);
  assert.equal(ask(project).result.error.code, 'SWAP_TURN_TAKEN', 'the same request again');
  const jo = turnOf(turns(project), JO);
  assert.equal(code(call(project, 'requestSwap', JO, { your_due_at: jo.due, partner_id: SAM, their_due_at: theirs.due })), 'SWAP_TURN_TAKEN', 'Sam’s turn is already asked for');
  assert.equal(code(call(project, 'requestSwap', SAM, { your_due_at: theirs.due, partner_id: ALEX, their_due_at: mine.due })), 'SWAP_TURN_TAKEN', 'the mirror image');
  call(project, 'acceptSwap', SAM, { swap_id: result.swap.swap_id });
  assert.equal(code(call(project, 'requestSwap', JO, { your_due_at: jo.due, partner_id: ALEX, their_due_at: mine.due })), 'SWAP_TURN_TAKEN', 'an accepted turn is taken');
});

test('nobody can take a turn on a weekend they are away; a vacation added later makes accepting fail', () => {
  const vacations = (roommateId, starts, due) => [fixtureSheet('VACATIONS')[0], ['v-1', roommateId, new Date(Date.parse(starts) - 86400e3), new Date(due), new Date('2026-01-01T00:00:00Z'), '']];
  const probe = app(database());
  const alexTurn = turnOf(turns(probe), ALEX);
  const away = app(database({ VACATIONS: vacations(SAM, alexTurn.starts, alexTurn.due) }));
  assert.equal(ask(away).result.error.code, 'SWAP_PARTNER_UNAVAILABLE');

  const spreadsheet = database();
  const project = app(spreadsheet);
  const { mine, result } = ask(project);
  assert.equal(code(call(project, 'saveVacation', SAM, { start_date: mine.starts.slice(0, 10), return_date: new Date(Date.parse(mine.due) + 86400e3).toISOString().slice(0, 10) })), 'OK');
  assert.equal(code(call(project, 'acceptSwap', SAM, { swap_id: result.swap.swap_id })), 'SWAP_STALE');
  assert.equal(rows(spreadsheet, 'SWAPS')[0].status, 'pending', 'it stays open to be declined or cancelled');
  assert.equal(code(call(project, 'declineSwap', SAM, { swap_id: result.swap.swap_id })), 'OK');
});

test('the partner completes a swapped turn with its swap recorded, and a completed turn cannot be swapped again', () => {
  // Alex's overdue turn (due Sun 11 Jan) is done, so Sam's turn (weekend of 17 Jan) is the current, not yet started one.
  const logHeaders = fixtureSheet('CLEANING_LOGS')[0];
  const done = { log_id: 'log-1', rotation_id: '33333333-3333-4333-8333-333333333333', roommate_id: ALEX, due_date: new Date('2026-01-11T23:00:00Z'), outcome: 'completed', resolved_at: new Date('2026-01-11T12:00:00Z'), completed_at: new Date('2026-01-11T12:00:00Z'), created_at: new Date('2026-01-11T12:00:00Z') };
  const spreadsheet = database({ CLEANING_LOGS: [logHeaders, logHeaders.map((h) => (h in done ? done[h] : ''))] });
  const project = app(spreadsheet);
  const [current] = turns(project);
  assert.equal(current.owner, SAM);
  const jo = turnOf(turns(project), JO);
  const asked = call(project, 'requestSwap', SAM, { your_due_at: current.due, partner_id: JO, their_due_at: jo.due });
  assert.equal(code(call(project, 'acceptSwap', JO, { swap_id: asked.swap.swap_id })), 'OK');

  const weekend = app(spreadsheet, new Date(Date.parse(current.starts) + 3600e3));
  const schedule = plain(weekend.get('getRotationSchedule')({ token: sessionToken(weekend, JO) }));
  assert.equal(schedule.current.owner.roommate_id, SAM, 'still Sam’s turn in the rotation');
  assert.equal(schedule.current.assignee.roommate_id, JO, 'Jo cleans it this time');
  assert.equal(code(call(weekend, 'markCleaned', SAM, { rotation_id: schedule.current.rotation_id, due_at: schedule.current.due_at })), 'NOT_YOUR_TURN');
  assert.equal(code(call(weekend, 'markCleaned', JO, { rotation_id: schedule.current.rotation_id, due_at: schedule.current.due_at })), 'OK');
  const log = rows(spreadsheet, 'CLEANING_LOGS').find((row) => row.roommate_id === JO);
  assert.equal(log.swap_id, asked.swap.swap_id);
  assert.equal(rows(spreadsheet, 'CLEANING_LOGS').length, 2, 'the earlier record is untouched');

  // Sam's turn is history now, so it is not upcoming and cannot be offered again.
  const after = app(spreadsheet, new Date(Date.parse(current.due) + 3600e3));
  const kim = turnOf(turns(after), KIM);
  assert.equal(code(call(after, 'requestSwap', SAM, { your_due_at: current.due, partner_id: KIM, their_due_at: kim.due })), 'SWAP_TURN_NOT_FOUND');
});
test('every swap call needs a valid session, waits its turn for the lock, and lists only your own swaps', () => {
  const spreadsheet = database();
  const project = app(spreadsheet);
  const shapes = {
    requestSwap: { your_due_at: NOW.toISOString(), partner_id: SAM, their_due_at: NOW.toISOString() },
    acceptSwap: { swap_id: 'x' }, declineSwap: { swap_id: 'x' }, cancelSwap: { swap_id: 'x' }, listSwaps: {},
  };
  for (const [name, body] of Object.entries(shapes)) {
    assert.equal(code(plain(project.get(name)({ token: 'v1.forged.token', ...body }))), 'UNAUTHENTICATED', name);
    assert.equal(code(plain(project.get(name)(null))), 'INVALID_REQUEST', name);
    assert.equal(code(plain(project.get(name)({ token: 'v1.forged.token', ...body, role: 'ADMIN' }))), 'INVALID_REQUEST', name);
  }
  const pending = app(database());
  pending.get('SheetDb').update('ROOMMATES', SAM, { must_change_password: true, password_expires_at: new Date(NOW.getTime() + 3600e3) });
  assert.equal(code(call(pending, 'listSwaps', SAM)), 'PASSWORD_CHANGE_REQUIRED');

  const busy = app(spreadsheet, NOW, { lock: { events: [], held: false, deny: true } });
  const before = spreadsheet.snapshot();
  const list = turns(busy);
  assert.equal(code(call(busy, 'requestSwap', ALEX, { your_due_at: turnOf(list, ALEX).due, partner_id: SAM, their_due_at: turnOf(list, SAM).due })), 'BUSY');
  assert.equal(spreadsheet.snapshot(), before);

  const { result } = ask(project);
  assert.deepEqual(call(project, 'listSwaps', ALEX).swaps.map((s) => [s.direction, s.status]), [['outgoing', 'pending']]);
  assert.deepEqual(call(project, 'listSwaps', SAM).swaps.map((s) => [s.direction, s.status, s.partner.name]), [['incoming', 'pending', 'Alex Example']]);
  assert.deepEqual(call(project, 'listSwaps', JO).swaps, [], 'others see nothing');
  call(project, 'declineSwap', SAM, { swap_id: result.swap.swap_id });
  assert.deepEqual(call(project, 'listSwaps', ALEX).swaps, [], 'answered requests drop off');
});

test('listSwaps also offers the turns that can still be swapped, and flags an accepted swap the engine cannot apply', () => {
  const spreadsheet = database();
  const project = app(spreadsheet);
  const list = turns(project);
  const first = call(project, 'listSwaps', ALEX);
  assert.equal(first.ok, true);
  assert.ok(first.turns.length > 0 && first.turns.length <= 16);
  assert.ok(first.turns.every((t) => Date.parse(t.weekend_starts_at) > NOW.getTime()), 'only weekends that have not started');
  assert.deepEqual(Object.keys(first.turns[0]).sort(), ['due_at', 'owner', 'weekend_starts_at']);
  assert.equal(first.turns.some((t) => t.due === list[0].due), false);
  assert.deepEqual(first.turns[0].owner, { roommate_id: SAM, name: 'Sam Example' });
  assert.doesNotMatch(JSON.stringify(first), /@example\.com|password|token/);

  const { mine, theirs, result } = ask(project);
  const taken = call(project, 'listSwaps', JO).turns.map((t) => t.due_at);
  assert.equal(taken.includes(mine.due) || taken.includes(theirs.due), false, 'turns in a pending swap are not offered');

  call(project, 'acceptSwap', SAM, { swap_id: result.swap.swap_id });
  assert.equal(call(project, 'listSwaps', SAM).swaps[0].not_applied, false);
  // A vacation typed into the Sheet afterwards: the engine cannot apply the accepted swap any more.
  const vacationHeaders = fixtureSheet('VACATIONS')[0];
  const row = { vacation_id: 'v-late', roommate_id: SAM, start_date: new Date(Date.parse(mine.starts) - 86400e3), return_date: new Date(Date.parse(mine.due) + 86400e3), created_at: new Date(NOW.getTime() + 1) };
  spreadsheet.getSheetByName('VACATIONS').appendRow(vacationHeaders.map((h) => (h in row ? row[h] : '')));
  const flagged = call(project, 'listSwaps', SAM).swaps[0];
  assert.equal(flagged.status, 'accepted');
  assert.equal(flagged.not_applied, true);
});
