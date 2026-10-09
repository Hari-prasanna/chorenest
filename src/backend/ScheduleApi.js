const UPCOMING_TURN_COUNT = 3;
const ROTATION_SHEETS = ['ROOMMATES', 'ROTATION', 'CLEANING_LOGS', 'SWAPS', 'VACATIONS'];

/**
 * Browser API (google.script.run): the current cleaning turn and the next few, read-only.
 * Returns { ok: true, environment, generated_at, current, upcoming } or { ok: false, error: { code, message } }.
 * Dates are ISO strings because google.script.run cannot return Date objects.
 */
function getRotationSchedule() {
  let environment;
  let records;
  try {
    environment = getEnvironment();
    records = SheetDb.listMany(ROTATION_SHEETS);
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }

  try {
    const data = {
      roommates: records.ROOMMATES,
      rotation: records.ROTATION,
      logs: records.CLEANING_LOGS,
      swaps: records.SWAPS,
      vacations: records.VACATIONS,
    };
    const now = new Date();
    const current = getCurrentTurn_(data, now);
    const upcoming = previewTurns_(data, now, UPCOMING_TURN_COUNT + 1).slice(1);
    const names = {};
    data.roommates.forEach(function (roommate) {
      names[roommate.roommate_id] = String(roommate.name);
    });

    const currentJson = turnToJson_(current, names);
    currentJson.status = current.status;
    return {
      ok: true,
      environment: environment,
      generated_at: now.toISOString(),
      current: currentJson,
      upcoming: upcoming.map(function (turn) {
        return turnToJson_(turn, names);
      }),
    };
  } catch (error) {
    // The engine only throws because of the data it was given.
    return apiError_(error, 'ROTATION_DATA_INVALID');
  }
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

function apiError_(error, fallbackCode) {
  console.error(error);
  const code = error && error.code ? error.code : fallbackCode;
  const message = code === 'INTERNAL_ERROR' ? 'Something went wrong. Try again later.' : String(error.message);
  return { ok: false, error: { code: code, message: message } };
}
