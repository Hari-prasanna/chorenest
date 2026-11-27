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
/** The last 14 days of cleanings, newest first: a completion, a vacation skip and a turn closed by the owner. */
const cleaningHistory = () => ({
  ok: true,
  range: '14d',
  page: 1,
  page_size: 25,
  total: 3,
  pages: 1,
  entries: [
    { log_id: 'l3', roommate: person('Jijo'), weekend_starts_at: day(-1), due_at: new Date(Date.UTC(2026, 0, 11, 23)).toISOString(), outcome: 'completed', completed_at: '2026-01-11T17:30:00.000Z', resolved_at: '2026-01-11T17:30:00.000Z', swapped: false },
    { log_id: 'l2', roommate: person('Arun'), weekend_starts_at: day(-2), due_at: new Date(Date.UTC(2026, 0, 4, 23)).toISOString(), outcome: 'vacation_skipped', completed_at: null, resolved_at: '2026-01-03T08:00:00.000Z', swapped: false },
    { log_id: 'l1', roommate: person('Hari'), weekend_starts_at: day(-3), due_at: new Date(Date.UTC(2025, 11, 28, 23)).toISOString(), outcome: 'admin_resolved', completed_at: null, resolved_at: '2026-01-02T09:00:00.000Z', swapped: false },
  ],
});

/** Swaps as the server reports them for Jijo: one asked of him by Hari, plus the turns that could be swapped. */
const swapsFor = () => ({
  ok: true,
  swaps: [{
    swap_id: 'swap-1', status: 'pending', direction: 'incoming', partner: person('Hari'),
    your_due_at: new Date(Date.UTC(2026, 0, 25, 23)).toISOString(), their_due_at: new Date(Date.UTC(2026, 1, 8, 23)).toISOString(),
    your_weekend_starts_at: day(1), their_weekend_starts_at: day(3), not_applied: false, created_at: '2026-01-12T10:00:00.000Z',
  }],
  turns: [
    { owner: person('Jijo'), weekend_starts_at: day(1), due_at: new Date(Date.UTC(2026, 0, 25, 23)).toISOString() },
    { owner: person('Arun'), weekend_starts_at: day(2), due_at: new Date(Date.UTC(2026, 1, 1, 23)).toISOString() },
    { owner: person('Hari'), weekend_starts_at: day(3), due_at: new Date(Date.UTC(2026, 1, 8, 23)).toISOString() },
  ],
});

