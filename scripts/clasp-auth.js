'use strict';
// ChoreNest signs in to clasp with its OWN credential file, never with the machine-wide ~/.clasprc.json
// (which may hold another account, e.g. a work login for a different project).
//
//   - Every clasp call made by this repo passes --auth <this file>, so clasp cannot fall back to the home file.
//   - A missing, unreadable or unpinned credential file is an error, not a reason to try another account.
//   - Nothing here prints tokens. The only account detail ever shown is the e-mail address of the signed-in account.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(ROOT, '.clasp-auth');
const AUTH_FILE = path.join(AUTH_DIR, 'chorenest.clasprc.json'); // gitignored: holds OAuth tokens
const ACCOUNT_FILE = path.join(AUTH_DIR, 'account.json'); // gitignored: the e-mail recorded at login
const LOGIN_COMMAND = 'npm run login';

function claspBin(root = ROOT) {
  const pkgDir = path.join(root, 'node_modules', '@google', 'clasp');
  const pkgFile = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgFile)) return null;
  return path.join(pkgDir, JSON.parse(fs.readFileSync(pkgFile, 'utf8')).bin.clasp);
}

// Runs clasp and returns stdout only (stderr can carry warnings; neither is echoed by this module).
function defaultRun(args) {
  const bin = claspBin();
  if (!bin) return { status: 1, stdout: '' };
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '' };
}

// Returns the signed-in e-mail for the given credential file (or the machine-wide default when authFile is omitted).
function lookupEmail(run, authFile) {
  const args = [...(authFile ? ['--auth', authFile] : []), '--json', 'show-authorized-user'];
  const { status, stdout } = run(args);
  if (status !== 0) return null;
  try {
    const info = JSON.parse(stdout);
    return info.loggedIn && typeof info.email === 'string' && info.email ? info.email.toLowerCase() : null;
  } catch (error) {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

function hasRefreshToken(file) {
  const store = readJson(file);
  return !!(store && store.tokens && store.tokens.default && store.tokens.default.refresh_token);
}

// ok:true only when the personal file exists, holds a login, and still belongs to the account recorded at login time.
function checkPersonalAuth({ run = defaultRun, authFile = AUTH_FILE, accountFile = ACCOUNT_FILE } = {}) {
  const fix = `Run "${LOGIN_COMMAND}" and sign in with your personal Google account. No other account is used.`;
  if (!fs.existsSync(authFile)) return { ok: false, reason: `ChoreNest has no personal clasp credentials. ${fix}` };
  if (!hasRefreshToken(authFile)) return { ok: false, reason: `The ChoreNest credential file holds no login. ${fix}` };
  const pinned = readJson(accountFile);
  if (!pinned || typeof pinned.email !== 'string' || !pinned.email) {
    return { ok: false, reason: `The personal account was never recorded. ${fix}` };
  }
  const email = lookupEmail(run, authFile);
  if (!email) return { ok: false, reason: `The personal login is expired or revoked. ${fix}` };
  if (email !== pinned.email.toLowerCase()) {
    return { ok: false, reason: `The credential file now belongs to a different account than the one recorded. ${fix}` };
  }
  return { ok: true, email };
}

module.exports = { ROOT, AUTH_DIR, AUTH_FILE, ACCOUNT_FILE, LOGIN_COMMAND, claspBin, defaultRun, lookupEmail, readJson, hasRefreshToken, checkPersonalAuth };
