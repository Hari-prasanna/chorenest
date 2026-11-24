/**
 * Authentication core: password hashing, sign-in evaluation, signed sessions, revocation and role checks.
 * Every function ends in "_", so google.script.run cannot call any of them. No browser API uses them yet.
 *
 * Passwords: PBKDF2-HMAC-SHA256 (RFC 8018, @noble/hashes, 600,000 iterations), with a per-password random salt and a
 * server-side pepper (Script Property PASSWORD_PEPPER) applied first. The iteration count is stored in each hash,
 * so it can be raised later; a successful sign-in silently re-hashes an older, weaker hash.
 *
 * Sessions: stateless tokens signed with HMAC-SHA256 (Script Property SESSION_SECRET). A token names the roommate,
 * the environment and the roommate's session_version, and expires after 14 days. Logging out, changing or resetting
 * the password, and deactivating the roommate all invalidate every existing token of that roommate.
 */
const AUTH_SETTINGS = {
  // OWASP 2023 figure for PBKDF2-HMAC-SHA256.
  iterations: 600000,
  minIterations: 10000,
  maxIterations: 5000000,
  sessionDays: 14,
  temporaryPasswordHours: 72,
  maxClockSkewMs: 5 * 60 * 1000,
  lockAfterFailures: 5,
  lockMinutes: 15,
  passwordMinLength: 10,
  passwordMaxLength: 128,
};
const AUTH_ROLES = ['ADMIN', 'ROOMMATE'];
const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{2,31}$/;
const PASSWORD_HASH_SCHEME = 'pbkdf2_sha256_pepper';
const SESSION_TOKEN_VERSION = 'v1';
// 43 characters = 32 random bytes in base64url, as printed by scripts/generate-secrets.js.
const MIN_SECRET_LENGTH = 43;
const COMMON_PASSWORDS = ['password', 'passwort', 'password1', 'password123', '1234567890', '12345678901', '123456789012', 'qwertyuiop', 'qwertzuiop', 'iloveyou12', 'letmein123', 'welcome123', 'chorenest', 'chorenest1', 'chorenest123', 'abcdefghij', 'abcd123456', '0987654321'];
// Unambiguous characters for temporary passwords (no 0/O, 1/l/I).
const TEMP_PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXYZ2346789';
const TEMP_PASSWORD_LENGTH = 16;

// ---------- secrets ----------

function getAuthSecrets_() {
  const properties = PropertiesService.getScriptProperties();
  const sessionSecret = properties.getProperty('SESSION_SECRET') || '';
  const pepper = properties.getProperty('PASSWORD_PEPPER') || '';
  if (sessionSecret.length < MIN_SECRET_LENGTH || pepper.length < MIN_SECRET_LENGTH || sessionSecret === pepper) {
    // The detail stays in the server log; the browser only ever sees the generic setup message.
    throw appError_('CONFIG_INVALID', 'SESSION_SECRET and PASSWORD_PEPPER must be different random values of at least ' + MIN_SECRET_LENGTH + ' characters.');
  }
  return { sessionSecret: sessionSecret, pepper: pepper };
}

// ---------- byte helpers (Apps Script byte arrays hold signed values -128..127) ----------

function utf8Bytes_(text) {
  return Utilities.newBlob('').setDataFromString(text, 'UTF-8').getBytes();
}

function hmacSha256_(valueBytes, keyBytes) {
  return Utilities.computeHmacSha256Signature(valueBytes, keyBytes);
}

/**
 * Random bytes for salts and temporary passwords. Apps Script has no direct CSPRNG API; Utilities.getUuid() is
 * documented as java.util.UUID.randomUUID(), whose 122 random bits come from SecureRandom. Bytes 6 and 8 carry the
 * fixed version/variant bits and are dropped, so 14 fully random bytes are used per UUID. JavaScript's non-cryptographic random is never used.
 */
function randomBytes_(count) {
  const bytes = [];
  while (bytes.length < count) {
    const hex = Utilities.getUuid().replace(/-/g, '');
    if (!/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/i.test(hex)) throw new Error('Unexpected UUID format from Utilities.getUuid().');
    for (let i = 0; i < 16; i++) {
      // Byte 6 carries the version nibble and byte 8 the variant bits; skip both rather than reduce entropy.
      if (i === 6 || i === 8) continue;
      const value = parseInt(hex.substr(i * 2, 2), 16);
      bytes.push(value > 127 ? value - 256 : value);
    }
  }
  return bytes.slice(0, count);
}

