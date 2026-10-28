import type { Page } from "@playwright/test";
import type * as Three from "three";
import type { Probe } from "./ar-bubble-types";

// Where a hologram's recorded floor ends up against the floor the viewer
// draws (B-022). The recorded floor is the capture scene's own ground under
// the author, found by casting down through the exported scene; the viewer's
// ground is the cloche's foot and, in AR, the surface the hologram is placed on.
// Read at the take's start, where the author stands: a take can walk off a
// ledge, and a bubble that follows its author carries the dome down with it.
// In the feed the dome wraps all the bubble draws, so its foot is the lowest
// drawn ground, which is under the author's floor where the ground falls away.
export type FloorReport = {
  mode: "feed" | "ar";
  /** The exported scene's ground under the author, world y. */
  recordedFloorY: number;
  /** The author's lowest foot bone (the ankle, a few centimetres up), world y. */
  footBoneY: number;
  /** The cloche's foot (its floor and shade), world y. */
  clocheBaseY: number;
  /** AR only: the placed hologram's origin, on the room floor. */
  placementY: number | null;
  /** Feed only: the lowest recorded ground inside the bubble, world y. */
  lowestDrawnY: number | null;
  /** Feed only: the drawn points of the recorded scene outside the glass; null for a take whose rim lifts (see `measureGlass`). */
  outsideGlass: number | null;
  /** Feed only: the take's rim lifts, so the bent dome clips it (3.4). */
  rimLifts: boolean;
};

type ClocheBase = { base: { x: number; y: number; z: number }; radii: { x: number; y: number; z: number }; exponent: number };

type FloorProbe = Probe & {
  cloche?: { current: ClocheBase | null } | { shape: { current: ClocheBase | null }; fitted: { current: Three.Vector3 | null } };
  group?: { current: Three.Object3D | null };
};

export async function measureFloor(page: Page, mode: "feed" | "ar"): Promise<FloorReport> {
  return page.evaluate(async (mode) => {
    const { Raycaster, Vector3 } = (await (window as unknown as { __HOLOIM_TEST_MODULES__: Promise<{ three: typeof Three }> }).__HOLOIM_TEST_MODULES__).three;
    const hooks = window as unknown as { __feedProbe: FloorProbe; __bubbleProbe: FloorProbe };
    const probe = mode === "feed" ? hooks.__feedProbe : hooks.__bubbleProbe;
    const { model, mixer } = probe;
    mixer.setTime(0);
    model.updateWorldMatrix(true, true);
    const avatar = model.getObjectByName("RecordedAvatar");
    if (!avatar) throw new Error("export has no RecordedAvatar");
    const author = avatar.getWorldPosition(new Vector3());
    const ground: Three.Object3D[] = [];
    model.getObjectByName("RecordedSceneBubble")?.traverse((node) => { if ((node as Three.Mesh).isMesh) ground.push(node); });
    if (ground.length === 0) throw new Error("export has no recorded scene");
    let footBoneY = Infinity;
    const foot = new Vector3();
    avatar.traverse((node) => {
      if ((node as Three.Bone).isBone && /(Left|Right)(Foot|ToeBase)$/.test(node.name)) footBoneY = Math.min(footBoneY, node.getWorldPosition(foot).y);
    });
    // Down from above the author's head: the first ground at or below the feet.
    const raycaster = new Raycaster(author.clone().setY(author.y + 2), new Vector3(0, -1, 0));
    const hit = raycaster.intersectObjects(ground, false).find((h) => h.point.y <= footBoneY + 0.05);
    if (!hit) throw new Error("no recorded ground under the author");

    let clocheBaseY = Number.NaN;
    let placementY: number | null = null;
    let lowestDrawnY: number | null = null;
    let outsideGlass: number | null = null;
    const rimLifts = mode === "feed" && (probe as FloorProbe & { rim?: { lifts: boolean } }).rim?.lifts === true;
    if (mode === "feed") {
      // The dome follows the bubble by its centre's shift since the fit.
      const cloche = probe.cloche as { shape: { current: ClocheBase | null }; fitted: { current: Three.Vector3 | null } };
      const sphere = model.getObjectByName("RecordedBubbleSphere");
      const shift = sphere && cloche.fitted.current ? sphere.getWorldPosition(new Vector3()).y - cloche.fitted.current.y : 0;
      const shape = cloche.shape.current;
      if (shape) clocheBaseY = shape.base.y + shift;
      if (shape && sphere && cloche.fitted.current) {
        const mesh = sphere as Three.Mesh;
        mesh.geometry.computeBoundingSphere();
        const bubble = mesh.geometry.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld);
        const offset = bubble.center.clone().sub(cloche.fitted.current);
        const point = new Vector3();
        lowestDrawnY = Infinity;
        outsideGlass = 0;
        for (const node of ground) {
          const position = (node as Three.Mesh).geometry.getAttribute("position");
          for (let i = 0; i < position.count; i += 1) {
            point.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld);
            if (point.distanceTo(bubble.center) > bubble.radius) continue;
            lowestDrawnY = Math.min(lowestDrawnY, point.y);
            // |x/rx|^n + |y/ry|^n + |z/rz|^n of the point against the dome where it is now.
            const { base, radii, exponent: n } = shape;
            const value = Math.abs((point.x - base.x - offset.x) / radii.x) ** n + Math.abs((point.y - base.y - offset.y) / radii.y) ** n + Math.abs((point.z - base.z - offset.z) / radii.z) ** n;
            if (point.y < base.y + offset.y - 0.01 || value > 1) outsideGlass += 1;
          }
        }
        // The bent dome clips a take whose rim lifts: what it draws is counted on the GPU (measureGlass).
        if (rimLifts) outsideGlass = null;
      }
    } else {
      const group = probe.group?.current;
      const shape = (probe.cloche as { current: ClocheBase | null }).current;
      if (group) {
        placementY = group.getWorldPosition(new Vector3()).y;
        if (shape) clocheBaseY = group.localToWorld(new Vector3(shape.base.x, shape.base.y, shape.base.z)).y;
      }
    }
    return { mode, recordedFloorY: hit.point.y, footBoneY, clocheBaseY, placementY, lowestDrawnY, outsideGlass, rimLifts };
  }, mode);
}

