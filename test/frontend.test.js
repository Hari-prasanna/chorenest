'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const FRONTEND_DIR = path.join(__dirname, '..', 'src', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND_DIR, file), 'utf8');
const scriptOf = (file) => read(file).match(/<script>([\s\S]*)<\/script>/)[1];

/**
 * Runs the real page scripts against a fake browser: document, theme toggle, localStorage, matchMedia and
 * google.script.run. `storage` can be shared between two loads to simulate a page reload.
 */
function loadFrontend({ storage = new Map(), systemDark = false, storageBlocked = false } = {}) {
  const element = () => ({
    innerHTML: '',
    attributes: {},
    listeners: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  });
  const app = element();
  const whoText = element();
  const markAction = element();
  const dialog = element();
  dialog.open = false;
  dialog.opened = 0;
  dialog.showModal = function () {
    this.open = true;
    this.opened++;
  };
  dialog.close = function () {
    this.open = false;
  };
  const root = element();
  const toggle = element();
  const buttons = ['light', 'dark', 'system'].map((choice) => {
    const button = element();
    button.attributes['data-choice'] = choice;
    return button;
  });
  toggle.querySelectorAll = () => buttons;

  const vacationDialog = element();
  vacationDialog.open = false;
  vacationDialog.showModal = function () {
    this.open = true;
  };
  vacationDialog.close = function () {
    this.open = false;
  };
  const profileDialog = element();
  profileDialog.open = false;
  profileDialog.showModal = function () {
    this.open = true;
  };
  profileDialog.close = function () {
    this.open = false;
  };
  const profileButton = element();
  const betaNotice = Object.assign(element(), { hidden: true });
  const whoSelect = Object.assign(element(), { focused: 0, focus() { this.focused++; } });
  const tabs = element();
  const tabButtons = ['schedule', 'vacation', 'swaps', 'history'].map((name) => {
    const button = element();
    button.attributes['data-tab'] = name;
    button.attributes['aria-current'] = name === 'schedule' ? 'page' : 'false';
    return button;
  });
  tabs.querySelectorAll = () => tabButtons;
  const panels = {
    schedule: Object.assign(element(), { hidden: false }),
    vacation: Object.assign(element(), { hidden: true }),
    swaps: Object.assign(element(), { hidden: true }),
    history: Object.assign(element(), { hidden: true }),
  };
  const startInput = Object.assign(element(), { value: '' });
  const returnInput = Object.assign(element(), { value: '' });

  const media = {
    matches: systemDark,
    listener: null,
    addEventListener(type, listener) {
      this.listener = listener;
    },
  };
  const localStorage = {
    getItem(key) {
      if (storageBlocked) throw new Error('SecurityError');
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      if (storageBlocked) throw new Error('SecurityError');
      storage.set(key, value);
    },
    removeItem(key) {
      if (storageBlocked) throw new Error('SecurityError');
      storage.delete(key);
    },
  };

  const pending = [];
  const calls = [];
  const callArguments = [];
  const run = {
    withSuccessHandler(success) {
      this.success = success;
      return this;
    },
    withFailureHandler(failure) {
      this.failure = failure;
      return this;
    },
    getRotationSchedule(...args) {
      calls.push('getRotationSchedule');
      callArguments.push(args);
      pending.push({ success: this.success, failure: this.failure });
    },
    markCleaned(...args) {
      calls.push('markCleaned');
      callArguments.push(args);
      pending.push({ success: this.success, failure: this.failure });
    },
    listVacations(...args) {
      calls.push('listVacations');
      callArguments.push(args);
      pending.push({ success: this.success, failure: this.failure });
    },
    saveVacation(...args) {
      calls.push('saveVacation');
      callArguments.push(args);
      pending.push({ success: this.success, failure: this.failure });
    },
    cancelVacation(...args) {
      calls.push('cancelVacation');
      callArguments.push(args);
      pending.push({ success: this.success, failure: this.failure });
    },
  };
  const elements = {
    'theme-toggle': toggle,
    'who-text': whoText,
    'mark-action': markAction,
    'confirm-dialog': dialog,
    'vacation-dialog': vacationDialog,
    'profile-dialog': profileDialog,
    'profile-button': profileButton,
    'beta-notice': betaNotice,
    'who-select': whoSelect,
    tabs,
    'panel-schedule': panels.schedule,
    'panel-vacation': panels.vacation,
    'panel-swaps': panels.swaps,
    'panel-history': panels.history,
    'vacation-start': startInput,
    'vacation-return': returnInput,
  };
  const document = { documentElement: root, getElementById: (id) => elements[id] || app };
  const context = vm.createContext({
    document,
    window: { localStorage, matchMedia: () => media },
    google: { script: { run } },
  });
  vm.runInContext(scriptOf('Storage.html'), context);
  vm.runInContext(scriptOf('Theme.html'), context);
  const themeAtLoad = root.attributes['data-theme'];
  vm.runInContext(scriptOf('ScheduleView.html'), context);
  vm.runInContext(scriptOf('VacationView.html'), context);
  vm.runInContext(scriptOf('Identity.html'), context);
  vm.runInContext(scriptOf('Shell.html'), context);
  vm.runInContext(scriptOf('App.html'), context);

  return {
    app,
    whoText,
    markAction,
    dialog,
    vacationDialog,
    profileDialog,
    profileButton,
    betaNotice,
    whoSelect,
    panels,
    tabButtons,
    tabs,
    tabClick: (tab) => tabs.listeners.click({ target: tabButtons.find((b) => b.attributes['data-tab'] === tab) || { getAttribute: () => null } }),
    tabsClickElsewhere: () => tabs.listeners.click({ target: { getAttribute: () => null } }),
    shown: () => Object.keys(panels).filter((name) => !panels[name].hidden),
    current: () => tabButtons.filter((b) => b.attributes['aria-current'] === 'page').map((b) => b.attributes['data-tab']),
    betaClick: (action) => betaNotice.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : null) } }),
    openProfile: () => profileButton.listeners.click({ target: profileButton }),
    profileClick: (action) => profileDialog.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : null) } }),
    setDates: (start, back) => {
      startInput.value = start;
      returnInput.value = back;
    },
    vacationClick: (action, attributes = {}) =>
      vacationDialog.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : attributes[name] || null) } }),
    openVacationsClick: () => panels.vacation.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? 'open-vacations' : null) } }),
    clickMark: () => app.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? 'mark-cleaned' : null) } }),
    dialogClick: (action) => dialog.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : null) } }),
    calls,
    callArguments,
    storage,
    themeAtLoad,
    theme: () => root.attributes['data-theme'],
    pressed: () => Object.fromEntries(buttons.map((b) => [b.attributes['data-choice'], b.attributes['aria-pressed']])),
    chooseTheme: (choice) => toggle.listeners.click({ target: buttons.find((b) => b.attributes['data-choice'] === choice) }),
    clickToggleElsewhere: () => toggle.listeners.click({ target: { getAttribute: () => null } }),
    setSystemDark: (dark) => {
      media.matches = dark;
      media.listener();
    },
    view: (name) => vm.runInContext(name, context),
    succeed: (result) => pending[pending.length - 1].success(result),
    succeedCall: (index, result) => pending[index].success(result),
    failCall: (index) => pending[index].failure(new Error('network')),
    fail: (error = new Error('network')) => pending[pending.length - 1].failure(error),
    pick: (roommateId) =>
      app.listeners.change({ target: { value: roommateId, getAttribute: (name) => (name === 'data-action' ? 'select-roommate' : null) } }),
    changeElsewhere: () => app.listeners.change({ target: { value: 'x', getAttribute: () => null } }),
    clickRetry: () => app.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? 'retry' : null) } }),
    clickElsewhere: () => app.listeners.click({ target: { getAttribute: () => null } }),
  };
}

/** The text a visitor reads: tags and decorative (aria-hidden) avatars, glyphs and icons are dropped. */
const textOf = (html) =>
  html.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Weekend n: Saturday 2026-01-17 + 7n, due Monday 00:00 Berlin (winter time, so 23:00Z the evening before).
const person = (name, id = `id-${name}`) => ({ roommate_id: id, name });
function turn(name, weekend = 0, extra = {}) {
  return {
    rotation_id: `slot-${name}`,
    owner: person(name),
    assignee: person(name),
    swap_id: null,
    skipped: [],
    vacation_conflict_id: null,
    opens_at: new Date(Date.UTC(2026, 0, 12 + 7 * weekend, 23)).toISOString(),
    weekend_starts_at: new Date(Date.UTC(2026, 0, 16 + 7 * weekend, 23)).toISOString(),
    due_at: new Date(Date.UTC(2026, 0, 18 + 7 * weekend, 23)).toISOString(),
    ...extra,
  };
}

function schedule({ current = {}, upcoming, roommates } = {}) {
  return {
    ok: true,
    environment: 'DEV',
    generated_at: '2026-01-13T12:00:00.000Z',
    current: { ...turn('Hari', 0), status: 'pending', ...current },
    upcoming: upcoming || [turn('Jijo', 1), turn('Arun', 2), turn('Hari', 3)],
    roommates: roommates || [person('Arun'), person('Hari'), person('Jijo')],
  };
}

const failure = (code) => ({ ok: false, error: { code, message: 'Server detail that visitors must not see' } });

// Loading and success

test('shows a loading state while waiting, then the schedule', () => {
  const page = loadFrontend();
  assert.deepEqual(page.calls, ['getRotationSchedule']);
  assert.match(page.app.innerHTML, /Loading schedule/);
  assert.equal(page.app.attributes['aria-busy'], 'true');

  page.succeed(schedule());
  assert.equal(page.app.attributes['aria-busy'], 'false');
  assert.doesNotMatch(page.app.innerHTML, /Loading schedule/);
});

