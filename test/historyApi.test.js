'use strict';

// listCleaningHistory and exportCleaningHistory (src/backend/HistoryApi.js): the read-only History tab, its Berlin
// calendar-day ranges, server-side pages of 25, and the CSV download.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, asSignedIn, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const [ALEX, SAM, JO] = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
const SHEETS = Object.keys(FIXTURES);
const DAY = 24 * 3600e3;
const WED = new Date('2026-02-18T12:00:00Z'); // Wednesday 13:00 Berlin; winter time

/** A record for the weekend whose Sunday is `sunday` ('YYYY-MM-DD'): due Monday 00:00 Berlin (23:00Z in winter, 22:00Z in summer). */
function weekend(id, sunday, extra = {}, summer = false) {
  const due = new Date(Date.parse(sunday + (summer ? 'T22:00:00Z' : 'T23:00:00Z')));
  const done = new Date(due.getTime() - 5 * 3600e3);
  return { log_id: id, rotation_id: 'slot', roommate_id: ALEX, swap_id: '', due_date: due, outcome: 'completed', resolved_at: done, completed_at: done, notes: 'private note', created_at: due, ...extra };
}
const sundayAt = (weeksBack, from = '2026-02-15') => new Date(Date.parse(from + 'T00:00:00Z') - weeksBack * 7 * DAY).toISOString().slice(0, 10);

function database(logs, edit = () => {}) {
  const sheets = Object.fromEntries(SHEETS.map((name) => [name, fixtureSheet(name)]));
  const headers = sheets.CLEANING_LOGS[0];
  sheets.CLEANING_LOGS = [headers, ...logs.map((record) => headers.map((h) => (h in record ? record[h] : '')))];
  edit(sheets);
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets });
}

const app = (spreadsheet, now = WED) => loadProject({ properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID }, spreadsheets: [spreadsheet], now, maintenance: false });
const signed = (project, request = {}) => asSignedIn(project, { roommate_id: SAM, ...request });
const history = (project, request = {}) => plain(project.get('listCleaningHistory')(signed(project, request)));
const exportCsv = (project, request = {}) => plain(project.get('exportCleaningHistory')(signed(project, request)));
const ids = (result) => result.entries.map((e) => e.log_id);

// ---------- ranges ----------

test('the default is the last 14 calendar days by cleaning weekend (Sunday, Berlin), newest first', () => {
  // Today is Wed 18 Feb, so the range starts Thu 5 Feb: Sunday 8 Feb is in, Sunday 1 Feb is out.
  const logs = [weekend('feb1', '2026-02-01'), weekend('feb8', '2026-02-08'), weekend('feb15', '2026-02-15')].reverse();
  const result = history(app(database(logs)));
  assert.equal(result.ok, true);
  assert.equal(result.range, '14d');
  assert.deepEqual(ids(result), ['feb15', 'feb8']);
  assert.deepEqual([result.page, result.page_size, result.total, result.pages], [1, 25, 2, 1]);
  assert.deepEqual(ids(history(app(database(logs)), { range: '14d' })), ['feb15', 'feb8'], 'asking for the default is the same');
});

test('the first day of the range is included to the minute, in Berlin time (not UTC)', () => {
  const logs = [weekend('feb8', '2026-02-08')];
  // 14 days including today: on Sat 21 Feb the range starts Sun 8 Feb; on Sun 22 Feb it starts Mon 9 Feb.
  const at = (iso) => ids(history(app(database(logs), new Date(iso))));
  assert.deepEqual(at('2026-02-21T12:00:00Z'), ['feb8']);
  assert.deepEqual(at('2026-02-21T22:59:59Z'), ['feb8'], 'Sat 23:59:59 Berlin is still Saturday');
  assert.deepEqual(at('2026-02-21T23:00:00Z'), [], 'Sun 00:00 Berlin: the first day is now Monday 9 Feb');
  assert.deepEqual(at('2026-02-22T12:00:00Z'), []);
});

