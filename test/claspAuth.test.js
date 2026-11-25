'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkPersonalAuth, lookupEmail } = require('../scripts/clasp-auth');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorenest-auth-'));
  const authFile = path.join(dir, 'chorenest.clasprc.json');
  const accountFile = path.join(dir, 'account.json');
  return { dir, authFile, accountFile };
}
const login = (file) => fs.writeFileSync(file, JSON.stringify({ tokens: { default: { refresh_token: 'SECRET-REFRESH', access_token: 'SECRET-ACCESS' } } }));
const pin = (file, email) => fs.writeFileSync(file, JSON.stringify({ email }));
const whoIs = (email, loggedIn = true) => () => ({ status: 0, stdout: JSON.stringify({ loggedIn, email, clientId: 'x' }) });

test('a missing credential file, an empty one or an unpinned one all fail closed without calling clasp', () => {
  const { dir, authFile, accountFile } = scratch();
  const calls = [];
  const run = (args) => { calls.push(args); return whoIs('me@gmail.com')(); };
  try {
    assert.match(checkPersonalAuth({ run, authFile, accountFile }).reason, /no personal clasp credentials/);
    fs.writeFileSync(authFile, '{}');
    assert.match(checkPersonalAuth({ run, authFile, accountFile }).reason, /holds no login/);
    fs.writeFileSync(authFile, 'not json');
    assert.match(checkPersonalAuth({ run, authFile, accountFile }).reason, /holds no login/);
    login(authFile);
    assert.match(checkPersonalAuth({ run, authFile, accountFile }).reason, /never recorded/);
    assert.deepEqual(calls, [], 'no network call until a login and a pinned account exist');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the personal login is accepted only when it still belongs to the recorded account', () => {
  const { dir, authFile, accountFile } = scratch();
  try {
    login(authFile);
    pin(accountFile, 'Me@Gmail.com');
    const seen = [];
    const result = checkPersonalAuth({ authFile, accountFile, run: (args) => { seen.push(args); return whoIs('me@gmail.com')(); } });
    assert.deepEqual(result, { ok: true, email: 'me@gmail.com' });
    assert.deepEqual(seen[0].slice(0, 2), ['--auth', authFile], 'the lookup uses the personal file, never the machine default');
    assert.match(checkPersonalAuth({ authFile, accountFile, run: whoIs('work@company.example') }).reason, /different account/);
    assert.match(checkPersonalAuth({ authFile, accountFile, run: whoIs(undefined) }).reason, /expired or revoked/);
    assert.match(checkPersonalAuth({ authFile, accountFile, run: whoIs('me@gmail.com', false) }).reason, /expired or revoked/);
    assert.match(checkPersonalAuth({ authFile, accountFile, run: () => ({ status: 1, stdout: '' }) }).reason, /expired or revoked/);
    assert.match(checkPersonalAuth({ authFile, accountFile, run: () => ({ status: 0, stdout: 'garbage' }) }).reason, /expired or revoked/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failure messages never contain tokens', () => {
  const { dir, authFile, accountFile } = scratch();
  try {
    login(authFile);
    pin(accountFile, 'me@gmail.com');
    for (const run of [whoIs('work@company.example'), whoIs(undefined)]) {
      const text = JSON.stringify(checkPersonalAuth({ authFile, accountFile, run }));
      assert.doesNotMatch(text, /SECRET/);
    }
    assert.equal(lookupEmail(() => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, email: 'A@B.C' }) }), authFile), 'a@b.c');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('push and deploy stop with the login instruction when personal credentials are missing, before any clasp call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorenest-noauth-'));
  try {
    for (const entry of ['scripts', 'src', 'package.json']) fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
    fs.rmSync(path.join(dir, 'src', 'backend', 'EditorTools.js'), { force: true }); // a PROD deploy refuses the wrappers first
    for (const env of ['DEV', 'PROD']) {
      fs.writeFileSync(path.join(dir, `.clasp.${env.toLowerCase()}.json`), JSON.stringify({ environment: env, scriptId: `FAKE${env}${env}${env}`, rootDir: 'src' }));
    }
    for (const [env, action] of [['dev', 'push'], ['dev', 'deploy'], ['prod', 'push'], ['prod', 'deploy']]) {
      const result = spawnSync(process.execPath, ['scripts/clasp-env.js', env, action], { cwd: dir, encoding: 'utf8' });
      const output = result.stderr + result.stdout;
      assert.equal(result.status, 1, `${env} ${action}`);
      assert.match(output, /no personal clasp credentials/);
      assert.match(output, /npm run login/);
      assert.doesNotMatch(output, /not installed|PRODUCTION DEPLOYMENT/, 'stops before clasp or the PROD prompt');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every clasp call from the push script names the personal credential file; nothing falls back to the home file', () => {
  const env = read('scripts/clasp-env.js');
  assert.match(env, /'--auth', AUTH_FILE/);
  assert.equal((env.match(/spawnSync\(/g) || []).length - (env.match(/spawnSync\(process\.execPath, \[bin, '--auth'/g) || []).length, 1, 'only git runs without --auth');
  const login = read('scripts/clasp-login.js');
  assert.match(login, /'--auth', auth\.AUTH_FILE, 'login'/);
  for (const text of [env, login, read('scripts/clasp-auth.js')]) {
    assert.doesNotMatch(text, /console\.(log|error)\([^)]*(refresh_token|access_token|id_token|client_secret)/);
    assert.doesNotMatch(text, /--adc|clasprc\.json'\)\s*,\s*JSON\.stringify/);
  }
  assert.doesNotMatch(read('package.json'), /"login": "clasp login"/);
  assert.match(read('package.json'), /"login": "node scripts\/clasp-login\.js"/);
});

test('credential files are gitignored', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((line) => line.trim());
  assert.ok(lines.includes('.clasp-auth/'));
  assert.ok(lines.includes('*.clasprc.json'));
  assert.ok(lines.includes('.clasprc.json'));
});
