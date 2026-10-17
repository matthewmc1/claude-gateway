// api/tick.mjs: the Cloud Run job entry. Dependencies are injected (no real services); the subprocess tests use demo mode and an empty environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOverrides } from '../lib/overrides.mjs';
import { checkJobConfig, runTick } from '../tick.mjs';
import { ADMIN, H, effAmount, fakeClock, fakeUsage, isoAt, memStore, seededGateway, testCfg } from './api-helpers.mjs';

const TICK = fileURLToPath(new URL('../tick.mjs', import.meta.url));
const lines = [];
const collect = () => { lines.length = 0; return (o) => lines.push(o); };
const done = () => lines.find((l) => l.phase === 'done');

async function setup() {
  const clock = fakeClock(), gw = await seededGateway(clock), store = memStore(), cfg = testCfg();
  const usage = fakeUsage();
  const deps = { now: clock.now, store, usage, gateway: gw };
  const o = createOverrides({ store, gateway: gw, cfg, now: clock.now, log: () => {} });
  return { clock, gw, store, cfg, usage, deps, o };
}

test('a tick applies what is due and ingests usage once; JSON lines say so', async () => {
  const { clock, gw, cfg, deps, usage, o } = await setup();
  await o.create({ sub: 'u1', period: 'weekly', extraUsd: 50, startsAt: isoAt(clock, 1 * H), endsAt: isoAt(clock, 20 * H), reason: 'on-call week' }, ADMIN);
  clock.advance(2 * H);
  const out = await runTick(cfg, deps, { log: collect() });
  assert.equal(out.ok, true); assert.deepEqual(out.overrides, { applied: 1, ended: 0, failed: 0 }); assert.equal(usage.ingested, 1); assert.deepEqual(out.usage, { ingested: 3 });
  assert.equal(await effAmount(gw, 'u1', 'weekly'), '20000');
  assert.deepEqual(lines.filter((l) => l.evt === 'tick.job').map((l) => l.phase), ['start', 'done']);
  assert.equal(lines[0].phase, 'start');
  assert.deepEqual({ ok: done().ok, applied: done().applied, ended: done().ended, failed: done().failed, ingested: done().ingested }, { ok: true, applied: 1, ended: 0, failed: 0, ingested: 3 });
  // and the end of the boost
  clock.advance(24 * H);
  const out2 = await runTick(cfg, deps, { log: collect() });
  assert.equal(out2.ok, true); assert.equal(out2.overrides.ended, 1); assert.equal(await effAmount(gw, 'u1', 'weekly'), '15000');
});
test('nothing due: still a success', async () => {
  const { cfg, deps } = await setup();
  const out = await runTick(cfg, deps, { log: collect() });
  assert.equal(out.ok, true); assert.deepEqual(out.overrides, { applied: 0, ended: 0, failed: 0 });
});
test('an overrides failure fails the job, and the ingest still ran', async () => {
  const { cfg, deps, usage } = await setup();
  const out = await runTick(cfg, { ...deps, overrides: { tick: async () => { throw new Error('store exploded'); } } }, { log: collect() });
  assert.equal(out.ok, false); assert.equal(usage.ingested, 1);
  assert.equal(done().ok, false); assert.match(done().error, /overrides tick failed/);
  assert.ok(lines.some((l) => l.phase === 'overrides' && l.ok === false && /store exploded/.test(l.error)));
});
test('an ingest failure fails the job (so it shows red), and the overrides tick still ran', async () => {
  const { cfg, deps } = await setup();
  let ticked = 0;
  const usage = { ...fakeUsage(), ingest: async () => { throw new Error('logging api 503'); } };
  const out = await runTick(cfg, { ...deps, usage, overrides: { tick: async () => { ticked++; return { applied: 0, ended: 0, failed: 0 }; } } }, { log: collect() });
  assert.equal(out.ok, false); assert.equal(ticked, 1);
  assert.match(done().error, /usage ingest failed/); assert.equal(done().applied, 0);
});
test('overrides that ended up failed are reported but are data, not a job failure', async () => {
  const { cfg, deps } = await setup();
  const out = await runTick(cfg, { ...deps, overrides: { tick: async () => ({ applied: 0, ended: 0, failed: 2 }) } }, { log: collect() });
  assert.equal(out.ok, true); assert.equal(done().failed, 2);
});
test('hard timeout: a hung step ends the run as a failure instead of hanging forever', async () => {
  const { cfg, deps } = await setup();
  const t0 = Date.now();
  const out = await runTick(cfg, { ...deps, usage: { ...fakeUsage(), ingest: () => new Promise(() => {}) } }, { log: collect(), timeoutMs: 80 });
  assert.equal(out.ok, false); assert.ok(Date.now() - t0 < 2000);
  assert.match(done().error, /timed out after/);
});
test('log lines are JSON-serialisable and carry no secrets', async () => {
  const { cfg, deps } = await setup();
  await runTick(cfg, { ...deps, overrides: { tick: async () => { throw new Error('boom'); } } }, { log: collect() });
  const blob = JSON.stringify(lines);
  for (const secret of ['wk-ADA-SECRET', 'rk-READ-SECRET', 'wk-SYSTEM-SECRET', 'sess-SECRET']) assert.ok(!blob.includes(secret));
});