test('30 days, 90 days and all time widen the range on the same day boundaries', () => {
  // Today Wed 18 Feb 2026: 30d starts 20 Jan, 90d starts 21 Nov 2025.
  const logs = [
    weekend('jan18', '2026-01-18'), weekend('jan25', '2026-01-25'), // 18 Jan is out of 30d, 25 Jan is in
    weekend('nov23', '2025-11-23'), weekend('nov16', '2025-11-16'), // 23 Nov is in 90d, 16 Nov is out
    weekend('old', '2024-05-05', {}, true),
  ];
  const project = () => app(database(logs));
  assert.deepEqual(ids(history(project(), { range: '30d' })), ['jan25']);
  assert.deepEqual(ids(history(project(), { range: '90d' })), ['jan25', 'jan18', 'nov23']);
  assert.deepEqual(ids(history(project(), { range: 'all' })), ['jan25', 'jan18', 'nov23', 'nov16', 'old']);
  assert.equal(history(project(), { range: 'all' }).range, 'all');
});

test('a weekend across the clock change belongs to its Sunday, and the weekend dates are right', () => {
  // Sat 28 – Sun 29 Mar 2026: summer time starts on the Sunday, so the deadline is 22:00Z.
  const logs = [weekend('mar29', '2026-03-29', {}, true)];
  const result = history(app(database(logs), new Date('2026-04-02T10:00:00Z')));
  assert.deepEqual(ids(result), ['mar29']);
  assert.equal(result.entries[0].weekend_starts_at, '2026-03-27T23:00:00.000Z');
  assert.equal(result.entries[0].due_at, '2026-03-29T22:00:00.000Z');
  assert.deepEqual(ids(history(app(database(logs), new Date('2026-04-12T10:00:00Z')))), [], 'out of the 14 days from 30 Mar to 12 Apr');
  assert.deepEqual(ids(history(app(database(logs), new Date('2026-04-12T10:00:00Z')), { range: '30d' })), ['mar29']);
});

test('invalid ranges and pages are refused, and nothing else may be sent', () => {
  const project = app(database([weekend('a', '2026-02-15')]));
  for (const bad of [{ range: '7d' }, { range: 'ALL' }, { range: '' }, { range: 14 }, { range: null }, { range: '__proto__' }, { range: 'constructor' },
    { page: 0 }, { page: -1 }, { page: 1.5 }, { page: '2' }, { page: null }, { page: NaN }, { page: 100001 }, { extra: 1 }]) {
    assert.equal(history(project, bad).error.code, 'INVALID_REQUEST', JSON.stringify(bad));
  }
  for (const bad of [{ range: '7d' }, { page: 1 }, { extra: 1 }]) {
    assert.equal(exportCsv(project, bad).error.code, 'INVALID_REQUEST', JSON.stringify(bad));
  }
});

// ---------- pages ----------

test('records come in pages of 25, newest first; a page past the end is the last page', () => {
  const logs = Array.from({ length: 60 }, (_, n) => weekend('w' + String(n).padStart(2, '0'), sundayAt(n))).reverse(); // w00 is the newest
  const project = () => app(database(logs));
  const first = history(project(), { range: 'all' });
  assert.deepEqual([first.page, first.pages, first.total, first.entries.length], [1, 3, 60, 25]);
  assert.equal(first.entries[0].log_id, 'w00');
  assert.equal(first.entries[24].log_id, 'w24');
  const second = history(project(), { range: 'all', page: 2 });
  assert.deepEqual([second.entries[0].log_id, second.entries[24].log_id, second.entries.length], ['w25', 'w49', 25]);
  const third = history(project(), { range: 'all', page: 3 });
  assert.deepEqual([third.entries[0].log_id, third.entries[9].log_id, third.entries.length], ['w50', 'w59', 10]);
  const beyond = history(project(), { range: 'all', page: 99 });
  assert.equal(beyond.page, 3);
  assert.deepEqual(ids(beyond), ids(third));
  const pagesSeen = [first, second, third].flatMap(ids);
  assert.equal(new Set(pagesSeen).size, 60, 'no record twice, none missing');
  // Exactly one full page is one page.
  const exact = history(app(database(logs.slice(0, 25))), { range: 'all' });
  assert.deepEqual([exact.pages, exact.entries.length], [1, 25]);
});

test('an empty range is an empty first page, and an empty log too', () => {
  assert.deepEqual(history(app(database([]))), { ok: true, entries: [], range: '14d', page: 1, page_size: 25, total: 0, pages: 1 });
  const old = history(app(database([weekend('old', '2025-01-05')])));
  assert.deepEqual([old.total, old.pages, old.entries.length], [0, 1, 0]);
  assert.equal(history(app(database([weekend('old', '2025-01-05')])), { range: 'all' }).total, 1);
});

