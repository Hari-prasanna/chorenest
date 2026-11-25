'use strict';

// The scheduled Friday reminder (src/backend/Reminder.js): trigger, Berlin Fridays, vacations, overdue turns,
// once-per-week delivery, concurrency and failures. No real trigger, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
const LIVE = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-1001234567890', APP_URL: 'https://chorenest.example.com/app', TELEGRAM_DRY_RUN: 'false' };
const FRIDAY = new Date('2026-01-16T08:30:00Z'); // Friday 09:30 Berlin (winter time)
const NEXT_FRIDAY = new Date('2026-01-23T08:30:00Z');
const [ALEX, SAM] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const SHEETS = Object.keys(FIXTURES);
const rowFor = (sheet, record) => fixtureSheet(sheet)[0].map((h) => (h in record ? record[h] : ''));
const alexDone = rowFor('CLEANING_LOGS', { log_id: 'l1', rotation_id: '33333333-3333-4333-8333-333333333333', roommate_id: ALEX, due_date: new Date('2026-01-11T23:00:00Z'), outcome: 'completed', resolved_at: new Date('2026-01-11T12:00:00Z'), completed_at: new Date('2026-01-11T12:00:00Z') });

function database({ logs = [alexDone], vacations = [] } = {}) {
  const sheets = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  sheets.CLEANING_LOGS = [sheets.CLEANING_LOGS[0], ...logs];
  sheets.SWAPS = [sheets.SWAPS[0]];
  sheets.VACATIONS = [sheets.VACATIONS[0], ...vacations];
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets });
}

const ok = () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) });
function app(spreadsheet, { now = FRIDAY, properties = LIVE, urlFetch = ok, maintenance = false, lock } = {}) {
  return loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, ...properties },
    spreadsheets: [spreadsheet], now, maintenance, urlFetch, ...(lock ? { lock } : {}),
  });
}
const run = (project) => plain(project.get('runScheduledReminder_')(project.get('new Date()')));
const state = (project) => (project.properties.REMINDER_STATE ? JSON.parse(project.properties.REMINDER_STATE) : null);

// ---------- the trigger ----------

test('installing creates exactly one Friday trigger at 9:00 Berlin, replacing any earlier one; removing deletes it', () => {
  const project = app(database(), { maintenance: true });
  assert.match(project.get('installFridayReminder')(), /every Friday between 9:00 and 10:00 Berlin time/);
  project.get('installFridayReminder')();
  assert.equal(project.triggers.length, 1, 'installing again does not add a second trigger');
  assert.deepEqual(plain(project.triggers[0].spec), { weekDay: 'FRIDAY', hour: 9, timeZone: 'Europe/Berlin' });
  assert.equal(project.triggers[0].handler, 'runFridayReminder');
  assert.deepEqual(project.fetches, [], 'installing sends nothing');
  assert.equal(state(project), null);
  assert.equal(project.get('removeFridayReminder')(), 'Friday reminder removed.');
  assert.equal(project.triggers.length, 0);
  assert.equal(project.get('removeFridayReminder')(), 'There was no Friday reminder to remove.');

  for (const options of [{ maintenance: false }, { activeUser: 'roommate@example.com' }]) {
    const closed = loadProject({ properties: { ENVIRONMENT: 'DEV' }, maintenance: true, ...options, ...(options.maintenance === false ? { maintenance: false } : {}) });
    assert.throws(() => closed.get('installFridayReminder')());
    assert.equal(closed.triggers.length, 0);
  }
});

test('the trigger handler refuses anything but this project’s own reminder trigger, so a browser call does nothing', () => {
  const project = app(database(), { maintenance: true });
  project.get('installFridayReminder')();
  const handler = project.get('runFridayReminder');
  for (const event of [undefined, null, {}, 'x', { triggerUid: '' }, { triggerUid: 'guessed-123' }, { triggerUid: 42 }]) {
    assert.deepEqual(plain(handler(event)), { ok: false, error: 'NOT_A_TRIGGER' });
  }
  assert.deepEqual(project.fetches, []);
  assert.equal(state(project), null);
  const result = plain(handler({ triggerUid: project.triggers[0].uid, authMode: 'FULL' }));
  assert.equal(result.status, 'sent');
  assert.equal(project.fetches.length, 1);
});

