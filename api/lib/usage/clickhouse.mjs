// p50 here is ClickHouse's quantile(0.5) (approximate, sampled) over ok requests with latency_ms > 0; the aggregator's p50 is a log-binned
// approximation (worst measured error 6.6%) of the same population. Both are approximate by design.
// NOT HANDLED here (needs clickhouse/views.sql): the gateway's `spend.blocked` events (a request refused at a spend limit logs no `inference`
// event). For them to show up as outcome 'spend_cap', v_gateway_requests would have to UNION the log rows with evt='spend.blocked'
// (status 429, empty upstream, model '', period/cap in the cause); until then ClickHouse-sourced dashboards under-count blocked requests.
// Local backend: reads the ClickHouse analytics views (clickhouse/views.sql: v_gateway_requests, v_upstream_errors) over HTTP.
// Every value that reaches SQL is validated first (sub: strict pattern; window numbers: safe integers; `data`: fixed table).
const SUB_RE = /^[A-Za-z0-9_-]{1,200}$/;
const DATA = { all: '1', real: 'NOT {p}is_load_test', loadtest: '{p}is_load_test' };   // fixed table: user input never becomes SQL text
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);   // never used as object keys (F8); such subs are dropped
const EMPTY_TOTALS = { requests: 0, ok: 0, upstream_errors: 0, blocked: 0, rejected: 0, users: 0 };

class UsageStoreError extends Error { constructor(message) { super(message); this.status = 502; } }

function windowOf(w) {
  const ints = ['start', 'end', 'n', 'b'];
  for (const k of ints) if (!Number.isSafeInteger(w?.[k])) throw new TypeError(`bad window: ${k} must be an integer`);
  if (w.n < 1 || w.n > 2000 || w.b < 1 || w.start < 0 || w.end <= w.start) throw new TypeError('bad window');
  if (!Object.hasOwn(DATA, w.data)) throw new TypeError('bad window: data must be all, real or loadtest');
  return w;
}
const filt = (w, alias = '') => DATA[w.data].replace('{p}', alias ? alias + '.' : '');
const range = (w, col = 'ts') => `${col} >= toDateTime(${w.start}) AND ${col} < toDateTime(${w.end})`;
const bucket = (w) => `intDiv(toUnixTimestamp(ts) - ${w.start}, ${w.b})`;
const zeros = (n) => Array(n).fill(0);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isoMs = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null; };
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []).filter((m) => m !== '');

