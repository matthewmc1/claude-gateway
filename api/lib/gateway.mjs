// Gateway admin API client (spend limits). Two implementations behind one interface:
//   createHttpGateway: the real gateway.   createMemoryGateway: an in-memory twin used by demo mode and tests.
//
//   ping() -> bool                 listLimits() -> limit[]            effective(subs) -> row[]      effectiveAll() -> row[]
//   audit(limit) -> event[]        upsert(scope, period, cents|null, who) -> limit      remove(id, who) -> void
//   `who` = { key, actor }: the real gateway authenticates with `key`; the twin records `actor`.
import https from 'node:https';
import { HttpError } from './http.mjs';

export const PERIODS = ['daily', 'weekly', 'monthly'];
const MAX_PAGES = 100;                                              // x 1000 rows per page

// fetch() cannot take a custom CA without undici (we ship no dependencies), so a gateway behind a self-signed or corporate CA
// (GATEWAY_CA_PEM) is called with node:https. The PEM is the ONLY trust anchor for that call; the certificate's name must still match the URL.
// Returns the small slice of the fetch Response the client below uses: ok, status, text().
const MAX_RESPONSE = 16 * 1024 * 1024;
export function caFetch(ca) {
  const agent = new https.Agent({ ca, keepAlive: true, maxCachedSessions: 0 });
  return (url, { method = 'GET', headers = {}, body, signal } = {}) => new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { ...headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) }, agent, signal }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX_RESPONSE) { req.destroy(new Error('gateway response too large')); return; } chunks.push(c); });
      res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, text: async () => text, json: async () => JSON.parse(text) }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function createHttpGateway(cfg) {
  // No audience: no Authorization header at all (internal load balancer mode, where Cloud Run's own IAM check is off).
  const callFetch = cfg.gatewayCaPem && /^https:/i.test(cfg.gatewayUrl) ? caFetch(cfg.gatewayCaPem) : (...a) => fetch(...a);
  let idToken = { value: '', exp: 0 };
  async function authHeader() {
    if (!cfg.gatewayAudience) return {};
    if (Date.now() > idToken.exp) {    // Cloud Run service-to-service: an ID token for the gateway, from the metadata server
      const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' + encodeURIComponent(cfg.gatewayAudience),
        { headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(4000) });
      if (!r.ok) { console.error('metadata identity token failed:', r.status); throw new HttpError(502, 'could not get a service identity token'); }
      idToken = { value: await r.text(), exp: Date.now() + 45 * 60e3 };
    }
    return { authorization: 'Bearer ' + idToken.value };
  }
  async function call(method, p, { body, key } = {}) {
    const r = await callFetch(cfg.gatewayUrl + '/v1/organizations/spend_limits' + p, {
      method,
      headers: { ...(await authHeader()), 'x-api-key': key || cfg.readKey, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
    });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw new HttpError(r.status === 401 || r.status === 403 ? 502 : r.status, json?.error?.message || `gateway ${r.status}`);
    return json;
  }
  const paged = async (path, withPeriods) => {
    // Never silently truncate: a partial list would read as "this user has no personal limit" and the overrides code acts on that.
    const rows = []; let page = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const j = await call('GET', path + page);
      rows.push(...j.data);
      if (!(withPeriods ? j.next_page : j.has_more)) return rows;
      page = withPeriods ? '&page=' + encodeURIComponent(j.next_page) : `&after_id=${j.last_id}`;
    }
    throw new HttpError(502, 'too many spend limits to list');
  };
  return {
    async ping() { try { const r = await callFetch(cfg.gatewayUrl + '/protocol', { headers: await authHeader(), signal: AbortSignal.timeout(3000) }); return r.ok; } catch (e) { console.error('gateway ping:', e.message); return false; } },
    listLimits: () => paged('?limit=1000', false),
    async effective(subs) {
      const rows = [];
      for (let i = 0; i < subs.length; i += 50) {
        const q = [...subs.slice(i, i + 50).map((s) => 'user_ids%5B%5D=' + encodeURIComponent(s)), ...PERIODS.map((p) => 'period%5B%5D=' + p), 'limit=1000'].join('&');
        rows.push(...(await call('GET', '/effective?' + q)).data);
      }
      return rows;
    },
    effectiveAll: () => paged('/effective?' + PERIODS.map((p) => 'period%5B%5D=' + p).join('&') + '&limit=1000', true),
    async audit(limit = 200) { return (await call('GET', `/audit?limit=${limit}`)).data; },
    upsert: (scope, period, cents, who) => call('POST', '', { key: who.key, body: { scope, period, amount: cents === null ? null : String(cents) } }),
    remove: (id, who) => call('DELETE', '/' + id, { key: who.key }),
  };
}

