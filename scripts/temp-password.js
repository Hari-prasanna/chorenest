#!/usr/bin/env node
// Prints one random temporary password for createAccount / resetAccountPassword (see src/backend/Accounts.js).
// 16 characters from an unambiguous 53-character alphabet (about 91 bits), drawn with Node's CSPRNG without bias.
// Nothing is saved. It refuses to print into a pipe or file unless --allow-redirect is given, so it stays out of logs.
'use strict';

const crypto = require('crypto');

// Must equal TEMP_PASSWORD_ALPHABET in src/backend/Auth.js (a test checks this).
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXYZ2346789';
const LENGTH = 16;

function temporaryPassword() {
  let result = '';
  for (let i = 0; i < LENGTH; i++) result += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return result;
}

if (require.main === module) {
  if (!process.stdout.isTTY && !process.argv.includes('--allow-redirect')) {
    console.error('Refusing to print a password into a pipe or file. Run this in a terminal, or pass --allow-redirect.');
    process.exit(1);
  }
  console.log('Paste into the Script Property ACCOUNT_TEMP_PASSWORD, run createAccount or resetAccountPassword,');
  console.log('then give it to the roommate in person. Do not save it anywhere.\n');
  console.log(temporaryPassword());
}

module.exports = { ALPHABET, LENGTH, temporaryPassword };
