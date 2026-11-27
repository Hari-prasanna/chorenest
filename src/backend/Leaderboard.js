// Leaderboard: points and streaks derived from CLEANING_LOGS on every request. Nothing is stored.
const LEADERBOARD_PERIODS = ['month', 'all'];
const POINTS_ON_TIME = 15;
const POINTS_LATE = 10;

/**
 * Browser API, read-only: { token, period? } -> { ok, period, month, entries }. `period` is 'month' (default: the
 * current Berlin calendar month) or 'all'; `month` is that month as 'YYYY-MM', or null for all time. Any signed-in
 * roommate may read it. Each entry: { rank, roommate: { roommate_id, name, avatar, active }, is_you, points,
 * completed, on_time, late, missed, skipped, on_time_percent, best_streak, current_streak }.
 *
 * Who scores is the log's roommate_id: the roommate who actually cleaned (on a swapped turn, the partner), never the
 * owner of the rotation slot. A turn belongs to the month of its weekend's Sunday (Berlin), like History.
 * Every active roommate is listed (with zeros if need be); a roommate who moved out is listed only with records in the
 * period. Records naming nobody in ROOMMATES, and malformed rows, are left out. Equal points share a rank (1, 1, 3);
 * within a rank, names are in alphabetical order. Emails, usernames, roles, codes and notes are never sent.
 */
function getLeaderboard(request) {
  try {
    const period = leaderboardQuery_(request);
    const records = SheetDb.listMany(['ROOMMATES', 'CLEANING_LOGS']);
    const session = sessionOf_(request, records.ROOMMATES);
    const now = new Date();
    const month = period === 'month' ? berlinDateText_(now.getTime()).slice(0, 7) : null;
    const byRoommate = {};
    records.ROOMMATES.forEach(function (roommate) {
      byRoommate[roommate.roommate_id] = { roommate: roommate, all: [], period: [] };
    });
    records.CLEANING_LOGS.filter(isHistoryRow_).forEach(function (log) {
      const bucket = Object.prototype.hasOwnProperty.call(byRoommate, log.roommate_id) ? byRoommate[log.roommate_id] : null;
      if (!bucket) return;
      bucket.all.push(log);
      if (month === null || turnMonth_(log) === month) bucket.period.push(log);
    });

    const entries = Object.keys(byRoommate).map(function (id) {
      return byRoommate[id];
    }).filter(function (bucket) {
      return bucket.roommate.active === true || bucket.period.length > 0;
    }).map(function (bucket) {
      const stats = scoreLogs_(bucket.period);
      const roommate = bucket.roommate;
      return {
        rank: 0,
        roommate: { roommate_id: roommate.roommate_id, name: String(roommate.name), avatar: avatarOf_(roommate), active: roommate.active === true },
        is_you: roommate.roommate_id === session.roommateId,
        points: stats.points,
        completed: stats.completed,
        on_time: stats.on_time,
        late: stats.late,
        missed: stats.missed,
        skipped: stats.skipped,
        on_time_percent: stats.on_time_percent,
        best_streak: stats.best_streak,
        current_streak: scoreLogs_(bucket.all).current_streak, // a streak runs on across months
      };
    }).sort(function (a, b) {
      return b.points - a.points || a.roommate.name.localeCompare(b.roommate.name) || (a.roommate.roommate_id < b.roommate.roommate_id ? -1 : 1);
    });
    entries.forEach(function (entry, index) {
      entry.rank = index > 0 && entries[index - 1].points === entry.points ? entries[index - 1].rank : index + 1;
    });
    return { ok: true, period: period, month: month, entries: entries };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

/** Only { token, period? }; period one of LEADERBOARD_PERIODS. Returns the period. */
function leaderboardQuery_(request) {
  const valid = Boolean(request) && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).every(function (field) {
      return field === 'token' || field === 'period';
    }) && typeof request.token === 'string' && request.token.length <= MAX_TOKEN_LENGTH &&
    (request.period === undefined || LEADERBOARD_PERIODS.indexOf(request.period) !== -1);
  if (!valid) throw appError_('INVALID_REQUEST', 'That request wasn’t valid.');
  return request.period === undefined ? 'month' : request.period;
}

/** 'YYYY-MM' of the turn's weekend Sunday, as a Berlin calendar day (day numbers, so clock changes do not matter). */
function turnMonth_(log) {
  const sunday = saturdayOfDue_(log.due_date.getTime()) + 1;
  return new Date(sunday * CALENDAR_DAY_MS).toISOString().slice(0, 7);
}

/** Whether a completed log was marked before its turn's deadline (the exclusive Monday 00:00 Berlin due_date). */
function isOnTime_(log) {
  const markedAt = isHistoryDate_(log.completed_at) ? log.completed_at : log.resolved_at;
  return markedAt.getTime() < log.due_date.getTime();
}

/**
 * The one scoring of a roommate's well-formed cleaning logs, shared by the leaderboard and member profiles.
 *   completed on time: 15 points, streak + 1 | completed late: 10 points, streak back to 0
 *   admin_resolved: 0 points, streak back to 0  | vacation_skipped: 0 points, streak unchanged
 * Logs are taken in turn order (due date, then resolved time). on_time_percent is on_time / completed, or null.
 */
function scoreLogs_(logs) {
  const totals = { points: 0, completed: 0, on_time: 0, late: 0, missed: 0, skipped: 0, best_streak: 0, current_streak: 0 };
  logs.slice().sort(function (a, b) {
    return a.due_date.getTime() - b.due_date.getTime() || a.resolved_at.getTime() - b.resolved_at.getTime();
  }).forEach(function (log) {
    if (log.outcome === 'completed') {
      totals.completed++;
      if (isOnTime_(log)) {
        totals.on_time++;
        totals.points += POINTS_ON_TIME;
        totals.current_streak++;
        totals.best_streak = Math.max(totals.best_streak, totals.current_streak);
      } else {
        totals.late++;
        totals.points += POINTS_LATE;
        totals.current_streak = 0;
      }
    } else if (log.outcome === 'admin_resolved') {
      totals.missed++;
      totals.current_streak = 0;
    } else if (log.outcome === 'vacation_skipped') {
      totals.skipped++;
    }
  });
  totals.on_time_percent = totals.completed ? Math.round(100 * totals.on_time / totals.completed) : null;
  return totals;
}