test('shows the current cleaner, task, weekend, due date and status', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  const html = page.app.innerHTML;
  const text = textOf(html);

  assert.match(text, /Current turn Pending Hari Entire Home Time to give the nest some love\./);
  assert.match(text, /Cleaning weekend Sat 17 – Sun 18 Jan/);
  assert.match(text, /Due End of Sunday 18 Jan 2026/);
  assert.match(html, /<section class="card hero"/);
  assert.match(html, /badge-pending/);
  assert.doesNotMatch(html, /is-overdue/);
});

test('shows the next three turns in order, with their weekends', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  const items = page.app.innerHTML.match(/<li class="timeline-item">[\s\S]*?<\/li>/g).map(textOf);
  assert.deepEqual(items, ['Jijo Up next Sat 24 – Sun 25 Jan', 'Arun Then Sat 31 Jan – Sun 1 Feb', 'Hari After that Sat 7 – Sun 8 Feb']);
  assert.deepEqual([...page.app.innerHTML.matchAll(/class="avatar avatar-\w+ tone-\d" aria-hidden="true">([^<]*)</g)].map((m) => m[1]), ['H', 'J', 'A', 'H']);
});

test('marks an overdue turn, and labels one that has not opened yet', () => {
  const overdue = loadFrontend();
  overdue.succeed(schedule({ current: { status: 'overdue' } }));
  assert.match(overdue.app.innerHTML, /is-overdue/);
  assert.match(overdue.app.innerHTML, /badge-overdue/);
  assert.match(textOf(overdue.app.innerHTML), /Overdue/);
  assert.match(textOf(overdue.app.innerHTML), /Was due End of Sunday 18 Jan 2026/);
  assert.match(textOf(overdue.app.innerHTML), /Overdue: the nest is waiting for this one\./);

  const waiting = loadFrontend();
  waiting.succeed(schedule({ current: { status: 'waiting' } }));
  assert.match(waiting.app.innerHTML, /badge-waiting/);
  assert.match(textOf(waiting.app.innerHTML), /Upcoming/);
  assert.match(textOf(waiting.app.innerHTML), /Not open yet\./);
});

test('explains swapped turns, roommates who are away and recorded vacations', () => {
  const page = loadFrontend();
  page.succeed(
    schedule({
      current: { owner: person('Jijo'), assignee: person('Hari'), swap_id: 'swap', vacation_conflict_id: 'vacation' },
      upcoming: [turn('Arun', 1, { skipped: [person('Jijo'), person('Kim')] }), turn('Hari', 2), turn('Jijo', 3)],
    })
  );
  const text = textOf(page.app.innerHTML);
  assert.match(text, /Swapped turn: covering for Jijo\./);
  assert.match(text, /A vacation has been recorded for this weekend\./);
  assert.match(text, /Jijo and Kim are away\./);
});

// Berlin time

test('formats dates in Berlin time, including across a month end and the clock change', () => {
  const page = loadFrontend();
  page.succeed(schedule({ upcoming: [turn('Jijo', 2), turn('Arun', 3), turn('Hari', 4)] }));
  assert.match(textOf(page.app.innerHTML), /Sat 31 Jan – Sun 1 Feb/);

  const spring = loadFrontend();
  spring.succeed(
    schedule({ current: { weekend_starts_at: '2026-03-27T23:00:00.000Z', due_at: '2026-03-29T22:00:00.000Z' } })
  );
  const text = textOf(spring.app.innerHTML);
  assert.match(text, /Sat 28 – Sun 29 Mar/);
  assert.match(text, /Due End of Sunday 29 Mar 2026/);
});

test('shows the update time in Berlin time', () => {
  const page = loadFrontend();
  page.succeed({ ...schedule(), generated_at: '2026-01-12T23:30:00.000Z' });
  assert.match(textOf(page.app.innerHTML), /Updated Tue 13 Jan, 00:30 · Times in Berlin/);
  const summer = loadFrontend();
  summer.succeed({ ...schedule(), generated_at: '2026-07-01T21:59:00.000Z' });
  assert.match(textOf(summer.app.innerHTML), /Updated Wed 1 Jul, 23:59/);
});

// Escaping and read-only

test('escapes roommate names from the spreadsheet', () => {
  const page = loadFrontend();
  const name = '<img src=x onerror=alert(1)> & "Q" \'R\'';
  page.succeed(
    schedule({ current: { owner: person(name, 'a'), assignee: person(name, 'a'), status: '<b>weird</b>' }, upcoming: [turn(name)] })
  );
  const html = page.app.innerHTML;
  assert.doesNotMatch(html, /<img|<b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Q&quot; &#39;R&#39;/);
  assert.match(html, /&lt;b&gt;weird&lt;\/b&gt;/);
});

test('shows a placeholder for a roommate without a name', () => {
  const page = loadFrontend();
  page.succeed(schedule({ current: { owner: person(null, 'x'), assignee: person(null, 'x') } }));
  assert.match(textOf(page.app.innerHTML), /Current turn Pending Unknown roommate Entire Home/);
  assert.match(page.app.innerHTML, /class="avatar avatar-lg tone-\d" aria-hidden="true">U</);
});

test('is read-only: only the roommate picker as a control, and only getRotationSchedule is ever called', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  assert.doesNotMatch(page.app.innerHTML, /<(form|input|textarea|a )/);
  assert.equal(page.app.innerHTML.match(/<select/g).length, 1);
  assert.doesNotMatch(page.app.innerHTML, /<button/, 'the schedule has no buttons for a visitor who picked nobody');
  assert.deepEqual(page.panels.vacation.innerHTML.match(/<button[^>]*>/g), ['<button class="button button-quiet" type="button" data-action="open-vacations">'], 'the only button is the one that opens vacations');
  page.clickElsewhere();
  assert.deepEqual(page.calls, ['getRotationSchedule']);
});

// Empty and error states

test('an empty rotation shows an empty state, not an error', () => {
  const page = loadFrontend();
  page.succeed(failure('ROTATION_EMPTY'));
  const text = textOf(page.app.innerHTML);
  assert.match(text, /No rotation yet/);
  assert.doesNotMatch(text, /Error code/);
  assert.equal(page.app.attributes['aria-busy'], 'false');
});

test('API errors show a plain explanation and the code, never the server message', () => {
  const cases = {
    CONFIG_INVALID: /isn’t set up correctly/,
    SPREADSHEET_UNAVAILABLE: /isn’t set up correctly/,
    DATABASE_NOT_SET_UP: /isn’t set up correctly/,
    DATABASE_ENVIRONMENT_MISMATCH: /isn’t set up correctly/,
    TIMEZONE_MISMATCH: /isn’t set up correctly/,
    SCHEMA_INVALID: /isn’t set up correctly/,
    ROTATION_DATA_INVALID: /rotation data needs attention/,
    INTERNAL_ERROR: /Something went wrong/,
    SOMETHING_NEW: /Something went wrong/,
  };
  for (const [code, title] of Object.entries(cases)) {
    const page = loadFrontend();
    page.succeed(failure(code));
    const text = textOf(page.app.innerHTML);
    assert.match(text, title, code);
    assert.ok(text.includes(`Error code: ${code}`), code);
    assert.doesNotMatch(text, /Server detail/, code);
    assert.match(page.app.innerHTML, /data-action="retry"/, code);
  }
});

test('a failed request shows an error with retry, and retrying loads the schedule', () => {
  const page = loadFrontend();
  page.fail();
  assert.match(textOf(page.app.innerHTML), /Couldn’t reach the server/);
  assert.match(textOf(page.app.innerHTML), /Error code: REQUEST_FAILED/);
  assert.equal(page.app.attributes['aria-busy'], 'false');

  page.clickRetry();
  assert.deepEqual(page.calls, ['getRotationSchedule', 'getRotationSchedule']);
  assert.match(page.app.innerHTML, /Loading schedule/);
  assert.equal(page.app.attributes['aria-busy'], 'true');

  page.succeed(schedule());
  assert.match(textOf(page.app.innerHTML), /Current turn Pending Hari/);
});

test('malformed responses show an error instead of breaking the page', () => {
  const broken = [
    undefined,
    null,
    'ok',
    {},
    { ok: true },
    { ok: true, current: {}, upcoming: [] },
    { ...schedule(), upcoming: 'none' },
    { ...schedule(), upcoming: [{ ...turn('Jijo'), due_at: 'soon' }] },
    { ...schedule(), generated_at: 'yesterday' },
    { ...schedule(), current: { ...schedule().current, status: undefined } },
    { ok: false },
    // Passes validation but cannot be rendered.
    schedule({ current: { assignee: person(5, 'a') } }),
  ];
  for (const response of broken) {
    const page = loadFrontend();
    assert.doesNotThrow(() => page.succeed(response));
    const text = textOf(page.app.innerHTML);
    assert.match(text, /Something went wrong/, JSON.stringify(response));
    assert.match(text, /Error code: UNEXPECTED_RESPONSE/);
  }
});

// With the real server API

test('renders the real getRotationSchedule() response built from the fixtures', () => {
  const values = Object.fromEntries(Object.keys(FIXTURES).map((name) => [name, fixtureSheet(name)]));
  const spreadsheet = new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets: values });
  const server = loadProject({
    properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID },
    spreadsheets: [spreadsheet],
    now: new Date('2026-01-13T12:00:00Z'),
  });

  const page = loadFrontend();
  page.succeed(plain(server.get('getRotationSchedule')()));
  const text = textOf(page.app.innerHTML);
  assert.match(text, /Current turn Pending Alex Example Entire Home/);
  assert.match(text, /Swapped turn: covering for Sam Example\./);
  assert.match(text, /Cleaning weekend Sat 17 – Sun 18 Jan/);
  assert.match(text, /Updated Tue 13 Jan, 13:00 · Times in Berlin/);
  const upcoming = page.app.innerHTML.match(/<li class="timeline-item">[\s\S]*?<\/li>/g).map((item) => item.match(/class="name">([^<]*)</)[1]);
  assert.deepEqual(upcoming, ['Kim Example', 'Alex Example', 'Sam Example']);
  assert.match(text, /Jo Example is away\./);
});

