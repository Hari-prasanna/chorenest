'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, asSignedIn, fixtureSheet, loadProject, plain } = require('./support/appsScript');
const { FakeDrive, jpegBase64 } = require('./support/fakeDrive');

const ROOT = path.join(__dirname, '..');
const [ALEX, SAM, JO] = FIXTURES.ROOMMATES.map((r) => r.roommate_id); // Alex is ADMIN; Sam and Jo are roommates
// The fixture log: Sam cleaned Alex's turn by swap, so Sam is the actual cleaner although the slot is Alex's.
const SWAPPED = FIXTURES.CLEANING_LOGS[0];
const SKIP = { ...SWAPPED, log_id: '99999999-9999-4999-8999-999999999999', roommate_id: JO, swap_id: '', outcome: 'vacation_skipped', completed_at: '', notes: 'Away' };
const NOW = new Date('2026-01-13T12:00:00Z');
const PHOTO = jpegBase64(64);

const rowsFor = (name, records) => {
  const headers = fixtureSheet(name)[0];
  return [headers, ...records.map((record) => headers.map((header) => {
    const value = header in record ? record[header] : '';
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : value;
  }))];
};
function database(logs = [SWAPPED, SKIP]) {
  return new FakeSpreadsheet(DEV_SPREADSHEET_ID, {
    marker: 'DEV',
    sheets: { ...Object.fromEntries(Object.keys(FIXTURES).map((name) => [name, fixtureSheet(name)])), CLEANING_LOGS: rowsFor('CLEANING_LOGS', logs) },
  });
}
function setup({ folder = true, logs, lock, env = 'DEV' } = {}) {
  const drive = new FakeDrive({ now: () => NOW });
  const photoFolder = folder ? drive.folder(env) : null;
  const spreadsheet = database(logs);
  const properties = { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, ...(photoFolder ? { PHOTO_FOLDER_ID: photoFolder.id } : {}) };
  const project = loadProject({ properties, spreadsheets: [spreadsheet], now: NOW, maintenance: false, urlFetch: drive.fetch, ...(lock ? { lock } : {}) });
  return { drive, spreadsheet, project, folder: photoFolder, properties };
}
const call = (project, name, who, request) => plain(project.get(name)({ token: asSignedIn(project, { roommate_id: who }).token, ...request }));
const attach = (project, who = SAM, photo = PHOTO, logId = SWAPPED.log_id) => call(project, 'attachCleaningPhoto', who, { log_id: logId, photo });
const fetchPhoto = (project, who = JO, logId = SWAPPED.log_id) => call(project, 'getCleaningPhoto', who, { log_id: logId });
const remove = (project, who = SAM, logId = SWAPPED.log_id) => call(project, 'deleteCleaningPhoto', who, { log_id: logId });
const logs = (spreadsheet) => {
  const [headers, ...rows] = spreadsheet.getSheetByName('CLEANING_LOGS').values;
  return rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]])));
};
const linked = (spreadsheet) => logs(spreadsheet).find((log) => log.log_id === SWAPPED.log_id).photo_file_id;
const failed = (result, code) => {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
};
const uploads = (drive) => drive.calls.filter((c) => c.url.includes('/upload/')).length;

// Attaching

