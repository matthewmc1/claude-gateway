// scripts/edge/iap-emulator.mjs (the laptop stand-in for IAP) must survive hostile cookies: it is the thing the L6 edge suite stands on.
// Ephemeral ports only; the upstream is a stub that echoes what the emulator forwarded.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { COOKIE, startIapEmulator } from '../../scripts/edge/iap-emulator.mjs';

const closers = [];
afterEach(async () => { while (closers.length) await closers.pop()(); });
const raw = (port, headers) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', headers, timeout: 3000 }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); });
  req.on('timeout', () => req.destroy(new Error('request hung'))); req.on('error', reject); req.end();
});
async function boot() {
  const seen = [];
  const up = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((ok) => up.listen(0, '127.0.0.1', ok)); closers.push(() => new Promise((ok) => { up.close(ok); up.closeAllConnections?.(); }));
  const emu = await startIapEmulator({ port: 0, upstream: `http://127.0.0.1:${up.address().port}`, audience: '/projects/1/locations/r/services/s', users: ['ada@example.com'], quiet: true });
  closers.push(() => emu.close());
  return { emu, seen };
}

test('crafted cookies (non-ASCII byte, wrong lengths, junk) get the sign-in redirect and never crash the emulator', async () => {
  const unhandled = []; const on = (e) => unhandled.push(e); process.on('unhandledRejection', on); closers.push(() => process.off('unhandledRejection', on));
  const { emu } = await boot();
  const sig43 = 'A'.repeat(42) + 'é';           // 43 characters, 44 bytes in UTF-8: the old length check passed and timingSafeEqual threw
  for (const cookie of [`${COOKIE}=YWRhQGV4YW1wbGUuY29t.${sig43}`, `${COOKIE}=x.${'é'.repeat(43)}`, `${COOKIE}=.`, `${COOKIE}=a.`, `${COOKIE}=.b`, `${COOKIE}=a.b.c`, `${COOKIE}=%ff.%ff`, `${COOKIE}=${'z'.repeat(5000)}.${'y'.repeat(43)}`]) {
    const r = await raw(emu.port, { cookie, accept: 'text/html' });
    assert.equal(r.status, 302, JSON.stringify(cookie).slice(0, 40)); assert.match(r.headers.location, /^\/_iap\/signin/);
  }
  assert.deepEqual(unhandled, []);
  assert.equal((await raw(emu.port, { accept: 'application/json' })).status, 401, 'still alive and answering');
});

test('a real sign-in cookie is still accepted: the request is forwarded with a signed JWT and without the cookie', async () => {
  const { emu, seen } = await boot();
  const signin = await new Promise((resolve, reject) => {
    const body = 'email=ada%40example.com&next=%2F';
    const req = http.request({ host: '127.0.0.1', port: emu.port, path: '/_iap/signin', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': body.length } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
    req.on('error', reject); req.end(body);
  });
  assert.equal(signin.statusCode, 302);
  const cookie = signin.headers['set-cookie'][0].split(';')[0];
  const r = await raw(emu.port, { cookie, accept: 'application/json' });
  assert.equal(r.status, 200);
  assert.match(seen.at(-1)['x-goog-iap-jwt-assertion'], /^[\w-]+\.[\w-]+\.[\w-]+$/); assert.equal(seen.at(-1).cookie, undefined);
});
