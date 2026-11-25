/**
 * Browser API for the in-app admin section. Every call needs a session whose roommate is ADMIN in the Sheet right now
 * (requireSession_ with role ADMIN), checked again under the script lock just before anything is written.
 *
 * What the page may see about accounts: name, member code, username, role, rotation position and a status. Never
 * emails, password hashes, counters, session versions or tokens. A temporary password is returned exactly once, in the
 * answer to the call that created it, and is never stored or logged.
 *
 * Safeguards: no duplicate accounts or usernames; an admin cannot disable, demote or sign out their own account here;
 * and there is always at least one admin who can sign in.
 */
const ADMIN_TEXT_LIMIT = 254;

/**
 * Throws INVALID_REQUEST unless `request` holds a token and exactly the given fields: 'text' (string), 'optional'
 * (string or absent), 'role' (ADMIN or ROOMMATE), 'id' (a row ID).
 */
function adminRequest_(request, fields) {
  const allowed = ['token'].concat(Object.keys(fields));
  const valid = Boolean(request) && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).every(function (field) {
      return allowed.indexOf(field) !== -1;
    }) &&
    typeof request.token === 'string' && request.token.length <= MAX_TOKEN_LENGTH &&
    Object.keys(fields).every(function (field) {
      const value = request[field];
      const kind = fields[field];
      if (kind === 'optional' && value === undefined) return true;
      if (typeof value !== 'string' || value.length > ADMIN_TEXT_LIMIT) return false;
      if (kind === 'role') return AUTH_ROLES.indexOf(value) !== -1;
      if (kind === 'id') return ID_PATTERN.test(value);
      return true;
    });
  if (!valid) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  return request;
}

function requireAdmin_(request, roommates) {
  return requireSession_(request.token, roommates, new Date(), { role: 'ADMIN' });
}

