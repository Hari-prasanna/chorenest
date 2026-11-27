'use strict';

// An in-memory stand-in for the Drive v3 REST endpoints the photo code uses (no real Drive is ever called). It answers
// UrlFetchApp.fetch(url, options) as Apps Script would, records every call, and refuses anything else, such as a
// permissions request, so a test fails if the code ever tries to share a file.
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN = 'Bearer test-oauth-token';

const response = (code, body) => {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return {
    getResponseCode: () => code,
    getContentText: () => bytes.toString('utf8'),
    getContent: () => [...bytes].map((b) => (b > 127 ? b - 256 : b)),
  };
};
const unsigned = (payload) => (typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload.map((b) => b & 0xff)));

class FakeDrive {
  constructor({ now = () => new Date() } = {}) {
    this.files = new Map();
    this.calls = [];
    this.fail = {}; // { upload, meta, download, delete, list, create }: status code to answer instead, or 'throw'
    this.onUpload = null; // called with the new file right after an upload, before answering
    this.now = now;
    this.sequence = 0;
    this.fetch = this.fetch.bind(this);
  }

  add(fields) {
    const id = fields.id || this.newId();
    const file = { id, name: 'x', mimeType: 'image/jpeg', parents: [], trashed: false, shared: false, createdTime: this.now().toISOString(), appProperties: {}, bytes: Buffer.alloc(0), ...fields };
    file.size = String(file.bytes.length);
    this.files.set(id, file);
    return file;
  }

  folder(env = 'DEV', extra = {}) {
    return this.add({ name: `ChoreNest photos (${env})`, mimeType: 'application/vnd.google-apps.folder', appProperties: { chorenest_photo_folder: env }, ...extra });
  }

  newId() {
    this.sequence += 1;
    return `drv${String(this.sequence).padStart(4, '0')}FakeFileIdentifier`;
  }

  photos() {
    return [...this.files.values()].filter((file) => file.mimeType === 'image/jpeg');
  }

  failing(kind) {
    const mode = this.fail[kind];
    if (mode === 'throw') throw new Error('Address unavailable: ' + kind);
    return mode ? response(mode, { error: { code: mode } }) : null;
  }

  meta(file) {
    const { bytes, ...fields } = file;
    return fields;
  }

  fetch(url, options = {}) {
    const method = (options.method || 'get').toLowerCase();
    this.calls.push({ method, url: url.split('?')[0], query: url.split('?')[1] || '' });
    if (!options.headers || options.headers.Authorization !== TOKEN) return response(401, { error: 'no token' });
    const [base, query = ''] = url.split('?');
    const params = new URLSearchParams(query);

    if (method === 'post' && base === UPLOAD) {
      const failed = this.failing('upload');
      if (failed) return failed;
      if (params.get('uploadType') !== 'multipart') return response(400, {});
      const boundary = /boundary=(\S+)/.exec(options.contentType)[1];
      const raw = unsigned(options.payload);
      const parts = [];
      let at = raw.indexOf(`--${boundary}`);
      while (at !== -1) {
        const next = raw.indexOf(`\r\n--${boundary}`, at + 2);
        if (next === -1) break;
        const part = raw.subarray(raw.indexOf('\r\n', at) + 2, next);
        const split = part.indexOf('\r\n\r\n');
        parts.push({ headers: part.subarray(0, split).toString('utf8'), body: part.subarray(split + 4) });
        at = next + 2;
      }
      const metadata = JSON.parse(parts[0].body.toString('utf8'));
      const file = this.add({ name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents, appProperties: metadata.appProperties || {}, bytes: Buffer.from(parts[1].body) });
      if (this.onUpload) this.onUpload(file);
      return response(200, { id: file.id });
    }

    if (method === 'post' && base === API) {
      const failed = this.failing('create');
      if (failed) return failed;
      const metadata = JSON.parse(options.payload);
      return response(200, { id: this.add({ ...metadata, bytes: Buffer.alloc(0) }).id });
    }

    if (method === 'get' && base === API) {
      const failed = this.failing('list');
      if (failed) return failed;
      const q = params.get('q') || '';
      const inParent = /^'([^']+)' in parents/.exec(q);
      const folderEnv = /key='chorenest_photo_folder' and value='([^']+)'/.exec(q);
      const files = [...this.files.values()].filter((file) => !file.trashed && (
        inParent ? file.parents.includes(inParent[1]) : folderEnv ? file.mimeType === 'application/vnd.google-apps.folder' && file.appProperties.chorenest_photo_folder === folderEnv[1] : false
      ));
      return response(200, { files: files.map((file) => this.meta(file)) });
    }

    const match = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([A-Za-z0-9_-]+)$/.exec(base);
    if (!match) throw new Error(`Unexpected Drive call: ${method.toUpperCase()} ${base}`);
    const file = this.files.get(decodeURIComponent(match[1]));
    if (method === 'get' && params.get('alt') === 'media') {
      const failed = this.failing('download');
      if (failed) return failed;
      return file ? response(200, file.bytes) : response(404, {});
    }
    if (method === 'get') {
      const failed = this.failing('meta');
      if (failed) return failed;
      return file ? response(200, this.meta(file)) : response(404, {});
    }
    if (method === 'delete') {
      const failed = this.failing('delete');
      if (failed) return failed;
      if (!file) return response(404, {});
      this.files.delete(file.id);
      return response(204, '');
    }
    throw new Error(`Unexpected Drive call: ${method.toUpperCase()} ${base}`);
  }
}

/** A tiny JPEG by its markers (SOI, a segment marker, filler, EOI), as base64, with `filler` bytes in between. */
function jpegBase64(filler = 16) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(filler, 7), Buffer.from([0xff, 0xd9])]).toString('base64');
}

module.exports = { FakeDrive, jpegBase64 };
