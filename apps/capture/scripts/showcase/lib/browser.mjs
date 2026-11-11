import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { T } from './tokens.mjs';

// Headless Chromium for two jobs the generators cannot do in Node: setting
// text in the design system's fonts (labels become PNG textures), and
// rendering a finished GLB from several sides and moments as a contact sheet.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const fontDir = path.join(repoRoot, 'packages/design-tokens/src/fonts');
// three's entry is build/three.cjs; its package.json is not an exported path.
const threeDir = path.resolve(path.dirname(createRequire(import.meta.url).resolve('three')), '..');

async function launch() {
  return chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

/**
 * Sets each label and returns `{ [id]: { png, width, height } }` (CSS px, the
 * PNG is 2x). A spec is `{ id, text, font: 'title' | 'ui', size, color, weight,
 * italic, letterSpacing }`; `text` may hold `\n`.
 */
export async function renderLabels(specs) {
  const [fraunces, figtree] = await Promise.all([
    readFile(path.join(fontDir, 'fraunces-latin-opsz-normal.woff2')),
    readFile(path.join(fontDir, 'figtree-latin-wght-normal.woff2'))
  ]);
  const face = (family, bytes) =>
    `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2");font-weight:100 900;}`;
  const browser = await launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const html = `<style>${face('Fraunces', fraunces)}${face('Figtree', figtree)}
      body{margin:0;background:transparent}
      .label{display:inline-block;white-space:pre;padding:6px 8px;line-height:1.25;text-align:center}
      .row{display:block;margin-bottom:8px}</style>
      ${specs
        .map(
          (s) =>
            `<div class="row"><span class="label" id="${s.id}" style="font-family:${s.font === 'title' ? 'Fraunces' : 'Figtree'};font-size:${s.size ?? 48}px;color:${s.color ?? T.text};font-weight:${s.weight ?? 400};font-style:${s.italic ? 'italic' : 'normal'};letter-spacing:${s.letterSpacing ?? 0}em">${esc(s.text)}</span></div>`
        )
        .join('')}`;
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    const out = {};
    for (const spec of specs) {
      const element = page.locator(`#${spec.id}`);
      const box = await element.boundingBox();
      out[spec.id] = { png: await element.screenshot({ omitBackground: true }), width: box.width, height: box.height };
    }
    return out;
  } finally {
    await browser.close();
  }
}

const PREVIEW_HTML = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:${T.groundTop}}canvas{display:block}
.tag{position:absolute;font:11px/1.2 monospace;color:${T.text};background:#0008;padding:2px 4px}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Lights and tone mapping copied from the feed card (HologramLighting.tsx,
// HologramCardCanvas.tsx) so a sheet predicts what the viewer shows.
window.renderSheet = async ({ tiles, columns, tile }) => {
  const rows = Math.ceil(tiles.length / columns);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(columns * tile, rows * tile);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setScissorTest(true);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('${T.groundTop}');
  scene.add(new THREE.AmbientLight('#f5f7fa', 0.58));
  scene.add(new THREE.HemisphereLight('#ffffff', '#a8adb5', 0.24));
  const key = new THREE.DirectionalLight('#ffffff', 0.78);
  key.position.set(2.1, 3.8, 1.9);
  const fill = new THREE.DirectionalLight('#f3f6fa', 0.28);
  fill.position.set(-1.8, 2.4, -1.6);
  scene.add(key, fill);

  const gltf = await new GLTFLoader().loadAsync('/model.glb');
  scene.add(gltf.scene);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  for (const clip of gltf.animations) mixer.clipAction(clip).play();

  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
  const fit = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(22.5))) * 1.05;
  const dirs = { front: [0, 0.15, 1], back: [0, 0.15, -1], left: [-1, 0.15, 0], right: [1, 0.15, 0], top: [0, 1, 0.001], quarter: [0.8, 0.55, 1] };

  tiles.forEach((spec, i) => {
    mixer.setTime(spec.t ?? 0);
    if (spec.cam) {
      camera.position.set(...spec.cam);
      camera.up.set(0, 1, 0);
      camera.lookAt(...spec.look);
    } else {
      const d = new THREE.Vector3(...dirs[spec.view]).normalize();
      camera.position.copy(sphere.center).addScaledVector(d, fit);
      camera.up.set(0, 1, 0);
      camera.lookAt(sphere.center);
    }
    camera.fov = spec.fov ?? 45;
    camera.updateProjectionMatrix();
    const col = i % columns;
    const row = Math.floor(i / columns);
    const y = (rows - 1 - row) * tile;
    renderer.setViewport(col * tile, y, tile, tile);
    renderer.setScissor(col * tile, y, tile, tile);
    renderer.render(scene, camera);
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.style.left = col * tile + 4 + 'px';
    tag.style.top = row * tile + 4 + 'px';
    tag.textContent = (spec.label ?? spec.view ?? 'cam') + ' t=' + (spec.t ?? 0);
    document.body.appendChild(tag);
  });

  const size = bounds.getSize(new THREE.Vector3());
  let triangles = 0;
  let meshes = 0;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    meshes += 1;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  });
  return {
    size: size.toArray().map((v) => +v.toFixed(3)),
    min: bounds.min.toArray().map((v) => +v.toFixed(3)),
    max: bounds.max.toArray().map((v) => +v.toFixed(3)),
    clips: gltf.animations.map((c) => ({ name: c.name, duration: +c.duration.toFixed(3), tracks: c.tracks.length })),
    meshes,
    triangles,
    audio: Boolean(gltf.userData.gltfExtensions?.KHR_audio)
  };
};
</script>`;

/**
 * Renders `glb` as a contact sheet JPEG: one tile per entry of `tiles`
 * (`{ view, t }` for a named side, or `{ cam, look, t, fov, label }` for an
 * exact camera, meters). Returns the scene's measured bounds, clips and
 * triangle count, so a wrong scale or a missing clip shows up as numbers.
 */
export async function renderSheet(glb, out, { tiles, columns = 3, tile = 300 }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html' }).end(PREVIEW_HTML);
        return;
      }
      const file = url.pathname === '/model.glb' ? glb : path.join(threeDir, url.pathname.replace(/^\/three\//, ''));
      if (url.pathname !== '/model.glb' && !file.startsWith(threeDir)) throw new Error('outside three');
      await stat(file);
      response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await launch();
  try {
    const rows = Math.ceil(tiles.length / columns);
    const page = await browser.newPage({ viewport: { width: columns * tile, height: rows * tile } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => typeof window.renderSheet === 'function');
    const report = await page.evaluate((options) => window.renderSheet(options), { tiles, columns, tile });
    await page.screenshot({ path: out, type: 'jpeg', quality: 82 });
    return { ...report, errors };
  } finally {
    await browser.close();
    server.close();
  }
}
