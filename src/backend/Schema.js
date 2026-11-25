// Column order is used only when creating headers; reads and writes map by header name.
const SCHEMAS = {
  ROOMMATES: {
    idColumn: 'roommate_id',
    // The last eight columns are authentication fields (see Auth.js). They stay blank until an account is provisioned.
    columns: ['roommate_id', 'member_code', 'name', 'email', 'telegram_username', 'active', 'welcome_sent_at', 'created_at',
      'username', 'role', 'password_hash', 'must_change_password', 'session_version', 'failed_logins', 'locked_until', 'password_expires_at'],
    required: ['member_code', 'name', 'email', 'active'],
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
    columns: ['vacation_id', 'roommate_id', 'start_date', 'return_date', 'created_at', 'cancelled_at'],
    required: ['roommate_id', 'start_date', 'return_date'],
  },
};

const CREATED_AT_COLUMN = 'created_at';
const CLEANING_OUTCOMES = ['completed', 'admin_resolved', 'vacation_skipped'];
const MEMBER_CODE_PATTERN = /^[A-Z]{3}-\d{3,}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Sheets reads a text cell that starts with one of these as a formula (or a number or command). Dates, IDs, counts and
// password hashes never start with them, so every stored text is checked.
const FORMULA_START_PATTERN = /^[=+\-@\t\r]/;
const TELEGRAM_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

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
    // A roommate's name gets the same rule with its own error code in assertRoommate_.
    if (typeof value === 'string' && FORMULA_START_PATTERN.test(value) && !(sheetName === 'ROOMMATES' && field === 'name')) {
      throw new Error(sheetName + ': ' + field + ' must not start with = + - @ or a tab.');
    }
  });

  schema.required.forEach(function (field) {
    if (isBlank_(record[field])) throw new Error(sheetName + ': ' + field + ' is required.');
  });
  if (sheetName === 'CLEANING_LOGS') assertLogOutcome_(record);
  if (sheetName === 'ROOMMATES') assertRoommate_(record);
}

/** Roommate fields are checked on every write, so no code path can store a malformed member. */
function assertRoommate_(roommate) {
  const fail = function (message) {
    throw appError_('ROOMMATE_INVALID', 'ROOMMATES: ' + message);
  };
  const name = roommate.name;
  if (name !== name.trim() || name.length > 40 || !/\p{L}/u.test(name) || /[\u0000-\u001f\u007f]/.test(name)) {
    fail('name must be 1-40 characters with a letter, no line breaks and no surrounding spaces.');
  }
  // Sheets would read these as formulas or numbers.
  if (FORMULA_START_PATTERN.test(name)) fail('name must not start with = + - @ or a tab.');
  if (roommate.email.length > 254 || roommate.email !== roommate.email.toLowerCase() || !EMAIL_PATTERN.test(roommate.email)) {
    fail('email must be a valid address in lower case.');
  }
  if (!MEMBER_CODE_PATTERN.test(roommate.member_code)) fail('member_code must look like ABC-001.');
  if (!isBlank_(roommate.telegram_username) && !TELEGRAM_PATTERN.test(roommate.telegram_username)) {
    fail('telegram_username must be 5-32 letters, digits or underscores, without @.');
  }
  if (typeof roommate.active !== 'boolean') fail('active must be true or false.');
  assertAuthFields_(roommate);
}

/** Authentication fields are optional, but when present they must be exactly the shapes Auth.js writes. */
function assertAuthFields_(record) {
  const fail = function (message) {
    throw appError_('ROOMMATE_INVALID', 'ROOMMATES: ' + message);
  };
  const isCount = function (value) {
    return typeof value === 'number' && value >= 0 && value === Math.floor(value) && value <= 1e9;
  };
  if (!isBlank_(record.username) && !USERNAME_PATTERN.test(record.username)) fail('username must be 3-32 lower-case letters, digits, . _ or -, starting with a letter.');
  if (!isBlank_(record.role) && AUTH_ROLES.indexOf(record.role) === -1) fail('role must be ADMIN or ROOMMATE.');
  if (!isBlank_(record.password_hash) && parsePasswordHash_(record.password_hash) === null) fail('password_hash is not a valid password hash.');
  if (!isBlank_(record.must_change_password) && typeof record.must_change_password !== 'boolean') fail('must_change_password must be true or false.');
  if (!isBlank_(record.session_version) && !isCount(record.session_version)) fail('session_version must be a whole number.');
  if (!isBlank_(record.failed_logins) && !isCount(record.failed_logins)) fail('failed_logins must be a whole number.');
  ['locked_until', 'password_expires_at'].forEach(function (field) {
    const value = record[field];
    if (!isBlank_(value) && !(Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime()))) fail(field + ' must be a date.');
  });
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
