'use strict';

// Telegram reminders (src/backend/Telegram.js): message, configuration, dry run and API failures. No real network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, asSignedIn, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
const CHAT = '-1001234567890';
const URL = 'https://chorenest.example.com/app';
const WEDNESDAY = new Date('2026-01-13T12:00:00Z'); // Alex's turn (weekend of 10 Jan) is overdue
const FRIDAY = new Date('2026-01-16T12:00:00Z');
const [ALEX, SAM, JO] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const SHEETS = Object.keys(FIXTURES);
const CONFIGURED = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, APP_URL: URL };

const rowFor = (sheet, record) => fixtureSheet(sheet)[0].map((h) => (h in record ? record[h] : ''));
const alexDone = rowFor('CLEANING_LOGS', { log_id: 'l1', rotation_id: '33333333-3333-4333-8333-333333333333', roommate_id: ALEX, due_date: new Date('2026-01-11T23:00:00Z'), outcome: 'completed', resolved_at: new Date('2026-01-11T12:00:00Z'), completed_at: new Date('2026-01-11T12:00:00Z'), created_at: new Date('2026-01-11T12:00:00Z') });

/** The fixtures' household with no logs, swaps or vacations, plus whatever rows a test adds. */
function database({ logs = [], swaps = [], vacations = [], marker = 'DEV' } = {}) {
  const sheets = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  sheets.CLEANING_LOGS = [sheets.CLEANING_LOGS[0], ...logs];
  sheets.SWAPS = [sheets.SWAPS[0], ...swaps];
  sheets.VACATIONS = [sheets.VACATIONS[0], ...vacations];
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker, sheets });
}

function app(spreadsheet, { now = FRIDAY, properties = {}, environment = 'DEV', urlFetch, maintenance = false } = {}) {
  return loadProject({
    properties: { ENVIRONMENT: environment, SPREADSHEET_ID: DEV_SPREADSHEET_ID, ...properties },
    spreadsheets: [spreadsheet], now, maintenance, urlFetch,
  });
}