test('the actual cleaner attaches a private JPEG; only photo_file_id changes, and rotation and points stay the same', () => {
  const { drive, spreadsheet, project, folder } = setup();
  const scheduleBefore = plain(project.get('getRotationSchedule')(asSignedIn(project, { roommate_id: ALEX })));
  const boardBefore = call(project, 'getLeaderboard', ALEX, { period: 'all' });
  const before = logs(spreadsheet);

  assert.deepEqual(attach(project), { ok: true, log_id: SWAPPED.log_id });
  const [file] = drive.photos();
  assert.deepEqual([file.mimeType, file.parents, file.shared], ['image/jpeg', [folder.id], false]);
  assert.deepEqual(file.appProperties, { chorenest_env: 'DEV', chorenest_log: SWAPPED.log_id, chorenest_uploader: SAM });
  assert.equal(file.bytes.toString('base64'), PHOTO, 'the bytes arrive unchanged');
  assert.equal(linked(spreadsheet), file.id);
  assert.deepEqual(logs(spreadsheet).map(({ photo_file_id, ...rest }) => rest), before.map(({ photo_file_id, ...rest }) => rest), 'nothing else in any log changed');
  assert.deepEqual(project.lock.events, ['lock', 'unlock']);
  assert.ok(drive.calls.every((c) => !/permissions/.test(c.url)), 'never shared');

  const scheduleAfter = plain(project.get('getRotationSchedule')(asSignedIn(project, { roommate_id: ALEX })));
  assert.deepEqual({ ...scheduleAfter, generated_at: '' }, { ...scheduleBefore, generated_at: '' }, 'the rotation does not see photos');
  assert.deepEqual(call(project, 'getLeaderboard', ALEX, { period: 'all' }), boardBefore, 'points do not see photos');
});

test('only the roommate who cleaned can attach, and only to a completed cleaning that is on record', () => {
  const { drive, spreadsheet, project } = setup();
  const before = spreadsheet.snapshot();
  failed(attach(project, ALEX), 'NOT_YOUR_CLEANING'); // the slot owner, and an admin: still not the cleaner
  failed(attach(project, JO), 'NOT_YOUR_CLEANING');
  failed(attach(project, JO, PHOTO, SKIP.log_id), 'CLEANING_NOT_FOUND', 'a vacation skip is not a cleaning');
  failed(attach(project, SAM, PHOTO, 'no-such-log'), 'CLEANING_NOT_FOUND');
  failed(plain(project.get('attachCleaningPhoto')({ token: 'v1.unsigned.token', log_id: SWAPPED.log_id, photo: PHOTO })), 'UNAUTHENTICATED');
  assert.equal(spreadsheet.snapshot(), before);
  assert.equal(uploads(drive), 0, 'nothing reached Drive');
});

test('only a base64 JPEG of at most 500 KB is accepted, checked before the lock and before Drive', () => {
  const { drive, spreadsheet, project } = setup();
  const before = spreadsheet.snapshot();
  const limit = 500 * 1024;
  const jpegOf = (size) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 6, 1), Buffer.from([0xff, 0xd9])]).toString('base64');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const noEnd = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
  for (const photo of ['', 'abc', 'not base64!!', `data:image/jpeg;base64,${PHOTO}`, png, noEnd, jpegOf(limit + 1), 'A'.repeat(800000), PHOTO.replace(/=+$/, ''), 7, null, ['x'], { data: PHOTO }]) {
    failed(attach(project, SAM, photo), typeof photo === 'string' || photo === 7 || photo === null || Array.isArray(photo) || typeof photo === 'object' ? 'PHOTO_INVALID' : 'INVALID_REQUEST');
  }
  const token = asSignedIn(project, { roommate_id: SAM }).token;
  for (const request of [{ token, log_id: SWAPPED.log_id }, { token, log_id: SWAPPED.log_id, photo: PHOTO, roommate_id: SAM }, { token, log_id: 'bad id!', photo: PHOTO }, { log_id: SWAPPED.log_id, photo: PHOTO }, null]) {
    failed(plain(project.get('attachCleaningPhoto')(request)), 'INVALID_REQUEST');
  }
  assert.equal(spreadsheet.snapshot(), before);
  assert.deepEqual(project.lock.events, [], 'invalid requests never reach the lock');
  assert.equal(drive.calls.length, 0);

  assert.equal(attach(project, SAM, jpegOf(limit)).ok, true, 'exactly 500 KB is fine');
});

