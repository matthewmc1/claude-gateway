// Usage store built from gateway request events. Events are rolled up per hour (user x model x outcome), so the data
// stays small and fast to read however many requests there are, plus a small per-user ring of recent requests for the per-request view.
//
// event = { ts (ms), requestId, sub, email, model, status, ms, upstream, loadTest, cause? }
//
// Documents (all in the shared store):
//   usage/agg/<YYYY-MM-DD>   v2 compact day doc: { v:2, m:[model names], u:{ sub: [row...] }, ids:{ hourIndex: "<8 chars per applied request>" } }
//        row = [key, n, h1, h2, ...]  key = ((hourOfDay*64 + modelIdx)*4 + outcome(0 ok,1 spend_cap,2 upstream_error,3 rejected))*2 + loadTest;
//        each h = count*128 + latencyBin is one latency histogram entry (only for outcome ok). ~20 bytes per user-hour-model-outcome instead
//        of ~195 as pretty rows: 2,000 users x 10 active hours x 2 models with 3 distinct latency bins each is ~1 MB per day (7.8 MB before),
//        rewritten per ingest page in ~100-200 ms in memory. Legacy `{rows:{...}}` day docs are read and upgraded on their next write.
//   usage/roster             { sub: { first, last, email } }
//   usage/causes             { c:{ requestId: {cause, at} }, e:{ requestId: {sub, at} } }   upstream causes waiting for / matching an event, 15 min
//   usage/recent/<00..ff>    { v:2, u:{ sub: [[tsMs, id, model, outcome, status, ms, lt, cause|null], ...newest first, at most 50] } }
//
// Idempotency (M2): replaying the same events after ANY failure (the day docs, roster, causes, recent ring and the logs cursor are separate
// documents, so there is no cross-document transaction) never double counts. Every document is updated in a way that is its own no-op the
// second time: day docs keep a ledger of applied request ids (hashed to 48 bits, per hour, in the SAME document as the counts so counting
// and recording are atomic), the roster is max/min, causes are keyed by request id, the recent ring skips ids it already holds.
// The ledger is only kept for hours a replay could still reach: callers pass `replayFloorMs` (the oldest timestamp any later call can
// feed again); without it the last 6 hours of the batch are kept.
//
// Latency (L3): p50 is APPROXIMATE. Events with a missing/zero/negative `ms` are ignored. Latencies go into log-spaced bins (8 per doubling,
// i.e. each bin is ~9% wide) and the k-th value is interpolated inside its bin; the median of an even count is the mean of the two middle
// values. Measured against the exact median on 20,000 random lognormal samples (1 to 400 requests, sigma 0.1-1.3) the worst error was 6.6%
// (a test pins it under 8%); a bin of identical requests reads within ~4.5% of the truth. ClickHouse computes quantile(0.5) over the same
// population (ok outcomes with latency_ms > 0); both are approximations of the same definition.
import crypto from 'node:crypto';

export const classify = (status, upstream) => (status < 400 ? 'ok' : status === 429 && !upstream ? 'spend_cap' : upstream ? 'upstream_error' : 'rejected');
export const OUTCOMES = ['ok', 'spend_cap', 'upstream_error', 'rejected'];
const OC = Object.fromEntries(OUTCOMES.map((o, i) => [o, i]));
const HOUR = 3600, DAY = 86400, RECENT_PER_USER = 50, RECENT_SHARDS = 256, CAUSE_TTL_MS = 15 * 60e3, MAX_CAUSES = 5000;
const MAX_UNKNOWN_MODELS = 8, MAX_MODELS = 40, OTHER = 'other', MAX_SUB = 200, MAX_EMAIL = 320, MAX_MODEL = 100, MAX_ID = 200;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);        // object-key names that must never become a user id (F8)
// control characters and bidi/zero-width characters never belong in a model name or e-mail shown in the UI
const JUNK = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
const clean = (v, max) => (typeof v === 'string' ? v.replace(JUNK, '').slice(0, max) : '');

