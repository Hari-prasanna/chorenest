const RESOLVE_REASON_MAX_LENGTH = 300;
const RESOLVE_NOTE_PREFIX = 'Resolved by the owner: ';

/**
 * Owner-only, run by hand from the Apps Script editor through the wrapper in EditorTools.js: closes the current turn
 * when it is overdue by recording an admin_resolved log with a reason. The rotation then moves on exactly as it does
 * after a completion. Nothing else is changed, and nothing is ever deleted.
 * 1. Set the Script Properties RESOLVE_DUE_DAY (the turn's last day, the Sunday shown as "Was due" in the app, as
 *    YYYY-MM-DD) and RESOLVE_REASON (required, at most 300 characters).
 * 2. Open the maintenance window (MAINTENANCE_UNTIL), then run resolveOverdueTurn.
 * The day must match the overdue turn, so running it again cannot close the next turn. The properties are left in
 * place for you to delete afterwards.
 */
function resolveOverdueTurn_() {
  assertMaintenanceAllowed_();
  const request = readResolveRequest_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Another save is running. Try again in a moment.');
  try {
    const summary = resolveUnderLock_(request);
    console.log(summary);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function invalidResolve_(message) {
  return appError_('RESOLVE_INVALID', message + ' Nothing was changed.');
}

function readResolveRequest_() {
  const properties = PropertiesService.getScriptProperties();
  const dueText = (properties.getProperty('RESOLVE_DUE_DAY') || '').trim();
  const reason = (properties.getProperty('RESOLVE_REASON') || '').replace(/\s+/g, ' ').trim();
  if (!dueText || !reason) throw invalidResolve_('Set the Script Properties RESOLVE_DUE_DAY and RESOLVE_REASON first.');
  const dueDay = parseDay_(dueText);
  if (dueDay === null) throw invalidResolve_('RESOLVE_DUE_DAY must be a real date as YYYY-MM-DD.');
  if (reason.length > RESOLVE_REASON_MAX_LENGTH || !/[\p{L}\p{N}]/u.test(reason)) {
    throw invalidResolve_('RESOLVE_REASON must be 1-' + RESOLVE_REASON_MAX_LENGTH + ' characters with at least one letter or digit.');
  }
  return { dueDay: dueDay, reason: reason };
}

/** A day number as YYYY-MM-DD. */
function dayToText_(day) {
  return new Date(day * CALENDAR_DAY_MS).toISOString().slice(0, 10);
}

/** Runs under the lock: re-reads the Sheet and checks the request against the real current turn before writing. */
function resolveUnderLock_(request) {
  const records = SheetDb.listMany(ROTATION_SHEETS);
  const data = toRotationData_(records);
  const now = new Date();
  const turn = getCurrentTurn_(data, now);
  // due_at is the exclusive Monday 00:00 boundary, so the turn's last day is the Sunday before it.
  const lastDay = berlinDay_(turn.due_at.getTime() - 1);

  if (turn.status !== 'overdue') {
    throw appError_('TURN_NOT_OVERDUE', 'The current turn (last day ' + dayToText_(lastDay) + ') is not overdue. Nothing was changed.');
  }
  if (lastDay !== request.dueDay) {
    throw appError_('RESOLVE_MISMATCH', 'The overdue turn\'s last day is ' + dayToText_(lastDay) + ', not ' + dayToText_(request.dueDay) + '. Nothing was changed.');
  }
  // A vacation skip keeps the weekend free for the next roommate, which an admin resolution would not.
  if (planVacationSkip_(data, now)) {
    throw appError_('RESOLVE_MISMATCH', 'This turn is skipped automatically for a vacation. Open the app once to record the skip. Nothing was changed.');
  }
  const alreadyLogged = data.logs.some(function (log) {
    return log.rotation_id === turn.rotation_id && log.due_date.getTime() === turn.due_at.getTime();
  });
  if (alreadyLogged) throw appError_('ALREADY_RECORDED', 'This turn already has a log. Nothing was changed.');

  const record = {
    rotation_id: turn.rotation_id,
    roommate_id: turn.assignee_id,
    due_date: turn.due_at,
    outcome: 'admin_resolved',
    resolved_at: now,
    notes: RESOLVE_NOTE_PREFIX + request.reason,
  };
  if (turn.swap_id) record.swap_id = turn.swap_id;
  SheetDb.insert('CLEANING_LOGS', record);

  const assignee = records.ROOMMATES.find(function (roommate) {
    return roommate.roommate_id === turn.assignee_id;
  });
  return 'Resolved the overdue turn of ' + (assignee ? assignee.name : 'an unknown roommate') + ' (last day ' + dayToText_(lastDay) +
    ') as admin_resolved. Delete RESOLVE_DUE_DAY and RESOLVE_REASON, and MAINTENANCE_UNTIL when you are done.';
}