// In-memory twin of the gateway's spend-limit behaviour: a personal cap overrides the org default; `null` = unlimited.
// Mirrors the real gateway's write validation and result shapes (verified against it by tests/e2e): upsert -> the limit row with
// type:'spend_limit'; remove -> {type:'spend_limit_deleted', id}; negative/non-numeric amounts, unknown periods and bad scopes -> 400.
// `keys` (optional) = { [key]: 'read'|'write' } makes the twin strict like the real gateway: unknown key -> 502 (the real client maps 401/403
// to 502), a read key cannot write -> 502. Omitted (demo mode, most tests) = every key may write.
export function createMemoryGateway({ users = [], now = () => Date.now(), keys = null } = {}) {
  const limits = []; const audit = []; const spend = new Map(); let auditId = 0, limitId = 0;
  const iso = () => new Date(now()).toISOString();
  const userBy = (sub) => users.find((u) => u.sub === sub);
  const same = (l, scope, period) => l.period === period && l.scope.type === scope.type && (l.scope.user_id || '') === (scope.user_id || '');
  const rec = (actor, action, before, after) => audit.unshift({ type: 'audit_event', id: String(++auditId), created_at: iso(), actor: 'admin-key:' + actor, action, target_id: (after || before).id, before, after, reason: null });
  const row = (sub, period) => {
    const own = limits.find((l) => l.scope.type === 'user' && l.scope.user_id === sub && l.period === period);
    const org = limits.find((l) => l.scope.type === 'organization' && l.period === period);
    const hit = own || org; const u = userBy(sub);
    return {
      scope: { type: 'user', user_id: sub }, groups: [],
      actor: { type: 'user_actor', user_id: sub, name: u?.name ?? null, email_address: u?.email ?? null, deleted: false },
      amount: hit ? hit.amount : null, currency: 'USD', period,
      source: hit ? (own ? { type: 'user', user_id: sub } : { type: 'organization' }) : null, spend_limit_id: hit ? hit.id : null,
      period_to_date_spend: String(spend.get(sub)?.[period] ?? 0),
    };
  };
  const checkKey = (who) => {
    if (!keys) return;
    const role = keys[who?.key];
    if (role !== 'write') throw new HttpError(502, role === 'read' ? 'gateway 403' : 'gateway 401');
  };
  const checkScope = (scope) => {
    if (scope?.type === 'organization') return;
    if (scope?.type === 'user' && typeof scope.user_id === 'string' && scope.user_id) return;
    if (scope?.type === 'rbac_group' && scope.rbac_group_id) return;
    throw new HttpError(400, 'invalid scope');
  };
  const checkAmount = (cents) => {
    if (cents === null) return;
    if (!Number.isSafeInteger(cents) || cents < 0) throw new HttpError(400, 'amount must be a non-negative whole number of cents or null');
  };
  return {
    users, limits, audit, setSpend: (sub, period, cents) => spend.set(sub, { ...(spend.get(sub) || {}), [period]: cents }),
    async ping() { return true; },
    async listLimits() { return limits.map((l) => ({ type: 'spend_limit', currency: 'USD', ...l })); },
    async effective(subs) { return subs.flatMap((s) => PERIODS.map((p) => row(s, p))); },
    async effectiveAll() { return users.flatMap((u) => PERIODS.map((p) => row(u.sub, p))); },
    async audit(n = 200) { return audit.slice(0, n); },
    async upsert(scope, period, cents, who) {
      checkKey(who);
      if (!PERIODS.includes(period)) throw new HttpError(400, 'period must be daily, weekly or monthly');
      checkScope(scope); checkAmount(cents);
      const amount = cents === null ? null : String(cents); const existing = limits.find((l) => same(l, scope, period));
      if (existing) { const before = { ...existing }; existing.amount = amount; existing.updated_at = iso(); rec(who.actor, 'spend_limit.upsert', before, { ...existing }); return { type: 'spend_limit', currency: 'USD', ...existing }; }
      const l = { id: 'spl_' + String(++limitId).padStart(6, '0'), scope: { ...scope }, amount, period, currency: 'USD', created_at: iso(), updated_at: iso() };
      limits.push(l); rec(who.actor, 'spend_limit.upsert', null, { ...l }); return { type: 'spend_limit', ...l };
    },
    async remove(id, who) {
      checkKey(who);
      const i = limits.findIndex((l) => l.id === id);
      if (i < 0) throw new HttpError(404, 'no such limit');
      const [gone] = limits.splice(i, 1); rec(who.actor, 'spend_limit.delete', { ...gone }, null);
      return { type: 'spend_limit_deleted', id };
    },
  };
}
