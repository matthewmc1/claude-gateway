// Tiny JSON document store for the app's own state (temporary overrides, usage aggregates).
//   get(name, fallback) -> value      update(name, fn, fallback) -> value (read-modify-write, serialised; retries on conflict)
//   put(name, v)                      list(prefix) -> names
// Backends: local files (dev, demo) or one Cloud Storage bucket (Cloud Run). Both are dependency-free.
//
// Integrity rule (this store holds live spend-cap bookkeeping): ONLY "does not exist" means "missing" and yields the fallback.
// Any other failure (unreadable file, torn/invalid JSON, a storage 5xx, a body that is not the generation we asked about) THROWS a
// StoreError and is never papered over with an empty document, because the next write would then replace the real state with
// that empty one. The app keeps failing loudly until an operator fixes or removes the damaged document.
import fs from 'node:fs';
import path from 'node:path';

export class StoreError extends Error {
  constructor(message, { cause, quarantined } = {}) { super(message); this.name = 'StoreError'; this.status = 500; if (cause) this.cause = cause; if (quarantined) this.quarantined = quarantined; }
}

// Document names become file paths / object names: refuse anything that could leave the data directory or confuse a path.
function checkName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new StoreError(`invalid state document name ${JSON.stringify(String(name).slice(0, 60))}`);
  }
}
// opts.shape(value) -> boolean: valid JSON of the wrong SHAPE (null, [], {}, {"items":null}) is as damaged as torn JSON, not "an empty store".
const shapeOk = (opts, value) => !opts?.shape || opts.shape(value) === true;
const shapeError = (name) => new StoreError(`state document ${name} has an unexpected shape (valid JSON, but not what the app writes)`);

const queues = new Map();
const serial = (key, fn) => { const run = (queues.get(key) || Promise.resolve()).then(fn, fn); queues.set(key, run.catch(() => {})); return run; };

export function createMemoryStore() {
  const m = new Map();
  return {
    kind: 'memory',
    async get(name, fallback = null, opts) { checkName(name); if (!m.has(name)) return fallback; const v = structuredClone(m.get(name)); if (!shapeOk(opts, v)) throw shapeError(name); return v; },
    async put(name, v) { checkName(name); m.set(name, structuredClone(v)); },
    update: (name, fn, fallback = null, opts) => serial(name, async () => { checkName(name); if (m.has(name) && !shapeOk(opts, m.get(name))) throw shapeError(name); const cur = m.has(name) ? structuredClone(m.get(name)) : structuredClone(fallback); const next = (await fn(cur)) ?? cur; m.set(name, structuredClone(next)); return next; }),
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)).sort(); },
  };
}