function base64Url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function fromBase64Url_(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url');
  const padded = text + '===='.slice((text.length % 4) || 4);
  return Utilities.base64DecodeWebSafe(padded);
}

/** Equal-length comparison that does not stop at the first difference. */
function constantTimeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

// ---------- password hashing ----------

/**
 * PBKDF2-HMAC-SHA256 (RFC 8018) from the bundled, audited @noble/hashes (NobleHashes.js). Apps Script's native HMAC
 * costs about 1 ms per call, so a native loop needs over 10 minutes for 600,000 iterations; the library computes the
 * same function in plain JavaScript. Takes and returns Apps Script byte arrays (signed values).
 */
function pbkdf2Sha256_(passwordBytes, saltBytes, iterations, dkLength) {
  if (!(iterations >= 1) || iterations !== Math.floor(iterations)) throw new Error('iterations must be a positive integer.');
  const noble = nobleHashes_();
  const derived = noble.pbkdf2(noble.sha256, unsignedBytes_(passwordBytes), unsignedBytes_(saltBytes), { c: iterations, dkLen: dkLength });
  return Array.from(derived, function (b) {
    return b > 127 ? b - 256 : b;
  });
}

function unsignedBytes_(bytes) {
  return Uint8Array.from(bytes, function (b) {
    return b & 0xff;
  });
}

function normalizePassword_(password) {
  return String(password).normalize('NFC');
}

/** The pepper is applied with HMAC first, so a copy of the Sheet alone is not enough to test password guesses. */
function pepperedPasswordBytes_(password, pepper) {
  return hmacSha256_(utf8Bytes_(normalizePassword_(password)), utf8Bytes_(pepper));
}

/** Returns "pbkdf2_sha256_pepper$<iterations>$<salt>$<hash>". */
function hashPassword_(password, iterations) {
  const rounds = iterations || AUTH_SETTINGS.iterations;
  const salt = randomBytes_(16);
  const derived = pbkdf2Sha256_(pepperedPasswordBytes_(password, getAuthSecrets_().pepper), salt, rounds, 32);
  return [PASSWORD_HASH_SCHEME, rounds, base64Url_(salt), base64Url_(derived)].join('$');
}

/** Parses a stored hash strictly; returns null for anything malformed or outside the allowed cost range. */
function parsePasswordHash_(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_SCHEME || !/^[1-9]\d{0,7}$/.test(parts[1])) return null;
  const iterations = Number(parts[1]);
  if (iterations < AUTH_SETTINGS.minIterations || iterations > AUTH_SETTINGS.maxIterations) return null;
  try {
    const salt = fromBase64Url_(parts[2]);
    const hash = fromBase64Url_(parts[3]);
    if (salt.length !== 16 || hash.length !== 32) return null;
    return { iterations: iterations, salt: salt, hash: parts[3] };
  } catch (error) {
    return null;
  }
}

function verifyPassword_(password, stored) {
  const parsed = parsePasswordHash_(stored);
  if (!parsed || typeof password !== 'string') return false;
  const derived = pbkdf2Sha256_(pepperedPasswordBytes_(password, getAuthSecrets_().pepper), parsed.salt, parsed.iterations, 32);
  return constantTimeEqual_(base64Url_(derived), parsed.hash);
}

function needsRehash_(stored) {
  const parsed = parsePasswordHash_(stored);
  return !parsed || parsed.iterations < AUTH_SETTINGS.iterations;
}

// Spends the same work as a real check, so an unknown username is not faster to reject than a wrong password.
function burnPasswordCheck_(password) {
  pbkdf2Sha256_(pepperedPasswordBytes_(String(password || ''), getAuthSecrets_().pepper), randomBytes_(16), AUTH_SETTINGS.iterations, 32);
}

// ---------- policies ----------