test('one photo per cleaning: a second upload is refused, also when two arrive at the same moment', () => {
  const lock = { events: [], held: false, deny: false };
  const drive = new FakeDrive({ now: () => NOW });
  const folder = drive.folder('DEV');
  const spreadsheet = database();
  const properties = { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, PHOTO_FOLDER_ID: folder.id };
  const first = loadProject({ properties, spreadsheets: [spreadsheet], now: NOW, maintenance: false, urlFetch: drive.fetch, lock });
  const second = loadProject({ properties, spreadsheets: [spreadsheet], now: NOW, maintenance: false, urlFetch: drive.fetch, lock });
  let during;
  drive.onUpload = () => {
    drive.onUpload = null;
    during = attach(second); // the first upload still holds the lock
  };
  assert.equal(attach(first).ok, true);
  failed(during, 'BUSY');
  failed(attach(second), 'PHOTO_EXISTS');
  assert.equal(drive.photos().length, 1, 'no duplicate file');
  assert.equal(linked(spreadsheet), drive.photos()[0].id);
});

test('a failed upload stores nothing, keeps the cleaning as recorded, and can be retried', () => {
  for (const mode of [500, 403, 'throw']) {
    const { drive, spreadsheet, project } = setup();
    const before = spreadsheet.snapshot();
    drive.fail.upload = mode;
    const result = attach(project);
    failed(result, 'PHOTO_UPLOAD_FAILED');
    assert.match(result.error.message, /cleaning is still recorded/);
    assert.doesNotMatch(JSON.stringify(result), /googleapis|Drive|token/);
    assert.equal(spreadsheet.snapshot(), before);
    assert.equal(drive.photos().length, 0);
    assert.equal(project.lock.held, false);
    drive.fail.upload = null;
    assert.equal(attach(project).ok, true, String(mode));
  }
});

