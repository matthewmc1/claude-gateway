// Renders the gateway config and the app environment for the local enterprise edge (scripts/edge.sh and tests/e2e/l6-edge.test.mjs).
// The gateway differs from scripts/run-gateway.sh in exactly the ways the deployed internal-load-balancer setup does:
//   listen.public_url is the https load-balancer URL (a *.localhost name), the gateway itself listens on plain http behind it, and
//   listen.trusted_proxies lists the balancer so X-Forwarded-For is honoured. Replies are canned (load_test_mode) so nothing leaves the machine.
//   node scripts/edge/prepare.mjs <outdir>   writes <outdir>/secrets.json (kept between runs), gateway.yaml, fake-adc.json, edge.env (shell-sourceable)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelPolicy, writeFakeAdc } from '../../tests/e2e/lib/config.mjs';

const rand = (n = 24) => crypto.randomBytes(n).toString('hex');
export const DEFAULTS = {
  appPort: 19330, gatewayPort: 19331, idpPort: 19332, gatewayInternalPort: 19333, appInternalPort: 19334,
  admins: ['ada@example.com'], users: ['ada@example.com', 'bob@example.com', 'alice@example.com'],
};
// A real project's audience is /projects/<number>/locations/<region>/services/<name>; the number here is obviously fake.
export const DEFAULT_AUDIENCE = '/projects/1234567890/locations/local/services/claude-budget-app';

export const makeEdgeSecrets = (admins = DEFAULTS.admins) => ({
  jwt: rand(32), oidcClientSecret: rand(16), appSession: rand(24),
  keys: { read: rand(), system: rand(), admins: Object.fromEntries(admins.map((a) => [a, rand()])) },
});

export function renderEdgeGatewayYaml({ listenPort, publicUrl, idpPort, pgUrl, secrets, trustedProxies = ['127.0.0.0/8', '::1/128'], allowCidrs = null, loadTest = true }) {
  const j = JSON.stringify, pol = modelPolicy();
  return `listen:
  host: 127.0.0.1
  port: ${listenPort}
  public_url: ${j(publicUrl)}
  trusted_proxies: ${j(trustedProxies)}
oidc:
  issuer: http://127.0.0.1:${idpPort}
  client_id: edge-client
  client_secret: ${j(secrets.oidcClientSecret)}
  allowed_email_domains: [example.com]
  scopes: [openid, profile, email]
session:
  jwt_secret: ${j(secrets.jwt)}
  ttl_hours: 1
store:
  postgres_url: ${j(pgUrl)}
upstreams:
  - provider: vertex
    region: us-east5
    project_id: edge-fake-project
    auth: {}
auto_include_builtin_models: true
admin:
  write_keys:
${Object.entries(secrets.keys.admins).map(([email, key]) => `    - { id: ${j(email)}, key: ${j(key)} }`).join('\n')}
    - { id: "system:overrides", key: ${j(secrets.keys.system)} }
  read_keys:
    - { id: "budget-app-read", key: ${j(secrets.keys.read)} }
  blocked_message: "Spend cap reached. Ask the platform team."
${allowCidrs ? `access_control:\n  allow_cidrs: ${j(allowCidrs)}\n` : ''}managed:
  policies:
    - match: {}
      code:
        enforceAvailableModels: true
        availableModels: ${j(pol.availableModels)}
        env: ${j(pol.env)}
${loadTest ? `load_test_mode:
  enabled: true
  reply_tokens: 300
  reply_seconds: 0
` : ''}`;
}

