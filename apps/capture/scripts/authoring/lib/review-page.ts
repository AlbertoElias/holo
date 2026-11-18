/**
 * Helpers the review installs in the viewer page, as plain JavaScript: they
 * run inside viewer-web against its card probe (the scene, camera, renderer
 * and mixer the card draws with), so every frame is the real viewer's.
 *
 * `window.__review`:
 * - `init(url)`: finds the card's probe and the performers (wrappers named
 *   `RecordedAvatar` or `Performer_*`), their key bones and face vertices
 *   (the vertices any face shape moves by more than 0.5 mm), and the
 *   recorded objects `HOLOIM_objects` declares (name, source, holds).
 * - `seek(t)`: pauses the take at `t` and waits two frames so the card's
 *   camera and dome follow, as they would in playback.
 * - `card()`: per performer, key points and the face's box projected with
 *   the card's own camera, in CSS pixels of the card canvas; per recorded
 *   object, its box the same way.
 * - `close(i, view)`: renders performer `i` with the viewer's renderer and
 *   scene from a camera placed by `view`, returns a JPEG data URL (and,
 *   with `view.faceBox`, the face's box: brow line to chin when `init` had
 *   regions, else every vertex a face shape moves).
 * - `bodies()`: world head and hips per performer and each recorded
 *   object's world box, for planning `view`.
 * - `regions(i)`: when `init` was given the audition's face regions
 *   (`lib/face-geometry.ts`), performer `i`'s brow line top, chin bottom
 *   and each eye's opening projected with the card's camera, CSS px, and
 *   the face's world centre (brow to chin) for framing a close view.
 *   `close(i, { …view, regions: true })` returns the same in output pixels
 *   with the OKLab lightness of the render at each brow vertex.
 */
import { tokens } from '@holoim/design-tokens';

const { color } = tokens;

