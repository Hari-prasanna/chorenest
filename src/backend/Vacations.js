const VACATION_MAX_DAYS = 120;
const VACATION_MAX_AHEAD_DAYS = 366;
const VACATION_MAX_ACTIVE_PER_ROOMMATE = 10;
const VACATION_PREVIEW_TURNS = 20;
const VACATION_LIST_LIMIT = 50;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// These three functions are called from the page. `roommate_id` is the roommate picked on the page: an UNVERIFIED
// claim, not a login. It only decides whose vacation is changed, and it grants nothing else.

/**
 * Browser API: plans a vacation. Request: { roommate_id, start_date, return_date } with 'YYYY-MM-DD' Berlin dates,
 * where return_date is the first day back. Returns { ok: true, vacation_id } or { ok: false, error }.
 */
function saveVacation(request) {
  let locked = false;
  const lock = LockService.getScriptLock();
  try {
    const claim = parseVacationRequest_(request);
    if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Someone else is saving right now.');
    locked = true;
    return { ok: true, vacation_id: addVacationUnderLock_(claim) };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  } finally {
    if (locked) lock.releaseLock();
  }
}

/**
 * Browser API: cancels a vacation that has not started and has not skipped a turn yet. Nothing is deleted: the row
 * gets a cancelled_at time and the rotation engine ignores it. Request: { roommate_id, vacation_id }.
 */
function cancelVacation(request) {
  let locked = false;
  const lock = LockService.getScriptLock();
  try {
    const claim = parseCancelRequest_(request);
    if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Someone else is saving right now.');
    locked = true;
    cancelUnderLock_(claim);
    return { ok: true };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  } finally {
    if (locked) lock.releaseLock();
  }
}

/**
 * Browser API, read-only, no input: current and planned vacations of active roommates, with the cleaning weekends each
 * one affects and whether that weekend's turn is skipped. Names only, no emails.
 */
function listVacations() {
  try {
    const records = SheetDb.listMany(ROTATION_SHEETS);
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

    const vacations = records.VACATIONS
      .filter(function (row) {
        return !isCancelled_(row) && isValidVacation_(row) && row.return_date.getTime() > now.getTime() &&
          Object.prototype.hasOwnProperty.call(names, row.roommate_id);
      })
      .sort(function (a, b) {
        return a.start_date.getTime() - b.start_date.getTime();
      })
      .slice(0, VACATION_LIST_LIMIT)
      .map(function (row) {
        return vacationToJson_(row, names[row.roommate_id], now, turns, skippedLogs);
      });
    return { ok: true, vacations: vacations };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
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
  if (!valid || !ID_PATTERN.test(asText_(request.roommate_id))) {
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

function parseVacationRequest_(request) {
  vacationRequestShape_(request, ['roommate_id', 'start_date', 'return_date']);
  const startDay = parseDay_(request.start_date);
  const returnDay = parseDay_(request.return_date);
  if (startDay === null || returnDay === null) throw appError_('VACATION_DATES_INVALID', 'Not real dates.');
  const today = berlinDay_(Date.now());
  if (startDay < today) throw appError_('VACATION_IN_PAST', 'The first day away is in the past.');
  if (returnDay <= startDay) throw appError_('VACATION_ORDER', 'The first day back must be after the first day away.');
  if (returnDay - startDay > VACATION_MAX_DAYS) throw appError_('VACATION_TOO_LONG', 'Too long.');
  if (startDay - today > VACATION_MAX_AHEAD_DAYS) throw appError_('VACATION_TOO_FAR', 'Too far ahead.');
  return { roommateId: request.roommate_id, startDay: startDay, returnDay: returnDay };
}

function parseCancelRequest_(request) {
  vacationRequestShape_(request, ['roommate_id', 'vacation_id']);
  if (!ID_PATTERN.test(asText_(request.vacation_id))) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  return { roommateId: request.roommate_id, vacationId: request.vacation_id };
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

function cancelUnderLock_(claim) {
  const records = SheetDb.listMany(['VACATIONS', 'CLEANING_LOGS']);
  const vacation = records.VACATIONS.find(function (row) {
    return row.vacation_id === claim.vacationId && !isCancelled_(row);
  });
  if (!vacation) throw appError_('VACATION_NOT_FOUND', 'No such vacation.');
  if (vacation.roommate_id !== claim.roommateId) throw appError_('NOT_YOUR_VACATION', 'Someone else’s vacation.');
  if (!isValidVacation_(vacation) || vacation.start_date.getTime() <= Date.now()) throw appError_('VACATION_STARTED', 'Already started.');
  if (vacationSkippedATurn_(vacation.vacation_id, records.CLEANING_LOGS)) throw appError_('VACATION_IN_USE', 'Already skipped a turn.');

  try {
    SheetDb.update('VACATIONS', claim.vacationId, { cancelled_at: new Date() });
  } catch (error) {
    console.error(error);
    throw appError_('WRITE_FAILED', 'Could not save.');
  }
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

function vacationToJson_(row, name, now, turns, skippedLogs) {
  const start = row.start_date.getTime();
  const lastDue = turns[turns.length - 1].due_at.getTime();
  const weekends = weekendsOfVacation_(start, row.return_date.getTime(), now.getTime()).map(function (weekend) {
    const recorded = skippedLogs.some(function (log) {
      return log.roommate_id === row.roommate_id && log.due_date.getTime() === weekend.dueAt;
    });
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
  return {
    vacation_id: id,
    roommate_id: row.roommate_id,
    name: name,
    start_date: row.start_date.toISOString(),
    return_date: row.return_date.toISOString(),
    state: start <= now.getTime() ? 'away' : 'upcoming',
    cancellable: id !== null && start > now.getTime() && !vacationSkippedATurn_(id, skippedLogs),
    weekends: weekends,
  };
}
