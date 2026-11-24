'use strict';

// Authentication core (src/backend/Auth.js): password hashing, sign-in decisions, signed sessions, revocation, roles.
// Nothing here is browser-callable yet; these tests pin the security behaviour before any API uses it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DEV_SPREADSHEET_ID, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');
const { asSignedIn } = require('./support/appsScript');

const ROOT = path.join(__dirname, '..');
const SECRET = 'S'.repeat(20) + crypto.randomBytes(16).toString('hex');
const PEPPER = 'P'.repeat(20) + crypto.randomBytes(16).toString('hex');
const ITERATIONS = 10000; // the minimum accepted cost; production uses AUTH_SETTINGS.iterations
const NOW = new Date('2026-12-01T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms) => new Date(NOW.getTime() + ms);
const GOOD_PASSWORD = 'correct horse battery';

function auth({ environment = 'DEV', secret = SECRET, pepper = PEPPER, ...rest } = {}) {
  const properties = { ENVIRONMENT: environment };
  // An unset Script Property reads as empty; the harness only supplies test secrets for keys a test leaves out.
  properties.SESSION_SECRET = secret === null ? '' : secret;
  properties.PASSWORD_PEPPER = pepper === null ? '' : pepper;
  const project = loadProject({ properties, maintenance: false, ...rest });
  project.get('AUTH_SETTINGS').iterations = ITERATIONS;
  const fn = (name) => project.get(name);
  return { project, fn, utilities: project.utilities };
}

function account(fn, overrides = {}) {
  return {
    roommate_id: '11111111-1111-4111-8111-111111111111',
    name: 'Alex Example',
    active: true,
    username: 'alex',
    role: 'ROOMMATE',
    password_hash: fn('hashPassword_')(GOOD_PASSWORD),
    must_change_password: false,
    session_version: 3,
    failed_logins: '',
    locked_until: '',
    ...overrides,
  };
}

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return 'NO_ERROR';
};

/** Counts PBKDF2 iterations the project runs, and how many of them ran while the script lock was held. */
function countHashing(project) {
  const global = project.get('globalThis');
  const real = global.nobleHashes_;
  const stats = { iterations: 0, underLock: 0 };
  global.nobleHashes_ = () => {
    const library = real();
    return {
      sha256: library.sha256,
      pbkdf2: (hash, password, salt, options) => {
        stats.iterations += options.c;
        if (project.lock.held) stats.underLock += options.c;
        return library.pbkdf2(hash, password, salt, options);
      },
    };
  };
  return stats;
}

// ---------- password derivation ----------

test('PBKDF2-HMAC-SHA256 matches RFC 7914 and Node for one and several blocks', () => {
  const { fn } = auth();
  const pbkdf2 = fn('pbkdf2Sha256_');
  const bytes = (text) => [...Buffer.from(text, 'utf8')].map((b) => (b > 127 ? b - 256 : b));
  const hex = (signed) => Buffer.from(signed.map((b) => b & 0xff)).toString('hex');
  assert.equal(hex(pbkdf2(bytes('passwd'), bytes('salt'), 1, 64)),
    '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783');
  for (const [password, salt, iterations, length] of [['Password', 'NaCl', 2, 32], ['pässwörd 🔑', 'salt', 1000, 32], ['', 'x', 3, 40]]) {
    assert.equal(hex(pbkdf2(bytes(password), bytes(salt), iterations, length)), crypto.pbkdf2Sync(password, salt, iterations, length, 'sha256').toString('hex'));
  }
  // RFC 7914 section 11, second PBKDF2-HMAC-SHA256 vector.
  assert.equal(hex(pbkdf2(bytes('Password'), bytes('NaCl'), 80000, 64)),
    '4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d');
  assert.throws(() => pbkdf2(bytes('a'), bytes('b'), 0, 32));
  assert.throws(() => pbkdf2(bytes('a'), bytes('b'), 1.5, 32));
});

