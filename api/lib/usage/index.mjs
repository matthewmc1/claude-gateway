// Usage backend factory. See docs/ARCHITECTURE.md.
//   createUsage(cfg, { store, ...backendOptions }) -> usage       (cfg.usageSource: 'none' | 'demo' | 'logs' | 'clickhouse'; missing means 'none')
// An unknown source throws. `store` defaults to a throwaway in-memory store. Extra options (fetchImpl, now, env, ...) go to the backend (tests).
import { createAggregator } from './aggregate.mjs';
import { createMemoryStore } from '../store.mjs';
import * as logs from './logs.mjs';
import * as clickhouse from './clickhouse.mjs';
import * as demo from './demo.mjs';

const emptyShapes = (source) => ({
  source, async ok() { return null; }, async roster() { return new Map(); },
  async users(w) { return { rows: [], spark: new Map() }; },
  async detail(sub, w) { return { series: { models: [], values: {} }, models: [], recent: [] }; },
  async company(w) { return { totals: { requests: 0, ok: 0, upstream_errors: 0, blocked: 0, rejected: 0, users: 0 }, byUser: [], byModel: [], series: {} }; },
  async ingest() { return { ingested: 0 }; },
});

export async function createUsage(cfg, { store = createMemoryStore(), ...options } = {}) {
  const source = cfg.usageSource || 'none';
  // model ids the catalog knows are always tracked by name; other names are capped per day doc and then bucketed as 'other' (aggregate.mjs)
  const knownModels = new Set((cfg.catalog?.models || []).flatMap((m) => [m.id, m.alias]).filter(Boolean));
  const aggregator = () => createAggregator(store, { now: options.now, knownModels });
  switch (source) {
    case 'none': return emptyShapes('none');
    case 'clickhouse': return clickhouse.create(cfg, options);
    case 'logs': return logs.create(cfg, { store, aggregator: aggregator(), ...options });
    case 'demo': return demo.create(cfg, { store, aggregator: aggregator(), ...options });
    default: throw new Error(`unknown USAGE_SOURCE ${source}`);
  }
}