// The rim follows the ground (styleguide 3.4): where the feed's bent foot
// stands against the recorded ground, measured with the test's own raycast
// and its own reading of the brief's formulas, never the viewer's height
// field. A bin's edge is the foot's edge (ρ = 1) in the middle of its
// direction; where there is no ground there, the ground's edge is found by
// stepping inward.
export type RimBin = {
  bin: number;
  /** The rim's height at the edge (the foot plus its lift), world y. */
  rim: number;
  /** The recorded ground under it, world y; null with none within reach. */
  ground: number | null;
  /** A ledge of another recorded mesh, within a step over the ground, that the rim stands on instead. */
  ledge: number | null;
  /** How far inward the ground's edge was found, metres (0: at the dome's edge). */
  inward: number;
  slopeDeg: number;
  /** The lift is at its cap (0.6 × dome height): the ground is higher than the dome can take. */
  capped: boolean;
  /** The ground is under the foot's dead-band: a rim never goes below its foot, and the dome's floor cuts that ground. */
  belowFoot: boolean;
  error: number | null;
  pass: boolean;
  /** Diagnostics only: the edge point, and the viewer's own ground field there. */
  edge: [number, number];
  field: number | null;
};

export type RimSnapshot = { label: string; seconds: number; footY: number; heightY: number; bins: RimBin[]; failures: number; worst: RimBin | null };

export type RimState = {
  gated: boolean;
  rimReady: boolean;
  lifts: boolean;
  maxLift: number;
  buildMs: number | null;
  candidates: number;
  timing: { lastMs: number; meanMs: number; maxMs: number; frames: number; p99Ms: number } | null;
  shadeDrawn: boolean | null;
  /** The largest lift drawn this frame, metres. */
  liftNow: number;
};

type RimProbe = FloorProbe & {
  rim: Omit<RimState, "shadeDrawn" | "liftNow"> & { heights: Float32Array | null; target?: Float32Array | null; raw?: Float32Array | null; groundAt: ((x: number, z: number) => number) | null };
};

const CELL_METERS = 0.2;

export async function readRimState(page: Page): Promise<RimState> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __feedProbe: RimProbe }).__feedProbe;
    const { rim, scene } = probe;
    const shade = scene.getObjectByName("cloche-shade");
    let liftNow = 0;
    for (const value of rim.heights ?? []) liftNow = Math.max(liftNow, value);
    return { gated: rim.gated, rimReady: rim.rimReady, lifts: rim.lifts, maxLift: rim.maxLift, buildMs: rim.buildMs, candidates: rim.candidates, timing: rim.timing ? (() => { const { recent, ...rest } = rim.timing as typeof rim.timing & { recent: Float32Array }; const seen = Array.from(recent.subarray(0, Math.min(rest.frames, recent.length))).sort((a, b) => a - b); return { ...rest, p99Ms: seen[Math.floor(0.99 * Math.max(seen.length - 1, 0))] ?? 0 }; })() : null, shadeDrawn: shade ? shade.visible : null, liftNow };
  });
}