test('stored hashes equal an independent Node computation, for Unicode passwords too, at the production cost', () => {
  const { fn, project } = auth();
  project.get('AUTH_SETTINGS').iterations = 600000;
  const passwords = ['correct horse battery', 'pässwörd mit Ümläuten', 'café crème 42', '密码是安全的十个字符', '🔑🏠🧹 cleaning rota', 'ﬁ ligature passw0rd'];
  const node = (password, salt, iterations) => {
    const key = crypto.createHmac('sha256', PEPPER).update(Buffer.from(password.normalize('NFC'), 'utf8')).digest();
    return crypto.pbkdf2Sync(key, salt, iterations, 32, 'sha256').toString('base64url');
  };
  passwords.forEach((password, index) => {
    const iterations = index === 0 ? 600000 : ITERATIONS; // one full-cost hash; the rest at the minimum to keep tests fast
    const stored = fn('hashPassword_')(password, iterations);
    const [scheme, cost, salt, hash] = stored.split('$');
    assert.equal(scheme, 'pbkdf2_sha256_pepper');
    assert.equal(Number(cost), iterations);
    assert.equal(hash, node(password, Buffer.from(salt, 'base64url'), iterations), password);
    if (index > 0) {
      assert.equal(fn('verifyPassword_')(password, stored), true, password);
      assert.equal(fn('verifyPassword_')(password.normalize('NFD'), stored), true, `${password} (decomposed)`);
      assert.equal(fn('verifyPassword_')(password + 'x', stored), false);
    }
  });
  assert.match(fn('hashPassword_')(GOOD_PASSWORD), /^pbkdf2_sha256_pepper\$600000\$/, 'production default');
});

