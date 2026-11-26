'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DEV_SPREADSHEET_ID, FIXTURES, FakeSpreadsheet, asSignedIn, fixtureSheet, loadProject, plain } = require('./support/appsScript');

const FRONTEND_DIR = path.join(__dirname, '..', 'src', 'frontend');
const read = (file) => fs.readFileSync(path.join(FRONTEND_DIR, file), 'utf8');
const scriptOf = (file) => read(file).match(/<script>([\s\S]*)<\/script>/)[1];

/**
 * Runs the real page scripts against a fake browser: document, theme toggle, localStorage, matchMedia and
 * google.script.run. `storage` can be shared between two loads to simulate a page reload.
 */
const SESSION_KEY = 'chorenest-session';
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
/** The signed-in roommate as the server reports it (Hari holds the ADMIN role in these tests). */
const viewerOf = (name, extra = {}) => ({ roommate_id: `id-${name}`, name, role: name === 'Hari' ? 'ADMIN' : 'ROOMMATE', must_change_password: false, ...extra });

/**
 * Loads the real page scripts with a fake DOM. `as` signs the page in as that roommate: a stored session, and the
 * fake server adds them as `viewer` to good schedule answers. The default is Jijo, who is not the current assignee;
 * `as: null` starts signed out.
 */
function loadFrontend({ storage = new Map(), systemDark = false, storageBlocked = false, as = 'Jijo' } = {}) {
  if (as && !storageBlocked && !storage.has(SESSION_KEY)) storage.set(SESSION_KEY, JSON.stringify({ token: `token-${as}`, expires_at: FAR_FUTURE }));
  let viewer = as ? viewerOf(as) : null;
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
  const authScreen = Object.assign(element(), { hidden: false });
  const mainContent = Object.assign(element(), { hidden: true });
  const input = (type = 'text') => Object.assign(element(), { value: '', type, focused: 0, focus() { this.focused++; } });
  const adminDialog = element();
  adminDialog.open = false;
  adminDialog.showModal = function () {
    this.open = true;
  };
  adminDialog.close = function () {
    this.open = false;
  };
  const authInputs = {
    'sign-in-username': input(),
    'sign-in-password': input('password'),
    'current-password': input('password'),
    'new-password': input('password'),
    'repeat-password': input('password'),
  };
  const swapDialog = element();
  swapDialog.open = false;
  swapDialog.showModal = function () {
    this.open = true;
  };
  swapDialog.close = function () {
    this.open = false;
  };
  const swapInputs = {
    'swap-mine': input(),
    'swap-theirs': input(),
    'swap-preview-slot': element(),
  };
  const adminInputs = {
    'admin-name': input(),
    'admin-email': input(),
    'admin-telegram': input(),
    'admin-username': input(),
    'admin-role-admin': Object.assign(input('radio'), { checked: false }),
    'temp-password': Object.assign(element(), { textContent: '' }),
    'copy-status': Object.assign(element(), { textContent: '' }),
  };
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
    admin: Object.assign(element(), { hidden: true }),
  };
  const awaySlot = element();
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
  };
  for (const name of ['getRotationSchedule', 'markCleaned', 'listVacations', 'saveVacation', 'cancelVacation', 'updateVacation', 'endVacation', 'signIn', 'changePassword', 'signOut',
    'listCleaningHistory', 'exportCleaningHistory', 'listSwaps', 'requestSwap', 'acceptSwap', 'declineSwap', 'cancelSwap', 'adminListAccounts', 'adminAddRoommate', 'adminProvisionAccount', 'adminResetSignIn', 'adminDisableSignIn', 'adminEndSessions', 'adminChangeRole']) {
    run[name] = function (...args) {
      calls.push(name);
      callArguments.push(JSON.parse(JSON.stringify(args))); // plain data, as google.script.run would send it
      pending.push({ name, success: this.success, failure: this.failure });
    };
  }
  // Like the server: a good schedule says who is signed in; a successful sign-in changes who that is.
  const answer = (entry, result) => {
    if ((entry.name === 'signIn' || entry.name === 'changePassword') && result && result.ok === true) viewer = result.viewer;
    entry.success(entry.name === 'getRotationSchedule' && result && result.ok === true && !result.viewer && viewer ? { ...result, viewer } : result);
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
    'auth-screen': authScreen,
    'admin-dialog': adminDialog,
    'swap-dialog': swapDialog,
    ...swapInputs,
    'panel-admin': panels.admin,
    ...adminInputs,
    'main-content': mainContent,
    ...authInputs,
    tabs,
    'panel-schedule': panels.schedule,
    'panel-vacation': panels.vacation,
    'panel-swaps': panels.swaps,
    'panel-history': panels.history,
    'vacation-start': startInput,
    'vacation-return': returnInput,
    'away-slot': awaySlot,
  };
  // Downloads: a temporary link plus a Blob URL, as the page makes them.
  const downloads = [];
  const blobs = new Map();
  const downloadFlags = { blocked: false };
  const document = {
    documentElement: root,
    getElementById: (id) => elements[id] || app,
    createElement: () => ({ click() { downloads.push({ href: this.href, download: this.download, text: blobs.get(this.href) }); } }),
    body: { appendChild() {}, removeChild() {} },
  };
  const context = vm.createContext({
    document,
    window: { localStorage, matchMedia: () => media },
    google: { script: { run } },
    Blob: class { constructor(parts, options) { this.text = parts.join(''); this.type = options.type; } },
    URL: {
      createObjectURL: (blob) => {
        if (downloadFlags.blocked) throw new Error('blocked');
        const url = 'blob:test-' + (blobs.size + 1);
        blobs.set(url, blob.text);
        return url;
      },
      revokeObjectURL() {},
    },
  });
  vm.runInContext(scriptOf('Storage.html'), context);
  vm.runInContext(scriptOf('Theme.html'), context);
  const themeAtLoad = root.attributes['data-theme'];
  vm.runInContext(scriptOf('ScheduleView.html'), context);
  vm.runInContext(scriptOf('VacationView.html'), context);
  vm.runInContext(scriptOf('HistoryView.html'), context);
  vm.runInContext(scriptOf('SwapView.html'), context);
  vm.runInContext(scriptOf('Session.html'), context);
  vm.runInContext(scriptOf('LoginView.html'), context);
  vm.runInContext(scriptOf('AdminView.html'), context);
  vm.runInContext(scriptOf('Shell.html'), context);
  vm.runInContext(scriptOf('App.html'), context);

  return {
    app,
    awaySlot,
    whoText,
    markAction,
    dialog,
    vacationDialog,
    profileDialog,
    profileButton,
    betaNotice,
    authScreen,
    mainContent,
    authInputs,
    adminDialog,
    adminInputs,
    swapDialog,
    swapInputs,
    swapPanelClick: (action, attributes = {}) => panels.swaps.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : attributes[name] || null) } }),
    swapDialogClick: (action) => swapDialog.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : null) } }),
    swapChange: () => swapDialog.listeners.change({ target: {} }),
    swapEscape: () => swapDialog.listeners.cancel({ preventDefault() {} }),
    adminPanelClick: (action, attributes = {}) => panels.admin.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : attributes[name] || null) } }),
    adminDialogClick: (action) => adminDialog.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : null) } }),
    adminEscape: () => adminDialog.listeners.cancel({ preventDefault() {} }),
    authSubmit: (form) => authScreen.listeners.submit({ target: { getAttribute: (name) => (name === 'data-form' ? form : null) }, preventDefault() {} }),
    authClick: (action, attributes = {}) => authScreen.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : attributes[name] || null) } }),
    signedIn: () => !mainContent.hidden && !tabs.hidden && authScreen.hidden,
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
    panelClick: (action, attributes = {}) =>
      panels.vacation.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : attributes[name] || null) } }),
    clickApp: (action) => app.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : null) } }),
    clickMark: () => app.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? 'mark-cleaned' : null) } }),
    dialogClick: (action) => dialog.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : null) } }),
    historyClick: (action, attributes = {}) =>
      panels.history.listeners.click({ target: { getAttribute: (name) => (name === 'data-action' ? action : attributes[name] || null) } }),
    downloads,
    downloadFlags,
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
    succeed: (result) => answer(pending[pending.length - 1], result),
    succeedCall: (index, result) => answer(pending[index], result),
    failCall: (index) => pending[index].failure(new Error('network')),
    fail: (error = new Error('network')) => pending[pending.length - 1].failure(error),
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

function schedule({ current = {}, upcoming, roommates, viewer } = {}) {
  return {
    ...(viewer ? { viewer } : {}),
    ok: true,
    environment: 'DEV',
    generated_at: '2026-01-13T12:00:00.000Z',
    current: { ...turn('Hari', 0), status: 'pending', ...current },
    upcoming: upcoming || [turn('Jijo', 1), turn('Arun', 2), turn('Hari', 3)],
    roommates: roommates || [person('Arun'), person('Hari'), person('Jijo')],
  };
}

// After the first schedule answer the page asks for the household vacations once.
const LOADED = ['getRotationSchedule', 'listVacations'];
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

/** The names listed under "Coming up", in order. */
const comingUpNames = (html) => [...html.matchAll(/<li class="timeline-item">[\s\S]*?class="name">([^<]*)</g)].map((m) => m[1]);

test('Coming up shows the next three distinct turns; the same roommate may come round again on a later weekend', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  const items = page.app.innerHTML.match(/<li class="timeline-item">[\s\S]*?<\/li>/g).map(textOf);
  assert.deepEqual(items, ['Jijo Up next Sat 24 – Sun 25 Jan', 'Arun Then Sat 31 Jan – Sun 1 Feb', 'Hari After that Sat 7 – Sun 8 Feb'], 'Hari cleans now and again in three weeks');
  assert.deepEqual([...page.app.innerHTML.matchAll(/class="avatar avatar-\w+ tone-\d" aria-hidden="true">([^<]*)</g)].map((m) => m[1]), ['H', 'J', 'A', 'H']);
  assert.equal((textOf(page.app.innerHTML).match(/Sat 17 – Sun 18 Jan/g) || []).length, 1, 'the current weekend appears once, in the card');
  assert.doesNotMatch(textOf(page.app.innerHTML), /Your next turn|your turn at a glance/);

  const four = loadFrontend();
  four.succeed(schedule({ upcoming: [turn('Jijo', 1), turn('Arun', 2), turn('Kim', 3), turn('Hari', 4)], roommates: [person('Arun'), person('Hari'), person('Jijo'), person('Kim')] }));
  assert.deepEqual(comingUpNames(four.app.innerHTML), ['Jijo', 'Arun', 'Kim'], 'at most three');
});

