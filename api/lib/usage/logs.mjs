// Cloud backend: pulls the gateway's own request events out of Cloud Logging (Cloud Run revision logs) and feeds them to the
// shared aggregator. Dependency-free: REST + the Cloud Run metadata server for credentials.
//
// Cursor (store key `usage/cursor`): { ts, ids, seen }
//   ts    newest log timestamp consumed so far (RFC 3339, always 9 fractional digits, so strings sort like times)
//   ids   insertIds seen at exactly `ts`
//   seen  [[ts, insertId]] for everything within LAG_MS of `ts`. Each run re-reads from `ts - LAG_MS` and skips what is in `seen`, so
//         entries that Cloud Logging makes visible late (it is not strictly ordered at ingestion) are still counted, once.
// The cursor only moves after a page has been handed to the aggregator, so a failure never skips events. If a run dies between
// "page aggregated" and "cursor saved" that page is fed again on the next run; the aggregator is idempotent per request id (see
// aggregate.mjs), so it is NOT counted twice. A cursor that cannot be read (store error, bad shape) fails the run loudly instead of
// restarting the backfill (which would recount history).
//
// Two kinds of request events: `inference` (the request reached the model provider, any status) and `spend.blocked` (the gateway refused it
// at a spend limit; it logs NO inference event for that request). A block becomes an event with status 429, no upstream, model unknown ('')
// and cause `over_limit (<period> cap $X)`, so classify() files it as spend_cap. `ingested` counts inference events only.
const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const LOG_API = 'https://logging.googleapis.com/v2/entries:list';
const LAG_MS = 2 * 60e3;
const MAX_PAGES = 20, PAGE_SIZE = 1000, TIMEOUT_MS = 15000, PROBE_TTL_MS = 30e3, OK_FRESH_MS = 10 * 60e3;
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CAUSE_RE = /^[A-Z][A-Z0-9_]{1,60}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

// ---- parsing (pure, exported for tests) ----
// Canonical RFC 3339 UTC with 9 fractional digits, or null.
export function canonTs(s) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(String(s ?? ''));
  if (!m || Number.isNaN(Date.parse(m[1] + 'Z'))) return null;
  return `${m[1]}.${(m[2] || '').padEnd(9, '0')}Z`;
}
const msOf = (canon) => Date.parse(canon.slice(0, 23) + 'Z');
const fmtMs = (ms) => canonTs(new Date(ms).toISOString());
const lowerBound = (canon) => fmtMs(msOf(canon) - LAG_MS);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function parseInference(j, fallbackMs) {
  const status = Number(j.status);
  if (typeof j.request_id !== 'string' || !ID_RE.test(j.request_id) || !Number.isInteger(status) || status < 100 || status > 599) return null;
  const t = typeof j.ts === 'string' ? Date.parse(j.ts) : NaN, ms = j.ms === null || j.ms === undefined || j.ms === '' ? NaN : Number(j.ms);
  return {
    ts: Number.isFinite(t) ? t : fallbackMs, requestId: j.request_id, sub: str(j.sub, 200), email: str(j.email, 320), model: str(j.model, 200),
    status, ms: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null,           // null = unknown: the latency statistics ignore it
    upstream: str(j.upstream, 50), loadTest: j.load_test === true || j.load_test === 'true',
  };
}

// {"evt":"spend.blocked","request_id","sub","cause":"over_limit","cap_cents":"0","source":"user","period":"weekly"[,"load_test":true]}
const PERIOD_RE = /^(daily|weekly|monthly)$/;
function parseBlocked(j, fallbackMs) {
  if (typeof j.request_id !== 'string' || !ID_RE.test(j.request_id)) return null;
  const t = typeof j.ts === 'string' ? Date.parse(j.ts) : NaN;
  const reason = typeof j.cause === 'string' && /^[a-z_]{1,40}$/.test(j.cause) ? j.cause : 'over_limit';
  const period = PERIOD_RE.test(j.period) ? j.period : '', capRaw = String(j.cap_cents ?? ''), cap = /^\d{1,12}$/.test(capRaw) ? Number(capRaw) / 100 : null;
  const detail = [period, cap === null ? '' : `cap $${Number.isInteger(cap) ? cap : cap.toFixed(2)}`].filter(Boolean).join(' ');
  return {
    ts: Number.isFinite(t) ? t : fallbackMs, requestId: j.request_id, sub: str(j.sub, 200), email: str(j.email, 320), model: '',
    status: 429, ms: null, upstream: '', loadTest: j.load_test === true || j.load_test === 'true', cause: detail ? `${reason} (${detail})` : reason,
  };
}

