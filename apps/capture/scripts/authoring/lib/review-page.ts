/**
 * Helpers the review installs in the viewer page, as plain JavaScript: they
 * run inside viewer-web against its card probe (the scene, camera, renderer
 * and mixer the card draws with), so every frame is the real viewer's.
 *
 * `window.__review`:
 * - `init(url)`: finds the card's probe and the performers (wrappers named
 *   `RecordedAvatar` or `Performer_*`), their key bones and face vertices
 *   (the vertices any face shape moves by more than 0.5 mm).
 * - `seek(t)`: pauses the take at `t` and waits two frames so the card's
 *   camera and dome follow, as they would in playback.
 * - `card()`: per performer, key points and the face's box projected with
 *   the card's own camera, in CSS pixels of the card canvas.
 * - `close(i, view)`: renders performer `i` with the viewer's renderer and
 *   scene from a camera placed by `view`, returns a JPEG data URL.
 * - `bodies()`: world head and hips per performer, for planning `view`.
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
  const state = { probe: null, performers: [] };
  const V = () => new (state.probe.camera.position.constructor)();
  const vertex = (mesh, i, out) => {
    mesh.getVertexPosition ? mesh.getVertexPosition(i, out) : out.fromBufferAttribute(mesh.geometry.attributes.position, i);
    if (mesh.isSkinnedMesh && mesh.applyBoneTransform) mesh.applyBoneTransform(i, out);
    else if (mesh.isSkinnedMesh && mesh.boneTransform) mesh.boneTransform(i, out);
    return out.applyMatrix4(mesh.matrixWorld);
  };
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  window.__review = {
    init(url) {
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
      const actions = Object.values(state.probe.actions).filter(Boolean);
      const duration = Math.max(...actions.map((a) => a.getClip().duration));
      return { duration, performers: state.performers.map((p) => ({ name: p.name, bones: Object.keys(p.bones), faceVertices: p.face.reduce((s, f) => s + f.idx.length, 0) })), fov: state.probe.camera.fov, pixelRatio: state.probe.renderer.getPixelRatio() };
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
        })
      };
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
      if (view.faceBox) {
        const p = state.performers[i];
        const v = V();
        for (const f of p.face) for (const k of f.idx) {
          const s = vertex(f.mesh, k, v).project(cam);
          const x = ((s.x + 1) / 2) * view.width, y = ((1 - s.y) / 2) * view.height;
          face = face ? [Math.min(face[0], x), Math.min(face[1], y), Math.max(face[2], x), Math.max(face[3], y)] : [x, y, x, y];
        }
      }
      r.setSize(size.x, size.y, false);
      r.setPixelRatio(prev.pr);
      r.setClearColor(colour || 0x000000, prev.alpha);
      return { image: out.toDataURL('image/jpeg', 0.9), face };
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
