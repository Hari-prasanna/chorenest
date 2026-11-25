/**
 * Browser API for temporary turn swaps between two roommates (one weekend each), stored in SWAPS.
 *   status: pending  -> accepted | declined (by the receiving roommate) | cancelled (by the requester)
 * Only an accepted row changes who cleans, and only on those two weekends: the rotation engine assigns each turn to
 * the partner on its agreed date (applySwaps_). ROTATION, ownership and the order are never changed, and nothing in
 * CLEANING_LOGS is touched. Who is acting always comes from the session. Every check and write runs under the script
 * lock against the Sheet as it is now.
 */
const SWAP_HORIZON_TURNS = 26; // about half a year of turns can be swapped
const SWAP_TRIAL_ID = '__swap_trial__';
const SWAP_TURN_LIST_LIMIT = 16;

function swapCall_(request, fields, work) {
  let locked = false;
  const lock = LockService.getScriptLock();
  try {
    swapRequestShape_(request, fields);
    if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Someone else is saving right now.');
    locked = true;
    const records = SheetDb.listMany(ROTATION_SHEETS);
    const session = sessionOf_(request, records.ROOMMATES);
    return work(session, records, new Date());
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  } finally {
    if (locked) lock.releaseLock();
  }
}

/** Only known fields, all text: 'id' fields are row IDs, 'time' fields ISO UTC timestamps (a turn's due_at). */
function swapRequestShape_(request, fields) {
  const allowed = ['token'].concat(Object.keys(fields));
  const valid = Boolean(request) && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).every(function (field) {
      return allowed.indexOf(field) !== -1;
    }) &&
    typeof request.token === 'string' &&
    Object.keys(fields).every(function (field) {
      const value = asText_(request[field]);
      return fields[field] === 'id' ? ID_PATTERN.test(value) : ISO_UTC_PATTERN.test(value) && !isNaN(Date.parse(value));
    });
  if (!valid) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
}

function sameTurn_(ownerId, dueMs, swapOwnerId, swapDue) {
  return ownerId === swapOwnerId && Object.prototype.toString.call(swapDue) === '[object Date]' && swapDue.getTime() === dueMs;
}

/** A pending or accepted swap (other than `exceptId`) that already involves this turn, or undefined. */
function swapUsingTurn_(swaps, ownerId, dueMs, exceptId) {
  return swaps.filter(function (swap) {
    return swap.swap_id !== exceptId && (swap.status === 'pending' || swap.status === 'accepted') &&
      (sameTurn_(ownerId, dueMs, swap.from_roommate_id, swap.from_due_date) || sameTurn_(ownerId, dueMs, swap.to_roommate_id, swap.to_due_date));
  })[0];
}

/**
 * Throws unless `plan` ({ fromId, toId, fromDue, toDue } in ms) swaps two upcoming turns that each still belong to
 * their owner, whose weekends have not started, that no other pending or accepted swap uses, and that the rotation
 * engine would actually apply (both people active and not away that weekend).
 */
function checkSwap_(records, now, plan, exceptId) {
  if (plan.fromId === plan.toId) throw appError_('SWAP_SELF', 'A swap needs two different roommates.');
  const data = toRotationData_(records);
  let turns;
  try {
    turns = previewTurns_(data, now, SWAP_HORIZON_TURNS);
  } catch (error) {
    throw error.code ? error : appError_('ROTATION_DATA_INVALID', String(error.message));
  }
  [[plan.fromId, plan.fromDue], [plan.toId, plan.toDue]].forEach(function (side) {
    const turn = turns.filter(function (candidate) {
      return candidate.owner_id === side[0] && candidate.due_at.getTime() === side[1];
    })[0];
    if (!turn) throw appError_('SWAP_TURN_NOT_FOUND', 'That turn is not upcoming for that roommate.');
    if (turn.weekend_starts_at.getTime() <= now.getTime()) throw appError_('SWAP_TURN_STARTED', 'That weekend has started.');
    if (turn.swap_id || turn.assignee_id !== turn.owner_id) throw appError_('SWAP_TURN_TAKEN', 'That turn is already swapped.');
    if (swapUsingTurn_(records.SWAPS, side[0], side[1], exceptId)) throw appError_('SWAP_TURN_TAKEN', 'That turn is in another swap request.');
  });

  // Ask the engine: would this swap be applied as agreed if it were accepted now?
  const trial = Object.assign({}, data, {
    swaps: data.swaps.concat([{
      swap_id: SWAP_TRIAL_ID, from_roommate_id: plan.fromId, to_roommate_id: plan.toId,
      from_due_date: new Date(plan.fromDue), to_due_date: new Date(plan.toDue), status: 'accepted', created_at: new Date(now.getTime() + 1),
    }]),
  });
  const conflicts = getSwapConflicts_(trial, now).filter(function (conflict) {
    return conflict.swap_id === SWAP_TRIAL_ID;
  });
  if (conflicts.some(function (conflict) { return conflict.reason === 'partner_unavailable'; })) {
    throw appError_('SWAP_PARTNER_UNAVAILABLE', 'One of them is away or inactive that weekend.');
  }
  if (conflicts.length) throw appError_('SWAP_TURN_TAKEN', 'The engine could not apply the swap: ' + conflicts[0].reason);
}

