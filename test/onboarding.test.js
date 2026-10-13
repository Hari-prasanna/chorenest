'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const NOW = new Date('2026-10-13T10:00:00Z');
const ONBOARD_KEYS = ['ONBOARD_NAME', 'ONBOARD_EMAIL', 'ONBOARD_TELEGRAM', 'ONBOARD_POSITION'];
const JOHN = { name: 'John Smith', email: 'john.smith@example.com' };

/** A set-up spreadsheet with the four fixture roommates (ALX-001 to KMI-004) at positions 1-4. */
function database({ marker = 'DEV', sheets = {}, ...options } = {}) {
  const headerOnly = (name) => [fixtureSheet(name)[0]];
  const base = {
    ROOMMATES: fixtureSheet('ROOMMATES'),
    ROTATION: fixtureSheet('ROTATION'),
    CLEANING_LOGS: headerOnly('CLEANING_LOGS'),
    SWAPS: headerOnly('SWAPS'),
    VACATIONS: headerOnly('VACATIONS'),
  };
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker, sheets: { ...base, ...sheets }, ...options });
}

/** A project whose Script Properties hold an onboarding request: { name, email, telegram, position }. */
function server(spreadsheet, request = JOHN, { environment = 'DEV', ...options } = {}) {
  const properties = { ENVIRONMENT: environment, SPREADSHEET_ID: DEV_SPREADSHEET_ID };
  const keys = { name: 'ONBOARD_NAME', email: 'ONBOARD_EMAIL', telegram: 'ONBOARD_TELEGRAM', position: 'ONBOARD_POSITION' };
  for (const [field, value] of Object.entries(request)) properties[keys[field]] = value;
  return loadProject({ properties, spreadsheets: [spreadsheet], now: NOW, ...options });
}

const onboard = (project) => project.get('onboardRoommate_')();
const table = (spreadsheet, name) => {
  const [headers, ...rows] = spreadsheet.getSheetByName(name).values;
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]])));
};
const keptRequest = (project) => ONBOARD_KEYS.some((key) => key in project.properties);

/** The call must fail with `pattern`, change nothing, keep the request for a retry and release the lock. */
function refuses(spreadsheet, project, pattern, code) {
  const before = spreadsheet.snapshot();
  assert.throws(() => onboard(project), (error) => pattern.test(error.message) && (!code || error.code === code), String(pattern));
  assert.equal(spreadsheet.snapshot(), before, 'nothing is written');
  assert.equal(project.lock.held, false, 'the lock is released');
  assert.ok(keptRequest(project), 'the request is kept so the owner can fix it');
}

// Adding a roommate

test('adds the roommate with the next sequential code and the next rotation position, and nothing else', () => {
  const spreadsheet = database();
  const project = server(spreadsheet, { ...JOHN, email: '  John.Smith@Example.COM ', telegram: '@john_smith' });
  const others = JSON.stringify(['CLEANING_LOGS', 'SWAPS', 'VACATIONS'].map((n) => spreadsheet.getSheetByName(n).values));
  const existing = JSON.stringify([spreadsheet.getSheetByName('ROOMMATES').values, spreadsheet.getSheetByName('ROTATION').values]);

  assert.equal(onboard(project), 'Added JHN-005 (John Smith) at rotation position 5.');

  const added = table(spreadsheet, 'ROOMMATES')[4];
  assert.match(added.roommate_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { ...added, roommate_id: undefined, created_at: Object.prototype.toString.call(added.created_at) },
    { roommate_id: undefined, member_code: 'JHN-005', name: 'John Smith', email: 'john.smith@example.com', telegram_username: 'john_smith', active: true, welcome_sent_at: '', created_at: '[object Date]' }
  );
  const slot = table(spreadsheet, 'ROTATION')[4];
  assert.equal(slot.position, 5);
  assert.equal(slot.roommate_id, added.roommate_id);

  assert.equal(JSON.stringify(['CLEANING_LOGS', 'SWAPS', 'VACATIONS'].map((n) => spreadsheet.getSheetByName(n).values)), others);
  const rowsBefore = JSON.parse(existing);
  assert.equal(JSON.stringify(spreadsheet.getSheetByName('ROOMMATES').values.slice(0, 5)), JSON.stringify(rowsBefore[0]), 'existing roommates are untouched');
  assert.equal(JSON.stringify(spreadsheet.getSheetByName('ROTATION').values.slice(0, 5)), JSON.stringify(rowsBefore[1]), 'existing positions are untouched');
  assert.equal(keptRequest(project), false, 'the request is consumed');
  assert.ok(project.properties.ENVIRONMENT && project.properties.MAINTENANCE_UNTIL, 'configuration is kept');
  assert.deepEqual(project.lock.events, ['lock', 'unlock']);
});