// Static checks

test('the page includes only frontend files that exist', () => {
  const includes = [...read('Index.html').matchAll(/include_\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(includes, [
    'frontend/Styles',
    'frontend/Storage',
    'frontend/Theme',
    'frontend/ScheduleView',
    'frontend/VacationView',
    'frontend/Identity',
    'frontend/Shell',
    'frontend/App',
  ]);
  for (const name of includes) assert.ok(fs.existsSync(path.join(FRONTEND_DIR, `${name.replace('frontend/', '')}.html`)), name);

  const project = loadProject();
  assert.equal(typeof project.get('include_'), 'function');
});

test('no roommate names or dates are hardcoded in the frontend', () => {
  const names = [...FIXTURES.ROOMMATES.map((r) => r.name.split(' ')[0]), 'Hari', 'Jijo', 'Arun'];
  for (const file of fs.readdirSync(FRONTEND_DIR)) {
    const source = read(file);
    for (const name of names) assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), `${file}: ${name}`);
    assert.doesNotMatch(source, /\b20\d\d\b/, `${file}: year`);
  }
});

// Theme

test('the theme starts as System and is applied before the page renders', () => {
  const light = loadFrontend();
  assert.equal(light.themeAtLoad, 'light');
  assert.deepEqual(light.pressed(), { light: 'false', dark: 'false', system: 'true' });
  assert.equal(light.storage.size, 0);

  assert.equal(loadFrontend({ systemDark: true }).themeAtLoad, 'dark');
  const index = read('Index.html');
  assert.ok(index.indexOf("include_('frontend/Theme')") < index.indexOf('<body>'));
});

test('System follows the operating system, including when it changes', () => {
  const page = loadFrontend();
  page.setSystemDark(true);
  assert.equal(page.theme(), 'dark');
  page.setSystemDark(false);
  assert.equal(page.theme(), 'light');
});

test('Light and Dark override the system and are remembered; System follows it again', () => {
  const page = loadFrontend({ systemDark: true });
  page.chooseTheme('light');
  assert.equal(page.theme(), 'light');
  assert.deepEqual(page.pressed(), { light: 'true', dark: 'false', system: 'false' });
  assert.equal(page.storage.get('chorenest-theme'), 'light');
  page.setSystemDark(false);
  page.setSystemDark(true);
  assert.equal(page.theme(), 'light');

  page.chooseTheme('dark');
  assert.equal(page.theme(), 'dark');
  assert.deepEqual(page.pressed(), { light: 'false', dark: 'true', system: 'false' });
  assert.equal(page.storage.get('chorenest-theme'), 'dark');

  page.chooseTheme('system');
  assert.equal(page.theme(), 'dark');
  assert.equal(page.storage.get('chorenest-theme'), 'system');
  page.setSystemDark(false);
  assert.equal(page.theme(), 'light');
});

test('a saved choice survives a reload, and an invalid saved value is ignored', () => {
  const first = loadFrontend();
  first.chooseTheme('dark');
  const reloaded = loadFrontend({ storage: first.storage });
  assert.equal(reloaded.themeAtLoad, 'dark');
  assert.deepEqual(reloaded.pressed(), { light: 'false', dark: 'true', system: 'false' });

  const lightOnDarkSystem = new Map([['chorenest-theme', 'light']]);
  assert.equal(loadFrontend({ storage: lightOnDarkSystem, systemDark: true }).themeAtLoad, 'light');

  const invalid = loadFrontend({ storage: new Map([['chorenest-theme', 'purple']]) });
  assert.equal(invalid.themeAtLoad, 'light');
  assert.deepEqual(invalid.pressed(), { light: 'false', dark: 'false', system: 'true' });
});

test('the toggle still works for this visit when browser storage is blocked', () => {
  const page = loadFrontend({ storageBlocked: true });
  assert.doesNotThrow(() => page.chooseTheme('dark'));
  assert.equal(page.theme(), 'dark');
  assert.deepEqual(page.pressed(), { light: 'false', dark: 'true', system: 'false' });
  assert.equal(page.storage.size, 0);
});

test('clicks that are not a theme choice change nothing', () => {
  const page = loadFrontend();
  page.chooseTheme('dark');
  page.clickToggleElsewhere();
  page.view('chooseTheme')('neon');
  assert.equal(page.theme(), 'dark');
  assert.equal(page.storage.get('chorenest-theme'), 'dark');
});

test('the theme survives loading, error and empty states', () => {
  const page = loadFrontend();
  page.chooseTheme('dark');
  page.fail();
  page.clickRetry();
  page.succeed(failure('ROTATION_EMPTY'));
  assert.equal(page.theme(), 'dark');
  assert.deepEqual(page.pressed(), { light: 'false', dark: 'true', system: 'false' });
});

// Visual design

test('each roommate keeps one avatar colour, from a fixed set', () => {
  const page = loadFrontend();
  const tone = page.view('avatarTone');
  for (const id of ['a', 'id-Hari', '5f1c9a1e-0000-4000-8000-000000000001', '']) {
    assert.equal(tone({ roommate_id: id }), tone({ roommate_id: id }));
    assert.ok([1, 2, 3, 4, 5, 6].includes(tone({ roommate_id: id })), id);
  }
  const tones = new Set(Array.from({ length: 60 }, (_, i) => tone({ roommate_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })));
  assert.ok(tones.size >= 5, `only ${tones.size} tones used`);

  page.succeed(schedule());
  const shown = [...page.app.innerHTML.matchAll(/avatar avatar-\w+ tone-(\d)/g)].map((m) => m[1]);
  assert.equal(shown[0], shown[3], 'Hari has the same colour in the hero and in the list');
});

test('the hero never hides overdue or vacation information', () => {
  const page = loadFrontend();
  page.succeed(
    schedule({
      current: { status: 'overdue', vacation_conflict_id: 'v', skipped: [person('Jijo')] },
      upcoming: [turn('Arun', 1, { skipped: [person('Kim')] })],
    })
  );
  const hero = page.app.innerHTML.match(/<section class="card hero[\s\S]*?<\/section>/)[0];
  const text = textOf(hero);
  assert.match(hero, /is-overdue/);
  assert.match(text, /Overdue/);
  assert.match(text, /Was due End of Sunday 18 Jan 2026/);
  assert.match(text, /Jijo is away\./);
  assert.match(text, /A vacation has been recorded for this weekend\./);
  assert.match(textOf(page.app.innerHTML), /Kim is away\./);
});

test('statuses use a shape as well as a colour', () => {
  for (const [status, glyph] of [['pending', '●'], ['overdue', '!'], ['waiting', '○']]) {
    const page = loadFrontend();
    page.succeed(schedule({ current: { status } }));
    assert.ok(page.app.innerHTML.includes(`<span aria-hidden="true">${glyph}</span>`), status);
  }
});

// Static checks on the design files

const frontendSources = () => fs.readdirSync(FRONTEND_DIR).map((file) => [file, read(file)]);

test('the only buttons are the known ones, and the only navigation is the four-section bar', () => {
  const group = read('Index.html').match(/<div class="theme-toggle"[^>]*>([\s\S]*?)<\/div>/);
  assert.match(group[0], /role="group" aria-label="Theme"/);
  const choices = [...group[1].matchAll(/<button type="button" data-choice="(\w+)" aria-pressed="(\w+)">(\w+)<\/button>/g)];
  assert.deepEqual(choices.map((m) => m.slice(1)), [
    ['light', 'false', 'Light'],
    ['dark', 'false', 'Dark'],
    ['system', 'true', 'System'],
  ]);
  for (const [file, source] of frontendSources()) {
    for (const [button] of source.matchAll(/<button\b[^>]*>/g)) {
      assert.match(
        button,
        /data-choice="|data-tab="(schedule|vacation|swaps|history)"|data-action="(open-profile|dismiss-beta|change-name|close-profile|retry|mark-cleaned|confirm-clean|cancel-clean|open-vacations|retry-vacations|plan-vacation|save-vacation|back-to-vacations|close-vacation|cancel-vacation|confirm-cancel-vacation)"/,
        `${file}: ${button}`
      );
    }
    assert.doesNotMatch(source, /<(a|form|textarea)\b|href=/, file);
    assert.equal((source.match(/<nav\b/g) || []).length, file === 'Index.html' ? 1 : 0, file);
    // The only text controls are the two date fields of the vacation form.
    for (const [input] of source.matchAll(/<input\b[^>]*>/g)) assert.ok(file === 'VacationView.html' && /type="date"/.test(input), `${file}: ${input}`);
    if (file !== 'ScheduleView.html') assert.doesNotMatch(source, /<select\b/, file);
  }
});

test('the design uses no external assets or frameworks', () => {
  for (const [file, source] of frontendSources()) {
    assert.doesNotMatch(source, /https?:|url\(|@import|<link|<img|<iframe|<script src|\bsrc=/, file);
  }
});

test('colours live in the theme tokens: one dark block, no stray colours, system preference handled in JS', () => {
  const css = read('Styles.html');
  assert.equal(css.match(/:root\[data-theme="dark"\]/g).length, 1);
  assert.doesNotMatch(css, /prefers-color-scheme/);
  const withoutTokens = css.replace(/:root(\[data-theme="dark"\])?\s*{[^}]*}/g, '');
  const stray = new Set(withoutTokens.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g));
  assert.deepEqual([...stray].sort(), ['#b45309', '#fff']);
});

