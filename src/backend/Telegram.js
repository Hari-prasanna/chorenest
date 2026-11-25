/**
 * Telegram reminders through the existing Neatify bot. Everything here is private (trailing "_"): nothing is
 * browser-callable. Reminder.js runs it from the weekly trigger.
 *
 * Script Properties:
 *   TELEGRAM_BOT_TOKEN  the bot token (never logged, never returned, never put in an error)
 *   TELEGRAM_CHAT_ID    the household chat: a number such as -1001234567890, or @channelname
 *   APP_URL             the https address of the web app, shown as the link in the message
 *   TELEGRAM_DRY_RUN    "true" or "false". DEV defaults to dry-run (nothing is sent unless it is "false");
 *                       PROD sends unless it is "true".
 *
 * A dry run builds the real message from the real rotation engine and returns it without any network call. Sending
 * never throws and never takes the script lock: a Telegram problem is reported as a short code and cannot affect
 * cleaning, vacations or swaps. Only fixed codes are logged.
 */
const TELEGRAM_API = 'https://api.telegram.org/bot';
const TELEGRAM_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT_PATTERN = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const APP_URL_PATTERN = /^https:\/\/[^\s<>"']{4,200}$/;
const TELEGRAM_MAX_TEXT = 1000;
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- configuration ----------

/** Dry run unless the property says otherwise: DEV needs an explicit "false" to send, PROD an explicit "true" to stay quiet. */
function telegramDryRun_(environment, value) {
  const setting = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (environment === 'PROD') return setting === 'true';
  return setting !== 'false';
}

/**
 * Reads and checks the configuration. Returns { dryRun, token, chatId, appUrl, missing }, where `missing` names the
 * properties that are absent or malformed (names only, never values).
 */
function readTelegramConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const read = function (key) {
    return String(properties.getProperty(key) || '').trim();
  };
  const token = read('TELEGRAM_BOT_TOKEN');
  const chatId = read('TELEGRAM_CHAT_ID');
  const appUrl = read('APP_URL');
  const missing = [];
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) missing.push('TELEGRAM_BOT_TOKEN');
  if (!TELEGRAM_CHAT_PATTERN.test(chatId)) missing.push('TELEGRAM_CHAT_ID');
  if (!APP_URL_PATTERN.test(appUrl)) missing.push('APP_URL');
  return {
    dryRun: telegramDryRun_(getEnvironment_(), properties.getProperty('TELEGRAM_DRY_RUN')),
    token: token,
    chatId: chatId,
    appUrl: APP_URL_PATTERN.test(appUrl) ? appUrl : '',
    missing: missing,
  };
}

// ---------- the message ----------

function berlinDateParts_(ms) {
  const date = new Date(berlinDay_(ms) * CALENDAR_DAY_MS);
  return { weekday: WEEKDAY_NAMES[date.getUTCDay()], day: date.getUTCDate(), month: MONTH_NAMES[date.getUTCMonth()] };
}

/** "Sat 24 – Sun 25 Jan", in Berlin time, from a turn's weekend start and due time (Monday 00:00, exclusive). */
function weekendLabel_(turn) {
  const saturday = berlinDateParts_(turn.weekend_starts_at.getTime());
  const sunday = berlinDateParts_(turn.due_at.getTime() - 1);
  return saturday.weekday + ' ' + saturday.day + (saturday.month === sunday.month ? '' : ' ' + saturday.month) + ' – ' + sunday.weekday + ' ' + sunday.day + ' ' + sunday.month;
}

/**
 * The turns a reminder is about, as the schedule page would show them: the current turn (overdue if its weekend has
 * passed without a log) and the one after it. A current turn that a vacation will skip is left out, because the next
 * page load records that skip; nothing is written here.
 */
function reminderTurns_(data, now) {
  // Add the skips applyVacationSkips_ would record (in memory only), so the turns match the page after that load.
  let planned = data;
  for (let i = 0; i < MAX_SKIPS_PER_RUN; i++) {
    const plan = planVacationSkip_(planned, now);
    if (!plan) break;
    planned = Object.assign({}, planned, { logs: planned.logs.concat([plan]) });
  }
  const turns = previewTurns_(planned, now, 2);
  const time = now.getTime();
  const current = turns[0];
  const status = time < current.opens_at.getTime() ? 'waiting' : time < current.due_at.getTime() ? 'pending' : 'overdue';
  return { current: current, next: turns[1] || null, status: status };
}

function turnPerson_(turn, names) {
  const assignee = Object.prototype.hasOwnProperty.call(names, turn.assignee_id) ? names[turn.assignee_id] : 'Someone';
  const owner = Object.prototype.hasOwnProperty.call(names, turn.owner_id) ? names[turn.owner_id] : 'Someone';
  return { name: assignee, swappedFrom: turn.assignee_id !== turn.owner_id ? owner : null };
}

