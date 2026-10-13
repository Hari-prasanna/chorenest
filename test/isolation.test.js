'use strict';

// Security regression tests for the trust-based V1 model: what the browser can reach, what it can learn,
// and what it can write.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DEV_SPREADSHEET_ID, PROD_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const WRAPPERS = 'EditorTools.js';
const backendFiles = () => fs.readdirSync(path.join(ROOT, 'src', 'backend')).filter((f) => f.endsWith('.js'));
const declared = (source) => [...source.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)].map((match) => match[1]);
// google.script.run can call every top-level function whose name does not end in an underscore.
const browserCallable = (files) => files.flatMap((file) => declared(read(`src/backend/${file}`))).filter((name) => !name.endsWith('_')).sort();

const NOW = new Date('2026-01-13T12:00:00Z'); // the fixture turn (Sam's, covered by Alex) is open
const ALL_SHEETS = ['ROOMMATES', 'ROTATION', 'CLEANING_LOGS', 'SWAPS', 'VACATIONS'];

function database({ marker = 'DEV', sheets = {}, ...options } = {}) {
  const values = Object.fromEntries(ALL_SHEETS.map((name) => [name, fixtureSheet(name)]));
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker, sheets: { ...values, ...sheets }, ...options });
}

function webApp(spreadsheet, { environment = 'DEV', ...options } = {}) {
  return loadProject({
    properties: { ENVIRONMENT: environment, SPREADSHEET_ID: DEV_SPREADSHEET_ID },
    spreadsheets: [spreadsheet],
    now: NOW,
    maintenance: false,
    ...options,
  });
}

const schedule = (project) => plain(project.get('getRotationSchedule')());
const mark = (project, request) => plain(project.get('markCleaned')(request));
const claimFor = (project, overrides = {}) => {
  const { current } = schedule(project);
  return { roommate_id: current.assignee.roommate_id, rotation_id: current.rotation_id, due_at: current.due_at, ...overrides };
};

// What the browser can reach

test('the browser can call exactly the six page functions; maintenance logic is private', () => {
  const files = backendFiles().filter((file) => file !== WRAPPERS);
  // The schedule, the cleaning completion, and the three vacation functions, each validated on the server.
  assert.deepEqual(browserCallable(files), ['cancelVacation', 'doGet', 'getRotationSchedule', 'listVacations', 'markCleaned', 'saveVacation']);
  for (const file of backendFiles()) {
    assert.doesNotMatch(read(`src/backend/${file}`), /^(const|let|var) [A-Za-z0-9]+ = (async )?(function|\()/m, `${file}: functions must be declarations`);
  }

  const project = loadProject();
  for (const helper of ['setupDatabase_', 'diagnoseDatabase_', 'onboardRoommate_', 'assertMaintenanceAllowed_']) {
    assert.equal(typeof project.get(helper), 'function', helper);
  }
  for (const [file, source] of [...backendFiles().map((f) => [f, read(`src/backend/${f}`)])]) {
    if (file === WRAPPERS) continue;
    assert.doesNotMatch(source, /^function (setupDatabase|diagnoseDatabase|onboardRoommate)\(/m, `${file}: maintenance entry points must be private`);
  }
  for (const file of fs.readdirSync(path.join(ROOT, 'src', 'frontend'))) {
    assert.doesNotMatch(read(`src/frontend/${file}`), /setupDatabase|diagnoseDatabase|onboardRoommate/, `${file}: the page never calls maintenance`);
  }
});

test('the separate admin projects are gone, and there is one web app project per environment', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'admin')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'targets.js')), false);
  const manifest = read('package.json');
  assert.doesNotMatch(manifest, /admin/i);
  assert.doesNotMatch(read('scripts/clasp-env.js'), /push-admin|admin/i);
  assert.doesNotMatch(read('.gitignore'), /admin|\.build/);
  assert.doesNotMatch(read('README.md'), /push-admin|admin project|dev-admin|prod-admin/i);
});

test('the temporary editor wrappers are three one-line delegations, and only exist while the web app is owner-only', () => {
  const file = path.join(ROOT, 'src', 'backend', WRAPPERS);
  if (!fs.existsSync(file)) return; // deleted for release: nothing left to check
  const source = fs.readFileSync(file, 'utf8');
  assert.deepEqual(browserCallable([WRAPPERS]), ['diagnoseDatabase', 'onboardRoommate', 'setupDatabase']);
  for (const name of ['setupDatabase', 'diagnoseDatabase', 'onboardRoommate']) {
    assert.match(source, new RegExp(`function ${name}\\(\\) {\\n  return ${name}_\\(\\);\\n}`), name);
  }
  assert.match(source, /TEMPORARY/);
  const { webapp } = JSON.parse(read('src/appsscript.json'));
  assert.deepEqual(webapp, { executeAs: 'USER_DEPLOYING', access: 'MYSELF' }, 'wrappers must never coexist with a widened web app');
});

