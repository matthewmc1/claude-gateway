// The app's call to the gateway in internal-load-balancer mode: GATEWAY_AUDIENCE empty (no Authorization at all) and GATEWAY_CA_PEM (trust a
// private CA for that call only). Real local TLS servers with throwaway certificates made by `openssl` (skipped if it is not installed).
// Ports 19200-19219.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHttpGateway } from '../lib/gateway.mjs';
import { loadConfig } from '../lib/config.mjs';
import { testEnv } from './api-helpers.mjs';

let haveOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { haveOpenssl = false; }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iapgw-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
function makeCert(name, san) {
  const key = path.join(dir, name + '.key'), crt = path.join(dir, name + '.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=${name}`, '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(crt, 'utf8') };
}
const seen = [];
const handler = (req, res) => {
  seen.push({ method: req.method, url: req.url, headers: req.headers });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/protocol') return res.end('{}');
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST') { seen.at(-1).body = body; return res.end(JSON.stringify({ type: 'spend_limit', id: 'spl_000001' })); }
    res.end(JSON.stringify({ data: [{ id: 'spl_1' }], has_more: false }));
  });
};
const listen = (server, port) => new Promise((ok) => server.listen(port, '127.0.0.1', ok));
const cfgFor = (url, extra = {}) => loadConfig(testEnv({ GATEWAY_URL: url, GATEWAY_ADMIN_READ_KEY: 'rk-fake-read', ...extra }));

test('empty GATEWAY_AUDIENCE sends no Authorization header (only the admin key), for calls and for ping', async () => {
  const srv = http.createServer(handler); await listen(srv, 19200);
  try {
    seen.length = 0;
    const gw = createHttpGateway(cfgFor('http://127.0.0.1:19200', { GATEWAY_AUDIENCE: '' }));
    assert.equal(await gw.ping(), true);
    assert.equal((await gw.listLimits()).length, 1);
    await gw.upsert({ type: 'organization' }, 'weekly', 100, { key: 'wk-fake-write', actor: 'x' });
    assert.equal(seen.length, 3);
    for (const s of seen) assert.equal(s.headers.authorization, undefined, s.url);
    assert.equal(seen[1].headers['x-api-key'], 'rk-fake-read'); assert.equal(seen[2].headers['x-api-key'], 'wk-fake-write');
    assert.equal(JSON.parse(seen[2].body).amount, '100');
    const spaces = createHttpGateway(cfgFor('http://127.0.0.1:19200', { GATEWAY_AUDIENCE: '   ' }));
    seen.length = 0; assert.equal(await spaces.ping(), true); assert.equal(seen[0].headers.authorization, undefined, 'whitespace counts as empty');
  } finally { srv.close(); }
});

test('GATEWAY_CA_PEM: the private CA is trusted for the gateway call, with no Authorization and the admin key intact', { skip: !haveOpenssl && 'openssl not installed: TLS fixtures cannot be generated' }, async () => {
  const gwCert = makeCert('gateway.test', 'DNS:gateway.test,DNS:localhost,IP:127.0.0.1');
  const srv = https.createServer({ key: gwCert.key, cert: gwCert.cert }, handler); await listen(srv, 19201);
  try {
    seen.length = 0;
    const cfg = cfgFor('https://localhost:19201', { GATEWAY_CA_PEM: gwCert.cert, GATEWAY_AUDIENCE: '' });
    assert.ok(cfg.gatewayCaPem.includes('BEGIN CERTIFICATE'));
    const gw = createHttpGateway(cfg);
    assert.equal(await gw.ping(), true);
    assert.equal((await gw.listLimits()).length, 1);
    const up = await gw.upsert({ type: 'organization' }, 'weekly', 4200, { key: 'wk-fake-write', actor: 'x' });
    assert.equal(up.id, 'spl_000001'); assert.equal(JSON.parse(seen.at(-1).body).amount, '4200');
    assert.equal(seen.every((s) => s.headers.authorization === undefined), true);
    assert.equal(seen[1].headers['x-api-key'], 'rk-fake-read');
    // the same call by IP address also works (the certificate lists 127.0.0.1)
    assert.equal(await createHttpGateway(cfgFor('https://127.0.0.1:19201', { GATEWAY_CA_PEM: gwCert.cert })).ping(), true);

    // without the PEM the self-signed certificate is not trusted
    const plain = createHttpGateway(cfgFor('https://localhost:19201', { GATEWAY_AUDIENCE: '' }));
    assert.equal(await plain.ping(), false);
    await assert.rejects(plain.listLimits());
    // another CA's PEM is no good either
    const other = makeCert('other.test', 'DNS:other.test');
    const wrongCa = createHttpGateway(cfgFor('https://localhost:19201', { GATEWAY_CA_PEM: other.cert }));
    assert.equal(await wrongCa.ping(), false);
    await assert.rejects(wrongCa.listLimits());
  } finally { srv.close(); }
});

test('GATEWAY_CA_PEM does not switch off name checking: a certificate for another name is refused', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const wrongName = makeCert('wrongname.test', 'DNS:wrongname.test');
  const srv = https.createServer({ key: wrongName.key, cert: wrongName.cert }, handler); await listen(srv, 19202);
  try {
    const gw = createHttpGateway(cfgFor('https://localhost:19202', { GATEWAY_CA_PEM: wrongName.cert }));
    assert.equal(await gw.ping(), false);
    await assert.rejects(gw.listLimits(), /altnames|match|hostname|certificate/i);
  } finally { srv.close(); }
});

test('GATEWAY_CA_PEM is ignored for an http gateway URL (no https, nothing to trust)', async () => {
  const srv = http.createServer(handler); await listen(srv, 19203);
  try {
    const { cert } = makeCertOrSkip();
    const gw = createHttpGateway(cfgFor('http://127.0.0.1:19203', { GATEWAY_CA_PEM: cert }));
    assert.equal(await gw.ping(), true);
  } finally { srv.close(); }
});
function makeCertOrSkip() { return haveOpenssl ? makeCert('x.test', 'DNS:x.test') : { cert: '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(200) + '\n-----END CERTIFICATE-----\n' }; }
