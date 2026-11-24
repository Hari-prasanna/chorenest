#!/usr/bin/env node
// One-time (and expiry) sign-in for ChoreNest, into its own credential file.
// Usage: npm run login            sign in with your personal Google account
//        npm run login -- --status   show which account ChoreNest will use (no sign-in)
// The machine-wide ~/.clasprc.json (your other projects) is never written by this command.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const auth = require('./clasp-auth');

function fail(message) {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}

function status() {
  const result = auth.checkPersonalAuth();
  if (!result.ok) fail(result.reason);
  console.log(`ChoreNest clasp account: ${result.email}`);
  console.log('Machine-wide (default) clasp login: not used by this project.');
}

// Cheap, read-only, offline: is the personal file just a copy of the machine-wide login?
function sharesRefreshToken() {
  const home = auth.readJson(path.join(os.homedir(), '.clasprc.json'));
  const mine = auth.readJson(auth.AUTH_FILE);
  const refresh = (store, user) => store && store.tokens && store.tokens[user] && store.tokens[user].refresh_token;
  const own = refresh(mine, 'default');
  if (!own || !home || !home.tokens) return false;
  return Object.keys(home.tokens).some((user) => refresh(home, user) === own);
}

function login() {
  const bin = auth.claspBin();
  if (!bin) fail('clasp is not installed. Run "npm install".');
  fs.mkdirSync(auth.AUTH_DIR, { recursive: true });

  console.log('A browser window opens. Sign in with the PERSONAL Google account that owns the ChoreNest Apps Script projects.\n');
  // The credential file is passed explicitly, so clasp writes there and nowhere else.
  const result = spawnSync(process.execPath, [bin, '--auth', auth.AUTH_FILE, 'login'], { cwd: auth.ROOT, stdio: 'inherit' });
  if (result.status !== 0) fail('clasp login did not complete. Nothing was recorded.');

  if (sharesRefreshToken()) {
    fs.rmSync(auth.AUTH_FILE, { force: true });
    fs.rmSync(auth.ACCOUNT_FILE, { force: true });
    fail('That login is identical to one already stored in your machine-wide clasp file. Sign in with the personal account instead.');
  }
  const email = auth.lookupEmail(auth.defaultRun, auth.AUTH_FILE);
  if (!email) fail('Signed in, but the account e-mail could not be read. Run "npm run login" again.');
  fs.writeFileSync(auth.ACCOUNT_FILE, JSON.stringify({ email }, null, 2));
  console.log(`\nChoreNest will use: ${email}`);
  console.log('If that is not your personal account, run "npm run login" again and choose the right one.');
}

if (process.argv.includes('--status')) status();
else login();