test('an unused position can be chosen, gaps are fine, and the engine and API pick the new member up', () => {
  const spreadsheet = database();
  const project = server(spreadsheet, { ...JOHN, position: '10' });
  assert.match(onboard(project), /at rotation position 10\.$/);
  assert.equal(table(spreadsheet, 'ROTATION')[4].position, 10);

  const raw = project.get('getRotationSchedule')();
  const result = plain(raw);
  assert.equal(result.ok, true);
  assert.ok(result.roommates.some((r) => r.name === 'John Smith'));
  for (const roommate of result.roommates) assert.deepEqual(Object.keys(roommate).sort(), ['name', 'roommate_id'], 'no codes, emails or Telegram names are exposed');
  assert.doesNotMatch(JSON.stringify(raw), /john\.smith@|JHN-005|john_smith/);
});

test('active is the only eligibility flag: a deactivated member keeps their code and position but is never assigned', () => {
  const spreadsheet = database();
  const project = server(spreadsheet, { ...JOHN, position: '1' + '0' });
  onboard(project);
  const sheet = spreadsheet.getSheetByName('ROOMMATES');
  const activeColumn = sheet.values[0].indexOf('active');
  sheet.values[5][activeColumn] = false;
  const turns = plain(project.get('previewTurns_')({
    roommates: table(spreadsheet, 'ROOMMATES'),
    rotation: table(spreadsheet, 'ROTATION'),
    logs: [], swaps: [], vacations: [],
  }, NOW, 6));
  assert.ok(turns.every((turn) => turn.assignee_id !== table(spreadsheet, 'ROOMMATES')[4].roommate_id));
  assert.equal(sheet.values[0].includes('status'), false);
});

// Validation

test('a bad rotation position is refused before anything is written', () => {
  for (const position of ['2', '0', '-1', '1.5', 'abc', '10000', '3x']) {
    const spreadsheet = database();
    refuses(spreadsheet, server(spreadsheet, { ...JOHN, position }), /ONBOARD_POSITION|already used/, undefined);
  }
});

test('invalid names, emails and Telegram names are refused, and the request stays for correction', () => {
  const bad = [
    { name: 'x'.repeat(41) }, { name: '123' }, { name: '=SUM(1)' }, { name: '+1 Smith' }, { name: '-5 Smith' }, { name: '@john' }, { name: 'Ann\u0007' },
    { email: 'john' }, { email: 'john@' }, { email: 'john@example' }, { email: 'jo hn@example.com' }, { email: `${'a'.repeat(250)}@example.com` },
    { telegram: 'abcd' }, { telegram: 'bad name' }, { telegram: '1abcde' }, { telegram: 'a'.repeat(33) }, { telegram: 'john-smith' },
  ];
  for (const change of bad) {
    const spreadsheet = database();
    // A leading "=" is caught by the generic formula check, which has no error code.
    refuses(spreadsheet, server(spreadsheet, { ...JOHN, ...change }), /ROOMMATES: /, change.name === '=SUM(1)' ? undefined : 'ROOMMATE_INVALID');
  }
  for (const missing of ['name', 'email']) {
    const spreadsheet = database();
    refuses(spreadsheet, server(spreadsheet, { ...JOHN, [missing]: '   ' }), /Set the Script Properties/, 'ONBOARDING_INVALID');
  }
  const none = database();
  const before = none.snapshot();
  assert.throws(() => onboard(server(none, {})), /Set the Script Properties/);
  assert.equal(none.snapshot(), before);
});

