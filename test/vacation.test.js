'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const [ALEX, SAM, JO, KIM] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const [ALEX_SLOT] = FIXTURES.ROTATION.map((s) => s.rotation_id);
const NAME = { [ALEX]: 'Alex', [SAM]: 'Sam', [JO]: 'Jo', [KIM]: 'Kim' };

// Weekend n has its Saturday on 2026-01-10 + 7n (the first weekend after the rotation was created on Monday the 5th).
const due = (n) => Date.UTC(2026, 0, 11 + 7 * n, 23); // Monday 00:00 Berlin after the weekend
const saturday = (n, hour = 12) => new Date(Date.UTC(2026, 0, 10 + 7 * n, hour));
const berlinMidnight = (month, day) => new Date(Date.UTC(2026, month - 1, day - 1, 23)); // winter time
const WED = new Date('2026-01-07T12:00:00Z'); // Alex's turn is open; his weekend is the 10th-11th

const rowsFor = (name, records = []) => {
  const headers = fixtureSheet(name)[0];
  return [headers, ...records.map((record) => headers.map((header) => (header in record ? record[header] : '')))];
};

const vacation = (overrides = {}) => ({
  vacation_id: 'v1',
  roommate_id: ALEX,
  start_date: berlinMidnight(1, 9), // Friday
  return_date: berlinMidnight(2, 2), // Monday: the first day back, four weeks later
  created_at: new Date('2026-01-07T10:00:00Z'), // after Alex's turn was assigned
  ...overrides,
});

function database(vacations = [], swaps = []) {
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, {
    marker: 'DEV',
    sheets: {
      ROOMMATES: fixtureSheet('ROOMMATES'),
      ROTATION: fixtureSheet('ROTATION'),
      CLEANING_LOGS: rowsFor('CLEANING_LOGS'),
      SWAPS: rowsFor('SWAPS', swaps),
      VACATIONS: rowsFor('VACATIONS', vacations),
    },
  });
}

const server = (spreadsheet, now = WED, options = {}) =>
  loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now, maintenance: false, ...options });
const schedule = (project) => plain(project.get('getRotationSchedule')());
const mark = (project) => {
  const { current } = schedule(project);
  return plain(project.get('markCleaned')({ roommate_id: current.assignee.roommate_id, rotation_id: current.rotation_id, due_at: current.due_at }));
};
const table = (spreadsheet, name) => {
  const [headers, ...rows] = spreadsheet.getSheetByName(name).values;
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]])));
};
const logs = (spreadsheet) => table(spreadsheet, 'CLEANING_LOGS');
const skips = (spreadsheet) => logs(spreadsheet).filter((log) => log.outcome === 'vacation_skipped');
const cleaner = (project) => schedule(project).current.assignee.roommate_id;

// Recording the skip

test('a vacation entered during the open turn is skipped automatically on the next page load, and recorded once', () => {
  const spreadsheet = database([vacation()]);
  const positions = JSON.stringify(spreadsheet.getSheetByName('ROTATION').values);
  const first = server(spreadsheet);

  const result = schedule(first);
  assert.equal(result.ok, true);
  assert.equal(result.current.assignee.roommate_id, SAM, 'the page already shows the result');
  assert.equal(Date.parse(result.current.due_at), due(0), 'Sam cleans the same weekend, it is not lost');

  const [row, ...extra] = skips(spreadsheet);
  assert.equal(extra.length, 0);
  assert.equal(row.rotation_id, ALEX_SLOT);
  assert.equal(row.roommate_id, ALEX);
  assert.equal(row.due_date.getTime(), due(0));
  assert.equal(row.resolved_at.getTime(), WED.getTime());
  assert.equal(row.completed_at, '', 'an unperformed cleaning is never recorded as completed');
  assert.equal(row.swap_id, '');
  assert.equal(row.notes, 'Skipped for vacation v1');
  assert.deepEqual(first.lock.events, ['lock', 'unlock']);
  assert.equal(JSON.stringify(spreadsheet.getSheetByName('ROTATION').values), positions, 'the permanent rotation is untouched');

  for (let i = 0; i < 3; i++) assert.equal(schedule(server(spreadsheet)).current.assignee.roommate_id, SAM);
  assert.equal(skips(spreadsheet).length, 1, 'more page loads add nothing');
});