function swapPlanOf_(swap) {
  return { fromId: swap.from_roommate_id, toId: swap.to_roommate_id, fromDue: swap.from_due_date.getTime(), toDue: swap.to_due_date.getTime() };
}

/** The pending swap with this ID that `roommateId` may act on as `side` ('to' answers, 'from' cancels). */
function pendingSwapFor_(records, swapId, roommateId, side) {
  const swap = records.SWAPS.filter(function (row) {
    return row.swap_id === swapId;
  })[0];
  if (!swap) throw appError_('SWAP_NOT_FOUND', 'No such swap.');
  if ((side === 'to' ? swap.to_roommate_id : swap.from_roommate_id) !== roommateId) throw appError_('SWAP_NOT_YOURS', 'Not this roommate’s swap to change.');
  if (swap.status !== 'pending') throw appError_('SWAP_NOT_PENDING', 'Already ' + swap.status + '.');
  return swap;
}

/** The Saturday 00:00 Berlin of the weekend that ends at `due` (a Date), as an ISO string. */
function weekendStartIso_(due) {
  return new Date(weekendFromSaturday_(saturdayOfDue_(due.getTime())).startsAt).toISOString();
}

/** `notApplied`: an accepted swap the rotation engine cannot apply as agreed (see getSwapConflicts_). */
function swapToJson_(swap, viewerId, names, notApplied) {
  const outgoing = swap.from_roommate_id === viewerId;
  const partnerId = outgoing ? swap.to_roommate_id : swap.from_roommate_id;
  return {
    swap_id: swap.swap_id,
    status: swap.status,
    direction: outgoing ? 'outgoing' : 'incoming',
    partner: { roommate_id: partnerId, name: Object.prototype.hasOwnProperty.call(names, partnerId) ? names[partnerId] : null },
    // "Your" turn is the one you own and give away; "their" turn is the one you take over.
    your_due_at: (outgoing ? swap.from_due_date : swap.to_due_date).toISOString(),
    their_due_at: (outgoing ? swap.to_due_date : swap.from_due_date).toISOString(),
    your_weekend_starts_at: weekendStartIso_(outgoing ? swap.from_due_date : swap.to_due_date),
    their_weekend_starts_at: weekendStartIso_(outgoing ? swap.to_due_date : swap.from_due_date),
    not_applied: notApplied === true,
    created_at: isHistoryDate_(swap.created_at) ? swap.created_at.toISOString() : null,
  };
}

// ---------- browser API ----------

/**
 * Request: { token, your_due_at, partner_id, their_due_at }: give your upcoming turn (due your_due_at) to partner_id
 * and take theirs (due their_due_at). Returns { ok, swap } with status pending.
 */
function requestSwap(request) {
  return swapCall_(request, { your_due_at: 'time', partner_id: 'id', their_due_at: 'time' }, function (session, records, now) {
    const plan = { fromId: session.roommateId, toId: request.partner_id, fromDue: Date.parse(request.your_due_at), toDue: Date.parse(request.their_due_at) };
    checkSwap_(records, now, plan, null);
    const stored = SheetDb.insert('SWAPS', {
      from_roommate_id: plan.fromId, to_roommate_id: plan.toId, from_due_date: new Date(plan.fromDue), to_due_date: new Date(plan.toDue), status: 'pending',
    });
    return { ok: true, swap: swapToJson_(stored, session.roommateId, rosterNames_(records)) };
  });
}