/**
 * Seeks the take to `seconds` and waits until the drawn rim has reached the
 * rim the take wants there. Real time; pause the card first (`pauseTake`) so
 * the take holds still while it is measured.
 */
export async function seekTake(page: Page, seconds: number): Promise<void> {
  const from = await page.evaluate((seconds) => {
    const probe = (window as unknown as { __feedProbe: RimProbe }).__feedProbe;
    // Each action's own time, so a paused card seeks as well.
    for (const action of Object.values(probe.actions)) action.time = seconds;
    probe.mixer.update(0);
    return probe.renderer.info.render.frame;
  }, seconds);
  await page.waitForFunction((from) => {
    const probe = (window as unknown as { __feedProbe: RimProbe & { rim: { target: Float32Array | null } } }).__feedProbe;
    if (probe.renderer.info.render.frame < from + 2) return false;
    const { heights, target } = probe.rim;
    if (!heights || !target) return true;
    for (let bin = 0; bin < heights.length; bin += 1) if (Math.abs(heights[bin]! - target[bin]!) > 1e-3) return false;
    return true;
  }, from);
}

/** Holds or resumes the card's playback, as its pause control does. */
export async function pauseTake(page: Page, paused: boolean): Promise<void> {
  await page.evaluate((paused) => (window as unknown as { __feedProbe: { portal: { setPaused(paused: boolean): void } } }).__feedProbe.portal.setPaused(paused), paused);
}

