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
 * - `card(withBound, restore)`: per performer, key points projected with
 *   the card's own camera, in CSS pixels of the card canvas, and the face's
 *   box in the drawn pixels (`face`: the performers drawn alone, unlit, so
 *   a turned head hides its face); with `withBound`, also the box of every
 *   face vertex (`faceBound`, which must hold `face`; slow, so only on a few
 *   frames); per recorded object, its box the same way. The face pass
 *   leaves the canvas unfit to show unless `restore` (default true).
 * - `close(i, view)` (`view.exposure` multiplies the tone-mapping exposure for that render): renders performer `i` with the viewer's renderer and
 *   scene from a camera placed by `view`, returns a JPEG data URL (and,
 *   with `view.faceBox`, the face's box: brow line to chin when `init` had
 *   regions, else every vertex a face shape moves).
 * - `points(i)`: performer `i`'s named bones (head, hips, neck, hands,
 *   feet) in world space.
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
    leftFoot: /left_?foot$/i, rightFoot: /right_?foot$/i,
    leftIndex: /left_?hand_?index_?1$/i, rightIndex: /right_?hand_?index_?1$/i,
    leftMiddle: /left_?hand_?middle_?1$/i, rightMiddle: /right_?hand_?middle_?1$/i,
    leftLittle: /left_?hand_?(pinky|little)_?1$/i, rightLittle: /right_?hand_?(pinky|little)_?1$/i
  };
  const state = { probe: null, performers: [], objects: [], regions: null };
  const V = () => new (state.probe.camera.position.constructor)();
  const vertex = (mesh, i, out) => {
    // A skinned mesh's getVertexPosition already applies the morphs and the bones; skin it a second time and
    // the vertex moves by the pose twice (the review's face box now comes from the drawn pixels; see "Face measure" in slice 8 of the brief).
    if (mesh.getVertexPosition) mesh.getVertexPosition(i, out);
    else {
      out.fromBufferAttribute(mesh.geometry.attributes.position, i);
      if (mesh.isSkinnedMesh && mesh.boneTransform) mesh.boneTransform(i, out);
    }
    return out.applyMatrix4(mesh.matrixWorld);
  };
  // The box of every \`step\`th face vertex, projected to [x, y] with \`to\` (from NDC): with step 1 the drawn face
  // must lie inside it. Each vertex is skinned with its morphs on the CPU, which is slow: use step 1 only on a few
  // frames. Null when the performer has no face vertices.
  const vertexFace = (p, cam, to, step = 1) => {
    let box = null;
    const v = V();
    for (const f of p.face) for (let j = 0; j < f.all.length; j += step) {
      const q = vertex(f.mesh, f.all[j], v).project(cam);
      const [x, y] = to([q.x, q.y]);
      box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
    }
    return box;
  };
  // Each performer's face box in the drawn pixels, CSS px of the card canvas: in one render, every performer's face
  // vertices drawn red plus a blue of 64 × (i + 1) set in performer i's own materials, the rest of their meshes green, unlit, with the
  // card's own renderer and camera (the GPU skins them, and the depth test hides what a head or a body hides), every
  // other mesh hidden. This is the face a viewer sees; a box of the face vertices also counts a face turned away and
  // the mouth's inside (a pair's turned head measured 25.9 CSS px where 0.7 px of face was drawn). Null for a
  // performer with no face pixel. Objects do not hide a face here. \`restore\` renders the card again afterwards (the
  // headless renderer is software, so each render costs; the review takes its screenshot first and skips it).
  const drawnFaces = (restore) => {
    const r = state.probe.renderer, scene = state.probe.scene, cam = state.probe.camera;
    const own = new Map();
    state.performers.forEach((p, i) => p.wrapper.traverse((o) => { if (o.isMesh) own.set(o, { i, all: (p.face.find((f) => f.mesh === o) || { all: [] }).all }); }));
    const hidden = [];
    scene.traverse((o) => { if (o.visible && (o.isMesh || o.isPoints || o.isLine || o.isSprite) && !own.has(o)) { o.visible = false; hidden.push(o); } });
    // The performer code (the blue) is in each mesh's own material, not in the vertex colours: two performers can share
    // one geometry, and a colour attribute written for the second performer then paints the first one's face too.
    const flat = (m, code) => {
      const c = m.clone();
      for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap']) if (k in c) c[k] = null;
      if (c.color) c.color.setRGB(1, 1, 1);
      if (c.emissive) c.emissive.setRGB(0, 0, 0);
      if ('roughness' in c) c.roughness = 1;
      if ('metalness' in c) c.metalness = 0;
      c.vertexColors = true; c.transparent = false; c.opacity = 1; c.needsUpdate = true;
      // Unlit: the pixel is the vertex colour, so a face turned from the light still shows (lit, it went too dark to read).
      c.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragColor = vec4(vColor.r, vColor.g, vColor.r * ' + code.toFixed(4) + ', 1.0);'); };
      c.customProgramCacheKey = () => 'holoim-face-truth-' + code;
      return c;
    };
    const saved = [], geometries = new Map();
    for (const [mesh, { i, all }] of own) {
      if (!mesh.visible) continue;
      const g = mesh.geometry;
      if (!geometries.has(g)) {
        // Face vertices red, the rest green; the same for every performer that shares this geometry.
        const colour = g.attributes.position.clone();
        for (let k = 0; k < colour.count; k += 1) colour.setXYZ(k, 0, 1, 0);
        for (const k of all) colour.setXYZ(k, 1, 0, 0);
        geometries.set(g, g.attributes.color);
        g.setAttribute('color', colour);
      }
      saved.push({ mesh, material: mesh.material });
      const code = (64 * (i + 1)) / 255;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => flat(m, code)) : flat(mesh.material, code);
    }
    const background = scene.background, fog = scene.fog;
    scene.background = null; scene.fog = null;
    const alpha = r.getClearAlpha();
    r.setClearAlpha(0);
    r.render(scene, cam);
    const w = r.domElement.width, h = r.domElement.height;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(r.domElement, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    const boxes = state.performers.map(() => null);
    const stray = state.performers.map(() => 0);
    // A pixel's performer: its blue within 8 of a code. The antialiasing resolve leaves lone edge pixels whose blue
    // falls near the wrong code (a 2-pixel speck of 112 at the edge of performer 0's face stretched performer 1's box
    // over her face), so a pixel counts only when 2 or more of its 4 neighbours have the same code. stray: the face
    // pixels left out, per the code a plain rounding gives them.
    const code = new Int8Array(w * h).fill(-1);
    for (let k = 0, n = 0; n < w * h; n += 1, k += 4) {
      if (px[k + 3] === 0 || px[k] <= 128 || px[k + 1] >= 64) continue;
      const i = Math.round(px[k + 2] / 64) - 1;
      if (i < 0 || i >= boxes.length) continue;
      if (Math.abs(px[k + 2] - 64 * (i + 1)) > 8) { stray[i] += 1; continue; }
      code[n] = i;
    }
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const i = code[y * w + x];
      if (i < 0) continue;
      const same = (x > 0 && code[y * w + x - 1] === i) + (x < w - 1 && code[y * w + x + 1] === i)
        + (y > 0 && code[(y - 1) * w + x] === i) + (y < h - 1 && code[(y + 1) * w + x] === i);
      if (same < 2) { stray[i] += 1; continue; }
      const b = boxes[i];
      boxes[i] = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x + 1), Math.max(b[3], y + 1)] : [x, y, x + 1, y + 1];
    }
    for (const [g, colour] of geometries) if (colour) g.setAttribute('color', colour); else g.deleteAttribute('color');
    for (const s of saved) {
      (Array.isArray(s.mesh.material) ? s.mesh.material : [s.mesh.material]).forEach((c) => c.dispose());
      s.mesh.material = s.material;
    }
    for (const o of hidden) o.visible = true;
    scene.background = background; scene.fog = fog;
    r.setClearAlpha(alpha);
    if (restore) r.render(scene, cam);
    const rect = r.domElement.getBoundingClientRect();
    const sx = rect.width / w, sy = rect.height / h;
    return { stray, boxes: boxes.map((box) => (box ? [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy].map((v) => Math.round(v * 10) / 10) : null)) };
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
          face.push({ mesh: o, all: idx });
        });
        return { name: w.name, wrapper: w, bones, face };
      });
      state.objects = (state.probe.objects || []).map(({ entry, node }) => ({ name: entry.name, source: entry.source && entry.source.name, holds: entry.holds || [], node }));
      const actions = Object.values(state.probe.actions).filter(Boolean);
      const duration = Math.max(...actions.map((a) => a.getClip().duration));
      return { duration, performers: state.performers.map((p) => ({ name: p.name, bones: Object.keys(p.bones), faceVertices: p.face.reduce((s, f) => s + f.all.length, 0) })), fov: state.probe.camera.fov, pixelRatio: state.probe.renderer.getPixelRatio(), objects: state.objects.map((o) => ({ name: o.name, source: o.source, holds: o.holds })) };
    },
    async seek(t) {
      for (const a of Object.values(state.probe.actions)) if (a) { a.paused = true; a.time = t; }
      state.probe.mixer.update(0);
      state.probe.model.updateWorldMatrix(true, true);
      await frames();
    },
    resume() { for (const a of Object.values(state.probe.actions)) if (a) a.paused = false; },
    card(withBound = false, restore = true) {
      const cam = state.probe.camera;
      cam.updateMatrixWorld();
      const rect = state.probe.renderer.domElement.getBoundingClientRect();
      const project = (w) => {
        const v = w.clone().project(cam);
        return [Math.round(((v.x + 1) / 2) * rect.width * 10) / 10, Math.round(((1 - v.y) / 2) * rect.height * 10) / 10];
      };
      state.probe.model.updateWorldMatrix(true, true);
      const drawn = drawnFaces(restore);
      return {
        canvas: { width: rect.width, height: rect.height, pixelRatio: state.probe.renderer.getPixelRatio() },
        performers: state.performers.map((p, i) => {
          const points = {};
          for (const [k, b] of Object.entries(p.bones)) points[k] = project(b.getWorldPosition(V()));
          if (p.bones.head) points.headTop = project(p.bones.head.getWorldPosition(V()).add(V().set(0, 0.17, 0)));
          const r1 = (n) => Math.round(n * 10) / 10;
          const bound = withBound && vertexFace(p, cam, ([x, y]) => [r1(((x + 1) / 2) * rect.width), r1(((1 - y) / 2) * rect.height)]);
          return { name: p.name, points, face: drawn.boxes[i], faceStray: drawn.stray[i], faceBound: bound || null };
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
    /** Performer i's named bones (head, hips, neck, hands, feet, the index, middle and little knuckles) in world space, for placing a close camera. */
    points(i) {
      state.probe.model.updateWorldMatrix(true, true);
      const out = {};
      for (const [k, b] of Object.entries(state.performers[i].bones)) { const w = b.getWorldPosition(V()); out[k] = [w.x, w.y, w.z]; }
      return out;
    },
    /**
     * How much of performer i's hand (\`side\`: the skin that the hand and finger bones move most) each view sees.
     * Each view is { position, target, fov }. Two small unlit renders per view: the hand with everything else drawn
     * black and both-sided (so a body or an object in front of the hand hides it, and a camera inside a body sees
     * nothing), then the hand alone. Returns per view { visible, total } in pixels of a \`size\`-pixel square.
     */
    handView(i, side, views, size) {
      const r = state.probe.renderer, scene = state.probe.scene;
      const p = state.performers[i];
      const handBone = new RegExp('^' + side + '_?hand', 'i');
      const own = [];
      p.wrapper.traverse((o) => { if (o.isSkinnedMesh && o.visible) own.push(o); });
      const others = [];
      scene.traverse((o) => { if (o.visible && (o.isMesh || o.isPoints || o.isLine || o.isSprite) && !own.includes(o)) others.push(o); });
      const unlit = (m, discardRest) => {
        const c = m.clone();
        for (const k of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap']) if (k in c) c[k] = null;
        if (c.color) c.color.setRGB(1, 1, 1);
        c.vertexColors = true; c.transparent = false; c.opacity = 1; c.side = 2; c.needsUpdate = true;
        c.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  ' + (discardRest ? 'if (vColor.r < 0.5) discard;\n  ' : '') + 'gl_FragColor = vec4(vColor.r, 0.0, 0.0, 1.0);'); };
        c.customProgramCacheKey = () => 'holoim-hand-view-' + (discardRest ? 'alone' : 'scene');
        return c;
      };
      const saved = [], geometries = new Map();
      for (const mesh of own) {
        const g = mesh.geometry;
        if (!geometries.has(g)) {
          const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
          const colour = g.attributes.position.clone();
          for (let k = 0; k < colour.count; k += 1) {
            let best = 0, bone = -1;
            for (let a = 0; a < 4; a += 1) { const w = sw.getComponent(k, a); if (w > best) { best = w; bone = si.getComponent(k, a); } }
            const b = bone >= 0 ? mesh.skeleton.bones[bone] : null;
            colour.setXYZ(k, b && handBone.test(b.name) ? 1 : 0, 0, 0);
          }
          geometries.set(g, g.attributes.color);
          g.setAttribute('color', colour);
        }
        saved.push({ mesh, material: mesh.material });
      }
      const otherSaved = others.map((o) => ({ o, material: o.material, visible: o.visible }));
      const prev = { pr: r.getPixelRatio(), alpha: r.getClearAlpha() };
      const sz = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } };
      r.getSize(sz);
      let clearColour = null;
      state.probe.model.traverse((o) => { if (!clearColour && o.material && o.material.color) clearColour = o.material.color.clone(); });
      if (clearColour) r.getClearColor(clearColour);
      const background = scene.background, fog = scene.fog;
      scene.background = null; scene.fog = null;
      r.setPixelRatio(1); r.setSize(size, size, false); r.setClearColor(0x000000, 1);
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      // The hand pixels of the current render, as a mask.
      const mask = () => {
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(r.domElement, 0, 0);
        const px = ctx.getImageData(0, 0, size, size).data;
        const m = new Uint8Array(size * size);
        for (let k = 0; k < m.length; k += 1) m[k] = px[k * 4] > 128 ? 1 : 0;
        return m;
      };
      const out = [];
      // Make the replacement materials once per call: disposing of the last material of a shader program deletes
      // the program, so new clones for each view would compile the shaders again for each view.
      const both = (s, discardRest) => Array.isArray(s.material) ? s.material.map((m) => unlit(m, discardRest)) : unlit(s.material, discardRest);
      const inSceneMaterials = saved.map((s) => both(s, false));
      const aloneMaterials = saved.map((s) => both(s, true));
      const blackMaterials = otherSaved.map((s) => {
        if (!s.o.isMesh) return null;
        const m = (Array.isArray(s.material) ? s.material[0] : s.material).clone();
        for (const k of ['map', 'emissiveMap']) if (k in m) m[k] = null;
        if (m.color) m.color.setRGB(0, 0, 0);
        if (m.emissive) m.emissive.setRGB(0, 0, 0);
        m.vertexColors = false; m.transparent = false; m.opacity = 1; m.side = 2;
        m.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);'); };
        m.customProgramCacheKey = () => 'holoim-hand-view-black';
        return m;
      });
      try {
        for (const view of views) {
          const cam = state.probe.camera.clone();
          if (cam.clearViewOffset) cam.clearViewOffset();
          cam.zoom = 1; cam.fov = view.fov; cam.aspect = 1; cam.near = 0.01; cam.far = 100;
          cam.position.set(...view.position); cam.lookAt(V().set(...view.target));
          cam.updateProjectionMatrix(); cam.updateMatrixWorld();
          // The hand in the scene: every other mesh is a black occluder.
          saved.forEach((s, k) => { s.mesh.material = inSceneMaterials[k]; });
          otherSaved.forEach((s, k) => { if (blackMaterials[k]) s.o.material = blackMaterials[k]; else s.o.visible = false; });
          r.render(scene, cam);
          const inScene = mask();
          saved.forEach((s, k) => { s.mesh.material = aloneMaterials[k]; });
          for (const s of otherSaved) s.o.visible = false;
          r.render(scene, cam);
          // Count a pixel as seen only where the hand alone also covers it, so visible can never pass total.
          const alone = mask();
          let visible = 0, total = 0;
          for (let k = 0; k < alone.length; k += 1) if (alone[k]) { total += 1; visible += inScene[k]; }
          for (const s of otherSaved) { s.o.material = s.material; s.o.visible = s.visible; }
          out.push({ visible, total });
        }
      } finally {
        for (const s of saved) s.mesh.material = s.material;
        for (const s of otherSaved) { s.o.material = s.material; s.o.visible = s.visible; }
        for (const m of [...inSceneMaterials, ...aloneMaterials, ...blackMaterials].flat()) if (m) m.dispose();
        for (const [g, colour] of geometries) if (colour) g.setAttribute('color', colour); else g.deleteAttribute('color');
        scene.background = background; scene.fog = fog;
        r.setSize(sz.x, sz.y, false); r.setPixelRatio(prev.pr); r.setClearColor(clearColour || 0x000000, prev.alpha);
      }
      return out;
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
     * view: { position: [x,y,z], target: [x,y,z], fov, width, height, label, background (hex number), far (m, optional: clips the stage behind the performer) }.
     * Returns a JPEG data URL and, when asked, the face box in output pixels.
     */
    close(i, view) {
      const r = state.probe.renderer;
      const cam = state.probe.camera.clone();
      // The card camera carries the card's view offset (its frame inside the canvas); the close view is a plain square camera.
      if (cam.clearViewOffset) cam.clearViewOffset();
      cam.zoom = 1;
      cam.fov = view.fov; cam.aspect = view.width / view.height; cam.near = 0.01; cam.far = view.far ?? 100;
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
      // view.exposure: a multiplier on the viewer's tone-mapping exposure for this render only (the clay finish is lit and has no emissive).
      const exposure = r.toneMappingExposure;
      if (view.exposure) r.toneMappingExposure = exposure * view.exposure;
      r.render(state.probe.scene, cam);
      r.toneMappingExposure = exposure;
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
        face = vertexFace(state.performers[i], cam, ([x, y]) => [((x + 1) / 2) * view.width, ((1 - y) / 2) * view.height], 4);
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