function normalizeUsername_(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

/** Throws PASSWORD_WEAK unless the new password is 10-128 characters and not trivially guessable. */
function assertPasswordPolicy_(password, username) {
  const weak = function (message) {
    throw appError_('PASSWORD_WEAK', message);
  };
  if (typeof password !== 'string') weak('password must be text.');
  const normalized = normalizePassword_(password);
  const length = Array.from(normalized).length;
  if (length < AUTH_SETTINGS.passwordMinLength || length > AUTH_SETTINGS.passwordMaxLength) weak('password length out of range.');
  if (/[\u0000-\u001f\u007f]/.test(normalized)) weak('password contains control characters.');
  const lower = normalized.toLowerCase();
  if (COMMON_PASSWORDS.indexOf(lower) !== -1) weak('password is too common.');
  if (/^(.)\1+$/.test(normalized)) weak('password repeats one character.');
  const name = normalizeUsername_(username);
  if (name && lower.indexOf(name) !== -1) weak('password contains the username.');
}

/** A random 16-character temporary password (about 92 bits) from an unambiguous alphabet, without modulo bias. */
function generateTemporaryPassword_() {
  const alphabet = TEMP_PASSWORD_ALPHABET;
  const limit = 256 - (256 % alphabet.length);
  let result = '';
  while (result.length < TEMP_PASSWORD_LENGTH) {
    randomBytes_(32).forEach(function (signed) {
      const value = signed & 0xff;
      if (value < limit && result.length < TEMP_PASSWORD_LENGTH) result += alphabet.charAt(value % alphabet.length);
    });
  }
  return result;
}

// ---------- account state ----------

function sessionVersionOf_(roommate) {
  const value = roommate.session_version;
  return typeof value === 'number' && value >= 0 && value === Math.floor(value) ? value : 0;
}

function failedLoginsOf_(roommate) {
  const value = roommate.failed_logins;
  return typeof value === 'number' && value >= 0 && value === Math.floor(value) ? value : 0;
}

function lockedUntilMs_(roommate) {
  const value = roommate.locked_until;
  if (Object.prototype.toString.call(value) === '[object Date]') return value.getTime();
  const parsed = typeof value === 'string' && value ? Date.parse(value) : NaN;
  return isNaN(parsed) ? 0 : parsed;
}

/** An account can sign in only if it is active, has a role, a unique username and a well-formed password hash. */
function canSignIn_(roommate) {
  return roommate.active === true && AUTH_ROLES.indexOf(roommate.role) !== -1 &&
    USERNAME_PATTERN.test(String(roommate.username || '')) && parsePasswordHash_(roommate.password_hash) !== null;
}

/** Finds the one account with this username. Duplicates fail closed: nobody with a shared username can sign in. */
function findAccount_(roommates, username) {
  const name = normalizeUsername_(username);
  if (!USERNAME_PATTERN.test(name)) return null;
  const matches = roommates.filter(function (roommate) {
    return String(roommate.username || '').toLowerCase() === name;
  });
  return matches.length === 1 ? matches[0] : null;
}

// ---------- sign-in ----------

/** The single public failure for sign-in: unknown user, wrong password and locked account are indistinguishable. */
function signInFailed_() {
  return appError_('LOGIN_FAILED', 'Sign-in failed.');
}

/**
 * Decides whether one more password check is allowed, counting it as a failure in advance. Returns
 * { allowed, changes }. Because the count is written before the (slow, unlocked) password check, parallel requests
 * cannot get more than lockAfterFailures checks per lock window: the attempt that reaches the limit sets the lock.
 */
function reserveSignInAttempt_(account, now) {
  const time = now.getTime();
  const lockedUntil = lockedUntilMs_(account);
  if (lockedUntil > time) return { allowed: false, changes: null };
  const attempts = (lockedUntil ? 0 : failedLoginsOf_(account)) + 1;
  if (attempts >= AUTH_SETTINGS.lockAfterFailures) {
    return { allowed: true, changes: { failed_logins: 0, locked_until: new Date(time + AUTH_SETTINGS.lockMinutes * 60 * 1000) } };
  }
  return { allowed: true, changes: { failed_logins: attempts, locked_until: '' } };
}

function isPlausiblePassword_(password) {
  return typeof password === 'string' && password.length > 0 && password.length <= AUTH_SETTINGS.passwordMaxLength * 4;
}

/** Runs `work` under the script lock, which every Sheet writer shares. Keep `work` short: no password hashing. */
function withAuthLock_(work) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Another save is running. Try again in a moment.');
  try {
    return work();
  } finally {
    lock.releaseLock();
  }
}