test('only the exact current assignment is left out, and each weekend is listed once', () => {
  const current = { ...turn('Hari', 0), status: 'overdue' };
  const page = loadFrontend();
  page.succeed(schedule({ current, upcoming: [turn('Hari', 0), turn('Arun', -1), turn('Jijo', 1), turn('Jijo', 1), turn('Hari', 2)] }));
  const html = page.app.innerHTML;
  assert.deepEqual(comingUpNames(html), ['Jijo', 'Hari']);
  assert.equal((textOf(html).match(/Sat 17 – Sun 18 Jan/g) || []).length, 1, 'the current weekend appears once, in the card');

  const alone = loadFrontend();
  alone.succeed(schedule({ upcoming: [turn('Hari', 1), turn('Hari', 2), turn('Hari', 3)], roommates: [person('Hari')] }));
  assert.deepEqual(comingUpNames(alone.app.innerHTML), ['Hari', 'Hari', 'Hari'], 'a single roommate still has later weekends');
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

test('explains swapped turns and roommates who are away, in one short note each', () => {
  const page = loadFrontend();
  page.succeed(
    schedule({
      current: { owner: person('Jijo'), assignee: person('Hari'), swap_id: 'swap', vacation_conflict_id: 'vacation', skipped: [person('Kim')] },
      upcoming: [turn('Arun', 1, { skipped: [person('Jijo'), person('Kim')] }), turn('Hari', 2), turn('Jijo', 3)],
    })
  );
  const hero = textOf(page.app.innerHTML.match(/<section class="card hero[\s\S]*?<\/section>/)[0]);
  assert.match(hero, /Covering for Jijo \(swap\)\. Hari is away, so this turn will be skipped\./);
  assert.equal((page.app.innerHTML.match(/<p class="note">/g) || []).length, 3, 'two in the card, one in Coming up');
  assert.match(textOf(page.app.innerHTML), /Jijo and Kim are away\./);
  assert.doesNotMatch(textOf(page.app.innerHTML), /has been recorded/);
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

test('is read-only: no picker or form on the schedule, and only the two read calls are made', () => {
  const page = loadFrontend(); // Jijo, whose turn it is not
  page.succeed(schedule());
  assert.doesNotMatch(page.app.innerHTML, /<(form|input|textarea|select|a )/);
  assert.equal(page.app.innerHTML.match(/<button[^>]*>/g), null, 'someone else’s turn offers no action');
  assert.deepEqual(page.panels.vacation.innerHTML.match(/<button[^>]*>/g), ['<button class="button" type="button" data-action="plan-vacation">'], 'planning your own vacation is always possible');
  page.clickElsewhere();
  assert.deepEqual(page.calls, LOADED);
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
  assert.deepEqual(page.calls, ['getRotationSchedule', 'listVacations', 'getRotationSchedule'], 'vacations are still loaded for their tab');
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
  page.succeed(plain(server.get('getRotationSchedule')(asSignedIn(server))));
  const text = textOf(page.app.innerHTML);
  assert.match(text, /Current turn Pending Alex Example Entire Home/);
  assert.match(text, /Covering for Sam Example \(swap\)\./);
  assert.match(text, /Cleaning weekend Sat 17 – Sun 18 Jan/);
  assert.match(text, /Updated Tue 13 Jan, 13:00 · Times in Berlin/);
  const upcoming = page.app.innerHTML.match(/<li class="timeline-item">[\s\S]*?<\/li>/g).map((item) => item.match(/class="name">([^<]*)</)[1]);
  assert.deepEqual(upcoming, ['Kim Example', 'Alex Example', 'Sam Example'], 'three later turns; Alex comes round again');
  assert.match(text, /Jo Example is away\./);
});

test('with the real server and a 3-roommate rotation, Coming up shows three distinct weekends, with vacations and the clock change', () => {
  const rotationRows = fixtureSheet('ROTATION').filter((row, i) => i === 0 || i <= 3); // header and positions 1-3
  const roommateRows = fixtureSheet('ROOMMATES').filter((row, i) => i <= 3);
  const noRows = (name) => [fixtureSheet(name)[0]];
  const headers = fixtureSheet('VACATIONS')[0];
  const vacation = (record) => headers.map((header) => (header in record ? record[header] : ''));
  const ids = FIXTURES.ROOMMATES.map((r) => r.roommate_id);
  const sheets = (extra = {}) => ({ ROOMMATES: roommateRows, ROTATION: rotationRows, CLEANING_LOGS: noRows('CLEANING_LOGS'), SWAPS: noRows('SWAPS'), VACATIONS: noRows('VACATIONS'), ...extra });
  const render = (now, extra) => {
    const server = loadProject({
      properties: { ENVIRONMENT: 'DEV', SPREADSHEET_ID: DEV_SPREADSHEET_ID },
      spreadsheets: [new FakeSpreadsheet(DEV_SPREADSHEET_ID, { marker: 'DEV', sheets: sheets(extra) })],
      now: new Date(now),
    });
    const result = plain(server.get('getRotationSchedule')(asSignedIn(server)));
    const page = loadFrontend();
    page.succeed(result);
    const weekends = [...page.app.innerHTML.matchAll(/<p class="when">([^<]*)<\/p>/g)].map((m) => m[1]);
    return { result, html: page.app.innerHTML, names: comingUpNames(page.app.innerHTML), weekends };
  };

  // Plain rotation: Alex now, then Sam, Jo, Alex again: three distinct weekends, Alex in the card and again later in the list.
  const plain3 = render('2026-01-13T12:00:00Z');
  assert.equal(plain3.result.ok, true);
  assert.equal(plain3.result.current.assignee.name, 'Alex Example');
  assert.deepEqual(plain3.names, ['Sam Example', 'Jo Example', 'Alex Example']);
  assert.equal(new Set(plain3.weekends).size, 3);
  assert.doesNotMatch(textOf(plain3.html), /Your next turn|at a glance/);

  // A vacation known in advance: Sam is skipped on his weekend, so Jo and Alex follow; still three distinct weekends.
  const known = vacation({ vacation_id: 'v1', roommate_id: ids[1], start_date: new Date('2026-01-14T23:00:00Z'), return_date: new Date('2026-01-18T23:00:00Z'), created_at: new Date('2026-01-01T10:00:00Z') });
  const withVacation = render('2026-01-13T12:00:00Z', { VACATIONS: [headers, known] });
  assert.equal(withVacation.names.length, 3);
  assert.equal(new Set(withVacation.weekends).size, 3);
  assert.equal(withVacation.names[0], 'Jo Example', 'Sam is skipped');
  assert.match(textOf(withVacation.html), /Sam Example is away\./);

  // Across the October clock change the weekends stay one per week and start on a Saturday in Berlin.
  const autumn = render('2026-10-14T12:00:00Z');
  assert.equal(autumn.names.length, 3);
  assert.equal(new Set(autumn.weekends).size, 3);
  for (const weekend of autumn.weekends) assert.match(weekend, /^Sat /);
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
    'frontend/HistoryView',
    'frontend/SwapView',
    'frontend/Session',
    'frontend/LoginView',
    'frontend/AdminView',
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

test('a first visit starts in Dark, whatever the system says, and it is applied before the page renders', () => {
  const first = loadFrontend({ as: null });
  assert.equal(first.themeAtLoad, 'dark');
  assert.deepEqual(first.pressed(), { light: 'false', dark: 'true', system: 'false' });
  assert.equal(first.storage.size, 0, 'the default is not saved: it is only a starting point');
  first.setSystemDark(true);
  first.setSystemDark(false);
  assert.equal(first.theme(), 'dark', 'the default does not follow the system');

  assert.equal(loadFrontend({ systemDark: true }).themeAtLoad, 'dark');
  assert.match(read('Index.html'), /data-choice="dark" aria-pressed="true">Dark</, 'the toggle starts on Dark too');
  const index = read('Index.html');
  assert.ok(index.indexOf("include_('frontend/Theme')") < index.indexOf('<body>'));
});

test('System follows the operating system, including when it changes', () => {
  const page = loadFrontend();
  page.chooseTheme('system');
  assert.equal(page.theme(), 'light');
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
  assert.equal(invalid.themeAtLoad, 'dark', 'an unknown value counts as a first visit');
  assert.deepEqual(invalid.pressed(), { light: 'false', dark: 'true', system: 'false' });

  const savedSystem = loadFrontend({ storage: new Map([['chorenest-theme', 'system']]), systemDark: false });
  assert.equal(savedSystem.themeAtLoad, 'light', 'a saved System choice still follows the system');
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
  const inHero = page.app.innerHTML.match(/avatar avatar-lg tone-(\d)/)[1];
  const later = loadFrontend();
  later.succeed(schedule({ current: { ...turn('Jijo', 0), status: 'pending' }, upcoming: [turn('Hari', 1)] }));
  assert.equal(later.app.innerHTML.match(/avatar avatar-md tone-(\d)" aria-hidden="true">H/)[1], inHero, 'Hari has the same colour in the card and in the list');
});

test('the hero never hides overdue or vacation information', () => {
  const page = loadFrontend();
  page.succeed(
    schedule({
      current: { status: 'overdue', vacation_conflict_id: 'v' },
      upcoming: [turn('Arun', 1, { skipped: [person('Kim')] })],
    })
  );
  const hero = page.app.innerHTML.match(/<section class="card hero[\s\S]*?<\/section>/)[0];
  const text = textOf(hero);
  assert.match(hero, /is-overdue/);
  assert.match(text, /Overdue/);
  assert.match(text, /Was due End of Sunday 18 Jan 2026/);
  assert.match(text, /Hari is away, so this turn will be skipped\./);
  assert.match(textOf(page.app.innerHTML), /Kim is away\./);

  const away = loadFrontend();
  away.succeed(schedule({ current: { skipped: [person('Jijo')] } }));
  assert.match(textOf(away.app.innerHTML), /Jijo is away\./);
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
    ['dark', 'true', 'Dark'],
    ['system', 'false', 'System'],
  ]);
  for (const [file, source] of frontendSources()) {
    for (const [button] of source.matchAll(/<button\b[^>]*>/g)) {
      assert.match(
        button,
        /data-choice="|data-tab="(schedule|vacation|swaps|history)"|id="profile-button"|class="button auth-submit" type="submit"|data-action="(dismiss-beta|close-profile|sign-out|toggle-password|open-admin|admin-add|admin-retry|admin-back|admin-provision|admin-reset|admin-end-sessions|admin-disable|admin-role|admin-save-add|admin-save-provision|admin-confirm|admin-copy|admin-done|admin-close|retry|mark-cleaned|confirm-clean|cancel-clean|retry-vacations|plan-vacation|save-vacation|close-vacation|cancel-vacation|confirm-cancel-vacation|edit-vacation|end-vacation|save-edit|confirm-end-vacation|retry-history|history-range|history-prev|history-next|download-history|swap-request|swap-retry|swap-accept|swap-decline|swap-cancel|swap-send|swap-confirm|swap-close)"/,
        `${file}: ${button}`
      );
    }
    // Forms exist only on the sign-in screens, so Enter submits and password managers recognise them; they never navigate.
    assert.doesNotMatch(source, file === 'LoginView.html' ? /<(a|textarea)\b|href=|\saction=/ : /<(a|form|textarea)\b|href=/, file);
    assert.equal((source.match(/<nav\b/g) || []).length, file === 'Index.html' ? 1 : 0, file);
    // The only text controls are the vacation dates and the sign-in fields.
    for (const [input] of source.matchAll(/<input\b[^>]*>/g)) {
      const allowed = (file === 'VacationView.html' && /type="date"/.test(input)) || (file === 'LoginView.html' && /class="text-input"/.test(input)) ||
        (file === 'AdminView.html' && (/class="text-input"/.test(input) || /type="radio" name="admin-role"/.test(input)));
      assert.ok(allowed, `${file}: ${input}`);
    }
    // The only dropdowns are the two turn pickers of the swap form; there is no name picker any more.
    if (file !== 'SwapView.html') assert.doesNotMatch(source, /<select\b/, file);
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
    // Hero card, yellow and (when overdue) coral, one flat colour each: its text, the hint, the tiles and the button.
    ...['hero-bg', 'overdue-bg'].flatMap((background) => [['on-hero', background], ['on-hero-soft', background]]),
    ['hero-tile-text', 'hero-tile'], ['hero-tile-muted', 'hero-tile'],
    ['overdue-tile-text', 'overdue-tile'], ['overdue-tile-muted', 'overdue-tile'],
    ['on-hero-button', 'hero-button'],
    // Errors, the delete button and the active tab.
    ['danger-text', 'danger-bg'], ['danger-text', 'surface'], ['danger-text', 'surface-soft'], ['surface', 'danger-text'],
    ['tab-active-text', 'tab-active-bg'], ['text', 'surface'],
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

// Signing in: identity comes from the server, never from a choice on the page

const tokenOf = (page, index) => page.callArguments[index][0].token;

test('signed out, the page shows only the sign-in card and asks the server for nothing', () => {
  const page = loadFrontend({ as: null });
  assert.deepEqual(page.calls, []);
  assert.equal(page.signedIn(), false);
  assert.equal(page.authScreen.hidden, false);
  assert.equal(page.mainContent.hidden, true);
  assert.equal(page.profileButton.hidden, true);
  assert.match(textOf(page.authScreen.innerHTML), /^Welcome home Sign in to see whose turn it is\. Username Password Show Sign in Forgot your password\?/);
  assert.match(page.authScreen.innerHTML, /autocomplete="username"/);
  assert.match(page.authScreen.innerHTML, /type="password" autocomplete="current-password"/);
  assert.equal(page.authInputs['sign-in-username'].focused, 1);
  assert.doesNotMatch(page.authScreen.innerHTML, /<select|Just looking|Not verified/);
});

test('signing in sends only the username and password, locks the form while the server works, then loads with the token', () => {
  const page = loadFrontend({ as: null });
  page.authInputs['sign-in-username'].value = '  hari ';
  page.authInputs['sign-in-password'].value = 'a long enough passphrase';
  page.authSubmit('sign-in');
  page.authSubmit('sign-in'); // a second Enter while busy sends nothing
  assert.deepEqual(page.calls, ['signIn']);
  assert.deepEqual(page.callArguments[0], [{ username: 'hari', password: 'a long enough passphrase' }]);
  assert.match(textOf(page.authScreen.innerHTML), /Checking your password\. This takes a few seconds…/);
  assert.match(page.authScreen.innerHTML, /<button class="button auth-submit" type="submit" disabled>Signing in…<\/button>/);
  assert.match(page.authScreen.innerHTML, /id="sign-in-username"[^>]*disabled/);
  assert.doesNotMatch(page.authScreen.innerHTML, /a long enough passphrase/, 'the password is never written into the page');

  page.succeed({ ok: true, session: { token: 'token-new', expires_at: FAR_FUTURE }, viewer: viewerOf('Hari') });
  assert.equal(page.signedIn(), true);
  assert.equal(JSON.parse(page.storage.get(SESSION_KEY)).token, 'token-new');
  assert.deepEqual(page.calls, ['signIn', 'getRotationSchedule']);
  assert.deepEqual(page.callArguments[1], [{ token: 'token-new' }]);
  page.succeed(schedule());
  assert.equal(hasMarkButton(page.app.innerHTML), true, 'Hari, from the server, may mark Hari’s turn');
  assert.match(textOf(page.profileButton.innerHTML), /Hari Admin$/);
});

test('sign-in refusals are explained in fixed words; the username stays, the password is cleared and focused', () => {
  const cases = [
    [failure('LOGIN_FAILED'), /Check your username and password\. After several failed attempts, wait 15 minutes\./],
    [failure('TEMP_PASSWORD_EXPIRED'), /temporary password has expired\. Ask the app owner/],
    [failure('BUSY'), /busy right now/],
    [failure('SOMETHING_NEW'), /Something went wrong/],
    [{ ok: true, session: { token: 'x', expires_at: '2000-01-01T00:00:00.000Z' }, viewer: viewerOf('Hari') }, /Something went wrong/],
  ];
  for (const [result, message] of cases) {
    const page = loadFrontend({ as: null });
    page.authInputs['sign-in-username'].value = 'hari';
    page.authInputs['sign-in-password'].value = 'wrong password';
    page.authSubmit('sign-in');
    page.succeed(result);
    assert.match(textOf(page.authScreen.innerHTML), message);
    assert.doesNotMatch(page.authScreen.innerHTML, /Server detail/);
    assert.match(page.authScreen.innerHTML, /id="sign-in-username"[^>]*value="hari"/);
    assert.equal(page.authInputs['sign-in-password'].focused, 1);
    assert.equal(page.signedIn(), false);
    assert.equal(page.storage.has(SESSION_KEY), false);
  }
  const offline = loadFrontend({ as: null });
  offline.authInputs['sign-in-username'].value = 'hari';
  offline.authInputs['sign-in-password'].value = 'x';
  offline.authSubmit('sign-in');
  offline.fail();
  assert.match(textOf(offline.authScreen.innerHTML), /Couldn’t reach ChoreNest/);

  const empty = loadFrontend({ as: null });
  empty.authSubmit('sign-in');
  assert.deepEqual(empty.calls, [], 'an empty form is not sent');
  assert.match(textOf(empty.authScreen.innerHTML), /Enter your username and password\./);
});

test('the password can be shown and hidden', () => {
  const page = loadFrontend({ as: null });
  const field = page.authInputs['sign-in-password'];
  const button = Object.assign({}, { attributes: { 'data-action': 'toggle-password', 'data-target': 'sign-in-password' }, textContent: 'Show' });
  button.getAttribute = (name) => button.attributes[name] || null;
  button.setAttribute = (name, value) => { button.attributes[name] = value; };
  const click = () => page.authScreen.listeners.click({ target: button });
  click();
  assert.equal(field.type, 'text');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(button.attributes['aria-label'], 'Hide password');
  assert.equal(button.textContent, 'Hide');
  click();
  assert.equal(field.type, 'password');
  assert.equal(button.attributes['aria-label'], 'Show password');
});

test('a temporary password must be replaced before anything of the household is shown', () => {
  const page = loadFrontend({ as: null });
  page.authInputs['sign-in-username'].value = 'jijo';
  page.authInputs['sign-in-password'].value = 'TempPassw0rdXyzK';
  page.authSubmit('sign-in');
  page.succeed({ ok: true, session: { token: 'token-temp', expires_at: FAR_FUTURE }, viewer: viewerOf('Jijo', { must_change_password: true }) });
  assert.equal(page.signedIn(), false);
  assert.deepEqual(page.calls, ['signIn'], 'no household data is requested');
  assert.match(textOf(page.authScreen.innerHTML), /^Choose your own password Hi Jijo! You signed in with a temporary password\./);
  assert.equal(page.authInputs['current-password'].focused, 1);

  const fill = (current, next, repeat) => {
    page.authInputs['current-password'].value = current;
    page.authInputs['new-password'].value = next;
    page.authInputs['repeat-password'].value = repeat;
    page.authSubmit('change-password');
  };
  fill('TempPassw0rdXyzK', 'short', 'short');
  assert.match(textOf(page.authScreen.innerHTML), /needs at least 10 characters/);
  fill('TempPassw0rdXyzK', 'our cosy flat 2026', 'our cosy flat 2027');
  assert.match(textOf(page.authScreen.innerHTML), /don’t match/);
  fill('TempPassw0rdXyzK', 'TempPassw0rdXyzK', 'TempPassw0rdXyzK');
  assert.match(textOf(page.authScreen.innerHTML), /different from the temporary one/);
  fill('', 'our cosy flat 2026', 'our cosy flat 2026');
  assert.match(textOf(page.authScreen.innerHTML), /Fill in all three fields/);
  assert.deepEqual(page.calls, ['signIn'], 'mistakes are caught before asking the server');

  fill('TempPassw0rdXyzK', 'our cosy flat 2026', 'our cosy flat 2026');
  assert.deepEqual(page.callArguments[1], [{ token: 'token-temp', current_password: 'TempPassw0rdXyzK', new_password: 'our cosy flat 2026' }]);
  assert.match(textOf(page.authScreen.innerHTML), /Saving your new password\. This takes about 10 seconds…/);
  page.succeed(failure('PASSWORD_CHANGE_FAILED'));
  assert.match(textOf(page.authScreen.innerHTML), /too many attempts/);

  fill('TempPassw0rdXyzK', 'our cosy flat 2026', 'our cosy flat 2026');
  page.succeed({ ok: true, session: { token: 'token-final', expires_at: FAR_FUTURE }, viewer: viewerOf('Jijo') });
  assert.equal(page.signedIn(), true);
  assert.equal(JSON.parse(page.storage.get(SESSION_KEY)).token, 'token-final');
  assert.deepEqual(page.callArguments[page.calls.length - 1], [{ token: 'token-final' }]);
});

test('a stored session opens the app straight away, and every household call carries only the token', () => {
  const page = loadFrontend({ as: 'Hari' });
  assert.equal(page.signedIn(), true);
  assert.deepEqual(page.calls, ['getRotationSchedule']);
  page.succeed(schedule());
  assert.deepEqual(page.calls, LOADED);
  for (const [request] of page.callArguments) assert.deepEqual(request, { token: 'token-Hari' });
  page.clickMark();
  page.dialogClick('confirm-clean');
  const [request] = page.callArguments[2];
  assert.deepEqual(Object.keys(request).sort(), ['due_at', 'rotation_id', 'token']);
  assert.equal(request.token, 'token-Hari');
});

test('an expired, ended or revoked session goes back to sign-in, forgets the token and clears what was shown', () => {
  for (const code of ['UNAUTHENTICATED', 'TEMP_PASSWORD_EXPIRED']) {
    const page = loadFrontend({ as: 'Hari' });
    page.succeed(failure(code));
    assert.equal(page.signedIn(), false, code);
    assert.equal(page.storage.has(SESSION_KEY), false, code);
    assert.equal(page.app.innerHTML, '', code);
    assert.match(textOf(page.authScreen.innerHTML), code === 'UNAUTHENTICATED' ? /Your session has ended/ : /temporary password has expired/);
  }
  const old = loadFrontend({ storage: new Map([[SESSION_KEY, JSON.stringify({ token: 't', expires_at: '2000-01-01T00:00:00.000Z' })]]) });
  assert.deepEqual(old.calls, [], 'an expired session is not even tried');
  assert.equal(old.signedIn(), false);
  const junk = loadFrontend({ storage: new Map([[SESSION_KEY, '{not json']]) });
  assert.equal(junk.signedIn(), false);

  const required = loadFrontend({ as: 'Jijo' });
  required.succeed(failure('PASSWORD_CHANGE_REQUIRED'));
  assert.match(textOf(required.authScreen.innerHTML), /^Choose your own password/);
  assert.equal(required.storage.has(SESSION_KEY), true, 'the session stays: it is needed for the change');
});

test('a session that ends during a save goes back to sign-in instead of showing an error, and late answers are ignored', () => {
  const page = loadFrontend({ as: 'Hari' });
  page.succeed(schedule());
  page.clickMark();
  page.dialogClick('confirm-clean');
  page.succeed(failure('UNAUTHENTICATED'));
  assert.equal(page.signedIn(), false);
  assert.equal(page.dialog.open, false);

  const late = loadFrontend({ as: 'Hari' });
  late.profileClick('sign-out'); // signed out before the schedule arrived
  late.succeedCall(0, schedule());
  assert.equal(late.app.innerHTML, '', 'an answer for the previous session is dropped');
  assert.equal(late.signedIn(), false);
});

test('signing out forgets the session here at once, tells the server, and clears the page for the next person', () => {
  const page = loadFrontend({ as: 'Hari' });
  page.succeed(schedule());
  page.succeed(vacationList(vacationItem('Hari')));
  page.openProfile();
  page.profileClick('sign-out');
  assert.equal(page.signedIn(), false);
  assert.equal(page.profileDialog.open, false);
  assert.equal(page.storage.has(SESSION_KEY), false);
  assert.equal(page.app.innerHTML, '');
  assert.equal(page.panels.vacation.innerHTML, '');
  assert.equal(page.profileButton.innerHTML, '');
  assert.match(textOf(page.authScreen.innerHTML), /You’re signed out\./);
  assert.equal(page.calls[page.calls.length - 1], 'signOut');
  assert.deepEqual(page.callArguments[page.calls.length - 1], [{ token: 'token-Hari' }]);
});

test('the old unverified name pick is removed from the device and plays no part', () => {
  const storage = new Map([['chorenest-roommate', 'id-Hari']]);
  const page = loadFrontend({ storage, as: 'Jijo' });
  assert.equal(storage.has('chorenest-roommate'), false);
  page.succeed(schedule());
  assert.equal(hasMarkButton(page.app.innerHTML), false, 'Jijo is signed in, whatever was picked before');
});

test('the page code holds no identity of its own: no picker, no roommate id in any request', () => {
  for (const file of ['App.html', 'Shell.html', 'ScheduleView.html', 'VacationView.html', 'Session.html', 'LoginView.html']) {
    const source = read(file);
    assert.doesNotMatch(source, /who-select|select-roommate|Just looking|Not verified|Pick your name|UNVERIFIED|TRUST_NOTE/, file);
    assert.doesNotMatch(source, /roommate_id:\s*selected|roommate_id:\s*viewer/, file);
  }
  assert.equal(fs.existsSync(path.join(FRONTEND_DIR, 'Identity.html')), false);
});

// Slice 04D polish

test('no page uses emojis: notes carry hidden line icons, and later turns form a list', () => {
  const page = loadFrontend();
  page.succeed(
    schedule({
      current: { owner: person('Jijo'), assignee: person('Hari'), vacation_conflict_id: 'v' },
      upcoming: [turn('Arun', 1, { skipped: [person('Kim')] }), turn('Kim', 2), turn('Hari', 3)],
      roommates: [person('Arun'), person('Hari'), person('Jijo'), person('Kim')],
    })
  );
  const html = page.app.innerHTML;
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u, 'no emojis');
  const notes = [...html.matchAll(/<p class="note"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/g)];
  assert.ok(notes.length >= 3, 'the swap and away notes each start with a hidden icon');
  for (const [svg] of html.matchAll(/<svg\b[^>]*>/g)) assert.match(svg, /aria-hidden="true" focusable="false"/, svg);
  for (const [file, source] of frontendSources()) assert.doesNotMatch(source, /\p{Extended_Pictographic}/u, `${file}: no emojis anywhere`);

  assert.equal(html.match(/<ol class="timeline">/g).length, 1);
  const names = [...html.matchAll(/<li class="timeline-item">[\s\S]*?class="name">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(names, ['Arun', 'Kim', 'Hari']);
  assert.doesNotMatch(html, /turn-card/);

  const overdue = loadFrontend();
  overdue.succeed(schedule({ current: { status: 'overdue' } }));
  assert.doesNotMatch(overdue.app.innerHTML, /\p{Extended_Pictographic}/u);
});

test('hover effects are limited to hover-capable devices, and keyboard focus is always visible', () => {
  const css = read('Styles.html');
  const hover = blockAt(css, css.indexOf('@media (hover: hover)'));
  assert.match(hover, /:hover/);
  assert.doesNotMatch(css.replace(hover, ''), /:hover/);
  for (const selector of ['.theme-toggle button:focus-visible', '.button:focus-visible', '.text-input:focus-visible', '.password-toggle:focus-visible', '.link-button:focus-visible', '.tab:focus-visible', '.profile:focus-visible']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /\.button:active/);
});

// Marking the turn as cleaned

const HARI = 'Hari';
const hasMarkButton = (html) => /data-action="mark-cleaned"/.test(html);
const withHari = (payload = schedule(), as = HARI) => {
  const page = loadFrontend({ as });
  page.succeed(payload);
  return page;
};

test('the button is offered only to the signed-in assignee, and only on their open turn', () => {
  assert.equal(hasMarkButton(withHari(schedule(), 'Jijo').app.innerHTML), false, 'not the assignee');
  assert.equal(hasMarkButton(withHari(schedule(), 'Gone').app.innerHTML), false, 'not in the roster');
  assert.equal(hasMarkButton(withHari().app.innerHTML), true);
  assert.equal(hasMarkButton(withHari(schedule({ current: { status: 'overdue' } })).app.innerHTML), true, 'overdue turns can be completed');
  assert.equal(hasMarkButton(withHari(schedule({ current: { status: 'waiting' } })).app.innerHTML), false, 'not open yet');
  assert.doesNotMatch(withHari(schedule(), 'Jijo').app.innerHTML, /Pick your name|open-profile|hero-hint/, 'no hint to become someone else');
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
  assert.deepEqual(page.calls, LOADED, 'nothing is sent yet');

  page.dialogClick('cancel-clean');
  assert.equal(page.dialog.open, false);
  assert.deepEqual(page.calls, LOADED);
});

test('confirming sends exactly the turn the page showed, ignores duplicate clicks, then shows a banner and refreshes', () => {
  const page = withHari();
  page.clickMark();
  page.dialogClick('confirm-clean');
  page.dialogClick('confirm-clean');
  page.dialogClick('confirm-clean');
  assert.deepEqual(page.calls, [...LOADED, 'markCleaned'], 'one request, however often it is clicked');
  assert.deepEqual(plain(page.callArguments[2]), [{ token: 'token-Hari', rotation_id: 'slot-Hari', due_at: turn('Hari', 0).due_at }]);
  assert.match(textOf(page.dialog.innerHTML), /Saving…/);
  assert.doesNotMatch(page.dialog.innerHTML, /<button/);
  page.clickMark();
  assert.equal(page.callArguments.length, 3, 'the button cannot start a second save while one is running');

  page.succeed({ ok: true, completed_at: '2026-01-14T12:00:00.000Z' });
  assert.equal(page.dialog.open, false);
  assert.deepEqual(page.calls, [...LOADED, 'markCleaned', 'getRotationSchedule'], 'the schedule is reloaded, the vacations are not');
  assert.match(page.app.innerHTML, /Loading schedule/);

  page.succeed(schedule({ current: turn('Jijo', 1) }));
  const html = page.app.innerHTML;
  assert.match(html, /<p class="notice notice-success" role="status">Nice work, Hari! Entire Home is marked as cleaned\.<\/p>/);
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
    assert.deepEqual(page.calls, [...LOADED, 'markCleaned', 'getRotationSchedule'], code);
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
    assert.deepEqual(page.calls, [...LOADED, 'markCleaned', 'getRotationSchedule']);
    page.succeed(schedule());
    assert.match(page.app.innerHTML, /<p class="notice notice-info" role="status">We couldn’t confirm that it saved\. Check the schedule below before trying again\.<\/p>/);
  }
});

test('names in the dialog and the banner are escaped', () => {
  const hostile = person('<b onmouseover=alert(1)>Hari</b>', 'id-Hari');
  const page = loadFrontend({ as: HARI });
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

// Vacations: an inline household overview on the Vacation tab, and "Who's away" on the Schedule (trust-based, interim)

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
const DAY_MS = 24 * 60 * 60 * 1000;
const isoIn = (days) => new Date(Date.now() + days * DAY_MS).toISOString();

/** A page with the schedule and the vacation list answered (index 0 and 1 of the pending calls). */
function loadedVacations(list = vacationList(), as = HARI) {
  const page = withHari(schedule(), as);
  page.succeedCall(1, list);
  return page;
}
const panelText = (page) => textOf(page.panels.vacation.innerHTML);
const dialogText = (page) => textOf(page.vacationDialog.innerHTML);
const berlinToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const SAVED = { ok: true, vacation_id: 'new-id' };

test('vacations load once, right after the first schedule answer, for the Vacation tab and "Who’s away"', () => {
  const page = loadFrontend({ as: HARI });
  assert.deepEqual(page.calls, ['getRotationSchedule'], 'the schedule is asked for first');
  assert.match(panelText(page), /Loading vacations…/);

  page.succeed(schedule());
  assert.deepEqual(page.calls, LOADED);
  assert.deepEqual(plain(page.callArguments[1]), [{ token: 'token-Hari' }], 'listing sends only the session');
  assert.match(textOf(page.app.innerHTML), /Who’s away Checking vacations…/);
  const schedulePage = page.app.innerHTML;

  page.succeedCall(1, vacationList(vacationItem('Arun', { state: 'away' })));
  assert.match(panelText(page), /Away now Arun Away now/);
  assert.match(textOf(page.awaySlot.innerHTML), /^Who’s away Arun Away · back Mon 12 Jan$/);
  assert.equal(page.app.innerHTML, schedulePage, 'only the "Who’s away" slot changes: the picker keeps focus and the turns stay as they are');

  for (const tab of ['vacation', 'schedule', 'vacation']) page.tabClick(tab);
  assert.deepEqual(page.calls, LOADED, 'a recent list is kept');
});

test('compact cards show name, status and Berlin dates; the cleaning impact is folded away', () => {
  const page = loadedVacations(vacationList(
    vacationItem('Jijo'),
    vacationItem('Arun', {
      state: 'away',
      cancellable: false,
      weekends: [
        { weekend_starts_at: '2026-01-16T23:00:00.000Z', due_at: '2026-01-18T23:00:00.000Z', status: 'not_their_turn' },
        { weekend_starts_at: '2026-06-05T22:00:00.000Z', due_at: '2026-06-07T22:00:00.000Z', status: 'later' },
      ],
    }),
    // Across the March clock change: away Sunday 29 March, back Wednesday 1 April (summer time).
    vacationItem('Kim', { state: 'returned', cancellable: false, start_date: '2026-03-28T23:00:00.000Z', return_date: '2026-03-31T22:00:00.000Z', weekends: [] }),
    vacationItem('Hari', {
      state: 'returned',
      cancellable: false,
      start_date: '2026-04-02T22:00:00.000Z',
      return_date: '2026-04-06T22:00:00.000Z',
      weekends: [{ weekend_starts_at: '2026-04-03T22:00:00.000Z', due_at: '2026-04-05T22:00:00.000Z', status: 'past' }],
    })
  ));
  const html = page.panels.vacation.innerHTML;
  const text = panelText(page);
  assert.match(text, /^Vacations Away on your weekend\? That turn is skipped, with no make-up turn\. Plan vacation /);
  assert.match(text, /Away now Arun Away now First day away Fri 9 Jan First day back Mon 12 Jan Cleaning impact Sat 17 – Sun 18 Jan · No turn that weekend Sat 6 – Sun 7 Jun · Not scheduled yet/);
  assert.match(text, /Upcoming Jijo Upcoming First day away Fri 9 Jan First day back Mon 12 Jan Cleaning impact · 1 turn skipped Sat 10 – Sun 11 Jan · Turn skipped/);
  assert.match(text, /Recently back Hari Returned First day away Fri 3 Apr First day back Tue 7 Apr Cleaning impact Sat 4 – Sun 5 Apr · Past weekend Kim Returned First day away Sun 29 Mar First day back Wed 1 Apr/, 'latest return first');
  assert.ok(text.indexOf('Away now Arun') < text.indexOf('Upcoming Jijo') && text.indexOf('Upcoming Jijo') < text.indexOf('Recently back'));
  assert.equal((html.match(/<details class="impact"><summary>/g) || []).length, 3, 'folded (no "open" attribute), and left out when no weekend is touched');
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /<span class="badge badge-away">Away now<\/span>/);
  assert.match(html, /class="chip chip-skipped"/);
  assert.doesNotMatch(text, /name picked|isn’t a login|Not verified/);
});

test('"Who’s away" shows who is away now and who leaves within two weeks, and nothing else', () => {
  const page = loadedVacations(vacationList(
    vacationItem('Arun', { state: 'away', return_date: isoIn(5) }),
    vacationItem('Jijo', { start_date: isoIn(3), return_date: isoIn(9) }),
    vacationItem('Kim', { start_date: isoIn(30), return_date: isoIn(40) }),
    vacationItem('Hari', { state: 'returned', start_date: isoIn(-9), return_date: isoIn(-2) })
  ));
  const text = textOf(page.awaySlot.innerHTML);
  assert.match(text, /^Who’s away Arun Away · back \w{3} \d{1,2} \w{3} Jijo Leaves \w{3} \d{1,2} \w{3}$/);
  assert.doesNotMatch(text, /Kim|Hari/);
  assert.doesNotMatch(page.awaySlot.innerHTML, /<button/, 'information only');

  const empty = loadedVacations(vacationList(vacationItem('Kim', { start_date: isoIn(30), return_date: isoIn(40) })));
  assert.equal(textOf(empty.awaySlot.innerHTML), 'Who’s away Everyone’s home.');
});

test('loading, empty, server problem, malformed answer and network failure each have a clear state, and Try again reloads', () => {
  assert.match(panelText(loadedVacations(vacationList())), /Everyone’s home No vacations planned\. The dust bunnies are outnumbered\./);

  for (const [answer, pattern] of [
    [{ ok: false, error: { code: 'DATABASE_NOT_SET_UP', message: 'Server detail secret' } }, /Couldn’t load vacations Try again in a moment\./],
    [undefined, /Couldn’t load vacations Try again in a moment\./],
    [{ ok: true }, /Couldn’t load vacations/],
    [{ ok: true, vacations: [{ name: 'x' }] }, /Couldn’t load vacations/],
    ['network', /Couldn’t load vacations Check your connection and try again\./],
  ]) {
    const page = withHari();
    if (answer === 'network') page.failCall(1);
    else page.succeedCall(1, answer);
    assert.match(panelText(page), pattern);
    assert.match(textOf(page.awaySlot.innerHTML), /Couldn’t load vacations\. Try again/, 'the schedule says so too');
    assert.doesNotMatch(page.panels.vacation.innerHTML + page.awaySlot.innerHTML, /secret|DATABASE/);
    assert.match(textOf(page.app.innerHTML), /Current turn Pending Hari/, 'the schedule still works');

    page.panelClick('retry-vacations');
    assert.deepEqual(page.calls, [...LOADED, 'listVacations']);
    assert.match(panelText(page), /Loading vacations…/);
    page.clickApp('retry-vacations');
    assert.deepEqual(page.calls.slice(-1), ['listVacations'], 'Try again works from "Who’s away" too');
  }
});

test('a schedule error still loads the vacations, and the tab works on its own', () => {
  const page = loadFrontend({ as: HARI });
  page.fail();
  assert.deepEqual(page.calls, LOADED);
  page.succeedCall(1, vacationList(vacationItem('Jijo')));
  assert.match(panelText(page), /Upcoming Jijo/);
  assert.doesNotMatch(panelText(page), /Pick your name/);
  assert.doesNotMatch(page.panels.vacation.innerHTML, /plan-vacation/, 'until the server has said who is signed in, nothing can be planned');
});

test('Plan vacation is offered to every signed-in roommate', () => {
  for (const as of ['Hari', 'Jijo']) {
    const page = loadedVacations(vacationList(), as);
    assert.deepEqual(page.panels.vacation.innerHTML.match(/<button[^>]*>/g), ['<button class="button" type="button" data-action="plan-vacation">']);
    page.tabClick('vacation');
    page.panelClick('plan-vacation');
    assert.equal(page.vacationDialog.open, true);
    assert.match(dialogText(page), new RegExp('Plan a vacation for ' + as));
  }
});

test('only your own vacation offers actions: Delete when the server allows it, Edit dates while upcoming or away, and I’m back while away', () => {
  const list = vacationList(
    vacationItem('Hari'),
    vacationItem('Hari', { vacation_id: 'v-used', cancellable: false }),
    vacationItem('Hari', { vacation_id: 'v-away', state: 'away', cancellable: false }),
    vacationItem('Hari', { vacation_id: 'v-away-free', state: 'away', cancellable: true }),
    vacationItem('Hari', { vacation_id: 'v-back', state: 'returned', cancellable: false }),
    vacationItem('Hari', { vacation_id: 'v-back-free', state: 'returned', cancellable: true }),
    vacationItem('Hari', { vacation_id: null, state: 'upcoming', cancellable: true }),
    vacationItem('Jijo'),
    vacationItem('Jijo', { vacation_id: 'v-jijo-away', state: 'away', cancellable: true })
  );
  const page = loadedVacations(list);
  const html = page.panels.vacation.innerHTML;
  const actions = [...html.matchAll(/data-action="(cancel-vacation|edit-vacation|end-vacation)" data-vacation-id="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(actions, [
    ['end-vacation', 'v-away'], ['edit-vacation', 'v-away'],
    ['end-vacation', 'v-away-free'], ['edit-vacation', 'v-away-free'], ['cancel-vacation', 'v-away-free'],
    ['edit-vacation', 'v-Hari'], ['cancel-vacation', 'v-Hari'],
    ['edit-vacation', 'v-used'],
    ['cancel-vacation', 'v-back-free'],
  ], 'Delete only where the server said it is safe; nothing for hand-typed rows without an ID, or anyone else');
  assert.match(html, /data-action="cancel-vacation" data-vacation-id="v-Hari" aria-label="Delete vacation">/);
  assert.doesNotMatch(html, / disabled/);

  page.panelClick('cancel-vacation', { 'data-vacation-id': 'v-used' });
  page.panelClick('cancel-vacation', { 'data-vacation-id': 'v-jijo-away' });
  assert.equal(page.vacationDialog.open, false, 'a vacation the server marked unsafe, or someone else’s, opens nothing');
  page.panelClick('cancel-vacation', { 'data-vacation-id': 'v-back-free' });
  assert.match(dialogText(page), /^Delete this vacation\? Hari: .*It leaves the list\. The cleaning history stays as it is\./);
  page.vacationClick('close-vacation');

  page.panelClick('edit-vacation', { 'data-vacation-id': 'v-Jijo' });
  page.panelClick('end-vacation', { 'data-vacation-id': 'v-Hari' });
  page.panelClick('edit-vacation', { 'data-vacation-id': 'v-back' });
  assert.equal(page.vacationDialog.open, false, 'foreign, not-started and finished vacations open nothing');
  assert.deepEqual(page.calls, LOADED);

  const other = loadedVacations(list, 'Arun');
  assert.doesNotMatch(other.panels.vacation.innerHTML, /cancel-vacation|edit-vacation|end-vacation/, 'someone else sees no actions on these');
});

test('Edit dates opens a form filled with the Berlin dates; a started vacation keeps its first day away', () => {
  // 25 Oct is the October clock change: midnight Berlin is 22:00Z before it and 23:00Z after.
  const upcoming = vacationItem('Hari', { start_date: '2026-10-23T22:00:00.000Z', return_date: '2026-10-26T23:00:00.000Z' });
  const page = loadedVacations(vacationList(upcoming));
  page.panelClick('edit-vacation', { 'data-vacation-id': 'v-Hari' });
  assert.equal(page.vacationDialog.open, true);
  const html = page.vacationDialog.innerHTML;
  assert.match(textOf(html), /^Change your vacation dates /);
  assert.ok(html.includes(`id="vacation-start" type="date" min="${berlinToday()}" value="2026-10-24">`), 'Saturday 24 Oct');
  assert.ok(html.includes(`id="vacation-return" type="date" min="${berlinToday()}" value="2026-10-27">`), 'Tuesday 27 Oct');
  assert.match(textOf(html), /If a change would affect them, ask the app owner\./);
  assert.doesNotMatch(textOf(html), /isn’t a login|name picked/);
  assert.deepEqual(page.calls, LOADED, 'opening the form asks the server nothing');

  const away = loadedVacations(vacationList(vacationItem('Hari', { state: 'away', cancellable: false })));
  away.panelClick('edit-vacation', { 'data-vacation-id': 'v-Hari' });
  assert.match(away.vacationDialog.innerHTML, /id="vacation-start" type="date" min="[^"]*" value="2026-01-09" disabled aria-describedby="vacation-start-note">/);
  assert.match(textOf(away.vacationDialog.innerHTML), /Your vacation has started, so the first day away stays\./);
});

test('saving an edit sends the new dates and the dates the page showed, once, then refreshes without blanking the schedule', () => {
  const page = loadedVacations(vacationList(vacationItem('Hari')));
  const schedulePage = page.app.innerHTML;
  page.panelClick('edit-vacation', { 'data-vacation-id': 'v-Hari' });
  page.setDates('2026-01-10', '2026-01-14');
  page.vacationClick('save-edit');
  page.vacationClick('save-edit');
  page.vacationClick('close-vacation');
  assert.deepEqual(page.calls, [...LOADED, 'updateVacation']);
  assert.deepEqual(plain(page.callArguments[2]), [{
    token: 'token-Hari', vacation_id: 'v-Hari', start_date: '2026-01-10', return_date: '2026-01-14',
    seen_start: '2026-01-08T23:00:00.000Z', seen_return: '2026-01-11T23:00:00.000Z',
  }]);
  assert.match(dialogText(page), /Saving…/);
  assert.equal(page.vacationDialog.open, true, 'the dialog stays while saving');

  page.succeedCall(2, { ok: true, changed: true });
  assert.equal(page.vacationDialog.open, false);
  assert.deepEqual(page.calls.slice(3), ['getRotationSchedule', 'listVacations']);
  assert.equal(page.app.innerHTML, schedulePage, 'the schedule stays on screen while it refreshes');
  assert.doesNotMatch(page.app.innerHTML, /Loading schedule/);
  assert.match(panelText(page), /Vacation dates updated\./);

  page.succeedCall(3, schedule({ current: turn('Jijo', 1) }));
  assert.match(textOf(page.app.innerHTML), /Current turn Pending Jijo/);
  assert.equal(page.panels.schedule.attributes['data-settled'], 'true', 'updated in place, without replaying the entrance');
  page.succeedCall(4, vacationList(vacationItem('Hari', { start_date: '2026-01-09T23:00:00.000Z', return_date: '2026-01-13T23:00:00.000Z' })));
  assert.match(panelText(page), /First day away Sat 10 Jan First day back Wed 14 Jan/);

  const same = loadedVacations(vacationList(vacationItem('Hari')));
  same.panelClick('edit-vacation', { 'data-vacation-id': 'v-Hari' });
  same.setDates('2026-01-09', '2026-01-12');
  same.vacationClick('save-edit');
  same.succeedCall(2, { ok: true, changed: false });
  assert.match(panelText(same), /Nothing changed: those are already the dates\./);
});

test('a quiet refresh that fails keeps the current schedule on screen', () => {
  const page = loadedVacations(vacationList(vacationItem('Hari')));
  const schedulePage = page.app.innerHTML;
  page.panelClick('edit-vacation', { 'data-vacation-id': 'v-Hari' });
  page.setDates('2026-01-10', '2026-01-14');
  page.vacationClick('save-edit');
  page.succeedCall(2, { ok: true, changed: true });
  page.failCall(3);
  assert.equal(page.app.innerHTML, schedulePage);
  page.succeedCall(3, { ok: false, error: { code: 'INTERNAL_ERROR' } });
  assert.equal(page.app.innerHTML, schedulePage, 'an error answer does not replace a good schedule either');
});

test('edit mistakes are caught before asking the server, and refusals keep the form with a plain reason', () => {
  const page = loadedVacations(vacationList(vacationItem('Hari')));
  page.panelClick('edit-vacation', { 'data-vacation-id': 'v-Hari' });
  page.setDates('2026-01-12', '2026-01-12');
  page.vacationClick('save-edit');
  assert.match(page.vacationDialog.innerHTML, /<p class="form-error" role="alert">The first day back must be after the first day away\.<\/p>/);
  page.setDates('', '2026-01-12');
  page.vacationClick('save-edit');
  assert.match(dialogText(page), /Pick both dates\./);
  assert.deepEqual(page.calls, LOADED);

  const codes = {
    VACATION_TURN_CONFLICT: /would affect the current cleaning turn.*Ask the app owner/,
    VACATION_SKIP_RECORDED: /already skipped for this vacation.*Ask the app owner/,
    VACATION_START_LOCKED: /keeps its first day away/,
    VACATION_BACK_IN_PAST: /first day back can’t be in the past/,
    VACATION_IN_PAST: /can’t be in the past/,
    VACATION_OVERLAP: /already a vacation on those dates/,
    VACATION_DATES_INVALID: /real dates/,
    BUSY: /Someone else is saving/,
    SOMETHING_NEW: /Something went wrong, so nothing was saved/,
  };
  for (const [code, pattern] of Object.entries(codes)) {
    const edit = loadedVacations(vacationList(vacationItem('Hari')));
    edit.panelClick('edit-vacation', { 'data-vacation-id': 'v-Hari' });
    edit.setDates('2026-01-10', '2026-01-14');
    edit.vacationClick('save-edit');
    edit.succeedCall(2, { ok: false, error: { code, message: 'Server detail 1AbC-secret' } });
    assert.equal(edit.vacationDialog.open, true, code);
    assert.match(dialogText(edit), pattern, code);
    assert.ok(edit.vacationDialog.innerHTML.includes('value="2026-01-10"') && edit.vacationDialog.innerHTML.includes('value="2026-01-14"'), `${code}: the typed dates stay`);
    assert.doesNotMatch(edit.vacationDialog.innerHTML, /secret|Server detail/, code);
    assert.deepEqual(edit.calls, [...LOADED, 'updateVacation'], `${code}: nothing is reloaded`);
  }
});

test('a stale edit closes the form and shows the latest list with the reason', () => {
  for (const code of ['VACATION_CHANGED', 'VACATION_NOT_FOUND', 'VACATION_ENDED', 'NOT_YOUR_VACATION']) {
    const page = loadedVacations(vacationList(vacationItem('Hari')));
    page.panelClick('edit-vacation', { 'data-vacation-id': 'v-Hari' });
    page.setDates('2026-01-10', '2026-01-14');
    page.vacationClick('save-edit');
    page.succeedCall(2, { ok: false, error: { code } });
    assert.equal(page.vacationDialog.open, false, code);
    assert.deepEqual(page.calls.slice(3), ['listVacations'], `${code}: only the list is reloaded`);
    page.succeedCall(3, vacationList(vacationItem('Hari')));
    assert.match(page.panels.vacation.innerHTML, /<p class="notice notice-error" role="alert">/, code);
  }
  const page = loadedVacations(vacationList(vacationItem('Hari')));
  page.panelClick('edit-vacation', { 'data-vacation-id': 'v-Hari' });
  page.setDates('2026-01-10', '2026-01-14');
  page.vacationClick('save-edit');
  page.failCall(2);
  assert.match(panelText(page), /We couldn’t confirm that it saved/);
});

test('I’m back asks first, sends the vacation and the dates the page showed once, then refreshes both views', () => {
  const away = vacationItem('Hari', { state: 'away', cancellable: false });
  const page = loadedVacations(vacationList(away));
  page.panelClick('end-vacation', { 'data-vacation-id': 'v-Hari' });
  assert.equal(page.vacationDialog.open, true);
  assert.match(dialogText(page), /Back already\? Today, \w{3} \d{1,2} \w{3}, becomes your first day back\. Turns from today on count for you again\./);
  assert.match(page.vacationDialog.innerHTML, /data-action="close-vacation" autofocus>Not yet</, 'the safe choice has focus');
  page.vacationClick('close-vacation');
  assert.deepEqual(page.calls, LOADED, 'Not yet sends nothing');

  page.panelClick('end-vacation', { 'data-vacation-id': 'v-Hari' });
  page.vacationClick('confirm-end-vacation');
  page.vacationClick('confirm-end-vacation');
  assert.deepEqual(page.calls, [...LOADED, 'endVacation']);
  assert.deepEqual(plain(page.callArguments[2]), [{ token: 'token-Hari', vacation_id: 'v-Hari', seen_start: away.start_date, seen_return: away.return_date }]);
  page.succeedCall(2, { ok: true, changed: true });
  assert.equal(page.vacationDialog.open, false);
  assert.deepEqual(page.calls.slice(3), ['getRotationSchedule', 'listVacations']);
  assert.doesNotMatch(page.app.innerHTML, /Loading schedule/);
  assert.match(panelText(page), /Welcome back! Today is your first day back\./);

  // A turn that is already processed can't be changed: the reason stays in the dialog, and nothing is reloaded.
  for (const [code, pattern] of [
    ['VACATION_TURN_CONFLICT', /would affect the current cleaning turn.*Ask the app owner/],
    ['VACATION_SKIP_RECORDED', /already skipped for this vacation.*Ask the app owner/],
    ['VACATION_JUST_STARTED', /started today/],
    ['BUSY', /Someone else is saving/],
  ]) {
    const refused = loadedVacations(vacationList(away));
    refused.panelClick('end-vacation', { 'data-vacation-id': 'v-Hari' });
    refused.vacationClick('confirm-end-vacation');
    refused.succeedCall(2, { ok: false, error: { code, message: 'secret' } });
    assert.equal(refused.vacationDialog.open, true, code);
    assert.match(dialogText(refused), new RegExp('Your vacation wasn’t changed .*' + pattern.source), code);
    assert.match(refused.vacationDialog.innerHTML, /<p class="form-error" role="alert">/, code);
    assert.doesNotMatch(refused.vacationDialog.innerHTML, /secret/, code);
    assert.deepEqual(refused.calls, [...LOADED, 'endVacation'], `${code}: nothing is reloaded`);
    refused.vacationClick('close-vacation');
    assert.equal(refused.vacationDialog.open, false, code);
  }
  // A page that is out of date closes the dialog and shows the latest list.
  const stale = loadedVacations(vacationList(away));
  stale.panelClick('end-vacation', { 'data-vacation-id': 'v-Hari' });
  stale.vacationClick('confirm-end-vacation');
  stale.succeedCall(2, { ok: false, error: { code: 'VACATION_CHANGED' } });
  assert.equal(stale.vacationDialog.open, false);
  stale.succeedCall(3, vacationList(away));
  assert.match(panelText(stale), /changed since you loaded it/);
});

test('the form asks for the first day away and the first day back, with today as the earliest date', () => {
  const page = loadedVacations();
  page.panelClick('plan-vacation');
  assert.equal(page.vacationDialog.open, true);
  const html = page.vacationDialog.innerHTML;
  assert.match(textOf(html), /Plan a vacation for Hari/);
  assert.match(html, /<label for="vacation-start">First day away<\/label>/);
  assert.match(html, /<label for="vacation-return">First day back<\/label>/);
  assert.equal([...html.matchAll(/type="date" min="([^"]*)"/g)].map((m) => m[1]).join(), `${berlinToday()},${berlinToday()}`);
  assert.doesNotMatch(textOf(html), /isn’t a login|name picked/);
  assert.match(textOf(html), /The first day back is the first day you can clean again\./);
  assert.deepEqual(page.calls, LOADED, 'opening the form asks the server nothing');
});

test('form mistakes are caught before asking the server, and the typed dates are kept', () => {
  const page = loadedVacations();
  page.panelClick('plan-vacation');
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
  assert.deepEqual(page.calls, LOADED);
});

test('saving sends exactly the picked roommate and two dates, ignores double clicks, then closes and refreshes both views', () => {
  const page = loadedVacations();
  page.panelClick('plan-vacation');
  page.setDates('2026-01-09', '2026-01-12');
  page.vacationClick('save-vacation');
  page.vacationClick('save-vacation');
  page.vacationClick('close-vacation');
  assert.deepEqual(page.calls, [...LOADED, 'saveVacation'], 'one request however often it is clicked');
  assert.deepEqual(plain(page.callArguments[2]), [{ token: 'token-Hari', start_date: '2026-01-09', return_date: '2026-01-12' }]);
  assert.match(dialogText(page), /Saving…/);
  assert.equal(page.vacationDialog.open, true, 'the dialog stays while saving');
  assert.doesNotMatch(page.vacationDialog.innerHTML, /<button/);

  page.succeedCall(2, SAVED);
  assert.equal(page.vacationDialog.open, false);
  assert.deepEqual(page.calls.slice(3), ['getRotationSchedule', 'listVacations'], 'the schedule and the list are reloaded');
  assert.match(panelText(page), /Vacation saved\. Your turns while you are away are skipped\./, 'the old list stays visible meanwhile');
  page.succeedCall(3, schedule({ current: turn('Jijo', 1) }));
  assert.match(textOf(page.app.innerHTML), /Current turn Pending Jijo/);
  page.succeedCall(4, vacationList(vacationItem('Hari')));
  assert.match(page.panels.vacation.innerHTML, /<p class="notice notice-success" role="status">/);
  assert.match(panelText(page), /Upcoming Hari Upcoming First day away Fri 9 Jan First day back Mon 12 Jan/);
  assert.deepEqual(page.calls.slice(5), [], 'nothing else is loaded');
});

test('every refusal is explained in plain words, nothing leaks, and the typed dates stay in the form', () => {
  const codes = {
    VACATION_DATES_INVALID: /real dates/, VACATION_IN_PAST: /can’t be in the past/, VACATION_ORDER: /must be after the first day away/, VACATION_TOO_LONG: /at most 120 days/,
    VACATION_TOO_FAR: /at most a year ahead/, VACATION_OVERLAP: /already a vacation on those dates/, VACATION_LIMIT: /Too many vacations/, UNKNOWN_ROOMMATE: /isn’t on the list/,
    BUSY: /Someone else is saving/, WRITE_FAILED: /Nothing was recorded/, INVALID_REQUEST: /Something went wrong, so nothing was saved/, SOMETHING_NEW: /Something went wrong, so nothing was saved/,
  };
  for (const [code, pattern] of Object.entries(codes)) {
    const page = loadedVacations();
    page.panelClick('plan-vacation');
    page.setDates('2026-01-09', '2026-01-12');
    page.vacationClick('save-vacation');
    page.succeedCall(2, { ok: false, error: { code, message: 'Server detail 1AbC-secret' } });
    assert.equal(page.vacationDialog.open, true, code);
    assert.match(dialogText(page), pattern, code);
    assert.doesNotMatch(page.vacationDialog.innerHTML, /secret|Server detail/, code);
    assert.ok(page.vacationDialog.innerHTML.includes('value="2026-01-09"') && page.vacationDialog.innerHTML.includes('value="2026-01-12"'), code);
    assert.deepEqual(page.calls, [...LOADED, 'saveVacation'], `${code}: nothing was saved, so nothing is reloaded`);
    page.vacationClick('save-vacation');
    assert.equal(page.calls.filter((c) => c === 'saveVacation').length, 2, 'the form can be fixed and sent again');
  }
});

test('if the answer never arrives or makes no sense, the list is reloaded with a note that the save is unconfirmed', () => {
  for (const answer of ['network', undefined, null, {}, 'ok']) {
    const page = loadedVacations();
    page.panelClick('plan-vacation');
    page.setDates('2026-01-09', '2026-01-12');
    page.vacationClick('save-vacation');
    if (answer === 'network') page.failCall(2);
    else page.succeedCall(2, answer);
    assert.equal(page.vacationDialog.open, false);
    assert.deepEqual(page.calls.slice(3), ['listVacations'], 'only the list is checked');
    page.succeedCall(3, vacationList());
    assert.match(page.panels.vacation.innerHTML, /<p class="notice notice-info" role="status">We couldn’t confirm that it saved\. Check the list before trying again\.<\/p>/);
  }
});

test('deleting asks first, sends exactly the roommate and vacation once, then refreshes', () => {
  const page = loadedVacations(vacationList(vacationItem('Hari')));
  page.panelClick('cancel-vacation', { 'data-vacation-id': 'v-Hari' });
  assert.equal(page.vacationDialog.open, true);
  assert.match(dialogText(page), /Delete this vacation\? Hari: Fri 9 Jan – back Mon 12 Jan\. Your turns in that time count again\. Delete vacation Keep it/);
  assert.match(page.vacationDialog.innerHTML, /data-action="close-vacation" autofocus>Keep it</, 'the safe choice has focus');
  page.vacationClick('close-vacation');
  assert.equal(page.vacationDialog.open, false);
  assert.deepEqual(page.calls, LOADED, 'keeping it asks the server nothing');

  page.panelClick('cancel-vacation', { 'data-vacation-id': 'v-Hari' });
  page.vacationClick('confirm-cancel-vacation');
  page.vacationClick('confirm-cancel-vacation');
  assert.deepEqual(page.calls.slice(2), ['cancelVacation']);
  assert.deepEqual(plain(page.callArguments[2]), [{ token: 'token-Hari', vacation_id: 'v-Hari' }]);
  page.succeedCall(2, { ok: true });
  assert.deepEqual(page.calls.slice(3), ['getRotationSchedule', 'listVacations']);
  page.succeedCall(4, vacationList());
  assert.match(panelText(page), /Vacation deleted\..*Everyone’s home/);
});

test('a delete that is refused or unconfirmed reloads the list, with the reason in plain words', () => {
  const reasons = {
    VACATION_IN_USE: /already skipped a turn, so it stays on record and can’t be deleted/, VACATION_DELETE_CONFLICT: /would change the current cleaning turn, so it stays/,
    NOT_YOUR_VACATION: /belongs to someone else/, VACATION_NOT_FOUND: /isn’t there any more/, WRITE_FAILED: /Nothing was recorded/,
  };
  for (const [code, pattern] of Object.entries(reasons)) {
    const page = loadedVacations(vacationList(vacationItem('Hari')));
    page.panelClick('cancel-vacation', { 'data-vacation-id': 'v-Hari' });
    page.vacationClick('confirm-cancel-vacation');
    page.succeedCall(2, { ok: false, error: { code, message: 'Server detail secret' } });
    assert.equal(page.vacationDialog.open, false, code);
    assert.deepEqual(page.calls.slice(3), ['listVacations'], code);
    page.succeedCall(3, vacationList(vacationItem('Hari')));
    assert.match(page.panels.vacation.innerHTML, /<p class="notice notice-error" role="alert">/, code);
    assert.match(panelText(page), pattern, code);
    assert.doesNotMatch(page.panels.vacation.innerHTML, /secret/, code);
  }
  const page = loadedVacations(vacationList(vacationItem('Hari')));
  page.panelClick('cancel-vacation', { 'data-vacation-id': 'v-Hari' });
  page.vacationClick('confirm-cancel-vacation');
  page.failCall(2);
  page.succeedCall(3, vacationList(vacationItem('Hari')));
  assert.match(page.panels.vacation.innerHTML, /notice notice-info/);
});

test('names and ids in the vacation views are escaped, and someone else\'s vacation cannot be cancelled from the page', () => {
  const hostile = vacationItem('Hari', { name: '<img src=x onerror=alert(1)>', vacation_id: 'v"><b>x', state: 'away' });
  const page = loadedVacations(vacationList(hostile, vacationItem('Hari', { name: '<b>bold</b>' }), vacationItem('Jijo')));
  for (const html of [page.panels.vacation.innerHTML, page.awaySlot.innerHTML]) {
    assert.doesNotMatch(html, /<img|<b>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
  assert.match(page.panels.vacation.innerHTML, /data-vacation-id="v-Hari"/);

  page.panelClick('cancel-vacation', { 'data-vacation-id': 'v-Jijo' });
  assert.deepEqual(page.calls, LOADED, 'Jijo\'s vacation is not Hari\'s to cancel');
});

test('closing the dialog drops drafts and pending confirmations', () => {
  const page = loadedVacations(vacationList(vacationItem('Hari')));
  page.panelClick('plan-vacation');
  page.setDates('2026-01-09', '2026-01-12');
  page.vacationClick('close-vacation');
  assert.equal(page.vacationDialog.open, false);
  page.panelClick('plan-vacation');
  assert.ok(page.vacationDialog.innerHTML.includes(`min="${berlinToday()}" value=""`), 'the old dates are gone');

  page.vacationClick('close-vacation');
  page.vacationClick('confirm-cancel-vacation');
  assert.deepEqual(page.calls, LOADED);
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
  assert.deepEqual(page.calls, [...LOADED, 'listSwaps', 'listCleaningHistory'], 'Swaps and History load once, on their first visit; nothing else reloads');
  page.tabClick('swaps');
  page.tabsClickElsewhere();
  assert.deepEqual(page.shown(), ['swaps'], 'a click that is not on a tab changes nothing');
  assert.deepEqual(page.calls, [...LOADED, 'listSwaps', 'listCleaningHistory']);
});

test('the schedule and Mark as cleaned work exactly as before after visiting other tabs', () => {
  const page = withHari();
  const before = page.app.innerHTML;
  for (const tab of ['vacation', 'schedule']) page.tabClick(tab);
  assert.equal(page.app.innerHTML, before, 'the schedule was not re-rendered');
  assert.equal(hasMarkButton(page.app.innerHTML), true);
  page.clickMark();
  assert.equal(page.dialog.open, true);
  page.dialogClick('confirm-clean');
  assert.deepEqual(page.calls, [...LOADED, 'markCleaned']);
  assert.deepEqual(plain(page.callArguments[2]), [{ token: 'token-Hari', rotation_id: 'slot-Hari', due_at: turn('Hari', 0).due_at }]);
});

test('a schedule that arrives while another tab is open is waiting there, and the tab bar survives errors', () => {
  const page = loadFrontend();
  page.tabClick('vacation');
  page.succeed(schedule());
  assert.deepEqual(page.shown(), ['vacation']);
  page.tabClick('schedule');
  assert.match(textOf(page.app.innerHTML), /Current turn/);

  const broken = loadFrontend();
  broken.fail();
  broken.tabClick('vacation');
  assert.deepEqual(broken.shown(), ['vacation']);
  broken.tabClick('schedule');
  assert.match(textOf(broken.app.innerHTML), /Couldn’t reach the server/);
});

test('Vacation is a real section on the tab, not behind a dialog', () => {
  const page = withHari();
  assert.match(textOf(page.panels.vacation.innerHTML), /^Vacations /);
  assert.doesNotMatch(page.panels.vacation.innerHTML, /open-vacations/, 'the overview is on the tab, not behind a dialog');
  assert.deepEqual(page.calls, LOADED);
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

  // Without storage the session lasts for this visit only: sign in, then the notice shows and can be dismissed.
  const blocked = loadFrontend({ storageBlocked: true });
  assert.equal(blocked.betaNotice.hidden, true, 'not on the sign-in screen');
  blocked.authInputs['sign-in-username'].value = 'hari';
  blocked.authInputs['sign-in-password'].value = 'a long enough passphrase';
  blocked.authSubmit('sign-in');
  blocked.succeed({ ok: true, session: { token: 'token-visit', expires_at: FAR_FUTURE }, viewer: viewerOf('Hari') });
  assert.equal(blocked.signedIn(), true);
  assert.deepEqual(blocked.callArguments[1], [{ token: 'token-visit' }], 'the session is kept in memory');
  assert.equal(blocked.betaNotice.hidden, false);
  blocked.betaClick('dismiss-beta');
  assert.equal(blocked.betaNotice.hidden, true, 'dismissed for this visit');
});

test('the profile entry shows the signed-in name and role, as the server reports them', () => {
  const page = loadFrontend({ as: 'Hari' });
  assert.equal(page.profileButton.attributes['aria-label'], 'Profile');
  page.succeed(schedule());
  assert.match(textOf(page.profileButton.innerHTML), /^Hari Admin$/);
  assert.match(page.profileButton.innerHTML, /avatar avatar-sm tone-\d/);
  assert.equal(page.profileButton.attributes['aria-label'], 'Profile: Hari, Admin');

  const roommate = loadFrontend({ as: 'Jijo' });
  roommate.succeed(schedule());
  assert.match(textOf(roommate.profileButton.innerHTML), /^Jijo Roommate$/);
  const odd = loadFrontend({ as: 'Arun' });
  odd.succeed(schedule({ viewer: viewerOf('Arun', { role: 'SUPERUSER' }) }));
  assert.match(textOf(odd.profileButton.innerHTML), /^Arun Roommate$/, 'an unknown role is shown as the least');
});

test('the profile dialog shows who is signed in and offers Sign out and Close', () => {
  const page = loadFrontend({ as: 'Hari' });
  page.succeed(schedule());
  page.openProfile();
  assert.equal(page.profileDialog.open, true);
  assert.equal(textOf(page.profileDialog.innerHTML), 'Profile Hari Admin · Signed in Manage household Signing out ends your session on all your devices. Sign out Close');
  const roommate = loadFrontend({ as: 'Jijo' });
  roommate.succeed(schedule());
  roommate.openProfile();
  assert.doesNotMatch(roommate.profileDialog.innerHTML, /open-admin|Manage household/, 'only admins see the admin entry');
  assert.match(page.profileDialog.innerHTML, /data-action="close-profile" autofocus/);
  page.profileClick('something-else');
  assert.equal(page.profileDialog.open, true);
  page.profileClick('close-profile');
  assert.equal(page.profileDialog.open, false);
  assert.deepEqual(page.calls, LOADED, 'opening the profile never calls the server');
});

test('hostile roommate names are escaped in the profile entry and dialog', () => {
  const page = loadFrontend({ as: 'x' });
  const hostile = { roommate_id: 'id-x', name: '<img src=x onerror=alert(1)>', role: 'ROOMMATE', must_change_password: false };
  page.succeed(schedule({ viewer: hostile, roommates: [hostile, person('Hari')] }));
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
  assert.match(blockAt(css, css.indexOf('  .page {')), /padding: var\(--space-3\) var\(--space-4\) 96px;/, 'the bar never covers the end of the page');
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
  assert.equal(page.dialog.open, true, 'the icon of Mark as cleaned');

  const vacation = loadedVacations(vacationList(vacationItem('Hari')));
  const cancel = { getAttribute: (name) => ({ 'data-action': 'cancel-vacation', 'data-vacation-id': 'v-Hari' })[name] || null };
  vacation.panels.vacation.listeners.click({ target: { getAttribute: () => null, closest: () => cancel } });
  assert.match(textOf(vacation.vacationDialog.innerHTML), /Delete this vacation\?/, 'the label of Delete');
});

test('Schedule and vacations are fetched again only after they have gone stale, and never while saving', () => {
  const page = withHari();
  page.succeedCall(1, vacationList());
  page.tabClick('vacation');
  page.tabClick('schedule');
  page.tabClick('vacation');
  assert.deepEqual(page.calls, LOADED, 'recent copies are kept');

  page.view('Date.now = (real => () => real() + 6 * 60 * 1000)(Date.now)');
  page.tabClick('schedule');
  assert.deepEqual(page.calls, [...LOADED, 'getRotationSchedule'], 'an old schedule is refreshed');
  page.succeed(schedule());
  page.tabClick('vacation');
  assert.deepEqual(page.calls, [...LOADED, 'getRotationSchedule', 'listVacations'], 'an old vacation list is refreshed');
  page.succeed(vacationList());
  page.tabClick('schedule');
  page.tabClick('vacation');
  assert.equal(page.calls.length, 4, 'and then both are recent again');

  const failed = loadFrontend();
  failed.fail();
  failed.view('Date.now = (real => () => real() + 6 * 60 * 1000)(Date.now)');
  failed.tabClick('vacation');
  failed.tabClick('schedule');
  assert.deepEqual(failed.calls, LOADED, 'a failed load keeps its Try again button instead');
});

// Admin section (opened from Profile; ADMIN only, checked by the server on every call)

const accountOf = (name, extra = {}) => ({ roommate_id: `id-${name}`, name, member_code: `${name.slice(0, 3).toUpperCase()}-00${extra.n || 1}`, username: name.toLowerCase(), role: 'ROOMMATE', status: 'active', position: 1, is_you: false, ...extra });
const accountList = (...accounts) => ({ ok: true, accounts });
const HOUSEHOLD = accountList(
  accountOf('Hari', { role: 'ADMIN', is_you: true }),
  accountOf('Jijo', { status: 'temporary' }),
  accountOf('Arun', { username: null, role: null, status: 'none' }),
  accountOf('Old', { status: 'inactive' }),
);
const adminText = (page) => textOf(page.panels.admin.innerHTML);
const adminDialogText = (page) => textOf(page.adminDialog.innerHTML);

/** Hari (ADMIN), signed in, with the admin section open and the household loaded. */
function openAdminPage(list = HOUSEHOLD) {
  const page = loadFrontend({ as: 'Hari' });
  page.succeed(schedule());
  page.succeed(vacationList());
  page.openProfile();
  page.profileClick('open-admin');
  page.succeed(list);
  return page;
}

test('only an admin can open the household section; it lists everyone with what can be done', () => {
  const roommate = loadFrontend({ as: 'Jijo' });
  roommate.succeed(schedule());
  roommate.openProfile();
  roommate.profileClick('open-admin');
  assert.equal(roommate.panels.admin.hidden, true);
  assert.equal(roommate.calls.includes('adminListAccounts'), false, 'a roommate’s page does not even ask');

  const page = openAdminPage();
  assert.equal(page.profileDialog.open, false);
  assert.equal(page.panels.admin.hidden, false);
  assert.deepEqual(page.shown(), ['admin'], 'only the admin section is shown');
  assert.deepEqual(page.current(), [], 'no tab is marked current');
  const listCall = page.calls.indexOf('adminListAccounts');
  assert.deepEqual(page.callArguments[listCall], [{ token: 'token-Hari' }]);
  const text = adminText(page);
  assert.match(text, /^Household Roommates and their sign-in\. Only admins see this page\. Add roommate/);
  assert.match(text, /Hari \(you\) HAR-001 · @hari Admin Active New temporary password/);
  assert.match(text, /Jijo JIJ-001 · @jijo Roommate Waiting for first sign-in New temporary password Sign out everywhere Disable sign-in Make admin/);
  assert.match(text, /Arun ARU-001 · no username No account yet Create account/);
  assert.match(text, /Old OLD-001 · @old Roommate Moved out Moved out: change this in the Google Sheet\./);
  const own = page.panels.admin.innerHTML.split('<li').find((card) => card.includes('(you)'));
  assert.doesNotMatch(own, /admin-disable|admin-role|admin-end-sessions/, 'your own account cannot be disabled, demoted or signed out here');
  page.adminPanelClick('admin-back');
  assert.equal(page.panels.admin.hidden, true);
  assert.deepEqual(page.shown(), ['schedule']);
});

test('adding a roommate checks the form, sends exactly the details, then shows the temporary password once', () => {
  const page = openAdminPage();
  page.adminPanelClick('admin-add');
  assert.equal(page.adminDialog.open, true);
  assert.match(adminDialogText(page), /^Add a roommate They join the rotation at the end/);
  const inputs = page.adminInputs;
  page.adminDialogClick('admin-save-add');
  assert.match(adminDialogText(page), /Fill in the name, email and username\./);
  Object.assign(inputs['admin-name'], { value: 'Kim Lee' });
  Object.assign(inputs['admin-email'], { value: 'kim@example' });
  Object.assign(inputs['admin-username'], { value: 'kim' });
  page.adminDialogClick('admin-save-add');
  assert.match(adminDialogText(page), /That email doesn’t look right\./);
  assert.match(page.adminDialog.innerHTML, /id="admin-name" type="text" value="Kim Lee"/, 'what was typed stays');
  const before = page.calls.length;
  inputs['admin-email'].value = 'kim@example.com';
  inputs['admin-role-admin'].checked = true;
  page.adminDialogClick('admin-save-add');
  page.adminDialogClick('admin-save-add');
  assert.deepEqual(page.calls.slice(before), ['adminAddRoommate'], 'one request however often it is clicked');
  assert.deepEqual(page.callArguments[before], [{ token: 'token-Hari', name: 'Kim Lee', email: 'kim@example.com', telegram: '', username: 'kim', role: 'ADMIN' }]);
  assert.match(adminDialogText(page), /Adding the roommate and creating the account\. This takes about 10 seconds…/);

  page.succeed({ ok: true, account: accountOf('Kim Lee', { username: 'kim', role: 'ADMIN', status: 'temporary' }), temporary_password: 'Xy7kP3qRt9mWb2Nc', expires_at: '2026-01-16T12:00:00.000Z' });
  assert.match(adminDialogText(page), /Temporary password for Kim Lee Username kim \. Give them this password in person\. It is shown only now\. Xy7kP3qRt9mWb2Nc It works until Fri 16 Jan, 13:00 \(Berlin\)/);
  assert.equal(page.storage.has('Xy7kP3qRt9mWb2Nc'), false);
  assert.ok(![...page.storage.values()].some((value) => value.includes('Xy7kP3qRt9mWb2Nc')), 'never stored on the device');
  assert.ok(!page.panels.admin.innerHTML.includes('Xy7kP3qRt9mWb2Nc'));

  const reloads = page.calls.length;
  page.adminDialogClick('admin-done');
  assert.equal(page.adminDialog.open, false);
  assert.equal(page.adminDialog.innerHTML, '', 'the password is wiped from the page');
  assert.deepEqual(page.calls.slice(reloads), ['adminListAccounts', 'getRotationSchedule'], 'the list and the rotation refresh');
  page.succeedCall(reloads, HOUSEHOLD);
  assert.match(adminText(page), /Kim Lee was added to the rotation\./);
});

test('a refusal keeps the form with a plain reason; a network failure says the save is unconfirmed', () => {
  const page = openAdminPage();
  page.adminPanelClick('admin-provision', { 'data-roommate-id': 'id-Arun' });
  assert.match(adminDialogText(page), /^Create an account for Arun Username/);
  assert.match(page.adminDialog.innerHTML, /id="admin-username" type="text" value="arun"/, 'a username is suggested');
  page.adminInputs['admin-username'].value = 'Not Valid!';
  page.adminDialogClick('admin-save-provision');
  assert.match(adminDialogText(page), /Check the username/);
  page.adminInputs['admin-username'].value = 'hari';
  page.adminDialogClick('admin-save-provision');
  page.succeed(failure('USERNAME_TAKEN'));
  assert.match(adminDialogText(page), /That username is already taken\. Choose another one\./);
  assert.doesNotMatch(adminDialogText(page), /Server detail/);
  assert.equal(page.adminDialog.open, true);

  page.adminInputs['admin-username'].value = 'arun';
  page.adminDialogClick('admin-save-provision');
  page.fail();
  assert.equal(page.adminDialog.open, false);
  page.succeed(HOUSEHOLD);
  assert.match(adminText(page), /couldn’t confirm that it saved/);
});

test('a new temporary password is asked for first, shown once, and Escape wipes it too', () => {
  const page = openAdminPage();
  page.adminPanelClick('admin-reset', { 'data-roommate-id': 'id-Jijo' });
  assert.match(adminDialogText(page), /^New temporary password for Jijo\? Their current password stops working and they are signed out everywhere\./);
  assert.match(page.adminDialog.innerHTML, /data-action="admin-close" autofocus/, 'Cancel is the safe default');
  const before = page.calls.length;
  page.adminDialogClick('admin-confirm');
  assert.deepEqual(page.callArguments[before], [{ token: 'token-Hari', roommate_id: 'id-Jijo' }]);
  page.succeed({ ok: true, account: accountOf('Jijo', { status: 'temporary' }), temporary_password: 'AbCdEfGh23456789', expires_at: '2026-01-16T12:00:00.000Z' });
  assert.match(page.adminDialog.innerHTML, /AbCdEfGh23456789/);
  page.adminEscape();
  assert.equal(page.adminDialog.open, false);
  assert.equal(page.adminDialog.innerHTML, '');
  assert.equal(page.calls[page.calls.length - 1], 'adminListAccounts');
});

test('disable, sign out everywhere and role changes send exactly the account and refresh the list', () => {
  const cases = [
    ['admin-disable', {}, 'adminDisableSignIn', {}, /Disable sign-in for Jijo\?/, /Sign-in disabled for Jijo\./],
    ['admin-end-sessions', {}, 'adminEndSessions', {}, /Sign Jijo out everywhere\?/, /Jijo is signed out everywhere\./],
    ['admin-role', { 'data-role': 'ADMIN' }, 'adminChangeRole', { role: 'ADMIN' }, /Make Jijo an admin\?/, /Jijo is now an admin\./],
  ];
  for (const [action, attributes, call, extra, question, notice] of cases) {
    const page = openAdminPage();
    page.adminPanelClick(action, { 'data-roommate-id': 'id-Jijo', ...attributes });
    assert.match(adminDialogText(page), question);
    const before = page.calls.length;
    page.adminDialogClick('admin-confirm');
    assert.deepEqual(page.calls.slice(before), [call]);
    assert.deepEqual(page.callArguments[before], [{ token: 'token-Hari', roommate_id: 'id-Jijo', ...extra }]);
    page.succeed({ ok: true, account: accountOf('Jijo') });
    assert.equal(page.adminDialog.open, false);
    page.succeed(HOUSEHOLD);
    assert.match(adminText(page), notice);
  }
  const refused = openAdminPage();
  refused.adminPanelClick('admin-role', { 'data-roommate-id': 'id-Jijo', 'data-role': 'ADMIN' });
  refused.adminDialogClick('admin-confirm');
  refused.succeed(failure('LAST_ADMIN'));
  assert.match(adminDialogText(refused), /always needs at least one admin/);
});

test('when the server says you are not an admin any more, the section closes and the profile says Roommate', () => {
  const page = openAdminPage();
  page.adminPanelClick('admin-disable', { 'data-roommate-id': 'id-Jijo' });
  page.adminDialogClick('admin-confirm');
  page.succeed(failure('FORBIDDEN'));
  assert.equal(page.panels.admin.hidden, true);
  assert.equal(page.adminDialog.open, false);
  assert.deepEqual(page.shown(), ['schedule']);
  assert.match(textOf(page.profileButton.innerHTML), /Hari Roommate$/);
  assert.equal(page.calls[page.calls.length - 1], 'getRotationSchedule', 'who you are is checked again');

  const listed = loadFrontend({ as: 'Hari' });
  listed.succeed(schedule());
  listed.openProfile();
  listed.profileClick('open-admin');
  listed.succeed(failure('FORBIDDEN'));
  assert.equal(listed.panels.admin.hidden, true);
});

test('names and IDs in the admin section are escaped', () => {
  const page = openAdminPage(accountList(accountOf('<img src=x onerror=alert(1)>', { roommate_id: 'id-"><b>', member_code: '<i>X</i>', username: '<u>u</u>' })));
  assert.doesNotMatch(page.panels.admin.innerHTML, /<img|<b>|<i>|<u>/);
  assert.match(page.panels.admin.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page.panels.admin.innerHTML, /data-roommate-id="id-&quot;&gt;&lt;b&gt;"/);
});

test('signing out from the admin section clears it for the next person', () => {
  const page = openAdminPage();
  page.adminPanelClick('admin-reset', { 'data-roommate-id': 'id-Jijo' });
  page.openProfile();
  page.profileClick('sign-out');
  assert.equal(page.panels.admin.hidden, true);
  assert.equal(page.panels.admin.innerHTML, '');
  assert.equal(page.adminDialog.open, false);
  assert.equal(page.adminDialog.innerHTML, '');
});

// History: a read-only table with a time range, server-side pages and a CSV download, loaded on the first visit

const historyEntry = (name, n, extra = {}) => ({
  log_id: `log-${n}`, roommate: person(name), weekend_starts_at: turn(name, -n).weekend_starts_at, due_at: turn(name, -n).due_at,
  outcome: 'completed', completed_at: '2026-01-11T17:30:00.000Z', resolved_at: '2026-01-11T17:30:00.000Z', swapped: false, ...extra,
});
const historyList = (entries, extra = {}) => ({ ok: true, entries, range: '14d', page: 1, page_size: 25, total: entries.length, pages: 1, ...extra });
const historyText = (page) => textOf(page.panels.history.innerHTML);
const historyArgs = (page) => page.callArguments[page.calls.lastIndexOf('listCleaningHistory')][0];
const openHistory = (page = withHari()) => {
  page.tabClick('history');
  return page;
};

test('History loads the last 14 days on its first visit and shows a read-only table', () => {
  const page = withHari();
  page.succeed(vacationList());
  assert.equal(page.calls.includes('listCleaningHistory'), false, 'not loaded until asked for');
  openHistory(page);
  assert.equal(page.calls[page.calls.length - 1], 'listCleaningHistory');
  assert.deepEqual(historyArgs(page), { token: 'token-Hari', range: '14d', page: 1 });
  assert.match(historyText(page), /Loading history…/);
  assert.match(page.panels.history.innerHTML, /aria-pressed="true">Last 14 days/, 'the filter shows while loading');
  page.succeed(historyList([
    historyEntry('Jijo', 1),
    historyEntry('Arun', 2, { outcome: 'vacation_skipped', completed_at: null, resolved_at: '2026-01-03T08:00:00.000Z' }),
    historyEntry('Hari', 3, { outcome: 'admin_resolved', completed_at: null, resolved_at: '2026-01-05T09:00:00.000Z', swapped: true }),
  ]));
  const html = page.panels.history.innerHTML;
  const text = historyText(page);
  assert.match(text, /^History The receipts: who cleaned, and which turns were skipped\. Download CSV Last 14 days Last 30 days Last 90 days All time Last 14 days Cleaning weekend Roommate Status Resolved/);
  assert.match(text, /Sat 10 – Sun 11 Jan Jijo Cleaned Sun 11 Jan, 18:30/);
  assert.match(text, /Sat 3 – Sun 4 Jan Arun Skipped: away Sat 3 Jan, 09:00/);
  assert.match(text, /Sat 27 – Sun 28 Dec Hari Closed by the app owner Swapped turn Mon 5 Jan, 10:00/);
  assert.match(text, /Newest first · Times in Berlin$/);
  assert.doesNotMatch(text, /Page \d/, 'one page needs no pager');
  assert.equal((html.match(/<tr>/g) || []).length, 4, 'a header row and three records');
  assert.equal((html.match(/<th scope="row"/g) || []).length, 3);
  assert.doesNotMatch(html, /<(input|form|select|a)\b/);
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u, 'no decorative emojis');

  const calls = page.calls.length;
  page.tabClick('schedule');
  openHistory(page);
  assert.equal(page.calls.length, calls, 'a recent history is kept');
});

test('choosing a range asks the server for page 1 of that range, and the chosen range is shown as pressed', () => {
  const page = openHistory();
  page.succeed(historyList([historyEntry('Jijo', 1)]));
  page.historyClick('history-range', { 'data-range': '90d' });
  assert.deepEqual(historyArgs(page), { token: 'token-Hari', range: '90d', page: 1 });
  assert.match(page.panels.history.innerHTML, /aria-pressed="true">Last 90 days/);
  assert.equal((page.panels.history.innerHTML.match(/aria-pressed="true"/g) || []).length, 1);
  page.succeed(historyList([historyEntry('Jijo', 1)], { range: '90d' }));

  const before = page.calls.length;
  page.historyClick('history-range', { 'data-range': '90d' }); // already chosen
  page.historyClick('history-range', { 'data-range': '7d' }); // not a range
  page.historyClick('history-range', {});
  assert.equal(page.calls.length, before, 'nothing asked');
  page.historyClick('history-range', { 'data-range': 'all' });
  assert.equal(historyArgs(page).range, 'all');
  page.succeed(historyList([historyEntry('Jijo', 1)], { range: 'all' }));
  page.tabClick('schedule');
  assert.match(page.panels.history.innerHTML, /aria-pressed="true">All time/, 'the range is kept while the tab is closed');
});

test('pages come from the server: next and previous ask for the neighbouring page, and the edges do nothing', () => {
  const page = openHistory();
  const entries = Array.from({ length: 25 }, (_, n) => historyEntry('Jijo', n));
  page.succeed(historyList(entries, { range: 'all', total: 61, pages: 3 }));
  assert.match(historyText(page), /Page 1 of 3 1–25 of 61/);
  assert.match(page.panels.history.innerHTML, /data-action="history-prev" disabled/);
  assert.doesNotMatch(page.panels.history.innerHTML, /data-action="history-next" disabled/);

  const before = page.calls.length;
  page.historyClick('history-prev');
  assert.equal(page.calls.length, before, 'no page before the first');
  page.historyClick('history-next');
  assert.deepEqual(historyArgs(page), { token: 'token-Hari', range: 'all', page: 2 });
  page.succeed(historyList(entries, { range: 'all', total: 61, pages: 3, page: 2 }));
  assert.match(historyText(page), /Page 2 of 3 26–50 of 61/);
  page.historyClick('history-next');
  page.succeed(historyList(entries.slice(0, 11), { range: 'all', total: 61, pages: 3, page: 3 }));
  assert.match(historyText(page), /Page 3 of 3 51–61 of 61/);
  assert.match(page.panels.history.innerHTML, /data-action="history-next" disabled/);
  const last = page.calls.length;
  page.historyClick('history-next');
  assert.equal(page.calls.length, last, 'no page after the last');
  page.historyClick('history-prev');
  assert.equal(historyArgs(page).page, 2);

  // Changing the range starts again at page 1.
  page.succeed(historyList(entries, { range: 'all', total: 61, pages: 3, page: 2 }));
  page.historyClick('history-range', { 'data-range': '30d' });
  assert.deepEqual(historyArgs(page), { token: 'token-Hari', range: '30d', page: 1 });
});

test('an older answer never replaces a newer one, and the page follows the server when it moved to the last page', () => {
  const page = openHistory();
  page.succeed(historyList([historyEntry('Jijo', 1)]));
  page.historyClick('history-range', { 'data-range': '30d' }); // call A
  const a = page.calls.length - 1;
  page.historyClick('history-range', { 'data-range': '90d' }); // call B
  const b = page.calls.length - 1;
  page.succeedCall(b, historyList([historyEntry('Arun', 5)], { range: '90d' }));
  page.succeedCall(a, historyList([historyEntry('Kim', 6)], { range: '30d' }));
  assert.match(historyText(page), /Arun/);
  assert.doesNotMatch(historyText(page), /Kim/);
  assert.match(page.panels.history.innerHTML, /aria-pressed="true">Last 90 days/);

  const moved = openHistory(withHari());
  moved.succeed(historyList(Array.from({ length: 25 }, (_, n) => historyEntry('Jijo', n)), { range: 'all', total: 60, pages: 3 }));
  moved.historyClick('history-next');
  moved.succeed(historyList([historyEntry('Jijo', 1)], { range: 'all', total: 26, pages: 2, page: 2 })); // the list shrank meanwhile
  assert.match(historyText(moved), /Page 2 of 2 26–26 of 26/);
});

test('History has clear empty states for every range, an error state with retry, escapes names, and refreshes after a cleaning', () => {
  const empty = openHistory();
  empty.succeed(historyList([], { total: 0 }));
  assert.match(historyText(empty), /No cleanings in the last 14 days Choose a longer range to see older cleanings\./);
  assert.match(empty.panels.history.innerHTML, /data-action="download-history" disabled/, 'nothing to download');
  empty.historyClick('history-range', { 'data-range': '30d' });
  empty.succeed(historyList([], { range: '30d', total: 0 }));
  assert.match(historyText(empty), /No cleanings in the last 30 days/);
  empty.historyClick('history-range', { 'data-range': '90d' });
  empty.succeed(historyList([], { range: '90d', total: 0 }));
  assert.match(historyText(empty), /No cleanings in the last 90 days/);
  empty.historyClick('history-range', { 'data-range': 'all' });
  empty.succeed(historyList([], { range: 'all', total: 0 }));
  assert.match(historyText(empty), /No cleanings yet Once a turn is marked as cleaned, it shows up here\./);

  const broken = openHistory();
  broken.fail();
  assert.match(historyText(broken), /Couldn’t load the history Check your connection and try again\. Try again/);
  assert.match(broken.panels.history.innerHTML, /data-action="history-range"/, 'the range can still be changed');
  broken.historyClick('retry-history');
  assert.equal(broken.calls[broken.calls.length - 1], 'listCleaningHistory');
  broken.succeed({ ok: true, entries: [{ nonsense: true }] });
  assert.match(historyText(broken), /Couldn’t load the history Try again in a moment\./);
  broken.historyClick('retry-history');
  broken.succeed(historyList([historyEntry('Jijo', 1)], { range: 'bogus' }));
  assert.match(historyText(broken), /Couldn’t load the history/, 'an unknown range in the answer is not trusted');

  const hostile = openHistory();
  hostile.succeed(historyList([historyEntry('<img src=x onerror=alert(1)>', 1)]));
  assert.doesNotMatch(hostile.panels.history.innerHTML, /<img/);

  const ended = openHistory();
  ended.succeed(failure('UNAUTHENTICATED'));
  assert.equal(ended.signedIn(), false, 'an ended session goes back to sign-in');

  const after = openHistory();
  after.succeed(historyList([historyEntry('Jijo', 1)]));
  after.tabClick('schedule');
  after.clickMark();
  after.dialogClick('confirm-clean');
  after.succeed({ ok: true, completed_at: '2026-01-13T12:00:00.000Z' });
  const before = after.calls.length;
  after.tabClick('history');
  assert.equal(after.calls[before], 'listCleaningHistory', 'the new record is fetched on the next visit');
  assert.deepEqual(historyArgs(after), { token: 'token-Hari', range: '14d', page: 1 });
});

test('Download CSV asks the server for the chosen range, saves the file once, and explains a failure', () => {
  const page = openHistory();
  page.succeed(historyList([historyEntry('Jijo', 1)], { range: '30d' }));
  page.historyClick('download-history');
  assert.equal(page.calls[page.calls.length - 1], 'exportCleaningHistory');
  assert.deepEqual(page.callArguments[page.calls.length - 1], [{ token: 'token-Hari', range: '30d' }], 'only the token and the range');
  assert.match(historyText(page), /Preparing…/);
  assert.match(page.panels.history.innerHTML, /data-action="download-history" disabled/);
  const before = page.calls.length;
  page.historyClick('download-history'); // a second click while preparing
  assert.equal(page.calls.length, before);
  page.succeed({ ok: true, filename: 'chorenest-history-30d-2026-01-13.csv', csv: 'a,b\r\n1,2\r\n', count: 1 });
  assert.deepEqual(page.downloads, [{ href: 'blob:test-1', download: 'chorenest-history-30d-2026-01-13.csv', text: 'a,b\r\n1,2\r\n' }]);
  assert.match(historyText(page), /Download CSV/);
  assert.doesNotMatch(page.panels.history.innerHTML, /role="alert"/);

  for (const answer of [{ ok: true, filename: '../evil.csv', csv: 'x' }, { ok: true, csv: 5 }, failure('INTERNAL_ERROR')]) {
    page.historyClick('download-history');
    page.succeed(answer);
    assert.match(page.panels.history.innerHTML, /Couldn’t prepare the download/);
  }
  assert.equal(page.downloads.length, 1, 'nothing was saved for a bad answer');

  page.historyClick('download-history');
  page.fail();
  assert.match(historyText(page), /Couldn’t prepare the download\. Check your connection/);
  page.downloadFlags.blocked = true;
  page.historyClick('download-history');
  page.succeed({ ok: true, filename: 'x.csv', csv: 'a' });
  assert.match(historyText(page), /Your browser blocked the download/);

  const ended = openHistory();
  ended.succeed(historyList([historyEntry('Jijo', 1)]));
  ended.historyClick('download-history');
  ended.succeed(failure('UNAUTHENTICATED'));
  assert.equal(ended.signedIn(), false);
  assert.equal(ended.downloads.length, 0);
});

// Swaps: incoming, outgoing and accepted requests, and the request form

const swapTurn = (name, n) => ({ owner: person(name), weekend_starts_at: turn(name, n).weekend_starts_at, due_at: turn(name, n).due_at });
const swapItem = (name, direction, extra = {}) => ({
  swap_id: `swap-${name}-${direction}`, status: 'pending', direction, partner: person(name),
  your_due_at: turn('Hari', 1).due_at, their_due_at: turn(name, 2).due_at,
  your_weekend_starts_at: turn('Hari', 1).weekend_starts_at, their_weekend_starts_at: turn(name, 2).weekend_starts_at,
  not_applied: false, created_at: '2026-01-12T10:00:00.000Z', ...extra,
});
const swapList = (swaps = [], turns = [swapTurn('Hari', 1), swapTurn('Jijo', 2), swapTurn('Arun', 3)]) => ({ ok: true, swaps, turns });
const swapText = (page) => textOf(page.panels.swaps.innerHTML);
const swapDialogText = (page) => textOf(page.swapDialog.innerHTML);
function openSwaps(list = swapList(), as = HARI) {
  const page = withHari(schedule(), as);
  page.succeed(vacationList());
  page.tabClick('swaps');
  page.succeed(list);
  return page;
}

test('the Swaps tab loads with the session, explains that pending requests change nothing, and groups requests by status', () => {
  const page = withHari();
  page.tabClick('swaps');
  assert.equal(page.calls[page.calls.length - 1], 'listSwaps');
  assert.deepEqual(page.callArguments[page.calls.length - 1], [{ token: 'token-Hari' }]);
  assert.match(swapText(page), /Loading swaps…/);
  page.succeed(swapList([
    swapItem('Jijo', 'incoming'),
    swapItem('Arun', 'outgoing'),
    swapItem('Jijo', 'incoming', { swap_id: 'swap-accepted', status: 'accepted' }),
    swapItem('Arun', 'incoming', { swap_id: 'swap-off', status: 'accepted', not_applied: true }),
  ]));
  const text = swapText(page);
  assert.match(text, /^Swaps Trade one cleaning weekend for another\. Nothing changes until they accept, and the rotation order stays put\. Request a swap/);
  assert.ok(text.includes('Asked of you Jijo Waiting for an answer You clean Sat 31 Jan – Sun 1 Feb (Jijo’s turn) Jijo cleans Sat 24 – Sun 25 Jan (your turn) Accept Decline'), text);
  assert.ok(text.includes('You asked Arun Waiting for an answer You clean Sat 31 Jan – Sun 1 Feb (Arun’s turn) Arun cleans Sat 24 – Sun 25 Jan (your turn) Cancel request'), text);
  assert.ok(text.includes('Accepted Jijo Accepted You clean Sat 31 Jan – Sun 1 Feb (Jijo’s turn) Jijo cleans Sat 24 – Sun 25 Jan (your turn) Arun Not in effect'), text);
  assert.ok(text.endsWith('Not in effect: someone is away or inactive that weekend, so the usual turns stand. Nothing else changed.'), text);
  const html = page.panels.swaps.innerHTML;
  assert.equal((html.match(/data-action="swap-accept"/g) || []).length, 1 + 0, 'accept is only on pending incoming requests');
  assert.equal((html.match(/data-action="swap-cancel"/g) || []).length, 1, 'cancel is only on pending outgoing requests');
  assert.equal((html.match(/data-action="swap-decline"/g) || []).length, 1);
  const calls = page.calls.length;
  page.tabClick('schedule');
  page.tabClick('swaps');
  assert.equal(page.calls.length, calls, 'a recent list is kept');
});

test('empty, error and nothing-to-swap states are clear, and a failed load can be retried', () => {
  const none = openSwaps(swapList([], []));
  assert.match(swapText(none), /No swaps yet There is no turn you could swap right now./);
  assert.doesNotMatch(none.panels.swaps.innerHTML, /swap-request/, 'no button when nothing can be swapped');
  const only = openSwaps(swapList([], [swapTurn('Hari', 1)]));
  assert.doesNotMatch(only.panels.swaps.innerHTML, /swap-request/, 'nobody else has a turn to take');
  const empty = openSwaps();
  assert.ok(swapText(empty).endsWith('No swaps yet Busy weekend coming up? Ask a roommate to trade.'));
  assert.match(empty.panels.swaps.innerHTML, /data-action="swap-request"/);

  const broken = withHari();
  broken.tabClick('swaps');
  broken.fail();
  assert.match(swapText(broken), /Couldn’t load the swaps Check your connection and try again. Try again/);
  broken.swapPanelClick('swap-retry');
  assert.equal(broken.calls[broken.calls.length - 1], 'listSwaps');
  broken.succeed({ ok: true, swaps: [{ nonsense: true }], turns: [] });
  assert.match(swapText(broken), /Couldn’t load the swaps Try again in a moment./);
  const ended = withHari();
  ended.tabClick('swaps');
  ended.succeed(failure('UNAUTHENTICATED'));
  assert.equal(ended.signedIn(), false);
});

test('the request form offers my turns and the others’ turns, previews the exchanged weekends, and sends exactly the choice', () => {
  const page = openSwaps(swapList([], [swapTurn('Hari', 1), swapTurn('Jijo', 2), swapTurn('Hari', 5), swapTurn('Arun', 3)]));
  page.swapPanelClick('swap-request');
  assert.equal(page.swapDialog.open, true);
  const html = page.swapDialog.innerHTML;
  assert.match(html, /id="swap-mine"[^>]*autofocus>/);
  assert.deepEqual([...html.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [m[3], Boolean(m[2])]), [
    ['Sat 24 – Sun 25 Jan', true], ['Sat 21 – Sun 22 Feb', false], ['Jijo · Sat 31 Jan – Sun 1 Feb', true], ['Arun · Sat 7 – Sun 8 Feb', false],
  ]);
  const text = swapDialogText(page);
  assert.ok(text.startsWith('Request a swap Your turn to give away'), text);
  assert.ok(text.endsWith('You clean Sat 31 Jan – Sun 1 Feb instead of Jijo Jijo cleans Sat 24 – Sun 25 Jan instead of Hari Nothing changes until Jijo accepts. Send request Not now'), text);
  const slot = page.swapInputs['swap-preview-slot'];
  page.swapInputs['swap-mine'].value = turn('Hari', 5).due_at;
  page.swapInputs['swap-theirs'].value = turn('Arun', 3).due_at;
  page.swapChange();
  assert.equal(textOf(slot.innerHTML), 'You clean Sat 7 – Sun 8 Feb instead of Arun Arun cleans Sat 21 – Sun 22 Feb instead of Hari Nothing changes until Arun accepts.');

  const before = page.calls.length;
  page.swapDialogClick('swap-send');
  page.swapDialogClick('swap-send');
  assert.deepEqual(page.calls.slice(before), ['requestSwap'], 'one request however often it is clicked');
  assert.deepEqual(page.callArguments[before], [{ token: 'token-Hari', your_due_at: turn('Hari', 5).due_at, partner_id: 'id-Arun', their_due_at: turn('Arun', 3).due_at }]);
  assert.match(swapDialogText(page), /Saving…/);
  page.succeed({ ok: true, swap: swapItem('Arun', 'outgoing') });
  assert.equal(page.swapDialog.open, false);
  assert.equal(page.calls[page.calls.length - 1], 'listSwaps');
  page.succeed(swapList([swapItem('Arun', 'outgoing')]));
  assert.match(swapText(page), /Request sent to Arun. Nothing changes until they accept. /);
  assert.equal(page.calls.includes('markCleaned'), false);
});

test('accepting asks first, shows the exchange, then reloads the list and refreshes the schedule without blanking it', () => {
  const page = openSwaps(swapList([swapItem('Jijo', 'incoming')]));
  const schedulePage = page.app.innerHTML;
  page.swapPanelClick('swap-accept', { 'data-swap-id': 'swap-Jijo-incoming' });
  assert.equal(swapDialogText(page), 'Accept Jijo’s swap? You clean Sat 31 Jan – Sun 1 Feb (Jijo’s turn) Jijo cleans Sat 24 – Sun 25 Jan (your turn) Cleaning changes for just these two weekends. Accept swap Not now');
  assert.match(page.swapDialog.innerHTML, /data-action="swap-close" autofocus/, 'Not now is the safe default');
  const before = page.calls.length;
  page.swapDialogClick('swap-confirm');
  assert.deepEqual(page.callArguments[before], [{ token: 'token-Hari', swap_id: 'swap-Jijo-incoming' }]);
  assert.equal(page.calls[before], 'acceptSwap');
  page.succeed({ ok: true, swap: swapItem('Jijo', 'incoming', { status: 'accepted' }) });
  assert.deepEqual(page.calls.slice(before + 1), ['listSwaps', 'getRotationSchedule']);
  assert.equal(page.app.innerHTML, schedulePage, 'the schedule stays on screen while it refreshes');
  page.succeedCall(before + 2, schedule({ current: { status: 'pending' } }));
  page.succeedCall(before + 1, swapList([swapItem('Jijo', 'incoming', { status: 'accepted' })]));
  assert.match(swapText(page), /Swap accepted: you and Jijo trade those two weekends./);
});

test('decline and cancel ask first, only on the right requests, and change nothing else', () => {
  const page = openSwaps(swapList([swapItem('Jijo', 'incoming'), swapItem('Arun', 'outgoing')]));
  page.swapPanelClick('swap-cancel', { 'data-swap-id': 'swap-Jijo-incoming' });
  page.swapPanelClick('swap-accept', { 'data-swap-id': 'swap-Arun-outgoing' });
  page.swapPanelClick('swap-decline', { 'data-swap-id': 'swap-Arun-outgoing' });
  assert.equal(page.swapDialog.open, false, 'someone else’s side of a request opens nothing');

  page.swapPanelClick('swap-decline', { 'data-swap-id': 'swap-Jijo-incoming' });
  assert.equal(swapDialogText(page), 'Decline Jijo’s swap? Nothing changes. They’ll see it was declined. Decline swap Not now');
  let before = page.calls.length;
  page.swapDialogClick('swap-confirm');
  assert.equal(page.calls[before], 'declineSwap');
  page.succeed({ ok: true });
  assert.equal(page.calls.includes('getRotationSchedule', before), false, 'declining does not refresh the schedule');
  assert.deepEqual(page.calls.slice(before + 1), ['listSwaps']);
  page.succeed(swapList([swapItem('Arun', 'outgoing')]));
  assert.match(swapText(page), /Request declined./);

  page.swapPanelClick('swap-cancel', { 'data-swap-id': 'swap-Arun-outgoing' });
  assert.equal(swapDialogText(page), 'Cancel your request to Arun? Nothing changes. Cancel request Not now');
  before = page.calls.length;
  page.swapDialogClick('swap-confirm');
  assert.deepEqual(page.callArguments[before], [{ token: 'token-Hari', swap_id: 'swap-Arun-outgoing' }]);
  page.swapEscape(); // busy: Escape cannot close it
  assert.equal(page.swapDialog.open, true);
  page.succeed({ ok: true });
  page.succeed(swapList());
  assert.match(swapText(page), /Request cancelled./);
  page.swapPanelClick('swap-request');
  page.swapEscape();
  assert.equal(page.swapDialog.open, false);
  assert.equal(page.swapDialog.innerHTML, '');
});

test('stale requests, vacation conflicts and other refusals are explained in plain words and reload the list', () => {
  const cases = [
    ['SWAP_STALE', /schedule changed \(for example, someone planned a vacation\), so this swap no longer fits/],
    ['SWAP_PARTNER_UNAVAILABLE', /One of you is away or inactive that weekend/],
    ['SWAP_NOT_PENDING', /already answered or cancelled/],
    ['SWAP_NOT_FOUND', /isn’t there any more/],
    ['SWAP_TURN_TAKEN', /already part of another swap/],
    ['SWAP_NOT_YOURS', /isn’t yours to change/],
    ['BUSY', /Someone else is saving/],
    ['SOMETHING_NEW', /Something went wrong, so nothing was changed/],
  ];
  for (const [code, message] of cases) {
    const page = openSwaps(swapList([swapItem('Jijo', 'incoming')]));
    page.swapPanelClick('swap-accept', { 'data-swap-id': 'swap-Jijo-incoming' });
    page.swapDialogClick('swap-confirm');
    page.succeed(failure(code));
    assert.equal(page.swapDialog.open, false, code);
    assert.equal(page.calls[page.calls.length - 1], 'listSwaps', `${code}: the list is reloaded`);
    assert.equal(page.calls.includes('getRotationSchedule', LOADED.length), false);
    page.succeed(swapList([swapItem('Jijo', 'incoming')]));
    assert.match(swapText(page), message, code);
    assert.doesNotMatch(swapText(page), /Server detail/);
  }
  const lost = openSwaps(swapList([swapItem('Jijo', 'incoming')]));
  lost.swapPanelClick('swap-accept', { 'data-swap-id': 'swap-Jijo-incoming' });
  lost.swapDialogClick('swap-confirm');
  lost.fail();
  lost.succeed(swapList([swapItem('Jijo', 'incoming')]));
  assert.match(swapText(lost), /couldn’t confirm that it saved/);
  const ended = openSwaps(swapList([swapItem('Jijo', 'incoming')]));
  ended.swapPanelClick('swap-accept', { 'data-swap-id': 'swap-Jijo-incoming' });
  ended.swapDialogClick('swap-confirm');
  ended.succeed(failure('UNAUTHENTICATED'));
  assert.equal(ended.signedIn(), false);
  assert.equal(ended.swapDialog.open, false);
  assert.equal(ended.panels.swaps.innerHTML, '');
});

test('names in the Swaps tab are escaped, and the requests never carry a roommate id of the viewer', () => {
  const hostile = swapItem('<img src=x onerror=alert(1)>', 'incoming');
  const page = openSwaps(swapList([hostile], [swapTurn('Hari', 1), swapTurn('<b>Eve</b>', 2)]));
  assert.doesNotMatch(page.panels.swaps.innerHTML, /<img|<b>/);
  page.swapPanelClick('swap-request');
  assert.doesNotMatch(page.swapDialog.innerHTML, /<b>/);
  page.swapInputs['swap-mine'].value = turn('Hari', 1).due_at;
  page.swapInputs['swap-theirs'].value = turn('<b>Eve</b>', 2).due_at;
  page.swapDialogClick('swap-send');
  assert.equal(Object.keys(page.callArguments[page.calls.length - 1][0]).sort().join(), 'partner_id,their_due_at,token,your_due_at');
});
