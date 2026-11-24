// A mocked backend for browser tests: google.script.run is replaced by a recorder that answers after `delay` ms.
const person = (name) => ({ roommate_id: `id-${name}`, name });
const day = (offset) => new Date(Date.UTC(2026, 0, 16 + 7 * offset, 23)).toISOString();

function turn(name, weekend, extra = {}) {
  return {
    rotation_id: `slot-${name}`,
    owner: person(name),
    assignee: person(name),
    swap_id: null,
    skipped: [],
    vacation_conflict_id: null,
    opens_at: new Date(Date.UTC(2026, 0, 12 + 7 * weekend, 23)).toISOString(),
    weekend_starts_at: day(weekend),
    due_at: new Date(Date.UTC(2026, 0, 18 + 7 * weekend, 23)).toISOString(),
    ...extra,
  };
}

function schedule(extra = {}) {
  return {
    ok: true,
    environment: 'DEV',
    generated_at: '2026-01-13T12:00:00.000Z',
    current: { ...turn('Hari', 0), status: 'pending' },
    upcoming: [turn('Jijo', 1), turn('Arun', 2), turn('Hari', 3)],
    roommates: [person('Arun'), person('Hari'), person('Jijo')],
    ...extra,
  };
}

// Household vacations relative to today, one per state: Arun is away, Hari leaves in ten days, Jijo came back last week.
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (days) => new Date(Date.now() + days * DAY_MS).toISOString();
const weekend = (days, status) => ({ weekend_starts_at: at(days), due_at: at(days + 2), status });
/** The signed-in roommate as the server reports it. Hari holds the ADMIN role in these tests. */
const viewerOf = (name, extra = {}) => ({ roommate_id: `id-${name}`, name, role: name === 'Hari' ? 'ADMIN' : 'ROOMMATE', must_change_password: false, ...extra });
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

const vacations = () => ({
  ok: true,
  vacations: [
    { vacation_id: 'v-arun', roommate_id: 'id-Arun', name: 'Arun', start_date: at(-3), return_date: at(4), state: 'away', cancellable: false, weekends: [weekend(1, 'skipped')] },
    { vacation_id: 'v1', roommate_id: 'id-Hari', name: 'Hari', start_date: at(10), return_date: at(13), state: 'upcoming', cancellable: true, weekends: [weekend(11, 'not_their_turn')] },
    { vacation_id: 'v-jijo', roommate_id: 'id-Jijo', name: 'Jijo', start_date: at(-12), return_date: at(-5), state: 'returned', cancellable: false, weekends: [weekend(-10, 'past')] },
  ],
});

/** Installs the mock before the page's own scripts run. `config` is plain data, so it can cross into the browser. */
async function installMock(page, config = {}) {
  await page.addInitScript((settings) => {
    window.__mock = Object.assign({ delay: 0, scheduleResponses: [], vacationsResponse: null, cleanResponse: { ok: true }, responses: {}, viewer: null }, settings);
    window.__calls = [];
    // `hold: true` parks every answer until the test calls window.__mock.release(), so loading states can be
    // asserted without racing a timer.
    const held = [];
    window.__mock.release = () => {
      window.__mock.hold = false;
      held.splice(0).forEach((answer) => answer());
    };
    const respond = (handlers, name, args, answer) => {
      window.__calls.push({ name, args });
      if (window.__mock.hold) {
        held.push(() => respond.answer(handlers, answer));
        return;
      }
      respond.answer(handlers, answer);
    };
    respond.answer = (handlers, answer) => {
      setTimeout(() => {
        const result = typeof answer === 'function' ? answer() : answer;
        if (result && result.__network) handlers.failure(new Error('network'));
        else handlers.success(result);
      }, window.__mock.delay);
    };
    const run = (handlers) => new Proxy({}, {
      get: (_, name) => {
        if (name === 'withSuccessHandler') return (success) => run({ ...handlers, success });
        if (name === 'withFailureHandler') return (failure) => run({ ...handlers, failure });
        return (...args) => respond(handlers, name, args, () => {
          if (name === 'getRotationSchedule') {
            const queue = window.__mock.scheduleResponses;
            const answer = queue.length > 1 ? queue.shift() : queue[0];
            // Like the server, a good schedule says who is signed in.
            return answer && answer.ok === true && !answer.viewer && window.__mock.viewer ? { ...answer, viewer: window.__mock.viewer } : answer;
          }
          if (Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) {
            const answer = window.__mock.responses[name];
            if ((name === 'signIn' || name === 'changePassword') && answer && answer.ok === true) window.__mock.viewer = answer.viewer;
            return answer;
          }
          if (name === 'signIn') {
            const username = String(args[0] && args[0].username);
            const display = username.charAt(0).toUpperCase() + username.slice(1);
            window.__mock.viewer = { roommate_id: `id-${display}`, name: display, role: 'ROOMMATE', must_change_password: false };
            return { ok: true, session: { token: `token-${username}`, expires_at: '2099-01-01T00:00:00.000Z' }, viewer: window.__mock.viewer };
          }
          if (name === 'changePassword') {
            window.__mock.viewer = { ...window.__mock.viewer, must_change_password: false };
            return { ok: true, session: { token: 'token-changed', expires_at: '2099-01-01T00:00:00.000Z' }, viewer: window.__mock.viewer };
          }
          if (name === 'listVacations') return window.__mock.vacationsResponse;
          if (name === 'markCleaned') return window.__mock.cleanResponse;
          // Other calls (saveVacation, updateVacation, endVacation, ...) answer from `responses` by name, or succeed.
          if (Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) return window.__mock.responses[name];
          return { ok: true, changed: true };
        });
      },
    });
    window.google = { script: { run: run({}) } };
  }, config);
}

module.exports = { installMock, schedule, vacations, person, viewerOf, FAR_FUTURE };
