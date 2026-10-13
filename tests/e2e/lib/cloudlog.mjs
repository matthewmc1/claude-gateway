// Helpers for L2: turn the real gateway's stderr into Cloud Logging entries and serve them from a fake logging API.
import { canonTs } from '../../../api/lib/usage/logs.mjs';

let seq = 0;
// Cloud Run turns a JSON line on stderr into jsonPayload and any other line into textPayload.
// `idPrefix` makes insertIds stable across calls (a growing log file is re-read in full), like Cloud Logging's own.
export function entriesFromLines(lines, { jsonAsText = false, idPrefix = null } = {}) {
  const out = [];
  let idx = 0, lastTs = '2000-01-01T00:00:00.000Z';
  for (const line of lines) {
    const nextId = () => (idPrefix ? `${idPrefix}${idx++}` : `i${++seq}`);
    if (line.startsWith('{')) {
      let j; try { j = JSON.parse(line); } catch { out.push({ insertId: nextId(), timestamp: lastTs, textPayload: line }); continue; }
      lastTs = j.ts || lastTs;
      out.push({ insertId: nextId(), timestamp: j.ts, ...(jsonAsText ? { textPayload: line } : { jsonPayload: j }) });
    } else {
      const m = /^\[gateway\] (\S+) /.exec(line);
      if (m) lastTs = m[1];
      out.push({ insertId: nextId(), timestamp: m ? m[1] : lastTs, textPayload: line });
    }
  }
  return out;
}

export function fakeCloud(entries = []) {
  const f = { entries, calls: 0, fetch: null };
  f.fetch = async (url, init = {}) => {
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/service-accounts/default/token')) return json(200, { access_token: 'tok', expires_in: 3600 });
    if (String(url).endsWith('/project/project-id')) return new Response('e2e-project');
    if (String(url) !== 'https://logging.googleapis.com/v2/entries:list') throw new Error('unexpected network call: ' + url);
    f.calls++;
    const body = JSON.parse(init.body);
    const from = /timestamp>="([^"]+)"/.exec(body.filter)[1];
    const rows = f.entries.filter((e) => canonTs(e.timestamp) && canonTs(e.timestamp) >= from).sort((a, b) => (canonTs(a.timestamp) < canonTs(b.timestamp) ? -1 : canonTs(a.timestamp) > canonTs(b.timestamp) ? 1 : 0));
    const start = body.pageToken ? Number(body.pageToken) : 0, size = body.pageSize || 1000;
    return json(200, { entries: rows.slice(start, start + size), ...(start + size < rows.length ? { nextPageToken: String(start + size) } : {}) });
  };
  return f;
}

export const window24h = (nowMs = Date.now(), data = 'all') => { const b = 3600, n = 24, end = Math.ceil(nowMs / 1000 / b) * b; return { range: '24h', data, n, b, start: end - n * b, end }; };

// A fake Cloud Logging that serves the CURRENT contents of a gateway's stderr file on every call.
export function liveCloud(readLines, idPrefix) {
  const f = fakeCloud([]);
  const inner = f.fetch;
  f.fetch = (url, init) => { f.entries = entriesFromLines(readLines(), { idPrefix }); return inner(url, init); };
  return f;
}
