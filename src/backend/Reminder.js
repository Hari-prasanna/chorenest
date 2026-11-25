/**
 * The scheduled Friday reminder: one weekly time-driven trigger (Friday, REMINDER_HOUR, Europe/Berlin) runs
 * runFridayReminder, which reuses Telegram.js for the message and the send.
 *
 * Exactly once per reminder week. The week is the Berlin date of that Friday. Before sending, the run claims the week
 * in the Script Property REMINDER_STATE under the script lock ({ week, status, at }), so a second or concurrent
 * execution for the same week sends nothing. After the send the claim becomes:
 *   sent         Telegram confirmed it.
 *   failed       certainly not delivered (not configured, rejected, 4xx, the message could not be built): the week is
 *                released, so running it again may send.
 *   unconfirmed  it may have been delivered (no answer, 5xx, unreadable answer): never retried automatically. The
 *                owner checks the chat and, if nothing arrived, deletes REMINDER_STATE before running it again.
 * A dry run (DEV by default) never reads or writes REMINDER_STATE, so it cannot use up the real week.
 *
 * It also acts only on a Berlin Friday between 08:30 and 12:00, so even a valid trigger event cannot send early or late.
 *
 * runFridayReminder has to be a top-level function for the trigger, so the browser could name it; it refuses unless it
 * was started by this project's own reminder trigger. Installing and removing the trigger are private helpers, reached
 * only through the temporary editor wrappers.
 */
const REMINDER_HANDLER = 'runFridayReminder';
const REMINDER_HOUR = 9; // 09:00-10:00 Berlin, whatever the season
const REMINDER_TIME_ZONE = 'Europe/Berlin';
const REMINDER_STATE_KEY = 'REMINDER_STATE';
const REMINDER_RETRY_STATUSES = ['failed'];
// The trigger fires 09:00-10:00 Berlin but can run late; outside 08:30-12:00 Berlin on a Friday the run does nothing.
const REMINDER_WINDOW_START_MINUTE = 8 * 60 + 30;
const REMINDER_WINDOW_END_MINUTE = 12 * 60;

/** Trigger handler. `event` is the time-driven trigger's event object; anything else is refused. */
function runFridayReminder(event) {
  if (!isReminderTrigger_(event)) {
    console.log('Reminder refused: not started by the reminder trigger.');
    return { ok: false, error: 'NOT_A_TRIGGER' };
  }
  return runScheduledReminder_(new Date());
}

function isReminderTrigger_(event) {
  if (!event || typeof event !== 'object' || typeof event.triggerUid !== 'string' || !event.triggerUid) return false;
  try {
    return ScriptApp.getProjectTriggers().some(function (trigger) {
      return trigger.getUniqueId() === event.triggerUid && trigger.getHandlerFunction() === REMINDER_HANDLER;
    });
  } catch (error) {
    return false;
  }
}

/** The reminder week: the Berlin calendar date of the Friday, "YYYY-MM-DD". */
function reminderWeek_(now) {
  return new Date(berlinDay_(now.getTime()) * CALENDAR_DAY_MS).toISOString().slice(0, 10);
}

function isBerlinFriday_(now) {
  return new Date(berlinDay_(now.getTime()) * CALENDAR_DAY_MS).getUTCDay() === 5;
}

/** True from 08:30 up to (not including) 12:00 Berlin time. */
function isReminderWindow_(now) {
  const local = now.getTime() + berlinOffsetMs_(now.getTime());
  const minute = Math.floor((((local % CALENDAR_DAY_MS) + CALENDAR_DAY_MS) % CALENDAR_DAY_MS) / 60000);
  return minute >= REMINDER_WINDOW_START_MINUTE && minute < REMINDER_WINDOW_END_MINUTE;
}

function readReminderState_() {
  try {
    const state = JSON.parse(PropertiesService.getScriptProperties().getProperty(REMINDER_STATE_KEY) || 'null');
    return state && typeof state.week === 'string' && typeof state.status === 'string' ? state : null;
  } catch (error) {
    return null; // an unreadable value counts as no claim; it is replaced by the next real run
  }
}