// ---- the real entry point, in a subprocess with a clean environment ----
const run = (env, script = TICK) => new Promise((resolve) => {
  const p = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
  const kill = setTimeout(() => p.kill('SIGKILL'), 20000);
  p.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err, lines: out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) }); });
});
test('node api/tick.mjs in demo mode exits 0 and prints tick.job lines', async () => {
  const r = await run({ APP_DEMO: '1' });
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(r.lines.every((l) => l.evt === 'tick.job' && typeof l.ts === 'string'));
  assert.equal(r.lines.at(-1).phase, 'done'); assert.equal(r.lines.at(-1).ok, true);
});
test('node api/tick.mjs with a bad configuration exits 1 with a JSON line (no stack trace, no secrets)', async () => {
  const r = await run({ GATEWAY_ADMIN_READ_KEY: 'rk-fake', APP_AUTH_MODE: 'iap', APP_ADMINS: JSON.stringify([{ email: 'a@example.com', writeKey: 'k-fake-write-key' }]) });
  assert.equal(r.code, 1);
  assert.equal(r.lines.length, 1); assert.equal(r.lines[0].phase, 'config'); assert.equal(r.lines[0].ok, false); assert.match(r.lines[0].error, /IAP_AUDIENCE/);
  const demoCloud = await run({ APP_DEMO: '1', CLOUD_RUN_JOB: 'claude-budget-tick' });
  assert.equal(demoCloud.code, 1, 'a Cloud Run job is Cloud Run: demo mode is refused there too'); assert.match(demoCloud.lines[0].error, /demo mode/);
});
test('node api/tick.mjs fails (exit 1) when the gateway is unreachable', async () => {
  const r = await run({ GATEWAY_ADMIN_READ_KEY: 'rk-fake', GATEWAY_URL: 'http://127.0.0.1:19259', APP_ADMINS: JSON.stringify([{ email: 'a@example.com', password: 'a-long-password-1', writeKey: 'k-fake-write-key' }]),
    GATEWAY_SYSTEM_WRITE_KEY: 'sk-fake-system-key', APP_SESSION_SECRET: 'abcdefghij0123456789ABCDEFGHIJ-_x', APP_DATA_DIR: '/tmp/iap-tick-test-' + process.pid });
  // nothing is due and the ingest has no source, so the job is healthy even without a gateway: it must not hang and must exit cleanly
  assert.equal(r.code, 0, r.err + r.out); assert.equal(r.lines.at(-1).ok, true);
});

const jobEnv = (extra = {}) => ({ GATEWAY_ADMIN_READ_KEY: 'rk-fake', GATEWAY_URL: 'http://127.0.0.1:19259', APP_ADMINS: JSON.stringify([{ email: 'a@example.com', password: 'a-long-password-1', writeKey: 'k-fake-write-key' }]),
  GATEWAY_SYSTEM_WRITE_KEY: 'sk-fake-system-key', APP_SESSION_SECRET: 'abcdefghij0123456789ABCDEFGHIJ-_x', APP_DATA_DIR: path.join(os.tmpdir(), 'iap-tick-job-' + process.pid), ...extra });
