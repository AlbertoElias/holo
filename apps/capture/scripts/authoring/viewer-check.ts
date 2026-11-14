/**
 * Plays a directed take in viewer-web, as a viewer would see it, and reads
 * back what the viewer's mixer does with it: per performer, how many bones,
 * finger bones and face influences move across the take, and which
 * performer holds the bones the viewer resolved as the humanoid (its anchors
 * for the scene origin, framing focus and hand traces; it should be only
 * `RecordedAvatar`).
 *
 *   node --conditions=development --import tsx scripts/authoring/viewer-check.ts <take.glb> [--video out.mp4] [--frames dir] [--report out.json]
 *
 * Starts its own test API and viewer test build on ports away from the
 * defaults (VIEWER_CHECK_API_PORT 3341, VIEWER_CHECK_WEB_PORT 3214), so it
 * runs beside another agent's servers. `--video` records the card playing in
 * real time and encodes H.264 with ffmpeg; `--frames` saves twelve paused
 * stills at exact take times, framed on the cast.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';

import { openTake, startViewer, tempDir } from './lib/viewer-session.ts';
const FINGER = /thumb|index|middle|ring|little|pinky/i;
// The tags viewer-web puts on the humanoid it resolved (apps/viewer-web/src/features/hologram/humanoidAnchors.ts).
const HUMANOID_BONE_TAG = 'holoimHumanoidBone';
const HUMANOID_SOURCE_TAG = 'holoimHumanoidSource';

export interface PerformerReading {
  readonly name: string;
  readonly bones: number;
  readonly bonesMoving: number;
  readonly fingerBones: number;
  readonly fingerBonesMoving: number;
  readonly morphTargets: number;
  readonly morphTargetsMoving: number;
  /** Largest face influence anywhere in the take. */
  readonly peakInfluence: number;
  /** Centre of the performer's bounds in the card's normalised screen space at t = 0 (−1..1). */
  /** Bones the viewer resolved as the hologram's humanoid (its anchors for origin, framing focus and hand traces) inside this performer. */
  readonly anchoredBones: number;
}

export interface ViewerReading {
  readonly take: string;
  readonly duration: number;
  readonly samples: number;
  /** How the viewer resolved the humanoid: a declaration format, `names` when found by bone names, `none`. */
  readonly anchorSource: string;
  readonly performers: PerformerReading[];
}

