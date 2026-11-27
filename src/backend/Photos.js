/**
 * Cleaning photos: one optional JPEG per completed cleaning, kept in a private Drive folder per environment and linked
 * from CLEANING_LOGS.photo_file_id. Photos are separate from completing a turn: nothing here touches rotation, swaps,
 * vacations or points, and a failed upload leaves the cleaning exactly as recorded.
 *
 * Drive access uses only the drive.file scope (see appsscript.json): the script reaches files and folders it created
 * itself and nothing else in the owner's Drive. The folder is created by setupPhotoFolder_ (so drive.file covers it)
 * and configured through the PHOTO_FOLDER_ID Script Property. Files are never shared: the script never touches Drive
 * permissions, and a file that has been shared (by hand) is refused. A file is only ever looked up through a log row's
 * photo_file_id, and served only if its Drive metadata names this environment, this folder and that log.
 */
const PHOTO_MAX_BYTES = 500 * 1024; // decoded
const PHOTO_MAX_BASE64 = Math.ceil(PHOTO_MAX_BYTES / 3) * 4;
const PHOTO_MIME = 'image/jpeg';
const PHOTO_FOLDER_MIME = 'application/vnd.google-apps.folder';
const PHOTO_ORPHAN_AGE_MS = 60 * 60 * 1000; // a file younger than this may belong to an upload still in progress
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const PHOTO_FILE_FIELDS = 'id,name,mimeType,parents,trashed,shared,size,createdTime,appProperties';
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// ---------- browser API ----------

/**
 * Browser API: { token, log_id, photo } where photo is a standard base64 JPEG (no data: prefix) of at most
 * PHOTO_MAX_BYTES once decoded. Only the roommate who did that cleaning (the log's roommate_id, so the partner on a
 * swapped turn) can attach one, once. Returns { ok: true, log_id } or { ok: false, error }.
 * The script lock is held from the check to the write, so two uploads for one cleaning can never both be stored.
 */
function attachCleaningPhoto(request) {
  return withPhotoLock_(function () {
    photoRequest_(request, ['token', 'log_id', 'photo']);
    const bytes = decodeJpeg_(request.photo);
    return function () {
      const session = sessionOf_(request);
      const log = photoLog_(request.log_id);
      if (log.outcome !== 'completed') throw appError_('CLEANING_NOT_FOUND', 'Not a completed cleaning.');
      if (log.roommate_id !== session.roommateId) throw appError_('NOT_YOUR_CLEANING', 'Only the cleaner can add a photo.');
      if (!isBlank_(log.photo_file_id)) throw appError_('PHOTO_EXISTS', 'This cleaning already has a photo.');
      const folderId = photoFolder_();

      let file;
      try {
        file = PhotoDrive.upload(folderId, 'cleaning-' + log.log_id + '.jpg', bytes, {
          chorenest_env: getEnvironment_(), chorenest_log: String(log.log_id), chorenest_uploader: session.roommateId,
        });
      } catch (error) {
        console.error(error);
        throw appError_('PHOTO_UPLOAD_FAILED', 'Upload failed.');
      }
      try {
        if (!DRIVE_ID_PATTERN.test(String(file.id))) throw new Error('Drive returned an unexpected file ID.');
        SheetDb.update('CLEANING_LOGS', log.log_id, { photo_file_id: file.id });
      } catch (error) {
        console.error(error);
        removePhotoQuietly_(file.id); // never leave a file that no log points to
        throw appError_('PHOTO_UPLOAD_FAILED', 'Could not link the photo.');
      }
      return { ok: true, log_id: String(log.log_id) };
    };
  });
}

/**
 * Browser API, read-only: { token, log_id } -> { ok, log_id, mime_type, data } with data as base64. Any signed-in
 * household member can see an attached photo. The file must still be this environment's photo for that log.
 */