/** The `{...}` block that starts at `start`, including its header. */
function blockAt(source, start) {
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unbalanced braces');
}

test('motion is subtle and respects reduced-motion', () => {
  const css = read('Styles.html');
  const entrance = blockAt(css, css.indexOf('@media (prefers-reduced-motion: no-preference)'));
  const skeleton = blockAt(css, css.indexOf('.skeleton {'));
  const reduce = blockAt(css, css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduce, /\.skeleton\s*{\s*animation: none;/);
  assert.doesNotMatch(css.replace(entrance, '').replace(skeleton, '').replace(reduce, ''), /\banimation\s*:|transition\s*:/);
  assert.match(css, /@keyframes pulse/);
});

const channels = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
const luminance = (value) => {
  const [r, g, b] = channels(value).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const tokensOf = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));

test('text meets WCAG AA contrast (4.5:1) on its background in both themes', () => {
  const css = read('Styles.html');
  const light = tokensOf(blockAt(css, css.indexOf(':root {')));
  const dark = { ...light, ...tokensOf(blockAt(css, css.indexOf(':root[data-theme="dark"]'))) };
  const pairs = [
    ['text', 'bg'], ['text', 'surface'], ['text', 'surface-soft'], ['text', 'note-bg'],
    ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-soft'],
    ['accent-text', 'bg'], ['accent-text', 'surface'], ['accent-text', 'accent-soft'], ['neutral-text', 'neutral-bg'],
    ['on-solid', 'solid'], ['on-solid', 'solid-hover'],
    // Hero card, teal and (when overdue) coral: text on both ends of the gradient, and on the light tiles.
    ...['hero-a', 'hero-b', 'overdue-a', 'overdue-b'].flatMap((stop) => [['on-hero', stop], ['on-hero-soft', stop]]),
    ['hero-tile-text', 'hero-tile'], ['hero-tile-muted', 'hero-tile'],
    ['overdue-tile-text', 'overdue-tile'], ['overdue-tile-muted', 'overdue-tile'],
    ...[1, 2, 3, 4, 5, 6].map((n) => [`tone-${n}-fg`, `tone-${n}-bg`]),
  ];
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    for (const [foreground, background] of pairs) {
      assert.ok(theme[foreground] && theme[background], `${name}: missing ${foreground} or ${background}`);
      const ratio = contrast(theme[foreground], theme[background]);
      assert.ok(ratio >= 4.5, `${name}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`);
    }
  }
});

// Roommate picker (unverified identity)

const pickerOptions = (html) =>
  [...html.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], Boolean(m[2])]);
const ROOMMATE_KEY = 'chorenest-roommate';

/** The greeting text after picking `roommateId` on a freshly loaded page. */
function greetingAfterPicking(roommateId, payload = schedule()) {
  const page = loadFrontend();
  page.succeed(payload);
  page.pick(roommateId);
  return textOf(page.whoText.innerHTML);
}

test('offers every active roommate and "Just looking", with nobody picked at first', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  assert.deepEqual(pickerOptions(page.app.innerHTML), [
    ['', 'Just looking', false],
    ['id-Arun', 'Arun', false],
    ['id-Hari', 'Hari', false],
    ['id-Jijo', 'Jijo', false],
  ]);
  const text = textOf(page.app.innerHTML);
  assert.match(text, /Hi there!/);
  assert.match(text, /Pick your name to see your turn at a glance\./);
  assert.match(page.app.innerHTML, /<label for="who-select">Who are you\?<\/label><select class="who-select" id="who-select"/);
});

test('picking a roommate greets them and is remembered, without re-rendering the picker', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  const before = page.app.innerHTML;
  page.pick('id-Jijo');
  assert.equal(page.app.innerHTML, before, 'the picker keeps its focus because only the greeting text changes');
  assert.equal(textOf(page.whoText.innerHTML), 'Hi, Jijo! Your next turn: Sat 24 – Sun 25 Jan.');
  assert.equal(page.storage.get(ROOMMATE_KEY), 'id-Jijo');
});

test('the pick is remembered across reloads and shown as selected', () => {
  const first = loadFrontend();
  first.succeed(schedule());
  first.pick('id-Arun');

  const again = loadFrontend({ storage: first.storage });
  again.succeed(schedule());
  assert.match(textOf(again.app.innerHTML), /Hi, Arun! Your next turn: Sat 31 Jan – Sun 1 Feb\./);
  assert.deepEqual(pickerOptions(again.app.innerHTML).filter((option) => option[2]), [['id-Arun', 'Arun', true]]);
});

test('"Just looking" clears the pick, and so does a roommate who is gone', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  page.pick('id-Hari');
  page.pick('');
  assert.match(textOf(page.whoText.innerHTML), /^Hi there!/);
  assert.equal(page.storage.has(ROOMMATE_KEY), false);

  page.pick('id-Hari');
  page.pick('not-a-roommate');
  assert.match(textOf(page.whoText.innerHTML), /^Hi there!/);
  assert.equal(page.storage.has(ROOMMATE_KEY), false);

  const stale = new Map([[ROOMMATE_KEY, 'id-Gone']]);
  const reloaded = loadFrontend({ storage: stale });
  reloaded.succeed(schedule());
  assert.match(textOf(reloaded.app.innerHTML), /Hi there!/);
  assert.equal(stale.has(ROOMMATE_KEY), false);
  assert.equal(pickerOptions(reloaded.app.innerHTML).some((option) => option[2]), false);
});

test('the personal message follows the current and upcoming turns', () => {
  assert.equal(greetingAfterPicking('id-Hari'), 'Hi, Hari! It’s your turn this weekend.');
  assert.equal(greetingAfterPicking('id-Hari', schedule({ current: { status: 'overdue' } })), 'Hi, Hari! Your turn is overdue.');
  assert.equal(greetingAfterPicking('id-Hari', schedule({ current: { status: 'waiting' } })), 'Hi, Hari! You’re up next.');
  assert.equal(
    greetingAfterPicking('id-Jijo', schedule({ current: { owner: person('Jijo'), assignee: person('Hari') } })),
    'Hi, Jijo! Your turn is covered by Hari (swap).'
  );
  const withKim = schedule({ roommates: [person('Hari'), person('Kim')] });
  assert.equal(greetingAfterPicking('id-Kim', withKim), 'Hi, Kim! You’re not up in the next few turns.');
});

test('names in the picker and greeting are escaped, including hostile ids', () => {
  const hostileName = person('<img src=x onerror=alert(1)>', 'id-bad');
  const hostileId = { roommate_id: 'x" onfocus="alert(1)', name: 'Eve' };
  const page = loadFrontend();
  page.succeed(schedule({ roommates: [hostileName, hostileId, person('Hari')] }));
  page.pick('id-bad');
  const html = page.app.innerHTML + page.whoText.innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /value="x" onfocus/);
  assert.match(page.app.innerHTML, /value="x&quot; onfocus=&quot;alert\(1\)"/);

  page.pick(hostileId.roommate_id);
  assert.match(textOf(page.whoText.innerHTML), /^Hi, Eve!/);
});

test('the pick is presented as unverified: a friendly greeting, never a login', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  page.pick('id-Hari');
  const text = textOf(page.app.innerHTML + page.whoText.innerHTML);
  assert.match(text, /Just for a friendly greeting\. This isn’t a login\./);
  assert.doesNotMatch(text, /log in|logged in|sign in|signed in|verified|welcome back|authenticated/i);
});

test('the pick never reaches the server and only decides whether the button is shown', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  page.pick('id-Hari');
  page.fail();
  page.clickRetry();
  assert.deepEqual(page.callArguments, [[], []], 'every getRotationSchedule call has no arguments, so the pick is never sent');
  assert.deepEqual([...page.storage.keys()], [ROOMMATE_KEY]);

  // Everything outside the greeting section is identical whoever is picked.
  const withoutGreeting = (html) =>
    html.replace(/<section class="who"[\s\S]*?<\/section>/, '').replace(/<button class="button mark-button"[\s\S]*?<\/button>/, '');
  const render = (stored) => {
    const loaded = loadFrontend({ storage: new Map(stored ? [[ROOMMATE_KEY, stored]] : []) });
    loaded.succeed(schedule());
    return loaded.app.innerHTML;
  };
  const baseline = withoutGreeting(render(null));
  for (const id of ['id-Hari', 'id-Jijo', 'id-Arun', 'id-Gone']) assert.equal(withoutGreeting(render(id)), baseline, id);
  assert.notEqual(render('id-Hari'), render(null), 'only the greeting differs');
});

test('the picker works for this visit when storage is blocked, and ignores changes before the schedule loads', () => {
  const page = loadFrontend({ storageBlocked: true });
  assert.doesNotThrow(() => page.pick('id-Hari'));
  page.succeed(schedule());
  assert.doesNotThrow(() => page.pick('id-Hari'));
  assert.match(textOf(page.whoText.innerHTML), /^Hi, Hari!/);
  assert.equal(page.storage.size, 0);

  const early = loadFrontend();
  early.pick('id-Hari');
  assert.equal(early.storage.has(ROOMMATE_KEY), false);
  early.changeElsewhere();
  assert.equal(early.whoText.innerHTML, '');
});

test('empty and error states have no picker, and a response without roommates is rejected', () => {
  for (const response of [failure('ROTATION_EMPTY'), failure('DATABASE_NOT_SET_UP')]) {
    const page = loadFrontend();
    page.succeed(response);
    assert.doesNotMatch(page.app.innerHTML, /<select/);
  }
  for (const roommates of [undefined, 'Hari', [{}], [null]]) {
    const page = loadFrontend();
    page.succeed({ ...schedule(), roommates });
    assert.match(textOf(page.app.innerHTML), /Error code: UNEXPECTED_RESPONSE/, JSON.stringify(roommates));
  }
});