export const REVIEW_PAGE = String.raw`
(() => {
  const NAMES = {
    head: /(^|[^a-z])head$/i, hips: /hips$/i, neck: /neck$/i,
    leftHand: /left_?hand$/i, rightHand: /right_?hand$/i,
    leftFoot: /left_?foot$/i, rightFoot: /right_?foot$/i
  };
  const state = { probe: null, performers: [], objects: [], regions: null };
  const V = () => new (state.probe.camera.position.constructor)();
  const vertex = (mesh, i, out) => {
    mesh.getVertexPosition ? mesh.getVertexPosition(i, out) : out.fromBufferAttribute(mesh.geometry.attributes.position, i);
    if (mesh.isSkinnedMesh && mesh.applyBoneTransform) mesh.applyBoneTransform(i, out);
    else if (mesh.isSkinnedMesh && mesh.boneTransform) mesh.boneTransform(i, out);
    return out.applyMatrix4(mesh.matrixWorld);
  };
  // Every vertex of a recorded object, thinned to about 1500 per object: enough for its box.
  const objectPoints = (node, each) => {
    const v = V();
    node.traverse((m) => {
      if (!m.isMesh || !m.geometry || !m.geometry.attributes.position) return;
      const n = m.geometry.attributes.position.count;
      const step = Math.max(1, Math.floor(n / 1500));
      for (let i = 0; i < n; i += step) each(vertex(m, i, v));
    });
  };
  // The audition's regions name meshes as three loaded the avatar file, and three makes repeated names unique
  // (one per primitive of a mesh with several materials), so the suffix goes on both sides; the count tells them apart.
  const meshOf = (p, set) => {
    let found = null;
    const name = set.mesh.replace(/_\d+$/, '');
    p.wrapper.traverse((o) => {
      if (!found && o.isMesh && o.name.replace(/_\d+$/, '') === name && o.geometry.attributes.position.count === set.count) found = o;
    });
    if (!found) throw new Error('no mesh ' + set.mesh + ' with ' + set.count + ' vertices in ' + p.name);
    return found;
  };
  const surface = (p, s, out) => {
    const m = meshOf(p, s), a = V(), b = V(), c = V();
    vertex(m, s.tri[0], a); vertex(m, s.tri[1], b); vertex(m, s.tri[2], c);
    return out.copy(a).multiplyScalar(1 - s.uv[0] - s.uv[1]).addScaledVector(b, s.uv[0]).addScaledVector(c, s.uv[1]);
  };
  // Region points, each projected by project(world) → [x, y].
  const regionPoints = (i, project) => {
    const p = state.performers[i], r = state.regions;
    if (!r) throw new Error('init was given no regions');
    const v = V();
    const each = (sets) => sets.flatMap((s) => { const m = meshOf(p, s); return s.idx.map((k) => project(vertex(m, k, v))); });
    const browLine = each(r.browLine), chin = each(r.chin);
    const eyes = {};
    for (const [side, e] of Object.entries(r.eyes || {})) eyes[side] = { top: project(surface(p, e.top, v)), bottom: project(surface(p, e.bottom, v)) };
    return {
      browTop: browLine.length ? Math.min(...browLine.map((q) => q[1])) : null,
      chinBottom: chin.length ? Math.max(...chin.map((q) => q[1])) : null,
      eyes,
      brow: each(r.brow)
    };
  };
  // sRGB bytes to OKLab lightness, 0..1.
  const lightness = (r8, g8, b8) => {
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const r = lin(r8), g = lin(g8), b = lin(b8);
    const l = Math.cbrt(0.4122214708 * r + 0.5363335811 * g + 0.0514459719 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return 0.2104542553 * l + 0.793617785 * m - 0.0040720958 * s;
  };
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  window.__review = {
    init(url, regions) {
      state.regions = regions || null;
      const entry = Object.entries(window.__feedProbes).find(([k]) => k.endsWith(url));
      if (!entry) throw new Error('no probe for ' + url);
      state.probe = entry[1];
      const wrappers = [];
      state.probe.model.traverse((o) => { if (o.name === 'RecordedAvatar' || o.name.startsWith('Performer_')) wrappers.push(o); });
      state.performers = wrappers.map((w) => {
        const bones = {};
        w.traverse((o) => {
          if (!o.isBone) return;
          const tag = o.userData && o.userData.holoimHumanoidBone;
          // three's loader makes repeated names unique (a second performer's "Head" is "Head_1").
          const name = o.name.replace(/_\d+$/, '');
          for (const [k, re] of Object.entries(NAMES)) if (!bones[k] && (tag === k || re.test(name))) bones[k] = o;
        });
        const face = [];
        w.traverse((o) => {
          if (!o.isMesh || !o.geometry.morphAttributes || !o.geometry.morphAttributes.position) return;
          const targets = o.geometry.morphAttributes.position;
          const relative = o.geometry.morphTargetsRelative;
          const base = o.geometry.attributes.position;
          const n = base.count;
          const idx = [];
          for (let i = 0; i < n; i += 1) {
            for (const t of targets) {
              let dx = t.getX(i), dy = t.getY(i), dz = t.getZ(i);
              if (!relative) { dx -= base.getX(i); dy -= base.getY(i); dz -= base.getZ(i); }
              if (dx * dx + dy * dy + dz * dz > 0.0005 * 0.0005) { idx.push(i); break; }
            }
          }
          // Every fourth moved vertex is enough for a box.
          face.push({ mesh: o, idx: idx.filter((_, j) => j % 4 === 0) });
        });
        return { name: w.name, wrapper: w, bones, face };
      });
      state.objects = (state.probe.objects || []).map(({ entry, node }) => ({ name: entry.name, source: entry.source && entry.source.name, holds: entry.holds || [], node }));
      const actions = Object.values(state.probe.actions).filter(Boolean);
      const duration = Math.max(...actions.map((a) => a.getClip().duration));
      return { duration, performers: state.performers.map((p) => ({ name: p.name, bones: Object.keys(p.bones), faceVertices: p.face.reduce((s, f) => s + f.idx.length, 0) })), fov: state.probe.camera.fov, pixelRatio: state.probe.renderer.getPixelRatio(), objects: state.objects.map((o) => ({ name: o.name, source: o.source, holds: o.holds })) };
    },
    async seek(t) {
      for (const a of Object.values(state.probe.actions)) if (a) { a.paused = true; a.time = t; }
      state.probe.mixer.update(0);
      state.probe.model.updateWorldMatrix(true, true);
      await frames();
    },
    resume() { for (const a of Object.values(state.probe.actions)) if (a) a.paused = false; },
    card() {
      const cam = state.probe.camera;
      cam.updateMatrixWorld();
      const rect = state.probe.renderer.domElement.getBoundingClientRect();
      const project = (w) => {
        const v = w.clone().project(cam);
        return [Math.round(((v.x + 1) / 2) * rect.width * 10) / 10, Math.round(((1 - v.y) / 2) * rect.height * 10) / 10];
      };
      state.probe.model.updateWorldMatrix(true, true);
      return {
        canvas: { width: rect.width, height: rect.height, pixelRatio: state.probe.renderer.getPixelRatio() },
        performers: state.performers.map((p) => {
          const points = {};
          for (const [k, b] of Object.entries(p.bones)) points[k] = project(b.getWorldPosition(V()));
          if (p.bones.head) points.headTop = project(p.bones.head.getWorldPosition(V()).add(V().set(0, 0.17, 0)));
          let box = null;
          const v = V();
          for (const f of p.face) for (const i of f.idx) {
            const [x, y] = project(vertex(f.mesh, i, v));
            box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
          }
          return { name: p.name, points, face: box };
        }),
        objects: state.objects.map((o) => {
          let box = null;
          objectPoints(o.node, (w) => {
            const [x, y] = project(w);
            box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
          });
          return { name: o.name, box };
        })
      };
    },
    regions(i) {
      const cam = state.probe.camera;
      cam.updateMatrixWorld();
      state.probe.model.updateWorldMatrix(true, true);
      const rect = state.probe.renderer.domElement.getBoundingClientRect();
      const out = regionPoints(i, (w) => { const s = w.clone().project(cam); return [((s.x + 1) / 2) * rect.width, ((1 - s.y) / 2) * rect.height]; });
      delete out.brow;
      // The face's world centre, brow line to chin, to frame a close view on the face whatever the head's size.
      const world = regionPoints(i, (w) => [w.x, w.y, w.z]);
      const pts = [...world.brow, ...state.regions.chin.flatMap((s) => { const m = meshOf(state.performers[i], s); const v = V(); return s.idx.map((k) => { const q = vertex(m, k, v); return [q.x, q.y, q.z]; }); })];
      const faceCentre = pts.length ? [0, 1, 2].map((a) => (Math.min(...pts.map((q) => q[a])) + Math.max(...pts.map((q) => q[a]))) / 2) : null;
      return { ...out, faceCentre, pixelRatio: state.probe.renderer.getPixelRatio() };
    },
    bodies() {
      state.probe.model.updateWorldMatrix(true, true);
      const cam = state.probe.camera.position;
      return {
        camera: [cam.x, cam.y, cam.z],
        performers: state.performers.map((p) => {
          const h = p.bones.head ? p.bones.head.getWorldPosition(V()) : V();
          const hip = p.bones.hips ? p.bones.hips.getWorldPosition(V()) : h.clone();
          return { head: [h.x, h.y, h.z], hips: [hip.x, hip.y, hip.z] };
        }),
        objects: state.objects.map((o) => {
          const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
          objectPoints(o.node, (w) => {
            const a = [w.x, w.y, w.z];
            for (let k = 0; k < 3; k += 1) { min[k] = Math.min(min[k], a[k]); max[k] = Math.max(max[k], a[k]); }
          });
          return { name: o.name, min, max };
        })
      };
    },
    /**
     * view: { position: [x,y,z], target: [x,y,z], fov, width, height, label, background (hex number) }.
     * Returns a JPEG data URL and, when asked, the face box in output pixels.
     */
    close(i, view) {
      const r = state.probe.renderer;
      const cam = state.probe.camera.clone();
      // The card camera carries the card's view offset (its frame inside the canvas); the close view is a plain square camera.
      if (cam.clearViewOffset) cam.clearViewOffset();
      cam.zoom = 1;
      cam.fov = view.fov; cam.aspect = view.width / view.height; cam.near = 0.01; cam.far = 100;
      cam.position.set(...view.position); cam.lookAt(V().set(...view.target));
      cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      const prev = { w: r.domElement.clientWidth, h: r.domElement.clientHeight, pr: r.getPixelRatio(), alpha: r.getClearAlpha() };
      const size = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } };
      r.getSize(size);
      let colour = null;
      state.probe.model.traverse((o) => { if (!colour && o.material && o.material.color) colour = o.material.color.clone(); });
      if (colour) r.getClearColor(colour);
      r.setPixelRatio(1);
      r.setSize(view.width, view.height, false);
      r.setClearColor(view.background, 1);
      r.render(state.probe.scene, cam);
      const out = document.createElement('canvas');
      out.width = view.width; out.height = view.height;
      const ctx = out.getContext('2d');
      ctx.drawImage(r.domElement, 0, 0);
      if (view.label) {
        const px = Math.round(view.height / 28);
        ctx.font = px + 'px sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, ctx.measureText(view.label).width + px, px * 1.6);
        ctx.fillStyle = '${color.text}';
        ctx.fillText(view.label, px / 2, px * 1.15);
      }
      let face = null;
      if (view.faceBox && state.regions) {
        // With the audition's regions, the face box runs from the brow line to the chin, as on the card.
        const q = regionPoints(i, (w) => { const s = w.clone().project(cam); return [((s.x + 1) / 2) * view.width, ((1 - s.y) / 2) * view.height]; });
        const xs = q.brow.map((b) => b[0]);
        if (xs.length && q.browTop !== null && q.chinBottom !== null) face = [Math.min(...xs), q.browTop, Math.max(...xs), q.chinBottom];
      } else if (view.faceBox) {
        const p = state.performers[i];
        const v = V();
        for (const f of p.face) for (const k of f.idx) {
          const s = vertex(f.mesh, k, v).project(cam);
          const x = ((s.x + 1) / 2) * view.width, y = ((1 - s.y) / 2) * view.height;
          face = face ? [Math.min(face[0], x), Math.min(face[1], y), Math.max(face[2], x), Math.max(face[3], y)] : [x, y, x, y];
        }
      }
      let regions = null;
      if (view.regions) {
        regions = regionPoints(i, (w) => { const s = w.clone().project(cam); return [((s.x + 1) / 2) * view.width, ((1 - s.y) / 2) * view.height]; });
        const px = ctx.getImageData(0, 0, view.width, view.height).data;
        // Only brow vertices inside the frame are read; one clamped to the edge would read whatever is there.
        regions.browL = regions.brow.filter(([x, y]) => x >= 0 && y >= 0 && x < view.width && y < view.height).map(([x, y]) => {
          const k = (Math.round(Math.min(y, view.height - 1)) * view.width + Math.round(Math.min(x, view.width - 1))) * 4;
          return Math.round(lightness(px[k], px[k + 1], px[k + 2]) * 1000) / 1000;
        });
      }
      r.setSize(size.x, size.y, false);
      r.setPixelRatio(prev.pr);
      r.setClearColor(colour || 0x000000, prev.alpha);
      return { image: out.toDataURL('image/jpeg', 0.9), face, regions };
    }
  };
})();
`;

