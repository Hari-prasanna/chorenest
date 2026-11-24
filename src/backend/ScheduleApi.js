const UPCOMING_TURN_COUNT = 3;
const ROTATION_SHEETS = ['ROOMMATES', 'ROTATION', 'CLEANING_LOGS', 'SWAPS', 'VACATIONS'];

// What the browser may learn about a failure. Details (sheet names, IDs, columns) stay in the server log.
const SETUP_PROBLEM = 'ChoreNest isn’t set up correctly.';
const PUBLIC_ERROR_MESSAGES = {
  CONFIG_INVALID: SETUP_PROBLEM,
  SPREADSHEET_UNAVAILABLE: SETUP_PROBLEM,
  DATABASE_NOT_SET_UP: SETUP_PROBLEM,
  DATABASE_ENVIRONMENT_MISMATCH: SETUP_PROBLEM,
  TIMEZONE_MISMATCH: SETUP_PROBLEM,
  SCHEMA_INVALID: SETUP_PROBLEM,
  UNAUTHENTICATED: 'Please sign in again.',
  PASSWORD_CHANGE_REQUIRED: 'Please choose a new password first.',
  FORBIDDEN: 'You don’t have access to that.',
  // One message for unknown usernames, wrong passwords and locked accounts, so none can be told apart.
  LOGIN_FAILED: 'Sign-in failed. Check your username and password. After several failed attempts, wait 15 minutes.',
  PASSWORD_WEAK: 'Choose a password of at least 10 characters that isn’t easy to guess.',
  PASSWORD_REUSED: 'Choose a password different from the current one.',
  TEMP_PASSWORD_EXPIRED: 'This temporary password has expired. Ask the app owner for a new one.',
  PASSWORD_CHANGE_FAILED: 'Your current password is wrong, or there were too many attempts. Wait 15 minutes and try again.',
  ROTATION_EMPTY: 'There is no rotation yet.',
  ROTATION_DATA_INVALID: 'The rotation data needs attention.',
  INVALID_REQUEST: 'That request wasn’t valid, so nothing was saved.',
  BUSY: 'Someone else is saving right now. Please try again in a moment.',
  NOT_YOUR_TURN: 'It isn’t your turn to clean right now.',
  STALE_TURN: 'The schedule changed since you loaded it.',
  ALREADY_RECORDED: 'This turn was already marked as done.',
  TURN_NOT_OPEN: 'This turn isn’t open yet.',
  WRITE_FAILED: 'We couldn’t save that. Nothing was recorded, so you can try again.',
  UNKNOWN_ROOMMATE: 'That roommate isn’t on the list.',
  VACATION_DATES_INVALID: 'Pick a first day away and a first day back that are real dates.',
  VACATION_IN_PAST: 'The first day away can’t be in the past.',
  VACATION_ORDER: 'The first day back must be after the first day away.',
  VACATION_TOO_LONG: 'A vacation can last at most 120 days. Please split longer ones.',
  VACATION_TOO_FAR: 'A vacation can start at most a year ahead.',
  VACATION_OVERLAP: 'There is already a vacation on those dates.',
  VACATION_LIMIT: 'Too many vacations are planned. Cancel one first.',
  VACATION_NOT_FOUND: 'That vacation isn’t there any more.',
  RECORD_NOT_FOUND: 'That vacation isn’t there any more.',
  NOT_YOUR_VACATION: 'That vacation belongs to someone else.',
  VACATION_STARTED: 'A vacation that has started can’t be cancelled here.',
  VACATION_IN_USE: 'This vacation has already skipped a turn, so it can’t be cancelled here.',
  VACATION_CHANGED: 'This vacation changed since you loaded it. Here’s the latest.',
  VACATION_ENDED: 'This vacation is over, so it can’t be changed.',
  VACATION_START_LOCKED: 'A vacation that has started keeps its first day away.',
  VACATION_BACK_IN_PAST: 'The first day back can’t be in the past.',
  VACATION_NOT_STARTED: 'This vacation hasn’t started yet. Edit or cancel it instead.',
  VACATION_JUST_STARTED: 'This vacation started today, so it can’t end today. Ask the app owner to remove it.',
  VACATION_SKIP_RECORDED: 'A turn was already skipped for this vacation, and the new dates no longer cover it. Ask the app owner to change it.',
  VACATION_TURN_CONFLICT: 'This change would affect the current cleaning turn, so it can’t be made here. Ask the app owner to sort it out.',
  INTERNAL_ERROR: 'Something went wrong. Try again later.',
};

