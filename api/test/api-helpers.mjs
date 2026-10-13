// Shared fixtures for the backend-core tests (not a test file itself): config, fake clock, fake usage backend, seeded memory gateway.
import { loadConfig } from '../lib/config.mjs';
import { createMemoryGateway } from '../lib/gateway.mjs';
import { createMemoryStore } from '../lib/store.mjs';

export const SECRETS = {
  session: 'sess-SECRET-0123456789-abcdefghijklmnop', readKey: 'rk-READ-SECRET', systemKey: 'wk-SYSTEM-SECRET',
  adaPw: 'ada-PASSWORD-secret', adaKey: 'wk-ADA-SECRET', bobPw: 'bob-PASSWORD-secret', bobKey: 'wk-BOB-SECRET',
  localPw: 'local-PASSWORD-secret', localKey: 'wk-LOCAL-SECRET',
};
export const SCHEDULER_SA = 'scheduler@proj.iam.gserviceaccount.com';
export const SCHEDULER_AUDIENCE = 'https://budget-app-abc.a.run.app';
export const MODELS = {
  default: 'sonnet',
  models: [
    { alias: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'default', description: 'Everyday coding.', enabled: true, pricePerMTok: { input: 3, output: 15 } },
    { alias: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'upgrade', description: 'Hardest problems.', enabled: true, pricePerMTok: { input: 15, output: 75 } },
    { alias: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5', tier: 'fast', description: 'Fast and cheap.', enabled: true },
  ],
};

export function testEnv(extra = {}) {
  return {
    GATEWAY_ADMIN_READ_KEY: SECRETS.readKey, GATEWAY_SYSTEM_WRITE_KEY: SECRETS.systemKey, APP_SESSION_SECRET: SECRETS.session,
    APP_ADMINS: JSON.stringify([
      { email: 'Ada@Example.com', name: 'Ada Admin', password: SECRETS.adaPw, writeKey: SECRETS.adaKey },
      { email: 'bob@example.com', password: SECRETS.bobPw, writeKey: SECRETS.bobKey },
    ]),
    SCHEDULER_SA, SCHEDULER_AUDIENCE, MODELS_JSON: JSON.stringify(MODELS), ...extra,
  };
}
export const testCfg = (extraEnv = {}, patch = {}) => ({ ...loadConfig(testEnv(extraEnv)), usageSource: 'none', ...patch });

export function fakeClock(iso = '2026-03-10T12:00:00Z') {
  const c = { t: Date.parse(iso), now: () => c.t, advance(ms) { c.t += ms; return c; }, set(isoStr) { c.t = Date.parse(isoStr); return c; } };
  return c;
}
export const H = 3600e3, D = 86400e3;
export const isoAt = (clock, ms) => new Date(clock.t + ms).toISOString();

export const USERS = [
  { sub: 'u1', email: 'u1@example.com', name: 'User One' },
  { sub: 'u2', email: 'u2@example.com', name: 'User Two' },
  { sub: 'u3', email: 'u3@example.com', name: 'User Three' },
];
export const ADMIN = { email: 'ada@example.com', name: 'Ada Admin', writeKey: SECRETS.adaKey };
export const SYSTEM_WHO = { key: 'seed', actor: 'seed' };

// Memory gateway with a company default of $150 weekly / $500 monthly and three users.
export async function seededGateway(clock) {
  const gw = createMemoryGateway({ users: USERS, now: clock.now });
  await gw.upsert({ type: 'organization' }, 'weekly', 15000, SYSTEM_WHO);
  await gw.upsert({ type: 'organization' }, 'monthly', 50000, SYSTEM_WHO);
  return gw;
}
export const personal = (gw, sub, period) => gw.limits.find((l) => l.scope.type === 'user' && l.scope.user_id === sub && l.period === period) || null;
export const effAmount = async (gw, sub, period) => (await gw.effective([sub])).find((r) => r.period === period).amount;
export const silent = () => {};

export function fakeUsage({ users = [], detail = {}, company = null, roster = new Map(), source = 'demo', ok = true } = {}) {
  return {
    source, ingested: 0, ok: async () => ok, roster: async () => roster,
    async users() { return { rows: users, spark: new Map() }; },
    async detail(sub) { return detail[sub] || { series: { models: [], values: {} }, models: [], recent: [] }; },
    async company() { return company || { totals: { requests: 0, ok: 0, upstream_errors: 0, blocked: 0, rejected: 0, users: 0 }, byUser: [], byModel: [], series: {} }; },
    async ingest() { this.ingested++; return { ingested: 3 }; },
  };
}
export const memStore = () => createMemoryStore();
