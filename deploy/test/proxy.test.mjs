// Tests for deploy/proxy.mjs. Loopback only (ports 19360-19379), a fake `gcloud` first on PATH, a mock upstream standing in
// for Cloud Run (reachable only through the test-only target https://proxy-test.invalid + CLAUDE_GATEWAY_PROXY_TEST_UPSTREAM).
//   node --test deploy/test/proxy.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROXY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'proxy.mjs');
const UP_PORT = 19360;
const TOKEN = 'FAKE-ID-TOKEN-0123456789-abcdef';
const SESSION = 'session-token-xyz';
let tmp, binDir, upstream, seen = [], portCounter = 0;
const nextPort_ = () => 19361 + (portCounter++ % 9);   // proxies are stopped one after another, so ports 19361-19369 are reused (the allowed range is 19360-19379)

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxytest-'));
  binDir = path.join(tmp, 'bin'); fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gcloud'), `#!/bin/sh\nif [ "$1 $2" = "auth print-identity-token" ]; then\n  if [ -n "$FAKE_GCLOUD_FAIL" ]; then echo "ERROR leaked ${TOKEN}" >&2; exit 1; fi\n  echo ${TOKEN}\n  exit 0\nfi\necho "unexpected gcloud call: $*" >&2; exit 99\n`, { mode: 0o755 });
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url.startsWith('/sse')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n'); setTimeout(() => res.end('data: two\n\n'), 50); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
});
after(() => { upstream.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function startProxy({ env = {}, target = 'https://proxy-test.invalid', port, useUpstream = true } = {}) {
  port = port || nextPort_();
  const e = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...(useUpstream ? { CLAUDE_GATEWAY_PROXY_TEST_UPSTREAM: `http://127.0.0.1:${UP_PORT}` } : {}), ...env };
  delete e.FAKE_GCLOUD_FAIL_UNSET;
  const child = spawn(process.execPath, [PROXY, target, String(port)], { env: e });
  const p = { child, port, out: '', err: '', exited: new Promise((r) => child.on('exit', (code) => r(code))) };
  child.stdout.on('data', (d) => { p.out += d; });
  child.stderr.on('data', (d) => { p.err += d; });
  p.ready = new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('proxy did not start: ' + p.err)), 5000);
    const poll = setInterval(() => { if (p.out.includes('proxy http://')) { clearTimeout(t); clearInterval(poll); ok(); } }, 20);
    child.on('exit', () => { clearTimeout(t); clearInterval(poll); ok(); });
  });
  p.stop = async () => { child.kill('SIGKILL'); await p.exited; };
  return p;
}

function req(port, { method = 'GET', url = '/v1/messages', headers = {}, body } = {}) {
  return new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', no); if (body) r.write(body); r.end();
  });
}
function raw(port, text) {   // send raw bytes, return what comes back until the socket closes (or 1s)
  return new Promise((ok) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let buf = ''; s.on('data', (d) => { buf += d; }); s.on('close', () => ok(buf)); s.on('error', () => ok(buf)); setTimeout(() => { s.destroy(); ok(buf); }, 1000);
  });
}
async function withProxy(opts, fn) { const p = startProxy(opts); try { await p.ready; await fn(p); } finally { await p.stop(); } }
const upstreamHits = () => seen.length;