test('the same member rules apply to every ROOMMATES write, not just onboarding', () => {
  const validate = loadProject().get('validateRecord_');
  const good = { member_code: 'JHN-001', name: 'John', email: 'john@example.com', telegram_username: 'john_s', active: true };
  validate('ROOMMATES', good);
  validate('ROOMMATES', { ...good, telegram_username: '' });
  validate('ROOMMATES', { ...good, member_code: 'JHN-1000' });
  for (const bad of [{ member_code: 'jhn-001' }, { member_code: 'JH-001' }, { member_code: 'JHN-01' }, { member_code: undefined }, { email: 'John@Example.com' }, { active: 'yes' }]) {
    assert.throws(() => validate('ROOMMATES', { ...good, ...bad }), /ROOMMATES|member_code is required/);
  }
});

// Duplicates and codes

test('duplicates are refused: the same email in any case, and the same Telegram name', () => {
  for (const email of ['alex@example.com', '  ALEX@Example.com ']) {
    const spreadsheet = database();
    refuses(spreadsheet, server(spreadsheet, { ...JOHN, email }), /already onboarded as ALX-001 at position 1/, 'ONBOARDING_DUPLICATE');
  }
  const spreadsheet = database();
  refuses(spreadsheet, server(spreadsheet, { ...JOHN, telegram: '@ALEX_EXAMPLE' }), /Telegram username already belongs/);
});

test('two people with the same name get different codes, in sequence', () => {
  const spreadsheet = database();
  server(spreadsheet, { name: 'Alex Example', email: 'alex2@example.com' }).get('onboardRoommate_')();
  assert.equal(table(spreadsheet, 'ROOMMATES')[4].member_code, 'ALX-005');
  const second = server(spreadsheet, { ...JOHN });
  assert.match(second.get('onboardRoommate_')(), /^Added JHN-006 /);
  assert.deepEqual(table(spreadsheet, 'ROOMMATES').map((r) => r.member_code), ['ALX-001', 'SMA-002', 'JOX-003', 'KMI-004', 'ALX-005', 'JHN-006']);
  assert.equal(new Set(table(spreadsheet, 'ROOMMATES').map((r) => r.member_code)).size, 6);
});

test('codes are sequential, never reused, and readable', () => {
  const project = loadProject();
  const next = project.get('nextMemberCode_');
  assert.equal(next('John', []), 'JHN-001');
  assert.equal(next('John', [{ member_code: 'ALX-001' }, { member_code: 'SMA-002' }]), 'JHN-003');
  assert.equal(next('John', [{ member_code: '' }, {}, { member_code: null }]), 'JHN-001', 'roommates without a code are ignored');
  assert.equal(next('John', [{ member_code: 'ABC-009' }]), 'JHN-010', 'the highest number wins, gaps are not filled');
  assert.equal(next('John', [{ member_code: 'ABC-999' }]), 'JHN-1000');
  assert.equal(next('John', [{ member_code: 'jhn-001' }]), 'JHN-002', 'case does not matter');

  const prefix = project.get('memberCodePrefix_');
  const prefixes = { John: 'JHN', 'John Smith': 'JHN', Hari: 'HRA', Jo: 'JOX', 'Alex Example': 'ALX', Zoë: 'ZOE', '李雷': 'XXX' };
  for (const [name, expected] of Object.entries(prefixes)) assert.equal(prefix(name), expected, name);
});

// Repeat execution

test('running it again adds nobody', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  onboard(project);
  assert.throws(() => onboard(project), /Set the Script Properties/);

  const again = server(spreadsheet);
  assert.throws(() => again.get('onboardRoommate_')(), (error) => error.code === 'ONBOARDING_DUPLICATE' && /already onboarded as JHN-005 at position 5/.test(error.message));
  assert.equal(table(spreadsheet, 'ROOMMATES').length, 5);
  assert.equal(table(spreadsheet, 'ROTATION').length, 5);
});