test('the bundled library is the pinned @noble/hashes, unmodified apart from indentation, exposing one function', () => {
  const bundle = require('../scripts/bundle-noble');
  const source = fs.readFileSync(path.join(ROOT, 'src', 'backend', 'NobleHashes.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(bundle.build(), source, 'regenerating from node_modules gives the committed file');
  for (const name of bundle.MODULES) {
    const start = source.indexOf(`    './${name}': function (module, exports, require) {\n`);
    const body = source.slice(start).split('\n').slice(1);
    const end = body.indexOf('    },');
    const original = fs.readFileSync(path.join(bundle.PACKAGE_DIR, name), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    const restored = body.slice(0, end).map((line) => (line.startsWith(bundle.INDENT) ? line.slice(bundle.INDENT.length) : line)).join('\n');
    assert.equal(restored, original, name);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies['@noble/hashes'], '1.8.0', 'exact pin');
  // Loading the file defines exactly one global and runs no library code until first use.
  const vm = require('vm');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.deepEqual(Object.keys(context), ['nobleHashes_']);
  assert.equal(context.nobleHashes_.cache, undefined);
  assert.deepEqual(Object.keys(context.nobleHashes_()).sort(), ['pbkdf2', 'sha256']);
});

test('stored hashes are salted, peppered and slow: unique per call, cost recorded, no plain digest', () => {
  const { fn, project } = auth();
  const hashing = countHashing(project);
  const first = fn('hashPassword_')(GOOD_PASSWORD);
  assert.equal(hashing.iterations, ITERATIONS, 'the full iteration count is run');
  const second = fn('hashPassword_')(GOOD_PASSWORD);
  assert.match(first, /^pbkdf2_sha256_pepper\$10000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second, 'random salt');
  assert.ok(!first.includes(GOOD_PASSWORD));
  const plainSha = crypto.createHash('sha256').update(GOOD_PASSWORD).digest('base64url');
  const plainHmac = crypto.createHmac('sha256', PEPPER).update(GOOD_PASSWORD).digest('base64url');
  assert.ok(!first.includes(plainSha) && !first.includes(plainHmac));

  const verify = fn('verifyPassword_');
  assert.equal(verify(GOOD_PASSWORD, first), true);
  assert.equal(verify(GOOD_PASSWORD, second), true);
  assert.equal(verify('correct horse batterY', first), false);
  assert.equal(verify(GOOD_PASSWORD + ' ', first), false);
  assert.equal(verify(undefined, first), false);
  // Unicode normalisation: the composed and decomposed spellings of the same password are equal.
  const accented = fn('hashPassword_')('caf\u00e9 au lait 42'); // composed é
  assert.equal(verify('cafe\u0301 au lait 42', accented), true); // e + combining accent
});

test('the pepper is required: the same Sheet row does not verify under another pepper', () => {
  const { fn } = auth();
  const stored = fn('hashPassword_')(GOOD_PASSWORD);
  const other = auth({ pepper: 'Q'.repeat(50) }).fn;
  assert.equal(other('verifyPassword_')(GOOD_PASSWORD, stored), false);
});

test('malformed or out-of-range stored hashes never verify and never throw', () => {
  const { fn } = auth();
  const good = fn('hashPassword_')(GOOD_PASSWORD);
  const [scheme, , salt, hash] = good.split('$');
  const bad = [
    '', 'plain-text-password', GOOD_PASSWORD, `sha256$10000$${salt}$${hash}`, `${scheme}$9999$${salt}$${hash}`,
    `${scheme}$5000001$${salt}$${hash}`, `${scheme}$010000$${salt}$${hash}`, `${scheme}$1e5$${salt}$${hash}`,
    `${scheme}$10000$${salt}`, `${scheme}$10000$${salt}$${hash}$x`, `${scheme}$10000$${salt.slice(2)}$${hash}`,
    `${scheme}$10000$${salt}$${hash.slice(1)}`, `${scheme}$10000$${salt}$${hash.replace(/./, '+')}`, `${scheme}$10000$${salt}$${hash}=`,
    null, 42, { toString: () => good },
  ];
  for (const stored of bad) {
    assert.equal(fn('verifyPassword_')(GOOD_PASSWORD, stored), false, String(stored));
    assert.equal(fn('parsePasswordHash_')(stored), null, String(stored));
  }
});

test('missing, short or identical secrets stop everything with a generic configuration error', () => {
  for (const options of [{ secret: null }, { pepper: null }, { secret: 'short' }, { pepper: 'x'.repeat(31) }, { secret: 'y'.repeat(42) }, { secret: SECRET, pepper: SECRET }]) {
    const { fn } = auth(options);
    assert.equal(codeOf(() => fn('hashPassword_')(GOOD_PASSWORD)), 'CONFIG_INVALID');
    assert.equal(codeOf(() => fn('issueSessionToken_')({ roommate_id: 'x', session_version: 0 }, NOW)), 'CONFIG_INVALID');
  }
  const { fn } = auth();
  assert.equal(fn('PUBLIC_ERROR_MESSAGES').CONFIG_INVALID, 'ChoreNest isn’t set up correctly.');
});

// ---------- policies ----------

test('password policy: 10-128 characters, not common, not one repeated character, not containing the username', () => {
  const { fn } = auth();
  const policy = (password, username = 'alex') => codeOf(() => fn('assertPasswordPolicy_')(password, username));
  for (const weak of ['short', '123456789', 'password123', 'Chorenest123', 'aaaaaaaaaaaa', 'x'.repeat(129), 'my alex password', 'MyALEXpassword', 'tab\there12345', 42, null]) {
    assert.equal(policy(weak), 'PASSWORD_WEAK', String(weak));
  }
  for (const fine of [GOOD_PASSWORD, 'Tr0ub4dor&3x', '🔑🔑🔑🔑🔑 open sesame', 'xy'.repeat(64)]) assert.equal(policy(fine), 'NO_ERROR', fine);
  assert.equal(policy('😀😀😀😀😀😀😀😀😀'), 'PASSWORD_WEAK', 'length counts characters, not UTF-16 units');
});

test('temporary passwords are random, unambiguous, policy-compliant and unbiased', () => {
  const { fn } = auth();
  const generate = fn('generateTemporaryPassword_');
  const alphabet = fn('TEMP_PASSWORD_ALPHABET');
  const seen = new Set();
  const counts = {};
  for (let i = 0; i < 400; i++) {
    const password = generate();
    assert.equal(password.length, 16);
    assert.ok([...password].every((c) => alphabet.includes(c)), password);
    assert.equal(codeOf(() => fn('assertPasswordPolicy_')(password, 'alex')), 'NO_ERROR');
    seen.add(password);
    for (const c of password) counts[c] = (counts[c] || 0) + 1;
  }
  assert.equal(seen.size, 400);
  assert.ok(!/[0O1lI]/.test(alphabet));
  const expected = (400 * 16) / alphabet.length;
  assert.ok(Object.values(counts).every((n) => n > expected * 0.5 && n < expected * 1.5), 'roughly uniform');
});

test('random bytes come from v4 UUIDs without the fixed version and variant bits, and a bad UUID source fails closed', () => {
  const { fn, utilities } = auth();
  const bytes = fn('randomBytes_')(40);
  assert.equal(bytes.length, 40);
  assert.ok(bytes.every((b) => Number.isInteger(b) && b >= -128 && b <= 127));
  utilities.getUuid = () => '00000000-0000-0000-0000-000000000000';
  assert.throws(() => fn('randomBytes_')(16), /UUID/);
});

// ---------- sign-in (against a Sheet, with the script lock) ----------

const ALEX_ID = '11111111-1111-4111-8111-111111111111';

/** A DEV database whose ROOMMATES has Alex provisioned (username "alex"); the others have no account. */
function household(alexFields = {}, extraRows = []) {
  const hash = auth().fn('hashPassword_')(GOOD_PASSWORD);
  const [headers, ...rows] = fixtureSheet('ROOMMATES');
  const fields = { username: 'alex', role: 'ROOMMATE', password_hash: hash, must_change_password: false, session_version: 3, failed_logins: 0, locked_until: '', ...alexFields };
  const updated = rows.map((row) => (row[0] === ALEX_ID ? headers.map((h, i) => (h in fields ? fields[h] : row[i])) : row));
  const extra = extraRows.map((r) => headers.map((h) => (h in r ? r[h] : '')));
  const others = Object.fromEntries(['ROTATION', 'CLEANING_LOGS', 'SWAPS', 'VACATIONS'].map((name) => [name, fixtureSheet(name)]));
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets: { ROOMMATES: [headers, ...updated, ...extra], ...others } });
}

function signInApp(spreadsheet, { now = NOW, lock } = {}) {
  const project = loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, SESSION_SECRET: SECRET, PASSWORD_PEPPER: PEPPER },
    spreadsheets: [spreadsheet],
    now,
    maintenance: false,
    ...(lock ? { lock } : {}),
  });
  project.get('AUTH_SETTINGS').iterations = ITERATIONS;
  return project;
}