// The app's environment in iap mode, exactly the variables the deployment sets (contract: docs/ARCHITECTURE.md "Enterprise edge contract").
export function edgeAppEnv({ appInternalPort, appOrigin, gatewayUrl, caPem, iapKeysUrl, audience, secrets, admins, dataDir, allowedDomains = '' }) {
  return {
    APP_AUTH_MODE: 'iap', IAP_AUDIENCE: audience, IAP_PUBLIC_KEYS_URL: iapKeysUrl, ...(allowedDomains ? { IAP_ALLOWED_DOMAINS: allowedDomains } : {}),
    PORT: String(appInternalPort), APP_HOST: '127.0.0.1', APP_ALLOWED_HOSTS: new URL(appOrigin).hostname,
    GATEWAY_URL: gatewayUrl, GATEWAY_AUDIENCE: '', GATEWAY_CA_PEM: caPem,
    GATEWAY_ADMIN_READ_KEY: secrets.keys.read, GATEWAY_SYSTEM_WRITE_KEY: secrets.keys.system,
    APP_SESSION_SECRET: secrets.appSession, APP_DATA_DIR: dataDir, USAGE_SOURCE: 'none', APP_READ_CACHE_MS: '0', APP_HEALTH_CACHE_MS: '0',
    APP_ADMINS: JSON.stringify(admins.map((email) => ({ email, name: email.split('@')[0], writeKey: secrets.keys.admins[email] }))),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node prepare.mjs <outdir>'); process.exit(2); }
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const env = process.env, d = DEFAULTS;
  const admins = (env.EDGE_ADMINS || d.admins.join(',')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const users = [...new Set([...(env.EDGE_USERS || d.users.join(',')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean), ...admins])];
  const sf = path.join(out, 'secrets.json');
  let secrets = null;
  try { secrets = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { /* first run */ }
  if (!secrets || admins.some((a) => !secrets.keys.admins[a])) {
    const fresh = makeEdgeSecrets(admins);
    secrets = secrets ? { ...secrets, keys: { ...secrets.keys, admins: { ...fresh.keys.admins, ...secrets.keys.admins } } } : fresh;
    fs.writeFileSync(sf, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }
  const ports = { app: Number(env.EDGE_APP_PORT || d.appPort), gw: Number(env.EDGE_GATEWAY_PORT || d.gatewayPort), idp: Number(env.EDGE_IDP_PORT || d.idpPort), gwInt: Number(env.EDGE_GATEWAY_INTERNAL_PORT || d.gatewayInternalPort), appInt: Number(env.EDGE_APP_INTERNAL_PORT || d.appInternalPort) };
  const pgUrl = env.EDGE_POSTGRES_URL;
  if (!pgUrl) { console.error('EDGE_POSTGRES_URL is required'); process.exit(2); }
  fs.writeFileSync(path.join(out, 'gateway.yaml'), renderEdgeGatewayYaml({ listenPort: ports.gwInt, publicUrl: `https://gateway.localhost:${ports.gw}`, idpPort: ports.idp, pgUrl, secrets, allowCidrs: env.EDGE_ALLOW_CIDRS ? env.EDGE_ALLOW_CIDRS.split(',') : null }), { mode: 0o600 });
  const adc = writeFakeAdc(out, ports.idp);
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const shEnv = (o) => Object.entries(o).map(([k, v]) => `export ${k}=${q(v)}`).join('\n') + '\n';
  const origin = `http://app.localhost:${ports.app}`, gwUrl = `https://gateway.localhost:${ports.gw}`, audience = env.EDGE_AUDIENCE || DEFAULT_AUDIENCE;
  fs.writeFileSync(path.join(out, 'edge.env'), shEnv({ EDGE_ADC: adc, EDGE_APP_ORIGIN: origin, EDGE_GATEWAY_URL: gwUrl, EDGE_USERS_RESOLVED: users.join(','), EDGE_ADMINS_RESOLVED: admins.join(','), EDGE_AUDIENCE: audience }), { mode: 0o600 });
  fs.writeFileSync(path.join(out, 'app.env'), shEnv(edgeAppEnv({
    appInternalPort: ports.appInt, appOrigin: origin, gatewayUrl: gwUrl, caPem: fs.readFileSync(path.join(out, 'ca.pem'), 'utf8'), iapKeysUrl: `http://127.0.0.1:${ports.app}/.well-known/iap-keys.json`,
    audience, secrets, admins, dataDir: path.join(out, 'app'),
  })), { mode: 0o600 });
  console.log('prepared ' + out);
}
