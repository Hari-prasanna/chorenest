const MAX_SKIPS_PER_RUN = 10;

/**
 * Records vacation_skipped for the current turn while its assignee is away, so the rotation never stays blocked.
 * Called by getRotationSchedule when planVacationSkip_ says a skip is due, so nobody has to run anything by hand.
 * Under the script lock it re-reads the Sheet and re-plans before every write, so repeating it, or two page loads
 * at once, records each skip exactly once. It never throws: a failure is logged and the next page load retries.
 * Returns how many skips it recorded.
 */
function applyVacationSkips_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    console.error('VACATION_SKIP_BUSY');
    return 0;
  }
  let recorded = 0;
  try {
    // A skipped turn can hand the next one to someone who is also away, so repeat until nothing applies.
    while (recorded < MAX_SKIPS_PER_RUN) {
      const plan = planVacationSkip_(toRotationData_(SheetDb.listMany(ROTATION_SHEETS)), new Date());
      if (!plan) break;
      SheetDb.insert('CLEANING_LOGS', plan);
      recorded++;
    }
  } catch (error) {
    console.error(error);
  } finally {
    lock.releaseLock();
  }
  return recorded;
}
