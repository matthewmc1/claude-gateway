// One-shot tick for the Cloud Run job `claude-budget-tick` (command: node api/tick.mjs). Cloud Scheduler starts the job through the Run API,
// because a scheduler cannot call an IAP-protected service. Runs the overrides tick (apply what is due, revert what has expired) and the usage
// ingest once, with the same dependencies as the server, prints JSON log lines (`evt: "tick.job"`) and exits 0 on success, 1 on any failure
// (bad config, an override tick error, a failed ingest, or the hard timeout). Overrides that end up `failed` are data, reported in the log
// line but not a job failure. Safe to run from any number of instances at once (the overrides code guards itself in the store).
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { buildDeps } from './lib/routes.mjs';
import { createOverrides } from './lib/overrides.mjs';
import { storeKind } from './lib/store.mjs';

const DEFAULT_TIMEOUT_MS = 240e3;
const msg = (e) => String(e?.message || e).slice(0, 300);
const defaultLog = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

function withTimeout(p, ms, what) {
  let t;
  const timer = new Promise((_, no) => { t = setTimeout(() => no(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// The job must act on the SAME state as the service. On Cloud Run that is the state bucket: without APP_STATE_BUCKET the store silently becomes an
// empty local directory, the tick finds no overrides, reports success and no boost is ever ended by the job. Refuse to run instead (throws).
export function checkJobConfig(cfg) {
  if (cfg.inCloud && !cfg.demo && storeKind(cfg) !== 'gcs') throw new Error('on Cloud Run the tick job needs APP_STATE_BUCKET (the service\'s state bucket): without it the job would read an empty local store and never end a temporary boost');
}

// Returns { ok, overrides, usage, error? }; never throws. `deps` = { now, store, usage, gateway } (buildDeps), injectable for tests.
export async function runTick(cfg, deps, { log = defaultLog, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const started = Date.now();
  log({ evt: 'tick.job', phase: 'start' });
  const out = { ok: false, overrides: null, usage: null };
  try {
    const overrides = deps.overrides || createOverrides({ store: deps.store, gateway: deps.gateway, cfg, now: deps.now || (() => Date.now()), log });
    // Separate steps, so a slow or failing ingest never stops a revert from running (and vice versa).
    const [o, u] = await withTimeout(Promise.allSettled([overrides.tick(), deps.usage.ingest()]), timeoutMs, 'tick');
    if (o.status === 'fulfilled') out.overrides = o.value; else { out.error = 'overrides tick failed'; log({ evt: 'tick.job', phase: 'overrides', ok: false, error: msg(o.reason) }); }
    if (u.status === 'fulfilled') out.usage = u.value; else { out.error ||= 'usage ingest failed'; log({ evt: 'tick.job', phase: 'usage', ok: false, error: msg(u.reason) }); }
    out.ok = o.status === 'fulfilled' && u.status === 'fulfilled';
  } catch (e) {
    out.error = msg(e);
  }
  log({ evt: 'tick.job', phase: 'done', ok: out.ok, store: storeKind(cfg), ms: Date.now() - started, ...(out.overrides ? { applied: out.overrides.applied, ended: out.overrides.ended, failed: out.overrides.failed } : {}),
    ...(out.usage ? { ingested: out.usage.ingested } : {}), ...(out.error ? { error: out.error } : {}) });
  return out;
}

async function main() {
  const timeoutMs = Number(process.env.TICK_TIMEOUT_MS) >= 1000 ? Number(process.env.TICK_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  setTimeout(() => { defaultLog({ evt: 'tick.job', phase: 'done', ok: false, error: 'hard timeout' }); process.exit(1); }, timeoutMs + 15e3);
  let cfg;
  try { cfg = loadConfig(); checkJobConfig(cfg); } catch (e) { defaultLog({ evt: 'tick.job', phase: 'config', ok: false, error: msg(e) }); return 1; }
  try {
    const deps = await withTimeout(buildDeps(cfg), timeoutMs, 'start-up');
    return (await runTick(cfg, deps, { timeoutMs })).ok ? 0 : 1;
  } catch (e) { defaultLog({ evt: 'tick.job', phase: 'start', ok: false, error: msg(e) }); return 1; }
}

// Run only as the entry point. Node resolves import.meta.url through symlinks but leaves argv[1] as given, so compare real paths: a plain
// string comparison silently skipped main() (no output, exit 0) when started through a symlinked directory.
const realUrl = (p) => { try { return pathToFileURL(fs.realpathSync(p)).href; } catch { return pathToFileURL(p).href; } };
if (process.argv[1] && realUrl(fileURLToPath(import.meta.url)) === realUrl(process.argv[1])) process.exit(await main());