const UPSTREAM_LINE = /warn vertex upstream (\d{3}) request_id=([A-Za-z0-9._:-]{1,200}):\s*(.*)$/s;
function parseUpstreamLine(text) {
  const m = UPSTREAM_LINE.exec(text);
  if (!m) return null;
  let cause = null;
  const i = m[3].indexOf('{');
  if (i >= 0) { try { cause = JSON.parse(m[3].slice(i))?.error?.status; } catch { /* truncated: fall back to a pattern match */ } }
  if (typeof cause !== 'string') cause = /"status"\s*:\s*"([A-Z][A-Z0-9_]{1,60})"/.exec(m[3])?.[1];
  return typeof cause === 'string' && CAUSE_RE.test(cause) ? { requestId: m[2], cause } : null;
}

// One Cloud Logging entry -> { event[, blocked:true] } | { cause } | null (anything that is not ours or is malformed).
export function parseEntry(entry) {
  try {
    const stamp = Date.parse(entry?.timestamp);
    let j = entry?.jsonPayload;
    const text = typeof entry?.textPayload === 'string' ? entry.textPayload : '';
    if (!j && text.startsWith('{')) { try { j = JSON.parse(text); } catch { return null; } }   // JSON line that was not auto-parsed
    if (j && typeof j === 'object') {
      if (j.evt === 'spend.blocked') { const event = parseBlocked(j, stamp); return event ? { event, blocked: true } : null; }
      if (j.evt !== 'inference') return null;
      const event = parseInference(j, stamp);
      return event ? { event } : null;
    }
    if (text.includes('warn vertex upstream')) { const cause = parseUpstreamLine(text); return cause ? { cause } : null; }
  } catch { /* never let one bad line stop a run */ }
  return null;
}