// ---------- Berlin Fridays and DST ----------

test('the run only acts on a Berlin Friday, and the reminder week is that Friday’s Berlin date across both clock changes', () => {
  const project = app(database());
  const week = project.get('reminderWeek_');
  const friday = project.get('isBerlinFriday_');
  const cases = [
    ['2026-01-15T23:30:00Z', true, '2026-01-16'], // Thursday 23:30 UTC is already Friday 00:30 in Berlin (winter)
    ['2026-01-16T22:59:59Z', true, '2026-01-16'],
    ['2026-01-16T23:00:00Z', false, '2026-01-17'], // Saturday 00:00 Berlin
    ['2026-03-27T08:00:00Z', true, '2026-03-27'], // the Friday before the spring change (CET)
    ['2026-04-03T07:00:00Z', true, '2026-04-03'], // the Friday after it (CEST): 09:00 Berlin
    ['2026-07-03T22:30:00Z', false, '2026-07-04'], // 00:30 Saturday in summer
    ['2026-10-23T07:30:00Z', true, '2026-10-23'], // the Friday before the autumn change (CEST)
    ['2026-10-30T08:30:00Z', true, '2026-10-30'], // the Friday after it (CET)
    ['2026-01-14T08:30:00Z', false, '2026-01-14'], // Wednesday
  ];
  for (const [iso, isFriday, key] of cases) {
    assert.equal(friday(new Date(iso)), isFriday, iso);
    assert.equal(week(new Date(iso)), key, iso);
  }
  const thursday = app(database(), { now: new Date('2026-01-15T08:30:00Z') });
  assert.deepEqual(run(thursday), { ok: true, week: '2026-01-15', skipped: 'NOT_FRIDAY' });
  assert.deepEqual(thursday.fetches, []);
});

test('the run acts only on a Berlin Friday morning (08:30-12:00), in winter and summer time, and sends nothing outside it', () => {
  const window = app(database()).get('isReminderWindow_');
  const cases = [
    ['2026-01-16T07:29:59Z', false], ['2026-01-16T07:30:00Z', true], // 08:29:59 / 08:30:00 Berlin (CET)
    ['2026-01-16T10:59:59Z', true], ['2026-01-16T11:00:00Z', false], // 11:59:59 / 12:00:00 Berlin
    ['2026-07-03T06:29:59Z', false], ['2026-07-03T06:30:00Z', true], // 08:29:59 / 08:30:00 Berlin (CEST)
    ['2026-07-03T09:59:59Z', true], ['2026-07-03T10:00:00Z', false],
    ['2026-01-16T00:00:00Z', false], ['2026-01-16T20:00:00Z', false],
  ];
  for (const [iso, inside] of cases) assert.equal(window(new Date(iso)), inside, iso);
  for (const iso of ['2026-01-16T06:00:00Z', '2026-01-16T14:00:00Z', '2026-01-16T22:30:00Z']) {
    const project = app(database(), { now: new Date(iso) });
    assert.deepEqual(run(project), { ok: true, week: '2026-01-16', skipped: 'OUTSIDE_WINDOW' }, iso);
    assert.deepEqual(project.fetches, [], iso);
    assert.equal(state(project), null, 'a refused run does not claim the week');
  }
  // A valid trigger event does not bypass the time check.
  const early = app(database(), { now: new Date('2026-01-16T06:00:00Z'), maintenance: true });
  early.get('installFridayReminder')();
  assert.equal(plain(early.get('runFridayReminder')({ triggerUid: early.triggers[0].uid })).skipped, 'OUTSIDE_WINDOW');
  assert.deepEqual(early.fetches, []);
});

