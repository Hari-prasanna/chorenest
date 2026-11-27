const MEMBER_RECENT_COUNT = 5;
const MEMBER_PREVIEW_TURNS = 20; // how far ahead "next assignment" looks, about five months

/**
 * Browser API, read-only: { token, roommate_id } -> { ok, member, stats, recent, next }. Any signed-in roommate may read
 * the profile of an active roommate (the cleaning history is shared in the household anyway). Everything is derived from
 * the cleaning records and the rotation as they are now; nothing is stored. Never sent: email, Telegram name, username,
 * role, member code, password data or session data.
 *   member: { roommate_id, name, avatar, is_you }
 *   stats:  { completed, on_time, on_time_percent }. A completed turn is on time when it was marked before its weekend
 *           ended (the turn's deadline). The percentage is on_time / completed, or null with no completed turn. Turns
 *           skipped for a vacation or closed by the app owner are not counted either way.
 *   recent: up to MEMBER_RECENT_COUNT records, newest weekend first: { log_id, weekend_starts_at, due_at, outcome,
 *           completed_at, resolved_at, swapped, has_photo, can_add_photo, can_delete_photo } (never a Drive ID)
 *   next:   the first turn ahead (the current one included) that this roommate is due to clean, or null:
 *           { weekend_starts_at, due_at, current, covering } where `covering` is the owner whose turn it is by swap.
 */
function getMemberProfile(request) {
  try {
    memberRequest_(request, ['token', 'roommate_id']);
    if (!ID_PATTERN.test(asText_(request.roommate_id))) throw appError_('INVALID_REQUEST', 'That request wasn’t valid.');
    const records = SheetDb.listMany(ROTATION_SHEETS);
    const session = sessionOf_(request, records.ROOMMATES);
    const member = records.ROOMMATES.filter(function (roommate) {
      return roommate.roommate_id === request.roommate_id && roommate.active === true;
    })[0];
    if (!member) throw appError_('UNKNOWN_ROOMMATE', 'No such active roommate.');

    const names = historyNames_(records);
    const logs = records.CLEANING_LOGS.filter(function (log) {
      return isHistoryRow_(log) && log.roommate_id === member.roommate_id;
    });
    return {
      ok: true,
      member: { roommate_id: member.roommate_id, name: String(member.name), avatar: avatarOf_(member), is_you: member.roommate_id === session.roommateId },
      stats: memberStats_(logs),
      recent: logs.sort(function (a, b) {
        return b.due_date.getTime() - a.due_date.getTime() || b.resolved_at.getTime() - a.resolved_at.getTime();
      }).slice(0, MEMBER_RECENT_COUNT).map(function (log) {
        const entry = historyEntry_(log, names);
        return Object.assign({
          log_id: entry.log_id, weekend_starts_at: entry.weekend_starts_at, due_at: entry.due_at, outcome: entry.outcome,
          completed_at: entry.completed_at, resolved_at: entry.resolved_at, swapped: entry.swapped,
        }, photoFlags_(log, session));
      }),
      next: nextAssignment_(records, member.roommate_id, names),
    };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

/**
 * Browser API: sets the signed-in roommate's own avatar. Request: { token, avatar } where avatar is one of AVATAR_IDS,
 * or null to go back to the initial. Whose avatar changes is the session's roommate, never a value from the page, so
 * nobody can change someone else's. Returns { ok: true, avatar } or { ok: false, error }.
 */
function setMyAvatar(request) {
  let locked = false;
  const lock = LockService.getScriptLock();
  try {
    memberRequest_(request, ['token', 'avatar']);
    const avatar = request.avatar;
    if (avatar !== null && AVATAR_IDS.indexOf(avatar) === -1) throw appError_('INVALID_REQUEST', 'That request wasn’t valid.');
    if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Someone else is saving right now.');
    locked = true;
    const session = sessionOf_(request);
    try {
      SheetDb.update('ROOMMATES', session.roommateId, { avatar: avatar });
    } catch (error) {
      console.error(error);
      throw appError_('WRITE_FAILED', 'Could not save.');
    }
    return { ok: true, avatar: avatar };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** A plain object with exactly these fields; the token must be text (the session check does the rest). */
function memberRequest_(request, fields) {
  const valid = Boolean(request) && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).length === fields.length && fields.every(function (field) {
      return Object.prototype.hasOwnProperty.call(request, field);
    }) && typeof request.token === 'string' && request.token.length <= MAX_TOKEN_LENGTH;
  if (!valid) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
}

/** The stored avatar if it is still a bundled one, else null (a hand-typed value in the Sheet shows the initial). */
function avatarOf_(roommate) {
  return AVATAR_IDS.indexOf(roommate.avatar) === -1 ? null : roommate.avatar;
}

/** The profile's part of the shared scoring (scoreLogs_ in Leaderboard.js), so both always agree. */
function memberStats_(logs) {
  const stats = scoreLogs_(logs);
  return { completed: stats.completed, on_time: stats.on_time, on_time_percent: stats.on_time_percent };
}

/** The first of the coming turns assigned to this roommate. A rotation that cannot be worked out gives null, not an error. */
function nextAssignment_(records, roommateId, names) {
  let turns;
  try {
    turns = previewTurns_(toRotationData_(records), new Date(), MEMBER_PREVIEW_TURNS);
  } catch (error) {
    console.error(error);
    return null;
  }
  const index = turns.findIndex(function (turn) {
    return turn.assignee_id === roommateId;
  });
  if (index === -1) return null;
  const turn = turns[index];
  const covering = turn.owner_id !== turn.assignee_id;
  return {
    weekend_starts_at: turn.weekend_starts_at.toISOString(),
    due_at: turn.due_at.toISOString(),
    current: index === 0,
    covering: covering ? { roommate_id: turn.owner_id, name: Object.prototype.hasOwnProperty.call(names, turn.owner_id) ? names[turn.owner_id] : null } : null,
  };
}