test('forwards with the identity token, passes Authorization, drops Cookie/Referer/forwarded headers, keeps anthropic-* and the body', async () => {
  seen = [];
  await withProxy({}, async (p) => {
    const r = await req(p.port, { method: 'POST', url: '/v1/messages?x=1', body: '{"a":1}', headers: {
      authorization: `Bearer ${SESSION}`, 'content-type': 'application/json', cookie: 'sid=secret', referer: 'http://localhost:1/', 'x-forwarded-for': '6.6.6.6',
      'anthropic-version': '2023-06-01', 'x-stainless-lang': 'js', 'x-serverless-authorization': 'Bearer attacker', 'sec-fetch-mode': 'cors', 'x-evil': 'yes' } });
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    const h = seen[0].headers;
    assert.equal(h['x-serverless-authorization'], `Bearer ${TOKEN}`, 'your identity, not the one the client claimed');
    assert.equal(h.authorization, `Bearer ${SESSION}`);
    assert.equal(h['anthropic-version'], '2023-06-01'); assert.equal(h['x-stainless-lang'], 'js');
    assert.equal(h.host, 'proxy-test.invalid');
    for (const k of ['cookie', 'referer', 'x-forwarded-for', 'sec-fetch-mode', 'x-evil']) assert.equal(h[k], undefined, `${k} must not be forwarded`);
    assert.equal(seen[0].url, '/v1/messages?x=1'); assert.equal(seen[0].body, '{"a":1}');
    assert.equal(r.headers['set-cookie'][0], 'sid=1', 'responses pass through');
  });
});

test('streams responses (SSE)', async () => {
  await withProxy({}, async (p) => {
    const r = await req(p.port, { url: '/sse' });
    assert.equal(r.status, 200); assert.match(r.body, /data: one[\s\S]*data: two/);
  });
});

test('Host: only localhost:<port> or 127.0.0.1:<port>', async () => {
  seen = [];
  await withProxy({}, async (p) => {
    assert.equal((await req(p.port, { headers: { host: `127.0.0.1:${p.port}` } })).status, 200);
    for (const host of ['evil.example.com', `evil.example.com:${p.port}`, 'localhost', `localhost:${p.port + 1}`, `localhost.evil.com:${p.port}`]) {
      assert.equal((await req(p.port, { headers: { host } })).status, 400, `Host "${host}"`);
    }
    assert.match(await raw(p.port, 'GET /x HTTP/1.0\r\n\r\n'), /^HTTP\/1\.[01] 400 /, 'no Host header at all');
    assert.equal(seen.length, 1, 'only the good request reached the upstream');
  });
});

test('Origin: foreign, null and other-port origins are refused before the token is fetched; own origins pass', async () => {
  seen = [];
  await withProxy({}, async (p) => {
    for (const origin of ['https://evil.example.com', 'http://evil.example.com', 'null', `http://localhost:${p.port + 1}`, `https://localhost:${p.port}`, `http://localhost.evil.com:${p.port}`, `http://localhost:${p.port}.evil.com`, 'http://127.0.0.1', '']) {
      const r = await req(p.port, { method: 'POST', headers: { origin } });
      assert.equal(r.status, 403, `Origin "${origin}"`);
    }
    assert.equal(seen.length, 0, 'nothing reached the upstream');
    assert.equal((await req(p.port, { method: 'POST', headers: { origin: `http://localhost:${p.port}` } })).status, 200);
    assert.equal((await req(p.port, { method: 'POST', headers: { origin: `http://127.0.0.1:${p.port}` } })).status, 200);
    assert.equal(seen.length, 2);
  });
});

