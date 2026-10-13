// L4: the engineer installer (client/claude-gateway-setup.sh) against the REAL running gateway.
// Isolation follows client/test/run.sh: HOME, CLAUDE_MANAGED_DIR and CLAUDE_USER_DIR are temp dirs inside a test root that the
// installer's own guard (CLAUDE_GATEWAY_TEST_ROOT) enforces, and `env -i` keeps the machine's environment out.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { E } from './lib/env.mjs';
import { ROOT, modelPolicy } from './lib/config.mjs';
import { messages, mintSession, unique, wget } from './lib/gw.mjs';

const SCRIPT = path.join(ROOT, 'client', 'claude-gateway-setup.sh');
const REAL_CLAUDE = execFileSync('sh', ['-c', 'command -v claude']).toString().trim();
let n = 0;
const REAL_PATHS = ['/Library/Application Support/ClaudeCode', '/etc/claude-code', path.join(process.env.HOME || '/nonexistent', '.claude')];
const snapshot = () => REAL_PATHS.map((d) => { try { return fs.readdirSync(d).filter((f) => f.startsWith('managed-settings.json') || f === 'settings.json').map((f) => f + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(d, f))).digest('hex')).join(',') ; } catch { return 'absent'; } }).join('|');
let realBefore;
before(() => { realBefore = snapshot(); });
after(() => { assert.equal(snapshot(), realBefore, 'the real system/user settings were not touched'); });

function sandbox(name = 'c' + ++n) {
  const root = path.join(E.tmp, 'l4-' + name); fs.mkdirSync(path.join(root, 'home'), { recursive: true }); fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const dirs = { managed: path.join(root, 'managed'), user: path.join(root, 'user') };
  const run = (args, { claudeBin = REAL_CLAUDE, extraEnv = {}, tmpRoot = E.tmp } = {}) => {
    const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60000, env: {
      PATH: process.env.PATH, HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), CLAUDE_MANAGED_DIR: dirs.managed, CLAUDE_USER_DIR: dirs.user,
      CLAUDE_GATEWAY_TEST_ROOT: tmpRoot, CLAUDE_GATEWAY_NO_DNS: '1', NO_PROXY: '127.0.0.1,localhost', CLAUDE_BIN: claudeBin, ...extraEnv } });
    return { rc: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
  };
  return { root, ...dirs, run, policy: () => JSON.parse(fs.readFileSync(path.join(dirs.managed, 'managed-settings.json'), 'utf8')), userSettings: () => JSON.parse(fs.readFileSync(path.join(dirs.user, 'settings.json'), 'utf8')) };
}
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