function writeReminderState_(week, status, now) {
  PropertiesService.getScriptProperties().setProperty(REMINDER_STATE_KEY, JSON.stringify({ week: week, status: status, at: now.toISOString() }));
}

/** Under the script lock: claims `week` unless a run already sent, is sending or may have sent it. Returns the claim result. */
function claimReminderWeek_(week, now) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { claimed: false, reason: 'BUSY' };
  try {
    const state = readReminderState_();
    if (state && state.week === week && REMINDER_RETRY_STATUSES.indexOf(state.status) === -1) {
      return { claimed: false, reason: state.status === 'sent' ? 'ALREADY_SENT' : state.status === 'sending' ? 'IN_PROGRESS' : 'UNCONFIRMED' };
    }
    writeReminderState_(week, 'sending', now);
    return { claimed: true };
  } finally {
    lock.releaseLock();
  }
}

/** Under the script lock again: records how the claimed week ended. Never throws (the result is logged as a code). */
function finishReminderWeek_(week, status, now) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    // The claim stays "sending", which also blocks any retry: the safe outcome.
    console.error('REMINDER_STATE_NOT_SAVED');
    return;
  }
  try {
    const state = readReminderState_();
    if (state && state.week === week) writeReminderState_(week, status, now);
  } finally {
    lock.releaseLock();
  }
}

/**
 * The weekly run. Never throws. Returns { ok, week, dryRun?, skipped?, status?, error?, text? }:
 *   skipped NOT_FRIDAY | OUTSIDE_WINDOW | ALREADY_SENT | IN_PROGRESS | UNCONFIRMED  nothing was sent
 *   status  sent | failed | unconfirmed                             what happened to this week's message
 */
function runScheduledReminder_(now) {
  const week = reminderWeek_(now);
  if (!isBerlinFriday_(now)) return { ok: true, week: week, skipped: 'NOT_FRIDAY' };
  if (!isReminderWindow_(now)) return { ok: true, week: week, skipped: 'OUTSIDE_WINDOW' };
  let config;
  try {
    config = readTelegramConfig_();
  } catch (error) {
    console.error('REMINDER_NOT_CONFIGURED');
    return { ok: false, week: week, error: 'REMINDER_NOT_CONFIGURED' };
  }
  // The same locked reconciliation a page load does, so the message names who really cleans this weekend.
  applyVacationSkips_();

  if (config.dryRun) {
    const dry = sendFridayReminder_();
    return { ok: dry.ok, week: week, dryRun: true, text: dry.text, error: dry.error, missing: dry.missing };
  }

  const claim = claimReminderWeek_(week, now);
  if (!claim.claimed) {
    console.log('Reminder skipped: ' + claim.reason);
    return { ok: claim.reason !== 'BUSY', week: week, skipped: claim.reason };
  }
  const sent = sendFridayReminder_();
  const status = sent.delivered === 'yes' ? 'sent' : sent.delivered === 'no' ? 'failed' : 'unconfirmed';
  finishReminderWeek_(week, status, new Date());
  console.log('Reminder ' + week + ': ' + status);
  return { ok: sent.ok, week: week, dryRun: false, status: status, error: sent.error };
}

// ---------- installing (owner only, through the editor wrappers) ----------

function reminderTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === REMINDER_HANDLER;
  });
}

/** Replaces any reminder trigger with exactly one: Fridays, REMINDER_HOUR, Europe/Berlin. Sends nothing. */
function installFridayReminder_() {
  assertMaintenanceAllowed_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Another save is running. Try again in a moment.');
  try {
    reminderTriggers_().forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
    ScriptApp.newTrigger(REMINDER_HANDLER).timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(REMINDER_HOUR).inTimezone(REMINDER_TIME_ZONE).create();
  } finally {
    lock.releaseLock();
  }
  const summary = 'Friday reminder scheduled: every Friday between ' + REMINDER_HOUR + ':00 and ' + (REMINDER_HOUR + 1) + ':00 Berlin time.';
  console.log(summary);
  return summary;
}

function removeFridayReminder_() {
  assertMaintenanceAllowed_();
  const triggers = reminderTriggers_();
  triggers.forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  const summary = triggers.length ? 'Friday reminder removed.' : 'There was no Friday reminder to remove.';
  console.log(summary);
  return summary;
}
