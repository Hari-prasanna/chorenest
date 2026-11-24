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
// Test-only session secrets, used unless a test sets SESSION_SECRET / PASSWORD_PEPPER itself (even to '').
const TEST_SECRETS = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdefghijklmnopq',
  PASSWORD_PEPPER: 'test-password-pepper-0123456789abcdefghijklmno',
};

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
  const utilities = fakeUtilities();
  for (const [key, value] of Object.entries(TEST_SECRETS)) {
    if (!(key in properties)) properties = { ...properties, [key]: value };
  }
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
    Utilities: utilities,
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
    utilities,
    get properties() {
      return properties;
    },
    // Top-level const declarations are not properties of the context, so evaluate by name.
    get: (name) => vm.runInContext(name, context),
  };
}

// Apps Script byte arrays are Java byte[]: plain arrays of signed values -128..127.
const toSigned = (buffer) => Array.from(buffer, (b) => (b > 127 ? b - 256 : b));
function toBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (!Array.isArray(value) || value.some((b) => !Number.isInteger(b) || b < -128 || b > 127)) throw new Error('Expected a byte array.');
  return Buffer.from(value.map((b) => b & 0xff));
}
class FakeBlob {
  constructor(bytes = Buffer.alloc(0)) {
    this.bytes = bytes;
  }
  setDataFromString(text, charset) {
    if (charset !== 'UTF-8') throw new Error('Only UTF-8 is faked.');
    this.bytes = Buffer.from(text, 'utf8');
    return this;
  }
  getBytes() {
    return toSigned(this.bytes);
  }
  getDataAsString(charset = 'UTF-8') {
    if (charset !== 'UTF-8') throw new Error('Only UTF-8 is faked.');
    return this.bytes.toString('utf8');
  }
}
/** The Utilities members the backend uses, with Apps Script's argument and return shapes. `calls` counts HMACs. */
function fakeUtilities() {
  const utilities = {
    hmacCalls: 0,
    getUuid: () => crypto.randomUUID(),
    newBlob: (data) => new FakeBlob(data === undefined || data === '' ? Buffer.alloc(0) : toBuffer(data)),
    computeHmacSha256Signature: (value, key) => {
      utilities.hmacCalls += 1;
      return toSigned(crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest());
    },
    base64EncodeWebSafe: (data) => toBuffer(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64DecodeWebSafe: (text) => {
      if (typeof text !== 'string' || text.length % 4 !== 0 || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error('Invalid base64.');
      return toSigned(Buffer.from(text, 'base64url'));
    },
  };
  return utilities;
}

/**
 * The request as the signed-in page sends it: `roommate_id` (how tests say who is acting) is replaced by a real
 * session token for that roommate, issued by the project's own code for its current ROOMMATES row. A roommate that
 * cannot sign in gets a token that the server will reject.
 */
function asSignedIn(project, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request; // malformed on purpose
  const { roommate_id: roommateId = FIXTURES.ROOMMATES[0].roommate_id, ...rest } = request;
  return { token: sessionToken(project, roommateId), ...rest };
}

function sessionToken(project, roommateId) {
  let roommate;
  const opened = project.opened.length; // the helper's own read is not part of what a test observes
  try {
    roommate = project.get('SheetDb').list('ROOMMATES').find((row) => row.roommate_id === roommateId);
  } catch (error) {
    roommate = null; // the database itself is broken: the API reports that before looking at the token
  }
  project.opened.splice(opened);
  try {
    return project.get('issueSessionToken_')(roommate || { roommate_id: String(roommateId), session_version: 0 }, project.get('new Date()'));
  } catch (error) {
    return 'v1.unsigned.token'; // configuration is broken: any token is rejected or never reached
  }
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
  TEST_SECRETS,
  asSignedIn,
  sessionToken,
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