test('a run interrupted between its two writes is finished by running it again, without a second roommate', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  const rotation = spreadsheet.getSheetByName('ROTATION');
  const appendRow = rotation.appendRow.bind(rotation);
  rotation.appendRow = () => {
    throw new Error('Service Spreadsheets failed 1AbC-secret');
  };

  assert.throws(() => onboard(project), (error) => error.code === 'ONBOARDING_INCOMPLETE' && /JHN-005 was added but has no rotation position/.test(error.message) && !/secret/.test(error.message));
  assert.equal(table(spreadsheet, 'ROOMMATES').length, 5);
  assert.equal(table(spreadsheet, 'ROTATION').length, 4);
  assert.ok(keptRequest(project));
  assert.equal(project.lock.held, false);

  rotation.appendRow = appendRow;
  assert.equal(onboard(project), 'Finished onboarding JHN-005 (John Smith) at rotation position 5.');
  assert.equal(table(spreadsheet, 'ROOMMATES').length, 5, 'no second roommate');
  assert.equal(table(spreadsheet, 'ROTATION').length, 5);
  assert.equal(keptRequest(project), false);
});

// Locking

test('while another save holds the lock nothing is read or written', () => {
  const spreadsheet = database();
  const project = server(spreadsheet, JOHN, { lock: { events: [], held: false, deny: true } });
  const before = spreadsheet.snapshot();
  assert.throws(() => onboard(project), /Another save is running/);
  assert.equal(spreadsheet.snapshot(), before);
  assert.deepEqual(project.opened, []);
  assert.ok(keptRequest(project));
});

test('two runs racing: the second is refused while the first writes, and only one roommate is added', () => {
  const spreadsheet = database();
  const lock = { events: [], held: false, deny: false };
  const first = server(spreadsheet, JOHN, { lock });
  const second = server(spreadsheet, { name: 'Jane Doe', email: 'jane@example.com' }, { lock });
  const sheet = spreadsheet.getSheetByName('ROOMMATES');
  const appendRow = sheet.appendRow.bind(sheet);
  let duringWrite;
  sheet.appendRow = (row) => {
    try {
      onboard(second);
    } catch (error) {
      duringWrite = error.message;
    }
    appendRow(row);
  };

  onboard(first);
  assert.match(duringWrite, /Another save is running/);
  assert.equal(table(spreadsheet, 'ROOMMATES').length, 5);
  assert.ok(keptRequest(second), 'the refused run keeps its request');
  assert.match(onboard(second), /^Added JNA-006 /, 'it succeeds afterwards, with the next code and position');
  assert.deepEqual(table(spreadsheet, 'ROTATION').map((s) => s.position), [1, 2, 3, 4, 5, 6]);
});

test('the checks and both writes happen while the lock is held', () => {
  const spreadsheet = database();
  const project = server(spreadsheet);
  for (const sheet of spreadsheet.sheets.values()) {
    const getDataRange = sheet.getDataRange.bind(sheet);
    const appendRow = sheet.appendRow.bind(sheet);
    sheet.getDataRange = () => (project.lock.events.push('read'), getDataRange());
    sheet.appendRow = (row) => (project.lock.events.push('write'), appendRow(row));
  }
  onboard(project);
  assert.match(project.lock.events.join(' '), /^lock( read)+ write( read)* write unlock$/);
});

// Environment isolation, owner-only and no email

test('the environment and time zone safeguards apply: wrong, unset or mismatched spreadsheets are refused', () => {
  refuses(database({ marker: 'PROD' }), server(database({ marker: 'PROD' })), /belongs to PROD, not DEV/);
  const prodSheet = database({ marker: 'PROD' });
  refuses(prodSheet, server(prodSheet), /belongs to PROD, not DEV/, 'DATABASE_ENVIRONMENT_MISMATCH');
  const devSheet = database();
  refuses(devSheet, server(devSheet, JOHN, { environment: 'PROD' }), /belongs to DEV, not PROD/, 'DATABASE_ENVIRONMENT_MISMATCH');
  const invalid = database();
  refuses(invalid, server(invalid, JOHN, { environment: 'staging' }), /Invalid ENVIRONMENT/, 'CONFIG_INVALID');
  const zone = database({ timeZone: 'America/Los_Angeles' });
  refuses(zone, server(zone), /time zone America\/Los_Angeles does not match/, 'TIMEZONE_MISMATCH');
  const unset = database({ marker: null });
  refuses(unset, server(unset), /not set up/, 'DATABASE_NOT_SET_UP');

  const prod = database({ marker: 'PROD' });
  assert.match(onboard(server(prod, JOHN, { environment: 'PROD' })), /^Added JHN-005 /, 'PROD works on its own marked spreadsheet');
});

