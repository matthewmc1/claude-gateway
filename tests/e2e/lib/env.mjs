// The hermetic stack is built by scripts/e2e.sh, which exports these variables. Running a test file directly without it fails loudly.
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set: run the suite through scripts/e2e.sh (it builds the hermetic gateway stack and tears it down)`);
  return v;
};
export const E = {
  tmp: need('E2E_TMP'), gwUrl: need('E2E_GW_URL'), gwPort: Number(need('E2E_GW_PORT')), gwLog: need('E2E_GW_LOG'),
  oidcPort: Number(need('E2E_OIDC_PORT')), pgPort: Number(need('E2E_PG_PORT')), pgPassword: need('E2E_PG_PASSWORD'),
  fakeAdc: need('E2E_FAKE_ADC'),
  jwt: need('E2E_JWT_SECRET'), oidcClientSecret: need('E2E_OIDC_CLIENT_SECRET'),
  keys: { ada: need('E2E_KEY_ADA'), bob: need('E2E_KEY_BOB'), system: need('E2E_KEY_SYSTEM'), read: need('E2E_KEY_READ') },
};
