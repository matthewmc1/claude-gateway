// Renders the throwaway gateway config used by the end-to-end suite (same shape as terraform/modules/gateway_config/gateway.yaml.tftpl).
// Everything secret is generated at run time; nothing here is ever printed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCatalog } from '../../../api/lib/config.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PORTS = { pg: 19160, gateway: 19161, oidc: 19162, opsGateway: 19163, appL3: 19164, appL5: 19165, fakeVertex: 19166, vertexGateway: 19167 };
export const ADMINS = ['ada@example.com', 'bob@example.com'];   // one write key each, like production; the system key is separate
const rand = (n = 24) => crypto.randomBytes(n).toString('hex');

export const makeSecrets = () => ({
  jwt: rand(32), oidcClientSecret: rand(16),
  keys: { ada: rand(), bob: rand(), system: rand(), read: rand() },
});

// What Terraform renders into the gateway's managed policy, for a catalog (default: config/models.json). Every enabled model is allowed
// (default first); only an entry that PINS its family (family + pin, see docs/ARCHITECTURE.md) sets ANTHROPIC_DEFAULT_<FAMILY>_MODEL.
// The catalog is validated by the same rules the app, Terraform and the installer apply (an invalid one throws here).
export const readCatalog = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'models.json'), 'utf8'));
export function modelPolicy(cat = readCatalog()) {
  const c = normalizeCatalog(cat, 'config/models.json');
  const enabled = c.models.filter((m) => m.enabled);
  const ordered = [...enabled.filter((m) => m.alias === c.default), ...enabled.filter((m) => m.alias !== c.default)];
  const env = {};
  for (const m of enabled) if (m.pinned) env[`ANTHROPIC_DEFAULT_${m.family.toUpperCase()}_MODEL`] = m.id;
  return { availableModels: ordered.map((m) => m.id), model: ordered[0].id, env, catalog: cat };   // model = the explicit starting model (default entry)
}
// The "run 4.6 as the default for everyone" recipe applied to a catalog.
export function recipe46(cat = readCatalog()) {
  const c = JSON.parse(JSON.stringify(cat)); c.default = 'sonnet-4-6';
  for (const m of c.models) { if (m.alias === 'sonnet' || m.alias === 'opus') m.pin = false; if (m.alias === 'sonnet-4-6' || m.alias === 'opus-4-6') m.pin = true; }
  return c;
}

export function renderGatewayYaml({ port, oidcPort, pgPort, pgPassword, db, secrets, loadTest = true }) {
  const j = JSON.stringify, pol = modelPolicy();
  return `listen:
  host: 127.0.0.1
  port: ${port}
  public_url: http://127.0.0.1:${port}
oidc:
  issuer: http://127.0.0.1:${oidcPort}
  client_id: e2e-client
  client_secret: ${j(secrets.oidcClientSecret)}
  allowed_email_domains: [example.com]
  scopes: [openid, profile, email]
session:
  jwt_secret: ${j(secrets.jwt)}
  ttl_hours: 1
store:
  postgres_url: ${j(`postgres://postgres:${pgPassword}@127.0.0.1:${pgPort}/${db}`)}
upstreams:
  - provider: vertex
    region: us-east5
    project_id: e2e-fake-project
    auth: {}
auto_include_builtin_models: true
admin:
  write_keys:
    - { id: "ada@example.com", key: ${j(secrets.keys.ada)} }
    - { id: "bob@example.com", key: ${j(secrets.keys.bob)} }
    - { id: "system:overrides", key: ${j(secrets.keys.system)} }
  read_keys:
    - { id: "budget-app-read", key: ${j(secrets.keys.read)} }
  blocked_message: "Spend cap reached. Ask the platform team."
managed:
  policies:
    - match: {}
      code:
        enforceAvailableModels: true
        availableModels: ${j(pol.availableModels)}
        model: ${j(pol.model)}
        env: ${j(pol.env)}
${loadTest ? `load_test_mode:
  enabled: true
  reply_tokens: 300
  reply_seconds: 0
` : ''}`;
}

// Application Default Credentials for the gateway's Vertex upstream that never leave this machine: a workload-identity-federation
// ("external_account") file whose STS endpoint is our fake issuer. load_test_mode still "acquires credentials" before replying.
export function writeFakeAdc(dir, oidcPort) {
  const subject = path.join(dir, 'fake-subject-token'); fs.writeFileSync(subject, 'fake-subject-token', { mode: 0o600 });
  const f = path.join(dir, 'fake-adc.json');
  fs.writeFileSync(f, JSON.stringify({
    type: 'external_account', audience: '//iam.googleapis.com/projects/0/locations/global/workloadIdentityPools/e2e/providers/e2e',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_url: `http://127.0.0.1:${oidcPort}/sts`, credential_source: { file: subject },
  }), { mode: 0o600 });
  return f;
}