// ---- latency histogram: 8 bins per doubling from 25 ms; bin 0 = up to 25 ms, bin 96 = everything above ~51 s ----
const BIN_BASE = 25, BIN_PER_OCTAVE = 8, MAX_BIN = 96;
export const latencyBin = (ms) => (ms <= BIN_BASE ? 0 : Math.min(MAX_BIN, Math.ceil(BIN_PER_OCTAVE * Math.log2(ms / BIN_BASE))));
const binHi = (i) => BIN_BASE * 2 ** (i / BIN_PER_OCTAVE), binLo = (i) => (i === 0 ? BIN_BASE / 2 : BIN_BASE * 2 ** ((i - 1) / BIN_PER_OCTAVE));
const validMs = (ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
// hist: Map(bin -> count)  ->  ms | null.  The value of the k-th smallest request is interpolated geometrically inside the bin that holds it
// (so one bin of identical requests reads about its true value); the median of an even count is the mean of the two middle values.
export function medianOf(hist) {
  let total = 0; for (const c of hist.values()) total += c;
  if (!total) return null;
  const bins = [...hist.keys()].sort((a, b) => a - b);
  const valueAt = (k) => {                                          // k = 1-based rank
    let acc = 0;
    for (const bin of bins) {
      const c = hist.get(bin);
      if (acc + c >= k) { const lo = binLo(bin), hi = binHi(bin); return lo * (hi / lo) ** ((k - acc - 0.5) / c); }
      acc += c;
    }
    return null;
  };
  const v = total % 2 ? valueAt((total + 1) / 2) : (valueAt(total / 2) + valueAt(total / 2 + 1)) / 2;
  return v === null ? null : Math.round(v);
}
const addHist = (h, bin, n) => h.set(bin, (h.get(bin) || 0) + n);
// legacy 11-bin histograms (edges 50..25600) -> new bins, at each old bin's geometric centre
const LEGACY_EDGES = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600];
const legacyBin = (i) => latencyBin(Math.sqrt((i ? LEGACY_EDGES[i - 1] : 25) * (LEGACY_EDGES[i] ?? LEGACY_EDGES.at(-1) * 2)));

const dayOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const token = (id) => crypto.createHash('sha1').update(id).digest('base64url').slice(0, 8);
const rowKey = (hr, mi, oc, lt) => ((hr * 64 + mi) * 4 + oc) * 2 + lt;
const keyLt = (k) => k % 2, keyOc = (k) => Math.floor(k / 2) % 4, keyMi = (k) => Math.floor(k / 8) % 64, keyHr = (k) => Math.floor(k / 512);
const HPACK = 128;                                                      // histogram entry = count * 128 + bin (bin <= 96)
const keep = (data) => (lt) => data === 'all' || (data === 'loadtest' ? !!lt : !lt);
const keepRecent = (data) => (r) => data === 'all' || (data === 'loadtest' ? r.lt : !r.lt);
const emptyDay = () => ({ v: 2, m: [], u: {}, ids: {} });
const shardName = (sub) => 'usage/recent/' + (fnv(sub) % RECENT_SHARDS).toString(16).padStart(2, '0');

