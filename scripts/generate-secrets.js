#!/usr/bin/env node
// Prints two independent random values for one environment's Script Properties:
//   SESSION_SECRET   signs session tokens
//   PASSWORD_PEPPER  is mixed into every password hash
// Each is 32 bytes from Node's CSPRNG (crypto.randomBytes), base64url-encoded (43 characters).
// Run it once per environment (DEV and PROD get different values) and paste each value straight into
// Apps Script > Project Settings > Script Properties. Nothing is written to disk.
// It refuses to print into a pipe or file unless --allow-redirect is given, so values do not end up in logs.
'use strict';

const crypto = require('crypto');

function generateSecrets() {
  const sessionSecret = crypto.randomBytes(32).toString('base64url');
  const pepper = crypto.randomBytes(32).toString('base64url');
  if (sessionSecret === pepper) throw new Error('Random source returned the same value twice.');
  return { SESSION_SECRET: sessionSecret, PASSWORD_PEPPER: pepper };
}

if (require.main === module) {
  if (!process.stdout.isTTY && !process.argv.includes('--allow-redirect')) {
    console.error('Refusing to print secrets into a pipe or file. Run this in a terminal, or pass --allow-redirect.');
    process.exit(1);
  }
  const secrets = generateSecrets();
  console.log('Paste into ONE environment\'s Script Properties (run again for the other environment):\n');
  for (const [name, value] of Object.entries(secrets)) console.log(`${name}=${value}`);
  console.log('\nDo not save these anywhere else. Changing PASSWORD_PEPPER later invalidates every password.');
}

module.exports = { generateSecrets };
