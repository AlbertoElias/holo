// Serves a production build of apps/viewer-web over plain HTTP on localhost
// with a mocked API, so iOS Safari in the Simulator can open it without a
// certificate (http://localhost is a secure context). Usage:
//   node scripts/ui-inventory/ios-sim-server.mjs [port]
// Then open http://localhost:<port>/ in the Simulator. Feed states are picked
// with ?feed=quicklook-ready|quicklook-preparing|quicklook-failed|empty|plain.
/* global URL, console, process */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { workspaceRoot } from './lib.mjs';

const port = Number(process.argv[2] ?? process.env.IOS_SIM_PORT ?? 3180);
const distDir = path.join(workspaceRoot, 'output/ui-inventory/viewer-dist');
const recordedGlb = path.join(workspaceRoot, 'output/ui-inventory/capture-recording.glb');
const glbPath = existsSync(recordedGlb) ? recordedGlb : path.join(workspaceRoot, 'apps/capture/public/gltf/models/avatar.glb');
const usdzPath = process.env.INVENTORY_USDZ ?? (() => {
  const dir = path.join(workspaceRoot, 'output/quicklook');
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter((name) => existsSync(path.join(dir, name, 'capture-quicklook.usdz'))).sort();
  return runs.length ? path.join(dir, runs.at(-1), 'capture-quicklook.usdz') : null;
})();

if (!existsSync(path.join(distDir, 'index.html')) || process.env.REBUILD === '1') {
  const result = spawnSync('pnpm', ['exec', 'vite', 'build', '--outDir', distDir, '--emptyOutDir'], {
    cwd: path.join(workspaceRoot, 'apps/viewer-web'),
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function hologram(id, overrides = {}) {
  return {
    id, url: `/uploads/${id}.glb`, usdzUrl: null, usdzStatus: 'none', quickLookEnabled: false,
    createdAt: '2026-10-20T17:42:00.000Z', sizeBytes: statSync(glbPath).size, filenameOriginal: `${id}.glb`,
    hologramName: 'Morning walk in the courtyard', submittedBy: 'alberto', ...overrides
  };
}

let feedMode = 'quicklook-ready';
function feedItems() {
  const second = hologram('wave', { hologramName: 'Waving hello', submittedBy: 'sam' });
  switch (feedMode) {
    case 'empty': return [];
    case 'plain': return [hologram('walk'), second];
    case 'quicklook-preparing': return [hologram('walk', { quickLookEnabled: true, usdzStatus: 'processing' }), second];
    case 'quicklook-failed': return [hologram('walk', { quickLookEnabled: true, usdzStatus: 'failed' }), second];
    default: return [hologram('walk', { quickLookEnabled: true, usdzStatus: usdzPath ? 'ready' : 'failed', usdzUrl: usdzPath ? '/uploads/walk.usdz' : null }), second];
  }
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };

function sendFile(req, res, file, contentType, extraHeaders = {}) {
  const size = statSync(file).size;
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const headers = { 'content-type': contentType, 'accept-ranges': 'bytes', ...extraHeaders };
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  return createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.searchParams.has('feed')) feedMode = url.searchParams.get('feed');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/holograms') return json(200, { items: feedItems(), nextCursor: null });
  const single = /^\/api\/holograms\/([^/]+)$/.exec(url.pathname);
  if (single) {
    const item = feedItems().find((entry) => entry.id === single[1]) ?? (single[1] === 'walk' ? hologram('walk') : null);
    return item ? json(200, item) : json(404, { error: 'Hologram not found.' });
  }
  if (url.pathname.endsWith('.usdz') && usdzPath) {
    return sendFile(req, res, usdzPath, 'model/vnd.usdz+zip', { 'content-disposition': 'inline' });
  }
  if (url.pathname.startsWith('/uploads/')) return sendFile(req, res, glbPath, 'model/gltf-binary');
  const file = path.join(distDir, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (file.startsWith(distDir) && existsSync(file) && statSync(file).isFile()) {
    return sendFile(req, res, file, types[path.extname(file)] ?? 'application/octet-stream');
  }
  return sendFile(req, res, path.join(distDir, 'index.html'), 'text/html');
}).listen(port, '127.0.0.1', () => {
  console.log(`iOS Simulator viewer: http://localhost:${port}/ (GLB ${path.relative(workspaceRoot, glbPath)}, USDZ ${usdzPath ? path.relative(workspaceRoot, usdzPath) : 'none'})`);
});
