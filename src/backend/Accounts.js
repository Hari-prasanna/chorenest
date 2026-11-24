/**
 * Owner-only account provisioning, run by hand from the Apps Script editor through the wrappers in EditorTools.js.
 * Accounts are added to EXISTING roommates (found by member code); no roommate row is ever created here.
 *
 * Temporary passwords and their one-time delivery:
 *   1. On your own computer run `npm run temp-password`. It prints a random 16-character password in the terminal
 *      only (nothing is saved).
 *   2. Paste it into the Script Property ACCOUNT_TEMP_PASSWORD, together with ACCOUNT_MEMBER_CODE (and, to create an
 *      account, ACCOUNT_USERNAME and optionally ACCOUNT_ROLE = ROOMMATE | ADMIN).
 *   3. Open the maintenance window and run createAccount or resetAccountPassword.
 *      The very first thing the run does is delete ACCOUNT_TEMP_PASSWORD, whether or not it then succeeds; only the
 *      PBKDF2 hash is stored and nothing about the password is logged. A failed run needs a new temporary password.
 *   4. Give the password to the roommate in person (or by an end-to-end encrypted message you then delete). They must
 *      choose their own password at the first sign-in; every existing session of theirs has already ended.
 */
const ACCOUNT_REQUEST_KEYS = ['ACCOUNT_MEMBER_CODE', 'ACCOUNT_USERNAME', 'ACCOUNT_ROLE'];
const ACCOUNT_TEMP_PASSWORD_KEY = 'ACCOUNT_TEMP_PASSWORD';

// Built when called: Apps Script loads files in name order, so this file must not read Auth.js constants at load time.
function isTemporaryPasswordFormat_(value) {
  return new RegExp('^[' + TEMP_PASSWORD_ALPHABET + ']{16,64}$').test(value);
}

function invalidAccount_(message) {
  return appError_('ACCOUNT_INVALID', message + ' Nothing was changed.');
}

/** Reads the request. ACCOUNT_TEMP_PASSWORD is removed before anything is checked, so it never lingers. */
function takeAccountRequest_(withUsername) {
  const properties = PropertiesService.getScriptProperties();
  const temporaryPassword = (properties.getProperty(ACCOUNT_TEMP_PASSWORD_KEY) || '').trim();
  properties.deleteProperty(ACCOUNT_TEMP_PASSWORD_KEY);
  const read = function (key) {
    return (properties.getProperty(key) || '').trim();
  };

  const memberCode = read('ACCOUNT_MEMBER_CODE').toUpperCase();
  if (!MEMBER_CODE_PATTERN.test(memberCode)) throw invalidAccount_('Set ACCOUNT_MEMBER_CODE to the roommate\'s member code, for example ALX-001.');
  // Never echo the password itself in a message.
  if (!isTemporaryPasswordFormat_(temporaryPassword)) {
    throw invalidAccount_('Set ACCOUNT_TEMP_PASSWORD to a fresh value from "npm run temp-password" (it was missing or not in that format; it has been deleted).');
  }
  const request = { memberCode: memberCode, temporaryPassword: temporaryPassword };
  if (withUsername) {
    request.username = normalizeUsername_(read('ACCOUNT_USERNAME'));
    request.role = read('ACCOUNT_ROLE').toUpperCase() || 'ROOMMATE';
    if (!USERNAME_PATTERN.test(request.username)) throw invalidAccount_('ACCOUNT_USERNAME must be 3-32 lower-case letters, digits, . _ or -, starting with a letter.');
    if (AUTH_ROLES.indexOf(request.role) === -1) throw invalidAccount_('ACCOUNT_ROLE must be ROOMMATE or ADMIN.');
  }
  try {
    assertPasswordPolicy_(temporaryPassword, request.username || '');
  } catch (error) {
    throw invalidAccount_('That temporary password is not strong enough; generate a new one.');
  }
  return request;
}

/** The one active roommate with this member code, checked for the requested action. */
function accountTarget_(roommates, request, action) {
  const matches = roommates.filter(function (roommate) {
    return String(roommate.member_code || '').toUpperCase() === request.memberCode;
  });
  if (matches.length !== 1) throw invalidAccount_('No single roommate has member code ' + request.memberCode + '.');
  const roommate = matches[0];
  if (roommate.active !== true) throw invalidAccount_(request.memberCode + ' is deactivated.');
  const hasAccount = !isBlank_(roommate.username) || !isBlank_(roommate.password_hash);
  if (action === 'create') {
    if (hasAccount) throw appError_('ACCOUNT_EXISTS', request.memberCode + ' already has an account. Use resetAccountPassword instead. Nothing was changed.');
    const taken = roommates.some(function (other) {
      return other !== roommate && String(other.username || '').toLowerCase() === request.username;
    });
    if (taken) throw invalidAccount_('The username ' + request.username + ' is already taken.');
  } else if (!hasAccount || !USERNAME_PATTERN.test(String(roommate.username)) || AUTH_ROLES.indexOf(roommate.role) === -1) {
    throw appError_('ACCOUNT_MISSING', request.memberCode + ' has no complete account. Use createAccount instead. Nothing was changed.');
  }
  return roommate;
}

/**
 * Hashing (several seconds) runs outside the script lock; the checks run again under the lock right before the write,
 * so a concurrent change cannot slip in between.
 */
function provisionAccount_(action) {
  assertMaintenanceAllowed_();
  const request = takeAccountRequest_(action === 'create');
  accountTarget_(SheetDb.list('ROOMMATES'), request, action);
  const passwordHash = hashPassword_(request.temporaryPassword);

  return withAuthLock_(function () {
    const roommate = accountTarget_(SheetDb.list('ROOMMATES'), request, action);
    const changes = resetPasswordChanges_(roommate, passwordHash, new Date());
    if (action === 'create') {
      changes.username = request.username;
      changes.role = request.role;
    }
    writeAuthChanges_(roommate.roommate_id, changes);
    const properties = PropertiesService.getScriptProperties();
    ACCOUNT_REQUEST_KEYS.forEach(function (key) {
      properties.deleteProperty(key);
    });
    const who = request.memberCode + ' (' + roommate.name + ')';
    const summary = action === 'create'
      ? 'Created the ' + changes.role + ' account "' + changes.username + '" for ' + who + '. Give them the temporary password in person; they must change it at the first sign-in, within ' + AUTH_SETTINGS.temporaryPasswordHours + ' hours.'
      : 'Reset the password of "' + roommate.username + '" (' + who + '). All their sessions have ended. Give them the new temporary password in person; they must change it at the next sign-in, within ' + AUTH_SETTINGS.temporaryPasswordHours + ' hours.';
    console.log(summary);
    return summary;
  });
}

function createAccount_() {
  return provisionAccount_('create');
}

function resetAccountPassword_() {
  return provisionAccount_('reset');
}
