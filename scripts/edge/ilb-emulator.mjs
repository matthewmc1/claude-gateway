// A stand-in for the regional INTERNAL Application Load Balancer in front of the gateway. NOT Google: it terminates TLS with the
// throwaway certificate from scripts/edge/make-certs.sh and forwards to the gateway over plain http, so the topology is the real one:
//
//   Claude Code / browser --https://gateway.localhost:<port>--> ILB emulator --http--> gateway (listen.public_url = that https URL)
//
//   node scripts/edge/ilb-emulator.mjs --port 19331 --upstream http://127.0.0.1:19333 [--cert-dir data/edge] [--allow-cidr 127.0.0.0/8,::1/128]
//
// Imitated: TLS termination, Host header preserved, x-forwarded-proto: https, X-Forwarded-For = <client supplied>,<client ip>,<lb ip> (Google's
// layout), hop-by-hop headers dropped, streaming bodies (SSE). --allow-cidr is a stand-in for the VPC firewall / Cloud Armor: peers outside
// the list get 403 (the gateway's own access_control.allow_cidrs is a separate, second line of defence).
// Not imitated: HTTP/2, health checks, backend timeouts, client-IP preservation (a laptop only ever has loopback clients).
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { forward, clientIp, log } from './proxy.mjs';

export function cidrList(cidrs) {
  const bl = new net.BlockList();
  for (const c of cidrs.map((x) => x.trim()).filter(Boolean)) {
    const [addr, bits] = c.split('/');
    const fam = net.isIPv6(addr) ? 'ipv6' : net.isIPv4(addr) ? 'ipv4' : null;
    if (!fam || (bits !== undefined && !/^\d{1,3}$/.test(bits))) throw new Error(`bad CIDR: ${c}`);
    if (bits === undefined) bl.addAddress(addr, fam); else bl.addSubnet(addr, Number(bits), fam);
  }
  return bl;
}

export function startIlbEmulator({ port, host = '127.0.0.1', upstream, certDir, allowCidrs = [], lbIp = '127.0.0.1', quiet = false }) {
  if (!upstream || !certDir) throw new Error('ilb emulator needs upstream and certDir');
  const key = fs.readFileSync(path.join(certDir, 'gateway.key')), cert = fs.readFileSync(path.join(certDir, 'gateway-chain.pem'));
  const cidrs = allowCidrs.map((c) => c.trim()).filter(Boolean), allow = cidrs.length ? cidrList(cidrs) : null;
  const emu = { server: null, port: null, ca: fs.readFileSync(path.join(certDir, 'ca.pem'), 'utf8') };
  emu.server = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
    const ip = clientIp(req);
    if (allow && !allow.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4')) {
      if (!quiet) log('ilb', { evt: 'ilb.denied', ip });
      res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Forbidden: client address is outside the allowed ranges (emulated firewall)\n');
    }
    const headers = { ...req.headers };
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], ip, lbIp].filter(Boolean).join(',');
    headers['x-forwarded-proto'] = 'https';
    forward(req, res, { upstream, headers, timeoutMs: 300000 });
  });
  emu.server.on('tlsClientError', () => {});   // scanners and untrusted-CA handshakes are normal noise
  return new Promise((ok, no) => {
    emu.server.once('error', no);
    emu.server.listen(port, host, () => {
      emu.port = emu.server.address().port;
      emu.close = () => new Promise((r) => { emu.server.close(r); emu.server.closeAllConnections?.(); });
      ok(emu);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values: v } = parseArgs({ options: { port: { type: 'string' }, host: { type: 'string' }, upstream: { type: 'string' }, 'cert-dir': { type: 'string' }, 'allow-cidr': { type: 'string' } } });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const emu = await startIlbEmulator({
    port: Number(v.port || process.env.EDGE_ILB_PORT), host: v.host, upstream: v.upstream || process.env.EDGE_ILB_UPSTREAM,
    certDir: v['cert-dir'] || process.env.EDGE_CERT_DIR || path.join(root, 'data', 'edge'), allowCidrs: (v['allow-cidr'] || process.env.EDGE_ALLOW_CIDRS || '').split(','),
  });
  console.log(JSON.stringify({ evt: 'listening', proxy: 'ilb', port: emu.port, upstream: v.upstream || process.env.EDGE_ILB_UPSTREAM }));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => emu.close().then(() => process.exit(0)));
}
