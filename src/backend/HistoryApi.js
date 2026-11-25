const HISTORY_LIMIT = 10;

/**
 * Browser API, read-only: { token } -> { ok, entries, limit }. The latest HISTORY_LIMIT cleaning records, newest
 * weekend first, for any signed-in roommate. Each entry: { log_id, roommate: { roommate_id, name }, weekend_starts_at,
 * due_at, outcome, completed_at, resolved_at, swapped }. Notes, emails and other columns are never sent. Rows that are
 * not well-formed (see RowDiagnostics.js) are left out rather than breaking the page.
 */
function listCleaningHistory(request) {
  try {
    authRequest_(request, ['token']);
    const records = SheetDb.listMany(['ROOMMATES', 'CLEANING_LOGS']);
    sessionOf_(request, records.ROOMMATES);
    const names = {};
    records.ROOMMATES.forEach(function (roommate) {
      names[roommate.roommate_id] = String(roommate.name);
    });
    const entries = records.CLEANING_LOGS
      .filter(isHistoryRow_)
      .sort(function (a, b) {
        return b.due_date.getTime() - a.due_date.getTime() || b.resolved_at.getTime() - a.resolved_at.getTime();
      })
      .slice(0, HISTORY_LIMIT)
      .map(function (log) {
        return historyEntry_(log, names);
      });
    return { ok: true, entries: entries, limit: HISTORY_LIMIT };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

function isHistoryDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

function isHistoryRow_(log) {
  return CLEANING_OUTCOMES.indexOf(log.outcome) !== -1 && typeof log.roommate_id === 'string' && log.roommate_id !== '' &&
    isHistoryDate_(log.due_date) && isHistoryDate_(log.resolved_at);
}

/** The weekend comes from the turn's own deadline (Monday 00:00 Berlin), like the schedule's turns. */
function historyEntry_(log, names) {
  const weekend = weekendFromSaturday_(saturdayOfDue_(log.due_date.getTime()));
  return {
    log_id: String(log.log_id),
    roommate: { roommate_id: log.roommate_id, name: Object.prototype.hasOwnProperty.call(names, log.roommate_id) ? names[log.roommate_id] : null },
    weekend_starts_at: new Date(weekend.startsAt).toISOString(),
    due_at: new Date(weekend.dueAt).toISOString(),
    outcome: log.outcome,
    completed_at: log.outcome === 'completed' && isHistoryDate_(log.completed_at) ? log.completed_at.toISOString() : null,
    resolved_at: log.resolved_at.toISOString(),
    swapped: !isBlank_(log.swap_id),
  };
}
