// Minimal fake OIDC issuer: discovery, JWKS and just enough of the authorization-code flow for the gateway's device login.
//   GET /auth?...&e2e_sub=..&e2e_email=..&e2e_name=..   -> 302 to redirect_uri with a stateless code that encodes that identity
//   POST /token (authorization_code)                    -> { id_token (RS256), access_token }
// Usage: node oidc.mjs <port>   (listens on 127.0.0.1 only)
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2]);
const issuer = `http://127.0.0.1:${port}`;
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e-1', use: 'sig', alg: 'RS256' };
const disco = {
  issuer, authorization_endpoint: issuer + '/auth', token_endpoint: issuer + '/token', jwks_uri: issuer + '/keys', userinfo_endpoint: issuer + '/userinfo',
  response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
  scopes_supported: ['openid', 'profile', 'email'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  code_challenge_methods_supported: ['S256'], claims_supported: ['sub', 'email', 'email_verified', 'name'],
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims) {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'e2e-1' }), p = b64(claims);
  return `${h}.${p}.${crypto.sign('sha256', Buffer.from(h + '.' + p), privateKey).toString('base64url')}`;
}
const readForm = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => ok(new URLSearchParams(d))); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  const send = (code, obj, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/.well-known/openid-configuration') return send(200, disco);
  if (url.pathname === '/keys') return send(200, { keys: [jwk] });
  if (url.pathname === '/auth') {
    const q = url.searchParams, redirect = q.get('redirect_uri');
    if (!redirect || !q.get('state')) return send(400, { error: 'invalid_request' });
    const code = b64({ sub: q.get('e2e_sub') || 'e2e-user', email: q.get('e2e_email') || 'e2e@example.com', name: q.get('e2e_name') || 'E2E User', nonce: q.get('nonce') || undefined, cid: q.get('client_id'), r: crypto.randomBytes(6).toString('hex') });
    const back = new URL(redirect); back.searchParams.set('code', code); back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { location: back.toString() }); return res.end();
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    const f = await readForm(req);
    let c; try { c = JSON.parse(Buffer.from(f.get('code') || '', 'base64url').toString()); } catch { return send(400, { error: 'invalid_grant' }); }
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: c.cid, sub: c.sub, email: c.email, email_verified: true, name: c.name, iat: now, exp: now + 600, ...(c.nonce ? { nonce: c.nonce } : {}) };
    return send(200, { access_token: 'fake-' + crypto.randomBytes(8).toString('hex'), token_type: 'Bearer', expires_in: 600, id_token: idToken(claims) }, { 'cache-control': 'no-store' });
  }
  if (url.pathname === '/sts' && req.method === 'POST') {   // fake Google STS: lets the gateway's Vertex upstream "acquire credentials" with no Google account and no internet
    await readForm(req);
    return send(200, { access_token: 'fake-gcp-' + crypto.randomBytes(8).toString('hex'), issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 3600 });
  }
  send(404, { error: 'not_implemented_in_e2e_fake' });
}).listen(port, '127.0.0.1', () => console.log('oidc fake listening ' + issuer));