test('ordinary page loads never take the lock or write', () => {
  const spreadsheet = database();
  const before = spreadsheet.snapshot();
  const project = server(spreadsheet);
  assert.equal(cleaner(project), ALEX);
  assert.equal(spreadsheet.snapshot(), before);
  assert.deepEqual(project.lock.events, []);
});

test('running the processor directly is idempotent', () => {
  const spreadsheet = database([vacation()]);
  const project = server(spreadsheet);
  assert.equal(project.get('applyVacationSkips_')(), 1);
  assert.equal(project.get('applyVacationSkips_')(), 0);
  assert.equal(skips(spreadsheet).length, 1);
});

// The four-week absence

test('over a four-week absence Alex is never assigned, the order is unchanged, and he returns without priority', () => {
  const spreadsheet = database([vacation()]);
  schedule(server(spreadsheet, WED)); // a roommate opens the page midweek, which records the skip
  const cleaners = [];
  for (let week = 0; week < 7; week++) {
    const project = server(spreadsheet, saturday(week));
    cleaners.push(NAME[cleaner(project)]);
    assert.equal(mark(project).ok, true, `week ${week}`);
  }
  assert.deepEqual(cleaners, ['Sam', 'Jo', 'Kim', 'Sam', 'Jo', 'Kim', 'Alex']);
  assert.equal(cleaners.indexOf('Alex'), 6, 'back after the vacation in his normal position, with no make-up turn');

  const all = logs(spreadsheet);
  assert.equal(skips(spreadsheet).length, 1, 'later weeks are skipped without a log: the vacation was known when they were assigned');
  assert.equal(all.filter((log) => log.outcome === 'completed').length, 7);
  assert.deepEqual(table(spreadsheet, 'ROTATION').map((slot) => slot.position), [1, 2, 3, 4], 'permanent positions never change');
});

test('if nobody opens the page until the weekend has started, the skip is still recorded and the next turn uses the following weekend', () => {
  const spreadsheet = database([vacation()]);
  const result = schedule(server(spreadsheet, saturday(0)));
  assert.equal(result.current.assignee.roommate_id, SAM);
  assert.equal(Date.parse(result.current.due_at), due(1));
  assert.equal(skips(spreadsheet).length, 1);
});

test('someone who returns for the weekend, or leaves after it, is not skipped', () => {
  const cases = [
    ['returns exactly when the weekend starts', { start_date: berlinMidnight(1, 5), return_date: berlinMidnight(1, 10) }, ALEX],
    ['leaves exactly when the weekend ends', { start_date: berlinMidnight(1, 12), return_date: berlinMidnight(2, 9) }, ALEX],
    ['is away Monday to Thursday only', { start_date: berlinMidnight(1, 5), return_date: berlinMidnight(1, 9) }, ALEX],
    ['is back one minute into the weekend', { start_date: berlinMidnight(1, 5), return_date: new Date(berlinMidnight(1, 10).getTime() + 60000) }, SAM],
    ['leaves on the Sunday', { start_date: new Date(berlinMidnight(1, 11).getTime() + 3600000), return_date: berlinMidnight(2, 2) }, SAM],
  ];
  for (const [label, dates, expected] of cases) {
    const spreadsheet = database([vacation(dates)]);
    assert.equal(cleaner(server(spreadsheet)), expected, label);
  }
});