function getCleaningPhoto(request) {
  try {
    photoRequest_(request, ['token', 'log_id']);
    const records = SheetDb.listMany(['ROOMMATES', 'CLEANING_LOGS']);
    sessionOf_(request, records.ROOMMATES);
    const log = findPhotoLog_(records.CLEANING_LOGS, request.log_id);
    if (isBlank_(log.photo_file_id)) throw appError_('PHOTO_NOT_FOUND', 'No photo linked.');
    // A hand-edited cell never reaches a Drive URL.
    if (!DRIVE_ID_PATTERN.test(String(log.photo_file_id))) throw appError_('PHOTO_NOT_FOUND', 'The linked ID is not a Drive file ID.');
    const folderId = photoFolder_();
    let bytes;
    try {
      assertOwnPhoto_(PhotoDrive.meta(String(log.photo_file_id)), folderId, log.log_id);
      bytes = PhotoDrive.download(String(log.photo_file_id));
    } catch (error) {
      console.error(error);
      throw appError_(error.code === 'PHOTO_NOT_FOUND' ? 'PHOTO_NOT_FOUND' : 'PHOTO_STORAGE_FAILED', 'Photo unavailable.');
    }
    if (!isJpeg_(bytes)) {
      console.error('Photo of log ' + log.log_id + ' is no longer a JPEG within the limit.');
      throw appError_('PHOTO_NOT_FOUND', 'Stored file is not a valid photo.');
    }
    return { ok: true, log_id: String(log.log_id), mime_type: PHOTO_MIME, data: Utilities.base64Encode(bytes) };
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  }
}

/**
 * Browser API: { token, log_id } -> { ok: true }. The roommate who added the photo (the cleaner) or an ADMIN can
 * delete it. The link is removed first, then the Drive file; if Drive fails at that point, the file is unlinked and
 * setupPhotoFolder_ sweeps it up later, so no log ever points to a deleted or foreign file.
 */
function deleteCleaningPhoto(request) {
  return withPhotoLock_(function () {
    photoRequest_(request, ['token', 'log_id']);
    return function () {
      const session = sessionOf_(request);
      const log = photoLog_(request.log_id);
      if (isBlank_(log.photo_file_id)) throw appError_('PHOTO_NOT_FOUND', 'No photo linked.');
      if (log.roommate_id !== session.roommateId && session.role !== 'ADMIN') throw appError_('PHOTO_NOT_YOURS', 'Not the uploader or an admin.');
      const fileId = String(log.photo_file_id);
      try {
        SheetDb.update('CLEANING_LOGS', log.log_id, { photo_file_id: '' });
      } catch (error) {
        console.error(error);
        throw appError_('WRITE_FAILED', 'Could not unlink the photo.');
      }
      if (DRIVE_ID_PATTERN.test(fileId)) removePhotoQuietly_(fileId);
      return { ok: true };
    };
  });
}

/**
 * What the signed-in roommate may do with a log's photo, for History and profile entries. Never exposes the Drive ID.
 * Mirrors the rules enforced by attachCleaningPhoto and deleteCleaningPhoto (which check again).
 */
function photoFlags_(log, session) {
  const hasPhoto = !isBlank_(log.photo_file_id);
  const own = log.roommate_id === session.roommateId;
  return {
    has_photo: hasPhoto,
    can_add_photo: log.outcome === 'completed' && own && !hasPhoto,
    can_delete_photo: hasPhoto && (own || session.role === 'ADMIN'),
  };
}

// ---------- maintenance (owner only, from the editor via EditorTools.js) ----------

/**
 * Creates this environment's private photo folder if needed and reports its ID to put in PHOTO_FOLDER_ID (the script
 * never sets Script Properties itself). Once configured, checks the folder and removes orphaned photos: files in it,
 * older than an hour, that no log points to. Returns a summary.
 */
function setupPhotoFolder_() {
  assertMaintenanceAllowed_();
  const env = getEnvironment_();
  const configured = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
  if (!configured) {
    const existing = PhotoDrive.findFolders(env);
    const folder = existing[0] || PhotoDrive.createFolder('ChoreNest photos (' + env + ')', env);
    return { folder_id: folder.id, created: !existing.length, next: 'Set the Script Property PHOTO_FOLDER_ID to ' + folder.id + ', then run setupPhotoFolder again.' };
  }
  const folderId = photoFolder_();
  const referenced = {};
  SheetDb.list('CLEANING_LOGS').forEach(function (log) {
    if (!isBlank_(log.photo_file_id)) referenced[String(log.photo_file_id)] = true;
  });
  const now = Date.now();
  const orphans = PhotoDrive.listFolder(folderId).filter(function (file) {
    const props = file.appProperties || {};
    return props.chorenest_env === env && !referenced[file.id] && now - Date.parse(file.createdTime) > PHOTO_ORPHAN_AGE_MS;
  });
  orphans.forEach(function (file) {
    PhotoDrive.remove(file.id);
  });
  return { folder_id: folderId, created: false, orphans_removed: orphans.length, linked: Object.keys(referenced).length };
}

