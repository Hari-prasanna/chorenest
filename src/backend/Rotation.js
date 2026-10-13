// Pure rotation engine: derives turns from Sheets records without reading or writing Sheets.
// `data` is { roommates, rotation, logs, vacations, swaps }, holding records of the matching sheets.
// A turn is due when its weekend ends: due_at is Monday 00:00 Berlin, exclusive, so Sunday 23:59:59 is still on time.
// Any cleaning log resolves its turn (see CLEANING_OUTCOMES).

const MAX_WEEKS_AHEAD = 1000;
const MAX_SWAP_LOOKAHEAD_TURNS = 104;

/** The open turn. A missed turn stays with its assignee, overdue, until a log resolves it. */
function getCurrentTurn_(data, now) {
  const turn = buildSchedule_(data, now, 1).turns[0];
  const time = now.getTime();
  turn.status = time < turn.opens_at.getTime() ? 'waiting' : time < turn.due_at.getTime() ? 'pending' : 'overdue';
  return turn;
}

/** The open turn and the ones after it, assuming each is resolved when due (or now, if overdue). */
function previewTurns_(data, now, count) {
  return buildSchedule_(data, now, count).turns;
}

/**
 * The log a future write operation appends when a vacation recorded during the current turn affects its assignee.
 * Run it after the vacation is saved, under a script lock, and append the result only if it is still non-null.
 * The turn counts as resolved, so the queue moves on: no make-up turn, and no priority on return.
 * Returns null when nothing needs skipping, so repeating the operation is harmless.
 */
function planVacationSkip_(data, now) {
  const turn = getCurrentTurn_(data, now);
  if (!turn.vacation_conflict_id) return null;
  return {
    rotation_id: turn.rotation_id,
    roommate_id: turn.assignee_id,
    due_date: turn.due_at,
    outcome: 'vacation_skipped',
    resolved_at: now,
    notes: 'Skipped for vacation ' + turn.vacation_conflict_id,
  };
}

/** Accepted swaps that cannot be applied as agreed. They are reported, never moved to other weeks. */
function getSwapConflicts_(data, now) {
  return buildSchedule_(data, now, 1).conflicts;
}

function buildSchedule_(data, now, count) {
  const rotation = buildRotation_(data);
  const history = readLogs_(rotation, data.logs);
  const swapHorizon = rotation.swaps.reduce(function (latest, swap) {
    return Math.max(latest, swap.fromDue, swap.toDue);
  }, 0);

  // Swaps never change who owns a turn or when it falls, so the base schedule is built without them.
  const base = [];
  let state = history.state;
  while (base.length < count || (base.length > 0 && base.length < count + MAX_SWAP_LOOKAHEAD_TURNS && base[base.length - 1].due_at.getTime() < swapHorizon)) {
    const next = nextTurn_(rotation, state);
    base.push(next.turn);
    state = {
      index: (next.index + 1) % rotation.slots.length,
      opensAt: Math.max(next.turn.due_at.getTime(), now.getTime()),
      previousSaturday: next.saturday,
    };
  }

  const swaps = applySwaps_(rotation, history.usedSwapSides, base);
  const turns = base.slice(0, count).map(function (turn, index) {
    const swap = swaps.assigned[index];
    return swap ? Object.assign({}, turn, { assignee_id: swap.partnerId, swap_id: swap.swapId, vacation_conflict_id: null }) : turn;
  });
  return { turns: turns, conflicts: swaps.conflicts };
}

function buildRotation_(data) {
  const slots = data.rotation.slice().sort(function (a, b) {
    return a.position - b.position;
  });
  if (!slots.length) throw appError_('ROTATION_EMPTY', 'The rotation is empty.');
  slots.forEach(function (slot, index) {
    if (typeof slot.position !== 'number' || !isFinite(slot.position)) throw new Error('Rotation position must be a number.');
    if (index > 0 && slot.position === slots[index - 1].position) throw new Error('Duplicate rotation position ' + slot.position + '.');
    const repeated = slots.some(function (other, otherIndex) {
      return otherIndex < index && other.roommate_id === slot.roommate_id;
    });
    if (repeated) throw new Error('Roommate ' + slot.roommate_id + ' appears twice in the rotation.');
  });

  const active = {};
  data.roommates.forEach(function (roommate) {
    if (roommate.active === true) active[roommate.roommate_id] = true;
  });
  if (!slots.some(function (slot) { return active[slot.roommate_id]; })) throw appError_('ROTATION_EMPTY', 'No active roommate is in the rotation.');

  const vacations = data.vacations.map(function (vacation) {
    const start = toTime_(vacation.start_date, 'start_date');
    const end = toTime_(vacation.return_date, 'return_date');
    if (end <= start) throw new Error('Vacation ' + vacation.vacation_id + ' must return after it starts.');
    return { id: vacation.vacation_id, roommateId: vacation.roommate_id, start: start, end: end, recordedAt: toTime_(vacation.created_at, 'created_at') };
  });

  const swaps = data.swaps
    .filter(function (swap) {
      return swap.status === 'accepted' && swap.from_roommate_id !== swap.to_roommate_id;
    })
    .map(function (swap) {
      return {
        id: swap.swap_id,
        fromId: swap.from_roommate_id,
        toId: swap.to_roommate_id,
        fromDue: toTime_(swap.from_due_date, 'from_due_date'),
        toDue: toTime_(swap.to_due_date, 'to_due_date'),
        createdAt: toTime_(swap.created_at, 'created_at'),
      };
    })
    .sort(function (a, b) {
      return a.createdAt - b.createdAt;
    });

  return { slots: slots, active: active, vacations: vacations, swaps: swaps };
}

