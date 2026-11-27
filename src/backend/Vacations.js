const VACATION_MAX_DAYS = 120;
const VACATION_MAX_AHEAD_DAYS = 366;
const VACATION_MAX_ACTIVE_PER_ROOMMATE = 10;
const VACATION_PREVIEW_TURNS = 20;
const VACATION_LIST_LIMIT = 50;
const VACATION_RETURNED_DAYS = 14; // how long a finished vacation stays in the list as "returned"
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// Called from the page with a session token. Whose vacation is planned or changed is the signed-in roommate from the
// session (sessionOf_), never a value sent by the page.

/**
 * Browser API: plans a vacation. Request: { token, start_date, return_date } with 'YYYY-MM-DD' Berlin dates,
 * where return_date is the first day back. Returns { ok: true, vacation_id } or { ok: false, error }.
 */
function saveVacation(request) {
  let locked = false;
  const lock = LockService.getScriptLock();
  try {
    vacationRequestShape_(request, ['token', 'start_date', 'return_date']);
    const claim = parseVacationRequest_(request, null);
    if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Someone else is saving right now.');
    locked = true;
    claim.roommateId = sessionOf_(request).roommateId;
    return { ok: true, vacation_id: addVacationUnderLock_(claim) };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  } finally {
    if (locked) lock.releaseLock();
  }
}

/**
 * Browser API: deletes your own vacation (upcoming, under way or recently back) when that is safe: no turn was skipped
 * for it, and the current turn stays exactly as it is. Nothing is erased: the row gets a cancelled_at time and the
 * rotation engine ignores it, so recorded skips and the cleaning history never change. Request: { token, vacation_id }.
 */
function cancelVacation(request) {
  let locked = false;
  const lock = LockService.getScriptLock();
  try {
    vacationRequestShape_(request, ['token', 'vacation_id']);
    const claim = parseCancelRequest_(request, null);
    if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Someone else is saving right now.');
    locked = true;
    claim.roommateId = sessionOf_(request).roommateId;
    cancelUnderLock_(claim);
    return { ok: true };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  } finally {
    if (locked) lock.releaseLock();
  }
}

/**
 * Browser API, read-only, request { token }: current, planned and recently finished (VACATION_RETURNED_DAYS) vacations of active
 * roommates, with the cleaning weekends each one affects and whether that weekend's turn is skipped. Names only, no
 * emails. `state` is 'upcoming', 'away' or 'returned'.
 */
