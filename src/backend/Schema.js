// Column order is used only when creating headers; reads and writes map by header name.
const SCHEMAS = {
  ROOMMATES: {
    idColumn: 'roommate_id',
    columns: ['roommate_id', 'name', 'email', 'active', 'created_at'],
    required: ['name', 'email', 'active'],
  },
  ROTATION: {
    idColumn: 'rotation_id',
    columns: ['rotation_id', 'position', 'roommate_id', 'created_at'],
    required: ['position', 'roommate_id'],
  },
  CLEANING_LOGS: {
    idColumn: 'log_id',
    columns: ['log_id', 'rotation_id', 'roommate_id', 'swap_id', 'due_date', 'outcome', 'resolved_at', 'completed_at', 'notes', 'created_at'],
    required: ['rotation_id', 'roommate_id', 'due_date', 'outcome', 'resolved_at'],
  },
  SWAPS: {
    idColumn: 'swap_id',
    columns: ['swap_id', 'from_roommate_id', 'to_roommate_id', 'from_due_date', 'to_due_date', 'status', 'created_at'],
    required: ['from_roommate_id', 'to_roommate_id', 'from_due_date', 'to_due_date', 'status'],
  },
  VACATIONS: {
    idColumn: 'vacation_id',
    columns: ['vacation_id', 'roommate_id', 'start_date', 'return_date', 'created_at'],
    required: ['roommate_id', 'start_date', 'return_date'],
  },
};

const CREATED_AT_COLUMN = 'created_at';
const CLEANING_OUTCOMES = ['completed', 'admin_resolved', 'vacation_skipped'];

function getSchema_(sheetName) {
  if (!Object.prototype.hasOwnProperty.call(SCHEMAS, sheetName)) {
    throw new Error('Unknown sheet: ' + sheetName);
  }
  return SCHEMAS[sheetName];
}

/** Compares a header row with the schema. Missing columns can be appended; errors cannot be fixed automatically. */
function checkHeaders_(sheetName, headers) {
  const schema = getSchema_(sheetName);
  const errors = [];
  const seen = {};
  headers.forEach(function (header, index) {
    if (header === '') errors.push('blank header in column ' + (index + 1));
    else if (schema.columns.indexOf(header) === -1) errors.push('unknown column: ' + header);
    else if (seen[header]) errors.push('duplicate column: ' + header);
    seen[header] = true;
  });
  const missing = schema.columns.filter(function (column) {
    return !seen[column];
  });
  return { missing: missing, errors: errors };
}

/** Throws unless the record contains only known, writable fields and every required field. */
function validateRecord_(sheetName, record) {
  const schema = getSchema_(sheetName);
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(sheetName + ': record must be an object.');
  }

  Object.keys(record).forEach(function (field) {
    if (field === schema.idColumn || field === CREATED_AT_COLUMN) {
      throw new Error(sheetName + ': ' + field + ' is set automatically.');
    }
    if (schema.columns.indexOf(field) === -1) {
      throw new Error(sheetName + ': unknown field ' + field + '.');
    }
    const value = record[field];
    if (!isBlank_(value) && !isCellValue_(value)) {
      throw new Error(sheetName + ': ' + field + ' must be a string, number, boolean or date.');
    }
    // Sheets would evaluate a leading "=" as a formula.
    if (typeof value === 'string' && value.charAt(0) === '=') {
      throw new Error(sheetName + ': ' + field + ' must not start with "=".');
    }
  });

  schema.required.forEach(function (field) {
    if (isBlank_(record[field])) throw new Error(sheetName + ': ' + field + ' is required.');
  });
  if (sheetName === 'CLEANING_LOGS') assertLogOutcome_(record);
}

/** Only a performed cleaning may carry completed_at; any other outcome must explain itself in notes. */
function assertLogOutcome_(log) {
  if (CLEANING_OUTCOMES.indexOf(log.outcome) === -1) {
    throw new Error('CLEANING_LOGS: outcome must be one of ' + CLEANING_OUTCOMES.join(', ') + '.');
  }
  if (log.outcome === 'completed') {
    if (isBlank_(log.completed_at)) throw new Error('CLEANING_LOGS: completed_at is required when outcome is completed.');
  } else {
    if (!isBlank_(log.completed_at)) throw new Error('CLEANING_LOGS: completed_at must be blank unless the cleaning was performed.');
    if (isBlank_(log.notes)) throw new Error('CLEANING_LOGS: notes must give the reason for ' + log.outcome + '.');
  }
}

function recordToRow_(headers, record) {
  return headers.map(function (header) {
    return isBlank_(record[header]) ? '' : record[header];
  });
}

function rowToRecord_(headers, row) {
  const record = {};
  headers.forEach(function (header, index) {
    record[header] = row[index];
  });
  return record;
}

function isBlankRow_(row) {
  return row.every(function (value) {
    return value === '';
  });
}

function isBlank_(value) {
  return value === undefined || value === null || value === '';
}

function isCellValue_(value) {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return isFinite(value);
  // instanceof Date is unreliable across script contexts.
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}
