/**
 * Apps Script exposes every editor-runnable function to google.script.run too, so admin entry points
 * check the caller instead: only the user the script executes as (the owner, given the manifest's
 * executeAs USER_DEPLOYING) may run them. Other web app visitors get an empty or different active user.
 */
function assertScriptOwner_() {
  const activeUser = Session.getActiveUser().getEmail();
  if (!activeUser || activeUser !== Session.getEffectiveUser().getEmail()) {
    throw new Error('Admin functions can only be run by the script owner from the Apps Script editor.');
  }
}

/**
 * Creates missing sheets and header columns, and marks the spreadsheet with this environment.
 * Safe to re-run: existing cells are never edited, reordered or deleted, and nothing changes
 * if any sheet has a problem that appending headers cannot fix.
 * Run manually from the Apps Script editor.
 */
function setupDatabase() {
  assertScriptOwner_();
  const db = openSpreadsheet_();
  const spreadsheet = db.spreadsheet;
  const marker = getEnvironmentMarker_(spreadsheet);
  if (marker !== null && marker !== db.environment) {
    throw new Error('Spreadsheet belongs to ' + marker + ', not ' + db.environment + '. Check SPREADSHEET_ID.');
  }

  // Inspect every sheet before changing any, so a problem leaves the whole spreadsheet untouched.
  const errors = [];
  const plan = Object.keys(SCHEMAS).map(function (sheetName) {
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) return { sheetName: sheetName, sheet: null, headers: [], missing: SCHEMAS[sheetName].columns };
    const inspection = inspectSheet_(sheet, sheetName);
    inspection.errors.forEach(function (error) {
      errors.push(sheetName + ': ' + error);
    });
    return { sheetName: sheetName, sheet: sheet, headers: inspection.headers, missing: inspection.missing };
  });
  if (errors.length) throw new Error('setupDatabase made no changes. Fix these first: ' + errors.join('; '));

  const summary = plan.map(function (step) {
    if (!step.missing.length) return step.sheetName + ': unchanged';
    const sheet = step.sheet || spreadsheet.insertSheet(step.sheetName);
    if (!step.sheet) sheet.setFrozenRows(1);
    sheet.getRange(1, step.headers.length + 1, 1, step.missing.length).setValues([step.missing]);
    return step.sheetName + ': ' + (step.sheet ? 'added ' + step.missing.join(', ') : 'created');
  });
  if (marker === null) spreadsheet.addDeveloperMetadata(ENVIRONMENT_METADATA_KEY, db.environment);

  console.log(summary.join('\n'));
  return summary;
}

/** Read-only DEV check of the spreadsheet connection, environment marker and schema. */
function diagnoseDatabase() {
  assertScriptOwner_();
  if (getEnvironment() !== 'DEV') throw new Error('diagnoseDatabase is only available in DEV.');
  const db = openSpreadsheet_();
  const marker = getEnvironmentMarker_(db.spreadsheet);

  const sheets = {};
  Object.keys(SCHEMAS).forEach(function (sheetName) {
    const sheet = db.spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      sheets[sheetName] = { exists: false };
      return;
    }
    const inspection = inspectSheet_(sheet, sheetName);
    sheets[sheetName] = {
      exists: true,
      rows: inspection.rows.length,
      missing: inspection.missing,
      errors: inspection.errors,
    };
  });

  const spreadsheetTimeZone = db.spreadsheet.getSpreadsheetTimeZone();
  const scriptTimeZone = Session.getScriptTimeZone();
  const schemaOk = Object.keys(sheets).every(function (name) {
    const sheet = sheets[name];
    return sheet.exists && !sheet.missing.length && !sheet.errors.length;
  });
  const ok = marker === 'DEV' && timeZonesMatch_(spreadsheetTimeZone, scriptTimeZone) && schemaOk;
  const report = {
    ok: ok,
    environment: db.environment,
    spreadsheetName: db.spreadsheet.getName(),
    spreadsheetId: db.spreadsheet.getId(),
    environmentMarker: marker,
    spreadsheetTimeZone: spreadsheetTimeZone,
    scriptTimeZone: scriptTimeZone,
    sheets: sheets,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}