/** Tiles labelled images into one sheet, in a blank page. */
export const SHEET_PAGE = String.raw`
window.__sheet = async (tiles, columns, tileWidth, tileHeight, title) => {
  const rows = Math.ceil(tiles.length / columns);
  const head = title ? 34 : 0;
  const c = document.createElement('canvas');
  c.width = columns * tileWidth; c.height = rows * tileHeight + head;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '${color.deepSea}'; ctx.fillRect(0, 0, c.width, c.height);
  if (title) { ctx.fillStyle = '${color.text}'; ctx.font = '20px sans-serif'; ctx.fillText(title, 10, 24); }
  for (let i = 0; i < tiles.length; i += 1) {
    const img = new Image();
    img.src = tiles[i].src;
    await img.decode();
    const x = (i % columns) * tileWidth, y = Math.floor(i / columns) * tileHeight + head;
    const crop = tiles[i].crop || [0, 0, img.width, img.height];
    const scale = Math.min(tileWidth / crop[2], tileHeight / crop[3]);
    const w = crop[2] * scale, h = crop[3] * scale;
    ctx.drawImage(img, crop[0], crop[1], crop[2], crop[3], x + (tileWidth - w) / 2, y + (tileHeight - h) / 2, w, h);
    ctx.strokeStyle = '${color.ground.mid}'; ctx.strokeRect(x + 0.5, y + 0.5, tileWidth - 1, tileHeight - 1);
    ctx.font = '18px sans-serif';
    const label = tiles[i].label;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x, y, ctx.measureText(label).width + 12, 26);
    ctx.fillStyle = '${color.gold}'; ctx.fillText(label, x + 6, y + 19);
  }
  return c.toDataURL('image/jpeg', 0.88);
};
`;