/** The admin section's account list: Hari (you, ADMIN), Jijo waiting for a first sign-in, Arun without an account. */
const accounts = () => ({
  ok: true,
  accounts: [
    { roommate_id: 'id-Hari', name: 'Hari', member_code: 'HRA-001', username: 'hari', role: 'ADMIN', status: 'active', position: 1, is_you: true },
    { roommate_id: 'id-Jijo', name: 'Jijo', member_code: 'JJX-002', username: 'jijo', role: 'ROOMMATE', status: 'temporary', position: 2, is_you: false },
    { roommate_id: 'id-Arun', name: 'Arun', member_code: 'ARN-003', username: null, role: null, status: 'none', position: 3, is_you: false },
  ],
});

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
    window.__mock = Object.assign({ delay: 0, scheduleResponses: [], vacationsResponse: null, cleanResponse: { ok: true }, responses: {}, avatars: {}, photos: {}, viewer: null, accounts: null, history: null, swaps: null }, settings);
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
            // Like the server, a good schedule says who is signed in, and lists the chosen avatars.
            const avatars = window.__mock.avatars;
            const withAvatars = answer && answer.ok === true ? { ...answer, roommates: answer.roommates.map((r) => ({ avatar: avatars[r.roommate_id] || null, ...r })) } : answer;
            return withAvatars && withAvatars.ok === true && !withAvatars.viewer && window.__mock.viewer ? { ...withAvatars, viewer: window.__mock.viewer } : withAvatars;
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
          if (name === 'getMemberProfile' && !Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) {
            const id = String(args[0].roommate_id);
            const at = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
            return {
              ok: true,
              member: { roommate_id: id, name: id.replace(/^id-/, ''), avatar: window.__mock.avatars[id] || null, is_you: Boolean(window.__mock.viewer) && window.__mock.viewer.roommate_id === id },
              stats: { completed: 12, on_time: 11, on_time_percent: 92 },
              recent: [
                { log_id: 'log-a', weekend_starts_at: at(-10), due_at: at(-8), outcome: 'completed', completed_at: at(-9), resolved_at: at(-9), swapped: false, has_photo: true, can_add_photo: false, can_delete_photo: false },
                { log_id: 'log-b', weekend_starts_at: at(-17), due_at: at(-15), outcome: 'vacation_skipped', completed_at: null, resolved_at: at(-15), swapped: false, has_photo: false, can_add_photo: false, can_delete_photo: false },
                { log_id: 'log-c', weekend_starts_at: at(-24), due_at: at(-22), outcome: 'completed', completed_at: at(-21), resolved_at: at(-21), swapped: true, has_photo: true, can_add_photo: false, can_delete_photo: false },
              ],
              next: { weekend_starts_at: at(4), due_at: at(6), current: false, covering: null },
            };
          }
          if (name === 'getLeaderboard' && !Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) {
            const period = args[0].period;
            const row = (name, rank, points, extra = {}) => ({
              rank, roommate: { roommate_id: 'id-' + name, name, avatar: null, active: true }, is_you: name === 'Hari', points,
              completed: Math.round(points / 15), on_time: Math.round(points / 15), late: 0, missed: 0, skipped: 0,
              on_time_percent: points ? 100 : null, best_streak: 3, current_streak: points ? 2 : 0, ...extra,
            });
            const scale = period === 'all' ? 4 : 1;
            return {
              ok: true, period, month: period === 'all' ? null : '2026-03',
              entries: [row('Hari', 1, 45 * scale), row('Jijo', 2, 30 * scale), row('Arun', 2, 30 * scale),
                row('Kim', 4, 15 * scale, { roommate: { roommate_id: 'id-Kim', name: 'Kim', avatar: null, active: false } })],
            };
          }
          // Photos: a stored upload comes back as it was sent; anything else is a small generated JPEG, so images really render.
          if (name === 'attachCleaningPhoto' && !Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) {
            window.__mock.photos[args[0].log_id] = args[0].photo;
            return { ok: true, log_id: args[0].log_id };
          }
          if (name === 'getCleaningPhoto' && !Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) {
            if (!window.__mock.photos[args[0].log_id]) {
              const canvas = document.createElement('canvas');
              canvas.width = 120;
              canvas.height = 90;
              const context = canvas.getContext('2d');
              context.fillStyle = '#e0b030';
              context.fillRect(0, 0, 120, 90);
              context.fillStyle = '#222';
              context.fillRect(20, 20, 50, 40);
              window.__mock.photos[args[0].log_id] = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
            }
            return { ok: true, mime_type: 'image/jpeg', data: window.__mock.photos[args[0].log_id] };
          }
          if (name === 'deleteCleaningPhoto' && !Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) {
            delete window.__mock.photos[args[0].log_id];
            return { ok: true };
          }
          if (name === 'setMyAvatar' && !Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) {
            window.__mock.avatars[window.__mock.viewer.roommate_id] = args[0].avatar;
            return { ok: true, avatar: args[0].avatar };
          }
          if (name === 'adminListAccounts') return window.__mock.accounts;
          if (name === 'listSwaps' && !Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) return window.__mock.swaps;
          if (name === 'listCleaningHistory' && !Object.prototype.hasOwnProperty.call(window.__mock.responses, name)) return { ...window.__mock.history, range: (args[0] && args[0].range) || window.__mock.history.range }; // like the server, the answer names the range
          if (name === 'adminAddRoommate' || name === 'adminProvisionAccount' || name === 'adminResetSignIn') {
            const request = args[0] || {};
            const known = (window.__mock.accounts.accounts || []).find((a) => a.roommate_id === request.roommate_id);
            const account = known || { roommate_id: 'id-New', name: request.name, member_code: 'NEW-004', username: request.username, role: request.role, status: 'temporary', position: 4, is_you: false };
            return { ok: true, account: { ...account, status: 'temporary', username: account.username || request.username }, temporary_password: 'Xy7kP3qRt9mWb2Nc', expires_at: '2026-01-16T12:00:00.000Z' };
          }
          if (name.startsWith('admin')) return { ok: true, account: (window.__mock.accounts.accounts || [])[1] };
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

module.exports = { installMock, schedule, vacations, accounts, cleaningHistory, swapsFor, person, viewerOf, FAR_FUTURE };