/** Where the queue stands after the latest resolved turn, and which swap halves already have a log. */
function readLogs_(rotation, logs) {
  const usedSwapSides = {};
  let last = null;
  logs.forEach(function (log) {
    assertLogOutcome_(log);
    const index = rotation.slots.findIndex(function (slot) {
      return slot.rotation_id === log.rotation_id;
    });
    if (index === -1) throw new Error('Cleaning log ' + log.log_id + ' refers to an unknown rotation slot.');
    if (log.swap_id) usedSwapSides[swapSideKey_(log.swap_id, rotation.slots[index].roommate_id)] = true;
    const resolvedAt = toTime_(log.resolved_at, 'resolved_at');
    const dueAt = toTime_(log.due_date, 'due_date');
    if (!last || resolvedAt >= last.resolvedAt) last = { index: index, resolvedAt: resolvedAt, dueAt: dueAt };
  });

  if (last) {
    const state = { index: (last.index + 1) % rotation.slots.length, opensAt: last.resolvedAt, previousSaturday: saturdayOfDue_(last.dueAt) };
    return { state: state, usedSwapSides: usedSwapSides };
  }
  const startedAt = Math.min.apply(null, rotation.slots.map(function (slot) {
    return toTime_(slot.created_at, 'created_at');
  }));
  return { state: { index: 0, opensAt: startedAt, previousSaturday: null }, usedSwapSides: usedSwapSides };
}

/** The next turn: the first weekend after the previous turn, and the first available roommate in position order. */
function nextTurn_(rotation, state) {
  const slots = rotation.slots;
  let weekend = weekendAfter_(state.opensAt, state.previousSaturday === null ? -Infinity : state.previousSaturday + 7);
  for (let week = 0; week < MAX_WEEKS_AHEAD; week++) {
    // Vacations recorded after the assignment was decided cannot move the turn to someone else.
    const window = { start: weekend.startsAt, end: weekend.dueAt, knownAt: state.opensAt };
    const skipped = [];
    for (let step = 0; step < slots.length; step++) {
      const index = (state.index + step) % slots.length;
      const ownerId = slots[index].roommate_id;
      if (!rotation.active[ownerId]) continue;
      if (findVacation_(rotation, ownerId, window, true)) {
        skipped.push(ownerId);
        continue;
      }
      const late = findVacation_(rotation, ownerId, window, false);
      return {
        index: index,
        saturday: weekend.saturday,
        turn: {
          rotation_id: slots[index].rotation_id,
          owner_id: ownerId,
          assignee_id: ownerId,
          swap_id: null,
          skipped_ids: skipped,
          vacation_conflict_id: late ? late.id : null,
          opens_at: new Date(Math.max(state.opensAt, weekend.weekStartsAt)),
          weekend_starts_at: new Date(weekend.startsAt),
          due_at: new Date(weekend.dueAt),
        },
      };
    }
    weekend = weekendFromSaturday_(weekend.saturday + 7);
  }
  throw new Error('No roommate is available within ' + MAX_WEEKS_AHEAD + ' weeks.');
}

/**
 * Assigns each accepted swap's open turns to the partners, only if every open turn can be swapped on its agreed
 * date. A turn whose swap half already has a log is not swapped again.
 */
function applySwaps_(rotation, usedSwapSides, base) {
  const assigned = {};
  const conflicts = [];
  rotation.swaps.forEach(function (swap) {
    const sides = [
      { ownerId: swap.fromId, partnerId: swap.toId, due: swap.fromDue },
      { ownerId: swap.toId, partnerId: swap.fromId, due: swap.toDue },
    ].filter(function (side) {
      return !usedSwapSides[swapSideKey_(swap.id, side.ownerId)];
    });

    const checked = sides.map(function (side) {
      const index = base.findIndex(function (turn) {
        return turn.owner_id === side.ownerId && turn.due_at.getTime() === side.due;
      });
      const reason = index === -1 ? 'turn_not_scheduled'
        : assigned[index] ? 'turn_already_swapped'
        : !canTake_(rotation, side.partnerId, base[index]) ? 'partner_unavailable'
        : null;
      return { side: side, index: index, reason: reason };
    });

    const failed = checked.filter(function (item) {
      return item.reason;
    });
    failed.forEach(function (item) {
      conflicts.push({ swap_id: swap.id, owner_id: item.side.ownerId, due_date: new Date(item.side.due), reason: item.reason });
    });
    if (!failed.length) {
      checked.forEach(function (item) {
        assigned[item.index] = { swapId: swap.id, partnerId: item.side.partnerId };
      });
    }
  });
  return { assigned: assigned, conflicts: conflicts };
}

function canTake_(rotation, roommateId, turn) {
  const window = { start: turn.weekend_starts_at.getTime(), end: turn.due_at.getTime() };
  return rotation.active[roommateId] === true && !rotation.vacations.some(function (vacation) {
    return vacation.roommateId === roommateId && overlaps_(vacation, window);
  });
}

/** A vacation over the turn's weekend, that was recorded before (`known`) or after the assignment was decided. */
function findVacation_(rotation, roommateId, window, known) {
  return rotation.vacations.find(function (vacation) {
    return vacation.roommateId === roommateId && overlaps_(vacation, window) && (vacation.recordedAt <= window.knownAt) === known;
  });
}

function overlaps_(vacation, window) {
  return vacation.start < window.end && vacation.end > window.start;
}

function swapSideKey_(swapId, ownerId) {
  return swapId + '|' + ownerId;
}

function toTime_(value, field) {
  if (Object.prototype.toString.call(value) !== '[object Date]' || isNaN(value.getTime())) {
    throw new Error(field + ' must be a date.');
  }
  return value.getTime();
}