/** Runs an admin call: shape check, then `work`, with every error turned into a fixed public answer. */
function adminCall_(request, fields, work) {
  try {
    adminRequest_(request, fields);
    return work();
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

/** none | active | temporary | temporary_expired | locked | disabled | inactive */
function accountStatus_(roommate, now) {
  if (roommate.active !== true) return 'inactive';
  if (!hasAccount_(roommate)) return 'none';
  if (parsePasswordHash_(roommate.password_hash) === null) return 'disabled';
  if (roommate.must_change_password === true) return temporaryPasswordExpired_(roommate, now) ? 'temporary_expired' : 'temporary';
  if (lockedUntilMs_(roommate) > now.getTime()) return 'locked';
  return 'active';
}

function accountView_(roommate, positions, viewerId, now) {
  return {
    roommate_id: roommate.roommate_id,
    name: String(roommate.name),
    member_code: String(roommate.member_code || ''),
    username: isBlank_(roommate.username) ? null : String(roommate.username),
    role: AUTH_ROLES.indexOf(roommate.role) !== -1 ? roommate.role : null,
    status: accountStatus_(roommate, now),
    position: Object.prototype.hasOwnProperty.call(positions, roommate.roommate_id) ? positions[roommate.roommate_id] : null,
    is_you: roommate.roommate_id === viewerId,
  };
}

function rotationPositions_(rotation) {
  const positions = {};
  rotation.forEach(function (slot) {
    if (typeof slot.position === 'number') positions[slot.roommate_id] = slot.position;
  });
  return positions;
}

/** Active roommates first, in rotation order, then everyone else by name. */
function accountViews_(records, viewerId) {
  const now = new Date();
  const positions = rotationPositions_(records.ROTATION);
  return records.ROOMMATES.map(function (roommate) {
    return accountView_(roommate, positions, viewerId, now);
  }).sort(function (a, b) {
    const rank = function (view) {
      return view.status === 'inactive' ? 1 : 0;
    };
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const pa = a.position === null ? Infinity : a.position;
    const pb = b.position === null ? Infinity : b.position;
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
  });
}

function viewOf_(roommateId, viewerId) {
  const records = SheetDb.listMany(['ROOMMATES', 'ROTATION']);
  return accountViews_(records, viewerId).filter(function (view) {
    return view.roommate_id === roommateId;
  })[0];
}

/** Admins who can still sign in (or are about to, with a temporary password) once `changes` apply to `roommateId`. */
function remainingAdmins_(roommates, roommateId, changes) {
  return roommates.filter(function (roommate) {
    const after = roommate.roommate_id === roommateId ? Object.assign({}, roommate, changes) : roommate;
    return after.active === true && after.role === 'ADMIN' && USERNAME_PATTERN.test(String(after.username || '')) &&
      parsePasswordHash_(after.password_hash) !== null;
  }).length;
}

function assertNotSelf_(session, roommateId) {
  if (session.roommateId === roommateId) throw appError_('SELF_CHANGE', 'Admins cannot do this to their own account.');
}

function assertAdminRemains_(roommates, roommateId, changes) {
  if (remainingAdmins_(roommates, roommateId, changes) < 1) throw appError_('LAST_ADMIN', 'That would leave no admin who can sign in.');
}

function oneTimePassword_(view, temporaryPassword, now) {
  return {
    ok: true,
    account: view,
    temporary_password: temporaryPassword,
    expires_at: new Date(now.getTime() + AUTH_SETTINGS.temporaryPasswordHours * 60 * 60 * 1000).toISOString(),
  };
}

// ---------- reads ----------

/** Browser API: { token } -> { ok, accounts: [view] }. ADMIN only. */
function adminListAccounts(request) {
  return adminCall_(request, {}, function () {
    const records = SheetDb.listMany(['ROOMMATES', 'ROTATION']);
    const session = requireAdmin_(request, records.ROOMMATES);
    return { ok: true, accounts: accountViews_(records, session.roommateId) };
  });
}

// ---------- accounts with a temporary password (the slow hash runs before the lock) ----------

/**
 * Browser API: { token, name, email, telegram?, username, role } -> { ok, account, temporary_password, expires_at }.
 * Adds a new roommate at the end of the rotation (onboardUnderLock_) and gives them an account.
 */
function adminAddRoommate(request) {
  return adminCall_(request, { name: 'text', email: 'text', telegram: 'optional', username: 'text', role: 'role' }, function () {
    const details = normalizeOnboardingRequest_({ name: request.name, email: request.email, telegram: request.telegram || '', position: '' });
    // The same checks SheetDb applies on insert, before any slow work (the member code is assigned later).
    assertRoommate_({ member_code: 'NEW-001', name: details.name, email: details.email, telegram_username: details.telegram, active: true });
    const account = { username: normalizeUsername_(request.username), role: request.role };
    if (!USERNAME_PATTERN.test(account.username)) throw invalidAccount_('The username must be 3-32 lower-case letters, digits, . _ or -, starting with a letter.');
    const check = function (roommates) {
      if (usernameTaken_(roommates, account.username, null)) throw appError_('USERNAME_TAKEN', 'Username taken. Nothing was changed.');
      const existing = roommates.filter(function (roommate) {
        return String(roommate.email).toLowerCase() === details.email;
      })[0];
      if (existing && hasAccount_(existing)) throw appError_('ACCOUNT_EXISTS', 'That email already has an account. Nothing was changed.');
    };
    const first = SheetDb.list('ROOMMATES');
    requireAdmin_(request, first);
    check(first);
    const temporaryPassword = generateTemporaryPassword_();
    const passwordHash = hashPassword_(temporaryPassword);

    return withAuthLock_(function () {
      const now = new Date();
      const roommates = SheetDb.list('ROOMMATES');
      const session = requireAdmin_(request, roommates);
      check(roommates);
      const added = onboardUnderLock_(details);
      const target = accountTarget_(SheetDb.list('ROOMMATES'), { roommateId: added.roommate.roommate_id, username: account.username }, 'create');
      writeAuthChanges_(target.roommate_id, temporaryAccountChanges_(target, passwordHash, now, account));
      console.log('Admin added ' + added.roommate.member_code + ' with a ' + account.role + ' account.');
      return oneTimePassword_(viewOf_(target.roommate_id, session.roommateId), temporaryPassword, now);
    });
  });
}

/** Browser API: { token, roommate_id, username, role } -> { ok, account, temporary_password, expires_at }. */
function adminProvisionAccount(request) {
  return adminCall_(request, { roommate_id: 'id', username: 'text', role: 'role' }, function () {
    const target = { roommateId: request.roommate_id, username: normalizeUsername_(request.username), role: request.role };
    if (!USERNAME_PATTERN.test(target.username)) throw invalidAccount_('The username must be 3-32 lower-case letters, digits, . _ or -, starting with a letter.');
    const first = SheetDb.list('ROOMMATES');
    requireAdmin_(request, first);
    accountTarget_(first, target, 'create');
    const temporaryPassword = generateTemporaryPassword_();
    const passwordHash = hashPassword_(temporaryPassword);

    return withAuthLock_(function () {
      const now = new Date();
      const roommates = SheetDb.list('ROOMMATES');
      const session = requireAdmin_(request, roommates);
      const roommate = accountTarget_(roommates, target, 'create');
      writeAuthChanges_(roommate.roommate_id, temporaryAccountChanges_(roommate, passwordHash, now, target));
      console.log('Admin created a ' + target.role + ' account for ' + roommate.member_code + '.');
      return oneTimePassword_(viewOf_(roommate.roommate_id, session.roommateId), temporaryPassword, now);
    });
  });
}

/**
 * Browser API: { token, roommate_id } -> { ok, account, temporary_password, expires_at }. A new temporary password
 * (also re-enables a disabled sign-in); every session of that roommate ends and any lock is cleared.
 */
function adminResetSignIn(request) {
  return adminCall_(request, { roommate_id: 'id' }, function () {
    const target = { roommateId: request.roommate_id };
    const first = SheetDb.list('ROOMMATES');
    requireAdmin_(request, first);
    accountTarget_(first, target, 'reset');
    const temporaryPassword = generateTemporaryPassword_();
    const passwordHash = hashPassword_(temporaryPassword);

    return withAuthLock_(function () {
      const now = new Date();
      const roommates = SheetDb.list('ROOMMATES');
      const session = requireAdmin_(request, roommates);
      const roommate = accountTarget_(roommates, target, 'reset');
      writeAuthChanges_(roommate.roommate_id, temporaryAccountChanges_(roommate, passwordHash, now, null));
      console.log('Admin reset sign-in for ' + roommate.member_code + '.');
      return oneTimePassword_(viewOf_(roommate.roommate_id, session.roommateId), temporaryPassword, now);
    });
  });
}

// ---------- quick changes (no hashing: everything happens under the lock) ----------

/** Runs `change(session, roommate, roommates)` under the lock for an account that exists; returns the new view. */
function adminAccountChange_(request, fields, change) {
  return adminCall_(request, fields, function () {
    return withAuthLock_(function () {
      const roommates = SheetDb.list('ROOMMATES');
      const session = requireAdmin_(request, roommates);
      const roommate = accountTarget_(roommates, { roommateId: request.roommate_id }, 'reset');
      const changes = change(session, roommate, roommates);
      writeAuthChanges_(roommate.roommate_id, changes);
      return { ok: true, account: viewOf_(roommate.roommate_id, session.roommateId) };
    });
  });
}

/** Browser API: { token, roommate_id } -> { ok, account }. Nobody can sign in to this account until it is reset. */
function adminDisableSignIn(request) {
  return adminAccountChange_(request, { roommate_id: 'id' }, function (session, roommate, roommates) {
    assertNotSelf_(session, roommate.roommate_id);
    const changes = {
      password_hash: '',
      must_change_password: false,
      password_expires_at: '',
      session_version: sessionVersionOf_(roommate) + 1,
      failed_logins: 0,
      locked_until: '',
    };
    assertAdminRemains_(roommates, roommate.roommate_id, changes);
    console.log('Admin disabled sign-in for ' + roommate.member_code + '.');
    return changes;
  });
}

/** Browser API: { token, roommate_id } -> { ok, account }. Ends every session of that roommate; the password stays. */
function adminEndSessions(request) {
  return adminAccountChange_(request, { roommate_id: 'id' }, function (session, roommate) {
    assertNotSelf_(session, roommate.roommate_id);
    console.log('Admin ended the sessions of ' + roommate.member_code + '.');
    return logoutChanges_(roommate);
  });
}

/** Browser API: { token, roommate_id, role } -> { ok, account }. Not your own role, and never the last admin's. */
function adminChangeRole(request) {
  return adminAccountChange_(request, { roommate_id: 'id', role: 'role' }, function (session, roommate, roommates) {
    assertNotSelf_(session, roommate.roommate_id);
    const changes = { role: request.role };
    assertAdminRemains_(roommates, roommate.roommate_id, changes);
    console.log('Admin set ' + roommate.member_code + ' to ' + request.role + '.');
    return changes;
  });
}