test('an overdue turn whose assignee has since gone away is skipped, and the next turn uses the next weekend', () => {
  const tuesday = new Date('2026-01-20T12:00:00Z');
  const away = vacation({ start_date: berlinMidnight(1, 19), return_date: berlinMidnight(2, 16), created_at: new Date('2026-01-19T09:00:00Z') });
  const spreadsheet = database([away]);
  const result = schedule(server(spreadsheet, tuesday));
  assert.equal(result.current.assignee.roommate_id, SAM);
  assert.equal(Date.parse(result.current.due_at), due(2), 'the weekend of the 24th, not the one that has passed');
  assert.deepEqual(skips(spreadsheet).map((log) => log.due_date.getTime()), [due(0)]);

  for (const [label, dates] of [
    ['already back', { start_date: berlinMidnight(1, 14), return_date: berlinMidnight(1, 19) }],
    ['not left yet', { start_date: berlinMidnight(1, 25), return_date: berlinMidnight(2, 16) }],
  ]) {
    const quiet = database([vacation({ ...dates, created_at: new Date('2026-01-19T09:00:00Z') })]);
    const project = server(quiet, tuesday);
    assert.equal(schedule(project).current.status, 'overdue', label);
    assert.equal(cleaner(project), ALEX, label);
    assert.equal(skips(quiet).length, 0, label);
  }
});

test('a vacation entered before the turn was assigned needs no log, and a skipped turn cannot be completed afterwards', () => {
  const early = database([vacation({ created_at: new Date('2026-01-05T08:00:00Z') })]);
  const project = server(early);
  assert.equal(cleaner(project), SAM);
  assert.equal(logs(early).length, 0);
  assert.deepEqual(project.lock.events, []);

  const spreadsheet = database();
  const page = server(spreadsheet); // Alex's page, loaded before the vacation was entered
  const stale = { roommate_id: ALEX, rotation_id: ALEX_SLOT, due_at: new Date(due(0)).toISOString() };
  spreadsheet.getSheetByName('VACATIONS').values = rowsFor('VACATIONS', [vacation()]);
  assert.equal(cleaner(server(spreadsheet)), SAM);
  assert.equal(plain(page.get('markCleaned')(stale)).error.code, 'ALREADY_RECORDED');
  assert.equal(logs(spreadsheet).length, 1);
  assert.equal(mark(server(spreadsheet)).ok, true, 'the new current turn can be completed as usual');
});

test('completing a turn before the vacation is noticed keeps the completion and adds no skip', () => {
  const spreadsheet = database();
  const page = server(spreadsheet);
  const request = { roommate_id: ALEX, rotation_id: ALEX_SLOT, due_at: new Date(due(0)).toISOString() };
  assert.equal(plain(page.get('markCleaned')(request)).ok, true);
  spreadsheet.getSheetByName('VACATIONS').values = rowsFor('VACATIONS', [vacation()]);
  const after = server(spreadsheet, new Date('2026-01-08T12:00:00Z'));
  assert.equal(cleaner(after), SAM);
  assert.deepEqual(logs(spreadsheet).map((log) => log.outcome), ['completed']);
});

test('a swapped turn whose partner has since left is skipped with its swap id, so the swap bookkeeping stays right', () => {
  const swap = {
    swap_id: 'swap-1',
    from_roommate_id: ALEX,
    to_roommate_id: SAM,
    from_due_date: new Date(due(0)),
    to_due_date: new Date(due(2)), // Sam's own turn, which the late turn has pushed to the weekend of the 24th
    status: 'accepted',
    created_at: new Date('2026-01-06T09:00:00Z'),
  };
  const sam = vacation({ vacation_id: 'v2', roommate_id: SAM, start_date: berlinMidnight(1, 19), return_date: berlinMidnight(1, 23), created_at: new Date('2026-01-19T09:00:00Z') }); // a midweek trip
  const spreadsheet = database([sam], [swap]);
  const project = server(spreadsheet, new Date('2026-01-20T12:00:00Z'));
  schedule(project); // this page load notices that Sam, who is covering Alex's overdue turn, is away
  const [row] = skips(spreadsheet);
  assert.equal(row.roommate_id, SAM);
  assert.equal(row.rotation_id, ALEX_SLOT);
  assert.equal(row.swap_id, 'swap-1');
  assert.equal(row.completed_at, '');
  assert.equal(skips(spreadsheet).length, 1);
});