function attempt(project, username, password) {
  try {
    return { ok: true, ...plain(project.get('signInWithPassword_')(username, password)) };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
}

const alexRow = (project) => project.get('SheetDb').list('ROOMMATES').find((r) => r.roommate_id === ALEX_ID);

test('the right password signs in, clears earlier failures and returns a token for the current account', () => {
  const project = signInApp(household({ failed_logins: 3 }));
  const result = attempt(project, '  ALEX ', GOOD_PASSWORD);
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result, token: undefined }, { ok: true, token: undefined, roommateId: ALEX_ID, name: 'Alex Example', role: 'ROOMMATE', mustChangePassword: false, expiresAt: at(14 * DAY).toISOString() });
  const row = alexRow(project);
  assert.equal(row.failed_logins, 0);
  assert.equal(row.locked_until, '');
  assert.equal(project.get('validateSession_')(result.token, project.get('SheetDb').list('ROOMMATES'), NOW).roommateId, ALEX_ID);
});

test('password hashing never runs while the global script lock is held', () => {
  const project = signInApp(household());
  const original = project.utilities.computeHmacSha256Signature;
  let underLock = 0;
  project.utilities.computeHmacSha256Signature = (...args) => {
    if (project.lock.held) underLock += 1;
    return original(...args);
  };
  assert.equal(attempt(project, 'alex', GOOD_PASSWORD).ok, true);
  assert.equal(attempt(project, 'alex', 'wrong password!').ok, false);
  assert.equal(attempt(project, 'nobody', 'wrong password!').ok, false);
  assert.ok(underLock <= 1, `only the token signature is computed under the lock (saw ${underLock})`);
  assert.equal(project.lock.held, false);
  const hashing = countHashing(project);
  assert.equal(attempt(project, 'alex', GOOD_PASSWORD).ok, true);
  assert.equal(attempt(project, 'alex', 'wrong password!').ok, false);
  assert.equal(hashing.iterations, 2 * ITERATIONS);
  assert.equal(hashing.underLock, 0, 'no PBKDF2 iteration runs under the lock');
});

test('five wrong passwords lock the account for 15 minutes; the right password is refused until then', () => {
  const spreadsheet = household();
  const project = signInApp(spreadsheet);
  for (let n = 1; n <= 4; n++) {
    assert.equal(attempt(project, 'alex', 'wrong password!').code, 'LOGIN_FAILED');
    assert.equal(alexRow(project).failed_logins, n);
  }
  assert.equal(attempt(project, 'alex', 'wrong password!').code, 'LOGIN_FAILED');
  assert.equal(alexRow(project).locked_until.getTime(), NOW.getTime() + 15 * 60 * 1000);
  assert.equal(alexRow(project).failed_logins, 0);

  assert.equal(attempt(signInApp(spreadsheet, { now: at(14 * 60 * 1000) }), 'alex', GOOD_PASSWORD).code, 'LOGIN_FAILED');
  const later = signInApp(spreadsheet, { now: at(15 * 60 * 1000) });
  assert.equal(attempt(later, 'alex', GOOD_PASSWORD).ok, true, 'the lock expires');
  assert.equal(alexRow(later).locked_until, '');
});

test('unknown user, wrong password, locked, inactive, unprovisioned and duplicate accounts get the identical answer and cost', () => {
  const duplicate = { roommate_id: 'dup', member_code: 'DUP-009', name: 'Dup', email: 'dup@example.com', active: true, username: 'alex', role: 'ROOMMATE', password_hash: auth().fn('hashPassword_')(GOOD_PASSWORD) };
  const cases = [
    ['unknown user', household(), 'nobody', GOOD_PASSWORD],
    ['wrong password', household(), 'alex', 'wrong password!'],
    ['locked account, right password', household({ locked_until: at(10 * 60 * 1000) }), 'alex', GOOD_PASSWORD],
    ['inactive', household({ active: false }), 'alex', GOOD_PASSWORD],
    ['no role', household({ role: '' }), 'alex', GOOD_PASSWORD],
    ['no password yet', household({ password_hash: '' }), 'alex', GOOD_PASSWORD],
    ['duplicate username', household({}, [duplicate]), 'alex', GOOD_PASSWORD],
    ['empty password', household(), 'alex', ''],
    ['not a string', household(), { username: 'alex' }, GOOD_PASSWORD],
  ];
  const answers = new Set();
  for (const [label, spreadsheet, username, password] of cases) {
    const project = signInApp(spreadsheet);
    const hashing = countHashing(project);
    const result = attempt(project, username, password);
    answers.add(JSON.stringify({ ok: result.ok, code: result.code, message: result.message }));
    assert.equal(hashing.iterations, ITERATIONS, `${label}: exactly one full password check is spent`);
  }
  assert.equal(answers.size, 1, [...answers].join(' | '));
  const messages = signInApp(household()).get('PUBLIC_ERROR_MESSAGES');
  assert.match(messages.LOGIN_FAILED, /wait 15 minutes/);
  assert.equal('ACCOUNT_LOCKED' in messages, false);
});