function writeAuthChanges_(roommateId, changes) {
  assertAuthChanges_(changes);
  SheetDb.update('ROOMMATES', roommateId, changes);
}

/**
 * Signs in with a username and password. Returns { token, roommateId, role, mustChangePassword, expiresAt } or throws
 * LOGIN_FAILED (any credential problem, including a locked account) or BUSY.
 *   1. Short lock: find the account and reserve an attempt (see reserveSignInAttempt_).
 *   2. No lock: the expensive password check. Unknown, unavailable and locked accounts spend the same work.
 *   3. Short lock: re-read the account; refuse if it was deactivated or its password changed meanwhile; clear the
 *      counter, store an upgraded hash if one was computed, and issue a token for the current session_version.
 */
function signInWithPassword_(username, password) {
  const now = new Date();
  const reservation = withAuthLock_(function () {
    const account = findAccount_(SheetDb.list('ROOMMATES'), username);
    if (!account || !canSignIn_(account) || !isPlausiblePassword_(password)) return null;
    const plan = reserveSignInAttempt_(account, now);
    if (plan.changes) writeAuthChanges_(account.roommate_id, plan.changes);
    return plan.allowed ? { roommateId: account.roommate_id, passwordHash: account.password_hash } : null;
  });

  if (!reservation) {
    burnPasswordCheck_(password);
    throw signInFailed_();
  }
  if (!verifyPassword_(password, reservation.passwordHash)) throw signInFailed_();
  const upgradedHash = needsRehash_(reservation.passwordHash) ? hashPassword_(password) : null;

  return withAuthLock_(function () {
    const fresh = SheetDb.list('ROOMMATES').filter(function (roommate) {
      return roommate.roommate_id === reservation.roommateId;
    })[0];
    if (!fresh || !canSignIn_(fresh) || fresh.password_hash !== reservation.passwordHash) throw signInFailed_();
    // Only someone who knows the temporary password learns that it expired.
    if (temporaryPasswordExpired_(fresh, now)) throw appError_('TEMP_PASSWORD_EXPIRED', 'Temporary password expired.');
    const changes = { failed_logins: 0, locked_until: '' };
    if (upgradedHash) changes.password_hash = upgradedHash;
    writeAuthChanges_(fresh.roommate_id, changes);
    const current = Object.assign({}, fresh, changes);
    const token = issueSessionToken_(current, now);
    return {
      token: token,
      roommateId: current.roommate_id,
      name: current.name,
      role: current.role,
      mustChangePassword: current.must_change_password === true,
      expiresAt: new Date(now.getTime() + AUTH_SETTINGS.sessionDays * 24 * 60 * 60 * 1000),
    };
  });
}

/**
 * A temporary password (must_change_password) is valid for AUTH_SETTINGS.temporaryPasswordHours after it was set.
 * A temporary password without a recorded expiry counts as expired: the owner issues a fresh one.
 */
function temporaryPasswordExpired_(roommate, now) {
  if (roommate.must_change_password !== true) return false;
  const value = roommate.password_expires_at;
  const expires = Object.prototype.toString.call(value) === '[object Date]' ? value.getTime() : NaN;
  return !(expires > now.getTime());
}

// ---------- sessions ----------

function signSessionPayload_(encodedPayload) {
  return base64Url_(hmacSha256_(utf8Bytes_(SESSION_TOKEN_VERSION + '.' + encodedPayload), utf8Bytes_(getAuthSecrets_().sessionSecret)));
}

/** Issues a 14-day token bound to this environment and the roommate's current session_version. */
function issueSessionToken_(roommate, now) {
  const issuedAt = now.getTime();
  const payload = {
    r: roommate.roommate_id,
    sv: sessionVersionOf_(roommate),
    env: getEnvironment_(),
    iat: issuedAt,
    exp: issuedAt + AUTH_SETTINGS.sessionDays * 24 * 60 * 60 * 1000,
  };
  const encoded = base64Url_(utf8Bytes_(JSON.stringify(payload)));
  return SESSION_TOKEN_VERSION + '.' + encoded + '.' + signSessionPayload_(encoded);
}

