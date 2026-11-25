#!/usr/bin/env node
// Runs clasp against exactly one environment's Apps Script project.
// Usage: node scripts/clasp-env.js <dev|prod> <push|deploy>
//   push    uploads src/ as the project's HEAD (what the editor and installed triggers run). It never creates or
//           changes a deployment, so the version the roommates use stays as it is.
//   deploy  pushes, then updates the deployment (the version the web app URL serves).
//
// Every run also passes ChoreNest's own personal credential file via --auth (see clasp-auth.js),
// so a work login in ~/.clasprc.json is never used and a missing login fails instead of falling back.
// Each run passes the environment's own config file to clasp via --project,
// so there is no shared "active" .clasp.json that could point at the wrong project.
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { AUTH_FILE, checkPersonalAuth } = require('./clasp-auth');

const ROOT = path.resolve(__dirname, '..');
const ENVIRONMENTS = ['dev', 'prod'];
const ACTIONS = ['push', 'deploy'];

function fail(message) {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}

function configFile(env) {
  return path.join(ROOT, `.clasp.${env}.json`);
}

function readConfig(env) {
  const file = configFile(env);
  const name = path.basename(file);
  if (!fs.existsSync(file)) return null;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${name} is not valid JSON.`);
  }
  if (config.environment !== env.toUpperCase()) {
    fail(`${name} must contain "environment": "${env.toUpperCase()}".`);
  }
  if (typeof config.scriptId !== 'string' || !config.scriptId.trim()) {
    fail(`${name} has no scriptId.`);
  }
  if (config.rootDir !== 'src') {
    fail(`${name} must use "rootDir": "src" so all environments share one source tree.`);
  }
  return config;
}

// The temporary editor-only wrappers are browser-callable, so they may only ship while the web app is owner-only,
// and a PROD deployment never contains them: PROD maintenance uses `push` (HEAD only) and no deployment.
function assertWrappersAreSafe(env, action) {
  if (!fs.existsSync(path.join(ROOT, 'src', 'backend', 'EditorTools.js'))) return;
  if (env === 'prod' && action === 'deploy') {
    fail('src/backend/EditorTools.js must not be deployed to PROD. Delete it and commit before deploying; for maintenance use "npm run push:prod", which never deploys.');
  }
  const { webapp } = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'appsscript.json'), 'utf8'));
  if (!webapp || webapp.access !== 'MYSELF' || webapp.executeAs !== 'USER_DEPLOYING') {
    fail('src/backend/EditorTools.js (temporary editor-only wrappers) must be deleted before the web app is opened to anyone but its owner.');
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function runClasp(env, args) {
  const pkgDir = path.join(ROOT, 'node_modules', '@google', 'clasp');
  const pkgFile = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgFile)) fail('clasp is not installed. Run "npm install".');
  const bin = path.join(pkgDir, JSON.parse(fs.readFileSync(pkgFile, 'utf8')).bin.clasp);

  // --auth always names ChoreNest's own credential file, so clasp can never fall back to ~/.clasprc.json.
  const result = spawnSync(process.execPath, [bin, '--auth', AUTH_FILE, '--project', configFile(env), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`clasp ${args[0]} failed for ${env.toUpperCase()}.`);
}

function confirmProd(config, action) {
  if (!process.stdin.isTTY) fail(`PROD ${action} requires an interactive terminal.`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log(action === 'push' ? '\n*** PRODUCTION PUSH (editor code only; the deployment is not changed) ***' : '\n*** PRODUCTION DEPLOYMENT ***');
    console.log(`Script ID:     ${config.scriptId}`);
    if (action === 'deploy') console.log(`Deployment ID: ${config.deploymentId || '(none: a new deployment will be created)'}`);
    if (fs.existsSync(path.join(ROOT, 'src', 'backend', 'EditorTools.js'))) {
      console.log('WARNING: EditorTools.js is included. Installed triggers run this code until you push the release commit again.');
    }
    console.log(`Commit:        ${git(['rev-parse', '--short', 'HEAD'])}`);
    rl.question('\nType PROD to continue: ', (answer) => {
      rl.close();
      resolve(answer === 'PROD');
    });
  });
}

async function main() {
  const [env, action] = process.argv.slice(2);
  if (!ENVIRONMENTS.includes(env) || !ACTIONS.includes(action)) {
    fail('Usage: node scripts/clasp-env.js <dev|prod> <push|deploy>');
  }

  const config = readConfig(env);
  if (!config) {
    fail(`${path.basename(configFile(env))} not found. Copy .clasp.example.json and fill it in.`);
  }

  // Catch a DEV config that was copied from PROD (or vice versa).
  const other = readConfig(env === 'dev' ? 'prod' : 'dev');
  if (other && other.scriptId === config.scriptId) {
    fail('.clasp.dev.json and .clasp.prod.json point at the same scriptId.');
  }
  if (other && config.deploymentId && other.deploymentId === config.deploymentId) {
    fail('.clasp.dev.json and .clasp.prod.json share the same deploymentId.');
  }

  assertWrappersAreSafe(env, action);

  // Fail closed: without the personal login nothing is pushed or deployed, and no other account is tried.
  const login = checkPersonalAuth();
  if (!login.ok) fail(login.reason);
  console.log(`clasp account (personal): ${login.email}`);

  const commit = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain']) !== '';

  // A versioned deployment must be reproducible from a commit, in every environment, and PROD never receives
  // uncommitted code at all. Pushing DEV HEAD from a dirty tree stays allowed.
  if (action === 'deploy' || env === 'prod') {
    if (!commit) fail(`${env.toUpperCase()} ${action} requires a git commit.`);
    if (dirty) fail(`${env.toUpperCase()} ${action} requires a clean working tree. Commit or stash your changes.`);
  }
  if (env === 'prod') {
    if (!(await confirmProd(config, action))) fail(`PROD ${action} cancelled.`);
  }

  // --force overwrites the remote manifest without an interactive prompt;
  // src/appsscript.json is the source of truth.
  runClasp(env, ['push', '--force']);
  if (action === 'push') return;

  const description = `${env.toUpperCase()} ${commit || 'uncommitted'}${dirty ? '-dirty' : ''}`;
  const deployArgs = ['deploy', '--description', description];
  if (config.deploymentId) deployArgs.push('--deploymentId', config.deploymentId);
  runClasp(env, deployArgs);

  if (!config.deploymentId) {
    console.log(
      `\nA new deployment was created. Add its ID as "deploymentId" in ` +
        `${path.basename(configFile(env))} so future deploys keep the same URL.`
    );
  }
}

main();
