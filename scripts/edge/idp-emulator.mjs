// A local OIDC identity provider (stand-in for Google Workspace / Okta / Dex) for the edge stack: discovery, JWKS, an authorization
// endpoint that shows a pick-a-person page, a token endpoint, and a fake Google STS so the gateway's Vertex upstream can "acquire
// credentials" with no Google account (it is only ever used with the gateway's load_test_mode, which replies without calling a model).
//   node scripts/edge/idp-emulator.mjs --port 19332 --users alice@example.com,bob@example.com [--redirect-origin https://gateway.localhost:19331]
// Tests can skip the page by passing ?e2e_email=..&e2e_sub=..&e2e_name=.. on /auth. Binds loopback only. Not for real sign-in.
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readForm = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => ok(new URLSearchParams(d))); });

export function startIdpEmulator({ port, host = '127.0.0.1', users = [], redirectOrigins = [], quiet = false }) {
  const issuer = `http://127.0.0.1:${port}`;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'edge-1', use: 'sig', alg: 'RS256' };
  const disco = {
    issuer, authorization_endpoint: issuer + '/auth', token_endpoint: issuer + '/token', jwks_uri: issuer + '/keys', userinfo_endpoint: issuer + '/userinfo',
    response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'], claims_supported: ['sub', 'email', 'email_verified', 'name'],
  };
  const idToken = (claims) => {
    const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'edge-1' }), p = b64(claims);
    return `${h}.${p}.${crypto.sign('sha256', Buffer.from(h + '.' + p), privateKey).toString('base64url')}`;
  };
  const emu = { issuer, port, seen: [], server: null };   // seen: the redirect_uri of every authorization request (tests assert its host)

  emu.server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (code, obj, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(obj)); };
    const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }); res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Sign in (local IdP)</title><style>body{font:15px system-ui;max-width:30rem;margin:12vh auto;padding:0 1rem}a{display:block;padding:.6rem .8rem;margin:.3rem 0;border:1px solid #999;border-radius:6px;text-decoration:none;color:inherit}.n{color:#a33;font-size:13px}</style>${body}`); };
    if (url.pathname === '/.well-known/openid-configuration') return json(200, disco);
    if (url.pathname === '/keys') return json(200, { keys: [jwk] });
    if (url.pathname === '/auth') {
      const q = url.searchParams, redirect = q.get('redirect_uri');
      if (!redirect || !q.get('state')) return json(400, { error: 'invalid_request' });
      let ro; try { ro = new URL(redirect).origin; } catch { return json(400, { error: 'invalid_redirect_uri' }); }
      if (redirectOrigins.length && !redirectOrigins.includes(ro)) return json(400, { error: 'invalid_redirect_uri', hint: 'not an allowed origin for this local IdP' });
      emu.seen.push({ redirect_uri: redirect, client_id: q.get('client_id') });
      const email = q.get('e2e_email');
      if (!email) {   // no identity chosen yet: show the picker (each link repeats this request with an identity)
        const link = (e) => { const n = new URLSearchParams(q); n.set('e2e_email', e); n.set('e2e_sub', 'idp-' + crypto.createHash('sha256').update(e).digest('hex').slice(0, 12)); n.set('e2e_name', e.split('@')[0]); return '/auth?' + n; };
        return html(200, `<h1>Sign in</h1><p class=n>Local identity provider for the edge stack (not a real IdP).</p>${users.map((e) => `<a href="${esc(link(e))}">${esc(e)}</a>`).join('') || '<p>No users configured.</p>'}`);
      }
      const code = b64({ sub: q.get('e2e_sub') || 'idp-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 12), email, name: q.get('e2e_name') || email.split('@')[0], nonce: q.get('nonce') || undefined, cid: q.get('client_id'), r: crypto.randomBytes(6).toString('hex') });
      const back = new URL(redirect); back.searchParams.set('code', code); back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { location: back.toString() }); return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const f = await readForm(req);
      let c; try { c = JSON.parse(Buffer.from(f.get('code') || '', 'base64url').toString()); } catch { return json(400, { error: 'invalid_grant' }); }
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, aud: c.cid, sub: c.sub, email: c.email, email_verified: true, name: c.name, iat: now, exp: now + 600, ...(c.nonce ? { nonce: c.nonce } : {}) };
      return json(200, { access_token: 'fake-' + crypto.randomBytes(8).toString('hex'), token_type: 'Bearer', expires_in: 600, id_token: idToken(claims) }, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/sts' && req.method === 'POST') {
      await readForm(req);
      return json(200, { access_token: 'fake-gcp-' + crypto.randomBytes(8).toString('hex'), issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600 });
    }
    json(404, { error: 'not_implemented_in_local_idp' });
  });
  return new Promise((ok, no) => {
    emu.server.once('error', no);
    emu.server.listen(port, host, () => {
      emu.close = () => new Promise((r) => { emu.server.close(r); emu.server.closeAllConnections?.(); });
      if (!quiet) console.log(JSON.stringify({ evt: 'listening', proxy: 'idp', issuer }));
      ok(emu);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values: v } = parseArgs({ options: { port: { type: 'string' }, users: { type: 'string' }, 'redirect-origin': { type: 'string' } } });
  const emu = await startIdpEmulator({ port: Number(v.port || process.env.EDGE_IDP_PORT), users: (v.users || process.env.EDGE_IDP_USERS || '').split(',').filter(Boolean), redirectOrigins: (v['redirect-origin'] || '').split(',').filter(Boolean) });
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => emu.close().then(() => process.exit(0)));
}
