// Budget app backend: entry point. Everything real lives in lib/ (config, routes, overrides, coach, usage, gateway).
// Holds the gateway admin keys so the browser never sees them, and serves the built web app.
import { loadConfig } from './lib/config.mjs';
import { buildDeps, createApp } from './lib/routes.mjs';

let cfg;
try { cfg = loadConfig(); } catch (e) { console.error(String(e.message || e)); process.exit(1); }

const app = createApp(cfg, await buildDeps(cfg));
app.server.listen(cfg.port, cfg.host, () => {
  console.log(JSON.stringify({ evt: 'listening', host: cfg.host, port: cfg.port, demo: cfg.demo, auth: cfg.authMode, usage: cfg.usageSource, viewAccess: cfg.viewAccess, accounts: app.auth.accounts }));
});
for (const w of cfg.catalog.warnings || []) console.warn(JSON.stringify({ evt: 'catalog.warning', warning: w }));
app.server.on('error', (e) => { console.error('server error:', e.message); process.exit(1); });

let stopping = false;
const stop = (sig) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ evt: 'stopping', signal: sig }));
  const t = setTimeout(() => process.exit(0), 8000); t.unref();
  app.close().then(() => process.exit(0));
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