function listVacations(request) {
  try {
    authRequest_(request, ['token']);
    const records = SheetDb.listMany(ROTATION_SHEETS);
    sessionOf_(request, records.ROOMMATES);
    const now = new Date();
    let turns;
    try {
      turns = previewTurns_(toRotationData_(records), now, VACATION_PREVIEW_TURNS);
    } catch (error) {
      throw error.code ? error : appError_('ROTATION_DATA_INVALID', String(error.message));
    }
    const names = {};
    records.ROOMMATES.forEach(function (roommate) {
      if (roommate.active === true) names[roommate.roommate_id] = String(roommate.name);
    });
    const skippedLogs = records.CLEANING_LOGS.filter(function (log) {
      return log.outcome === 'vacation_skipped';
    });
    let baseline = null; // the current turn as it is, worked out once and only if a started vacation needs it
    const deletable = function (row) {
      if (!row.vacation_id || vacationSkippedATurn_(String(row.vacation_id), skippedLogs)) return false;
      if (row.start_date.getTime() > now.getTime()) return true;
      baseline = baseline || currentTurnKey_(records, null, null, now);
      return keepsCurrentTurn_(records, row, now, baseline);
    };
    let current = null; // the current turn as it is, worked out once and only if an upcoming vacation needs it
    const person = function (roommateId) {
      return { roommate_id: roommateId, name: names[roommateId] || null };
    };
    // An upcoming vacation may still hand the open turn to someone else when deleted: say who, so the page can explain it.
    const turnChange = function (row, canDelete) {
      if (!canDelete || row.start_date.getTime() <= now.getTime()) return null;
      current = current || turnWithout_(records, null, now);
      const after = turnWithout_(records, row, now);
      if (after.assignee_id === current.assignee_id && after.due_at.getTime() === current.due_at.getTime()) return null;
      return { from: person(current.assignee_id), to: person(after.assignee_id), weekend_starts_at: after.weekend_starts_at.toISOString(), due_at: after.due_at.toISOString() };
    };

    const vacations = records.VACATIONS
      .filter(function (row) {
        return !isCancelled_(row) && isValidVacation_(row) && row.return_date.getTime() > now.getTime() - VACATION_RETURNED_DAYS * CALENDAR_DAY_MS &&
          Object.prototype.hasOwnProperty.call(names, row.roommate_id);
      })
      .sort(function (a, b) {
        return a.start_date.getTime() - b.start_date.getTime();
      })
      .slice(0, VACATION_LIST_LIMIT)
      .map(function (row) {
        return vacationToJson_(row, names[row.roommate_id], now, turns, skippedLogs, deletable, turnChange);
      });
    return { ok: true, vacations: vacations };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

/**
 * Browser API: changes the first day away and the first day back of your own vacation, keeping its ID. Request:
 * { token, vacation_id, start_date, return_date, seen_start, seen_return } with 'YYYY-MM-DD' Berlin dates, and
 * the ISO start_date and return_date the page showed (seen_*), so a change made meanwhile is never overwritten.
 * A vacation that has started keeps its first day away. Returns { ok: true, changed } or { ok: false, error }.
 */
function updateVacation(request) {
  return withVacationLock_(function () {
    vacationRequestShape_(request, ['token', 'vacation_id', 'start_date', 'return_date', 'seen_start', 'seen_return']);
    const claim = parseEditRequest_(request, null);
    return function () {
      claim.roommateId = sessionOf_(request).roommateId;
      return { ok: true, changed: changeVacationUnderLock_(claim, function (vacation, today, started) {
        // A started vacation's form sends its first day unchanged; keep the stored time exactly.
        const sameStart = started && claim.startDay === berlinDay_(vacation.start_date.getTime());
        return { start: sameStart ? vacation.start_date.getTime() : berlinMidnight_(claim.startDay), end: berlinMidnight_(claim.returnDay) };
      }) };
    };
  });
}

/**
 * Browser API, "I'm back": ends your own vacation that is under way by making today (Berlin) the first day back.
 * Request: { token, vacation_id, seen_start, seen_return }. Returns { ok: true, changed } or { ok: false, error }.
 */
function endVacation(request) {
  return withVacationLock_(function () {
    vacationRequestShape_(request, ['token', 'vacation_id', 'seen_start', 'seen_return']);
    const claim = parseEndRequest_(request, null);
    return function () {
      claim.roommateId = sessionOf_(request).roommateId;
      return { ok: true, changed: changeVacationUnderLock_(claim, function (vacation, today, started) {
        if (!started) throw appError_('VACATION_NOT_STARTED', 'Not started yet.');
        const end = berlinMidnight_(today);
        if (end <= vacation.start_date.getTime()) throw appError_('VACATION_JUST_STARTED', 'Started today.');
        return { start: vacation.start_date.getTime(), end: end };
      }) };
    };
  });
}

/** Parses before locking, then runs the returned function under the script lock (which checks the session first). */
function withVacationLock_(prepare) {
  let locked = false;
  const lock = LockService.getScriptLock();
  try {
    const run = prepare();
    if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Someone else is saving right now.');
    locked = true;
    return run();
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** The ISO timestamp the page showed for a date, as milliseconds, or an INVALID_REQUEST error. */
function parseSeen_(value) {
  const text = asText_(value);
  if (!ISO_UTC_PATTERN.test(text) || isNaN(Date.parse(text))) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  return Date.parse(text);
}

function parseEditRequest_(request, roommateId) {
  if (!ID_PATTERN.test(asText_(request.vacation_id))) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  const seen = { start: parseSeen_(request.seen_start), end: parseSeen_(request.seen_return) };
  const startDay = parseDay_(request.start_date);
  const returnDay = parseDay_(request.return_date);
  if (startDay === null || returnDay === null) throw appError_('VACATION_DATES_INVALID', 'Not real dates.');
  return { roommateId: roommateId, vacationId: request.vacation_id, seen: seen, startDay: startDay, returnDay: returnDay };
}

function parseEndRequest_(request, roommateId) {
  if (!ID_PATTERN.test(asText_(request.vacation_id))) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  return { roommateId: roommateId, vacationId: request.vacation_id, seen: { start: parseSeen_(request.seen_start), end: parseSeen_(request.seen_return) } };
}

/**
 * Runs under the lock. Re-reads the Sheet, checks the claim against the row as it is now, asks `plan` for the new
 * { start, end }, and writes only a change that leaves history alone:
 * - nothing before today moves: a first day away stays in the future (or, once started, stays as it was), and the
 *   first day back is today or later;
 * - every weekend already recorded as vacation_skipped for this vacation stays inside it;
 * - the current turn (who cleans, its dates, its skips) is exactly the same with the new dates.
 * Anything else is refused with a conflict for the admin. Returns whether the row changed.
 */
function changeVacationUnderLock_(claim, plan) {
  const records = SheetDb.listMany(ROTATION_SHEETS);
  const vacation = records.VACATIONS.find(function (row) {
    return row.vacation_id === claim.vacationId && !isCancelled_(row);
  });
  if (!vacation || !isValidVacation_(vacation)) throw appError_('VACATION_NOT_FOUND', 'No such vacation.');
  if (vacation.roommate_id !== claim.roommateId) throw appError_('NOT_YOUR_VACATION', 'Someone else’s vacation.');
  const oldStart = vacation.start_date.getTime();
  const oldEnd = vacation.return_date.getTime();
  if (oldStart !== claim.seen.start || oldEnd !== claim.seen.end) throw appError_('VACATION_CHANGED', 'Changed since it was loaded.');

  const now = new Date();
  const today = berlinDay_(now.getTime());
  if (oldEnd <= now.getTime()) throw appError_('VACATION_ENDED', 'Already over.');
  const started = oldStart <= now.getTime();
  const next = plan(vacation, today, started);

  if (started && next.start !== oldStart) throw appError_('VACATION_START_LOCKED', 'Started vacations keep their start.');
  if (!started && berlinDay_(next.start) < today) throw appError_('VACATION_IN_PAST', 'The first day away is in the past.');
  if (next.end <= next.start) throw appError_('VACATION_ORDER', 'The first day back must be after the first day away.');
  if (berlinDay_(next.end) < today) throw appError_('VACATION_BACK_IN_PAST', 'The first day back is in the past.');
  if (Math.round((next.end - next.start) / CALENDAR_DAY_MS) > VACATION_MAX_DAYS) throw appError_('VACATION_TOO_LONG', 'Too long.');
  if (berlinDay_(next.start) - today > VACATION_MAX_AHEAD_DAYS) throw appError_('VACATION_TOO_FAR', 'Too far ahead.');
  if (next.start === oldStart && next.end === oldEnd) return false;

  const overlaps = records.VACATIONS.some(function (row) {
    return row !== vacation && row.roommate_id === claim.roommateId && !isCancelled_(row) && isValidVacation_(row) &&
      next.start < row.return_date.getTime() && next.end > row.start_date.getTime();
  });
  if (overlaps) throw appError_('VACATION_OVERLAP', 'Overlaps another vacation.');

  const uncovered = records.CLEANING_LOGS.some(function (log) {
    if (log.outcome !== 'vacation_skipped' || log.notes !== 'Skipped for vacation ' + claim.vacationId || !isDate_(log.due_date)) return false;
    const weekend = weekendFromSaturday_(saturdayOfDue_(log.due_date.getTime()));
    return !(next.start < weekend.dueAt && next.end > weekend.startsAt);
  });
  if (uncovered) throw appError_('VACATION_SKIP_RECORDED', 'A recorded skip would fall outside the vacation.');

  const changed = Object.assign({}, vacation, { start_date: new Date(next.start), return_date: new Date(next.end) });
  if (currentTurnKey_(records, vacation, vacation, now) !== currentTurnKey_(records, vacation, changed, now)) {
    throw appError_('VACATION_TURN_CONFLICT', 'The change would alter the current turn.');
  }

  try {
    SheetDb.update('VACATIONS', claim.vacationId, { start_date: changed.start_date, return_date: changed.return_date });
  } catch (error) {
    console.error(error);
    throw appError_('WRITE_FAILED', 'Could not save.');
  }
  return true;
}

/** Everything about the current turn, and any skip due for it, with `original` replaced by `replacement`. */
function currentTurnKey_(records, original, replacement, now) {
  const vacations = records.VACATIONS.map(function (row) {
    return row === original ? replacement : row;
  });
  const data = toRotationData_(Object.assign({}, records, { VACATIONS: vacations }));
  try {
    const skip = planVacationSkip_(data, now);
    return JSON.stringify({ turn: getCurrentTurn_(data, now), skip: skip ? skip.notes : null });
  } catch (error) {
    throw error.code ? error : appError_('ROTATION_DATA_INVALID', String(error.message));
  }
}

function isCancelled_(row) {
  return row.cancelled_at !== '' && row.cancelled_at !== null && row.cancelled_at !== undefined;
}

function vacationRequestShape_(request, fields) {
  const valid = Boolean(request) && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).every(function (field) {
      return fields.indexOf(field) !== -1;
    });
  // Only known fields; the token must be text (sessionOf_ checks it under the lock). The parsers check the rest.
  if (!valid || typeof request.token !== 'string') {
    throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  }
}

/** 'YYYY-MM-DD' as a day number (days since 1970-01-01), or null when it is not a real calendar date. */
function parseDay_(value) {
  const match = DATE_ONLY_PATTERN.exec(asText_(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = year >= 2000 && year <= 2100 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date.getTime() / CALENDAR_DAY_MS : null;
}

function parseVacationRequest_(request, roommateId) {
  const startDay = parseDay_(request.start_date);
  const returnDay = parseDay_(request.return_date);
  if (startDay === null || returnDay === null) throw appError_('VACATION_DATES_INVALID', 'Not real dates.');
  const today = berlinDay_(Date.now());
  if (startDay < today) throw appError_('VACATION_IN_PAST', 'The first day away is in the past.');
  if (returnDay <= startDay) throw appError_('VACATION_ORDER', 'The first day back must be after the first day away.');
  if (returnDay - startDay > VACATION_MAX_DAYS) throw appError_('VACATION_TOO_LONG', 'Too long.');
  if (startDay - today > VACATION_MAX_AHEAD_DAYS) throw appError_('VACATION_TOO_FAR', 'Too far ahead.');
  return { roommateId: roommateId, startDay: startDay, returnDay: returnDay };
}

function parseCancelRequest_(request, roommateId) {
  if (!ID_PATTERN.test(asText_(request.vacation_id))) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  return { roommateId: roommateId, vacationId: request.vacation_id };
}

/** Runs under the lock: checks the roommate and every existing vacation as they are now, then appends the row. */
function addVacationUnderLock_(claim) {
  const records = SheetDb.listMany(['ROOMMATES', 'VACATIONS']);
  const known = records.ROOMMATES.some(function (roommate) {
    return roommate.roommate_id === claim.roommateId && roommate.active === true;
  });
  if (!known) throw appError_('UNKNOWN_ROOMMATE', 'Unknown roommate.');

  const start = berlinMidnight_(claim.startDay);
  const end = berlinMidnight_(claim.returnDay);
  const mine = records.VACATIONS.filter(function (row) {
    return row.roommate_id === claim.roommateId && !isCancelled_(row) && isValidVacation_(row);
  });
  const overlaps = mine.some(function (row) {
    return start < row.return_date.getTime() && end > row.start_date.getTime();
  });
  if (overlaps) throw appError_('VACATION_OVERLAP', 'Overlaps another vacation.');
  const planned = mine.filter(function (row) {
    return row.return_date.getTime() > Date.now();
  });
  if (planned.length >= VACATION_MAX_ACTIVE_PER_ROOMMATE) throw appError_('VACATION_LIMIT', 'Too many vacations.');

  try {
    return SheetDb.insert('VACATIONS', { roommate_id: claim.roommateId, start_date: new Date(start), return_date: new Date(end) }).vacation_id;
  } catch (error) {
    console.error(error);
    throw appError_('WRITE_FAILED', 'Could not save.');
  }
}

/**
 * Runs under the lock with the Sheet as it is now. A vacation that skipped a turn stays (its log names it). One that
 * has started also stays when removing it would change the current turn (who cleans, its dates or a skip due for it),
 * as with editing; a not-yet-started one may still hand the open turn back, as cancelling always did. Past turns are
 * already logged and later turns are only a forecast, so the cleaning history never changes.
 */
function cancelUnderLock_(claim) {
  const records = SheetDb.listMany(ROTATION_SHEETS);
  const vacation = records.VACATIONS.find(function (row) {
    return row.vacation_id === claim.vacationId && !isCancelled_(row);
  });
  if (!vacation) throw appError_('VACATION_NOT_FOUND', 'No such vacation.');
  if (vacation.roommate_id !== claim.roommateId) throw appError_('NOT_YOUR_VACATION', 'Someone else’s vacation.');
  if (!isValidVacation_(vacation)) throw appError_('VACATION_NOT_FOUND', 'Not a usable vacation row.');
  if (vacationSkippedATurn_(vacation.vacation_id, records.CLEANING_LOGS)) throw appError_('VACATION_IN_USE', 'Already skipped a turn.');
  const now = new Date();
  if (vacation.start_date.getTime() <= now.getTime() && !keepsCurrentTurn_(records, vacation, now, currentTurnKey_(records, null, null, now))) {
    throw appError_('VACATION_DELETE_CONFLICT', 'Removing it would change the current turn.');
  }

  try {
    SheetDb.update('VACATIONS', claim.vacationId, { cancelled_at: new Date() });
  } catch (error) {
    console.error(error);
    throw appError_('WRITE_FAILED', 'Could not save.');
  }
}

/** The current turn as the engine works it out with `vacation` left out (or as it is, for null). */
function turnWithout_(records, vacation, now) {
  const vacations = records.VACATIONS.filter(function (row) {
    return row !== vacation;
  });
  try {
    return getCurrentTurn_(toRotationData_(Object.assign({}, records, { VACATIONS: vacations })), now);
  } catch (error) {
    throw error.code ? error : appError_('ROTATION_DATA_INVALID', String(error.message));
  }
}

/** Whether the current turn is the same with `vacation` removed; `baseline` is currentTurnKey_ with nothing replaced. */
function keepsCurrentTurn_(records, vacation, now, baseline) {
  return currentTurnKey_(records, vacation, Object.assign({}, vacation, { cancelled_at: now }), now) === baseline;
}

function vacationSkippedATurn_(vacationId, logs) {
  return logs.some(function (log) {
    return log.outcome === 'vacation_skipped' && log.notes === 'Skipped for vacation ' + vacationId;
  });
}

/** Cleaning weekends from now on that a vacation overlaps, as Calendar weekends. */
function weekendsOfVacation_(startMs, endMs, nowMs) {
  const weekends = [];
  let weekend = weekendAfter_(startMs - 3 * CALENDAR_DAY_MS, -Infinity);
  for (let i = 0; i < VACATION_PREVIEW_TURNS && weekend.startsAt < endMs; i++) {
    if (weekend.dueAt > startMs && weekend.dueAt > nowMs) weekends.push(weekend);
    weekend = weekendFromSaturday_(weekend.saturday + 7);
  }
  return weekends;
}

function vacationToJson_(row, name, now, turns, skippedLogs, deletable, turnChange) {
  const start = row.start_date.getTime();
  const end = row.return_date.getTime();
  const returned = end <= now.getTime();
  const lastDue = turns[turns.length - 1].due_at.getTime();
  // A finished vacation lists all its weekends. Only a recorded skip can be confirmed for a past weekend.
  const weekends = weekendsOfVacation_(start, end, returned ? -Infinity : now.getTime()).map(function (weekend) {
    const recorded = skippedLogs.some(function (log) {
      return log.roommate_id === row.roommate_id && log.due_date.getTime() === weekend.dueAt;
    });
    if (weekend.dueAt <= now.getTime()) {
      return { weekend_starts_at: new Date(weekend.startsAt).toISOString(), due_at: new Date(weekend.dueAt).toISOString(), status: recorded ? 'skipped' : 'past' };
    }
    const turn = turns.find(function (candidate) {
      return candidate.due_at.getTime() === weekend.dueAt;
    });
    // A late-added vacation over the current turn shows as a conflict until the next page load records the skip.
    const pending = Boolean(turn) && turn.owner_id === row.roommate_id && Boolean(turn.vacation_conflict_id);
    let status = 'not_their_turn';
    if (recorded || pending || (turn && turn.skipped_ids.indexOf(row.roommate_id) !== -1)) status = 'skipped';
    else if (!turn && weekend.dueAt > lastDue) status = 'later';
    return { weekend_starts_at: new Date(weekend.startsAt).toISOString(), due_at: new Date(weekend.dueAt).toISOString(), status: status };
  });
  const id = row.vacation_id ? String(row.vacation_id) : null;
  const canDelete = deletable(row);
  return {
    vacation_id: id,
    roommate_id: row.roommate_id,
    name: name,
    start_date: row.start_date.toISOString(),
    return_date: row.return_date.toISOString(),
    state: returned ? 'returned' : start <= now.getTime() ? 'away' : 'upcoming',
    cancellable: canDelete, // whether its owner may delete it (cancelVacation)
    delete_changes_turn: turnChange(row, canDelete), // who would clean the open turn instead after a delete, or null
    weekends: weekends,
  };
}
