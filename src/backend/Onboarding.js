const ONBOARDING_KEYS = ['ONBOARD_NAME', 'ONBOARD_EMAIL', 'ONBOARD_TELEGRAM', 'ONBOARD_POSITION'];

/**
 * Owner-only, run by hand from the Apps Script editor through the wrapper in EditorTools.js: adds one roommate and a
 * rotation position.
 * 1. Set the Script Properties ONBOARD_NAME and ONBOARD_EMAIL (optionally ONBOARD_TELEGRAM and ONBOARD_POSITION).
 * 2. Open the maintenance window (MAINTENANCE_UNTIL), then run onboardRoommate.
 * The ONBOARD_* properties are removed after success. Running it again adds nobody: an existing email is refused,
 * and a run that was interrupted between its two writes is finished. It never sends email.
 * ROOMMATES.active stays the only rotation eligibility flag.
 */
function onboardRoommate_() {
  assertMaintenanceAllowed_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Another save is running. Try again in a moment.');
  try {
    const result = onboardUnderLock_(readOnboardingRequest_());
    const properties = PropertiesService.getScriptProperties();
    ONBOARDING_KEYS.forEach(function (key) {
      properties.deleteProperty(key);
    });
    const summary = (result.finishing ? 'Finished onboarding ' : 'Added ') + result.roommate.member_code + ' (' + result.roommate.name + ') at rotation position ' + result.position + '.';
    console.log(summary);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function invalidOnboarding_(message) {
  return appError_('ONBOARDING_INVALID', message + ' Nothing was changed.');
}

function readOnboardingRequest_() {
  const properties = PropertiesService.getScriptProperties();
  const read = function (key) {
    return properties.getProperty(key) || '';
  };
  return normalizeOnboardingRequest_({ name: read('ONBOARD_NAME'), email: read('ONBOARD_EMAIL'), telegram: read('ONBOARD_TELEGRAM'), position: read('ONBOARD_POSITION') }, {
    missing: 'Set the Script Properties ONBOARD_NAME and ONBOARD_EMAIL first.',
    position: 'ONBOARD_POSITION must be a whole number from 1 to 9999.',
  });
}

/** Trims and checks a new roommate's details, from Script Properties or from the admin page. */
function normalizeOnboardingRequest_(raw, messages) {
  const say = messages || { missing: 'A name and an email are required.', position: 'The rotation position must be a whole number from 1 to 9999.' };
  const text = function (value) {
    return typeof value === 'string' ? value.trim() : '';
  };
  const name = text(raw.name).replace(/\s+/g, ' ');
  const email = text(raw.email).toLowerCase();
  if (!name || !email) throw invalidOnboarding_(say.missing);
  const position = text(raw.position);
  if (position !== '' && !/^[1-9]\d{0,3}$/.test(position)) {
    throw invalidOnboarding_(say.position);
  }
  return { name: name, email: email, telegram: text(raw.telegram).replace(/^@/, ''), position: position === '' ? null : Number(position) };
}

/** First letter of the first name, then its consonants, then its vowels: John gives JHN. Padded with X. */
function memberCodePrefix_(name) {
  const letters = (name.split(/\s+/)
    .map(function (word) {
      return word.normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase();
    })
    .filter(Boolean)[0] || '').split('');
  const isVowel = function (letter) {
    return 'AEIOU'.indexOf(letter) !== -1;
  };
  const rest = letters.slice(1);
  const skeleton = (letters[0] || '') + rest.filter(function (l) { return !isVowel(l); }).join('') + rest.filter(isVowel).join('');
  return (skeleton + 'XXX').slice(0, 3);
}

/** The next number after the highest existing one, so codes are sequential and never reused. */
function nextMemberCode_(name, roommates) {
  const taken = {};
  let sequence = 0;
  roommates.forEach(function (roommate) {
    const code = String(roommate.member_code || '').toUpperCase();
    taken[code] = true;
    const match = /^[A-Z]{3}-(\d+)$/.exec(code);
    if (match) sequence = Math.max(sequence, Number(match[1]));
  });
  let code;
  do {
    sequence++;
    code = memberCodePrefix_(name) + '-' + String(sequence).padStart(3, '0');
  } while (taken[code]);
  return code;
}

/**
 * Everything below runs while holding the script lock, so the checks and the writes cannot interleave with another
 * run. Returns { roommate, position, finishing }.
 */
function onboardUnderLock_(request) {
  const records = SheetDb.listMany(['ROOMMATES', 'ROTATION']);
  const positions = records.ROTATION.map(function (slot) {
    return Number(slot.position);
  });

  let roommate = records.ROOMMATES.find(function (candidate) {
    return String(candidate.email).toLowerCase() === request.email;
  }) || null;
  const finishing = roommate !== null;
  if (finishing) {
    const slot = records.ROTATION.find(function (candidate) {
      return candidate.roommate_id === roommate.roommate_id;
    });
    if (slot) throw appError_('ONBOARDING_DUPLICATE', request.email + ' is already onboarded as ' + (roommate.member_code || 'a roommate') + ' at position ' + slot.position + '. Nothing was changed.');
    if (!roommate.member_code) throw invalidOnboarding_(request.email + ' exists without a member code or rotation position. Fix that row in the Sheet first.');
  } else if (request.telegram && records.ROOMMATES.some(function (other) {
    return String(other.telegram_username).toLowerCase() === request.telegram.toLowerCase();
  })) {
    throw invalidOnboarding_('That Telegram username already belongs to another roommate.');
  }

  const position = request.position === null ? Math.max.apply(null, [0].concat(positions)) + 1 : request.position;
  if (positions.indexOf(position) !== -1) throw invalidOnboarding_('Rotation position ' + position + ' is already used.');

  if (!finishing) {
    // SheetDb validates the name, email, Telegram name and code before it writes anything.
    roommate = SheetDb.insert('ROOMMATES', {
      member_code: nextMemberCode_(request.name, records.ROOMMATES),
      name: request.name,
      email: request.email,
      telegram_username: request.telegram,
      active: true,
    });
  }
  try {
    SheetDb.insert('ROTATION', { position: position, roommate_id: roommate.roommate_id });
  } catch (error) {
    console.error(error);
    throw appError_('ONBOARDING_INCOMPLETE', roommate.member_code + ' was added but has no rotation position yet. Run onboardRoommate again to finish.');
  }

  return { roommate: roommate, position: position, finishing: finishing };
}