// ---------- entries and privacy ----------

test('each entry has the roommate, the cleaning weekend, the outcome and when it was resolved, and nothing else', () => {
  const project = app(database([
    weekend('log-0', '2026-02-15'),
    weekend('log-1', '2026-02-08', { roommate_id: SAM, outcome: 'vacation_skipped', completed_at: '', notes: 'Skipped: away' }),
    weekend('log-2', '2026-02-01', { roommate_id: JO, outcome: 'admin_resolved', completed_at: '', notes: 'Resolved by the owner: flat was empty', swap_id: 'swap-1' }),
  ]));
  const [completed, skipped, resolved] = history(project, { range: '30d' }).entries;
  assert.deepEqual(completed, {
    log_id: 'log-0', roommate: { roommate_id: ALEX, name: 'Alex Example' }, weekend_starts_at: '2026-02-13T23:00:00.000Z', due_at: '2026-02-15T23:00:00.000Z',
    outcome: 'completed', completed_at: '2026-02-15T18:00:00.000Z', resolved_at: '2026-02-15T18:00:00.000Z', swapped: false,
    has_photo: false, can_add_photo: false, can_delete_photo: false, // Sam is looking at Alex's cleaning
  });
  assert.equal(skipped.outcome, 'vacation_skipped');
  assert.equal(skipped.completed_at, null);
  assert.equal(skipped.roommate.name, 'Sam Example');
  assert.equal(resolved.outcome, 'admin_resolved');
  assert.equal(resolved.swapped, true);
  for (const result of [JSON.stringify(history(project, { range: '30d' })), exportCsv(project, { range: '30d' }).csv]) {
    for (const hidden of ['private note', 'flat was empty', '@example.com', 'notes', 'rotation_id', 'created_at', 'swap-1']) assert.ok(!result.includes(hidden), hidden);
  }
});

test('malformed rows are left out instead of breaking the page', () => {
  const result = history(app(database([weekend('ok', '2026-02-15'), weekend('b1', '2026-02-15', { outcome: 'cleaned' }), weekend('b2', '2026-02-15', { due_date: 'soon' }),
    weekend('b3', '2026-02-15', { resolved_at: '' }), weekend('b4', '2026-02-15', { roommate_id: '' })])));
  assert.deepEqual(ids(result), ['ok']);
  assert.equal(result.total, 1);
  const gone = history(app(database([weekend('g', '2026-02-15', { roommate_id: 'someone-deleted' })])));
  assert.deepEqual(gone.entries[0].roommate, { roommate_id: 'someone-deleted', name: null });
});

// ---------- sessions ----------

test('both APIs need a valid session, take nothing else, and never write or lock', () => {
  const spreadsheet = database([weekend('a', '2026-02-15')]);
  const project = app(spreadsheet);
  const before = spreadsheet.snapshot();
  for (const name of ['listCleaningHistory', 'exportCleaningHistory']) {
    const call = (request) => plain(project.get(name)(request));
    assert.equal(call(null).error.code, 'INVALID_REQUEST');
    assert.equal(call({ range: 'all' }).error.code, 'INVALID_REQUEST', 'no token');
    assert.equal(call({ token: 'v1.forged.token' }).error.code, 'UNAUTHENTICATED');
    assert.equal(call({ ...asSignedIn(project), roommate_id: SAM }).error.code, 'INVALID_REQUEST');
    assert.equal(call(signed(project)).ok, true);
  }
  assert.deepEqual(project.lock.events, []);
  assert.equal(spreadsheet.snapshot(), before, 'read-only');

  for (const name of ['listCleaningHistory', 'exportCleaningHistory']) {
    const pending = app(database([weekend('a', '2026-02-15')]));
    pending.get('SheetDb').update('ROOMMATES', SAM, { must_change_password: true, password_expires_at: new Date(WED.getTime() + 3600e3) });
    assert.equal(plain(pending.get(name)(signed(pending))).error.code, 'PASSWORD_CHANGE_REQUIRED', name);
  }
});

// ---------- CSV ----------