/** Rim against ground for every bin, now. `groundNames` limits the raycast to those nodes (a fixture's ground), else every opaque recorded mesh. */
export async function measureRim(page: Page, label: string, groundNames: readonly string[] | null = null): Promise<RimSnapshot> {
  return page.evaluate(async ({ label, groundNames, cell }) => {
    const { Matrix3, Raycaster, Vector3 } = (await (window as unknown as { __HOLOIM_TEST_MODULES__: Promise<{ three: typeof Three }> }).__HOLOIM_TEST_MODULES__).three;
    const probe = (window as unknown as { __feedProbe: RimProbe }).__feedProbe;
    const { model } = probe;
    const cloche = probe.cloche as { shape: { current: ClocheBase | null }; fitted: { current: Three.Vector3 | null } };
    const shape = cloche.shape.current;
    const sphere = model.getObjectByName("RecordedBubbleSphere");
    if (!shape || !sphere || !cloche.fitted.current) throw new Error("no fitted cloche");
    model.updateWorldMatrix(true, true);
    const shift = sphere.getWorldPosition(new Vector3()).sub(cloche.fitted.current);
    const heights = probe.rim.heights ? Array.from(probe.rim.heights) : [];
    const bins = heights.length || 180;
    const avatar = model.getObjectByName("RecordedAvatar");
    const isWithin = (node: Three.Object3D, root: Three.Object3D) => {
      for (let at: Three.Object3D | null = node; at; at = at.parent) if (at === root) return true;
      return false;
    };
    const ground: Three.Object3D[] = [];
    const others: Three.Object3D[] = [];
    model.getObjectByName("RecordedSceneBubble")?.traverse((node) => {
      const mesh = node as Three.Mesh;
      if (!mesh.isMesh) return;
      if (!avatar || !isWithin(node, avatar)) others.push(node);
      if (groundNames) {
        // By name prefix: an export suffixes its meshes (`_RecordedBubble`).
        if (groundNames.some((name) => node.name.startsWith(name) || (node.parent?.name ?? "").startsWith(name))) ground.push(node);
        return;
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (materials.some((material) => material.opacity >= 0.5)) ground.push(node);
    });
    const { base, radii, exponent: n } = shape;
    const footY = base.y + shift.y;
    const top = footY + radii.y * 3;
    const raycaster = new Raycaster();
    const down = new Vector3(0, -1, 0);
    const normal = new Vector3();
    const normalMatrix = new Matrix3();
    // Upward faces of the other recorded meshes over (x, z), highest first.
    const ledgesAt = (x: number, z: number): number[] => {
      raycaster.set(new Vector3(x, top, z), down);
      const out: number[] = [];
      for (const hit of raycaster.intersectObjects(others, false)) {
        if (!hit.face || ground.includes(hit.object)) continue;
        // Only what the brief lets stand as ground: opaque, not glass.
        const material = (hit.object as Three.Mesh).material as Three.Material & { transmission?: number };
        if (Array.isArray(material) || material.opacity < 0.5 || (material.transmission ?? 0) > 0) continue;
        normal.copy(hit.face.normal).applyMatrix3(normalMatrix.getNormalMatrix(hit.object.matrixWorld)).normalize();
        if (normal.y >= 0.35) out.push(hit.point.y);
      }
      return out;
    };
    const groundAt = (x: number, z: number): number | null => {
      raycaster.set(new Vector3(x, top, z), down);
      for (const hit of raycaster.intersectObjects(ground, false)) {
        if (!hit.face) continue;
        // World normal through the normal matrix: a scaled mesh (a flattened disc of grass) tilts its faces.
        normal.copy(hit.face.normal).applyMatrix3(normalMatrix.getNormalMatrix(hit.object.matrixWorld)).normalize();
        if (normal.y >= 0.35) return hit.point.y;
      }
      return null;
    };
    const reach = 0.7 * Math.max(radii.x, radii.z);
    const out: RimBin[] = [];
    for (let bin = 0; bin < bins; bin += 1) {
      const angle = ((bin + 0.5) / bins) * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const k = (Math.abs(c) ** n + Math.abs(s) ** n) ** (1 / n);
      const ex = base.x + shift.x + (c / k) * radii.x;
      const ez = base.z + shift.z + (s / k) * radii.z;
      const cx = base.x + shift.x;
      const cz = base.z + shift.z;
      const span = Math.hypot(ex - cx, ez - cz);
      let found: number | null = null;
      let inward = 0;
      for (let step = 0; step * 0.05 <= reach; step += 1) {
        inward = step * 0.05;
        const t = Math.max(0, 1 - inward / span);
        found = groundAt(cx + (ex - cx) * t, cz + (ez - cz) * t);
        if (found !== null) break;
      }
      const lift = heights[bin] ?? 0;
      const rim = footY + lift;
      let slopeDeg = 0;
      if (found !== null) {
        const t = Math.max(0, 1 - inward / span);
        const px = cx + (ex - cx) * t;
        const pz = cz + (ez - cz) * t;
        const d = cell;
        const [xp, xm, zp, zm] = [groundAt(px + d, pz), groundAt(px - d, pz), groundAt(px, pz + d), groundAt(px, pz - d)];
        // One-sided where the ground stops: the slope is what is there.
        const gx = xp !== null && xm !== null ? (xp - xm) / (2 * d) : xp !== null ? (xp - found) / d : xm !== null ? (found - xm) / d : 0;
        const gz = zp !== null && zm !== null ? (zp - zm) / (2 * d) : zp !== null ? (zp - found) / d : zm !== null ? (found - zm) / d : 0;
        slopeDeg = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
      }
      const capped = lift >= 0.6 * radii.y - 1e-3;
      const belowFoot = found !== null && found < footY + 0.03;
      const error = found === null ? null : rim - found;
      const tolerance = slopeDeg < 30 ? null : cell * Math.tan((slopeDeg * Math.PI) / 180);
      let pass: boolean;
      const onGround = error !== null && (tolerance === null ? error >= -0.03 && error <= 0.05 : Math.abs(error) <= Math.max(tolerance, 0.05));
      if (found === null) pass = lift <= 1e-3;
      // Ground higher than the dome can take: the lift stays at its cap, 0.6 × the height (the brief's failure
      // cases). A capped rim on the ground within the tolerance passes as any other.
      else if (capped) pass = found >= rim || onGround;
      // The ground there is cut by the dome's floor: the rim stays at its foot, raised by its neighbours' smoothing at most.
      else if (belowFoot) pass = lift <= 0.03 + 1e-3;
      else pass = onGround;
      // A ledge of another mesh within a step (0.35 m) over the ground is ground too, by the brief's connectivity rule.
      let ledge: number | null = null;
      if (!pass && found !== null && groundNames) {
        const t = Math.max(0, 1 - inward / span);
        for (const height of ledgesAt(cx + (ex - cx) * t, cz + (ez - cz) * t)) {
          if (height <= found || height > found + 0.35 || rim - height < -0.03 || rim - height > 0.05) continue;
          ledge = height;
          pass = true;
          break;
        }
      }
      const field = probe.rim.groundAt?.(ex, ez) ?? null;
      out.push({ bin, rim, ground: found, ledge, inward, slopeDeg, capped, belowFoot, error, pass, edge: [ex, ez], field: field !== null && Number.isFinite(field) ? field : null });
    }
    const failures = out.filter((bin) => !bin.pass);
    const worst = failures.reduce<RimBin | null>((max, bin) => (!max || Math.abs(bin.error ?? 0) > Math.abs(max.error ?? 0) ? bin : max), null);
    return { label, seconds: Object.values(probe.actions)[0]?.time ?? 0, footY, heightY: radii.y, bins: out, failures: failures.length, worst };
  }, { label, groundNames: groundNames ? [...groundNames] : null, cell: CELL_METERS });
}

export type RimMotionReport = { frames: number; snaps: number; maxFrameChange: number; maxFrameChangeAt: number; maxFrameChangeBin: number; maxFrameChangeTarget: number | null; maxFrameChangeDt: number; maxNeighbourChange: number; maxNeighbourExcess: number; maxNeighbourExcessBin: number; maxNeighbourExcessPair: { at: number; rim: number[]; ground: number[] } | null; maxTargetNeighbourExcess: number; settledPairs: number; pairs: number; heightY: number; meanFrameS: number };

/**
 * The rim per bin, read every drawn frame over `seconds` of real playback
 * from the take's start: the largest change in a frame (scaled to a 60 fps
 * frame when frames come slower; a loop's snap aside) and between
 * neighbouring bins. The rim hugs the ground, so neighbours may differ by
 * 5% of the dome's height or by the ground's own step there plus 5 cm,
 * whichever is more; `maxNeighbourExcess` is the most any pair goes over
 * that, among pairs whose bins have both settled (within 2 cm of their
 * target); `maxTargetNeighbourExcess` is the same for the target every
 * frame. While a bin lags ground that moves faster than `maxRate`, its step
 * from its neighbour is the ground's history, held by the per-frame limit.
 */
export async function sampleRimMotion(page: Page, seconds: number): Promise<RimMotionReport> {
  await seekTake(page, 0);
  await pauseTake(page, false);
  return page.evaluate((seconds) => new Promise<RimMotionReport>((done) => {
    const probe = (window as unknown as { __feedProbe: RimProbe }).__feedProbe;
    const cloche = probe.cloche as { shape: { current: ClocheBase | null } };
    const report: RimMotionReport = { frames: 0, snaps: 0, maxFrameChange: 0, maxFrameChangeAt: 0, maxFrameChangeBin: 0, maxFrameChangeTarget: null, maxFrameChangeDt: 0, maxNeighbourChange: 0, maxNeighbourExcess: -Infinity, maxNeighbourExcessBin: 0, maxNeighbourExcessPair: null, maxTargetNeighbourExcess: -Infinity, settledPairs: 0, pairs: 0, heightY: cloche.shape.current?.radii.y ?? 0, meanFrameS: 0 };
    const time = () => Object.values(probe.actions)[0]?.time ?? 0;
    let lastFrame = probe.renderer.info.render.frame;
    let last = { time: time(), heights: Array.from(probe.rim.heights ?? []) };
    let played = 0;
    const tick = () => {
      const frame = probe.renderer.info.render.frame;
      if (frame !== lastFrame) {
        lastFrame = frame;
        const now = { time: time(), heights: Array.from(probe.rim.heights ?? []) };
        const dt = now.time - last.time;
        report.frames += 1;
        if (dt < 0) report.snaps += 1;
        else {
          played += dt;
          // Slower frames move further; a 60 fps frame moves this share of it.
          const scale = dt > 1 / 60 ? 1 / 60 / dt : 1;
          for (let bin = 0; bin < now.heights.length; bin += 1) {
            const change = Math.abs(now.heights[bin]! - (last.heights[bin] ?? 0)) * scale;
            if (change > report.maxFrameChange) {
              report.maxFrameChange = change;
              report.maxFrameChangeAt = now.time;
              report.maxFrameChangeBin = bin;
              report.maxFrameChangeTarget = probe.rim.target ? probe.rim.target[bin]! - (last.heights[bin] ?? 0) : null;
              report.maxFrameChangeDt = dt;
            }
          }
        }
        const ground = probe.rim.raw ? Array.from(probe.rim.raw) : null;
        for (let bin = 0; bin < now.heights.length; bin += 1) {
          const next = (bin + 1) % now.heights.length;
          const change = Math.abs(now.heights[bin]! - now.heights[next]!);
          report.maxNeighbourChange = Math.max(report.maxNeighbourChange, change);
          const step = ground ? Math.abs(ground[bin]! - ground[next]!) : 0;
          const allowed = Math.max(0.05 * report.heightY, step + 0.05);
          const target = probe.rim.target;
          report.pairs += 1;
          if (target) report.maxTargetNeighbourExcess = Math.max(report.maxTargetNeighbourExcess, Math.abs(target[bin]! - target[next]!) - allowed);
          if (target && (Math.abs(now.heights[bin]! - target[bin]!) > 0.02 || Math.abs(now.heights[next]! - target[next]!) > 0.02)) continue;
          report.settledPairs += 1;
          const excess = change - allowed;
          if (excess > report.maxNeighbourExcess) {
            report.maxNeighbourExcess = excess;
            report.maxNeighbourExcessBin = bin;
            report.maxNeighbourExcessPair = { at: now.time, rim: [now.heights[bin]!, now.heights[next]!], ground: ground ? [ground[bin]!, ground[next]!] : [] };
          }
        }
        last = now;
      }
      if (played < seconds && report.frames < seconds * 240) requestAnimationFrame(tick);
      else {
        report.meanFrameS = played / Math.max(report.frames - report.snaps, 1);
        done(report);
      }
    };
    requestAnimationFrame(tick);
  }), seconds);
}

export type GlassReport = { views: number; outside: number[]; drawn: number[]; images: string[]; worst: { metres: number; point: number[]; product: boolean | null; object: string | null } | null };

/**
 * The neighbour rule against the test's own raycast ground at one time:
 * neighbouring bins at most max(5% of the dome's height, the ground's step
 * between them + 5 cm) apart. The most any pair goes over (≤ 0 passes).
 */
export function snapshotNeighbourExcess(snapshot: RimSnapshot): { excess: number; bin: number } {
  let worst = { excess: -Infinity, bin: 0 };
  const bins = snapshot.bins;
  for (let bin = 0; bin < bins.length; bin += 1) {
    const a = bins[bin]!;
    const b = bins[(bin + 1) % bins.length]!;
    // Where there is no ground, or it lies under the foot or over the cap, the rim stands where its own rule puts it.
    const groundA = a.ground === null || a.belowFoot ? snapshot.footY : a.capped ? a.rim : a.ledge ?? a.ground;
    const groundB = b.ground === null || b.belowFoot ? snapshot.footY : b.capped ? b.rim : b.ledge ?? b.ground;
    const excess = Math.abs(a.rim - b.rim) - Math.max(0.05 * snapshot.heightY, Math.abs(groundA - groundB) + 0.05);
    if (excess > worst.excess) worst = { excess, bin };
  }
  return worst;
}

/** Several glass readings (one per time) as one. */
export function mergeGlass(reports: readonly GlassReport[]): GlassReport {
  return { views: reports.reduce((sum, r) => sum + r.views, 0), outside: reports.flatMap((r) => r.outside), drawn: reports.flatMap((r) => r.drawn), images: reports.flatMap((r) => r.images), worst: reports.reduce<GlassReport["worst"]>((w, r) => (r.worst && (!w || r.worst.metres > w.metres) ? r.worst : w), null) };
}

/**
 * Nothing outside the glass, on the GPU: from 24 orbit views around the dome
 * (pitches 12°, 30°, 55°), with every recorded surface writing depth (glass
 * and water too),
 * the recorded scene drawn as the feed draws it (its own clip; the avatar
 * left out), each drawn pixel's depth read back to the world point it shows,
 * and that point tested against the bent dome by the test's own reading of
 * the brief (lift per bin linearly filtered, w = smoothstep(bendFrom, 1, ρ),
 * y' = y + L·w·(1 − y/ry)). A point the dome holds may show below the
 * shell's lower edge, through its open floor; only a drawn point outside
 * the dome by more than a centimetre (across its floor or its wall) counts. With `control`, the same with the dome clip off (the
 * sphere's), to show the check can fail.
 */
export async function measureGlass(page: Page, { control = false, debugImages = false }: { control?: boolean; debugImages?: boolean } = {}): Promise<GlassReport> {
  return page.evaluate(async ({ control, debugImages }) => {
    const three = (await (window as unknown as { __HOLOIM_TEST_MODULES__: Promise<{ three: typeof Three }> }).__HOLOIM_TEST_MODULES__).three;
    const { WebGLRenderTarget, PerspectiveCamera, OrthographicCamera, ShaderMaterial, Mesh, PlaneGeometry, Scene, DepthTexture, FloatType, Vector3, Color } = three;
    const probe = (window as unknown as { __feedProbe: RimProbe }).__feedProbe;
    const { renderer, scene, model } = probe;
    const cloche = probe.cloche as { shape: { current: ClocheBase | null }; fitted: { current: Three.Vector3 | null } };
    const shape = cloche.shape.current;
    const sphere = model.getObjectByName("RecordedBubbleSphere");
    const heights = probe.rim.heights ? Array.from(probe.rim.heights) : [];
    if (!shape || !sphere || !cloche.fitted.current) throw new Error("no cloche");
    const shift = sphere.getWorldPosition(new Vector3()).sub(cloche.fitted.current);
    const base = new Vector3(shape.base.x, shape.base.y, shape.base.z).add(shift);
    const { radii, exponent: n } = shape;
    const BEND_FROM = 0.4;
    const lift = (angle: number) => {
      if (heights.length === 0) return 0;
      const f = (angle / (Math.PI * 2)) * heights.length - 0.5;
      const i0 = Math.floor(f);
      const t = f - i0;
      const at = (i: number) => heights[((i % heights.length) + heights.length) % heights.length]!;
      return at(i0) + (at(i0 + 1) - at(i0)) * t;
    };
    // Inside the bent dome, with a centimetre's give across each boundary (the depth read back, the half-float
    // heights): under the floor by 1 cm in the flat dome, which is at most 1 cm in the bent one, and out through
    // the wall by at most 1 cm anywhere: the dome scaled about its centre by give over its farthest reach
    // (no point of it is farther than the radii's diagonal), and the bent dome's floor only compresses it. Exactly, with `give` 0.
    const reach = Math.hypot(radii.x, radii.y, radii.z);
    const wallFor = (metres: number) => (1 + metres / reach) ** n;
    let give = 0.01;
    let wall = wallFor(give);
    const insideExact = (point: Three.Vector3) => {
      const qx = (point.x - base.x) / radii.x;
      const qz = (point.z - base.z) / radii.z;
      const rho = (Math.abs(qx) ** n + Math.abs(qz) ** n) ** (1 / n);
      const s = Math.min(Math.max((rho - BEND_FROM) / (1 - BEND_FROM), 0), 1);
      let angle = Math.atan2(qz, qx);
      if (angle < 0) angle += Math.PI * 2;
      const rise = lift(angle) * s * s * (3 - 2 * s);
      const y = point.y - base.y;
      const flat = y >= radii.y ? y : (y - rise) / (1 - rise / radii.y);
      if (flat < -give) return false;
      return Math.abs(qx) ** n + Math.abs(flat / radii.y) ** n + Math.abs(qz) ** n <= wall;
    };
    const centre = base.clone().add(new Vector3(0, radii.y / 2, 0));
    const inside = insideExact;
        const wider = Math.max(radii.x, radii.y, radii.z);
    const size = 256;
    const target = new WebGLRenderTarget(size, size);
    target.depthTexture = new DepthTexture(size, size);
    const depthCopy = new WebGLRenderTarget(size, size, { type: FloatType });
    const copyScene = new Scene();
    const copyMaterial = new ShaderMaterial({
      uniforms: { tDepth: { value: target.depthTexture } },
      vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: "uniform sampler2D tDepth; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tDepth, vUv).x, 0.0, 0.0, 1.0); }",
      depthTest: false,
      depthWrite: false
    });
    const copyPlane = new PlaneGeometry(2, 2);
    copyScene.add(new Mesh(copyPlane, copyMaterial));
    const copyCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const visibility = new Map<Three.Object3D, boolean>();
    scene.traverse((node) => visibility.set(node, node.visible));
    const previousTarget = renderer.getRenderTarget();
    const previousBackground = scene.background;
    const previousClear = renderer.getClearColor(new Color());
    const previousAlpha = renderer.getClearAlpha();
    const sceneBubble = model.getObjectByName("RecordedSceneBubble")!;
    const avatar = model.getObjectByName("RecordedAvatar");
    const within = (node: Three.Object3D, root: Three.Object3D | undefined) => {
      for (let at: Three.Object3D | null = node; at; at = at.parent) if (at === root) return true;
      return false;
    };
    const dome = (probe as unknown as { dome?: { u_domeOn: { value: number } } }).dome;
    const outside: number[] = [];
    const drawn: number[] = [];
    const images: string[] = [];
    const saved = control && dome ? dome.u_domeOn.value : null;
    const depthWrites = new Map<Three.Material, boolean>();
    let worst: { metres: number; point: number[]; product: boolean | null; object: string | null } | null = null;
    try {
      scene.background = null;
      scene.traverse((node) => {
        if (!(node as Three.Mesh).isMesh && !(node as Three.Points).isPoints) return;
        node.visible = within(node, sceneBubble) && !within(node, avatar) && visibility.get(node) === true;
        // Surfaces drawn without depth (glass, water) are read back too.
        if (!node.visible) return;
        const materials = (node as Three.Mesh).material;
        for (const material of Array.isArray(materials) ? materials : [materials]) {
          if (!depthWrites.has(material)) depthWrites.set(material, material.depthWrite);
          material.depthWrite = true;
        }
      });
      if (control && dome) dome.u_domeOn.value = 0;
      const depth = new Float32Array(size * size * 4);
      const point = new Vector3();
      for (const pitch of [12, 30, 55]) {
        for (let yaw = 0; yaw < 360; yaw += 45) {
          const camera = new PerspectiveCamera(40, 1, wider * 0.5, wider * 8);
          const p = (pitch * Math.PI) / 180;
          const y = (yaw * Math.PI) / 180;
          camera.position.copy(centre).add(new Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)).multiplyScalar(wider * 3.2));
          camera.lookAt(centre);
          camera.updateMatrixWorld();
          renderer.setRenderTarget(target);
          renderer.setClearColor(0, 0);
          renderer.clear();
          renderer.render(scene, camera);
          renderer.setRenderTarget(depthCopy);
          renderer.render(copyScene, copyCamera);
          renderer.readRenderTargetPixels(depthCopy, 0, 0, size, size, depth);
          let count = 0;
          let total = 0;
          const marks = debugImages ? new Uint8Array(size * size) : null;
          for (let j = 0; j < size; j += 1) {
            for (let i = 0; i < size; i += 1) {
              const d = depth[(j * size + i) * 4]!;
              if (d >= 1) continue;
              total += 1;
              point.set(((i + 0.5) / size) * 2 - 1, ((j + 0.5) / size) * 2 - 1, d * 2 - 1).unproject(camera);
              const out = !inside(point);
              if (out) {
                count += 1;
                // How far outside: the smallest give, in centimetres (50 cm at most), that holds it.
                const held = give;
                let metres = held;
                do {
                  metres += 0.01;
                  give = metres;
                  wall = wallFor(metres);
                } while (metres < 0.5 && !insideExact(point));
                give = held;
                wall = wallFor(held);
                if (!worst || metres > worst.metres) {
                  const caster = new three.Raycaster();
                  caster.setFromCamera(new three.Vector2(((i + 0.5) / size) * 2 - 1, ((j + 0.5) / size) * 2 - 1), camera);
                  const hit = caster.intersectObject(sceneBubble, true).find((h) => h.object.visible);
                  const names: string[] = [];
                  for (let node: Three.Object3D | null = hit?.object ?? null; node && node !== sceneBubble; node = node.parent) names.push(node.name || node.type);
                  worst = { metres, point: point.toArray(), product: (probe.rim as { insideDome?: ((p: Three.Vector3) => boolean | null) | null }).insideDome?.(point) ?? null, object: hit ? `${names.join(" < ")} @${hit.distance.toFixed(3)} vs ${point.distanceTo(camera.position).toFixed(3)}` : null };
                }
              }
              if (marks) marks[j * size + i] = out ? 2 : 1;
            }
          }
          outside.push(count);
          drawn.push(total);
          if (marks && count > 0) {
            // The view as an image: the drawn scene grey, drawn points outside the dome red.
            const canvas = document.createElement("canvas");
            canvas.width = size; canvas.height = size;
            const pixels = new ImageData(size, size);
            for (let j = 0; j < size; j += 1) for (let i = 0; i < size; i += 1) {
              const mark = marks[j * size + i]!;
              pixels.data.set([...(mark === 2 ? [255, 0, 0] : mark === 1 ? [150, 150, 150] : [10, 10, 10]), 255], ((size - 1 - j) * size + i) * 4);
            }
            canvas.getContext("2d")!.putImageData(pixels, 0, 0);
            images.push(canvas.toDataURL("image/png").split(",")[1]!);
          }
        }
      }
      return { views: outside.length, outside, drawn, images, worst };
    } finally {
      if (saved !== null && dome) dome.u_domeOn.value = saved;
      copyMaterial.dispose();
      copyPlane.dispose();
      for (const [material, was] of depthWrites) material.depthWrite = was;
      target.depthTexture?.dispose();
      target.dispose();
      depthCopy.dispose();
      scene.traverse((node) => { const was = visibility.get(node); if (was !== undefined) node.visible = was; });
      scene.background = previousBackground;
      renderer.setClearColor(previousClear, previousAlpha);
      renderer.setRenderTarget(previousTarget);
    }
  }, { control, debugImages });
}
