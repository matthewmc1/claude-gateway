// A fake Vertex AI publisher endpoint (the only upstream the gateway talks to when load_test_mode is off). Scripted per model:
//   claude-opus-5-5  -> 429 RESOURCE_EXHAUSTED   claude-haiku-5-5 -> 403 PERMISSION_DENIED   anything else -> a normal Messages reply
// The gateway reaches it through ANTHROPIC_VERTEX_BASE_URL (read by the Vertex SDK it embeds). Loopback only.
import http from 'node:http';

export function startFakeVertex(port) {
  const seen = [], state = { usage: { input_tokens: 10, output_tokens: 5 } };   // state.usage is what replies report (spend is computed from it)
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = /models\/([^:/]+):(rawPredict|streamRawPredict)/.exec(req.url);
      const model = m ? m[1] : '(none)'; seen.push({ url: req.url, model });
      const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (/opus/.test(model)) return out(429, { error: { code: 429, message: 'Quota exceeded for aiplatform.googleapis.com/online_prediction_requests_per_base_model (fake)', status: 'RESOURCE_EXHAUSTED' } });
      if (/haiku/.test(model)) return out(403, { error: { code: 403, message: 'Permission denied on resource project e2e-fake-project (fake)', status: 'PERMISSION_DENIED' } });
      let parsed = {}; try { parsed = JSON.parse(body); } catch { /* ignore */ }
      if (parsed.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(); }
      out(200, { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', stop_sequence: null, usage: state.usage });
    });
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ seen, state, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) })));
}