/** Request: { token, swap_id }. Only the receiving roommate; checked again, so a swap that no longer fits is refused. */
function acceptSwap(request) {
  return swapCall_(request, { swap_id: 'id' }, function (session, records, now) {
    const swap = pendingSwapFor_(records, request.swap_id, session.roommateId, 'to');
    try {
      checkSwap_(records, now, swapPlanOf_(swap), swap.swap_id);
    } catch (error) {
      if (error.code === 'BUSY' || error.code === 'ROTATION_DATA_INVALID') throw error;
      throw appError_('SWAP_STALE', 'No longer fits: ' + error.message);
    }
    SheetDb.update('SWAPS', swap.swap_id, { status: 'accepted' });
    return { ok: true, swap: swapToJson_(Object.assign({}, swap, { status: 'accepted' }), session.roommateId, rosterNames_(records)) };
  });
}

/** Request: { token, swap_id }. Only the receiving roommate. */
function declineSwap(request) {
  return swapCall_(request, { swap_id: 'id' }, function (session, records) {
    const swap = pendingSwapFor_(records, request.swap_id, session.roommateId, 'to');
    SheetDb.update('SWAPS', swap.swap_id, { status: 'declined' });
    return { ok: true };
  });
}

/** Request: { token, swap_id }. Only the requester, while still pending. */
function cancelSwap(request) {
  return swapCall_(request, { swap_id: 'id' }, function (session, records) {
    const swap = pendingSwapFor_(records, request.swap_id, session.roommateId, 'from');
    SheetDb.update('SWAPS', swap.swap_id, { status: 'cancelled' });
    return { ok: true };
  });
}

/**
 * Request: { token }. Read-only. Returns { ok, swaps, turns }: your pending and accepted swaps whose weekends have not
 * both passed, newest first (an accepted one the engine cannot apply is flagged not_applied), and `turns`, the upcoming
 * turns anyone could still swap (weekend not started, still with their owner, in no pending or accepted swap).
 */
function listSwaps(request) {
  try {
    authRequest_(request, ['token']);
    const records = SheetDb.listMany(ROTATION_SHEETS);
    const session = sessionOf_(request, records.ROOMMATES);
    const clock = new Date();
    const now = clock.getTime();
    const names = rosterNames_(records);
    const data = toRotationData_(records);
    let upcoming;
    let unapplied;
    try {
      upcoming = previewTurns_(data, clock, SWAP_HORIZON_TURNS);
      unapplied = {};
      getSwapConflicts_(data, clock).forEach(function (conflict) {
        unapplied[conflict.swap_id] = true;
      });
    } catch (error) {
      throw error.code ? error : appError_('ROTATION_DATA_INVALID', String(error.message));
    }
    const turns = upcoming
      .filter(function (turn) {
        return turn.weekend_starts_at.getTime() > now && !turn.swap_id && turn.assignee_id === turn.owner_id &&
          !swapUsingTurn_(records.SWAPS, turn.owner_id, turn.due_at.getTime(), null);
      })
      .slice(0, SWAP_TURN_LIST_LIMIT)
      .map(function (turn) {
        return {
          owner: { roommate_id: turn.owner_id, name: Object.prototype.hasOwnProperty.call(names, turn.owner_id) ? names[turn.owner_id] : null },
          weekend_starts_at: turn.weekend_starts_at.toISOString(),
          due_at: turn.due_at.toISOString(),
        };
      });
    const swaps = records.SWAPS
      .filter(function (swap) {
        return (swap.status === 'pending' || swap.status === 'accepted') && isHistoryDate_(swap.from_due_date) && isHistoryDate_(swap.to_due_date) &&
          (swap.from_roommate_id === session.roommateId || swap.to_roommate_id === session.roommateId) &&
          Math.max(swap.from_due_date.getTime(), swap.to_due_date.getTime()) > now;
      })
      .sort(function (a, b) {
        return (isHistoryDate_(b.created_at) ? b.created_at.getTime() : 0) - (isHistoryDate_(a.created_at) ? a.created_at.getTime() : 0);
      })
      .map(function (swap) {
        return swapToJson_(swap, session.roommateId, names, swap.status === 'accepted' && unapplied[swap.swap_id] === true);
      });
    return { ok: true, swaps: swaps, turns: turns };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

function rosterNames_(records) {
  const names = {};
  records.ROOMMATES.forEach(function (roommate) {
    names[roommate.roommate_id] = String(roommate.name);
  });
  return names;
}
