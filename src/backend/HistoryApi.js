const HISTORY_PAGE_SIZE = 25;
const HISTORY_DEFAULT_RANGE = '14d';
// Range name -> calendar days (Europe/Berlin, today included); null is all time.
const HISTORY_RANGES = { '14d': 14, '30d': 30, '90d': 90, all: null };
const HISTORY_STATUS_LABELS = { completed: 'Cleaned', vacation_skipped: 'Skipped: away', admin_resolved: 'Closed by the app owner' };
const HISTORY_CSV_BOM = String.fromCharCode(0xfeff);
const HISTORY_CSV_HEADER = ['Weekend start', 'Weekend end', 'Roommate', 'Status', 'Resolved (Berlin time)', 'Swapped turn'];

/**
 * Browser API, read-only: { token, range?, page? } -> { ok, entries, range, page, page_size, total, pages }.
 * range is '14d' (default), '30d', '90d' or 'all'. A cleaning belongs to a range when its weekend's Sunday (Berlin) is
 * within the last N calendar days, today included. Records are newest weekend first, HISTORY_PAGE_SIZE per page; a
 * page past the end returns the last page. Any signed-in roommate may read it. Each entry: { log_id,
 * roommate: { roommate_id, name }, weekend_starts_at, due_at, outcome, completed_at, resolved_at, swapped, has_photo,
 * can_add_photo, can_delete_photo }. Notes,
 * emails and other columns are never sent. Rows that are not well-formed (see RowDiagnostics.js) are left out.
 */
function listCleaningHistory(request) {
  try {
    const query = historyQuery_(request, true);
    const records = SheetDb.listMany(['ROOMMATES', 'CLEANING_LOGS']);
    const session = sessionOf_(request, records.ROOMMATES);
    const names = historyNames_(records);
    const rows = historyRows_(records, query.range, new Date());
    const pages = Math.max(1, Math.ceil(rows.length / HISTORY_PAGE_SIZE));
    const page = Math.min(query.page, pages);
    const entries = rows.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE).map(function (log) {
      return Object.assign(historyEntry_(log, names), photoFlags_(log, session));
    });
    return { ok: true, entries: entries, range: query.range, page: page, page_size: HISTORY_PAGE_SIZE, total: rows.length, pages: pages };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

/**
 * Browser API, read-only: { token, range? } -> { ok, filename, csv, count }. The same records as listCleaningHistory
 * for that range, all pages, as CSV (UTF-8 with a byte order mark, so Excel reads names correctly). Same session rules.
 * Text that starts like a formula is prefixed with an apostrophe, so a spreadsheet never runs it.
 */
function exportCleaningHistory(request) {
  try {
    const query = historyQuery_(request, false);
    const records = SheetDb.listMany(['ROOMMATES', 'CLEANING_LOGS']);
    sessionOf_(request, records.ROOMMATES);
    const names = historyNames_(records);
    const now = new Date();
    const rows = historyRows_(records, query.range, now);
    const lines = [HISTORY_CSV_HEADER].concat(rows.map(function (log) {
      return historyCsvRow_(log, names);
    }));
    const csv = HISTORY_CSV_BOM + lines.map(function (line) {
      return line.map(csvCell_).join(',');
    }).join('\r\n') + '\r\n';
    return { ok: true, filename: 'chorenest-history-' + query.range + '-' + berlinDateText_(now.getTime()) + '.csv', csv: csv, count: rows.length };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

/** Only known fields. The token is checked by authRequest_; range and page by value. */
function historyQuery_(request, withPage) {
  const allowed = withPage ? ['token', 'range', 'page'] : ['token', 'range'];
  const shaped = Boolean(request) && typeof request === 'object' && !Array.isArray(request) && Object.keys(request).every(function (field) {
    return allowed.indexOf(field) !== -1;
  });
  if (!shaped) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  authRequest_({ token: request.token }, ['token']);
  const range = request.range === undefined ? HISTORY_DEFAULT_RANGE : request.range;
  const page = request.page === undefined ? 1 : request.page;
  if (typeof range !== 'string' || !Object.prototype.hasOwnProperty.call(HISTORY_RANGES, range) ||
      typeof page !== 'number' || page !== Math.floor(page) || page < 1 || page > 100000) {
    throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
  }
  return { range: range, page: page };
}

function historyNames_(records) {
  const names = {};
  records.ROOMMATES.forEach(function (roommate) {
    names[roommate.roommate_id] = String(roommate.name);
  });
  return names;
}

/** Well-formed records of the range, newest weekend first. */
function historyRows_(records, range, now) {
  const days = HISTORY_RANGES[range];
  const firstDay = days === null ? null : berlinDay_(now.getTime()) - (days - 1);
  return records.CLEANING_LOGS
    .filter(isHistoryRow_)
    .filter(function (log) {
      return firstDay === null || saturdayOfDue_(log.due_date.getTime()) + 1 >= firstDay; // the weekend's Sunday
    })
    .sort(function (a, b) {
      return b.due_date.getTime() - a.due_date.getTime() || b.resolved_at.getTime() - a.resolved_at.getTime();
    });
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

// ---------- CSV ----------

/** 'YYYY-MM-DD' of a UTC instant as the Berlin calendar date. */
function berlinDateText_(ms) {
  return new Date(ms + berlinOffsetMs_(ms)).toISOString().slice(0, 10);
}

function berlinDateTimeText_(ms) {
  return new Date(ms + berlinOffsetMs_(ms)).toISOString().slice(0, 16).replace('T', ' ');
}

function historyCsvRow_(log, names) {
  const saturday = saturdayOfDue_(log.due_date.getTime());
  const known = Object.prototype.hasOwnProperty.call(names, log.roommate_id);
  return [
    new Date(saturday * CALENDAR_DAY_MS).toISOString().slice(0, 10),
    new Date((saturday + 1) * CALENDAR_DAY_MS).toISOString().slice(0, 10),
    known ? names[log.roommate_id] : 'Unknown roommate',
    HISTORY_STATUS_LABELS[log.outcome],
    berlinDateTimeText_(log.resolved_at.getTime()),
    isBlank_(log.swap_id) ? 'No' : 'Yes',
  ];
}

/** One CSV field: text starting like a formula gets a leading apostrophe; quotes, commas and line breaks are quoted. */
function csvCell_(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START_PATTERN.test(text)) text = '\'' + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