test('an unknown username writes nothing; a known one counts the attempt before checking the password', () => {
  const spreadsheet = household();
  const project = signInApp(spreadsheet);
  const before = spreadsheet.snapshot();
  attempt(project, 'nobody', 'wrong password!');
  assert.equal(spreadsheet.snapshot(), before);
  attempt(project, 'alex', 'wrong password!');
  assert.notEqual(spreadsheet.snapshot(), before);
});

test('parallel guesses cannot get more than five password checks per lock window', () => {
  const project = signInApp(household());
  const global = project.get('globalThis');
  const realVerify = global.verifyPassword_;
  let checks = 0;
  let spawned = false;
  const nested = [];
  global.verifyPassword_ = (...args) => {
    checks += 1;
    if (!spawned) {
      spawned = true;
      // Nine more requests arrive while this one is hashing. They can only start because no lock is held now.
      for (let i = 0; i < 9; i++) nested.push(attempt(project, 'alex', `guess number ${i}`));
    }
    return realVerify(...args);
  };
  assert.equal(attempt(project, 'alex', 'wrong password!').code, 'LOGIN_FAILED');
  assert.equal(nested.length, 9);
  assert.ok(nested.every((r) => r.code === 'LOGIN_FAILED'));
  assert.equal(checks, 5, 'the attempt that reaches the limit sets the lock before hashing');
  assert.ok(alexRow(project).locked_until.getTime() > NOW.getTime());
});

test('a password reset or deactivation that lands during hashing wins over the in-flight sign-in', () => {
  for (const change of [{ active: false }, { password_hash: auth().fn('hashPassword_')('a different passphrase') }]) {
    const project = signInApp(household());
    const global = project.get('globalThis');
    const realVerify = global.verifyPassword_;
    global.verifyPassword_ = (...args) => {
      project.get('SheetDb').update('ROOMMATES', ALEX_ID, change);
      return realVerify(...args);
    };
    const result = attempt(project, 'alex', GOOD_PASSWORD);
    assert.equal(result.code, 'LOGIN_FAILED', Object.keys(change).join());
    assert.equal(result.token, undefined);
  }
});

test('a busy lock is reported as busy, and nothing is written', () => {
  const spreadsheet = household();
  const before = spreadsheet.snapshot();
  const project = signInApp(spreadsheet, { lock: { events: [], held: false, deny: true } });
  assert.equal(attempt(project, 'alex', GOOD_PASSWORD).code, 'BUSY');
  assert.equal(spreadsheet.snapshot(), before);
});

test('an older, cheaper hash is upgraded on the next successful sign-in', () => {
  const project = signInApp(household());
  project.get('AUTH_SETTINGS').iterations = ITERATIONS * 2;
  assert.equal(attempt(project, 'alex', GOOD_PASSWORD).ok, true);
  const stored = alexRow(project).password_hash;
  assert.match(stored, /^pbkdf2_sha256_pepper\$20000\$/);
  assert.equal(project.get('verifyPassword_')(GOOD_PASSWORD, stored), true);
});

// ---------- sessions ----------

test('a session token validates for 14 days and identifies the account and role from the server data', () => {
  const { fn } = auth();
  const alex = account(fn, { role: 'ADMIN' });
  const token = fn('issueSessionToken_')(alex, NOW);
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.ok(!token.includes(alex.password_hash.split('$')[3]));
  const session = plain(fn('validateSession_')(token, [alex], at(14 * DAY - 1)));
  assert.deepEqual(session, { roommateId: alex.roommate_id, role: 'ADMIN', name: 'Alex Example', mustChangePassword: false, temporaryExpired: false, expiresAt: at(14 * DAY).toISOString() });
  assert.equal(codeOf(() => fn('validateSession_')(token, [alex], at(14 * DAY))), 'UNAUTHENTICATED', 'expired');
  // The role comes from the Sheet now, not from the token.
  assert.equal(fn('validateSession_')(token, [{ ...alex, role: 'ROOMMATE' }], NOW).role, 'ROOMMATE');
});