describe('L4 install against the real gateway', () => {
  let sb, install;
  const user = { sub: unique('l4'), email: null };
  user.email = `${user.sub}@example.com`;
  before(() => { sb = sandbox('main'); install = sb.run(['install', '--yes', '--gateway-url', E.gwUrl]); });

  test('install succeeds with the real claude binary, recognises the gateway as loopback, writes only inside the sandbox', () => {
    assert.equal(install.rc, 0, install.out);
    assert.match(install.out, /Claude Code 2\.\d+\.\d+/);
    assert.match(install.out, /gateway address is loopback\/private/);
    assert.ok(install.out.includes(sb.managed), 'wrote to the sandboxed managed dir');
    assert.ok(fs.existsSync(path.join(sb.managed, 'managed-settings.json')));
    assert.ok(fs.existsSync(path.join(sb.user, 'settings.json')));
  });

  test('status reaches the real gateway (/readyz) and reports a healthy install', () => {
    const s = sb.run(['status']);
    assert.equal(s.rc, 0, s.out);
    assert.match(s.out, /gateway URL: http:\/\/127\.0\.0\.1:19161/);
    assert.match(s.out, /gateway reachable and ready/);
    assert.equal(sb.policy().forceLoginGatewayUrl, E.gwUrl);
  });

  test('the installed policy and the policy the gateway itself delivers agree on models (availableModels order, enforcement, alias pins)', async () => {
    const token = mintSession({ sub: user.sub, email: user.email });
    const served = await wget('/managed/settings', { token });
    assert.equal(served.status, 200, served.text.slice(0, 200));
    const g = served.json.settings, p = sb.policy();
    assert.deepEqual(p.availableModels, g.availableModels, 'same list, same order (first = default)');
    assert.equal(p.enforceAvailableModels, g.enforceAvailableModels);
    assert.deepEqual(p.env, g.env, 'ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL pins match what the gateway pushes');
    const cat = modelPolicy();
    assert.deepEqual(p.availableModels, cat.availableModels, 'and both equal config/models.json (default first)');
    assert.deepEqual(p.env, cat.env);
    // anything the gateway pushes that the installer also writes must be identical; the rest must not collide
    for (const k of Object.keys(g)) if (k in p) assert.deepEqual(p[k], g[k], 'key ' + k);
    // client-side locks the installer adds on top
    assert.equal(p.forceLoginMethod, 'gateway'); assert.deepEqual(p.allowedProviders, ['gateway']); assert.equal(p.parentSettingsBehavior, 'merge');
  });

  test('every model the installer allows is accepted by the gateway; models outside the list are refused with 400', async () => {
    const p = sb.policy(), token = mintSession({ sub: user.sub, email: user.email });
    for (const m of [...p.availableModels, ...Object.values(p.env)]) assert.equal((await messages(token, { model: m })).status, 200, m);
    for (const m of ['claude-sonnet-4-5', 'gpt-4', 'claude-opus-4-1']) {
      const r = await messages(token, { model: m });
      assert.equal(r.status, 400, m); assert.match(r.json.error.message, /availableModels/);
    }
    const u = sb.userSettings();
    assert.equal(u.model, p.availableModels[0], 'the engineer default model is the gateway default (first entry)');
    assert.ok(p.availableModels.includes(u.model));
  });

  test('the gateway\'s managed-settings checksum follows the documented rule, and If-None-Match gives 304', async () => {
    const token = mintSession({ sub: user.sub, email: user.email });
    const r = await fetch(E.gwUrl + '/managed/settings', { headers: { authorization: 'Bearer ' + token } });
    const j = await r.json();
    const expected = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canon(j.settings))).digest('hex');
    assert.equal(j.checksum, expected);
    assert.equal(r.headers.get('etag'), `"${expected}"`);
    const again = await fetch(E.gwUrl + '/managed/settings', { headers: { authorization: 'Bearer ' + token, 'if-none-match': `"${expected}"` } });
    assert.equal(again.status, 304);
  });

  test('install is idempotent, print-managed matches the file, uninstall removes the gateway policy and keeps a backup', () => {
    const before = fs.readFileSync(path.join(sb.managed, 'managed-settings.json'), 'utf8');
    const again = sb.run(['install', '--yes', '--gateway-url', E.gwUrl]);
    assert.equal(again.rc, 0); assert.match(again.out, /already up to date/);
    assert.equal(fs.readFileSync(path.join(sb.managed, 'managed-settings.json'), 'utf8'), before);
    const pm = sb.run(['print-managed', '--gateway-url', E.gwUrl]);
    assert.deepEqual(JSON.parse(pm.stdout), sb.policy());
    const un = sb.run(['uninstall', '--yes']);
    assert.equal(un.rc, 0, un.out);
    const f = path.join(sb.managed, 'managed-settings.json');
    const left = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};   // an otherwise-empty policy file is removed entirely
    for (const k of ['forceLoginGatewayUrl', 'forceLoginMethod', 'allowedProviders', 'availableModels', 'env']) assert.ok(!(k in left), k + ' removed');
    assert.ok(fs.readdirSync(sb.managed).some((f) => f.startsWith('managed-settings.json.bak')), 'backup kept');
  });
});

describe('L4 gateway reachability', () => {
  test('status against a URL where nothing listens reports unreachable and exits non-zero', () => {
    const sb = sandbox('down');
    const down = 'http://127.0.0.1:19189';
    assert.equal(sb.run(['install', '--yes', '--gateway-url', down]).rc, 0, 'install does not need the gateway to be up');
    const s = sb.run(['status']);
    assert.notEqual(s.rc, 0); assert.match(s.out, /cannot reach http:\/\/127\.0\.0\.1:\d+\/readyz/);
  });
  test('status notices when this installer points at a different gateway than the installed policy', () => {
    const sb = sandbox('drift');
    sb.run(['install', '--yes', '--gateway-url', 'http://127.0.0.1:19189']);
    const s = sb.run(['status', '--gateway-url', E.gwUrl]);
    assert.notEqual(s.rc, 0); assert.match(s.out, /differs from this installer's/);
  });
  test('the sandbox guard refuses to run when the dirs are outside the test root', () => {
    const sb = sandbox('guard');
    const r = sb.run(['paths'], { tmpRoot: path.join(E.tmp, 'somewhere-else') });
    assert.notEqual(r.rc, 0); assert.match(r.out, /TEST GUARD/);
  });
});
