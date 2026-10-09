// TEMPORARY (Slice 04A DEV verification). Delete this file and test/devSeed.test.js once DEV holds real roommates.

const DEV_SEED_ROOMMATES = [
  { name: 'Hari', email: 'hari@chorenest.invalid', position: 1 },
  { name: 'Jijo', email: 'jijo@chorenest.invalid', position: 2 },
  { name: 'Arun', email: 'arun@chorenest.invalid', position: 3 },
];

/**
 * DEV-only: adds the sample roommates and their rotation positions if they are missing.
 * Matches roommates by email, never edits or deletes rows, and writes nothing if a position belongs to someone else.
 * Run manually from the Apps Script editor.
 */
function seedDevRotation() {
  assertScriptOwner_();
  if (getEnvironment() !== 'DEV') throw new Error('seedDevRotation is only available in DEV.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another seed run is in progress.');
  try {
    const records = SheetDb.listMany(['ROOMMATES', 'ROTATION']);
    // Plan every step before writing, so a conflict leaves the spreadsheet untouched.
    const plan = DEV_SEED_ROOMMATES.map(function (seed) {
      const matches = records.ROOMMATES.filter(function (roommate) {
        return roommate.email === seed.email;
      });
      if (matches.length > 1) throw new Error('More than one roommate has email ' + seed.email + '. No changes made.');
      const roommate = matches[0] || null;
      const slot = roommate ? records.ROTATION.find(function (s) { return s.roommate_id === roommate.roommate_id; }) || null : null;
      if (!slot && records.ROTATION.some(function (s) { return s.position === seed.position; })) {
        throw new Error('Rotation position ' + seed.position + ' is already used. No changes made.');
      }
      return { seed: seed, roommate: roommate, slot: slot };
    });

    const summary = plan.map(function (step) {
      const roommate = step.roommate || SheetDb.insert('ROOMMATES', { name: step.seed.name, email: step.seed.email, active: true });
      if (!step.slot) SheetDb.insert('ROTATION', { position: step.seed.position, roommate_id: roommate.roommate_id });
      return step.seed.name + ': ' + (step.roommate ? 'existing roommate' : 'added roommate') + ', ' +
        (step.slot ? 'existing position ' + step.slot.position : 'added position ' + step.seed.position);
    });
    console.log(summary.join('\n'));
    return summary;
  } finally {
    lock.releaseLock();
  }
}
