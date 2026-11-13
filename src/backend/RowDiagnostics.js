// Read-only row checks for diagnoseDatabase_. They report, and never change or delete, rows of ROTATION,
// CLEANING_LOGS and SWAPS that the app would reject or misread. `breaksSchedule` marks rows that make the rotation engine throw, which
// takes every page down with ROTATION_DATA_INVALID until the row is fixed by hand.
const MAX_REPORTED_ROWS = 50;

/** Data rows with their real sheet row numbers (blank rows are skipped, so they cannot be counted). */
function numberedRecords_(sheet, headers) {
  const values = sheet.getLastRow() === 0 ? [] : sheet.getDataRange().getValues();
  const rows = [];
  values.forEach(function (row, index) {
    if (index > 0 && !isBlankRow_(row)) rows.push({ row: index + 1, record: rowToRecord_(headers, row) });
  });
  return rows;
}

function idsOf_(records, idColumn) {
  const ids = {};
  (records || []).forEach(function (record) {
    if (!isBlank_(record[idColumn])) ids[record[idColumn]] = true;
  });
  return ids;
}

/**
 * Problems of one ROTATION row, mirroring buildRotation_ and readLogs_. created_at is only read while no turn has
 * been logged yet, so a bad one breaks the schedule only then.
 */
function rotationRowProblems_(slot, context) {
  const fatal = [];
  const other = [];
  if (typeof slot.position !== 'number' || !isFinite(slot.position)) fatal.push('position must be a number.');
  else if (context.positions[slot.position]) fatal.push('position ' + slot.position + ' is already used in row ' + context.positions[slot.position] + '.');
  else context.positions[slot.position] = context.row;
  const roommateKey = String(slot.roommate_id);
  if (context.slotRoommates[roommateKey]) fatal.push('roommate_id is already in row ' + context.slotRoommates[roommateKey] + '.');
  else context.slotRoommates[roommateKey] = context.row;
  if (!isDate_(slot.created_at)) (context.hasLogs ? other : fatal).push('created_at must be a date.');
  if (isBlank_(slot.rotation_id)) other.push('rotation_id is required.');
  if (isBlank_(slot.roommate_id)) other.push('roommate_id is required.');
  else if (context.roommateIds && !context.roommateIds[slot.roommate_id]) other.push('roommate_id is not in ROOMMATES.');
  return { fatal: fatal, other: other };
}

/**
 * Problems of one CLEANING_LOGS row. `context` holds ID sets from the other sheets (null when that sheet could not be
 * read) and `seen`, the earlier rows by turn, to find a turn that was resolved twice.
 */
function logRowProblems_(log, context) {
  const fatal = [];
  const other = [];
  try {
    assertLogOutcome_(log);
  } catch (error) {
    fatal.push(String(error.message).replace(/^CLEANING_LOGS: /, ''));
  }
  ['due_date', 'resolved_at'].forEach(function (field) {
    if (!isDate_(log[field])) fatal.push(field + ' must be a date.');
  });
  if (!isBlank_(log.completed_at) && !isDate_(log.completed_at)) other.push('completed_at must be a date.');
  if (context.rotationIds && !context.rotationIds[log.rotation_id]) fatal.push('rotation_id is not in ROTATION.');
  if (isBlank_(log.roommate_id)) other.push('roommate_id is required.');
  else if (context.roommateIds && !context.roommateIds[log.roommate_id]) other.push('roommate_id is not in ROOMMATES.');
  if (!isBlank_(log.swap_id) && context.swapIds && !context.swapIds[log.swap_id]) other.push('swap_id is not in SWAPS.');
  if (isDate_(log.due_date) && !isBlank_(log.rotation_id)) {
    const turn = log.rotation_id + '|' + log.due_date.getTime();
    if (context.seen[turn]) other.push('the same turn is already resolved in row ' + context.seen[turn] + '.');
    else context.seen[turn] = context.row;
  }
  return { fatal: fatal, other: other };
}

/** Problems of one SWAPS row. Only accepted swaps between two people are read by the engine. */
function swapRowProblems_(swap, context) {
  const fatal = [];
  const other = [];
  SCHEMAS.SWAPS.required.forEach(function (field) {
    if (isBlank_(swap[field])) other.push(field + ' is required.');
  });
  const used = swap.status === 'accepted' && swap.from_roommate_id !== swap.to_roommate_id;
  ['from_due_date', 'to_due_date', 'created_at'].forEach(function (field) {
    if (!isDate_(swap[field]) && (used || !isBlank_(swap[field]))) (used ? fatal : other).push(field + ' must be a date.');
  });
  if (!isBlank_(swap.from_roommate_id) && swap.from_roommate_id === swap.to_roommate_id) other.push('from_roommate_id and to_roommate_id are the same.');
  ['from_roommate_id', 'to_roommate_id'].forEach(function (field) {
    if (!isBlank_(swap[field]) && context.roommateIds && !context.roommateIds[swap[field]]) other.push(field + ' is not in ROOMMATES.');
  });
  return { fatal: fatal, other: other };
}

/**
 * Invalid rows of ROTATION, CLEANING_LOGS and SWAPS, keyed by sheet name. `tables` maps each sheet name to { sheet, headers }
 * for sheets whose headers are valid; sheets missing from it are not checked. Reads only.
 */
function findInvalidRows_(tables) {
  const records = {};
  Object.keys(tables).forEach(function (sheetName) {
    records[sheetName] = numberedRecords_(tables[sheetName].sheet, tables[sheetName].headers);
  });
  const recordsOf = function (sheetName) {
    return records[sheetName] ? records[sheetName].map(function (item) { return item.record; }) : null;
  };
  const ids = function (sheetName) {
    return records[sheetName] ? idsOf_(recordsOf(sheetName), SCHEMAS[sheetName].idColumn) : null;
  };
  const context = {
    rotationIds: ids('ROTATION'),
    roommateIds: ids('ROOMMATES'),
    swapIds: ids('SWAPS'),
    hasLogs: Boolean(records.CLEANING_LOGS && records.CLEANING_LOGS.length),
    seen: {},
    positions: {},
    slotRoommates: {},
  };
  const checks = { ROTATION: rotationRowProblems_, CLEANING_LOGS: logRowProblems_, SWAPS: swapRowProblems_ };

  const report = {};
  Object.keys(checks).forEach(function (sheetName) {
    if (!records[sheetName]) return;
    const idColumn = SCHEMAS[sheetName].idColumn;
    const invalid = [];
    records[sheetName].forEach(function (item) {
      context.row = item.row;
      const problems = checks[sheetName](item.record, context);
      if (!problems.fatal.length && !problems.other.length) return;
      invalid.push({
        row: item.row,
        id: isBlank_(item.record[idColumn]) ? null : String(item.record[idColumn]),
        breaksSchedule: problems.fatal.length > 0,
        problems: problems.fatal.concat(problems.other),
      });
    });
    report[sheetName] = { count: invalid.length, rows: invalid.slice(0, MAX_REPORTED_ROWS) };
  });
  return report;
}