// Hand-typed rows

test('hand-typed rows: a missing created_at or id still works, and bad rows are ignored instead of breaking the page', () => {
  const typed = vacation({ vacation_id: '', created_at: '' });
  const bad = [
    vacation({ vacation_id: 'bad1', start_date: berlinMidnight(2, 2), return_date: berlinMidnight(1, 9) }),
    vacation({ vacation_id: 'bad2', start_date: 'next week' }),
    vacation({ vacation_id: 'bad3', roommate_id: '' }),
    vacation({ vacation_id: 'bad4', roommate_id: 'nobody-with-this-id' }),
    vacation({ vacation_id: 'bad5', start_date: berlinMidnight(1, 9), return_date: berlinMidnight(1, 9) }),
  ];
  const spreadsheet = database([typed, ...bad]);
  const result = schedule(server(spreadsheet));
  assert.equal(result.ok, true);
  assert.equal(result.current.assignee.roommate_id, SAM);
  assert.deepEqual(skips(spreadsheet).map((log) => log.notes), ['Skipped for vacation vacation-1']);
});

test('several people away at once are all skipped in one run, each recorded, and the order stays', () => {
  const everyoneButKim = [ALEX, SAM, JO].map((roommate_id, i) => vacation({ vacation_id: `v${i}`, roommate_id, created_at: '' }));
  const spreadsheet = database(everyoneButKim);
  const project = server(spreadsheet);
  assert.equal(cleaner(project), KIM);
  assert.deepEqual(skips(spreadsheet).map((log) => NAME[log.roommate_id]), ['Alex', 'Sam', 'Jo']);
  assert.equal(cleaner(server(spreadsheet)), KIM);
  assert.equal(skips(spreadsheet).length, 3, 'a second run adds nothing');
});

// Concurrency and failures

test('two page loads at once record one skip, and neither fails', () => {
  const spreadsheet = database([vacation()]);
  const lock = { events: [], held: false, deny: false };
  const first = server(spreadsheet, WED, { lock });
  const second = server(spreadsheet, WED, { lock });
  const sheet = spreadsheet.getSheetByName('CLEANING_LOGS');
  const appendRow = sheet.appendRow.bind(sheet);
  let during;
  sheet.appendRow = (row) => {
    during = schedule(second); // arrives while the first is writing
    appendRow(row);
  };

  assert.equal(schedule(first).current.assignee.roommate_id, SAM);
  assert.equal(during.ok, true, 'the second page is still served');
  assert.equal(skips(spreadsheet).length, 1);
  assert.deepEqual(lock.events, ['lock', 'lock-denied', 'unlock']);
  assert.equal(schedule(second).current.assignee.roommate_id, SAM);
  assert.equal(skips(spreadsheet).length, 1);
});

test('if the lock is busy or the write fails, the page is still served, nothing is recorded, and the next load retries', () => {
  const busy = database([vacation()]);
  const denied = server(busy, WED, { lock: { events: [], held: false, deny: true } });
  assert.equal(schedule(denied).ok, true);
  assert.equal(logs(busy).length, 0);

  const spreadsheet = database([vacation()]);
  const sheet = spreadsheet.getSheetByName('CLEANING_LOGS');
  const appendRow = sheet.appendRow.bind(sheet);
  sheet.appendRow = () => {
    throw new Error('Service Spreadsheets failed 1AbC-secret');
  };
  const failing = server(spreadsheet);
  const result = schedule(failing);
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(logs(spreadsheet).length, 0);
  assert.equal(failing.lock.held, false);

  sheet.appendRow = appendRow;
  assert.equal(cleaner(server(spreadsheet)), SAM);
  assert.equal(skips(spreadsheet).length, 1);
});

test('the processor never throws, and is private to the server', () => {
  const project = server(database([vacation()]), WED, { lock: { events: [], held: false, deny: true } });
  assert.doesNotThrow(() => project.get('applyVacationSkips_')());
});
