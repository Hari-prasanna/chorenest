/**
 * Browser API for signing in and out, and the session gate every household API passes first.
 * Identity is never taken from the page: it is the roommate named by a valid, server-signed session token, checked
 * against the ROOMMATES row as it is now (active, role, session_version, forced password change).
 *
 * Responses never contain password hashes, counters or other account fields: only `viewer`, the signed-in person.
 */
const MAX_TOKEN_LENGTH = 1024;
const MAX_PASSWORD_INPUT = 512;

/** Throws INVALID_REQUEST unless `request` is a plain object with only these string fields, each present. */
function authRequest_(request, fields) {
  const valid = Boolean(request) && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).every(function (field) {
      return fields.indexOf(field) !== -1;
    }) &&
    fields.every(function (field) {
      return typeof request[field] === 'string' && request[field].length <= (field === 'token' ? MAX_TOKEN_LENGTH : MAX_PASSWORD_INPUT);
    });
  if (!valid) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  return request;
}

/**
 * The gate for household APIs: returns the session of request.token, or throws UNAUTHENTICATED,
 * PASSWORD_CHANGE_REQUIRED or TEMP_PASSWORD_EXPIRED. Only the token is read from the request here. Pass the ROOMMATES
 * records when the caller has just read them, so the spreadsheet is opened once.
 */
function sessionOf_(request, roommates) {
  const token = request && typeof request === 'object' && !Array.isArray(request) ? request.token : null;
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) throw appError_('UNAUTHENTICATED', 'No session token.');
  return requireSession_(token, roommates || SheetDb.list('ROOMMATES'), new Date());
}

/** What the page may know about the signed-in person. */
function viewerOf_(session) {
  return {
    roommate_id: session.roommateId,
    name: session.name,
    role: session.role,
    must_change_password: session.mustChangePassword === true,
  };
}

function sessionResponse_(result) {
  return {
    ok: true,
    session: { token: result.token, expires_at: result.expiresAt.toISOString() },
    viewer: viewerOf_(result),
  };
}

/**
 * Browser API: { username, password } -> { ok, session: { token, expires_at }, viewer }. Takes several seconds (the
 * password hash is deliberately slow). Unknown usernames, wrong passwords and locked accounts get the same answer.
 */
function signIn(request) {
  try {
    authRequest_(request, ['username', 'password']);
    return sessionResponse_(signInWithPassword_(request.username, request.password));
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

/**
 * Browser API: { token, current_password, new_password } -> { ok, session, viewer }. The returned token replaces the
 * old one on this device; every other session of this roommate ends. Required after a temporary password.
 */
function changePassword(request) {
  try {
    authRequest_(request, ['token', 'current_password', 'new_password']);
    return sessionResponse_(changePassword_(request.token, request.current_password, request.new_password));
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

/** Browser API: { token } -> { ok: true }. Ends every session of this roommate, on all devices. */
function signOut(request) {
  try {
    authRequest_(request, ['token']);
    signOut_(request.token);
    return { ok: true };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}
