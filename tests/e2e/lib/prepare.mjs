// Called by scripts/e2e.sh: writes <tmp>/gateway-main.yaml and <tmp>/stack.env (shell-sourceable; mode 600).
import fs from 'node:fs';
import path from 'node:path';
import { PORTS, makeSecrets, renderGatewayYaml, writeFakeAdc } from './config.mjs';

const tmp = process.argv[2];
const pgPassword = process.env.E2E_PG_PASSWORD;
if (!tmp || !pgPassword) { console.error('usage: E2E_PG_PASSWORD=.. node prepare.mjs <tmpdir>'); process.exit(2); }
const secrets = makeSecrets();
fs.writeFileSync(path.join(tmp, 'gateway-main.yaml'), renderGatewayYaml({ port: PORTS.gateway, oidcPort: PORTS.oidc, pgPort: PORTS.pg, pgPassword, db: 'gateway_main', secrets }), { mode: 0o600 });
const env = {
  E2E_FAKE_ADC: writeFakeAdc(tmp, PORTS.oidc),
  E2E_TMP: tmp, E2E_PG_PORT: PORTS.pg, E2E_GW_PORT: PORTS.gateway, E2E_GW_URL: `http://127.0.0.1:${PORTS.gateway}`, E2E_OIDC_PORT: PORTS.oidc,
  E2E_GW_LOG: path.join(tmp, 'gateway-main.err'), E2E_JWT_SECRET: secrets.jwt, E2E_OIDC_CLIENT_SECRET: secrets.oidcClientSecret,
  E2E_KEY_ADA: secrets.keys.ada, E2E_KEY_BOB: secrets.keys.bob, E2E_KEY_SYSTEM: secrets.keys.system, E2E_KEY_READ: secrets.keys.read,
};
fs.writeFileSync(path.join(tmp, 'stack.env'), Object.entries(env).map(([k, v]) => `export ${k}='${v}'`).join('\n') + '\n', { mode: 0o600 });
