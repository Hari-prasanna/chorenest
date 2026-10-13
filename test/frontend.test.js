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
  const root = element();
  const toggle = element();
  const buttons = ['light', 'dark', 'system'].map((choice) => {
    const button = element();
    button.attributes['data-choice'] = choice;
    return button;
  });
  toggle.querySelectorAll = () => buttons;

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
  };
  const elements = { 'theme-toggle': toggle, 'who-text': whoText };
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
  vm.runInContext(scriptOf('Identity.html'), context);
  vm.runInContext(scriptOf('App.html'), context);

  return {
    app,
    whoText,
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
  assert.doesNotMatch(page.app.innerHTML, /<(button|form|input|textarea|a )/);
  assert.equal(page.app.innerHTML.match(/<select/g).length, 1);
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
    'frontend/Identity',
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

test('the only buttons are the theme choices and Try again, and there is no navigation', () => {
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
      assert.match(button, /data-choice="|data-action="retry"/, `${file}: ${button}`);
    }
    assert.doesNotMatch(source, /<(nav|a|form|input|textarea)\b|href=/, file);
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

test('the pick never reaches the server and grants nothing', () => {
  const page = loadFrontend();
  page.succeed(schedule());
  page.pick('id-Hari');
  page.fail();
  page.clickRetry();
  assert.deepEqual(page.callArguments, [[], []], 'every getRotationSchedule call has no arguments, so the pick is never sent');
  assert.deepEqual([...page.storage.keys()], [ROOMMATE_KEY]);

  // Everything outside the greeting section is identical whoever is picked.
  const withoutGreeting = (html) => html.replace(/<section class="who"[\s\S]*?<\/section>/, '');
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
    assert.doesNotMatch(source, /\badmin\b|\bpermissions?\b|\brole\b(?!=)/i, file);
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
  for (const selector of ['.theme-toggle button:focus-visible', '.button:focus-visible', '.who-select:focus-visible']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /\.button:active/);
});