// Legacy day doc -> v2 (pure).
function upgradeDay(doc) {
  if (doc && doc.v === 2) return doc;
  const out = emptyDay();
  const rows = doc && typeof doc.rows === 'object' && doc.rows ? Object.values(doc.rows) : [];
  const idx = new Map(), byKey = new Map();
  for (const r of rows) {
    if (!r || typeof r.sub !== 'string' || RESERVED.has(r.sub)) continue;
    let name = clean(r.model, MAX_MODEL);
    if (!idx.has(name) && name && out.m.length >= MAX_MODELS - 1) name = OTHER;       // a hostile legacy doc cannot blow the model table up
    if (!idx.has(name)) { idx.set(name, out.m.length); out.m.push(name); }
    const hr = Math.floor((r.h % DAY) / HOUR), mi = idx.get(name), oc = OC[r.outcome] ?? 3, lt = r.lt ? 1 : 0;
    const key = rowKey(hr, mi, oc, lt), k = r.sub + '|' + key;
    let row = byKey.get(k);
    if (!row) { row = [key, 0]; byKey.set(k, row); (out.u[r.sub] ||= []).push(row); }
    row[1] += r.n || 0;
    if (oc === 0 && Array.isArray(r.hist)) {
      const h = new Map(); for (let i = 2; i < row.length; i++) h.set(row[i] % HPACK, Math.floor(row[i] / HPACK));
      r.hist.forEach((c, i) => { if (c) addHist(h, legacyBin(i), c); });
      row.length = 2; for (const [b, c] of h) row.push(c * HPACK + b);
    }
  }
  return out;
}