test('forged, altered, foreign and malformed tokens are all rejected the same way', () => {
  const { fn } = auth();
  const alex = account(fn);
  const sam = account(fn, { roommate_id: '22222222-2222-4222-8222-222222222222', username: 'sam' });
  const token = fn('issueSessionToken_')(alex, NOW);
  const [version, payload, signature] = token.split('.');
  const encode = (object) => Buffer.from(JSON.stringify(object)).toString('base64url');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const resign = (object) => {
    const body = encode(object);
    return `v1.${body}.${fn('signSessionPayload_')(body)}`;
  };
  const otherSecret = auth({ secret: 'Z'.repeat(50) }).fn('issueSessionToken_')(alex, NOW);
  const prodToken = auth({ environment: 'PROD' }).fn('issueSessionToken_')(alex, NOW);
  const rejected = [
    `${version}.${encode({ ...decoded, r: sam.roommate_id })}.${signature}`, // someone else's identity, old signature
    `${version}.${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`,
    `${version}.${payload}.`, `v2.${payload}.${signature}`, `${payload}.${signature}`, `${token}.extra`,
    otherSecret, prodToken,
    resign({ ...decoded, exp: decoded.iat + 15 * DAY }), // lifetime too long, even with a valid signature
    resign({ ...decoded, iat: NOW.getTime() + DAY, exp: NOW.getTime() + 2 * DAY }), // issued in the future
    resign({ ...decoded, sv: '3' }), resign({ r: alex.roommate_id }), resign({ ...decoded, r: 'missing' }),
    '', 'x'.repeat(2000), null, undefined, 42, { token },
  ];
  for (const candidate of rejected) {
    assert.equal(codeOf(() => fn('validateSession_')(candidate, [alex, sam], NOW)), 'UNAUTHENTICATED', String(candidate).slice(0, 60));
  }
  assert.equal(fn('validateSession_')(token, [alex, sam], NOW).roommateId, alex.roommate_id);
});

test('logout, password change, reset and deactivation each revoke every existing token of that roommate only', () => {
  const { fn } = auth();
  const alex = account(fn);
  const sam = account(fn, { roommate_id: '22222222-2222-4222-8222-222222222222', username: 'sam' });
  const issue = (who) => fn('issueSessionToken_')(who, NOW);
  const valid = (token, roommates) => codeOf(() => fn('validateSession_')(token, roommates, NOW)) === 'NO_ERROR';
  const samToken = issue(sam);

  const changes = {
    logout: fn('logoutChanges_')(alex),
    change: fn('newPasswordChanges_')(alex, fn('hashPassword_')('a brand new passphrase')),
    reset: fn('resetPasswordChanges_')(alex, fn('hashPassword_')('TempPassw0rdXyzK'), NOW),
    deactivate: { active: false },
  };
  for (const [label, change] of Object.entries(changes)) {
    const token = issue(alex);
    const updated = { ...alex, ...change };
    assert.equal(valid(token, [alex, sam]), true, `${label}: valid before`);
    assert.equal(valid(token, [updated, sam]), false, `${label}: revoked after`);
    assert.equal(valid(samToken, [updated, sam]), true, `${label}: other roommates keep their sessions`);
    if (label !== 'deactivate') assert.equal(valid(issue(updated), [updated, sam]), true, `${label}: a new sign-in works`);
  }
});

