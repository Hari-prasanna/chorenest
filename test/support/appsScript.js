// Loads src/backend into an isolated context with in-memory fakes of the Apps Script services it uses.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
const BACKEND_DIR = path.join(SRC_DIR, 'backend');
const SCRIPT_TIME_ZONE = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'appsscript.json'), 'utf8')).timeZone;
const FIXTURES = require('../fixtures/database.json');
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEV_SPREADSHEET_ID = 'DEV_SPREADSHEET_0000000000000000000000000';
const PROD_SPREADSHEET_ID = 'PROD_SPREADSHEET_000000000000000000000000';

class FakeSheet {
  constructor(name, values = []) {
    this.name = name;
    this.values = values.map((row) => row.slice());
    this.frozenRows = 0;
  }

  getLastRow() {
    return this.values.length;
  }

  getLastColumn() {
    return Math.max(0, ...this.values.map((row) => row.length));
  }

  getDataRange() {
    const width = Math.max(1, this.getLastColumn());
    const values = this.values.length ? this.values : [[]];
    return { getValues: () => values.map((row) => pad(row, width)) };
  }

  getRange(row, column, numRows, numColumns) {
    return {
      setValues: (data) => {
        if (data.length !== numRows || data.some((r) => r.length !== numColumns)) {
          throw new Error('setValues dimensions do not match the range.');
        }
        data.forEach((rowValues, i) => {
          while (this.values.length < row + i) this.values.push([]);
          const target = this.values[row - 1 + i];
          rowValues.forEach((value, j) => {
            while (target.length < column - 1 + j) target.push('');
            target[column - 1 + j] = value;
          });
        });
      },
    };
  }

  appendRow(row) {
    this.values.push(row.slice());
  }

  setFrozenRows(count) {
    this.frozenRows = count;
  }
}

class FakeSpreadsheet {
  constructor(id, { name = id, sheets = {}, marker = null, timeZone = SCRIPT_TIME_ZONE } = {}) {
    this.id = id;
    this.name = name;
    this.timeZone = timeZone;
    this.sheets = new Map(Object.entries(sheets).map(([sheetName, values]) => [sheetName, new FakeSheet(sheetName, values)]));
    this.metadata = marker ? [{ key: 'chorenest_environment', value: marker }] : [];
  }

  getId() {
    return this.id;
  }

  getName() {
    return this.name;
  }

  getSpreadsheetTimeZone() {
    return this.timeZone;
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  insertSheet(name) {
    if (this.sheets.has(name)) throw new Error('Sheet already exists: ' + name);
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }

  getDeveloperMetadata() {
    return this.metadata.map(({ key, value }) => ({ getKey: () => key, getValue: () => value }));
  }

  addDeveloperMetadata(key, value) {
    this.metadata.push({ key, value });
  }

  snapshot() {
    return JSON.stringify({ metadata: this.metadata, sheets: [...this.sheets].map(([n, s]) => [n, s.values]) });
  }
}

const OWNER = 'owner@example.com';

const listJs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(dir, f));


/**
 * Creates one Apps Script project. `properties` are its Script Properties;
 * `spreadsheets` are every spreadsheet the deploying user can open.
 * `activeUser` is who triggered the execution: the owner in the editor, or a web app visitor
 * ('' when Google hides the visitor's email). `now` fixes the project's clock.
 * The maintenance window is open unless `maintenance: false` or the properties set MAINTENANCE_UNTIL themselves.
 * `lock` records and controls LockService: { events, held, deny }.
 */
function loadProject({ properties = {}, spreadsheets = [], activeUser = OWNER, now, maintenance = true, lock = { events: [], held: false, deny: false } } = {}) {
  const opened = [];
  if (maintenance && !('MAINTENANCE_UNTIL' in properties)) {
    properties = { ...properties, MAINTENANCE_UNTIL: new Date((now ? now.getTime() : Date.now()) + 30 * 60 * 1000).toISOString() };
  }
  const context = vm.createContext({
    console: { log() {}, error() {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null),
        deleteProperty: (key) => {
          delete properties[key];
        },
      }),
    },
    SpreadsheetApp: {
      openById: (id) => {
        opened.push(id);
        const spreadsheet = spreadsheets.find((s) => s.id === id);
        if (!spreadsheet) throw new Error('Spreadsheet not found: ' + id);
        return spreadsheet;
      },
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => activeUser }),
      getEffectiveUser: () => ({ getEmail: () => OWNER }),
      getScriptTimeZone: () => SCRIPT_TIME_ZONE,
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (lock.deny || lock.held) {
            lock.events.push('lock-denied');
            return false;
          }
          lock.held = true;
          lock.events.push('lock');
          return true;
        },
        releaseLock: () => {
          lock.held = false;
          lock.events.push('unlock');
        },
      }),
    },
    Utilities: { getUuid: () => crypto.randomUUID() },
  });

  if (now) {
    vm.runInContext(
      `(() => {
        const RealDate = Date;
        globalThis.Date = class extends RealDate {
          constructor(...args) { super(...(args.length ? args : [${now.getTime()}])); }
          static now() { return ${now.getTime()}; }
        };
      })();`,
      context
    );
  }

  for (const file of listJs(BACKEND_DIR)) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: path.basename(file) });
  }

  return {
    opened,
    lock,
    get properties() {
      return properties;
    },
    // Top-level const declarations are not properties of the context, so evaluate by name.
    get: (name) => vm.runInContext(name, context),
  };
}

/** Fixture records for a sheet, with ISO timestamps as Dates, as Sheets returns date cells. */
function fixtureRecords(sheetName) {
  return FIXTURES[sheetName].map((record) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, ISO_TIMESTAMP.test(value) ? new Date(value) : value]))
  );
}

/** A fixture record without the ID (its first column) and created_at, which SheetDb generates. */
function writableFixture(sheetName, index = 0) {
  const [, ...fields] = Object.entries(fixtureRecords(sheetName)[index]);
  return Object.fromEntries(fields.filter(([key]) => key !== 'created_at'));
}

/** Fixture records as sheet values: a header row, then one row per record. */
function fixtureSheet(sheetName, headers = Object.keys(FIXTURES[sheetName][0])) {
  return [headers, ...fixtureRecords(sheetName).map((record) => headers.map((header) => record[header]))];
}

function pad(row, width) {
  return row.concat(Array(width - row.length).fill(''));
}

// Values created inside the context have different prototypes; normalise for deepStrictEqual.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  DEV_SPREADSHEET_ID,
  PROD_SPREADSHEET_ID,
  FIXTURES,
  FakeSpreadsheet,
  fixtureRecords,
  fixtureSheet,
  loadProject,
  plain,
  writableFixture,
};