// ---------- checks ----------

/** Only these fields, the token as text and log_id as an ID; the photo is checked by decodeJpeg_. */
function photoRequest_(request, fields) {
  const valid = Boolean(request) && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).length === fields.length && fields.every(function (field) {
      return Object.prototype.hasOwnProperty.call(request, field);
    }) && typeof request.token === 'string' && request.token.length <= MAX_TOKEN_LENGTH && ID_PATTERN.test(asText_(request.log_id));
  if (!valid) throw appError_('INVALID_REQUEST', 'That request wasn’t valid, so nothing was saved.');
}

/** The bytes of a base64 JPEG within the limit, or PHOTO_INVALID. The length is checked before decoding. */
function decodeJpeg_(text) {
  if (typeof text !== 'string' || !text.length || text.length > PHOTO_MAX_BASE64 || text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) {
    throw appError_('PHOTO_INVALID', 'Not base64 within the size limit.');
  }
  let bytes;
  try {
    bytes = Utilities.base64Decode(text);
  } catch (error) {
    throw appError_('PHOTO_INVALID', 'Not base64.');
  }
  if (!isJpeg_(bytes)) throw appError_('PHOTO_INVALID', 'Not a JPEG within the size limit.');
  return bytes;
}

/** A JPEG: starts with the SOI marker and a segment marker (FF D8 FF), ends with EOI (FF D9), at most the limit. */
function isJpeg_(bytes) {
  const at = function (index) {
    return bytes[index] & 0xff;
  };
  return Boolean(bytes) && bytes.length >= 4 && bytes.length <= PHOTO_MAX_BYTES &&
    at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff && at(bytes.length - 2) === 0xff && at(bytes.length - 1) === 0xd9;
}

function findPhotoLog_(logs, logId) {
  const log = logs.filter(function (row) {
    return row.log_id === logId;
  })[0];
  if (!log) throw appError_('CLEANING_NOT_FOUND', 'No such log.');
  return log;
}

/** The log as it is now (callers hold the lock). */
function photoLog_(logId) {
  return findPhotoLog_(SheetDb.list('CLEANING_LOGS'), logId);
}

/** PHOTO_FOLDER_ID, checked: this script's folder for this environment, not trashed and not shared. */
function photoFolder_() {
  const folderId = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
  if (!folderId || !DRIVE_ID_PATTERN.test(folderId)) throw appError_('PHOTO_NOT_CONFIGURED', 'PHOTO_FOLDER_ID is missing or malformed.');
  let folder;
  try {
    folder = PhotoDrive.meta(folderId);
  } catch (error) {
    console.error(error);
    // Not there at all: a setup problem. Anything else (Drive down, quota): a passing storage problem.
    throw appError_(error.code === 'PHOTO_NOT_FOUND' ? 'PHOTO_NOT_CONFIGURED' : 'PHOTO_STORAGE_FAILED', 'The photo folder cannot be read.');
  }
  const props = folder.appProperties || {};
  if (folder.mimeType !== PHOTO_FOLDER_MIME || folder.trashed === true || folder.shared === true || props.chorenest_photo_folder !== getEnvironment_()) {
    throw appError_('PHOTO_NOT_CONFIGURED', 'PHOTO_FOLDER_ID is not this environment’s private photo folder.');
  }
  return folderId;
}

/** Throws PHOTO_NOT_FOUND unless the file is this environment's private JPEG for this log, in the photo folder. */
function assertOwnPhoto_(file, folderId, logId) {
  const props = file.appProperties || {};
  const own = file.mimeType === PHOTO_MIME && file.trashed !== true && file.shared !== true && Array.isArray(file.parents) &&
    file.parents.indexOf(folderId) !== -1 && props.chorenest_env === getEnvironment_() && props.chorenest_log === String(logId) &&
    Number(file.size) > 0 && Number(file.size) <= PHOTO_MAX_BYTES;
  if (!own) throw appError_('PHOTO_NOT_FOUND', 'The linked file is not this log’s private photo.');
}

