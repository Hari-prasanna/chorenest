const MARK_CLEANED_FIELDS = ['roommate_id', 'rotation_id', 'due_at'];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Browser API (google.script.run): records that the current assignee cleaned the home.
 * Request: { roommate_id, rotation_id, due_at } exactly as shown by getRotationSchedule().
 * Returns { ok: true, completed_at } or { ok: false, error: { code, message } }.
 *
 * `roommate_id` is an UNVERIFIED claim made by the page. It only stops someone marking another roommate's turn by
 * mistake and grants nothing: there are no roles, and the turn is re-derived from the Sheet under a script lock.
 */
function markCleaned(request) {
  let locked = false;
  const lock = LockService.getScriptLock();
  try {
    const claim = parseMarkRequest_(request);
    if (!lock.tryLock(LOCK_WAIT_MS)) {
      throw appError_('BUSY', 'Someone else is saving right now. Please try again in a moment.');
    }
    locked = true;
    return { ok: true, completed_at: completeCurrentTurn_(claim).toISOString() };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** Only strings are checked against the formats; anything else becomes '' and fails them. */
function asText_(value) {
  return typeof value === 'string' ? value : '';
}

function parseMarkRequest_(request) {
  const valid = Boolean(request) && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).every(function (field) {
      return MARK_CLEANED_FIELDS.indexOf(field) !== -1;
    }) &&
    ID_PATTERN.test(asText_(request.roommate_id)) && ID_PATTERN.test(asText_(request.rotation_id)) &&
    ISO_UTC_PATTERN.test(asText_(request.due_at)) && !isNaN(Date.parse(request.due_at));
  if (!valid) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  return { roommateId: request.roommate_id, rotationId: request.rotation_id, dueMs: Date.parse(request.due_at) };
}

/** Runs under the lock: re-reads the Sheet, checks the claim against the real current turn, then appends the log. */
function completeCurrentTurn_(claim) {
  const data = toRotationData_(SheetDb.listMany(ROTATION_SHEETS));
  const now = new Date();
  let turn;
  try {
    turn = getCurrentTurn_(data, now);
  } catch (error) {
    throw error.code ? error : appError_('ROTATION_DATA_INVALID', String(error.message));
  }

  const alreadyLogged = data.logs.some(function (log) {
    return log.rotation_id === claim.rotationId && log.due_date.getTime() === claim.dueMs;
  });
  if (alreadyLogged) throw appError_('ALREADY_RECORDED', 'This turn was already marked as done.');
  if (turn.rotation_id !== claim.rotationId || turn.due_at.getTime() !== claim.dueMs) {
    throw appError_('STALE_TURN', 'The schedule changed since you loaded it.');
  }
  if (turn.assignee_id !== claim.roommateId) throw appError_('NOT_YOUR_TURN', 'It isn’t your turn to clean right now.');
  if (turn.status !== 'pending' && turn.status !== 'overdue') throw appError_('TURN_NOT_OPEN', 'This turn isn’t open yet.');

  // due_date is the turn's own deadline (not today), so a late completion never moves later turns.
  const record = {
    rotation_id: turn.rotation_id,
    roommate_id: turn.assignee_id,
    due_date: turn.due_at,
    outcome: 'completed',
    resolved_at: now,
    completed_at: now,
    notes: 'Marked done in ChoreNest (the roommate selection is unverified).',
  };
  if (turn.swap_id) record.swap_id = turn.swap_id;

  try {
    SheetDb.insert('CLEANING_LOGS', record);
  } catch (error) {
    console.error(error);
    throw appError_('WRITE_FAILED', 'We couldn’t save that. Nothing was recorded, so you can try again.');
  }
  return now;
}