/** Plain text only (no Markdown or HTML), so a name cannot break the message. */
function buildFridayReminder_(records, now, appUrl) {
  const names = {};
  records.ROOMMATES.forEach(function (roommate) {
    names[roommate.roommate_id] = String(roommate.name);
  });
  const picked = reminderTurns_(toRotationData_(records), now);
  const current = turnPerson_(picked.current, names);
  const lines = ['🧹 ChoreNest reminder'];
  if (picked.status === 'overdue') {
    lines.push('⚠️ ' + current.name + ' hasn’t cleaned yet: the turn for ' + weekendLabel_(picked.current) + ' is overdue.');
  } else {
    lines.push('Cleaning weekend ' + weekendLabel_(picked.current) + ': ' + current.name + ' is up.');
  }
  if (current.swappedFrom) lines.push('(Swapped turn: it is normally ' + current.swappedFrom + '’s.)');
  if (picked.next) {
    const next = turnPerson_(picked.next, names);
    lines.push((picked.status === 'overdue' ? 'After that: ' : 'Next: ') + next.name + ' (' + weekendLabel_(picked.next) + ').');
  }
  if (appUrl) lines.push('Mark it done: ' + appUrl);
  const text = lines.join('\n');
  return text.length > TELEGRAM_MAX_TEXT ? text.slice(0, TELEGRAM_MAX_TEXT - 1) + '…' : text;
}

// ---------- sending ----------

/**
 * Sends one text message. Never throws. Returns { ok, delivered, error? }:
 *   delivered 'yes'      Telegram confirmed it.
 *   delivered 'no'       certainly not delivered: TELEGRAM_NOT_CONFIGURED, TELEGRAM_RATE_LIMITED, TELEGRAM_REJECTED
 *                        (Telegram answered ok: false) or TELEGRAM_HTTP_<4xx>. Safe to try again.
 *   delivered 'unknown'  the request may have arrived: TELEGRAM_UNREACHABLE (no answer, for example a timeout),
 *                        TELEGRAM_HTTP_<5xx> or TELEGRAM_UNCONFIRMED (an answer that cannot be read). Retrying could
 *                        send the message twice, so callers must not retry blindly.
 * The token only ever appears in the request URL; no message, log line or result contains it.
 */
function sendTelegramMessage_(config, text) {
  if (config.missing.length || !config.token || !config.chatId) return { ok: false, delivered: 'no', error: 'TELEGRAM_NOT_CONFIGURED' };
  let response;
  try {
    response = UrlFetchApp.fetch(TELEGRAM_API + config.token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: config.chatId, text: text, disable_web_page_preview: true }),
      muteHttpExceptions: true,
    });
  } catch (error) {
    // The error text can contain the request URL, and with it the token: it is dropped, only the code is kept.
    // The request may have reached Telegram before the failure (a timeout, say), so delivery is unknown.
    return { ok: false, delivered: 'unknown', error: 'TELEGRAM_UNREACHABLE' };
  }
  let status = 0;
  let body = null;
  try {
    status = response.getResponseCode();
  } catch (error) {
    status = 0;
  }
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    body = null; // an unreadable answer is judged by its status alone
  }
  if (status === 200 && body && body.ok === true) return { ok: true, delivered: 'yes' };
  if (status === 200 && body && body.ok === false) return { ok: false, delivered: 'no', error: 'TELEGRAM_REJECTED' };
  if (status === 429) return { ok: false, delivered: 'no', error: 'TELEGRAM_RATE_LIMITED' };
  if (status >= 400 && status < 500) return { ok: false, delivered: 'no', error: 'TELEGRAM_HTTP_' + status };
  if (status >= 500 && status < 600) return { ok: false, delivered: 'unknown', error: 'TELEGRAM_HTTP_' + status };
  return { ok: false, delivered: 'unknown', error: 'TELEGRAM_UNCONFIRMED' };
}

/**
 * Builds the Friday reminder from the Sheet and sends it once (or, in a dry run, returns it). Never throws and never
 * writes to the Sheet. It does not deduplicate: the scheduled run (Reminder.js) does that around it.
 * Returns { ok, dryRun, delivered?, text?, error?, missing? }:
 *   dry run  -> { ok: true, dryRun: true, text, missing } (missing: properties a real send would need)
 *   sent     -> { ok: true, dryRun: false, delivered: 'yes', text }
 *   failed   -> { ok: false, dryRun, delivered: 'no' | 'unknown', error: <fixed code>, missing? }
 */
function sendFridayReminder_() {
  let config;
  let text;
  try {
    config = readTelegramConfig_();
    text = buildFridayReminder_(SheetDb.listMany(ROTATION_SHEETS), new Date(), config.appUrl);
  } catch (error) {
    console.error(error.code || 'REMINDER_NOT_BUILT');
    return { ok: false, dryRun: config ? config.dryRun : true, delivered: 'no', error: 'REMINDER_NOT_BUILT' };
  }
  if (config.dryRun) {
    console.log('Telegram dry run: nothing sent.');
    return { ok: true, dryRun: true, text: text, missing: config.missing };
  }
  const sent = sendTelegramMessage_(config, text);
  console.log(sent.ok ? 'Telegram reminder sent.' : 'Telegram reminder failed: ' + sent.error);
  return sent.ok
    ? { ok: true, dryRun: false, delivered: 'yes', text: text }
    : { ok: false, dryRun: false, delivered: sent.delivered, error: sent.error, missing: config.missing };
}

/** Owner-only preview for the editor: the message exactly as it would be sent, never sent. */
function previewFridayReminder_() {
  assertMaintenanceAllowed_();
  const config = readTelegramConfig_();
  const text = buildFridayReminder_(SheetDb.listMany(ROTATION_SHEETS), new Date(), config.appUrl);
  console.log(text);
  return { text: text, wouldSend: !config.dryRun && config.missing.length === 0, missing: config.missing };
}