test('fail closed: a Cloud Run job without APP_STATE_BUCKET refuses to run (it would tick an empty local store and report success)', async () => {
  const dir = path.join(os.tmpdir(), 'iap-tick-job-' + process.pid);
  for (const extra of [{}, { APP_STATE_BUCKET: '' }]) {
    const r = await run(jobEnv({ CLOUD_RUN_JOB: 'claude-budget-tick', ...extra }));
    assert.equal(r.code, 1, r.err + r.out);
    assert.equal(r.lines.length, 1); assert.equal(r.lines[0].evt, 'tick.job'); assert.equal(r.lines[0].phase, 'config'); assert.equal(r.lines[0].ok, false); assert.match(r.lines[0].error, /APP_STATE_BUCKET/);
  }
  assert.ok(!fs.existsSync(dir), 'and it never created a local store');
  // the same environment off Cloud Run (a laptop) is fine with the file store
  const local = await run(jobEnv());
  assert.equal(local.code, 0, local.err + local.out); assert.equal(local.lines.at(-1).store, 'file');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('checkJobConfig: needs the bucket on Cloud Run only, never complains in demo mode or locally; iap mode keeps its own requirements (loadConfig)', () => {
  assert.throws(() => checkJobConfig({ inCloud: true, demo: false, stateBucket: '' }), /APP_STATE_BUCKET/);
  assert.doesNotThrow(() => checkJobConfig({ inCloud: true, demo: false, stateBucket: 'my-bucket' }));
  assert.doesNotThrow(() => checkJobConfig({ inCloud: false, demo: false, stateBucket: '' }));
  assert.doesNotThrow(() => checkJobConfig({ inCloud: true, demo: true, stateBucket: '' }));
});
test('iap mode on Cloud Run without IAP_AUDIENCE or APP_ADMINS: exit 1 with a config line before anything else', async () => {
  const base = jobEnv({ CLOUD_RUN_JOB: 'claude-budget-tick', APP_STATE_BUCKET: 'fake-bucket', APP_AUTH_MODE: 'iap' });
  const noAud = await run({ ...base, APP_ADMINS: JSON.stringify([{ email: 'a@example.com', writeKey: 'k-fake-write-key' }]) });
  assert.equal(noAud.code, 1); assert.equal(noAud.lines[0].phase, 'config'); assert.match(noAud.lines[0].error, /IAP_AUDIENCE/);
  const noAdmins = await run({ ...base, APP_ADMINS: '', IAP_AUDIENCE: '/projects/123456789012/locations/europe-west2/services/claude-budget-app' });
  assert.equal(noAdmins.code, 1); assert.equal(noAdmins.lines[0].phase, 'config'); assert.match(noAdmins.lines[0].error, /APP_ADMINS/);
  const emptyMode = await run({ ...base, APP_AUTH_MODE: '' });
  assert.equal(emptyMode.code, 1); assert.match(emptyMode.lines[0].error, /APP_AUTH_MODE is set but empty/);
});
test('started through a symlinked directory the entry point still runs (a guard that silently skips is the wrong failure mode for a job)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-link-'));
  try {
    fs.symlinkSync(path.dirname(TICK), path.join(d, 'apilink'));
    const r = await run({}, path.join(d, 'apilink', 'tick.mjs'));
    assert.equal(r.code, 1, 'exit code ' + r.code + ' ' + r.err);
    assert.equal(r.lines.length, 1); assert.equal(r.lines[0].phase, 'config'); assert.match(r.lines[0].error, /GATEWAY_ADMIN_READ_KEY/);
    const demo = await run({ APP_DEMO: '1' }, path.join(d, 'apilink', 'tick.mjs'));
    assert.equal(demo.code, 0, demo.err + demo.out); assert.equal(demo.lines.at(-1).phase, 'done');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
test('importing tick.mjs does not run the job', async () => {
  const r = await new Promise((resolve) => { const p = spawn(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(TICK)}).then(() => console.log('imported'))`], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; p.stdout.on('data', (c) => { o += c; }); p.on('close', (code) => resolve({ code, o })); });
  assert.equal(r.code, 0); assert.equal(r.o.trim(), 'imported');
});