test('the picker code grants no privileges and sends nothing to the server', () => {
  for (const [file, source] of frontendSources()) {
    // The one place "admin" appears is the Beta notice: it says the admin is away, and grants nothing.
    assert.doesNotMatch(source.replace(/BETA_NOTICE = '[^']*'/, ''), /\badmin\b|\bpermissions?\b|\brole\b(?!=)/i, file);
    assert.doesNotMatch(source, /getRotationSchedule\([^)]/, file);
  }
  const identity = read('Identity.html');
  assert.doesNotMatch(identity, /google\.script/);
  assert.match(identity, /NOT authentication/);
  assert.match(read('App.html'), /\.getRotationSchedule\(\);/);
});

// Slice 04D polish

test('contextual emojis are decorative only, and upcoming turns form a timeline', () => {
  const page = loadFrontend();
  page.succeed(
    schedule({
      current: { owner: person('Jijo'), assignee: person('Hari'), vacation_conflict_id: 'v' },
      upcoming: [turn('Arun', 1, { skipped: [person('Kim')] }), turn('Hari', 2), turn('Jijo', 3)],
    })
  );
  const html = page.app.innerHTML;
  for (const emoji of ['👋', '🧹', '✨', '🏖️', '🔄']) assert.match(html, new RegExp(`aria-hidden="true">${emoji}</span>`), emoji);

  const withoutDecoration = html.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, '');
  assert.doesNotMatch(withoutDecoration, /\p{Extended_Pictographic}/u, 'every emoji is hidden from screen readers');

  assert.equal(html.match(/<ol class="timeline">/g).length, 1);
  const names = [...html.matchAll(/<li class="timeline-item">[\s\S]*?class="name">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(names, ['Arun', 'Hari', 'Jijo']);
  assert.doesNotMatch(html, /turn-card/);

  const overdue = loadFrontend();
  overdue.succeed(schedule({ current: { status: 'overdue' } }));
  assert.doesNotMatch(overdue.app.innerHTML, /aria-hidden="true">✨/);
  assert.match(overdue.app.innerHTML, /aria-hidden="true">🧹/);
});

test('hover effects are limited to hover-capable devices, and keyboard focus is always visible', () => {
  const css = read('Styles.html');
  const hover = blockAt(css, css.indexOf('@media (hover: hover)'));
  assert.match(hover, /:hover/);
  assert.doesNotMatch(css.replace(hover, ''), /:hover/);
  for (const selector of ['.theme-toggle button:focus-visible', '.button:focus-visible', '.who-select:focus-visible', '.tab:focus-visible', '.profile:focus-visible']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /\.button:active/);
});

// Marking the turn as cleaned

const HARI = new Map([[ROOMMATE_KEY, 'id-Hari']]);
const hasMarkButton = (html) => /data-action="mark-cleaned"/.test(html);
const withHari = (payload = schedule(), storage = new Map(HARI)) => {
  const page = loadFrontend({ storage });
  page.succeed(payload);
  return page;
};

test('the button is offered only to the picked roommate, only on their open turn, and follows the pick', () => {
  assert.equal(hasMarkButton(withHari(schedule(), new Map()).app.innerHTML), false, 'nobody picked');
  assert.equal(hasMarkButton(withHari(schedule(), new Map([[ROOMMATE_KEY, 'id-Jijo']])).app.innerHTML), false, 'not the assignee');
  assert.equal(hasMarkButton(withHari(schedule(), new Map([[ROOMMATE_KEY, 'id-Gone']])).app.innerHTML), false, 'stale pick');
  assert.equal(hasMarkButton(withHari().app.innerHTML), true);
  assert.equal(hasMarkButton(withHari(schedule({ current: { status: 'overdue' } })).app.innerHTML), true, 'overdue turns can be completed');
  assert.equal(hasMarkButton(withHari(schedule({ current: { status: 'waiting' } })).app.innerHTML), false, 'not open yet');

  const page = loadFrontend();
  page.succeed(schedule());
  const before = page.app.innerHTML;
  page.pick('id-Hari');
  assert.equal(hasMarkButton(page.markAction.innerHTML), true);
  page.pick('id-Jijo');
  assert.equal(page.markAction.innerHTML, '');
  page.pick('');
  assert.equal(page.markAction.innerHTML, '');
  assert.equal(page.app.innerHTML, before, 'the picker is not re-rendered');
});

test('the button asks first in a friendly dialog, and Not yet leaves everything alone', () => {
  const page = withHari();
  page.clickMark();
  assert.equal(page.dialog.open, true);
  assert.equal(page.dialog.opened, 1);
  const text = textOf(page.dialog.innerHTML);
  assert.match(text, /Mark Entire Home as cleaned\?/);
  assert.match(text, /Hari, you’re telling everyone the whole home is clean\./);
  assert.match(text, /can’t be undone from the app/);
  assert.match(page.dialog.innerHTML, /data-action="cancel-clean" autofocus>Not yet</, 'the safe choice has focus');
  assert.deepEqual(page.calls, ['getRotationSchedule'], 'nothing is sent yet');

  page.dialogClick('cancel-clean');
  assert.equal(page.dialog.open, false);
  assert.deepEqual(page.calls, ['getRotationSchedule']);
});

test('confirming sends exactly the turn the page showed, ignores duplicate clicks, then shows a banner and refreshes', () => {
  const page = withHari();
  page.clickMark();
  page.dialogClick('confirm-clean');
  page.dialogClick('confirm-clean');
  page.dialogClick('confirm-clean');
  assert.deepEqual(page.calls, ['getRotationSchedule', 'markCleaned'], 'one request, however often it is clicked');
  assert.deepEqual(plain(page.callArguments[1]), [{ roommate_id: 'id-Hari', rotation_id: 'slot-Hari', due_at: turn('Hari', 0).due_at }]);
  assert.match(textOf(page.dialog.innerHTML), /Saving…/);
  assert.doesNotMatch(page.dialog.innerHTML, /<button/);
  page.clickMark();
  assert.equal(page.callArguments.length, 2, 'the button cannot start a second save while one is running');

  page.succeed({ ok: true, completed_at: '2026-01-14T12:00:00.000Z' });
  assert.equal(page.dialog.open, false);
  assert.deepEqual(page.calls, ['getRotationSchedule', 'markCleaned', 'getRotationSchedule'], 'the schedule is reloaded');
  assert.match(page.app.innerHTML, /Loading schedule/);

  page.succeed(schedule({ current: turn('Jijo', 1) }));
  const html = page.app.innerHTML;
  assert.match(html, /<p class="notice notice-success" role="status"><span aria-hidden="true">✨<\/span> Nice work, Hari! Entire Home is marked as cleaned\.<\/p>/);
  assert.match(textOf(html), /Current turn Pending Jijo/);
  assert.equal(hasMarkButton(html), false, 'Hari is no longer on duty');

  page.fail();
  page.clickRetry();
  page.succeed(schedule({ current: turn('Jijo', 1) }));
  assert.doesNotMatch(page.app.innerHTML, /notice/, 'the banner is shown once');
});

test('every failure is explained in plain words, nothing leaks, and the schedule is refreshed', () => {
  const messages = {
    NOT_YOUR_TURN: /It isn’t your turn right now, so nothing was saved\./,
    STALE_TURN: /The schedule changed while you were looking\./,
    ALREADY_RECORDED: /That turn was already marked as done\./,
    TURN_NOT_OPEN: /That turn isn’t open yet, so nothing was saved\./,
    BUSY: /Someone else is saving right now\./,
    WRITE_FAILED: /Nothing was recorded, so you can try again\./,
    INVALID_REQUEST: /Something went wrong, so nothing was saved\./,
    INTERNAL_ERROR: /Something went wrong, so nothing was saved\./,
    SOMETHING_NEW: /Something went wrong, so nothing was saved\./,
  };
  for (const [code, message] of Object.entries(messages)) {
    const page = withHari();
    page.clickMark();
    page.dialogClick('confirm-clean');
    page.succeed({ ok: false, error: { code, message: 'Server detail 1AbC-secret' } });
    page.succeed(schedule());
    assert.match(page.app.innerHTML, /<p class="notice notice-error" role="alert">/, code);
    assert.match(textOf(page.app.innerHTML), message, code);
    assert.doesNotMatch(page.app.innerHTML, /secret|Server detail/, code);
    assert.deepEqual(page.calls, ['getRotationSchedule', 'markCleaned', 'getRotationSchedule'], code);
    assert.equal(page.dialog.open, false, code);
  }
});

test('if the answer never arrives or makes no sense, the page says it could not confirm and checks the schedule', () => {
  for (const answer of ['network failure', undefined, null, 'ok', {}, { ok: false }]) {
    const page = withHari();
    page.clickMark();
    page.dialogClick('confirm-clean');
    if (answer === 'network failure') page.fail();
    else page.succeed(answer);
    assert.deepEqual(page.calls, ['getRotationSchedule', 'markCleaned', 'getRotationSchedule']);
    page.succeed(schedule());
    assert.match(page.app.innerHTML, /<p class="notice notice-info" role="status">We couldn’t confirm that it saved\. Check the schedule below before trying again\.<\/p>/);
  }
});

test('names in the dialog and the banner are escaped', () => {
  const hostile = person('<b onmouseover=alert(1)>Hari</b>', 'id-Hari');
  const page = loadFrontend({ storage: new Map(HARI) });
  page.succeed(schedule({ current: { owner: hostile, assignee: hostile }, roommates: [hostile] }));
  page.clickMark();
  assert.doesNotMatch(page.dialog.innerHTML, /<b /);
  assert.match(page.dialog.innerHTML, /&lt;b onmouseover=alert\(1\)&gt;Hari&lt;\/b&gt;, you’re telling everyone/);
  page.dialogClick('confirm-clean');
  page.succeed({ ok: true });
  page.succeed(schedule({ current: { owner: hostile, assignee: hostile }, roommates: [hostile] }));
  assert.doesNotMatch(page.app.innerHTML, /<b onmouseover/);
  assert.match(page.app.innerHTML, /Nice work, &lt;b onmouseover=alert\(1\)&gt;Hari&lt;\/b&gt;!/);
});

// Vacations (trust-based, interim)

const vacationItem = (name, extra = {}) => ({
  vacation_id: `v-${name}`,
  roommate_id: `id-${name}`,
  name,
  start_date: '2026-01-08T23:00:00.000Z', // Friday 9 Jan 00:00 Berlin
  return_date: '2026-01-11T23:00:00.000Z', // Monday 12 Jan 00:00 Berlin: the first day back
  state: 'upcoming',
  cancellable: true,
  weekends: [{ weekend_starts_at: '2026-01-09T23:00:00.000Z', due_at: '2026-01-11T23:00:00.000Z', status: 'skipped' }],
  ...extra,
});
const vacationList = (...items) => ({ ok: true, vacations: items });

function openedVacations(list = vacationList(), storage = new Map(HARI)) {
  const page = withHari(schedule(), storage);
  page.openVacationsClick();
  page.succeed(list);
  return page;
}
const dialogText = (page) => textOf(page.vacationDialog.innerHTML);
const berlinToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const SAVED = { ok: true, vacation_id: 'new-id' };

test('the Vacation tab has a Vacations card, and the list is only loaded when it is opened', () => {
  const page = withHari();
  assert.match(textOf(page.panels.vacation.innerHTML), /Vacation Vacations Going away\? Plan it here and your turns are skipped, with no make-up turn\. See and plan vacations/);
  assert.doesNotMatch(page.app.innerHTML, /vacations-title/, 'the schedule itself is unchanged');
  assert.deepEqual(page.calls, ['getRotationSchedule']);
  assert.equal(page.vacationDialog.open, false);

  page.openVacationsClick();
  assert.equal(page.vacationDialog.open, true);
  assert.match(dialogText(page), /Loading…/);
  assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations']);
  assert.deepEqual(plain(page.callArguments[1]), [], 'listing sends nothing');
});

test('the list shows names, Berlin dates, affected weekends and their skip status, under a trust-based notice', () => {
  const away = vacationItem('Arun', {
    state: 'away',
    cancellable: false,
    weekends: [
      { weekend_starts_at: '2026-01-16T23:00:00.000Z', due_at: '2026-01-18T23:00:00.000Z', status: 'not_their_turn' },
      { weekend_starts_at: '2026-06-05T22:00:00.000Z', due_at: '2026-06-07T22:00:00.000Z', status: 'later' },
    ],
  });
  const page = openedVacations(vacationList(vacationItem('Jijo'), away));
  const text = dialogText(page);
  assert.match(text, /Jijo Upcoming Fri 9 Jan – back Mon 12 Jan Sat 10 – Sun 11 Jan · Turn skipped/);
  assert.match(text, /Arun Away now Fri 9 Jan – back Mon 12 Jan Sat 17 – Sun 18 Jan · No turn that weekend Sat 6 – Sun 7 Jun · Not scheduled yet/);
  assert.match(text, /Trust-based for now: anyone with this link can change a vacation for the name picked on the main screen\. The selection is not a login and is not verified\./);
  assert.doesNotMatch(text, /verified as|logged in|signed in|authenticated|log in/i);
  assert.match(page.vacationDialog.innerHTML, /class="chip chip-skipped"/);
});

test('an empty list, a server problem and a network failure are each explained, and Try again reloads', () => {
  const empty = openedVacations(vacationList());
  assert.match(dialogText(empty), /No vacations planned\./);

  for (const [answer, pattern] of [
    [{ ok: false, error: { code: 'DATABASE_NOT_SET_UP', message: 'Server detail secret' } }, /We couldn’t load the vacations/],
    [undefined, /We couldn’t load the vacations/],
    [{}, /We couldn’t load the vacations/],
    [{ ok: true }, /We couldn’t load the vacations/],
    ['network', /We couldn’t reach the server/],
  ]) {
    const page = withHari();
    page.openVacationsClick();
    if (answer === 'network') page.fail();
    else page.succeed(answer);
    assert.match(dialogText(page), pattern);
    assert.doesNotMatch(page.vacationDialog.innerHTML, /secret/);
    page.vacationClick('retry-vacations');
    assert.deepEqual(page.calls.slice(-1), ['listVacations']);
    assert.match(dialogText(page), /Loading…/);
  }
});

test('plan and cancel buttons follow the picked roommate, and only offer your own cancellable vacations', () => {
  const list = vacationList(vacationItem('Hari'), vacationItem('Jijo'), vacationItem('Hari', { vacation_id: 'v-used', cancellable: false }));
  const picked = openedVacations(list);
  assert.match(dialogText(picked), /Plan a vacation for Hari/);
  assert.deepEqual([...picked.vacationDialog.innerHTML.matchAll(/data-action="cancel-vacation" data-vacation-id="([^"]*)"/g)].map((m) => m[1]), ['v-Hari']);

  const nobody = openedVacations(list, new Map());
  assert.doesNotMatch(nobody.vacationDialog.innerHTML, /plan-vacation|cancel-vacation/);
  assert.match(dialogText(nobody), /Pick your name on the main screen to plan or cancel a vacation\./);
  nobody.vacationClick('plan-vacation');
  nobody.vacationClick('cancel-vacation', { 'data-vacation-id': 'v-Hari' });
  assert.deepEqual(nobody.calls, ['getRotationSchedule', 'listVacations'], 'without a pick nothing can start');
});

test('the form asks for the first day away and the first day back, with today as the earliest date', () => {
  const page = openedVacations();
  page.vacationClick('plan-vacation');
  const html = page.vacationDialog.innerHTML;
  assert.match(textOf(html), /Plan a vacation for Hari/);
  assert.match(html, /<label for="vacation-start">First day away<\/label>/);
  assert.match(html, /<label for="vacation-return">First day back<\/label>/);
  assert.equal([...html.matchAll(/type="date" min="([^"]*)"/g)].map((m) => m[1]).join(), `${berlinToday()},${berlinToday()}`);
  assert.match(textOf(html), /Trust-based for now/);
  assert.match(textOf(html), /The first day back is the first day you can clean again\./);
  assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations'], 'opening the form asks the server nothing');
});

test('form mistakes are caught before asking the server, and the typed dates are kept', () => {
  const page = openedVacations();
  page.vacationClick('plan-vacation');
  for (const [start, back, message] of [
    ['', '2026-01-12', 'Pick both dates.'],
    ['2026-01-09', '', 'Pick both dates.'],
    ['2026-01-12', '2026-01-12', 'The first day back must be after the first day away.'],
    ['2026-01-12', '2026-01-09', 'The first day back must be after the first day away.'],
  ]) {
    page.setDates(start, back);
    page.vacationClick('save-vacation');
    assert.match(page.vacationDialog.innerHTML, new RegExp(`<p class="form-error" role="alert">${message.replace(/[.]/g, '\\.')}</p>`));
    assert.ok(page.vacationDialog.innerHTML.includes(`id="vacation-start" type="date" min="${berlinToday()}" value="${start}"`), 'the typed date is kept');
  }
  assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations']);
});

test('saving sends exactly the picked roommate and two dates, ignores double clicks, then refreshes the schedule and the list', () => {
  const page = openedVacations();
  page.vacationClick('plan-vacation');
  page.setDates('2026-01-09', '2026-01-12');
  page.vacationClick('save-vacation');
  page.vacationClick('save-vacation');
  page.vacationClick('save-vacation');
  assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations', 'saveVacation'], 'one request however often it is clicked');
  assert.deepEqual(plain(page.callArguments[2]), [{ roommate_id: 'id-Hari', start_date: '2026-01-09', return_date: '2026-01-12' }]);
  assert.match(dialogText(page), /Saving…/);
  assert.doesNotMatch(page.vacationDialog.innerHTML, /<button/);

  page.succeedCall(2, SAVED);
  assert.deepEqual(page.calls.slice(3), ['getRotationSchedule', 'listVacations'], 'the schedule and the list are reloaded');
  page.succeedCall(3, schedule({ current: turn('Jijo', 1) }));
  assert.match(textOf(page.app.innerHTML), /Current turn Pending Jijo/);
  page.succeedCall(4, vacationList(vacationItem('Hari')));
  assert.match(page.vacationDialog.innerHTML, /<p class="notice notice-success" role="status">/);
  assert.match(dialogText(page), /Vacation saved\. Your turns while you are away are skipped\./);
  assert.match(dialogText(page), /Hari Upcoming Fri 9 Jan – back Mon 12 Jan/);
});

test('every refusal is explained in plain words, nothing leaks, and the typed dates stay in the form', () => {
  const codes = {
    VACATION_DATES_INVALID: /real dates/, VACATION_IN_PAST: /can’t be in the past/, VACATION_ORDER: /must be after the first day away/, VACATION_TOO_LONG: /at most 120 days/,
    VACATION_TOO_FAR: /at most a year ahead/, VACATION_OVERLAP: /already a vacation on those dates/, VACATION_LIMIT: /Too many vacations/, UNKNOWN_ROOMMATE: /isn’t on the list/,
    BUSY: /Someone else is saving/, WRITE_FAILED: /Nothing was recorded/, INVALID_REQUEST: /Something went wrong, so nothing was saved/, SOMETHING_NEW: /Something went wrong, so nothing was saved/,
  };
  for (const [code, pattern] of Object.entries(codes)) {
    const page = openedVacations();
    page.vacationClick('plan-vacation');
    page.setDates('2026-01-09', '2026-01-12');
    page.vacationClick('save-vacation');
    page.succeedCall(2, { ok: false, error: { code, message: 'Server detail 1AbC-secret' } });
    assert.match(textOf(page.vacationDialog.innerHTML), pattern, code);
    assert.doesNotMatch(page.vacationDialog.innerHTML, /secret|Server detail/, code);
    assert.ok(page.vacationDialog.innerHTML.includes('value="2026-01-09"') && page.vacationDialog.innerHTML.includes('value="2026-01-12"'), code);
    assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations', 'saveVacation'], `${code}: nothing was saved, so nothing is reloaded`);
    page.vacationClick('save-vacation');
    assert.equal(page.calls.filter((c) => c === 'saveVacation').length, 2, 'the form can be fixed and sent again');
  }
});

test('if the answer never arrives or makes no sense, the list is reloaded with a note that the save is unconfirmed', () => {
  for (const answer of ['network', undefined, null, {}, 'ok']) {
    const page = openedVacations();
    page.vacationClick('plan-vacation');
    page.setDates('2026-01-09', '2026-01-12');
    page.vacationClick('save-vacation');
    if (answer === 'network') page.failCall(2);
    else page.succeedCall(2, answer);
    assert.deepEqual(page.calls.slice(3), ['listVacations'], 'only the list is checked');
    page.succeedCall(3, vacationList());
    assert.match(page.vacationDialog.innerHTML, /<p class="notice notice-info" role="status">We couldn’t confirm that it saved\. Check the list before trying again\.<\/p>/);
  }
});

test('cancelling asks first, sends exactly the roommate and vacation once, then refreshes', () => {
  const page = openedVacations(vacationList(vacationItem('Hari')));
  page.vacationClick('cancel-vacation', { 'data-vacation-id': 'v-Hari' });
  assert.match(dialogText(page), /Cancel this vacation\? Hari: Fri 9 Jan – back Mon 12 Jan\. Your turns in that time will count again\./);
  assert.match(page.vacationDialog.innerHTML, /data-action="back-to-vacations" autofocus>Keep it</, 'the safe choice has focus');
  page.vacationClick('back-to-vacations');
  assert.match(dialogText(page), /Hari Upcoming/);
  assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations'], 'keeping it asks the server nothing');

  page.vacationClick('cancel-vacation', { 'data-vacation-id': 'v-Hari' });
  page.vacationClick('confirm-cancel-vacation');
  page.vacationClick('confirm-cancel-vacation');
  assert.deepEqual(page.calls.slice(2), ['cancelVacation']);
  assert.deepEqual(plain(page.callArguments[2]), [{ roommate_id: 'id-Hari', vacation_id: 'v-Hari' }]);
  page.succeedCall(2, { ok: true });
  assert.deepEqual(page.calls.slice(3), ['getRotationSchedule', 'listVacations']);
  page.succeedCall(4, vacationList());
  assert.match(dialogText(page), /Vacation cancelled\..*No vacations planned\./);
});

test('a cancel that is refused or unconfirmed reloads the list, with the reason in plain words', () => {
  const reasons = {
    VACATION_IN_USE: /already skipped a turn/, VACATION_STARTED: /has started/, NOT_YOUR_VACATION: /belongs to someone else/, VACATION_NOT_FOUND: /isn’t there any more/, WRITE_FAILED: /Nothing was recorded/,
  };
  for (const [code, pattern] of Object.entries(reasons)) {
    const page = openedVacations(vacationList(vacationItem('Hari')));
    page.vacationClick('cancel-vacation', { 'data-vacation-id': 'v-Hari' });
    page.vacationClick('confirm-cancel-vacation');
    page.succeedCall(2, { ok: false, error: { code, message: 'Server detail secret' } });
    assert.deepEqual(page.calls.slice(3), ['listVacations'], code);
    page.succeedCall(3, vacationList(vacationItem('Hari')));
    assert.match(page.vacationDialog.innerHTML, /<p class="notice notice-error" role="alert">/, code);
    assert.match(dialogText(page), pattern, code);
    assert.doesNotMatch(page.vacationDialog.innerHTML, /secret/, code);
  }
  const page = openedVacations(vacationList(vacationItem('Hari')));
  page.vacationClick('cancel-vacation', { 'data-vacation-id': 'v-Hari' });
  page.vacationClick('confirm-cancel-vacation');
  page.failCall(2);
  page.succeedCall(3, vacationList(vacationItem('Hari')));
  assert.match(page.vacationDialog.innerHTML, /notice notice-info/);
});

test('names and ids in the vacation views are escaped, and someone else\'s vacation cannot be cancelled from the page', () => {
  const hostile = vacationItem('Hari', { name: '<img src=x onerror=alert(1)>', vacation_id: 'v"><b>x' });
  const page = openedVacations(vacationList(hostile, vacationItem('Jijo')));
  assert.doesNotMatch(page.vacationDialog.innerHTML, /<img|<b>/);
  assert.match(page.vacationDialog.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page.vacationDialog.innerHTML, /data-vacation-id="v&quot;&gt;&lt;b&gt;x"/);

  page.vacationClick('cancel-vacation', { 'data-vacation-id': 'v-Jijo' });
  assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations'], 'Jijo\'s vacation is not Hari\'s to cancel');
  assert.match(dialogText(page), /Hari Upcoming|<img/);
});

test('closing the dialog drops drafts and pending confirmations', () => {
  const page = openedVacations(vacationList(vacationItem('Hari')));
  page.vacationClick('plan-vacation');
  page.setDates('2026-01-09', '2026-01-12');
  page.vacationClick('close-vacation');
  assert.equal(page.vacationDialog.open, false);
  page.vacationClick('plan-vacation');
  assert.ok(page.vacationDialog.innerHTML.includes('id="vacation-start" type="date" min="'), 'the form opens');
  assert.ok(page.vacationDialog.innerHTML.includes(`min="${berlinToday()}" value=""`), 'the old dates are gone');

  page.vacationClick('close-vacation');
  page.vacationClick('confirm-cancel-vacation');
  assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations']);
});

// App shell: navigation, Beta notice, profile entry, work-in-progress pages

const BETA_KEY = 'chorenest-beta-notice';

test('the page has a four-section navigation, with Schedule showing first', () => {
  const nav = read('Index.html').match(/<nav class="tabs"[^>]*>([\s\S]*?)<\/nav>/);
  assert.match(nav[0], /aria-label="Sections"/);
  assert.deepEqual(
    [...nav[1].matchAll(/<button class="tab" type="button" data-tab="(\w+)" aria-current="(\w+)">.*?<span>(\w+)<\/span><\/button>/g)].map((m) => m.slice(1)),
    [['schedule', 'page', 'Schedule'], ['vacation', 'false', 'Vacation'], ['swaps', 'false', 'Swaps'], ['history', 'false', 'History']]
  );
  const page = loadFrontend();
  assert.deepEqual(page.shown(), ['schedule']);
  assert.deepEqual(page.current(), ['schedule']);
});

test('tabs switch sections, mark the current one, and never ask the server for anything', () => {
  const page = withHari();
  for (const tab of ['vacation', 'swaps', 'history', 'schedule', 'history']) {
    page.tabClick(tab);
    assert.deepEqual(page.shown(), [tab]);
    assert.deepEqual(page.current(), [tab]);
  }
  assert.deepEqual(page.calls, ['getRotationSchedule'], 'moving around reloads nothing');
  page.tabClick('swaps');
  page.tabsClickElsewhere();
  assert.deepEqual(page.shown(), ['swaps'], 'a click that is not on a tab changes nothing');
  assert.deepEqual(page.calls, ['getRotationSchedule']);
});

test('the schedule and Mark as cleaned work exactly as before after visiting other tabs', () => {
  const page = withHari();
  const before = page.app.innerHTML;
  for (const tab of ['vacation', 'swaps', 'history', 'schedule']) page.tabClick(tab);
  assert.equal(page.app.innerHTML, before, 'the schedule was not re-rendered');
  assert.equal(hasMarkButton(page.app.innerHTML), true);
  page.clickMark();
  assert.equal(page.dialog.open, true);
  page.dialogClick('confirm-clean');
  assert.deepEqual(plain(page.callArguments[1]), [{ roommate_id: 'id-Hari', rotation_id: 'slot-Hari', due_at: turn('Hari', 0).due_at }]);
});

test('a schedule that arrives while another tab is open is waiting there, and the tab bar survives errors', () => {
  const page = loadFrontend();
  page.tabClick('history');
  page.succeed(schedule());
  assert.deepEqual(page.shown(), ['history']);
  page.tabClick('schedule');
  assert.match(textOf(page.app.innerHTML), /Current turn/);

  const broken = loadFrontend();
  broken.fail();
  broken.tabClick('vacation');
  assert.deepEqual(broken.shown(), ['vacation']);
  broken.tabClick('schedule');
  assert.match(textOf(broken.app.innerHTML), /Couldn’t reach the server/);
});

test('Vacation is a real section, and Swaps and History are honest "Work in progress" pages', () => {
  const page = withHari();
  assert.match(textOf(page.panels.vacation.innerHTML), /^Vacation Vacations /);
  page.openVacationsClick();
  assert.equal(page.vacationDialog.open, true, 'vacations work from their own tab');

  for (const [tab, title] of [['swaps', 'Swaps'], ['history', 'History']]) {
    const html = page.panels[tab].innerHTML;
    const text = textOf(html);
    assert.match(text, new RegExp(`^${title} Work in progress `));
    assert.match(text, /Nothing to do here yet\.$/);
    assert.doesNotMatch(html, /<(button|input|select|textarea|form|a )|data-action|onclick/, `${tab}: nothing to click or submit`);
  }
  assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations'], 'unfinished sections never touch the server');
});

test('a Beta badge sits next to the name, and the first visit gets a dismissible notice', () => {
  assert.match(read('Index.html'), /<h1>ChoreNest<\/h1>\s*<span class="beta-badge">Beta<\/span>/);
  const page = loadFrontend();
  assert.equal(page.betaNotice.hidden, false);
  assert.equal(textOf(page.betaNotice.innerHTML), 'ChoreNest is in beta. Some issues may take longer to fix while the admin is away. Thanks for your patience! Got it');
  assert.deepEqual(page.betaNotice.innerHTML.match(/<button[^>]*>/g), ['<button class="button button-quiet" type="button" data-action="dismiss-beta">']);
  page.betaClick('something-else');
  assert.equal(page.betaNotice.hidden, false, 'only Got it dismisses it');

  page.betaClick('dismiss-beta');
  assert.equal(page.betaNotice.hidden, true);
  assert.equal(page.betaNotice.innerHTML, '');
  assert.equal(page.storage.get(BETA_KEY), 'dismissed');
  assert.deepEqual(page.calls, ['getRotationSchedule'], 'it is only remembered in this browser');
});

test('a dismissed notice stays away on later visits, and still works when browser storage is blocked', () => {
  const first = loadFrontend();
  first.betaClick('dismiss-beta');
  const again = loadFrontend({ storage: first.storage });
  assert.equal(again.betaNotice.hidden, true);
  assert.equal(again.betaNotice.innerHTML, '');

  const other = loadFrontend({ storage: new Map([[BETA_KEY, 'something else']]) });
  assert.equal(other.betaNotice.hidden, false, 'only a real dismissal counts');

  const blocked = loadFrontend({ storageBlocked: true });
  assert.equal(blocked.betaNotice.hidden, false);
  blocked.betaClick('dismiss-beta');
  assert.equal(blocked.betaNotice.hidden, true, 'dismissed for this visit');
});

test('the profile entry says nobody is picked until someone is, and never claims a login', () => {
  const page = loadFrontend();
  assert.match(textOf(page.profileButton.innerHTML), /^Just looking No name picked$/);
  assert.equal(page.profileButton.attributes['aria-label'], 'Profile: no name picked');

  page.succeed(schedule());
  assert.equal(page.profileButton.attributes['aria-label'], 'Profile: no name picked');
  page.pick('id-Hari');
  assert.match(textOf(page.profileButton.innerHTML), /Hari Not verified$/);
  assert.match(page.profileButton.innerHTML, /avatar avatar-sm tone-\d/);
  assert.equal(page.profileButton.attributes['aria-label'], 'Profile: Hari, not verified');
  page.pick('');
  assert.match(textOf(page.profileButton.innerHTML), /Just looking No name picked$/);
});

test('the profile entry follows a remembered pick, and drops one that is gone', () => {
  const remembered = withHari();
  assert.match(textOf(remembered.profileButton.innerHTML), /Hari Not verified$/);
  assert.equal(remembered.profileButton.attributes['aria-label'], 'Profile: Hari, not verified');

  const gone = loadFrontend({ storage: new Map([[ROOMMATE_KEY, 'id-Gone']]) });
  gone.succeed(schedule());
  assert.match(textOf(gone.profileButton.innerHTML), /Just looking No name picked$/);

  const failed = loadFrontend({ storage: new Map(HARI) });
  failed.fail();
  assert.match(textOf(failed.profileButton.innerHTML), /Just looking No name picked$/, 'without the roommate list nothing can be confirmed');
});

test('the profile dialog explains the identity state honestly', () => {
  const picked = withHari();
  picked.openProfile();
  assert.equal(picked.profileDialog.open, true);
  assert.equal(
    textOf(picked.profileDialog.innerHTML),
    'Profile Viewing as Hari You picked this name from a list on this device. It isn’t a login and it isn’t verified: anyone with the link can pick any name. Change name Close'
  );

  const nobody = withHari(schedule(), new Map());
  nobody.openProfile();
  assert.match(textOf(nobody.profileDialog.innerHTML), /Just looking No name is picked\. Pick yours on the Schedule tab to get a personal greeting\. It isn’t a login and it isn’t verified\. Pick a name Close/);

  const early = loadFrontend();
  early.openProfile();
  assert.match(textOf(early.profileDialog.innerHTML), /The roommate list hasn’t loaded yet\. Close$/);
  assert.doesNotMatch(early.profileDialog.innerHTML, /change-name/);

  for (const page of [picked, nobody, early]) {
    const all = textOf(page.profileButton.innerHTML + page.profileDialog.innerHTML) + page.profileButton.attributes['aria-label'];
    assert.doesNotMatch(all.replace(/isn’t a login and it isn’t verified|not verified/gi, ''), /log ?in|logged|sign(ed)? ?in|verified|authenticated|account|welcome back/i);
  }
});

test('Change name returns to the Schedule tab and focuses the picker; Close just closes', () => {
  const page = withHari();
  page.tabClick('history');
  page.openProfile();
  page.profileClick('close-profile');
  assert.equal(page.profileDialog.open, false);
  assert.deepEqual(page.shown(), ['history']);

  page.openProfile();
  page.profileClick('change-name');
  assert.equal(page.profileDialog.open, false);
  assert.deepEqual(page.shown(), ['schedule']);
  assert.equal(page.whoSelect.focused, 1);
  page.profileClick('something-else');
  assert.deepEqual(page.calls, ['getRotationSchedule'], 'the profile never calls the server');
});

test('hostile roommate names are escaped in the profile entry and dialog', () => {
  const hostile = [person('<img src=x onerror=alert(1)>', 'id-x'), person('Hari')];
  const page = loadFrontend({ storage: new Map([[ROOMMATE_KEY, 'id-x']]) });
  page.succeed(schedule({ roommates: hostile }));
  page.openProfile();
  const html = page.profileButton.innerHTML + page.profileDialog.innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(page.profileDialog.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page.profileButton.innerHTML, /&lt;img/);
});

test('the shell grants nothing and sends nothing: no server calls, storage only for the Beta notice', () => {
  const shell = read('Shell.html');
  assert.doesNotMatch(shell, /google\.script|selectedRoommateId|localStorage/);
  assert.match(shell, /Data in, HTML strings out/);
  assert.match(read('Index.html'), /id="profile-button"[^>]*aria-haspopup="dialog"/);
});

test('the navigation is a bottom bar on phones and a row on wide screens, and hidden sections stay hidden', () => {
  const css = read('Styles.html');
  assert.match(blockAt(css, css.indexOf('  .tabs {')), /position: fixed;[\s\S]*bottom: 0;/);
  const wide = blockAt(css, css.indexOf('@media (min-width: 760px)'));
  assert.match(blockAt(wide, wide.indexOf('.tabs {')), /position: static;/);
  assert.match(css, /\[hidden\]\s*{\s*display: none !important;/);
  assert.match(css, /padding: 16px 16px 104px;/, 'the bar never covers the end of the page');
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.tab\[aria-current="page"\]/);
});

test('a tap on the icon or label inside a button counts as a tap on the button', () => {
  const inside = (button) => ({ getAttribute: () => null, closest: (selector) => (selector === '[data-tab]' && button.getAttribute('data-tab') ? button : selector === '[data-action]' && button.getAttribute('data-action') ? button : null) });
  const button = (attribute, value) => ({ getAttribute: (name) => (name === attribute ? value : null) });

  const page = withHari();
  page.tabs.listeners.click({ target: inside(button('data-tab', 'swaps')) });
  assert.deepEqual(page.shown(), ['swaps'], 'the label of a tab');

  page.tabClick('schedule');
  page.app.listeners.click({ target: inside(button('data-action', 'mark-cleaned')) });
  assert.equal(page.dialog.open, true, 'the emoji of Mark as cleaned');

  const vacation = openedVacations(vacationList(vacationItem('Hari')));
  const cancel = { getAttribute: (name) => ({ 'data-action': 'cancel-vacation', 'data-vacation-id': 'v-Hari' })[name] || null };
  vacation.vacationDialog.listeners.click({ target: { getAttribute: () => null, closest: () => cancel } });
  assert.match(textOf(vacation.vacationDialog.innerHTML), /Cancel this vacation\?/, 'the label of Cancel vacation');
});

test('Schedule is fetched again only after it has gone stale, and never while saving', () => {
  const page = withHari();
  page.tabClick('history');
  page.tabClick('schedule');
  assert.deepEqual(page.calls, ['getRotationSchedule'], 'a recent schedule is kept');

  page.tabClick('history');
  page.view('Date.now = (real => () => real() + 6 * 60 * 1000)(Date.now)');
  page.tabClick('schedule');
  assert.deepEqual(page.calls, ['getRotationSchedule', 'getRotationSchedule'], 'an old one is refreshed');
  page.succeed(schedule());
  page.tabClick('history');
  page.tabClick('schedule');
  assert.equal(page.calls.length, 2, 'and then it is recent again');

  const failed = loadFrontend();
  failed.fail();
  failed.view('Date.now = (real => () => real() + 6 * 60 * 1000)(Date.now)');
  failed.tabClick('history');
  failed.tabClick('schedule');
  assert.deepEqual(failed.calls, ['getRotationSchedule'], 'a failed load keeps its Try again button instead');
});