// ---------- the message: vacations and overdue turns ----------

test('a vacation skip is recorded under the lock before the message is built, so the message names who really cleans', () => {
  const vacation = rowFor('VACATIONS', { vacation_id: 'v1', roommate_id: SAM, start_date: new Date('2026-01-14T23:00:00Z'), return_date: new Date('2026-01-19T23:00:00Z'), created_at: new Date('2026-01-15T09:00:00Z') });
  const spreadsheet = database({ vacations: [vacation] });
  const project = app(spreadsheet);
  const result = run(project);
  assert.equal(result.status, 'sent');
  const text = JSON.parse(project.fetches[0].options.payload).text;
  assert.match(text, /Cleaning weekend Sat 17 – Sun 18 Jan: Jo Example is up\.\nNext: Kim Example \(Sat 24 – Sun 25 Jan\)\./);
  // The page, after the same reconciliation, agrees.
  const page = plain(project.get('getRotationSchedule')({ token: project.get('issueSessionToken_')(project.get('SheetDb').list('ROOMMATES').find((r) => r.roommate_id === SAM), project.get('new Date()')) }));
  assert.equal(page.current.assignee.name, 'Jo Example');
  assert.doesNotMatch(text, /Sam Example/);
  const [, ...logs] = spreadsheet.getSheetByName('CLEANING_LOGS').values;
  const headers = spreadsheet.getSheetByName('CLEANING_LOGS').values[0];
  assert.deepEqual(logs.map((row) => row[headers.indexOf('outcome')]), ['completed', 'vacation_skipped'], 'the skip is in the Sheet, once');
  assert.ok(project.lock.events.filter((e) => e === 'lock').length >= 3, 'reconciling, claiming and finishing each take the lock');
});

test('an overdue turn on a Friday is reported as overdue, and still only once that week', () => {
  const project = app(database({ logs: [] })); // Alex's weekend of 10–11 Jan was never marked
  assert.equal(run(project).status, 'sent');
  assert.match(JSON.parse(project.fetches[0].options.payload).text, /⚠️ Alex Example hasn’t cleaned yet: the turn for Sat 10 – Sun 11 Jan is overdue\./);
  assert.equal(run(project).skipped, 'ALREADY_SENT');
  assert.equal(project.fetches.length, 1);
});

// ---------- once per week ----------

test('a week is sent once: a second run skips, and the next Friday is a new week', () => {
  const spreadsheet = database();
  const first = app(spreadsheet);
  assert.deepEqual(run(first), { ok: true, week: '2026-01-16', dryRun: false, status: 'sent' });
  assert.deepEqual({ week: state(first).week, status: state(first).status }, { week: '2026-01-16', status: 'sent' });
  assert.deepEqual(run(first), { ok: true, week: '2026-01-16', skipped: 'ALREADY_SENT' });
  assert.equal(first.fetches.length, 1);

  const later = app(spreadsheet, { now: NEXT_FRIDAY, properties: { ...LIVE, REMINDER_STATE: first.properties.REMINDER_STATE } });
  assert.equal(run(later).status, 'sent');
  assert.equal(later.fetches.length, 1);
  assert.equal(state(later).week, '2026-01-23');
});

test('two executions at once send one message: the second sees the claim taken while the first is sending', () => {
  let second = null;
  const project = app(database(), {
    urlFetch: () => {
      if (!second) second = run(project); // a concurrent execution starts while this one waits for Telegram
      return ok();
    },
  });
  const first = run(project);
  assert.equal(first.status, 'sent');
  assert.deepEqual(second, { ok: true, week: '2026-01-16', skipped: 'IN_PROGRESS' });
  assert.equal(project.fetches.length, 1);
  assert.equal(project.lock.held, false, 'the lock is never held while waiting for Telegram');
});

test('a busy lock sends nothing and claims nothing', () => {
  const project = app(database(), { lock: { events: [], held: false, deny: true } });
  assert.deepEqual(run(project), { ok: false, week: '2026-01-16', skipped: 'BUSY' });
  assert.deepEqual(project.fetches, []);
  assert.equal(state(project), null);
});