const reply = (status, body) => () => ({ getResponseCode: () => status, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const sentOk = reply(200, { ok: true, result: { message_id: 1 } });

// ---------- the message ----------

test('after the last turn is done, the reminder names the current cleaner, the weekend, the next cleaner and the link', () => {
  const project = app(database({ logs: [alexDone] }), { properties: CONFIGURED });
  const result = plain(project.get('sendFridayReminder_')());
  assert.equal(result.ok, true);
  assert.equal(result.text, [
    '🧹 ChoreNest reminder',
    'Cleaning weekend Sat 17 – Sun 18 Jan: Sam Example is up.',
    'Next: Jo Example (Sat 24 – Sun 25 Jan).',
    'Mark it done: ' + URL,
  ].join('\n'));
});

test('an overdue turn is called overdue, still names its cleaner, and says who comes after', () => {
  const project = app(database(), { now: WEDNESDAY, properties: CONFIGURED });
  const { text } = plain(project.get('sendFridayReminder_')());
  assert.equal(text, [
    '🧹 ChoreNest reminder',
    '⚠️ Alex Example hasn’t cleaned yet: the turn for Sat 10 – Sun 11 Jan is overdue.',
    'After that: Sam Example (Sat 17 – Sun 18 Jan).',
    'Mark it done: ' + URL,
  ].join('\n'));
});

test('a swapped turn names the partner who cleans and who it normally belongs to; weekends over a month end say both months', () => {
  const swap = rowFor('SWAPS', { swap_id: 's1', from_roommate_id: SAM, to_roommate_id: FIXTURES.ROOMMATES[3].roommate_id, from_due_date: new Date('2026-01-18T23:00:00Z'), to_due_date: new Date('2026-02-01T23:00:00Z'), status: 'accepted', created_at: new Date('2026-01-12T10:00:00Z') });
  const project = app(database({ logs: [alexDone], swaps: [swap] }));
  const { text } = plain(project.get('sendFridayReminder_')());
  assert.match(text, /Cleaning weekend Sat 17 – Sun 18 Jan: Kim Example is up\.\n\(Swapped turn: it is normally Sam Example’s\.\)\nNext: Jo Example \(Sat 24 – Sun 25 Jan\)\./);
  const later = plain(app(database({ logs: [alexDone, rowFor('CLEANING_LOGS', { log_id: 'l2', rotation_id: '44444444-4444-4444-8444-444444444444', roommate_id: SAM, due_date: new Date('2026-01-18T23:00:00Z'), outcome: 'completed', resolved_at: new Date('2026-01-17T10:00:00Z'), completed_at: new Date('2026-01-17T10:00:00Z') }), rowFor('CLEANING_LOGS', { log_id: 'l3', rotation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', roommate_id: JO, due_date: new Date('2026-01-25T23:00:00Z'), outcome: 'completed', resolved_at: new Date('2026-01-24T10:00:00Z'), completed_at: new Date('2026-01-24T10:00:00Z') })] }), { now: new Date('2026-01-30T12:00:00Z') }).get('sendFridayReminder_')());
  assert.match(later.text, /Cleaning weekend Sat 31 Jan – Sun 1 Feb: Kim Example is up\./);
});

test('someone who is away is not named: the skip the next page load will record is already reflected, and nothing is written', () => {
  const vacation = rowFor('VACATIONS', { vacation_id: 'v1', roommate_id: SAM, start_date: new Date('2026-01-14T23:00:00Z'), return_date: new Date('2026-01-19T23:00:00Z'), created_at: new Date('2026-01-15T09:00:00Z') });
  const spreadsheet = database({ logs: [alexDone], vacations: [vacation] });
  const project = app(spreadsheet);
  const before = spreadsheet.snapshot();
  const { text } = plain(project.get('sendFridayReminder_')());
  // The skip hands this very weekend to the next roommate, exactly as the page shows after recording it.
  assert.match(text, /Cleaning weekend Sat 17 – Sun 18 Jan: Jo Example is up\.\nNext: Kim Example \(Sat 24 – Sun 25 Jan\)\./);
  assert.doesNotMatch(text, /Sam Example/);
  assert.equal(spreadsheet.snapshot(), before, 'the reminder never writes to the Sheet');
  assert.deepEqual(project.lock.events, [], 'and never takes the script lock');
});

test('the link line is left out when APP_URL is missing, and names are plain text (no Markdown or HTML mode)', () => {
  const sheets = database({ logs: [alexDone] });
  const hostile = sheets.getSheetByName('ROOMMATES');
  hostile.values[2][hostile.values[0].indexOf('name')] = '<b>Sam_*[x]</b>';
  const project = app(sheets, { properties: { ...CONFIGURED, APP_URL: 'not a url', TELEGRAM_DRY_RUN: 'false' }, urlFetch: sentOk });
  const result = plain(project.get('sendFridayReminder_')());
  assert.equal(result.ok, false, 'a real send needs a valid APP_URL');
  assert.deepEqual(result.missing, ['APP_URL']);
  const dry = plain(app(sheets, { properties: { ...CONFIGURED, APP_URL: '' } }).get('sendFridayReminder_')());
  assert.doesNotMatch(dry.text, /Mark it done/);
  assert.match(dry.text, /<b>Sam_\*\[x\]<\/b> is up/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'backend', 'Telegram.js'), 'utf8');
  assert.doesNotMatch(source, /parse_mode/);
});

// ---------- configuration and the dry run ----------

test('DEV is a dry run unless explicitly "false"; PROD sends unless explicitly "true"', () => {
  const project = app(database());
  const dry = project.get('telegramDryRun_');
  for (const value of [undefined, null, '', 'true', 'TRUE', 'yes', '0', 'nonsense', ' false-ish ']) assert.equal(dry('DEV', value), true, `DEV ${value}`);
  for (const value of ['false', 'FALSE', ' false ']) assert.equal(dry('DEV', value), false, `DEV ${value}`);
  for (const value of [undefined, '', 'false', 'nonsense']) assert.equal(dry('PROD', value), false, `PROD ${value}`);
  for (const value of ['true', 'TRUE', ' true ']) assert.equal(dry('PROD', value), true, `PROD ${value}`);
});

test('a DEV dry run builds the real message without any network call, even when everything is configured', () => {
  const project = app(database({ logs: [alexDone] }), { properties: CONFIGURED });
  const result = plain(project.get('sendFridayReminder_')());
  assert.deepEqual({ ok: result.ok, dryRun: result.dryRun, missing: result.missing }, { ok: true, dryRun: true, missing: [] });
  assert.match(result.text, /Sam Example is up/);
  assert.deepEqual(project.fetches, []);
  assert.deepEqual(project.logs, ['Telegram dry run: nothing sent.']);
  const bare = plain(app(database({ logs: [alexDone] })).get('sendFridayReminder_')());
  assert.deepEqual(bare.missing, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'APP_URL'], 'a dry run names what a real send would still need');
});

test('configuration is validated by name only: malformed values are reported, never echoed', () => {
  const read = (properties) => plain(app(database(), { properties }).get('readTelegramConfig_')());
  assert.deepEqual(read(CONFIGURED).missing, []);
  const cases = [
    [{ ...CONFIGURED, TELEGRAM_BOT_TOKEN: 'not-a-token' }, ['TELEGRAM_BOT_TOKEN']],
    [{ ...CONFIGURED, TELEGRAM_BOT_TOKEN: TOKEN + ' extra' }, ['TELEGRAM_BOT_TOKEN']],
    [{ ...CONFIGURED, TELEGRAM_CHAT_ID: 'my chat' }, ['TELEGRAM_CHAT_ID']],
    [{ ...CONFIGURED, TELEGRAM_CHAT_ID: '@chorenest_household' }, []],
    [{ ...CONFIGURED, APP_URL: 'http://insecure.example.com' }, ['APP_URL']],
    [{ ...CONFIGURED, APP_URL: 'https://a b.example.com' }, ['APP_URL']],
    [{}, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'APP_URL']],
  ];
  for (const [properties, missing] of cases) {
    const config = read(properties);
    assert.deepEqual(config.missing, missing, JSON.stringify(properties).replace(TOKEN, '<token>'));
  }
});

test('a real send needs every property and sends nothing otherwise', () => {
  for (const drop of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'APP_URL']) {
    const properties = { ...CONFIGURED, TELEGRAM_DRY_RUN: 'false' };
    delete properties[drop];
    const project = app(database({ logs: [alexDone] }), { properties, urlFetch: sentOk });
    assert.deepEqual(plain(project.get('sendFridayReminder_')()), { ok: false, dryRun: false, delivered: 'no', error: 'TELEGRAM_NOT_CONFIGURED', missing: [drop] });
    assert.deepEqual(project.fetches, []);
  }
});

// ---------- sending and failures ----------

test('a real send posts plain JSON to the bot API with the chat and the message, and reports success', () => {
  const project = app(database({ logs: [alexDone] }), { properties: { ...CONFIGURED, TELEGRAM_DRY_RUN: 'false' }, urlFetch: sentOk });
  const result = plain(project.get('sendFridayReminder_')());
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(project.fetches.length, 1);
  const [{ url, options }] = project.fetches;
  assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(options.method, 'post');
  assert.equal(options.muteHttpExceptions, true);
  assert.deepEqual(JSON.parse(options.payload), { chat_id: CHAT, text: result.text, disable_web_page_preview: true });
  assert.deepEqual(project.logs, ['Telegram reminder sent.']);
});

test('PROD sends by default, and stays quiet only when told to', () => {
  const sent = app(database({ logs: [alexDone], marker: 'PROD' }), { environment: 'PROD', properties: CONFIGURED, urlFetch: sentOk });
  assert.equal(plain(sent.get('sendFridayReminder_')()).dryRun, false);
  assert.equal(sent.fetches.length, 1);
  const quiet = app(database({ logs: [alexDone], marker: 'PROD' }), { environment: 'PROD', properties: { ...CONFIGURED, TELEGRAM_DRY_RUN: 'true' } });
  assert.equal(plain(quiet.get('sendFridayReminder_')()).dryRun, true);
  assert.deepEqual(quiet.fetches, []);
});

test('every Telegram failure becomes a short code, and the token never appears in a result or a log', () => {
  // [code, delivered, answer]: 'no' is certainly not delivered (safe to retry), 'unknown' may have been delivered.
  const failures = [
    ['TELEGRAM_UNREACHABLE', 'unknown', () => { throw new Error(`Exception: DNS error: https://api.telegram.org/bot${TOKEN}/sendMessage`); }],
    ['TELEGRAM_UNREACHABLE', 'unknown', () => { throw new Error(TOKEN); }],
    ['TELEGRAM_RATE_LIMITED', 'no', reply(429, { ok: false, error_code: 429, description: `Too Many Requests ${TOKEN}`, parameters: { retry_after: 5 } })],
    ['TELEGRAM_HTTP_401', 'no', reply(401, { ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` })],
    ['TELEGRAM_HTTP_400', 'no', reply(400, { ok: false, description: `Bad Request: chat not found ${CHAT}` })],
    ['TELEGRAM_HTTP_500', 'unknown', reply(500, '<html>Internal Server Error</html>')],
    ['TELEGRAM_HTTP_502', 'unknown', reply(502, '')],
    ['TELEGRAM_HTTP_403', 'no', reply(403, '')],
    ['TELEGRAM_REJECTED', 'no', reply(200, { ok: false, description: 'nope' })],
    ['TELEGRAM_UNCONFIRMED', 'unknown', reply(200, 'not json')],
    ['TELEGRAM_UNCONFIRMED', 'unknown', () => ({ getResponseCode: () => { throw new Error(`broken ${TOKEN}`); }, getContentText: () => '' })],
  ];
  for (const [code, delivered, urlFetch] of failures) {
    const project = app(database({ logs: [alexDone] }), { properties: { ...CONFIGURED, TELEGRAM_DRY_RUN: 'false' }, urlFetch });
    const result = plain(project.get('sendFridayReminder_')());
    assert.equal(result.ok, false);
    assert.equal(result.error, code);
    assert.equal(result.delivered, delivered, code);
    const everything = JSON.stringify(result) + project.logs.join('\n');
    assert.ok(!everything.includes(TOKEN), `${code}: no token in results or logs`);
    assert.ok(!everything.includes(CHAT), `${code}: no chat id either`);
    assert.deepEqual(project.logs, ['Telegram reminder failed: ' + code]);
  }
});

test('a Telegram failure cannot affect cleaning: nothing is written, no lock is taken, and the turn can still be marked done', () => {
  const spreadsheet = database({ logs: [alexDone] });
  const project = app(spreadsheet, { properties: { ...CONFIGURED, TELEGRAM_DRY_RUN: 'false' }, urlFetch: () => { throw new Error('boom'); } });
  const before = spreadsheet.snapshot();
  assert.equal(plain(project.get('sendFridayReminder_')()).error, 'TELEGRAM_UNREACHABLE');
  assert.equal(spreadsheet.snapshot(), before);
  assert.deepEqual(project.lock.events, []);

  const weekend = app(spreadsheet, { now: new Date('2026-01-17T10:00:00Z'), properties: { ...CONFIGURED, TELEGRAM_DRY_RUN: 'false' }, urlFetch: () => { throw new Error('boom'); } });
  const schedule = plain(weekend.get('getRotationSchedule')(asSignedIn(weekend, { roommate_id: SAM })));
  assert.equal(schedule.ok, true);
  const marked = plain(weekend.get('markCleaned')(asSignedIn(weekend, { roommate_id: SAM, rotation_id: schedule.current.rotation_id, due_at: schedule.current.due_at })));
  assert.equal(marked.ok, true, 'cleaning works whatever Telegram does');
});

test('if the reminder cannot be built, nothing is sent and the reason is a fixed code', () => {
  const broken = database({ logs: [alexDone] });
  const rotation = broken.getSheetByName('ROTATION');
  rotation.values[2][rotation.values[0].indexOf('position')] = 1; // two people at position 1
  const project = app(broken, { properties: { ...CONFIGURED, TELEGRAM_DRY_RUN: 'false' }, urlFetch: sentOk });
  const result = plain(project.get('sendFridayReminder_')());
  assert.deepEqual(result, { ok: false, dryRun: false, delivered: 'no', error: 'REMINDER_NOT_BUILT' });
  assert.deepEqual(project.fetches, []);
  assert.deepEqual(project.logs, ['REMINDER_NOT_BUILT']);
});

// ---------- the owner's preview ----------

test('the editor preview shows the message, never sends it, and only runs for the owner in the maintenance window', () => {
  const project = app(database({ logs: [alexDone] }), { properties: { ...CONFIGURED, TELEGRAM_DRY_RUN: 'false' }, urlFetch: sentOk, maintenance: true });
  const preview = plain(project.get('previewFridayReminder')());
  assert.match(preview.text, /Sam Example is up/);
  assert.equal(preview.wouldSend, true);
  assert.deepEqual(project.fetches, [], 'a preview is never sent');
  const dry = plain(app(database({ logs: [alexDone] }), { maintenance: true }).get('previewFridayReminder')());
  assert.equal(dry.wouldSend, false);
  assert.deepEqual(dry.missing, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'APP_URL']);
  assert.throws(() => app(database(), { maintenance: false }).get('previewFridayReminder')(), /Maintenance is closed/);
});

test('nothing in Telegram.js is browser-callable, and it logs only fixed words and codes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'backend', 'Telegram.js'), 'utf8');
  const functions = [...source.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]);
  assert.ok(functions.length >= 8);
  assert.deepEqual(functions.filter((name) => !name.endsWith('_')), []);
  for (const [, argument] of source.matchAll(/console\.\w+\(([^;]*)\);/g)) assert.doesNotMatch(argument, /token|config|response|body|error\.message|chatId/i, argument);
  assert.doesNotMatch(source, /Logger\./);
});
