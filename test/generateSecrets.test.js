'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateSecrets } = require('../scripts/generate-secrets');
const { loadProject } = require('./support/appsScript');

test('secrets are two independent 32-byte base64url values that the app accepts', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const secrets = generateSecrets();
    assert.deepEqual(Object.keys(secrets), ['SESSION_SECRET', 'PASSWORD_PEPPER']);
    for (const value of Object.values(secrets)) {
      assert.match(value, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(value, 'base64url').length, 32);
      seen.add(value);
    }
  }
  assert.equal(seen.size, 100, 'never repeated, and the two values always differ');
  const project = loadProject({ properties: { ENVIRONMENT: 'DEV', ...generateSecrets() }, maintenance: false });
  assert.equal(Object.keys(project.get('getAuthSecrets_')()).length, 2);
});

test('the script refuses to print secrets into a pipe or file, so they do not land in logs', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'generate-secrets.js')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Refusing to print secrets/);
});
