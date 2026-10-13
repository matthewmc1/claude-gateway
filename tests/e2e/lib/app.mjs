// Boots the real budget-app HTTP server in-process (createApp) against a REAL gateway, with an injectable clock.
import crypto from 'node:crypto';
import { loadConfig } from '../../../api/lib/config.mjs';
import { createApp } from '../../../api/lib/routes.mjs';
import { createHttpGateway } from '../../../api/lib/gateway.mjs';
import { createFileStore } from '../../../api/lib/store.mjs';
import { createUsage } from '../../../api/lib/usage/index.mjs';
import { E } from './env.mjs';

export const H = 3600e3, D = 86400e3;
export function fakeClock(start = Date.now()) {
  const c = { t: start, now: () => c.t, advance(ms) { c.t += ms; return c; } };
  return c;
}
export const iso = (ms) => new Date(ms).toISOString();

export function appEnv({ gatewayUrl = E.gwUrl, dataDir, extra = {} } = {}) {
  const pw = { ada: crypto.randomBytes(9).toString('hex'), bob: crypto.randomBytes(9).toString('hex') };
  return {
    pw,
    env: {
      GATEWAY_URL: gatewayUrl, GATEWAY_ADMIN_READ_KEY: E.keys.read, GATEWAY_SYSTEM_WRITE_KEY: E.keys.system,
      APP_SESSION_SECRET: crypto.randomBytes(16).toString('hex'), USAGE_SOURCE: 'none', APP_DATA_DIR: dataDir,
      APP_READ_CACHE_MS: '0', APP_HEALTH_CACHE_MS: '0',   // tests assert state immediately after a change
      APP_ADMINS: JSON.stringify([
        { email: 'ada@example.com', name: 'Ada Admin', password: pw.ada, writeKey: E.keys.ada },
        { email: 'bob@example.com', password: pw.bob, writeKey: E.keys.bob },
      ]),
      ...extra,
    },
  };
}

export async function bootApp({ port, dataDir, clock = fakeClock(), gatewayUrl = E.gwUrl, usage = null, usageOptions = null, extraEnv = {}, gateway = null, store = null }) {
  const { env, pw } = appEnv({ gatewayUrl, dataDir, extra: extraEnv });
  const cfg = loadConfig(env);
  const logs = [];
  const st = store || createFileStore(dataDir);
  const us = usage || (usageOptions ? await createUsage({ ...cfg, usageSource: 'logs' }, { store: st, ...usageOptions }) : null);
  const app = createApp(cfg, { now: clock.now, store: st, gateway: gateway || createHttpGateway(cfg), ...(us ? { usage: us } : {}), log: (o) => logs.push(o), lazyTickMs: 0, timerTickMs: 0 });
  await new Promise((ok, no) => { app.server.once('error', no); app.server.listen(port, '127.0.0.1', ok); });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, { token, body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { connection: 'close', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-app-token': token } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, headers: r.headers, text, json };
  };
  const login = async (who = 'ada') => (await call('POST', '/api/login', { body: { email: `${who}@example.com`, password: pw[who] } })).json.token;
  return { app, cfg, call, login, clock, logs, store: st, pw, base, close: () => app.close() };
}