test('a temporary password session can only change the password; roles are enforced', () => {
  const { fn } = auth();
  const fresh = account(fn, { must_change_password: true, password_expires_at: at(DAY) });
  const token = fn('issueSessionToken_')(fresh, NOW);
  const require = (options, who = fresh, t = token) => codeOf(() => fn('requireSession_')(t, [who], NOW, options));
  assert.equal(require(undefined), 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(require({ role: 'ROOMMATE' }), 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(require({ allowPasswordChange: true }), 'NO_ERROR');

  const roommate = account(fn);
  const admin = account(fn, { role: 'ADMIN' });
  const roommateToken = fn('issueSessionToken_')(roommate, NOW);
  const adminToken = fn('issueSessionToken_')(admin, NOW);
  assert.equal(require({ role: 'ADMIN' }, roommate, roommateToken), 'FORBIDDEN');
  assert.equal(require({ role: 'ADMIN' }, admin, adminToken), 'NO_ERROR');
  assert.equal(require(undefined, roommate, roommateToken), 'NO_ERROR');
  assert.equal(require({ role: 'ADMIN' }, roommate, 'garbage'), 'UNAUTHENTICATED');
});

test('changing a password needs the current one, ends every other session and clears the forced change', () => {
  const project = signInApp(household({ must_change_password: true, password_expires_at: at(DAY) }));
  const roommates = () => project.get('SheetDb').list('ROOMMATES');
  const oldToken = project.get('issueSessionToken_')(alexRow(project), NOW);
  const otherDevice = project.get('issueSessionToken_')(alexRow(project), NOW);
  assert.equal(codeOf(() => project.get('requireSession_')(oldToken, roommates(), NOW)), 'PASSWORD_CHANGE_REQUIRED');

  const result = plain(project.get('changePassword_')(oldToken, GOOD_PASSWORD, 'a brand new passphrase'));
  assert.deepEqual({ ...result, token: undefined, expiresAt: undefined }, { token: undefined, expiresAt: undefined, roommateId: ALEX_ID, name: 'Alex Example', role: 'ROOMMATE', mustChangePassword: false });
  const row = alexRow(project);
  assert.equal(row.must_change_password, false);
  assert.equal(row.session_version, 4);
  assert.equal(codeOf(() => project.get('requireSession_')(otherDevice, roommates(), NOW)), 'UNAUTHENTICATED', 'other sessions end');
  assert.equal(codeOf(() => project.get('requireSession_')(result.token, roommates(), NOW)), 'NO_ERROR', 'this device continues');
  assert.equal(attempt(project, 'alex', 'a brand new passphrase').ok, true);
  assert.equal(attempt(project, 'alex', GOOD_PASSWORD).code, 'LOGIN_FAILED');
});

test('a weak, reused or missing new password is refused before any attempt is counted or any hash is computed', () => {
  const project = signInApp(household());
  const token = project.get('issueSessionToken_')(alexRow(project), NOW);
  const hashing = countHashing(project);
  const change = (current, next, t = token) => codeOf(() => project.get('changePassword_')(t, current, next));
  assert.equal(change(GOOD_PASSWORD, 'short'), 'PASSWORD_WEAK');
  assert.equal(change(GOOD_PASSWORD, 'alex is great 2026'), 'PASSWORD_WEAK');
  assert.equal(change(GOOD_PASSWORD, GOOD_PASSWORD), 'PASSWORD_REUSED');
  assert.equal(change(GOOD_PASSWORD, undefined), 'PASSWORD_WEAK');
  assert.equal(change('', 'a brand new passphrase'), 'PASSWORD_WEAK');
  assert.equal(change(GOOD_PASSWORD, 'a brand new passphrase', 'not a token'), 'UNAUTHENTICATED');
  assert.equal(alexRow(project).failed_logins, 0);
  assert.equal(hashing.iterations, 0);
});

test('wrong current passwords are throttled with the sign-in counter: five tries, then a 15-minute lock for both', () => {
  const spreadsheet = household();
  const project = signInApp(spreadsheet);
  const token = project.get('issueSessionToken_')(alexRow(project), NOW);
  const hashing = countHashing(project);
  const change = (current) => codeOf(() => project.get('changePassword_')(token, current, 'a brand new passphrase'));
  for (let n = 1; n <= 5; n++) assert.equal(change(`wrong guess ${n}`), 'PASSWORD_CHANGE_FAILED');
  assert.ok(alexRow(project).locked_until.getTime() > NOW.getTime());
  assert.equal(change(GOOD_PASSWORD), 'PASSWORD_CHANGE_FAILED', 'locked: even the right password fails');
  assert.equal(attempt(project, 'alex', GOOD_PASSWORD).code, 'LOGIN_FAILED', 'sign-in shares the lock');
  assert.equal(hashing.underLock, 0, 'no hashing under the script lock');
  assert.equal(project.get('verifyPassword_')(GOOD_PASSWORD, alexRow(project).password_hash), true, 'password unchanged');
  const messages = project.get('PUBLIC_ERROR_MESSAGES');
  assert.match(messages.PASSWORD_CHANGE_FAILED, /15 minutes/);
});

test('a logout or reset that lands while the new password is being hashed wins: nothing is changed', () => {
  for (const change of [{ session_version: 99 }, { active: false }]) {
    const project = signInApp(household());
    const token = project.get('issueSessionToken_')(alexRow(project), NOW);
    const before = alexRow(project).password_hash;
    const global = project.get('globalThis');
    const realVerify = global.verifyPassword_;
    global.verifyPassword_ = (...args) => {
      project.get('SheetDb').update('ROOMMATES', ALEX_ID, change);
      return realVerify(...args);
    };
    assert.equal(codeOf(() => project.get('changePassword_')(token, GOOD_PASSWORD, 'a brand new passphrase')), 'UNAUTHENTICATED');
    assert.equal(alexRow(project).password_hash, before);
  }
});

test('a provisioning reset needs a new password, clears the lock and revokes sessions; it never sees plaintext', () => {
  const { fn } = auth();
  const alex = account(fn, { failed_logins: 0, locked_until: at(10 * 60 * 1000), session_version: '' });
  const hash = fn('hashPassword_')('TempPassw0rdXyzK');
  const changes = fn('resetPasswordChanges_')(alex, hash, NOW);
  assert.deepEqual(plain(changes), { password_hash: hash, must_change_password: true, password_expires_at: at(72 * 60 * 60 * 1000).toISOString(), session_version: 1, failed_logins: 0, locked_until: '' });
  const reset = { ...alex, ...changes };
  const token = fn('issueSessionToken_')(reset, NOW);
  assert.equal(codeOf(() => fn('requireSession_')(token, [reset], NOW)), 'PASSWORD_CHANGE_REQUIRED');
});

// ---------- schema, storage and isolation ----------

test('ROOMMATES accepts the authentication fields only in the shapes Auth.js writes', () => {
  const { fn } = auth();
  const base = { member_code: 'ALX-001', name: 'Alex', email: 'alex@example.com', active: true };
  const validate = (extra) => codeOf(() => fn('validateRecord_')('ROOMMATES', { ...base, ...extra }));
  const hash = fn('hashPassword_')(GOOD_PASSWORD);
  assert.equal(validate({}), 'NO_ERROR', 'existing roommates without accounts stay valid');
  assert.equal(validate({ username: 'alex', role: 'ADMIN', password_hash: hash, must_change_password: true, session_version: 0, failed_logins: 0, locked_until: NOW }), 'NO_ERROR');
  for (const bad of [{ username: 'Alex' }, { username: 'al' }, { username: '1alex' }, { role: 'admin' }, { role: 'OWNER' }, { password_hash: 'hunter2hunter2' },
    { must_change_password: 'TRUE' }, { session_version: -1 }, { session_version: 1.5 }, { failed_logins: '3' }, { locked_until: '2026-12-01' }]) {
    assert.equal(validate(bad), 'ROOMMATE_INVALID', JSON.stringify(bad));
  }
  const assertChanges = (changes) => codeOf(() => fn('assertAuthChanges_')(changes));
  assert.equal(assertChanges({ session_version: 4, failed_logins: 0, locked_until: '' }), 'NO_ERROR');
  for (const field of ['active', 'roommate_id', 'email', 'name', 'created_at']) assert.equal(assertChanges({ [field]: 'x' }), 'ROOMMATE_INVALID', field);
});

test('no browser API exposes authentication data, even when accounts are provisioned', () => {
  const { fn: hasher } = auth();
  const hash = hasher('hashPassword_')(GOOD_PASSWORD);
  const roommates = fixtureSheet('ROOMMATES');
  const headers = roommates[0];
  const rows = roommates.slice(1).map((row, i) => {
    const copy = row.slice();
    copy[headers.indexOf('username')] = `user${i}x`;
    copy[headers.indexOf('role')] = i === 0 ? 'ADMIN' : 'ROOMMATE';
    copy[headers.indexOf('password_hash')] = hash;
    copy[headers.indexOf('session_version')] = 7;
    copy[headers.indexOf('must_change_password')] = false;
    return copy;
  });
  const sheets = Object.fromEntries(['ROTATION', 'CLEANING_LOGS', 'SWAPS', 'VACATIONS'].map((name) => [name, fixtureSheet(name)]));
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets: { ROOMMATES: [headers, ...rows], ...sheets } });
  const project = loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, SESSION_SECRET: SECRET, PASSWORD_PEPPER: PEPPER },
    spreadsheets: [spreadsheet],
    now: new Date('2026-01-13T12:00:00Z'),
    maintenance: false,
  });
  const responses = JSON.stringify([project.get('getRotationSchedule')(asSignedIn(project)), project.get('listVacations')(asSignedIn(project))]);
  assert.match(responses, /"ok":true/);
  // `viewer` (name, role, must_change_password) is deliberate; nothing else about accounts may appear.
  for (const secret of ['pbkdf2', hash.split('$')[2], 'user0x', 'password_hash', 'session_version', 'failed_logins', 'locked_until', 'password_expires_at', '"username"', SECRET, PEPPER]) {
    assert.ok(!responses.includes(secret), secret);
  }
});

test('Auth.js adds nothing the browser can call and never logs secrets or passwords', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'backend', 'Auth.js'), 'utf8');
  const functions = [...source.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]);
  assert.ok(functions.length > 20);
  assert.deepEqual(functions.filter((name) => !name.endsWith('_')), []);
  assert.doesNotMatch(source, /console\.|Logger\./);
  assert.doesNotMatch(source, /Math\.random/);
  assert.doesNotMatch(source, /computeDigest\(/, 'no plain digest for passwords');
});