export function create(cfg, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const { url, password } = cfg.clickhouse || {};
  const configured = !!password;

  async function ch(sql) {
    if (!configured) return [];
    const r = await fetchImpl(`${url}/?database=otel&default_format=JSON`, {
      method: 'POST', body: sql, signal: AbortSignal.timeout(timeoutMs),
      headers: { 'x-clickhouse-user': 'otel', 'x-clickhouse-key': password },   // credentials in headers, never in a URL that could be logged
    });
    const t = await r.text();
    if (!r.ok) throw new UsageStoreError(`usage store error ${r.status}: ${t.slice(0, 200)}`);
    try { return JSON.parse(t).data || []; } catch { throw new UsageStoreError('usage store returned invalid JSON'); }
  }

  async function roster() {
    const rows = await ch(`SELECT sub, anyLast(email) AS email FROM v_gateway_requests WHERE sub != '' GROUP BY sub`);
    return new Map(rows.map((r) => [r.sub, r.email || null]));
  }

  async function users(w) {
    windowOf(w);
    const [base, sparkRows] = await Promise.all([
      ch(`SELECT sub, anyLast(email) AS email,
                 countIf(${range(w)}) AS requests,
                 countIf(${range(w)} AND outcome = 'ok') AS ok,
                 toUnixTimestamp64Milli(max(ts)) AS last_ms,
                 arrayFilter(m -> m != '', groupUniqArrayIf(model, ${range(w)})) AS models
          FROM v_gateway_requests WHERE sub != '' AND ${filt(w)} GROUP BY sub`),
      ch(`SELECT sub, ${bucket(w)} AS bi, count() AS c FROM v_gateway_requests
          WHERE sub != '' AND ${range(w)} AND ${filt(w)} GROUP BY sub, bi`),
    ]);
    const spark = new Map();
    for (const r of sparkRows) {
      if (RESERVED.has(r.sub)) continue;
      if (!spark.has(r.sub)) spark.set(r.sub, zeros(w.n));
      const i = num(r.bi); if (i >= 0 && i < w.n) spark.get(r.sub)[i] += num(r.c);
    }
    return { rows: base.filter((r) => !RESERVED.has(r.sub)).map((r) => ({ sub: r.sub, email: r.email || null, requests: num(r.requests), ok: num(r.ok), lastSeen: isoMs(r.last_ms), models: list(r.models) })), spark };
  }

  async function detail(sub, w, limit = 25) {
    if (typeof sub !== 'string' || !SUB_RE.test(sub)) throw new TypeError('bad user id');
    windowOf(w);
    const lim = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 25;
    const where = `sub = '${sub}' AND ${range(w)} AND ${filt(w)}`;
    const [series, models, recent] = await Promise.all([
      ch(`SELECT ${bucket(w)} AS bi, if(model = '', '(none)', model) AS model, count() AS c FROM v_gateway_requests WHERE ${where} GROUP BY bi, model`),
      ch(`SELECT if(model = '', '(none)', model) AS model, count() AS requests, countIf(outcome = 'ok') AS ok,
                 round(quantileIf(0.5)(latency_ms, outcome = 'ok' AND latency_ms > 0)) AS p50
          FROM v_gateway_requests WHERE ${where} GROUP BY model ORDER BY requests DESC`),
      ch(`SELECT toUnixTimestamp64Milli(r.ts) AS ts_ms, r.request_id AS id, r.sub AS sub, r.email AS email, if(r.model = '', '(none)', r.model) AS model,
                 r.outcome AS outcome, r.status AS status, r.latency_ms AS ms, r.is_load_test AS lt, u.cause AS cause
          FROM v_gateway_requests r LEFT JOIN v_upstream_errors u ON u.request_id = r.request_id
          WHERE r.sub = '${sub}' AND ${range(w, 'r.ts')} AND ${filt(w, 'r')} ORDER BY r.ts DESC LIMIT ${lim}`),
    ]);
    const names = [...new Set(series.map((r) => r.model))];
    const values = Object.fromEntries(names.map((m) => [m, zeros(w.n)]));      // fromEntries defines own properties, so a model called "__proto__" is harmless
    for (const r of series) { const i = num(r.bi); if (i >= 0 && i < w.n) values[r.model][i] += num(r.c); }
    return {
      series: { models: names, values },
      models: models.map((m) => ({ model: m.model, requests: num(m.requests), ok: num(m.ok), p50: num(m.p50) || null })),
      recent: recent.map((r) => ({ ts: isoMs(r.ts_ms), id: r.id, sub: r.sub, email: r.email || '', model: r.model, outcome: r.outcome, status: num(r.status), ms: num(r.ms), lt: r.lt === true || r.lt === 1 || r.lt === '1' || r.lt === 'true', cause: r.cause || null })),
    };
  }

  async function company(w) {
    windowOf(w);
    const tail = `${range(w)} AND ${filt(w)}`;
    const [tot, byUser, byModel, series] = await Promise.all([
      ch(`SELECT count() AS requests, countIf(outcome='ok') AS ok, countIf(outcome='upstream_error') AS upstream_errors,
                 countIf(outcome='spend_cap') AS blocked, countIf(outcome='rejected') AS rejected, uniqExactIf(sub, sub != '') AS users
          FROM v_gateway_requests WHERE ${tail}`),
      ch(`SELECT sub, anyLast(email) AS email, count() AS c FROM v_gateway_requests WHERE sub != '' AND ${tail} GROUP BY sub ORDER BY c DESC`),
      ch(`SELECT if(model = '', '(none)', model) AS model, count() AS requests, countIf(outcome='ok') AS ok
          FROM v_gateway_requests WHERE ${tail} GROUP BY model ORDER BY requests DESC`),
      ch(`SELECT ${bucket(w)} AS bi, sub, count() AS c FROM v_gateway_requests WHERE sub != '' AND ${tail} GROUP BY bi, sub`),
    ]);
    const bySub = new Map();                                                    // a Map, not {}: a sub called "__proto__" must not touch Object.prototype
    for (const r of series) { if (RESERVED.has(r.sub)) continue; const i = num(r.bi); if (i >= 0 && i < w.n) { if (!bySub.has(r.sub)) bySub.set(r.sub, zeros(w.n)); bySub.get(r.sub)[i] += num(r.c); } }
    const values = Object.fromEntries(bySub);
    const t = tot[0] || {};
    return {
      totals: Object.fromEntries(Object.keys(EMPTY_TOTALS).map((k) => [k, num(t[k])])),
      byUser: byUser.filter((u) => !RESERVED.has(u.sub)).map((u) => ({ sub: u.sub, email: u.email || null, requests: num(u.c) })),
      byModel: byModel.map((m) => ({ model: m.model, requests: num(m.requests), ok: num(m.ok) })),
      series: values,
    };
  }

  return {
    source: 'clickhouse',
    async ok() {
      if (!configured) return null;
      try { await ch('SELECT 1'); return true; } catch { return false; }
    },
    async ingest() { return { ingested: 0 }; },
    roster, users, detail, company,
  };
}