test('Sec-Fetch-Site: cross-site is refused except for a top-level GET navigation (real browser header sets)', async () => {
  seen = [];
  const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' };
  await withProxy({}, async (p) => {
    // the OIDC redirect from the identity provider: a cross-site top-level navigation
    assert.equal((await req(p.port, { url: '/oauth/callback?code=x&state=y', headers: nav })).status, 200, 'cross-site navigation GET is forwarded');
    assert.equal(seen.at(-1).url, '/oauth/callback?code=x&state=y');
    assert.equal((await req(p.port, { url: '/oauth/callback?code=x&state=y', headers: { ...nav, 'sec-fetch-site': 'Cross-Site' } })).status, 200);
    // everything else cross-site is refused
    const refused = {
      'cross-site fetch (cors)': { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      'cross-site no-cors fetch': { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' },
      'cross-site <img>': { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      'cross-site <script>': { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' },
      'cross-site iframe': { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
      'cross-site embed/object': { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'embed' },
      'cross-site navigate without dest': { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
      'cross-site document without mode': { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' },
      'bare cross-site': { 'sec-fetch-site': 'cross-site' },
      'duplicated mode header': { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors, navigate', 'sec-fetch-dest': 'document' },
    };
    for (const [name, headers] of Object.entries(refused)) assert.equal((await req(p.port, { url: '/x', headers })).status, 403, name);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await req(p.port, { method, url: '/x', body: 'a=1', headers: nav })).status, 403, `cross-site ${method} navigation (form submit) refused`);
    assert.equal((await req(p.port, { method: 'POST', url: '/x', headers: { ...nav, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await req(p.port, { url: '/x', headers: { ...nav, origin: 'https://evil.example' } })).status, 403, 'a foreign Origin is refused even on a navigation GET');
    assert.equal(seen.length, 2, 'only the two navigations reached the upstream');
    // same-origin and typed-URL requests are forwarded
    assert.equal((await req(p.port, { url: '/api/users', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: `http://localhost:${p.port}`, referer: `http://localhost:${p.port}/` } })).status, 200, 'same-origin fetch from the app');
    assert.equal((await req(p.port, { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).status, 200, 'typed URL');
    assert.equal((await req(p.port, { headers: { 'sec-fetch-site': 'none' } })).status, 200);
    assert.equal(seen.length, 5);
    assert.ok(!/oauth\/callback|code=x/.test(p.err), 'log lines carry no path: refusals are logged without the path (it can carry an OAuth code)');
    assert.match(p.err, /refused: cross-site request refused \(GET\)/);
    assert.match(p.err, /allowed: cross-site top-level navigation \(GET\)/);
  });
});

test('non-origin-form request lines (absolute URI, //, CONNECT, Upgrade) are refused', async () => {
  seen = [];
  await withProxy({}, async (p) => {
    const host = `Host: localhost:${p.port}`;
    assert.match(await raw(p.port, `GET http://evil.example.com/steal HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400 /);
    assert.match(await raw(p.port, `GET //evil.example.com/steal HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400 /);
    assert.match(await raw(p.port, `GET * HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400 /);
    assert.match(await raw(p.port, `CONNECT evil.example.com:443 HTTP/1.1\r\n${host}\r\n\r\n`), /^HTTP\/1\.1 405 /);
    assert.match(await raw(p.port, `GET /ws HTTP/1.1\r\n${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`), /^HTTP\/1\.1 426 /);
    assert.equal(seen.length, 0);
    assert.match(await raw(p.port, `GET /ok HTTP/1.1\r\n${host}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 200 /);
  });
});

test('PROXY_REQUIRE_SECRET=header: the per-run secret is printed once and required', async () => {
  seen = [];
  await withProxy({ env: { PROXY_REQUIRE_SECRET: 'header' } }, async (p) => {
    const secret = (p.out.match(/X-Proxy-Secret: ([0-9a-f]{48})/) || [])[1];
    assert.ok(secret, 'secret printed at startup');
    assert.equal((await req(p.port)).status, 403);
    assert.equal((await req(p.port, { headers: { 'x-proxy-secret': 'wrong' } })).status, 403);
    assert.equal((await req(p.port, { headers: { 'x-proxy-secret': secret } })).status, 200);
    assert.equal(seen.length, 1); assert.equal(seen[0].headers['x-proxy-secret'], undefined, 'the secret is not forwarded');
    assert.ok(!p.err.includes(secret));
  });
});

test('PROXY_REQUIRE_SECRET=path: requests need the /<secret>/ prefix, which is stripped', async () => {
  seen = [];
  await withProxy({ env: { PROXY_REQUIRE_SECRET: 'path' } }, async (p) => {
    const secret = (p.out.match(/localhost:\d+\/([0-9a-f]{48})\//) || [])[1];
    assert.ok(secret);
    assert.equal((await req(p.port, { url: '/v1/messages' })).status, 403);
    assert.equal((await req(p.port, { url: `/${secret}/v1/messages` })).status, 200);
    assert.equal(seen.at(-1).url, '/v1/messages');
  });
  await withProxy({ env: { PROXY_REQUIRE_SECRET: 'bogus' } }, async () => {});   // refuses to start: ready resolves on exit
});

test('PROXY_EXTRA_HEADERS extends the allow-list but never to cookies', async () => {
  seen = [];
  await withProxy({ env: { PROXY_EXTRA_HEADERS: 'x-custom-thing, cookie' } }, async (p) => {
    await req(p.port, { headers: { 'x-custom-thing': 'v', cookie: 'sid=1' } });
    assert.equal(seen[0].headers['x-custom-thing'], 'v'); assert.equal(seen[0].headers.cookie, undefined);
  });
});

test('refuses to start when the port is already in use (loopback and wildcard listeners), with a clear message', async () => {
  for (const bindHost of ['127.0.0.1', '0.0.0.0']) {
    const port = nextPort_();
    const blocker = net.createServer((s) => s.end()); await new Promise((r) => blocker.listen(port, bindHost, r));
    const p = startProxy({ port }); await p.ready; const code = await p.exited;
    blocker.close();
    assert.equal(code, 1, `listener on ${bindHost}`); assert.match(p.err, /port \d+ is already in use/);
  }
});

test('the test-only upstream cannot be enabled in normal use', async () => {
  // 1. real-looking target + the variable: still must be *.run.app over https
  let p = startProxy({ target: 'https://evil.example.com' }); await p.ready; assert.equal(await p.exited, 1); assert.match(p.err, /must be an https:\/\/\*\.run\.app/);
  p = startProxy({ target: 'http://x.run.app' }); await p.ready; assert.equal(await p.exited, 1);
  // 2. the reserved test target without the variable (or with a non-loopback / https / portless upstream) is refused
  p = startProxy({ useUpstream: false }); await p.ready; assert.equal(await p.exited, 1);
  for (const up of ['http://evil.example.com:80', 'https://127.0.0.1:19360', 'http://127.0.0.1', 'http://10.0.0.5:19360']) {
    p = startProxy({ env: { CLAUDE_GATEWAY_PROXY_TEST_UPSTREAM: up } }); await p.ready; assert.equal(await p.exited, 1, up);
  }
  // 3. a run.app target ignores the variable: it is shown as the real https origin, never the mock
  await withProxy({ target: 'https://nothing-here-abc123-ew.a.run.app' }, async (px) => {
    assert.match(px.out, /-> https:\/\/nothing-here-abc123-ew\.a\.run\.app/);
  });
});

test('the identity token and gcloud output are never printed, logged or returned, even when gcloud fails', async () => {
  seen = [];
  await withProxy({}, async (p) => {
    await req(p.port, { headers: { authorization: `Bearer ${SESSION}` } });
    assert.ok(!(p.out + p.err).includes(TOKEN) && !(p.out + p.err).includes(SESSION));
  });
  seen = [];
  await withProxy({ env: { FAKE_GCLOUD_FAIL: '1' } }, async (p) => {
    const r = await req(p.port);
    assert.equal(r.status, 502); assert.match(r.body, /gcloud auth print-identity-token failed/);
    assert.ok(!r.body.includes(TOKEN) && !(p.out + p.err).includes(TOKEN));
    assert.equal(seen.length, 0);
  });
});

test('upstream failure gives 502 without leaking details', async () => {
  const dead = nextPort_();   // nothing listens here
  await withProxy({ env: { CLAUDE_GATEWAY_PROXY_TEST_UPSTREAM: `http://127.0.0.1:${dead}` } }, async (p) => {
    const r = await req(p.port); assert.equal(r.status, 502); assert.ok(!r.body.includes(TOKEN));
  });
});

test('binds to loopback only', async () => {
  await withProxy({}, async (p) => {
    const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4');
    for (const i of ifaces.slice(0, 1)) {
      const ok = await new Promise((r) => { const s = net.connect({ host: i.address, port: p.port }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); setTimeout(() => { s.destroy(); r(false); }, 800); });
      assert.equal(ok, false, `reachable on ${i.address}`);
    }
  });
});