// ---------- failures ----------

test('a failure that may have delivered the message is never retried; the owner decides', () => {
  const ambiguous = [() => { throw new Error('Timeout'); }, () => ({ getResponseCode: () => 502, getContentText: () => '' }), () => ({ getResponseCode: () => 200, getContentText: () => 'garbled' })];
  for (const urlFetch of ambiguous) {
    const project = app(database(), { urlFetch });
    const result = run(project);
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.ok, false);
    assert.equal(state(project).status, 'unconfirmed');
    assert.deepEqual(run(project), { ok: true, week: '2026-01-16', skipped: 'UNCONFIRMED' });
    assert.equal(project.fetches.length, 1, 'no second attempt that week');
  }
});

test('a failure that certainly did not deliver releases the week, so running again can send it', () => {
  let attempt = 0;
  const project = app(database(), {
    urlFetch: () => (++attempt === 1
      ? { getResponseCode: () => 400, getContentText: () => JSON.stringify({ ok: false, description: 'chat not found' }) }
      : ok()),
  });
  assert.equal(run(project).status, 'failed');
  assert.equal(state(project).status, 'failed');
  assert.equal(run(project).status, 'sent', 'the retry sends');
  assert.equal(project.fetches.length, 2);

  const unconfigured = app(database(), { properties: { ...LIVE, TELEGRAM_BOT_TOKEN: '' } });
  assert.equal(run(unconfigured).status, 'failed');
  assert.deepEqual(unconfigured.fetches, []);
});

test('if the outcome cannot be saved, the claim stays "sending", which blocks a retry rather than risk a second message', () => {
  const project = app(database(), {
    urlFetch: () => {
      project.lock.deny = true; // another long save holds the lock when this run wants to record the result
      return ok();
    },
  });
  assert.equal(run(project).status, 'sent');
  assert.equal(state(project).status, 'sending');
  assert.ok(project.logs.includes('REMINDER_STATE_NOT_SAVED'));
  project.lock.deny = false;
  assert.equal(run(project).skipped, 'IN_PROGRESS');
  assert.equal(project.fetches.length, 1);
});

test('an unreadable saved state counts as no claim', () => {
  const project = app(database(), { properties: { ...LIVE, REMINDER_STATE: '{not json' } });
  assert.equal(run(project).status, 'sent');
});

// ---------- dry runs ----------

test('a DEV dry run builds the message but never touches the weekly claim, so the real run still sends', () => {
  const spreadsheet = database();
  const dry = app(spreadsheet, { properties: { ...LIVE, TELEGRAM_DRY_RUN: '' } });
  const result = run(dry);
  assert.equal(result.dryRun, true);
  assert.match(result.text, /Sam Example is up/);
  assert.deepEqual(dry.fetches, []);
  assert.equal(state(dry), null, 'nothing claimed');
  assert.equal(run(dry).dryRun, true, 'and it can be repeated');

  const claimed = JSON.stringify({ week: '2026-01-16', status: 'unconfirmed', at: FRIDAY.toISOString() });
  const blockedDry = app(spreadsheet, { properties: { ...LIVE, TELEGRAM_DRY_RUN: 'true', REMINDER_STATE: claimed } });
  assert.equal(run(blockedDry).dryRun, true, 'a dry run is not stopped by the real claim either');
  assert.equal(blockedDry.properties.REMINDER_STATE, claimed, 'and leaves it exactly as it was');

  const live = app(spreadsheet, { properties: LIVE });
  assert.equal(run(live).status, 'sent');
});

test('the token never reaches a log, a result or the saved state', () => {
  const project = app(database(), { urlFetch: () => { throw new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`); } });
  const result = run(project);
  const everything = JSON.stringify(result) + project.logs.join('\n') + project.properties.REMINDER_STATE;
  assert.ok(!everything.includes(TOKEN));
});
