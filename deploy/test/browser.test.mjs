// Real-browser proof for deploy/proxy.mjs with headless Chrome (skipped when no Chrome is installed; set CHROME=/path to choose one).
// Ports 19370-19373 on loopback only. A "web page you happen to have open" lives on http://127.0.0.1:19372 (a different site from
// http://localhost:19370, the proxy), the mock Cloud Run service on 19371, the proxy on 19370.
//   node --test deploy/test/browser.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROXY = process.env.PROXY_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'proxy.mjs');   // PROXY_FILE: to run the same proof against another copy
const PX = 19370, UP = 19371, WEB = 19372;
const CHROME = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .filter(Boolean).find((p) => fs.existsSync(p));
const skip = CHROME ? false : 'no Chrome/Chromium found (set CHROME=/path/to/chrome)';

let tmp, upstream, web, proxy, seen = [], webHits = [], proxyErr = '';

before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxbrowser-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'gcloud'), '#!/bin/sh\necho FAKE-ID-TOKEN-browser\n', { mode: 0o755 });
  upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, site: req.headers['sec-fetch-site'], mode: req.headers['sec-fetch-mode'], dest: req.headers['sec-fetch-dest'], cookie: req.headers.cookie });
    if (req.url === '/app.html') { res.setHeader('content-type', 'text/html'); return res.end('<title>app</title><body>APP<script>fetch("/api/ping").then(r=>r.text()).then(t=>{document.body.append(" ping:"+t)})</script>'); }
    res.setHeader('content-type', 'text/html'); res.end('<title>gateway</title><body>GATEWAY ' + req.url);
  }).listen(UP, '127.0.0.1');
  const P = `http://localhost:${PX}`;
  const pages = {
    '/nav.html': `<title>nav</title><script>location.href = ${JSON.stringify(P + '/oauth/callback?code=abc&state=xyz')}</script>`,
    '/attack.html': `<title>attack</title><body>
      <img src="${P}/attack-img">
      <script src="${P}/attack-script.js"></script>
      <iframe src="${P}/attack-iframe"></iframe>
      <script>
        fetch("${P}/attack-fetch", { mode: 'no-cors', credentials: 'include' }).catch(()=>{});
        fetch("${P}/attack-fetch-cors").catch(()=>{});
        fetch("${P}/attack-fetch-post", { method: 'POST', mode: 'no-cors', body: 'x=1' }).catch(()=>{});
        new Image().src = "${P}/attack-new-image";
        navigator.sendBeacon && navigator.sendBeacon("${P}/attack-beacon", "x");
        var x = new XMLHttpRequest(); x.open('GET', "${P}/attack-xhr"); x.send();
      </script>`,
    '/form.html': `<title>form</title><form id=f method=POST action="${P}/attack-form"><input name=a value=1></form><script>document.getElementById('f').submit()</script>`,
  };
  web = http.createServer((req, res) => { webHits.push(req.url); const b = pages[req.url]; res.setHeader('content-type', 'text/html'); res.statusCode = b ? 200 : 404; res.end(b || 'nope'); }).listen(WEB, '127.0.0.1');
  proxy = spawn(process.execPath, [PROXY, 'https://proxy-test.invalid', String(PX)], { env: { ...process.env, PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, CLAUDE_GATEWAY_PROXY_TEST_UPSTREAM: `http://127.0.0.1:${UP}` } });
  proxy.stderr.on('data', (d) => { proxyErr += d; });
  await new Promise((ok, no) => { const t = setTimeout(() => no(new Error('proxy did not start')), 5000); proxy.stdout.on('data', (d) => { if (String(d).includes('proxy http://')) { clearTimeout(t); ok(); } }); });
});
after(() => { if (skip) return; proxy.kill('SIGKILL'); upstream.close(); web.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function chrome(url) {   // resolves with the DOM Chrome ended up with (async: the mock servers live in this process and must keep answering)
  const ud = fs.mkdtempSync(path.join(tmp, 'ud-'));
  return new Promise((ok) => {
    const c = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      `--user-data-dir=${ud}`, '--virtual-time-budget=6000', '--dump-dom', url], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    const kill = setTimeout(() => c.kill('SIGKILL'), 45000);
    c.on('close', () => { clearTimeout(kill); fs.rmSync(ud, { recursive: true, force: true }); ok(out); });
  });
}
const seenNoFavicon = () => seen.filter((s) => s.url !== '/favicon.ico');   // Chrome asks for the icon of whatever page it ends on
const reset = () => { seen = []; webHits = []; proxyErr = ''; };

test('browser: the OIDC redirect (cross-site top-level navigation) reaches the service', { skip }, async () => {
  reset();
  const dom = await chrome(`http://127.0.0.1:${WEB}/nav.html`);
  const hit = seen.find((s) => s.url.startsWith('/oauth/callback'));
  assert.ok(hit, 'the callback reached the mock upstream: ' + JSON.stringify(seen));
  assert.equal(hit.url, '/oauth/callback?code=abc&state=xyz');
  assert.match(proxyErr, /allowed: cross-site top-level navigation/, 'the proxy classified it as a cross-site navigation (127.0.0.1 page -> localhost proxy) and let it through');
  assert.ok(!/refused:/.test(proxyErr), 'nothing was refused');
  assert.match(dom, /GATEWAY \/oauth\/callback/, 'the browser rendered the answer');
});

test('browser: a page you have open cannot reach the service with fetch, XHR, images, scripts, beacons or iframes', { skip }, async () => {
  reset();
  await chrome(`http://127.0.0.1:${WEB}/attack.html`);
  assert.ok(webHits.includes('/attack.html'), 'the attack page was actually loaded');
  assert.deepEqual(seen.filter((s) => s.url.startsWith('/attack')), [], 'nothing from the attack page reached the upstream: ' + JSON.stringify(seen));
  const refusals = (proxyErr.match(/refused: /g) || []).length;
  assert.ok(refusals >= 4, `the proxy itself saw and refused the requests (not Chrome blocking them first): ${refusals} refusals`);
});

test('browser: a cross-site form POST (navigation) is refused', { skip }, async () => {
  reset();
  await chrome(`http://127.0.0.1:${WEB}/form.html`);
  assert.ok(webHits.includes('/form.html'));
  assert.deepEqual(seenNoFavicon(), [], 'the form POST did not reach the upstream');
  assert.match(proxyErr, /refused: .*\(POST\)/, 'the proxy saw the POST and refused it');
});

test('browser: the app itself works through the proxy (typed URL, then same-origin fetch)', { skip }, async () => {
  reset();
  const dom = await chrome(`http://localhost:${PX}/app.html`);
  assert.deepEqual(seen.map((s) => s.url).filter((u) => u !== '/favicon.ico'), ['/app.html', '/api/ping']);
  assert.ok(!/refused:|allowed: cross-site/.test(proxyErr), 'typed URL and same-origin fetch need no exception');
  assert.match(dom, /ping:.*GATEWAY \/api\/ping/);
});