function unauthenticated_(detail) {
  return appError_('UNAUTHENTICATED', 'Session rejected: ' + detail);
}

/**
 * Validates a token against the current ROOMMATES rows. Returns { roommateId, role, mustChangePassword, expiresAt }.
 * Throws UNAUTHENTICATED for anything wrong: format, signature, environment, expiry, a deactivated or changed account.
 */
function validateSession_(token, roommates, now) {
  if (typeof token !== 'string' || token.length > 1024) throw unauthenticated_('not a token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_VERSION || !parts[1] || !parts[2]) throw unauthenticated_('malformed');
  if (!constantTimeEqual_(signSessionPayload_(parts[1]), parts[2])) throw unauthenticated_('bad signature');

  let payload;
  try {
    const bytes = fromBase64Url_(parts[1]);
    payload = JSON.parse(Utilities.newBlob(bytes).getDataAsString('UTF-8'));
  } catch (error) {
    throw unauthenticated_('unreadable payload');
  }
  if (!payload || typeof payload.r !== 'string' || typeof payload.sv !== 'number' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw unauthenticated_('incomplete payload');
  }
  const time = now.getTime();
  if (payload.env !== getEnvironment_()) throw unauthenticated_('other environment');
  if (payload.exp <= time) throw unauthenticated_('expired');
  if (payload.iat > time + AUTH_SETTINGS.maxClockSkewMs) throw unauthenticated_('issued in the future');
  if (payload.exp - payload.iat > AUTH_SETTINGS.sessionDays * 24 * 60 * 60 * 1000) throw unauthenticated_('lifetime too long');

  const roommate = roommates.filter(function (candidate) {
    return candidate.roommate_id === payload.r;
  })[0];
  if (!roommate || !canSignIn_(roommate)) throw unauthenticated_('account unavailable');
  if (sessionVersionOf_(roommate) !== payload.sv) throw unauthenticated_('revoked');

  return {
    roommateId: roommate.roommate_id,
    role: roommate.role,
    name: roommate.name,
    mustChangePassword: roommate.must_change_password === true,
    temporaryExpired: temporaryPasswordExpired_(roommate, now),
    expiresAt: new Date(payload.exp),
  };
}

/**
 * The one gate for every authenticated API. Only the password-change call may pass a session that still has to
 * replace its temporary password; `role` restricts the call to that role.
 */
function requireSession_(token, roommates, now, options) {
  const settings = options || {};
  const session = validateSession_(token, roommates, now);
  if (session.temporaryExpired) throw appError_('TEMP_PASSWORD_EXPIRED', 'Temporary password expired.');
  if (session.mustChangePassword && !settings.allowPasswordChange) {
    throw appError_('PASSWORD_CHANGE_REQUIRED', 'A temporary password must be changed first.');
  }
  if (settings.role && session.role !== settings.role) {
    throw appError_('FORBIDDEN', 'Role ' + session.role + ' cannot do this.');
  }
  return session;
}

// ---------- state changes (computed here, persisted by the caller under the script lock) ----------

/** Logging out ends every session of this roommate: tokens carry the old session_version. */
function logoutChanges_(roommate) {
  return { session_version: sessionVersionOf_(roommate) + 1 };
}

/** After a successful password change: the new hash, no forced change, and every older session revoked. */
function newPasswordChanges_(roommate, passwordHash) {
  return {
    password_hash: passwordHash,
    must_change_password: false,
    password_expires_at: '',
    session_version: sessionVersionOf_(roommate) + 1,
    failed_logins: 0,
    locked_until: '',
  };
}

/**
 * Owner-assisted provisioning or reset: a temporary password that must be changed at the next sign-in. Revokes all
 * sessions and clears any lock. Only the hash is passed in; the plaintext never reaches this function.
 */
function resetPasswordChanges_(roommate, passwordHash, now) {
  return {
    password_hash: passwordHash,
    must_change_password: true,
    password_expires_at: new Date(now.getTime() + AUTH_SETTINGS.temporaryPasswordHours * 60 * 60 * 1000),
    session_version: sessionVersionOf_(roommate) + 1,
    failed_logins: 0,
    locked_until: '',
  };
}

// ---------- password change ----------

function passwordChangeFailed_() {
  return appError_('PASSWORD_CHANGE_FAILED', 'Current password rejected or attempts locked.');
}

/**
 * Changes the signed-in roommate's password. Returns { token, expiresAt } for this device; every other session ends.
 * Throws UNAUTHENTICATED, PASSWORD_WEAK, PASSWORD_REUSED, PASSWORD_CHANGE_FAILED or BUSY.
 * The current-password check is throttled exactly like sign-in and shares its counter and lock: an attempt is counted
 * under a short lock before the (slow, unlocked) check, so a stolen session cannot be used to guess the password.
 */
function changePassword_(token, currentPassword, newPassword) {
  const now = new Date();
  // Cheap checks first: a policy mistake must not cost an attempt or a slow hash.
  if (typeof newPassword !== 'string' || !isPlausiblePassword_(currentPassword)) throw appError_('PASSWORD_WEAK', 'Missing password.');
  if (normalizePassword_(newPassword) === normalizePassword_(currentPassword)) throw appError_('PASSWORD_REUSED', 'New password equals the current one.');

  const reservation = withAuthLock_(function () {
    const roommates = SheetDb.list('ROOMMATES');
    const session = requireSession_(token, roommates, now, { allowPasswordChange: true });
    const account = findById_(roommates, session.roommateId);
    assertPasswordPolicy_(newPassword, account.username);
    const plan = reserveSignInAttempt_(account, now);
    if (plan.changes) writeAuthChanges_(account.roommate_id, plan.changes);
    return plan.allowed ? { roommateId: account.roommate_id, passwordHash: account.password_hash } : null;
  });
  if (!reservation) {
    burnPasswordCheck_(currentPassword);
    throw passwordChangeFailed_();
  }
  if (!verifyPassword_(currentPassword, reservation.passwordHash)) throw passwordChangeFailed_();
  const newHash = hashPassword_(newPassword);

  return withAuthLock_(function () {
    const roommates = SheetDb.list('ROOMMATES');
    // The session must still be valid now: a logout, reset or deactivation during hashing wins.
    requireSession_(token, roommates, now, { allowPasswordChange: true });
    const fresh = findById_(roommates, reservation.roommateId);
    if (!fresh || fresh.password_hash !== reservation.passwordHash) throw passwordChangeFailed_();
    const changes = newPasswordChanges_(fresh, newHash);
    writeAuthChanges_(fresh.roommate_id, changes);
    return {
      token: issueSessionToken_(Object.assign({}, fresh, changes), now),
      roommateId: fresh.roommate_id,
      name: fresh.name,
      role: fresh.role,
      mustChangePassword: false,
      expiresAt: new Date(now.getTime() + AUTH_SETTINGS.sessionDays * 24 * 60 * 60 * 1000),
    };
  });
}

/** Ends every session of the token's roommate (including one that still has to change its password). */
function signOut_(token) {
  const now = new Date();
  withAuthLock_(function () {
    const roommates = SheetDb.list('ROOMMATES');
    const session = validateSession_(token, roommates, now);
    const roommate = findById_(roommates, session.roommateId);
    writeAuthChanges_(roommate.roommate_id, logoutChanges_(roommate));
  });
}

function findById_(roommates, roommateId) {
  return roommates.filter(function (roommate) {
    return roommate.roommate_id === roommateId;
  })[0] || null;
}

/** Checks an auth update before SheetDb.update writes it; SheetDb.update itself only checks cell types. */
function assertAuthChanges_(changes) {
  const allowed = ['username', 'role', 'password_hash', 'must_change_password', 'password_expires_at', 'session_version', 'failed_logins', 'locked_until'];
  Object.keys(changes).forEach(function (field) {
    if (allowed.indexOf(field) === -1) throw appError_('ROOMMATE_INVALID', 'ROOMMATES: ' + field + ' is not an authentication field.');
  });
  assertAuthFields_(changes);
}