export async function read(page: Page, url: string): Promise<ViewerReading> {
  return page.evaluate(([target, fingerSource, boneTag, sourceTag]) => {
    const fingerRe = new RegExp(fingerSource, 'i');
    type Obj = {
      name: string; type: string; isBone?: boolean; isMesh?: boolean; parent: Obj | null;
      quaternion: { x: number; y: number; z: number; w: number };
      morphTargetInfluences?: number[];
      children: Obj[];
      traverse(cb: (o: Obj) => void): void;
      updateWorldMatrix(p: boolean, c: boolean): void;
    };
    type Probe = { model: Obj; camera: unknown; mixer: { update(d: number): void }; actions: Record<string, { time: number; getClip(): { duration: number } } | null> };
    const probes = (window as unknown as { __feedProbes: Record<string, Probe> }).__feedProbes;
    const probe = Object.entries(probes).find(([u]) => u.endsWith(target))![1];
    const actions = Object.values(probe.actions).filter((a): a is NonNullable<typeof a> => Boolean(a));
    const duration = Math.max(...actions.map((a) => a.getClip().duration));
    const wrappers: Obj[] = [];
    probe.model.traverse((o) => { if (o.name === 'RecordedAvatar' || o.name.startsWith('Performer_')) wrappers.push(o); });
    const seek = (t: number) => { for (const a of actions) a.time = t; probe.mixer.update(0); probe.model.updateWorldMatrix(true, true); };
    const times = Array.from({ length: 33 }, (_, i) => (duration * i) / 32);
    const per = wrappers.map((w) => {
      const bones: Obj[] = [];
      const meshes: Obj[] = [];
      w.traverse((o) => { if (o.isBone) bones.push(o); if (o.isMesh && o.morphTargetInfluences?.length) meshes.push(o); });
      return { w, bones, meshes, q: bones.map(() => [] as number[][]), m: meshes.map(() => [] as number[][]) };
    });
    for (const t of times) {
      seek(t);
      for (const p of per) {
        p.bones.forEach((b, i) => p.q[i]!.push([b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]));
        p.meshes.forEach((m, i) => p.m[i]!.push([...m.morphTargetInfluences!]));
      }
    }
    // The viewer tags the bones it resolved as the humanoid, and the scene with how (humanoidAnchors.ts).
    const tagged = (o: Obj) => typeof (o as unknown as { userData: Record<string, unknown> }).userData?.[boneTag] === 'string';
    let anchorSource: unknown;
    for (let o: Obj | null = probe.model; o && anchorSource === undefined; o = o.parent) anchorSource = (o as unknown as { userData: Record<string, unknown> }).userData?.[sourceTag];
    const moved = (series: number[][], eps: number) => series.some((s) => s.some((v, j) => Math.abs(v - series[0]![j]!) > eps));
    const performers = per.map((p) => {
      const fingers = p.bones.map((b, j) => [b, j] as const).filter(([b]) => fingerRe.test(b.name));
      let morphTargets = 0, morphMoving = 0, peak = 0;
      p.m.forEach((series) => {
        const width = series[0]!.length;
        morphTargets += width;
        for (let j = 0; j < width; j += 1) {
          const col = series.map((s) => s[j]!);
          if (col.some((v) => Math.abs(v - col[0]!) > 0.01)) morphMoving += 1;
          peak = Math.max(peak, ...col);
        }
      });
      return {
        name: p.w.name,
        bones: p.bones.length,
        bonesMoving: p.q.filter((s) => moved(s, 1e-3)).length,
        fingerBones: fingers.length,
        fingerBonesMoving: fingers.filter(([, j]) => moved(p.q[j]!, 1e-3)).length,
        morphTargets,
        morphTargetsMoving: morphMoving,
        peakInfluence: Math.round(peak * 1000) / 1000,
        anchoredBones: p.bones.filter(tagged).length
      };
    });
    seek(0);
    return { take: target, duration, samples: times.length, anchorSource: String(anchorSource), performers };
  }, [url, FINGER.source, HUMANOID_BONE_TAG, HUMANOID_SOURCE_TAG] as const);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const videoOut = flag('--video');
  const reportOut = flag('--report');
  const framesOut = flag('--frames');
  const file = args[0];
  if (!file) { console.error('usage: viewer-check.ts <take.glb> [--video out.mp4] [--frames dir] [--report out.json]'); process.exit(2); }
  const videoDir = videoOut ? await tempDir('viewer-check-') : undefined;
  const servers = await startViewer();
  try {
    const open = await openTake(servers, file, { viewport: { width: 900, height: 900 }, ...(framesOut ? { deviceScaleFactor: 2 } : {}), ...(videoDir ? { recordVideoDir: videoDir.path } : {}) });
    const { page, card } = open;
    const uploaded = { id: open.id, url: open.url };
    const result = await read(page, uploaded.url);
    const shot = resolve(`${file.replace(/\.glb$/, '')}-viewer.png`);
    await card.screenshot({ path: shot });
    if (framesOut) {
      // Twelve stills at exact take times, paused, framed on the cast: what a critic is shown.
      await mkdir(framesOut, { recursive: true });
      const box = (await card.boundingBox())!;
      const clip = { x: box.x + box.width * 0.27, y: box.y + box.height * 0.22, width: box.width * 0.46, height: box.height * 0.4 };
      for (let i = 0; i < 12; i += 1) {
        const t = (result.duration * i) / 12;
        await page.evaluate(([u, time]) => {
          const p = Object.entries((window as unknown as { __feedProbes: Record<string, { mixer: { update(d: number): void }; actions: Record<string, { time: number; paused: boolean } | null> }> }).__feedProbes).find(([k]) => k.endsWith(u))![1];
          for (const a of Object.values(p.actions)) if (a) { a.paused = true; a.time = time; }
          p.mixer.update(0);
          return new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        }, [uploaded.url, t] as const);
        await page.screenshot({ path: join(framesOut, `t${t.toFixed(2).padStart(5, '0')}.png`), clip });
      }
      await page.evaluate((u) => {
        const p = Object.entries((window as unknown as { __feedProbes: Record<string, { actions: Record<string, { paused: boolean } | null> }> }).__feedProbes).find(([k]) => k.endsWith(u))![1];
        for (const a of Object.values(p.actions)) if (a) a.paused = false;
      }, uploaded.url);
    }
    if (videoOut) {
      // Let the card play the whole take once more from the start, in real time.
      await page.evaluate((u) => {
        const p = Object.entries((window as unknown as { __feedProbes: Record<string, { actions: Record<string, { time: number } | null> }> }).__feedProbes).find(([k]) => k.endsWith(u))![1];
        for (const a of Object.values(p.actions)) if (a) a.time = 0;
      }, uploaded.url);
      await new Promise((r) => setTimeout(r, (result.duration + 1) * 1000)); // wall-clock: the proof video records playback in real time.
    }
    const video = page.video();
    await open.close();
    if (videoOut && video) {
      const webm = await video.path();
      const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', `${videoOut}.tmp.mp4`]);
      if (enc.status !== 0) throw new Error(`ffmpeg: ${enc.stderr.toString()}`);
      await rename(`${videoOut}.tmp.mp4`, videoOut);
    }
    console.log(`${basename(file)} in viewer-web: ${result.samples} samples over ${result.duration.toFixed(2)} s, humanoid resolved by ${result.anchorSource}`);
    for (const p of result.performers) {
      console.log(`  ${p.name}: bones ${p.bonesMoving}/${p.bones} move, fingers ${p.fingerBonesMoving}/${p.fingerBones}, face ${p.morphTargetsMoving}/${p.morphTargets} targets (peak ${p.peakInfluence}), ${p.anchoredBones} anchor bones`);
    }
    console.log(`  card: ${shot}`);
    if (reportOut) await writeFile(reportOut, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    servers.close();
    if (videoDir) await videoDir.remove();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