// ---- backend ----
export function create(cfg, { store, aggregator, fetchImpl = fetch, env = process.env, now = () => Date.now(), timeoutMs = TIMEOUT_MS, maxPages = MAX_PAGES, backfillDays } = {}) {
  const service = cfg.gatewayService || 'claude-gateway';
  const days = Number(backfillDays ?? env.USAGE_BACKFILL_DAYS ?? 30);
  const backfillMs = (Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30) * 86400e3;
  let tok = { v: '', exp: 0 }, project = env.GOOGLE_CLOUD_PROJECT || '';
  let inflight = null, lastOkAt = 0, lastError = null, lastIngested = 0, probe = { at: 0, ok: false };

  const call = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  async function token(force = false) {
    if (!force && tok.v && now() < tok.exp) return tok.v;
    const r = await call(`${METADATA}/instance/service-accounts/default/token`, { headers: { 'metadata-flavor': 'Google' } });
    if (!r.ok) throw new Error(`no access token from the metadata server (${r.status})`);
    const j = await r.json();
    if (!j?.access_token) throw new Error('metadata server returned no access token');
    tok = { v: j.access_token, exp: now() + Math.max(30, Number(j.expires_in) || 300) * 1000 - 60e3 };
    return tok.v;
  }
  async function projectId() {
    if (project) return project;
    const r = await call(`${METADATA}/project/project-id`, { headers: { 'metadata-flavor': 'Google' } });
    if (!r.ok) throw new Error(`no project id (set GOOGLE_CLOUD_PROJECT): metadata server ${r.status}`);
    project = (await r.text()).trim();
    if (!project) throw new Error('empty project id from the metadata server');
    return project;
  }
  async function list(body) {
    for (let attempt = 0; ; attempt++) {
      const r = await call(LOG_API, { method: 'POST', headers: { authorization: 'Bearer ' + await token(attempt > 0), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 401 && attempt === 0) continue;                               // expired or revoked token: refresh once
      if (!r.ok) {
        let msg = ''; try { msg = (await r.json())?.error?.message || ''; } catch { /* not JSON */ }
        throw new Error(`cloud logging ${r.status}${msg ? ': ' + String(msg).slice(0, 200) : ''}`);
      }
      return r.json();
    }
  }
  function filterFor(fromCanon) {
    if (!SERVICE_RE.test(service)) throw new Error(`GATEWAY_SERVICE_NAME is not a valid Cloud Run service name`);
    return `resource.type="cloud_run_revision" AND resource.labels.service_name="${service}" AND timestamp>="${fromCanon}" AND (jsonPayload.evt="inference" OR jsonPayload.evt="spend.blocked" OR textPayload:"warn vertex upstream")`;
  }
  async function readCursor() {
    const c = await store.get('usage/cursor', null);
    if (c === null) return null;
    if (!c || typeof c !== 'object' || !canonTs(c.ts) || !Array.isArray(c.ids) || (c.seen !== undefined && !Array.isArray(c.seen))) {
      throw new Error('usage/cursor in the state store is unreadable; delete it to backfill again (this recounts history)');
    }
    return c;
  }

  async function run() {
    let cursor = await readCursor();
    const proj = await projectId();
    let maxTs = cursor?.ts || '';
    const seen = new Set((cursor?.seen || []).map(([t, id]) => `${t}|${id}`));
    for (const id of cursor?.ids || []) seen.add(`${cursor.ts}|${id}`);
    let window = [...(cursor?.seen || [])];
    const from = cursor ? lowerBound(cursor.ts) : fmtMs(now() - backfillMs);
    const filter = filterFor(from);
    let pageToken, total = 0, productive = 0, roster = null;
    const fromMs = msOf(from);
    // The cap counts pages that brought something new. Pages that only re-read the lookback window cost a request but do not count,
    // so a busy window cannot stall progress (a hard limit of 4x still bounds one run).
    for (let page = 0; page < maxPages * 4 && productive < maxPages; page++) {
      const res = await list({ resourceNames: [cfg.usageLogsView || `projects/${proj}`], filter, orderBy: 'timestamp asc', pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
      const events = [], causes = [], fresh = [];
      let inference = 0;
      const prevMax = maxTs;                                       // nothing older than the cursor we had BEFORE this page can be fed again
      for (const e of res?.entries || []) {
        const ts = canonTs(e?.timestamp), id = typeof e?.insertId === 'string' ? e.insertId : '';
        if (!ts || !id) continue;
        const key = `${ts}|${id}`;
        if (seen.has(key)) continue;
        seen.add(key); fresh.push([ts, id]);
        if (ts > maxTs) maxTs = ts;
        const p = parseEntry(e);
        if (p?.event) { events.push(p.event); if (!p.blocked) inference++; } else if (p?.cause) causes.push(p.cause);
      }
      if (events.some((e) => !e.email && e.sub)) {                  // a block has no e-mail of its own: take it from the roster
        roster ||= await aggregator.roster();
        for (const e of events) if (!e.email && e.sub) e.email = roster.get(e.sub) || '';
      }
      if (events.length || causes.length) await aggregator.add(events, causes, { replayFloorMs: prevMax ? msOf(lowerBound(prevMax)) : fromMs });
      if (fresh.length) {
        productive++;
        const keepFrom = lowerBound(maxTs);
        window = [...window, ...fresh].filter(([t]) => t >= keepFrom);
        cursor = { ts: maxTs, ids: window.filter(([t]) => t === maxTs).map(([, id]) => id), seen: window };
        await store.put('usage/cursor', cursor);
      }
      total += inference;
      pageToken = res?.nextPageToken;
      if (!pageToken) break;
    }
    return total;
  }

  // One ingest at a time; callers that overlap share the running one (so the cursor and aggregates never interleave).
  function ingest() {
    if (inflight) return inflight;
    inflight = run().then((n) => { lastOkAt = now(); lastError = null; lastIngested = n; return { ingested: n }; },
      (e) => { lastError = String(e?.message || e); throw e; }).finally(() => { inflight = null; });
    return inflight;
  }

  async function ok() {
    try {
      if (lastError === null && lastOkAt && now() - lastOkAt < OK_FRESH_MS) return true;
      if (now() - probe.at < PROBE_TTL_MS) return probe.ok;
      const proj = await projectId();
      await list({ resourceNames: [cfg.usageLogsView || `projects/${proj}`], filter: `resource.type="cloud_run_revision" AND timestamp>="${fmtMs(now() - 3600e3)}"`, pageSize: 1 });
      probe = { at: now(), ok: true };
    } catch { probe = { at: now(), ok: false }; }
    return probe.ok;
  }

  return {
    source: 'logs', ok, ingest,
    status: () => ({ lastOkAt: lastOkAt || null, lastError, lastIngested, running: !!inflight, aggregator: aggregator.stats?.() ?? null }),
    roster: () => aggregator.roster(), users: (w) => aggregator.users(w), detail: (sub, w, limit) => aggregator.detail(sub, w, limit), company: (w) => aggregator.company(w),
  };
}