const parseCsv = (csv) => {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\r' && csv[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; } else field += c;
  }
  return rows;
};

test('the CSV has a header and one line per record of the range, in Berlin dates and times, with a byte order mark', () => {
  const project = app(database([
    weekend('a', '2026-02-15'),
    weekend('b', '2026-02-08', { roommate_id: SAM, outcome: 'vacation_skipped', completed_at: '', resolved_at: new Date('2026-02-07T23:30:00Z'), swap_id: 'swap-1' }),
    weekend('old', '2025-06-01', {}, true),
  ]));
  const result = exportCsv(project);
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.filename, 'chorenest-history-14d-2026-02-18.csv');
  assert.equal(result.csv.charCodeAt(0), 0xfeff);
  assert.ok(result.csv.endsWith('\r\n'));
  assert.deepEqual(parseCsv(result.csv.slice(1)), [
    ['Weekend start', 'Weekend end', 'Roommate', 'Status', 'Resolved (Berlin time)', 'Swapped turn'],
    ['2026-02-14', '2026-02-15', 'Alex Example', 'Cleaned', '2026-02-15 19:00', 'No'],
    ['2026-02-07', '2026-02-08', 'Sam Example', 'Skipped: away', '2026-02-08 00:30', 'Yes'], // 23:30Z is already 00:30 Berlin
  ]);
  const all = exportCsv(project, { range: 'all' });
  assert.equal(all.count, 3);
  assert.equal(all.filename, 'chorenest-history-all-2026-02-18.csv');
  assert.equal(parseCsv(all.csv.slice(1))[3][0], '2025-05-31', 'a summer weekend keeps its Berlin dates');
});

test('the CSV covers every page of the range, not just the first 25', () => {
  const logs = Array.from({ length: 60 }, (_, n) => weekend('w' + n, sundayAt(n)));
  const result = exportCsv(app(database(logs)), { range: 'all' });
  assert.equal(result.count, 60);
  assert.equal(parseCsv(result.csv.slice(1)).length, 61);
});

test('CSV fields that start like a formula are neutralised, and commas, quotes and line breaks are quoted', () => {
  const names = { [ALEX]: '=HYPERLINK("http://evil","x")', [SAM]: '+1+1', [JO]: 'O"Neil, Jr.' };
  const project = app(database(
    [weekend('a', '2026-02-15'), weekend('b', '2026-02-15', { roommate_id: SAM }), weekend('c', '2026-02-15', { roommate_id: JO }),
      weekend('d', '2026-02-15', { roommate_id: FIXTURES.ROOMMATES[3].roommate_id })],
    (sheets) => {
      const headers = sheets.ROOMMATES[0];
      for (const row of sheets.ROOMMATES) if (names[row[0]]) row[headers.indexOf('name')] = names[row[0]];
      const kim = sheets.ROOMMATES.find((row) => row[0] === FIXTURES.ROOMMATES[3].roommate_id);
      kim[headers.indexOf('name')] = '-2\tline\nbreak';
    },
  ));
  const { csv } = exportCsv(project);
  const rows = parseCsv(csv.slice(1)).slice(1);
  const written = rows.map((row) => row[2]).sort();
  assert.deepEqual(written, ["'+1+1", "'-2\tline\nbreak", '\'=HYPERLINK("http://evil","x")', 'O"Neil, Jr.'].sort());
  for (const row of rows) assert.doesNotMatch(row[2], /^[=+\-@\t\r]/);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/, 'quotes are doubled');
  assert.match(csv, /"O""Neil, Jr\."/);
  assert.match(csv, /"'-2\tline\nbreak"/, 'a line break inside a field stays inside quotes');
  assert.equal(rows.every((row) => row.length === 6), true);
});

test('csvCell_ neutralises every formula start character and leaves ordinary text alone', () => {
  const csvCell = app(database([])).get('csvCell_');
  for (const lead of ['=', '+', '-', '@', '\t', '\r']) assert.ok(csvCell(lead + 'x').replace(/^"/, '').startsWith("'" + lead), JSON.stringify(lead));
  assert.equal(csvCell('Alex Example'), 'Alex Example');
  assert.equal(csvCell('a-b'), 'a-b');
  assert.equal(csvCell('2026-02-15'), '2026-02-15');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(null), '');
});