export function createFileStore(dir) {
  const file = (name) => { checkName(name); return path.join(dir, name.replace(/[^A-Za-z0-9._/-]/g, '_') + '.json'); };
  const quarantined = new Map();
  let seq = 0;
  // Keep a copy of a damaged file for the operator. The ORIGINAL stays where it is, so every later read keeps failing (no silent reset).
  function quarantine(f, text) {
    const key = `${f}|${text.length}|${fs.statSync(f).mtimeMs}`;
    if (quarantined.has(key)) return quarantined.get(key);
    const q = `${f}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.writeFileSync(q, text, { mode: 0o600 }); } catch { return null; }          // no copy: say so, and try again on the next read
    quarantined.set(key, path.basename(q));                       // remembered only after a copy really exists
    return path.basename(q);
  }
  // -> { found:false } | { found:true, value }
  const read = (name, opts) => {
    const f = file(name);
    let text;
    try { text = fs.readFileSync(f, 'utf8'); }
    catch (e) {
      if (e?.code === 'ENOENT') return { found: false };
      throw new StoreError(`state file ${path.basename(f)} cannot be read (${e?.code || 'error'}); refusing to continue with an empty state`, { cause: e });
    }
    let value;
    try { value = JSON.parse(text); }
    catch (e) {
      let q = null; try { q = quarantine(f, text); } catch { /* best effort */ }
      throw new StoreError(`state file ${path.basename(f)} is corrupt (not valid JSON)${q ? `; a copy was kept as ${q}` : '; no copy could be made'}. Restore or delete it; the app will not reset it silently`, { cause: e, quarantined: q });
    }
    if (!shapeOk(opts, value)) {
      let q = null; try { q = quarantine(f, text); } catch { /* best effort */ }
      throw new StoreError(`state file ${path.basename(f)} has an unexpected shape (valid JSON, but not what the app writes)${q ? `; a copy was kept as ${q}` : '; no copy could be made'}. Restore or delete it; the app will not reset it silently`, { quarantined: q });
    }
    return { found: true, value };
  };
  const write = (name, v) => {
    const f = file(name), tmp = `${f}.${process.pid}.${++seq}.tmp`;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeFileSync(fd, JSON.stringify(v));
      fs.fsyncSync(fd);                                          // the bytes are on disk before the rename makes them the document
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, f);
    } catch (e) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
    try { const d = fs.openSync(path.dirname(f), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* directory fsync is best effort (not on every platform) */ }
  };
  return {
    kind: 'file',
    async get(name, fallback = null, opts) { const r = read(name, opts); return r.found ? r.value : fallback; },
    // put() replaces the document outright, so it does not need to parse the old one (it can repair a damaged document on purpose).
    async put(name, v) { write(name, v); },
    update: (name, fn, fallback = null, opts) => serial(name, async () => {
      const r = read(name, opts);
      const cur = r.found ? r.value : structuredClone(fallback);
      const next = (await fn(cur)) ?? cur; write(name, next); return next;
    }),
    async list(prefix) {
      if (typeof prefix !== 'string' || prefix.startsWith('/') || prefix.includes('\\') || prefix.split('/').includes('..')) throw new StoreError('invalid list prefix');
      const dirPart = prefix.endsWith('/') ? prefix.slice(0, -1) : path.dirname(prefix);
      const stem = prefix.endsWith('/') ? '' : path.basename(prefix);
      const base = path.join(dir, dirPart === '.' ? '' : dirPart);
      if (!fs.existsSync(base)) return [];
      return fs.readdirSync(base).filter((f) => f.startsWith(stem) && f.endsWith('.json'))
        .map((f) => (dirPart === '.' ? '' : dirPart + '/') + f.slice(0, -5)).sort();
    },
  };
}

// Cloud Storage via REST, using the Cloud Run service account (metadata server). Writes use ifGenerationMatch so two writers can't clobber each other.
// A read is two calls (metadata for the generation, then the media of exactly that generation); anything but "404 on the metadata of an
// object in a bucket that exists" that is not a clean 200 throws. A 401 refreshes the token once and retries the call.
export function createGcsStore(bucket, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let tok = { v: '', exp: 0 }, bucketOk = false;
  const call = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const token = async (force = false) => {
    if (!force && Date.now() < tok.exp) return tok.v;
    const r = await call('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'metadata-flavor': 'Google' } });
    if (!r.ok) throw new StoreError('no access token from the metadata server');
    const j = await r.json();
    if (!j?.access_token) throw new StoreError('metadata server returned no access token');
    tok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) - 60) * 1000 }; return tok.v;
  };
  // every storage call: bearer token, one refresh+retry on 401 (revoked or rotated token)
  async function gcs(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const r = await call(url, { ...init, headers: { ...(init.headers || {}), authorization: 'Bearer ' + await token(attempt > 0) } });
      if (r.status === 401 && attempt === 0) continue;
      return r;
    }
  }
  const obj = (name) => `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name + '.json')}`;
  // A 404 for an object is only "empty" if the bucket itself exists (a mistyped APP_STATE_BUCKET must not look like an empty store).
  async function ensureBucket() {
    if (bucketOk) return;
    const r = await gcs(`https://storage.googleapis.com/storage/v1/b/${bucket}`);
    if (r.status === 404) throw new StoreError(`storage bucket ${bucket} does not exist (check APP_STATE_BUCKET)`);
    if (!r.ok) throw new StoreError(`storage bucket check ${r.status}`);
    bucketOk = true;
  }
  async function meta(name) {
    checkName(name);
    const r = await gcs(obj(name));
    if (r.status === 404) { await ensureBucket(); return { exists: false, generation: 0 }; }
    if (!r.ok) throw new StoreError(`storage read ${r.status}`);
    let j; try { j = await r.json(); } catch (e) { throw new StoreError('storage metadata is not valid JSON', { cause: e }); }
    const generation = Number(j?.generation);
    if (!Number.isFinite(generation) || generation <= 0) throw new StoreError('storage metadata has no generation');
    return { exists: true, generation };
  }
  async function read(name, opts) {
    for (let i = 0; i < 3; i++) {
      const m = await meta(name);
      if (!m.exists) return { value: null, generation: 0 };
      const r = await gcs(obj(name) + `?alt=media&generation=${m.generation}`);
      if (r.status === 404 || r.status === 412) continue;                         // replaced or deleted between the two calls: start over
      if (!r.ok) throw new StoreError(`storage read ${r.status}`);
      const got = r.headers?.get?.('x-goog-generation');
      if (got && Number(got) !== m.generation) continue;                          // the body is not the generation the metadata described
      let value; try { value = await r.json(); } catch (e) { throw new StoreError(`storage object ${name} is not valid JSON; refusing to treat it as empty`, { cause: e }); }
      if (!shapeOk(opts, value)) throw shapeError(name);
      return { value, generation: m.generation };
    }
    throw new StoreError(`storage object ${name} kept changing while it was read`);
  }
  async function write(name, value, generation) {
    const r = await gcs(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name + '.json')}&ifGenerationMatch=${generation}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    if (r.status === 412) return false;
    if (!r.ok) throw new StoreError(`storage write ${r.status}`);
    return true;
  }
  return {
    kind: 'gcs',
    async get(name, fallback = null, opts) { const { value } = await read(name, opts); return value ?? fallback; },
    async put(name, v) { for (let i = 0; i < 5; i++) { const { generation } = await meta(name); if (await write(name, v, generation)) return; } throw new StoreError('storage conflict'); },
    update: (name, fn, fallback = null, opts) => serial(name, async () => {
      for (let i = 0; i < 6; i++) {
        const { value, generation } = await read(name, opts);
        const cur = value ?? structuredClone(fallback); const next = (await fn(cur)) ?? cur;
        if (await write(name, next, generation)) return next;
      }
      throw new StoreError('storage conflict');
    }),
    async list(prefix) {
      if (typeof prefix !== 'string' || prefix.startsWith('/') || prefix.includes('\\') || prefix.split('/').includes('..')) throw new StoreError('invalid list prefix');
      const names = []; let pageToken = '';
      for (let i = 0; i < 50; i++) {
        const r = await gcs(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(prefix)}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
        if (!r.ok) throw new StoreError(`storage list ${r.status}`);
        const j = await r.json();
        names.push(...(j.items || []).map((x) => x.name.replace(/\.json$/, '')));
        pageToken = j.nextPageToken || ''; if (!pageToken) break;
      }
      return names.sort();
    },
  };
}

// Which backend createStore will pick: 'memory' (demo), 'gcs' (APP_STATE_BUCKET) or 'file'.
export const storeKind = (cfg) => (cfg.demo ? 'memory' : cfg.stateBucket ? 'gcs' : 'file');
export function createStore(cfg) {
  const kind = storeKind(cfg);
  return kind === 'memory' ? createMemoryStore() : kind === 'gcs' ? createGcsStore(cfg.stateBucket) : createFileStore(cfg.dataDir);
}