test('if the link cannot be written, the uploaded file is removed; if even that fails, the folder setup sweeps it later', () => {
  const { drive, spreadsheet, project } = setup();
  const sheet = spreadsheet.getSheetByName('CLEANING_LOGS');
  const getRange = sheet.getRange.bind(sheet);
  sheet.getRange = () => {
    throw new Error('Service Spreadsheets failed 1AbC-secret');
  };
  const result = attach(project);
  failed(result, 'PHOTO_UPLOAD_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(drive.photos().length, 0, 'no orphaned file');

  drive.fail.delete = 500;
  failed(attach(project), 'PHOTO_UPLOAD_FAILED');
  assert.equal(drive.photos().length, 1, 'Drive refused the clean-up too');
  sheet.getRange = getRange;
  drive.fail.delete = null;
  assert.equal(linked(spreadsheet), '', 'no log points to it');
});

// Viewing

test('any signed-in household member sees an attached photo; nobody else does', () => {
  const { drive, project } = setup();
  failed(fetchPhoto(project), 'PHOTO_NOT_FOUND');
  attach(project);
  for (const who of [JO, ALEX, SAM]) {
    const result = fetchPhoto(project, who);
    assert.deepEqual(result, { ok: true, log_id: SWAPPED.log_id, mime_type: 'image/jpeg', data: PHOTO }, who);
  }
  const calls = drive.calls.length;
  failed(plain(project.get('getCleaningPhoto')({ token: 'v1.unsigned.token', log_id: SWAPPED.log_id })), 'UNAUTHENTICATED');
  failed(plain(project.get('getCleaningPhoto')({ token: asSignedIn(project, { roommate_id: JO }).token, log_id: SWAPPED.log_id, file_id: 'x' })), 'INVALID_REQUEST');
  failed(fetchPhoto(project, JO, 'no-such-log'), 'CLEANING_NOT_FOUND');
  assert.equal(drive.calls.length, calls, 'refusals never reach Drive');
  assert.deepEqual(project.lock.events.filter((e) => e === 'lock').length, 1, 'viewing takes no lock');
});

test('a log can only ever serve this environment’s private photo for that log, never another Drive file', () => {
  const { drive, spreadsheet, project, folder } = setup();
  attach(project);
  const own = drive.photos()[0];
  const point = (id) => {
    const sheet = spreadsheet.getSheetByName('CLEANING_LOGS');
    const headers = sheet.values[0];
    sheet.values.find((row) => row[0] === SWAPPED.log_id)[headers.indexOf('photo_file_id')] = id;
  };
  const strangers = [
    drive.add({ parents: ['someOtherFolderId1'], appProperties: { chorenest_env: 'DEV', chorenest_log: SWAPPED.log_id }, bytes: Buffer.from(PHOTO, 'base64') }),
    drive.add({ parents: [folder.id], appProperties: { chorenest_env: 'DEV', chorenest_log: SKIP.log_id }, bytes: Buffer.from(PHOTO, 'base64') }),
    drive.add({ parents: [folder.id], appProperties: { chorenest_env: 'PROD', chorenest_log: SWAPPED.log_id }, bytes: Buffer.from(PHOTO, 'base64') }),
    drive.add({ parents: [folder.id], shared: true, appProperties: { chorenest_env: 'DEV', chorenest_log: SWAPPED.log_id }, bytes: Buffer.from(PHOTO, 'base64') }),
    drive.add({ parents: [folder.id], mimeType: 'application/pdf', appProperties: { chorenest_env: 'DEV', chorenest_log: SWAPPED.log_id }, bytes: Buffer.from(PHOTO, 'base64') }),
    drive.add({ parents: [folder.id], trashed: true, appProperties: { chorenest_env: 'DEV', chorenest_log: SWAPPED.log_id }, bytes: Buffer.from(PHOTO, 'base64') }),
  ];
  for (const stranger of strangers) {
    point(stranger.id);
    const downloads = drive.calls.filter((c) => /alt=media/.test(c.query)).length;
    failed(fetchPhoto(project), 'PHOTO_NOT_FOUND');
    assert.equal(drive.calls.filter((c) => /alt=media/.test(c.query)).length, downloads, 'its content is never read');
  }
  for (const typed of ['../../etc', 'https://evil.example/x', '=IMPORTXML("x")', 'short']) {
    point(typed);
    const calls = drive.calls.length;
    failed(fetchPhoto(project), 'PHOTO_NOT_FOUND');
    assert.equal(drive.calls.length, calls, 'a hand-typed value never reaches a Drive URL');
  }
  point(own.id);
  own.bytes = Buffer.from('not a jpeg any more');
  own.size = String(own.bytes.length);
  failed(fetchPhoto(project), 'PHOTO_NOT_FOUND');
  drive.files.delete(own.id);
  failed(fetchPhoto(project), 'PHOTO_NOT_FOUND', 'deleted in Drive by hand');
  drive.fail.meta = 503;
  failed(fetchPhoto(project), 'PHOTO_STORAGE_FAILED');
});

test('the photo folder must be this environment’s private folder created by the app', () => {
  const variants = [
    ['missing', (drive, properties) => delete properties.PHOTO_FOLDER_ID],
    ['malformed', (drive, properties) => { properties.PHOTO_FOLDER_ID = 'x/../y'; }],
    ['unknown', (drive, properties) => { properties.PHOTO_FOLDER_ID = 'unknownFolderId123'; }],
    ['the PROD folder', (drive, properties) => { properties.PHOTO_FOLDER_ID = drive.folder('PROD').id; }],
    ['shared', (drive, properties) => { properties.PHOTO_FOLDER_ID = drive.folder('DEV', { shared: true }).id; }],
    ['trashed', (drive, properties) => { properties.PHOTO_FOLDER_ID = drive.folder('DEV', { trashed: true }).id; }],
    ['a hand-made folder', (drive, properties) => { properties.PHOTO_FOLDER_ID = drive.folder('DEV', { appProperties: {} }).id; }],
    ['a file', (drive, properties) => { properties.PHOTO_FOLDER_ID = drive.add({ appProperties: { chorenest_photo_folder: 'DEV' } }).id; }],
  ];
  for (const [label, change] of variants) {
    const drive = new FakeDrive({ now: () => NOW });
    const spreadsheet = database();
    const properties = { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID, PHOTO_FOLDER_ID: drive.folder('DEV').id };
    change(drive, properties);
    const project = loadProject({ properties, spreadsheets: [spreadsheet], now: NOW, maintenance: false, urlFetch: drive.fetch });
    const before = spreadsheet.snapshot();
    failed(attach(project), 'PHOTO_NOT_CONFIGURED', label);
    assert.equal(uploads(drive), 0, label);
    assert.equal(spreadsheet.snapshot(), before, label);
  }
});

// Deleting

test('the uploader or an admin deletes a photo: the link goes first, then the file; anyone else is refused', () => {
  for (const who of [SAM, ALEX]) {
    const { drive, spreadsheet, project } = setup();
    attach(project);
    failed(remove(project, JO), 'PHOTO_NOT_YOURS');
    assert.equal(drive.photos().length, 1);
    assert.deepEqual(remove(project, who), { ok: true });
    assert.equal(linked(spreadsheet), '');
    assert.equal(drive.photos().length, 0);
    failed(remove(project, who), 'PHOTO_NOT_FOUND');
    assert.equal(attach(project).ok, true, 'a new photo can be added afterwards');
  }
  const { project } = setup();
  failed(plain(project.get('deleteCleaningPhoto')({ token: 'v1.unsigned.token', log_id: SWAPPED.log_id })), 'UNAUTHENTICATED');
  failed(plain(project.get('deleteCleaningPhoto')({ token: asSignedIn(project, { roommate_id: SAM }).token, log_id: SWAPPED.log_id, roommate_id: SAM })), 'INVALID_REQUEST');
});

test('a Drive failure while deleting still unlinks the photo, and the folder setup removes the leftover file', () => {
  const { drive, spreadsheet, project } = setup();
  attach(project);
  drive.fail.delete = 500;
  assert.deepEqual(remove(project), { ok: true });
  assert.equal(linked(spreadsheet), '', 'the app shows no photo');
  assert.equal(drive.photos().length, 1, 'the file is left behind for now');
  drive.fail.delete = null;

  const sheet = spreadsheet.getSheetByName('CLEANING_LOGS');
  const getRange = sheet.getRange.bind(sheet);
  attach(project);
  sheet.getRange = () => {
    throw new Error('Service Spreadsheets failed');
  };
  failed(remove(project), 'WRITE_FAILED');
  sheet.getRange = getRange;
  assert.notEqual(linked(spreadsheet), '', 'nothing changed: the photo is still linked and still there');
  assert.equal(fetchPhoto(project).ok, true);
});

// Maintenance

test('setupPhotoFolder creates one private folder per environment, reuses it, and sweeps only old unlinked files', () => {
  const drive = new FakeDrive({ now: () => NOW });
  const spreadsheet = database();
  const properties = { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID };
  const closed = loadProject({ properties: { ...properties }, spreadsheets: [spreadsheet], now: NOW, maintenance: false, urlFetch: drive.fetch });
  assert.throws(() => closed.get('setupPhotoFolder_')(), /Maintenance is closed/);
  assert.equal(drive.calls.length, 0);

  const owner = loadProject({ properties, spreadsheets: [spreadsheet], now: NOW, urlFetch: drive.fetch });
  const created = plain(owner.get('setupPhotoFolder_')());
  assert.equal(created.created, true);
  const folder = drive.files.get(created.folder_id);
  assert.deepEqual([folder.mimeType, folder.appProperties, folder.parents, folder.shared], ['application/vnd.google-apps.folder', { chorenest_photo_folder: 'DEV' }, [], false]);
  assert.match(created.next, new RegExp(`PHOTO_FOLDER_ID to ${created.folder_id}`));
  assert.equal(owner.properties.PHOTO_FOLDER_ID, undefined, 'the script never sets Script Properties itself');
  const again = plain(owner.get('setupPhotoFolder_')());
  assert.deepEqual([again.folder_id, again.created], [created.folder_id, false], 'running it twice makes no second folder');

  const configured = loadProject({ properties: { ...properties, PHOTO_FOLDER_ID: folder.id }, spreadsheets: [spreadsheet], now: NOW, urlFetch: drive.fetch });
  assert.equal(attach(configured).ok, true);
  const bytes = Buffer.from(PHOTO, 'base64');
  const hourAgo = new Date(NOW.getTime() - 61 * 60 * 1000).toISOString();
  const oldOrphan = drive.add({ parents: [folder.id], createdTime: hourAgo, appProperties: { chorenest_env: 'DEV', chorenest_log: SKIP.log_id }, bytes });
  const youngOrphan = drive.add({ parents: [folder.id], appProperties: { chorenest_env: 'DEV', chorenest_log: SKIP.log_id }, bytes });
  const foreign = drive.add({ parents: [folder.id], createdTime: hourAgo, appProperties: { chorenest_env: 'PROD' }, bytes });
  const swept = plain(configured.get('setupPhotoFolder_')());
  assert.deepEqual([swept.orphans_removed, swept.linked], [1, 1]);
  assert.equal(drive.files.has(oldOrphan.id), false);
  assert.ok(drive.files.has(youngOrphan.id), 'an upload that may still be in progress is left alone');
  assert.ok(drive.files.has(foreign.id), 'files of another environment are never touched');
  assert.equal(fetchPhoto(configured).ok, true, 'the linked photo stays');
});

// What History and profiles say about photos

test('History and profile entries say whether a photo exists and what the viewer may do, and never reveal the Drive file', () => {
  const { drive, spreadsheet, project, folder } = setup();
  const history = (who) => call(project, 'listCleaningHistory', who, { range: 'all' }).entries.find((e) => e.log_id === SWAPPED.log_id);
  const profile = (who) => call(project, 'getMemberProfile', who, { roommate_id: SAM }).recent.find((e) => e.log_id === SWAPPED.log_id);
  const flags = (entry) => [entry.has_photo, entry.can_add_photo, entry.can_delete_photo];

  // Sam did the cleaning (by swap); Alex is ADMIN; Jo is another roommate.
  for (const read of [history, profile]) {
    assert.deepEqual([SAM, ALEX, JO].map((who) => flags(read(who))), [[false, true, false], [false, false, false], [false, false, false]], 'before: only the cleaner can add');
  }
  attach(project);
  for (const read of [history, profile]) {
    assert.deepEqual([SAM, ALEX, JO].map((who) => flags(read(who))), [[true, false, true], [true, false, true], [true, false, false]], 'after: the cleaner and an admin can delete, everyone sees it');
  }
  const fileId = drive.photos()[0].id;
  for (const raw of [call(project, 'listCleaningHistory', JO, { range: 'all' }), call(project, 'getMemberProfile', JO, { roommate_id: SAM }), call(project, 'exportCleaningHistory', JO, { range: 'all' })]) {
    assert.equal(JSON.stringify(raw).includes(fileId), false, 'no Drive ID');
    assert.doesNotMatch(JSON.stringify(raw), /photo_file_id|drive\.google|googleusercontent|folder/i);
  }
  const skipped = call(project, 'listCleaningHistory', JO, { range: 'all' }).entries.find((e) => e.log_id === SKIP.log_id);
  assert.deepEqual(flags(skipped), [false, false, false], 'a vacation skip never offers a photo');
  assert.ok(folder);
  void spreadsheet;
});

// Static guarantees

test('Drive is reached only through drive.file, never shared, and cleaning completion knows nothing of photos', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/drive.file',
  ]);
  const backend = fs.readdirSync(path.join(ROOT, 'src', 'backend')).map((file) => [file, fs.readFileSync(path.join(ROOT, 'src', 'backend', file), 'utf8')]);
  for (const [file, source] of backend) {
    assert.doesNotMatch(source, /\bDriveApp\b|\bDrive\.(Files|Permissions)\b|\/permissions|anyoneWithLink|ANYONE/, `${file}: no broad Drive service and no sharing`);
  }
  const photos = backend.find(([file]) => file === 'Photos.js')[1];
  assert.equal((photos.match(/UrlFetchApp\.fetch/g) || []).length, 1, 'one place talks to Drive');
  for (const file of ['CleaningApi.js', 'Rotation.js', 'Leaderboard.js', 'Calendar.js', 'VacationSkips.js']) {
    assert.doesNotMatch(backend.find(([name]) => name === file)[1], /photo/i, `${file} never depends on photos`);
  }
  for (const [file, source] of backend) {
    if (file !== 'Photos.js' && file !== 'Schema.js' && file !== 'EditorTools.js') assert.doesNotMatch(source, /photo_file_id/, `${file}: only Photos.js reads or writes the link`);
  }
});