test('it is owner-only and needs the open maintenance window', () => {
  const closed = database();
  const project = server(closed, JOHN, { maintenance: false });
  assert.throws(() => onboard(project), /Maintenance is closed/);
  assert.deepEqual(project.opened, []);
  assert.ok(keptRequest(project));

  for (const activeUser of ['', 'roommate@example.com']) {
    const spreadsheet = database();
    const visitor = server(spreadsheet, JOHN, { activeUser });
    const before = spreadsheet.snapshot();
    assert.throws(() => onboard(visitor), /only be run by the script owner/);
    assert.equal(spreadsheet.snapshot(), before);
    assert.deepEqual(visitor.opened, []);
  }
});

test('no email is ever sent, and welcome_sent_at stays empty', () => {
  const dir = path.join(__dirname, '..', 'src', 'backend');
  for (const file of fs.readdirSync(dir)) assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /MailApp|GmailApp/, file);
  const spreadsheet = database();
  onboard(server(spreadsheet));
  assert.equal(table(spreadsheet, 'ROOMMATES')[4].welcome_sent_at, '');
});

// Migrating the roommates already in a real Sheet

test('a legacy five-column ROOMMATES sheet is extended without touching its rows, then onboarding works', () => {
  const legacy = [
    ['roommate_id', 'name', 'email', 'active', 'created_at'],
    ['id-hari', 'Hari', 'hari@example.com', true, new Date('2026-09-01T10:00:00Z')],
  ];
  const slots = [fixtureSheet('ROTATION')[0], ['slot-hari', 1, 'id-hari', new Date('2026-09-01T10:00:00Z')]];
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, { sheets: { ROOMMATES: legacy, ROTATION: slots } });
  const project = server(spreadsheet);
  project.get('setupDatabase_')();

  const sheet = spreadsheet.getSheetByName('ROOMMATES');
  assert.deepEqual(plain(sheet.values[0]), ['roommate_id', 'name', 'email', 'active', 'created_at', 'member_code', 'telegram_username', 'welcome_sent_at']);
  assert.deepEqual(plain(sheet.values[1].slice(0, 4)), ['id-hari', 'Hari', 'hari@example.com', true]);
  assert.equal(sheet.values[1][4].getTime(), legacy[1][4].getTime(), 'the existing row is untouched');
  assert.equal(plain(project.get('SheetDb').list('ROOMMATES'))[0].member_code, '');

  assert.match(onboard(project), /^Added JHN-001 \(John Smith\) at rotation position 2\.$/);
  assert.equal(sheet.values.length, 3);
});

test('a stored email in another case is still recognised as a duplicate', () => {
  const rows = fixtureSheet('ROOMMATES');
  const emailColumn = rows[0].indexOf('email');
  rows[1][emailColumn] = 'Alex@Example.COM';
  const spreadsheet = database({ sheets: { ROOMMATES: rows } });
  refuses(spreadsheet, server(spreadsheet, { ...JOHN, email: 'alex@example.com' }), /already onboarded as ALX-001 at position 1/, 'ONBOARDING_DUPLICATE');
});

test('without a chosen position the new member goes after the highest one, even when positions have gaps', () => {
  const rows = fixtureSheet('ROTATION');
  rows[4][rows[0].indexOf('position')] = 10; // positions are now 1, 2, 3 and 10
  const spreadsheet = database({ sheets: { ROTATION: rows } });
  assert.match(onboard(server(spreadsheet)), /at rotation position 11\.$/);
  assert.deepEqual(table(spreadsheet, 'ROTATION').map((slot) => slot.position), [1, 2, 3, 10, 11]);
});