test('even while the wrappers exist, a browser caller is refused: closed window, no owner, nothing opened', () => {
  if (!fs.existsSync(path.join(ROOT, 'src', 'backend', WRAPPERS))) return;
  for (const [options, pattern] of [[{ maintenance: false }, /Maintenance is closed/], [{ activeUser: '' }, /only be run by the script owner/], [{ activeUser: 'roommate@example.com' }, /only be run by the script owner/]]) {
    const spreadsheet = database();
    const before = spreadsheet.snapshot();
    const project = webApp(spreadsheet, { maintenance: true, ...options });
    if (options.maintenance === false) project.properties.MAINTENANCE_UNTIL = undefined;
    for (const name of ['setupDatabase', 'diagnoseDatabase', 'onboardRoommate']) assert.throws(() => project.get(name)(), pattern, name);
    assert.deepEqual(project.opened, []);
    assert.equal(spreadsheet.snapshot(), before);
  }
});

test('the push script refuses to ship the wrappers once access is widened, in either environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorenest-push-'));
  try {
    for (const entry of ['scripts', 'src', 'package.json']) fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
    const config = (environment, scriptId) => fs.writeFileSync(path.join(dir, `.clasp.${environment.toLowerCase()}.json`), JSON.stringify({ environment, scriptId, rootDir: 'src' }));
    config('DEV', 'FAKEDEVDEVDEV');
    config('PROD', 'FAKEPRODPROD');
    const manifest = path.join(dir, 'src', 'appsscript.json');
    const wrappers = path.join(dir, 'src', 'backend', WRAPPERS);
    const run = (env) => {
      const result = spawnSync(process.execPath, ['scripts/clasp-env.js', env, 'push'], { cwd: dir, encoding: 'utf8' });
      return { status: result.status, output: result.stderr + result.stdout };
    };
    const setAccess = (access) => {
      const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      json.webapp.access = access;
      fs.writeFileSync(manifest, JSON.stringify(json));
    };
    // The scratch copy has no clasp, so a push that passes the guard stops with "clasp is not installed", offline.
    const stopsAtGuard = (output) => /EditorTools\.js/.test(output);

    fs.writeFileSync(wrappers, fs.existsSync(wrappers) ? fs.readFileSync(wrappers, 'utf8') : 'function setupDatabase() {}\n');
    setAccess('MYSELF');
    assert.equal(stopsAtGuard(run('dev').output), false, 'owner-only access may ship the wrappers');
    for (const access of ['ANYONE', 'ANYONE_ANONYMOUS', 'DOMAIN']) {
      setAccess(access);
      assert.equal(stopsAtGuard(run('dev').output), true, `DEV with ${access}`);
      assert.equal(run('dev').status, 1);
    }
    const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    json.webapp = { executeAs: 'USER_ACCESSING', access: 'MYSELF' };
    fs.writeFileSync(manifest, JSON.stringify(json));
    assert.equal(stopsAtGuard(run('dev').output), true, 'running as the visitor is refused too');

    fs.rmSync(wrappers);
    setAccess('ANYONE');
    json.webapp = { executeAs: 'USER_DEPLOYING', access: 'ANYONE' };
    fs.writeFileSync(manifest, JSON.stringify(json));
    assert.equal(stopsAtGuard(run('dev').output), false, 'with the wrappers deleted, access can be widened');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment access is unchanged: the web app runs as the deployer and is private to the owner', () => {
  const { webapp } = JSON.parse(read('src/appsscript.json'));
  assert.deepEqual(webapp, { executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
});

// Minimal information

test('the schedule response contains only what the page needs', () => {
  const result = schedule(webApp(database()));
  assert.deepEqual(Object.keys(result).sort(), ['current', 'generated_at', 'ok', 'roommates', 'upcoming']);
  const turnKeys = ['assignee', 'due_at', 'opens_at', 'owner', 'rotation_id', 'skipped', 'swap_id', 'vacation_conflict_id', 'weekend_starts_at'];
  assert.deepEqual(Object.keys(result.current).sort(), [...turnKeys, 'status'].sort());
  for (const turn of result.upcoming) assert.deepEqual(Object.keys(turn).sort(), turnKeys);
  const people = [result.current.owner, result.current.assignee, ...result.roommates, ...result.upcoming.flatMap((t) => [t.owner, t.assignee, ...t.skipped])];
  for (const person of people) assert.deepEqual(Object.keys(person).sort(), ['name', 'roommate_id']);

  const json = JSON.stringify(result);
  for (const roommate of FIXTURES.ROOMMATES) assert.equal(json.includes(roommate.email) || json.includes(roommate.member_code) || json.includes(roommate.telegram_username || '\u0000'), false);
  assert.doesNotMatch(json, /DEV|PROD|SPREADSHEET|ENVIRONMENT|log_id|created_at/);
});

test('every failure shows a fixed message by code, and no internal detail ever reaches the browser', () => {
  const secret = 'Service Spreadsheets failed at row 9 of 1AbC-secret';
  const broken = database();
  broken.getSheetByName('ROTATION').getDataRange = () => {
    throw new Error(secret);
  };
  const duplicatePosition = fixtureSheet('ROTATION').map((row, i) => (i > 1 ? row.map((v, j) => (j === 1 ? 1 : v)) : row));
  const extraColumn = fixtureSheet('SWAPS').map((row, i) => [...row, i === 0 ? 'due_date' : '']);
  const headerOnly = (name) => [fixtureSheet(name)[0]];

  const reads = [
    ['CONFIG_INVALID', webApp(database(), { environment: 'staging' })],
    ['DATABASE_NOT_SET_UP', webApp(database({ marker: null }))],
    ['DATABASE_ENVIRONMENT_MISMATCH', webApp(database({ marker: 'PROD' }))],
    ['TIMEZONE_MISMATCH', webApp(database({ timeZone: 'America/Los_Angeles' }))],
    ['SCHEMA_INVALID', webApp(database({ sheets: { SWAPS: extraColumn } }))],
    ['ROTATION_EMPTY', webApp(database({ sheets: { ROOMMATES: headerOnly('ROOMMATES'), ROTATION: headerOnly('ROTATION') } }))],
    ['ROTATION_DATA_INVALID', webApp(database({ sheets: { ROTATION: duplicatePosition } }))],
    ['INTERNAL_ERROR', webApp(broken)],
  ];
  const messages = webApp(database()).get('PUBLIC_ERROR_MESSAGES');
  const leak = /secret|row 9|Spreadsheet|[0-9a-f]{8}-[0-9a-f]{4}-|ROOMMATES|ROTATION|SWAPS|column|position|due_date|staging|America/;
  for (const [code, project] of reads) {
    const result = schedule(project);
    assert.deepEqual(result, { ok: false, error: { code, message: messages[code] } }, code);
    assert.doesNotMatch(result.error.message, leak, code);
  }

  const writing = webApp(database());
  const failingWrite = database();
  failingWrite.getSheetByName('CLEANING_LOGS').appendRow = () => {
    throw new Error(secret);
  };
  const base = claimFor(writing);
  const writes = [
    ['INVALID_REQUEST', webApp(database()), null],
    ['NOT_YOUR_TURN', webApp(database()), { ...base, roommate_id: FIXTURES.ROOMMATES[2].roommate_id }],
    ['STALE_TURN', webApp(database()), { ...base, rotation_id: FIXTURES.ROTATION[0].rotation_id }],
    ['WRITE_FAILED', webApp(failingWrite), base],
    ['BUSY', webApp(database(), { lock: { events: [], held: false, deny: true } }), base],
  ];
  for (const [code, project, request] of writes) {
    const result = mark(project, request);
    assert.deepEqual(result, { ok: false, error: { code, message: messages[code] } }, code);
    assert.doesNotMatch(result.error.message, leak, code);
  }
});

test('an unknown error code can never reach the browser, and every browser-reachable code has a public message', () => {
  const project = webApp(database());
  const apiError = project.get('apiError_');
  const unknown = plain(apiError({ code: 'SOMETHING_NEW', message: 'internal 1AbC-secret' }, 'INTERNAL_ERROR'));
  assert.deepEqual(unknown, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Try again later.' } });
  assert.deepEqual(plain(apiError(null, 'ROTATION_DATA_INVALID')).error.code, 'ROTATION_DATA_INVALID');
  assert.deepEqual(plain(apiError({ code: '__proto__' }, 'INTERNAL_ERROR')).error.code, 'INTERNAL_ERROR');

  const messages = project.get('PUBLIC_ERROR_MESSAGES');
  // Only maintenance code, which the browser cannot call, uses the other codes.
  const maintenanceOnly = ['ROOMMATE_INVALID', 'MAINTENANCE_CLOSED', 'ONBOARDING_INVALID', 'ONBOARDING_DUPLICATE', 'ONBOARDING_INCOMPLETE'];
  for (const file of backendFiles()) {
    for (const [, code] of read(`src/backend/${file}`).matchAll(/appError_\('([A-Z_]+)'/g)) {
      assert.ok(code in messages || maintenanceOnly.includes(code), `${file}: ${code} has no public message`);
    }
  }
});

// Every write is validated on the server

test('markCleaned accepts only the exact formats the page sends, and rejects everything else before locking', () => {
  const project = webApp(database());
  const good = claimFor(project);
  const before = project.lock.events.length;
  const bad = [
    { ...good, roommate_id: 'has space' }, { ...good, roommate_id: 'quote"' }, { ...good, roommate_id: 'semi;colon' }, { ...good, roommate_id: '=SUM(1)' },
    { ...good, roommate_id: 'x'.repeat(65) }, { ...good, rotation_id: '../etc' }, { ...good, rotation_id: ['a'] }, { ...good, roommate_id: { toString: () => 'abc' } },
    { ...good, due_at: 'Jan 13 2026' }, { ...good, due_at: '2026-01-13' }, { ...good, due_at: '2026-01-11T23:00:00' }, { ...good, due_at: '2026-01-11T23:00:00+01:00' },
    { ...good, due_at: '2026-13-45T25:61:61Z' }, { ...good, due_at: 1768172400000 }, { ...good, due_at: null },
    { ...good, role: 'admin' }, { ...good, is_admin: true }, { ...good, constructor: 'x' }, { ...good, __proto__x: 1 },
    JSON.parse('{"roommate_id":"a","rotation_id":"b","due_at":"2026-01-11T23:00:00.000Z","__proto__":{"admin":true}}'),
    'x'.repeat(1e6), 12, true, [], [good], null, undefined,
  ];
  for (const request of bad) {
    const result = mark(project, request);
    assert.deepEqual(result.error.code, 'INVALID_REQUEST', String(JSON.stringify(request)).slice(0, 80));
  }
  assert.equal(project.lock.events.length, before, 'invalid requests never reach the lock or the Sheet');
});

test('claiming to be an admin, the owner or someone else grants nothing and writes nothing', () => {
  const spreadsheet = database();
  const project = webApp(spreadsheet);
  const good = claimFor(project);
  const before = spreadsheet.snapshot();
  for (const roommate_id of ['admin', 'owner', 'root', FIXTURES.ROOMMATES[1].roommate_id, FIXTURES.ROOMMATES[3].roommate_id]) {
    assert.equal(mark(project, { ...good, roommate_id }).error.code, 'NOT_YOUR_TURN', roommate_id);
  }
  assert.equal(mark(project, { ...good, roommate_id: 'owner@example.com' }).error.code, 'INVALID_REQUEST');
  assert.equal(spreadsheet.snapshot(), before);
  // The only identity the server acts on is the current assignee, taken from the Sheet, never from the request.
  assert.equal(mark(project, good).ok, true);
});

test('the same request cannot be replayed to record a second cleaning', () => {
  const spreadsheet = database();
  const project = webApp(spreadsheet);
  const request = claimFor(project);
  assert.equal(mark(project, request).ok, true);
  const rows = spreadsheet.getSheetByName('CLEANING_LOGS').values.length;
  for (let i = 0; i < 5; i++) assert.equal(mark(project, request).ok, false);
  assert.equal(spreadsheet.getSheetByName('CLEANING_LOGS').values.length, rows);
});

test('a PROD web app cannot touch a DEV spreadsheet, and the reverse', () => {
  const dev = database();
  const prodOnDev = webApp(dev, { environment: 'PROD' });
  assert.equal(schedule(prodOnDev).error.code, 'DATABASE_ENVIRONMENT_MISMATCH');
  assert.equal(mark(prodOnDev, claimFor(webApp(database()))).error.code, 'DATABASE_ENVIRONMENT_MISMATCH');
  assert.equal(PROD_SPREADSHEET_ID === DEV_SPREADSHEET_ID, false);
});