function removePhotoQuietly_(fileId) {
  try {
    PhotoDrive.remove(fileId);
  } catch (error) {
    console.error('Photo file left for setupPhotoFolder to remove: ' + error);
  }
}

/** Parses before locking, then runs the returned function under the script lock. Every error becomes a fixed answer. */
function withPhotoLock_(prepare) {
  let locked = false;
  const lock = LockService.getScriptLock();
  try {
    const run = prepare();
    if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', 'Someone else is saving right now.');
    locked = true;
    return run();
  } catch (error) {
    return apiError_(error, 'INTERNAL_ERROR');
  } finally {
    if (locked) lock.releaseLock();
  }
}

// ---------- Drive (REST, drive.file scope) ----------

/**
 * The only Drive access. Kept as an object so google.script.run cannot call it. Every call throws on a non-2xx answer,
 * except remove(), for which "not found" counts as done. Never touches permissions.
 */
const PhotoDrive = {
  meta: function (fileId) {
    return driveJson_('get', DRIVE_API + '/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent(PHOTO_FILE_FIELDS));
  },

  download: function (fileId) {
    return driveFetch_('get', DRIVE_API + '/' + encodeURIComponent(fileId) + '?alt=media').getContent();
  },

  /** Multipart upload of a JPEG into the folder, with app properties. Returns { id }. */
  upload: function (folderId, name, bytes, appProperties) {
    const boundary = 'chorenest' + Utilities.getUuid().replace(/-/g, '');
    const metadata = { name: name, mimeType: PHOTO_MIME, parents: [folderId], appProperties: appProperties };
    const head = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
      '\r\n--' + boundary + '\r\nContent-Type: ' + PHOTO_MIME + '\r\n\r\n';
    const tail = '\r\n--' + boundary + '--\r\n';
    const payload = Utilities.newBlob(head).getBytes().concat(bytes, Utilities.newBlob(tail).getBytes());
    return driveJson_('post', DRIVE_UPLOAD_API + '?uploadType=multipart&fields=id', payload, 'multipart/related; boundary=' + boundary);
  },

  remove: function (fileId) {
    const response = driveFetch_('delete', DRIVE_API + '/' + encodeURIComponent(fileId), null, null, [404]);
    return response.getResponseCode() !== 404;
  },

  createFolder: function (name, env) {
    return driveJson_('post', DRIVE_API + '?fields=id', JSON.stringify({ name: name, mimeType: PHOTO_FOLDER_MIME, appProperties: { chorenest_photo_folder: env } }), 'application/json');
  },

  /** Folders this script created for this environment (drive.file lists only the script's own files). */
  findFolders: function (env) {
    const q = "mimeType = '" + PHOTO_FOLDER_MIME + "' and trashed = false and appProperties has { key='chorenest_photo_folder' and value='" + env + "' }";
    return driveJson_('get', DRIVE_API + '?pageSize=10&fields=' + encodeURIComponent('files(id)') + '&q=' + encodeURIComponent(q)).files || [];
  },

  listFolder: function (folderId) {
    const files = [];
    let pageToken = '';
    do {
      const q = "'" + folderId + "' in parents and trashed = false";
      const page = driveJson_('get', DRIVE_API + '?pageSize=1000&fields=' + encodeURIComponent('nextPageToken,files(id,createdTime,appProperties)') +
        '&q=' + encodeURIComponent(q) + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
      Array.prototype.push.apply(files, page.files || []);
      pageToken = page.nextPageToken || '';
    } while (pageToken);
    return files;
  },
};

function driveFetch_(method, url, payload, contentType, allowed) {
  const options = { method: method, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  if (payload !== null && payload !== undefined) options.payload = payload;
  if (contentType) options.contentType = contentType;
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  if ((code < 200 || code > 299) && (allowed || []).indexOf(code) === -1) {
    const error = new Error('Drive answered ' + code + ' for ' + method.toUpperCase() + ' ' + url.split('?')[0]);
    if (code === 404) error.code = 'PHOTO_NOT_FOUND';
    throw error;
  }
  return response;
}

function driveJson_(method, url, payload, contentType) {
  return JSON.parse(driveFetch_(method, url, payload, contentType).getContentText());
}