export function createAggregator(store, { now = () => Date.now(), knownModels = null } = {}) {
  const known = knownModels instanceof Set ? knownModels : new Set(knownModels || []);
  const counters = { droppedSubs: 0, droppedEvents: 0, modelsBucketedToOther: 0 };

  function normalise(e) {
    const ts = Number(e?.ts);
    if (!Number.isFinite(ts)) { counters.droppedEvents++; return null; }
    const sub = clean(e.sub, MAX_SUB);
    if (RESERVED.has(sub)) { counters.droppedSubs++; return null; }
    const outcome = classify(e.status, e.upstream);
    const h = Math.floor(ts / 1000 / HOUR) * HOUR;
    return { ts, h, sub, email: clean(e.email, MAX_EMAIL), model: clean(e.model, MAX_MODEL), outcome, oc: OC[outcome], status: Number(e.status) || 0, ms: validMs(e.ms) ? Math.round(e.ms) : null,
      lt: e.loadTest ? 1 : 0, id: typeof e.requestId === 'string' && e.requestId ? e.requestId.slice(0, MAX_ID) : '', cause: typeof e.cause === 'string' ? e.cause : null };
  }
  function modelIndex(doc, name) {
    let i = doc.m.indexOf(name);
    if (i >= 0) return i;
    const unknown = doc.m.filter((m) => m && m !== OTHER && !known.has(m)).length;
    const full = doc.m.length >= MAX_MODELS || (known.size > 0 && !known.has(name) && unknown >= MAX_UNKNOWN_MODELS) || (known.size === 0 && unknown >= MAX_MODELS - 1);
    if (name && name !== OTHER && full) { counters.modelsBucketedToOther++; return modelIndex(doc, OTHER); }
    doc.m.push(name); return doc.m.length - 1;
  }

  // ---- one day doc ----
  function applyDay(doc0, list, floorHour) {
    const doc = upgradeDay(doc0);
    const sets = new Map(), fresh = new Map(), indexes = new Map();
    const ledger = (hk) => {
      if (!sets.has(hk)) { const s = new Set(), str = own(doc.ids, hk) || ''; for (let i = 0; i + 8 <= str.length; i += 8) s.add(str.slice(i, i + 8)); sets.set(hk, s); fresh.set(hk, ''); }
      return sets.get(hk);
    };
    for (const ev of list) {
      if (ev.id) {
        const hk = String(ev.h / HOUR), tok = token(ev.id), s = ledger(hk);
        if (s.has(tok)) continue;                                          // already counted: a replay
        s.add(tok); fresh.set(hk, fresh.get(hk) + tok);
      }
      const hr = Math.floor((ev.h % DAY) / HOUR), mi = modelIndex(doc, ev.model);
      let ix = indexes.get(ev.sub);
      if (!ix) { ix = new Map(); for (const r of own(doc.u, ev.sub) || []) ix.set(r[0], r); indexes.set(ev.sub, ix); }
      const k = rowKey(hr, mi, ev.oc, ev.lt);
      let row = ix.get(k);
      if (!row) { row = [k, 0]; ix.set(k, row); (Object.hasOwn(doc.u, ev.sub) ? doc.u[ev.sub] : (doc.u[ev.sub] = [])).push(row); }
      row[1]++;
      if (ev.oc === 0 && ev.ms !== null) {
        const bin = latencyBin(ev.ms); let j = 2;
        while (j < row.length && row[j] % HPACK !== bin) j++;
        if (j < row.length) row[j] += HPACK; else row.push(HPACK + bin);
      }
    }
    for (const [hk, add] of fresh) if (add) doc.ids[hk] = (own(doc.ids, hk) || '') + add;
    for (const hk of Object.keys(doc.ids)) if (Number(hk) < floorHour) delete doc.ids[hk];
    return doc;
  }

  async function add(events, causes = [], { replayFloorMs } = {}) {
    if (!events.length && !causes.length) return;
    const evs = []; for (const e of events) { const n = normalise(e); if (n) evs.push(n); }
    const byDay = new Map(), roster = new Map();
    for (const e of evs) {
      const day = dayOf(e.h); if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(e);
      if (e.sub) { const r = roster.get(e.sub) || { email: e.email, first: e.ts, last: e.ts }; r.last = Math.max(r.last, e.ts); r.first = Math.min(r.first, e.ts); if (e.email) r.email = e.email; roster.set(e.sub, r); }
    }
    for (const [day, list] of byDay) {
      const floorHour = replayFloorMs === -Infinity ? -Infinity : replayFloorMs !== undefined ? Math.floor(replayFloorMs / 3600e3) : list.reduce((m, e) => Math.max(m, e.h / HOUR), 0) - 6;
      await store.update('usage/agg/' + day, (doc) => applyDay(doc, list, floorHour), emptyDay());
    }
    if (roster.size) await store.update('usage/roster', (doc) => {
      for (const [sub, r] of roster) { const c = own(doc, sub) || { first: r.first, last: r.last, email: r.email }; c.last = Math.max(c.last, r.last); c.first = Math.min(c.first, r.first); if (r.email) c.email = r.email; doc[sub] = c; }
      return doc;
    }, {});
    // causes: the upstream error line and the inference event are separate log lines that can arrive in either order or in different pages
    const t = now(), ids = new Set(evs.map((e) => e.id));
    const cd = await store.update('usage/causes', (doc) => {
      const d = { c: own(doc, 'c') && typeof doc.c === 'object' ? doc.c : {}, e: own(doc, 'e') && typeof doc.e === 'object' ? doc.e : {} };
      for (const part of [d.c, d.e]) for (const k of Object.keys(part)) if (t - part[k].at > CAUSE_TTL_MS) delete part[k];
      let nc = Object.keys(d.c).length, ne = Object.keys(d.e).length;
      for (const c of causes) if (typeof c.requestId === 'string' && !RESERVED.has(c.requestId) && nc < MAX_CAUSES) { d.c[c.requestId.slice(0, MAX_ID)] = { cause: c.cause, at: c.at ?? t }; nc++; }
      for (const e of evs) if (e.id && !RESERVED.has(e.id) && e.outcome === 'upstream_error' && ne < MAX_CAUSES) { d.e[e.id] = { sub: e.sub, at: t }; ne++; }
      return d;
    }, { c: {}, e: {} });
    // recent ring, one shard per hash(sub): each user keeps their own last RECENT_PER_USER requests (a busy user cannot push a quiet one out)
    const shards = new Map();
    const shard = (sub) => { const n = shardName(sub); if (!shards.has(n)) shards.set(n, { add: new Map(), fix: [] }); return shards.get(n); };
    for (const e of evs) {
      if (!e.sub) continue;
      const m = shard(e.sub).add; if (!m.has(e.sub)) m.set(e.sub, []);
      m.get(e.sub).push([e.ts, e.id, e.model, e.oc, e.status, e.ms ?? 0, e.lt, e.cause || own(cd.c, e.id)?.cause || null]);
    }
    for (const c of causes) {                                           // a cause for an event ingested earlier: patch it in its user's ring
      if (ids.has(c.requestId)) continue;
      const hit = own(cd.e, c.requestId); if (hit?.sub) shard(hit.sub).fix.push([hit.sub, c.requestId, c.cause]);
    }
    const jobs = [...shards].map(([name, s]) => store.update(name, (doc) => {
      if (!doc || doc.v !== 2) doc = { v: 2, u: {} };
      for (const [sub, items] of s.add) {
        const ring = own(doc.u, sub) || [], have = new Set(ring.map((r) => r[1]));
        for (const it of items) {
          if (it[1] && have.has(it[1])) { const prior = ring.find((r) => r[1] === it[1]); if (prior && !prior[7] && it[7]) prior[7] = it[7]; continue; }   // replay: only a cause can be new
          have.add(it[1]); ring.push(it);
        }
        ring.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1));
        ring.length = Math.min(ring.length, RECENT_PER_USER);
        doc.u[sub] = ring;
      }
      for (const [sub, id, cause] of s.fix) for (const r of own(doc.u, sub) || []) if (r[1] === id && !r[7]) r[7] = cause;
      return doc;
    }, { v: 2, u: {} }));
    const settled = await Promise.allSettled(jobs);
    const bad = settled.find((r) => r.status === 'rejected'); if (bad) throw bad.reason;
  }

  // ---- reads ----
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
    return out;
  }
  async function days(w) {
    const names = []; for (let s = Math.floor(w.start / DAY) * DAY; s < w.end; s += DAY) names.push([dayOf(s), s]);
    return (await mapLimit(names, 8, async ([d, s]) => { const doc = await store.get('usage/agg/' + d, null); return doc ? { doc: upgradeDay(doc), s } : null; })).filter(Boolean);
  }
  // fn(sub, hourSec, modelName, outcomeName, lt, n, histPairs(array, may be empty))
  function eachRow(ds, w, fn, onlySub = null) {
    const k = keep(w.data);
    for (const { doc, s } of ds) {
      const subs = onlySub === null ? Object.keys(doc.u) : (Object.hasOwn(doc.u, onlySub) ? [onlySub] : []);
      for (const sub of subs) for (const r of doc.u[sub]) {
        const key = r[0], h = s + keyHr(key) * HOUR, lt = keyLt(key);
        if (h < w.start || h >= w.end || !k(lt)) continue;
        fn(sub, h, doc.m[keyMi(key)] ?? '', OUTCOMES[keyOc(key)], lt, r[1], r);
      }
    }
  }
  const idx = (w, h) => Math.min(w.n - 1, Math.max(0, Math.floor((h - w.start) / w.b)));
  const zeros = (n) => Array(n).fill(0);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const readRoster = async () => { const r = await store.get('usage/roster', {}); return r && typeof r === 'object' ? r : {}; };

  return {
    add, stats: () => ({ ...counters }),
    // legacy flat rows ({h, sub, model, outcome, lt, n}) for callers that want them
    async rows(w) { const out = []; eachRow(await days(w), w, (sub, h, model, outcome, lt, n) => out.push({ h, sub, model, outcome, lt: !!lt, n })); return out; },
    async roster() { const r = await readRoster(); return new Map(Object.entries(r).map(([sub, v]) => [sub, v?.email || null])); },
    async users(w) {
      const roster = await readRoster(), by = new Map(), spark = new Map();
      for (const [sub, v] of Object.entries(roster)) by.set(sub, { sub, email: v?.email || null, requests: 0, ok: 0, lastSeen: iso(v?.last), models: new Set() });
      eachRow(await days(w), w, (sub, h, model, outcome, lt, n) => {
        if (!sub) return;
        let u = by.get(sub); if (!u) { u = { sub, email: null, requests: 0, ok: 0, lastSeen: null, models: new Set() }; by.set(sub, u); }
        u.requests += n; if (outcome === 'ok') u.ok += n; if (model) u.models.add(model);
        let sp = spark.get(sub); if (!sp) { sp = zeros(w.n); spark.set(sub, sp); } sp[idx(w, h)] += n;
      });
      return { rows: [...by.values()].map((u) => ({ ...u, models: [...u.models] })), spark };
    },
    async detail(sub, w, limit = 25) {
      const models = new Map(), series = new Map();
      eachRow(await days(w), w, (_s, h, model, outcome, lt, n, r) => {
        const m = model || '(none)';
        let s = models.get(m); if (!s) { s = { model: m, requests: 0, ok: 0, hist: new Map() }; models.set(m, s); }
        s.requests += n;
        if (outcome === 'ok') { s.ok += n; for (let i = 2; i < r.length; i++) addHist(s.hist, r[i] % HPACK, Math.floor(r[i] / HPACK)); }
        let sr = series.get(m); if (!sr) { sr = zeros(w.n); series.set(m, sr); } sr[idx(w, h)] += n;
      }, sub);
      // recent: THIS user's own ring first, then the window and data filter, then the limit
      const lim = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 25, RECENT_PER_USER));
      const email = (await readRoster())[sub]?.email || '';
      const shardDoc = await store.get(shardName(sub), null);
      let ring = own(shardDoc?.u, sub);
      let recent;
      if (ring) {
        recent = ring.map(([ts, id, model, oc, status, ms, lt, cause]) => ({ ts: new Date(ts).toISOString(), id, sub, email, model, outcome: OUTCOMES[oc], status, ms, lt: !!lt, cause: cause || null }));
      } else {                                                                      // pre-upgrade global ring, if one is still around
        const legacy = await store.get('usage/recent', null);
        recent = Array.isArray(legacy?.items) ? legacy.items.filter((r) => r.sub === sub) : [];
      }
      const lo = w.start * 1000, hi = w.end * 1000, kr = keepRecent(w.data);
      recent = recent.filter((r) => { const t = Date.parse(r.ts); return t >= lo && t < hi && kr(r); }).slice(0, lim);
      const object = (m) => Object.fromEntries([...m]);
      return {
        series: { models: [...series.keys()], values: object(series) },
        models: [...models.values()].sort((a, b) => b.requests - a.requests).map((s) => ({ model: s.model, requests: s.requests, ok: s.ok, p50: medianOf(s.hist) })),
        recent,
      };
    },
    async company(w) {
      const totals = { requests: 0, ok: 0, upstream_errors: 0, blocked: 0, rejected: 0, users: 0 };
      const users = new Map(), models = new Map(), series = new Map(), roster = await readRoster();
      eachRow(await days(w), w, (sub, h, model, outcome, lt, n) => {
        totals.requests += n; if (outcome === 'ok') totals.ok += n; else if (outcome === 'upstream_error') totals.upstream_errors += n; else if (outcome === 'spend_cap') totals.blocked += n; else totals.rejected += n;
        const m = model || '(none)'; let mm = models.get(m); if (!mm) { mm = { model: m, requests: 0, ok: 0 }; models.set(m, mm); } mm.requests += n; if (outcome === 'ok') mm.ok += n;
        if (sub) {
          let u = users.get(sub); if (!u) { u = { sub, email: own(roster, sub)?.email || null, requests: 0 }; users.set(sub, u); } u.requests += n;
          let sr = series.get(sub); if (!sr) { sr = zeros(w.n); series.set(sub, sr); } sr[idx(w, h)] += n;
        }
      });
      totals.users = users.size;
      return { totals, byUser: [...users.values()].sort((a, b) => b.requests - a.requests), byModel: [...models.values()].sort((a, b) => b.requests - a.requests), series: Object.fromEntries(series) };
    },
  };
}
