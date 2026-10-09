'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURES, fixtureRecords, loadProject, plain } = require('./support/appsScript');

const project = loadProject();
const getCurrentTurn = project.get('getCurrentTurn_');
const previewTurns = project.get('previewTurns_');
const getSwapConflicts = project.get('getSwapConflicts_');
const planVacationSkip = project.get('planVacationSkip_');
const validateRecord = project.get('validateRecord_');

const START = new Date(FIXTURES.ROTATION[0].created_at); // Monday 2026-01-05
const ID = Object.fromEntries(FIXTURES.ROOMMATES.map((r) => [r.name.split(' ')[0], r.roommate_id]));
const NAME = Object.fromEntries(Object.entries(ID).map(([name, id]) => [id, name]));
const SLOT = Object.fromEntries(FIXTURES.ROTATION.map((s) => [NAME[s.roommate_id], s.rotation_id]));

// Weekend n has its Saturday on 2026-01-10 + 7n and is due Monday 00:00 Berlin (winter time: 23:00Z on Sunday).
const due = (n) => new Date(Date.UTC(2026, 0, 11 + 7 * n, 23));
const saturday = (n, hour = 12) => new Date(Date.UTC(2026, 0, 10 + 7 * n, hour));
const at = (month, dayOfMonth, hour = 12) => new Date(Date.UTC(2026, month - 1, dayOfMonth, hour));

/** Fixture roommates and rotation with no history, unless overridden. */
function data(overrides = {}) {
  return {
    roommates: fixtureRecords('ROOMMATES'),
    rotation: fixtureRecords('ROTATION'),
    logs: [],
    vacations: [],
    swaps: [],
    ...overrides,
  };
}

function log(owner, weekend, { by = owner, swapId = '', outcome = 'completed', resolvedAt = saturday(weekend) } = {}) {
  const performed = outcome === 'completed';
  return {
    log_id: `log-${owner}-${weekend}`,
    rotation_id: SLOT[owner],
    roommate_id: ID[by],
    swap_id: swapId,
    due_date: due(weekend),
    outcome,
    resolved_at: resolvedAt,
    completed_at: performed ? resolvedAt : '',
    notes: performed ? '' : 'Reason recorded',
  };
}

function vacation(name, start, returnDate, { recordedAt = START, id = `vacation-${name}-${start.getTime()}` } = {}) {
  return { vacation_id: id, roommate_id: ID[name], start_date: start, return_date: returnDate, created_at: recordedAt };
}

function swap(from, fromWeekend, to, toWeekend, { status = 'accepted', createdAt = START } = {}) {
  return {
    swap_id: `swap-${from}${fromWeekend}-${to}${toWeekend}`,
    from_roommate_id: ID[from],
    to_roommate_id: ID[to],
    from_due_date: due(fromWeekend),
    to_due_date: due(toWeekend),
    status,
    created_at: createdAt,
  };
}

// Arrays created inside the Apps Script context need plain() before deepEqual.
const assignees = (turns) => plain(turns.map((t) => NAME[t.assignee_id]));
const owners = (turns) => plain(turns.map((t) => NAME[t.owner_id]));
const skipped = (turn) => plain(turn.skipped_ids.map((id) => NAME[id]));
const dueTimes = (turns) => plain(turns.map((t) => t.due_at.getTime()));
const swapIds = (turns) => plain(turns.map((t) => t.swap_id));

const berlinFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'long', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
function berlinLocal(date) {
  const parts = Object.fromEntries(berlinFormat.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.hour}:${parts.minute}`;
}

// Normal rotation

test('follows position order and wraps around, one turn per weekend', () => {
  const turns = previewTurns(data(), START, 6);
  assert.deepEqual(assignees(turns), ['Alex', 'Sam', 'Jo', 'Kim', 'Alex', 'Sam']);
  assert.deepEqual(owners(turns), assignees(turns));
  assert.deepEqual(dueTimes(turns), [0, 1, 2, 3, 4, 5].map((n) => due(n).getTime()));
});

test('the first turn is assigned from rotation creation and due at the end of the first weekend', () => {
  const turn = getCurrentTurn(data(), at(1, 7));
  assert.equal(NAME[turn.assignee_id], 'Alex');
  assert.equal(turn.status, 'pending');
  assert.equal(turn.opens_at.getTime(), START.getTime());
  assert.equal(turn.weekend_starts_at.getTime(), Date.UTC(2026, 0, 9, 23));
  assert.equal(turn.due_at.getTime(), due(0).getTime());
});

test('a Saturday completion makes the next turn due the following weekend, opening that Monday', () => {
  const input = data({ logs: [log('Alex', 0)] });
  const turn = getCurrentTurn(input, at(1, 13));
  assert.equal(NAME[turn.assignee_id], 'Sam');
  assert.equal(turn.due_at.getTime(), due(1).getTime());
  assert.equal(turn.opens_at.getTime(), Date.UTC(2026, 0, 11, 23));
  assert.equal(turn.status, 'pending');
  assert.equal(getCurrentTurn(input, at(1, 10, 20)).status, 'waiting');
});

test('early completion never gives two turns in one weekend', () => {
  const turn = getCurrentTurn(data({ logs: [log('Alex', 0, { resolvedAt: at(1, 5, 20) })] }), at(1, 6));
  assert.equal(turn.due_at.getTime(), due(1).getTime());
});

test('wraps from the last position back to the first', () => {
  const turn = getCurrentTurn(data({ logs: [log('Alex', 0), log('Sam', 1), log('Jo', 2), log('Kim', 3)] }), at(2, 3));
  assert.equal(NAME[turn.assignee_id], 'Alex');
  assert.equal(turn.due_at.getTime(), due(4).getTime());
});

test('rotation order follows position, not sheet order', () => {
  const turns = previewTurns(data({ rotation: fixtureRecords('ROTATION').reverse() }), START, 4);
  assert.deepEqual(assignees(turns), ['Alex', 'Sam', 'Jo', 'Kim']);
});

// Overdue and late turns

test('a missed turn stays with its assignee, overdue, until it is resolved', () => {
  for (const now of [at(1, 14), at(2, 10), at(12, 31)]) {
    const turn = getCurrentTurn(data(), now);
    assert.equal(NAME[turn.assignee_id], 'Alex');
    assert.equal(turn.status, 'overdue');
    assert.equal(turn.due_at.getTime(), due(0).getTime());
  }
});

test('late completion keeps every due date on a Sunday night, however late and however often', () => {
  const lateOnce = getCurrentTurn(data({ logs: [log('Alex', 0, { resolvedAt: at(2, 11) })] }), at(2, 12));
  assert.equal(NAME[lateOnce.assignee_id], 'Sam');
  assert.equal(lateOnce.due_at.getTime(), Date.UTC(2026, 1, 15, 23));
  assert.equal(berlinLocal(lateOnce.due_at), 'Monday 00:00');

  const logs = [log('Alex', 0, { resolvedAt: at(1, 14) }), log('Sam', 1, { resolvedAt: at(1, 21) }), log('Jo', 2, { resolvedAt: at(1, 28) })];
  const turns = previewTurns(data({ logs }), at(1, 29), 4);
  assert.deepEqual(dueTimes(turns), [3, 4, 5, 6].map((n) => due(n).getTime()));
  turns.forEach((turn) => assert.equal(berlinLocal(turn.due_at), 'Monday 00:00'));
});

test('an admin resolution advances the queue like a completion', () => {
  const turn = getCurrentTurn(data({ logs: [log('Alex', 0, { outcome: 'admin_resolved', resolvedAt: at(1, 14) })] }), at(1, 14));
  assert.equal(NAME[turn.assignee_id], 'Sam');
  assert.equal(turn.due_at.getTime(), due(1).getTime());
  assert.equal(turn.status, 'pending');
});

test('previewing an overdue turn assumes it is resolved now', () => {
  const turns = previewTurns(data(), at(2, 11), 2);
  assert.equal(turns[0].due_at.getTime(), due(0).getTime());
  assert.equal(turns[1].due_at.getTime(), Date.UTC(2026, 1, 15, 23));
});

test('the deadline is an exclusive Monday 00:00 Berlin boundary, in winter and summer time', () => {
  const summer = fixtureRecords('ROTATION').map((slot) => ({ ...slot, created_at: at(3, 25) }));
  const cases = [
    [data(), due(0), 'Monday 00:00'],
    [data({ rotation: summer }), new Date(Date.UTC(2026, 2, 29, 22)), 'Monday 00:00'],
  ];
  for (const [input, deadline, local] of cases) {
    const justBefore = new Date(deadline.getTime() - 1);
    assert.equal(berlinLocal(justBefore), 'Sunday 23:59');
    assert.equal(berlinLocal(deadline), local);
    assert.equal(getCurrentTurn(input, justBefore).due_at.getTime(), deadline.getTime());
    assert.equal(getCurrentTurn(input, justBefore).status, 'pending');
    assert.equal(getCurrentTurn(input, deadline).status, 'overdue');
  }
});

// Cleaning log outcomes

test('rejects logs that record an unperformed cleaning as completed, or leave the outcome unclear', () => {
  const invalid = [
    { ...log('Alex', 0, { outcome: 'admin_resolved' }), completed_at: saturday(0) },
    { ...log('Alex', 0, { outcome: 'vacation_skipped' }), completed_at: saturday(0) },
    { ...log('Alex', 0, { outcome: 'admin_resolved' }), notes: '' },
    { ...log('Alex', 0), completed_at: '' },
    { ...log('Alex', 0), outcome: 'done' },
  ];
  for (const bad of invalid) assert.throws(() => previewTurns(data({ logs: [bad] }), START, 1), /CLEANING_LOGS/);
});

// Vacation and return

test('skips a roommate on vacation; on return they rejoin at their own position with no make-up turn', () => {
  const turns = previewTurns(data({ vacations: [vacation('Sam', at(1, 16), at(1, 19))] }), START, 6);
  assert.deepEqual(assignees(turns), ['Alex', 'Jo', 'Kim', 'Alex', 'Sam', 'Jo']);
  assert.deepEqual(skipped(turns[1]), ['Sam']);
  assert.deepEqual(dueTimes(turns), [0, 1, 2, 3, 4, 5].map((n) => due(n).getTime()));
});

test('skips several roommates at once and back-to-back vacations', () => {
  const vacations = [
    vacation('Sam', at(1, 16), at(1, 19)),
    vacation('Jo', at(1, 16), at(1, 19)),
    vacation('Sam', at(1, 19), at(2, 2)),
  ];
  const turns = previewTurns(data({ vacations }), START, 7);
  assert.deepEqual(assignees(turns), ['Alex', 'Kim', 'Alex', 'Jo', 'Kim', 'Alex', 'Sam']);
  assert.deepEqual(skipped(turns[1]), ['Sam', 'Jo']);
  assert.deepEqual(skipped(turns[3]), ['Sam']);
});

test('only the due weekend matters: a vacation touching it skips, one ending before it does not', () => {
  const touching = previewTurns(data({ vacations: [vacation('Sam', at(1, 18), at(1, 25))] }), START, 2);
  assert.equal(NAME[touching[1].assignee_id], 'Jo');
  const before = previewTurns(data({ vacations: [vacation('Sam', at(1, 12), at(1, 16))] }), START, 2);
  assert.equal(NAME[before[1].assignee_id], 'Sam');
});

test('when everyone is away, the turn goes to the first roommate back for a weekend', () => {
  const vacations = [
    vacation('Sam', at(1, 12), at(2, 2)),
    vacation('Alex', at(1, 12), at(2, 2)),
    vacation('Kim', at(1, 12), at(2, 2)),
    vacation('Jo', at(1, 12), at(1, 23)),
  ];
  const input = data({ logs: [log('Alex', 0)], vacations });
  const turn = getCurrentTurn(input, at(1, 13));
  assert.equal(NAME[turn.assignee_id], 'Jo');
  assert.equal(turn.due_at.getTime(), due(2).getTime());
  assert.equal(turn.status, 'waiting');
  assert.equal(getCurrentTurn(input, at(1, 20)).status, 'pending');
});

test('inactive roommates are never assigned', () => {
  const roommates = fixtureRecords('ROOMMATES').map((r) => (r.roommate_id === ID.Sam ? { ...r, active: false } : r));
  const turns = previewTurns(data({ roommates }), START, 4);
  assert.deepEqual(assignees(turns), ['Alex', 'Jo', 'Kim', 'Alex']);
  assert.deepEqual(skipped(turns[1]), []);
});

test('a vacation known when the turn was assigned skips it silently', () => {
  const turn = getCurrentTurn(data({ vacations: [vacation('Alex', at(1, 9), at(1, 13), { recordedAt: at(1, 5, 8) })] }), at(1, 6));
  assert.equal(NAME[turn.assignee_id], 'Sam');
  assert.deepEqual(skipped(turn), ['Alex']);
  assert.equal(turn.vacation_conflict_id, null);
});

test('a vacation added during the current turn is reported, and the turn can be skipped without a make-up turn', () => {
  const late = vacation('Alex', at(1, 9), at(1, 13), { recordedAt: at(1, 7), id: 'vacation-late' });
  const turn = getCurrentTurn(data({ vacations: [late] }), at(1, 8));
  assert.equal(NAME[turn.assignee_id], 'Alex');
  assert.equal(turn.vacation_conflict_id, 'vacation-late');
  assert.equal(turn.status, 'pending');

  const skip = log('Alex', 0, { outcome: 'vacation_skipped', resolvedAt: at(1, 8) });
  const turns = previewTurns(data({ vacations: [late], logs: [skip] }), at(1, 8), 5);
  assert.deepEqual(assignees(turns), ['Sam', 'Jo', 'Kim', 'Alex', 'Sam']);
  assert.equal(turns[0].vacation_conflict_id, null);
  assert.equal(turns[0].due_at.getTime(), due(1).getTime());
});

test('a planned vacation skip is a valid vacation_skipped log, and applying it leaves no make-up turn or return priority', () => {
  const away = vacation('Alex', at(1, 9), at(1, 27), { recordedAt: at(1, 7), id: 'vacation-late' });
  const input = data({ vacations: [away] });
  const now = at(1, 8);

  const plan = plain(planVacationSkip(input, now));
  assert.deepEqual(plan, {
    rotation_id: SLOT.Alex,
    roommate_id: ID.Alex,
    due_date: due(0).toISOString(),
    outcome: 'vacation_skipped',
    resolved_at: now.toISOString(),
    notes: 'Skipped for vacation vacation-late',
  });
  validateRecord('CLEANING_LOGS', planVacationSkip(input, now));

  const applied = { ...input, logs: [{ ...planVacationSkip(input, now), log_id: 'planned', swap_id: '', completed_at: '' }] };
  assert.equal(planVacationSkip(applied, now), null);
  assert.equal(planVacationSkip(applied, at(1, 20)), null);

  // Alex returns after weekends 1-2 and next comes up in position order, after Kim, once.
  const turns = previewTurns(applied, now, 9);
  assert.deepEqual(assignees(turns), ['Sam', 'Jo', 'Kim', 'Alex', 'Sam', 'Jo', 'Kim', 'Alex', 'Sam']);
  assert.equal(turns[0].vacation_conflict_id, null);
  assert.deepEqual(dueTimes(turns), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => due(n).getTime()));
});

test('nothing is planned without a vacation conflict, and the plan covers only the current turn', () => {
  assert.equal(planVacationSkip(data(), at(1, 8)), null);
  const known = vacation('Alex', at(1, 9), at(1, 13), { recordedAt: at(1, 5, 8) });
  assert.equal(planVacationSkip(data({ vacations: [known] }), at(1, 8)), null);
  const nextWeek = vacation('Sam', at(1, 16), at(1, 19), { recordedAt: at(1, 7) });
  assert.equal(planVacationSkip(data({ vacations: [nextWeek] }), at(1, 8)), null);
});

test('an owner on vacation whose turn is swapped is not planned a skip', () => {
  const input = data({ swaps: [swap('Alex', 0, 'Kim', 3)], vacations: [vacation('Alex', at(1, 9), at(1, 13), { recordedAt: at(1, 7) })] });
  const turn = getCurrentTurn(input, at(1, 8));
  assert.equal(NAME[turn.assignee_id], 'Kim');
  assert.equal(planVacationSkip(input, at(1, 8)), null);
});

// Temporary swaps

test('a swap exchanges two specified turns without changing owners or positions', () => {
  const input = data({ swaps: [swap('Alex', 0, 'Kim', 3)] });
  const turns = previewTurns(input, START, 5);
  assert.deepEqual(assignees(turns), ['Kim', 'Sam', 'Jo', 'Alex', 'Alex']);
  assert.deepEqual(owners(turns), ['Alex', 'Sam', 'Jo', 'Kim', 'Alex']);
  assert.deepEqual(swapIds(turns), ['swap-Alex0-Kim3', null, null, 'swap-Alex0-Kim3', null]);
  assert.deepEqual(plain(getSwapConflicts(input, START)), []);
});

test('a swap reaching beyond the preview still decides the current turn', () => {
  const current = getCurrentTurn(data({ swaps: [swap('Alex', 0, 'Kim', 3)] }), START);
  assert.equal(NAME[current.assignee_id], 'Kim');
});

test('normal order resumes once both swapped turns have a log', () => {
  const swapId = 'swap-Alex0-Sam1';
  const logs = [log('Alex', 0, { by: 'Sam', swapId }), log('Sam', 1, { by: 'Alex', swapId })];
  const input = data({ logs, swaps: [swap('Alex', 0, 'Sam', 1)] });
  const turns = previewTurns(input, at(1, 18), 4);
  assert.deepEqual(assignees(turns), ['Jo', 'Kim', 'Alex', 'Sam']);
  assert.deepEqual(swapIds(turns), [null, null, null, null]);
  assert.deepEqual(plain(getSwapConflicts(input, at(1, 18))), []);
});

test('after one swapped turn is logged, the other is still swapped', () => {
  const input = data({ logs: [log('Alex', 0, { by: 'Sam', swapId: 'swap-Alex0-Sam1' })], swaps: [swap('Alex', 0, 'Sam', 1)] });
  const turn = getCurrentTurn(input, at(1, 13));
  assert.equal(NAME[turn.owner_id], 'Sam');
  assert.equal(NAME[turn.assignee_id], 'Alex');
  assert.equal(turn.swap_id, 'swap-Alex0-Sam1');
});

test('only accepted swaps apply', () => {
  for (const status of ['pending', 'declined', 'cancelled']) {
    const input = data({ swaps: [swap('Alex', 0, 'Sam', 1, { status })] });
    assert.deepEqual(assignees(previewTurns(input, START, 2)), ['Alex', 'Sam']);
    assert.deepEqual(plain(getSwapConflicts(input, START)), []);
  }
});

test('a swap is never postponed: with an unavailable partner it applies to neither turn and is reported', () => {
  const input = data({ swaps: [swap('Alex', 0, 'Sam', 1)], vacations: [vacation('Sam', at(1, 8), at(1, 12))] });
  const turns = previewTurns(input, START, 2);
  assert.deepEqual(assignees(turns), ['Alex', 'Sam']);
  assert.deepEqual(swapIds(turns), [null, null]);
  assert.deepEqual(plain(getSwapConflicts(input, START)), [
    { swap_id: 'swap-Alex0-Sam1', owner_id: ID.Alex, due_date: due(0).toISOString(), reason: 'partner_unavailable' },
  ]);
});

test('a swap naming a date that is not the owner\'s turn is reported, not moved to another week', () => {
  const input = data({ swaps: [swap('Alex', 0, 'Sam', 2)] });
  assert.deepEqual(assignees(previewTurns(input, START, 3)), ['Alex', 'Sam', 'Jo']);
  assert.deepEqual(plain(getSwapConflicts(input, START)), [
    { swap_id: 'swap-Alex0-Sam2', owner_id: ID.Sam, due_date: due(2).toISOString(), reason: 'turn_not_scheduled' },
  ]);
});

test('when late completion moves the schedule, the swap stays unapplied and is reported', () => {
  const input = data({ logs: [log('Alex', 0, { resolvedAt: at(2, 11) })], swaps: [swap('Alex', 0, 'Sam', 1)] });
  const turn = getCurrentTurn(input, at(2, 12));
  assert.equal(NAME[turn.assignee_id], 'Sam');
  assert.equal(turn.swap_id, null);
  assert.deepEqual(plain(getSwapConflicts(input, at(2, 12))).map((c) => c.reason), ['turn_not_scheduled', 'turn_not_scheduled']);
});

test('two swaps cannot claim the same turn; the earlier one wins', () => {
  const first = swap('Alex', 0, 'Sam', 1);
  const second = swap('Alex', 0, 'Kim', 3, { createdAt: new Date(START.getTime() + 1) });
  const input = data({ swaps: [second, first] });
  const turns = previewTurns(input, START, 4);
  assert.deepEqual(assignees(turns), ['Sam', 'Alex', 'Jo', 'Kim']);
  assert.deepEqual(plain(getSwapConflicts(input, START)), [
    { swap_id: second.swap_id, owner_id: ID.Alex, due_date: due(0).toISOString(), reason: 'turn_already_swapped' },
  ]);
});

test('fixture history: the swap is half done, Jo is skipped while away and returns in place', () => {
  const input = data({ logs: fixtureRecords('CLEANING_LOGS'), swaps: fixtureRecords('SWAPS'), vacations: fixtureRecords('VACATIONS') });
  const now = new Date('2026-01-13T12:00:00Z');
  const current = getCurrentTurn(input, now);
  assert.equal(NAME[current.owner_id], 'Sam');
  assert.equal(NAME[current.assignee_id], 'Alex');
  assert.equal(current.swap_id, FIXTURES.SWAPS[0].swap_id);
  assert.equal(current.status, 'pending');

  const turns = previewTurns(input, now, 5);
  assert.deepEqual(assignees(turns), ['Alex', 'Kim', 'Alex', 'Sam', 'Jo']);
  assert.deepEqual(skipped(turns[1]), ['Jo']);
  assert.deepEqual(plain(getSwapConflicts(input, now)), []);
});

// Read-only, deterministic previews

test('previews and conflict checks never change their inputs and always return the same result', () => {
  const input = data({
    logs: [log('Alex', 0)],
    swaps: [swap('Sam', 1, 'Kim', 3)],
    vacations: [vacation('Kim', at(1, 24), at(2, 20))],
  });
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) Object.values(Object.freeze(value)).forEach(deepFreeze);
    return value;
  };
  deepFreeze(input);
  const before = JSON.stringify(input);
  const now = at(1, 12);
  planVacationSkip(input, now);
  const current = plain(getCurrentTurn(input, now));
  const long = plain(previewTurns(input, now, 20));

  assert.deepEqual(plain(previewTurns(input, now, 3)), long.slice(0, 3));
  assert.deepEqual(plain(previewTurns(input, now, 20)), long);
  assert.deepEqual(plain(getCurrentTurn(input, now)), current);
  assert.deepEqual(plain(getSwapConflicts(input, now)), plain(getSwapConflicts(input, now)));
  assert.equal(JSON.stringify(input), before);
});

test('the result does not depend on the order of the input records', () => {
  const input = data({
    logs: [log('Alex', 0)],
    swaps: [swap('Sam', 1, 'Kim', 3), swap('Jo', 2, 'Alex', 4, { createdAt: new Date(START.getTime() + 1) })],
    vacations: [vacation('Kim', at(1, 24), at(2, 20)), vacation('Jo', at(2, 20), at(2, 27))],
  });
  const reversed = { roommates: [...input.roommates].reverse(), rotation: [...input.rotation].reverse(), logs: input.logs, vacations: [...input.vacations].reverse(), swaps: [...input.swaps].reverse() };
  assert.deepEqual(plain(previewTurns(reversed, at(1, 12), 12)), plain(previewTurns(input, at(1, 12), 12)));
  assert.deepEqual(plain(getSwapConflicts(reversed, at(1, 12))), plain(getSwapConflicts(input, at(1, 12))));
});

// Invalid data

test('rejects inconsistent rotation data', () => {
  const rotation = fixtureRecords('ROTATION');
  assert.throws(() => previewTurns(data({ rotation: [] }), START, 1), /rotation is empty/);
  assert.throws(() => previewTurns(data({ rotation: [rotation[0], { ...rotation[1], position: 1 }] }), START, 1), /Duplicate rotation position 1/);
  assert.throws(() => previewTurns(data({ rotation: [rotation[0], { ...rotation[1], roommate_id: ID.Alex }] }), START, 1), /appears twice/);
  assert.throws(() => previewTurns(data({ rotation: [{ ...rotation[0], position: '1' }] }), START, 1), /position must be a number/);
  assert.throws(() => previewTurns(data({ logs: [{ ...log('Alex', 0), rotation_id: 'gone' }] }), START, 1), /unknown rotation slot/);
  assert.throws(() => previewTurns(data({ logs: [{ ...log('Alex', 0), resolved_at: '' }] }), START, 1), /resolved_at must be a date/);
  assert.throws(() => previewTurns(data({ vacations: [vacation('Sam', at(1, 5), at(1, 5))] }), START, 1), /must return after it starts/);
  assert.throws(() => previewTurns(data({ swaps: [{ ...swap('Alex', 0, 'Sam', 1), to_due_date: '' }] }), START, 1), /to_due_date must be a date/);
});

test('fails when no active roommate is in the rotation', () => {
  const roommates = fixtureRecords('ROOMMATES').map((r) => ({ ...r, active: false }));
  assert.throws(() => getCurrentTurn(data({ roommates }), START), /No active roommate/);
});

test('fails instead of looping when nobody is ever available', () => {
  const vacations = Object.keys(ID).map((name) => vacation(name, at(1, 1), new Date(Date.UTC(2200, 0, 1))));
  assert.throws(() => getCurrentTurn(data({ vacations }), START), /No roommate is available/);
});
