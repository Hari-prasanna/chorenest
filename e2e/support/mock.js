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

const vacations = () => ({
  ok: true,
  vacations: [{
    vacation_id: 'v1', roommate_id: 'id-Hari', name: 'Hari', start_date: '2026-01-08T23:00:00.000Z', return_date: '2026-01-11T23:00:00.000Z',
    state: 'upcoming', cancellable: true, weekends: [{ weekend_starts_at: '2026-01-09T23:00:00.000Z', due_at: '2026-01-11T23:00:00.000Z', status: 'skipped' }],
  }],
});

/** Installs the mock before the page's own scripts run. `config` is plain data, so it can cross into the browser. */
async function installMock(page, config = {}) {
  await page.addInitScript((settings) => {
    window.__mock = Object.assign({ delay: 0, scheduleResponses: [], vacationsResponse: null, cleanResponse: { ok: true } }, settings);
    window.__calls = [];
    const respond = (handlers, name, args, answer) => {
      window.__calls.push({ name, args });
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
            return queue.length > 1 ? queue.shift() : queue[0];
          }
          if (name === 'listVacations') return window.__mock.vacationsResponse;
          if (name === 'markCleaned') return window.__mock.cleanResponse;
          return { ok: true };
        });
      },
    });
    window.google = { script: { run: run({}) } };
  }, config);
}

module.exports = { installMock, schedule, vacations, person };
