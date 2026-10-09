const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{25,}$/;
const ENVIRONMENT_METADATA_KEY = 'chorenest_environment';
// IANA links that follow the same rules as their target. Sheets reports its Berlin setting as Longyearbyen.
const TIME_ZONE_LINKS = { 'Arctic/Longyearbyen': 'Europe/Berlin' };

/**
 * Data access for the ChoreNest spreadsheet. Requires setupDatabase() to have run in this environment.
 * Kept as an object so google.script.run cannot call these methods from the browser.
 */
const SheetDb = {
  list: function (sheetName) {
    return readRecords_(openDatabase_(), sheetName);
  },

  /** Reads several sheets with one spreadsheet open. Returns records keyed by sheet name. */
  listMany: function (sheetNames) {
    const spreadsheet = openDatabase_();
    const records = {};
    sheetNames.forEach(function (sheetName) {
      records[sheetName] = readRecords_(spreadsheet, sheetName);
    });
    return records;
  },

  /** Validates and appends a record, assigning its ID and created_at. Returns the stored record. */
  insert: function (sheetName, record) {
    validateRecord_(sheetName, record);
    const table = readTable_(openDatabase_(), sheetName);
    const stored = Object.assign({}, record);
    stored[getSchema_(sheetName).idColumn] = Utilities.getUuid();
    stored[CREATED_AT_COLUMN] = new Date();
    table.sheet.appendRow(recordToRow_(table.headers, stored));
    return stored;
  },
};

/** Opens this project's configured spreadsheet. Fails before opening anything if configuration is invalid. */
function openSpreadsheet_() {
  const environment = getEnvironment();
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!SPREADSHEET_ID_PATTERN.test(spreadsheetId || '')) {
    throw appError_('CONFIG_INVALID', 'Invalid SPREADSHEET_ID Script Property. Use the ID from the spreadsheet URL, not the full URL.');
  }
  let spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    console.error(error);
    throw appError_('SPREADSHEET_UNAVAILABLE', 'The spreadsheet in SPREADSHEET_ID cannot be opened. Check the ID and sharing.');
  }
  return { environment: environment, spreadsheet: spreadsheet };
}

function getEnvironmentMarker_(spreadsheet) {
  const entry = spreadsheet.getDeveloperMetadata().filter(function (metadata) {
    return metadata.getKey() === ENVIRONMENT_METADATA_KEY;
  })[0];
  return entry ? entry.getValue() : null;
}

// The marker written by setupDatabase() stops one environment using another's spreadsheet
// if SPREADSHEET_ID is copied between projects by mistake.
function openDatabase_() {
  const db = openSpreadsheet_();
  const marker = getEnvironmentMarker_(db.spreadsheet);
  if (marker === null) {
    throw appError_('DATABASE_NOT_SET_UP', 'Spreadsheet is not set up. Run setupDatabase().');
  }
  if (marker !== db.environment) {
    throw appError_('DATABASE_ENVIRONMENT_MISMATCH', 'Spreadsheet belongs to ' + marker + ', not ' + db.environment + '. Check SPREADSHEET_ID.');
  }
  // Sheets converts Dates through the spreadsheet's time zone; a different script time zone shifts them.
  const spreadsheetTimeZone = db.spreadsheet.getSpreadsheetTimeZone();
  const scriptTimeZone = Session.getScriptTimeZone();
  if (!timeZonesMatch_(spreadsheetTimeZone, scriptTimeZone)) {
    throw appError_('TIMEZONE_MISMATCH', 'Spreadsheet time zone ' + spreadsheetTimeZone + ' does not match script time zone ' + scriptTimeZone + '.');
  }
  return db.spreadsheet;
}

function timeZonesMatch_(first, second) {
  const canonical = function (timeZone) {
    return Object.prototype.hasOwnProperty.call(TIME_ZONE_LINKS, timeZone) ? TIME_ZONE_LINKS[timeZone] : timeZone;
  };
  return canonical(first) === canonical(second);
}

function readTable_(spreadsheet, sheetName) {
  getSchema_(sheetName);
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw appError_('DATABASE_NOT_SET_UP', 'Missing sheet: ' + sheetName + '. Run setupDatabase().');
  const inspection = inspectSheet_(sheet, sheetName);
  const problems = inspection.errors.concat(inspection.missing.map(function (column) {
    return 'missing column: ' + column;
  }));
  // Missing columns are fixed by re-running setupDatabase(); other header problems need manual repair.
  if (problems.length) throw appError_(inspection.errors.length ? 'SCHEMA_INVALID' : 'DATABASE_NOT_SET_UP', sheetName + ': ' + problems.join('; '));
  return { sheet: sheet, headers: inspection.headers, rows: inspection.rows };
}

function readRecords_(spreadsheet, sheetName) {
  const table = readTable_(spreadsheet, sheetName);
  return table.rows.map(function (row) {
    return rowToRecord_(table.headers, row);
  });
}

/** Reads a sheet's header row and non-blank data rows, and reports schema problems. */
function inspectSheet_(sheet, sheetName) {
  const values = sheet.getLastRow() === 0 ? [] : sheet.getDataRange().getValues();
  const headers = (values[0] || []).map(String);
  while (headers.length && headers[headers.length - 1] === '') headers.pop();

  const result = checkHeaders_(sheetName, headers);
  const rows = values.slice(1).filter(function (row) {
    return !isBlankRow_(row);
  });
  const hasUnlabelledData = rows.some(function (row) {
    return !isBlankRow_(row.slice(headers.length));
  });
  if (hasUnlabelledData) result.errors.push('data in a column without a header');

  return { headers: headers, rows: rows, missing: result.missing, errors: result.errors };
}