/**
 * Browser API (google.script.run): the current cleaning turn and the next few, read-only.
 * Request: { token }. Returns { ok: true, viewer, generated_at, current, upcoming, roommates } or
 * { ok: false, error: { code, message } } (with `viewer` when only the rotation data is the problem).
 * `viewer` is the signed-in roommate from the session; `roommates` lists active roommates' names for display.
 * Dates are ISO strings because google.script.run cannot return Date objects.
 */
function getRotationSchedule(request) {
  let records;
  let viewer;
  try {
    authRequest_(request, ['token']);
    records = SheetDb.listMany(ROTATION_SHEETS);
    viewer = viewerOf_(sessionOf_(request, records.ROOMMATES));
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }

  try {
    let data = toRotationData_(records);
    const ignored = ignoredVacationRows_(data);
    if (ignored.length) console.error('Ignoring vacation rows that are not dates or return before they start: ' + ignored.join(', '));
    // Ordinary loads stay lock-free; only a due vacation skip takes the lock, then the page shows the result.
    if (planVacationSkip_(data, new Date())) {
      applyVacationSkips_();
      data = toRotationData_(SheetDb.listMany(ROTATION_SHEETS));
    }
    const now = new Date();
    const current = getCurrentTurn_(data, now);
    const upcoming = previewTurns_(data, now, UPCOMING_TURN_COUNT + 1).slice(1);
    const names = {};
    data.roommates.forEach(function (roommate) {
      names[roommate.roommate_id] = String(roommate.name);
    });

    const roommates = data.roommates
      .filter(function (roommate) {
        return roommate.active === true;
      })
      .map(function (roommate) {
        return { roommate_id: roommate.roommate_id, name: names[roommate.roommate_id] };
      })
      .sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });

    const currentJson = turnToJson_(current, names);
    currentJson.status = current.status;
    return {
      ok: true,
      viewer: viewer,
      generated_at: now.toISOString(),
      current: currentJson,
      upcoming: upcoming.map(function (turn) {
        return turnToJson_(turn, names);
      }),
      roommates: roommates,
    };
  } catch (error) {
    // The engine only throws because of the data it was given.
    return Object.assign(apiError_(error, 'ROTATION_DATA_INVALID'), { viewer: viewer });
  }
}

/** The engine's input, from the records of ROTATION_SHEETS. */
function toRotationData_(records) {
  return {
    roommates: records.ROOMMATES,
    rotation: records.ROTATION,
    logs: records.CLEANING_LOGS,
    swaps: records.SWAPS,
    vacations: records.VACATIONS.filter(function (row) {
      return !isCancelled_(row);
    }),
  };
}

/** A turn with names instead of emails and ISO strings instead of Dates. */
function turnToJson_(turn, names) {
  const person = function (roommateId) {
    return { roommate_id: roommateId, name: names[roommateId] || null };
  };
  return {
    rotation_id: turn.rotation_id,
    owner: person(turn.owner_id),
    assignee: person(turn.assignee_id),
    swap_id: turn.swap_id,
    skipped: turn.skipped_ids.map(person),
    vacation_conflict_id: turn.vacation_conflict_id,
    opens_at: turn.opens_at.toISOString(),
    weekend_starts_at: turn.weekend_starts_at.toISOString(),
    due_at: turn.due_at.toISOString(),
  };
}

/** An error response with a fixed public message. Unknown codes become the fallback code, so nothing leaks. */
function apiError_(error, fallbackCode) {
  console.error(error);
  const known = Boolean(error) && Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_MESSAGES, error.code);
  const code = known ? error.code : fallbackCode;
  return { ok: false, error: { code: code, message: PUBLIC_ERROR_MESSAGES[code] } };
}
