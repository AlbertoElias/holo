// Serves the round 3 design device probe (docs/product/design/direction.md, "Round 3 decisions")
// to headsets and phones on the same Wi-Fi. WebXR needs a secure origin, so it serves HTTPS with a
// self-signed certificate made on first run; plain HTTP is for the iPhone's Quick Look link.
// Every posted result is appended to output/design-probe/device-results.jsonl.
//
//   node scripts/design-probe/server.mjs [--take path/to/export.glb]
//
// The take defaults to the first exported take in apps/capture/output/ci-pointing.
/* global console, process */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const outDir = path.join(root, 'output/design-probe');
const log = path.join(outDir, 'device-results.jsonl');
const HTTPS_PORT = Number(process.env.PROBE_HTTPS_PORT || 8443);
const HTTP_PORT = Number(process.env.PROBE_HTTP_PORT || 8480);

function findTake() {
  const i = process.argv.indexOf('--take');
  if (i > 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  const dir = path.join(root, 'apps/capture/output/ci-pointing');
  const glb = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).sort() : [];
  if (!glb.length) throw new Error(`No exported take found in ${dir}; pass --take path/to/export.glb`);
  return path.join(dir, glb[0]);
}
const take = findTake();

const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address || '127.0.0.1';
function certificate() {
  const dir = path.join(outDir, 'cert'), key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem'), ipFile = path.join(dir, 'ip');
  if (!fs.existsSync(cert) || !fs.existsSync(ipFile) || fs.readFileSync(ipFile, 'utf8') !== lanIp) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=holoim-design-probe', '-addext', `subjectAltName=IP:${lanIp},DNS:localhost`], { stdio: 'ignore' });
    fs.writeFileSync(ipFile, lanIp);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/blend.usdz': ['blend.usdz', 'model/vnd.usdz+zip'] };
function handle(req, res) {
  const url = new URL(req.url, 'http://probe');
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${req.socket.remoteAddress} ${(req.headers['user-agent'] || '').slice(0, 90)}`);
  if (req.method === 'POST' && url.pathname === '/result') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const rec = { at: new Date().toISOString(), ua: req.headers['user-agent'], take: path.basename(take), ...JSON.parse(body) };
        fs.mkdirSync(outDir, { recursive: true });
        fs.appendFileSync(log, JSON.stringify(rec) + '\n');
        console.log(`result: ${rec.test} from ${rec.device}`);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); res.end(String(e)); }
    });
    return;
  }
  if (url.pathname === '/results') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(fs.existsSync(log) ? fs.readFileSync(log) : ''); return; }
  if (url.pathname === '/take.glb') { res.writeHead(200, { 'content-type': 'model/gltf-binary', 'cache-control': 'no-store' }); fs.createReadStream(take).pipe(res); return; }
  const f = files[url.pathname];
  if (!f) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store', ...(f[0].endsWith('.usdz') ? { 'content-disposition': 'inline' } : {}) });
  fs.createReadStream(path.join(here, f[0])).pipe(res);
}

https.createServer(certificate(), handle).listen(HTTPS_PORT, '0.0.0.0', () => console.log(`Design probe: https://${lanIp}:${HTTPS_PORT}/ (take: ${path.relative(root, take)})`));
http.createServer(handle).listen(HTTP_PORT, '0.0.0.0', () => console.log(`Quick Look link served on http://${lanIp}:${HTTP_PORT}/blend.usdz`));
