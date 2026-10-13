// Normalisation for comparing the in-memory twin with the real gateway: ids and timestamps are replaced by stable placeholders.
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
export function normaliser() {
  const ids = new Map();
  const limitId = (v) => { if (!ids.has(v)) ids.set(v, 'LIMIT#' + (ids.size + 1)); return ids.get(v); };
  let auditBase = null;
  const walk = (v, key = '') => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === 'string') {
      if (/^spl_[0-9a-f_]+$/.test(v)) return limitId(v);
      if ((key === 'created_at' || key === 'updated_at') ) { if (!ISO.test(v)) throw new Error(`${key} is not an ISO timestamp: ${v}`); return '<ts>'; }
    }
    return v;
  };
  return {
    limitId,
    any: (v) => walk(v),
    // audit ids are a global counter on the real gateway: report them relative to the first event this scenario produced
    audit(events) {
      return events.map((e) => walk({ ...e, id: String(Number(e.id) - auditBase + 1) }));
    },
    setAuditBase(n) { auditBase = n; },
  };
}
// Rows that exist for these subs only (the real gateway lists every principal it has ever seen).
export const only = (prefix) => (rows) => rows.filter((r) => String(r.scope?.user_id || r.scope?.user_id).startsWith(prefix));
