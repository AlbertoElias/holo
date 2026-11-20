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
 * stills at exact take times, framed on the cast. `--audio out.webm` records
 * what the card sends to its speakers over one real-time pass (a take
 * without sound fails it) and finds where each `KHR_audio` source is heard,
 * against where the file puts it; with `--video` the recording becomes the
 * video's soundtrack. `--captions` reads the caption the muted card shows on
 * every frame of one real-time pass against the file's `HOLOIM_captions`
 * cues (run before `--audio`, which unmutes); with `--audio` too, each cue's
 * start is checked against where the voice is heard.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { activeCue, primaryTrack, type CaptionCue } from '@holoim/contracts';

import { readCaptions } from './lib/captions.ts';
import { envelopeOf, voicedSpans } from './lib/lips.ts';
import { ffmpegPath } from './lib/sound.ts';
import { speechReport } from './speech-report.ts';
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
  /** The recorded objects the viewer loaded (`RecordedObject` wrappers): their credit and whether the take moves them. */
  readonly objects: ObjectReading[];
  /** What the card was heard to play (`--audio`). */
  readonly heard?: HeardReading;
  /** The captions the muted card showed (`--captions`). */
  readonly captions?: CaptionsReading;
}

/** A frame at most this far from a cue's edge may show either side (s): the card sets its caption the frame after the clock. */
const CAPTION_EDGE_S = 0.1;
/** The most a caption edge may trail the clock, and a cue's start the heard voice (ms), as the sound bar. */
const CAPTION_SYNC_MS = 100;

export interface CaptionsReading {
  readonly language: string | null;
  readonly cues: CaptionCue[];
  /** Frames sampled over one pass, and those that showed other than the cue the clock was in (away from an edge). */
  readonly frames: number;
  readonly wrongFrames: { t: number; shown: string; expected: string }[];
  /** For each cue, how long after the first frame drawn past its start and end the card showed and cleared it (ms; 0 is that frame). */
  readonly edges: { text: string; showLagMs: number | null; hideLagMs: number | null }[];
  /** Wall clock (ms) and take time when the pass began, to place it in a recording. */
  readonly passStartedAt: number;
  readonly passTakeTime: number;
  /** Each cue's start against the nearest heard voice onset (`--audio`). */
  readonly voice?: { text: string; from: number; heardOnset: number | null; deltaMs: number | null }[];
}

export interface HeardReading {
  /** Seconds recorded, and the take's motion and lead sound clocks when recording began. */
  readonly seconds: number;
  /** When recording began (Date.now ms), on the same clock as the captions pass's `passStartedAt`. */
  readonly startedAt?: number;
  readonly motionAt: number;
  readonly soundAt: number | null;
  /** Sounding stretches of the recording, in take time. */
  readonly spans: { start: number; end: number }[];
  /** Each file source's first sound and the nearest heard onset (take time), and how far apart (ms). */
  readonly sources: { name: string; fileOnset: number | null; heardOnset: number | null; deltaMs: number | null }[];
}

export interface ObjectReading {
  readonly name: string;
  readonly credit: string | null;
  readonly moves: boolean;
  readonly meshes: number;
}

export async function read(page: Page, url: string): Promise<ViewerReading> {
  return page.evaluate(([target, fingerSource, boneTag, sourceTag]) => {
    const fingerRe = new RegExp(fingerSource, 'i');
    type Obj = {
      name: string; type: string; isBone?: boolean; isMesh?: boolean; parent: Obj | null;
      quaternion: { x: number; y: number; z: number; w: number };
      position: { x: number; y: number; z: number };
      userData: Record<string, unknown>;
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
    const things: Obj[] = [];
    probe.model.traverse((o) => {
      if (o.name === 'RecordedAvatar' || o.name.startsWith('Performer_')) wrappers.push(o);
      else if (o.name === 'RecordedObject' || o.name.startsWith('RecordedObject_')) things.push(o);
    });
    const thingPoses = things.map(() => [] as number[][]);
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
      things.forEach((o, i) => thingPoses[i]!.push([o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]));
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
    const objects = things.map((o, i) => {
      let meshes = 0;
      o.traverse((c) => { if (c.isMesh) meshes += 1; });
      const credit = o.userData?.holoimCredit as { title?: string; author?: string; licence?: string } | undefined;
      return { name: o.name, credit: credit ? `${credit.title} by ${credit.author} (${credit.licence})` : null, moves: moved(thingPoses[i]!, 1e-4), meshes };
    });
    seek(0);
    return { take: target, duration, samples: times.length, anchorSource: String(anchorSource), performers, objects };
  }, [url, FINGER.source, HUMANOID_BONE_TAG, HUMANOID_SOURCE_TAG] as const);
}

/** One real-time pass of the muted card, from its clip's start to its wrap: the take time and the caption shown, every frame. */
async function watchCaptions(page: Page, url: string, file: string): Promise<CaptionsReading> {
  const track = primaryTrack(readCaptions(new Uint8Array(await readFile(file))));
  const pass = await page.evaluate((u) => new Promise<{ startedAt: number; samples: { t: number; caption: string }[] }>((done, fail) => {
    const p = Object.entries((window as unknown as { __feedProbes: Record<string, { actions: Record<string, { time: number } | null> }> }).__feedProbes).find(([k]) => k.endsWith(u))![1];
    const region = document.querySelector<HTMLElement>('[data-testid=card-caption]');
    const samples: { t: number; caption: string }[] = [];
    let startedAt = 0; let frames = 0;
    const step = () => {
      frames += 1;
      if (frames > 60 * 120) return fail(new Error('no full pass of the clip'));
      const t = Object.values(p.actions).find((a) => a)?.time ?? -1;
      if (!startedAt && t >= 0 && t < 0.3) startedAt = Date.now();
      if (startedAt) {
        if (samples.length && t < samples[samples.length - 1]!.t) return done({ startedAt, samples });
        samples.push({ t, caption: region?.dataset.caption ?? '<no caption region>' });
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), url);
  const cues = track?.cues ?? [];
  const near = (t: number) => cues.some((c) => Math.abs(t - c.from) < CAPTION_EDGE_S || Math.abs(t - c.to) < CAPTION_EDGE_S);
  const wrongFrames = pass.samples
    .map((s) => ({ t: s.t, shown: s.caption, expected: activeCue(track, s.t)?.text ?? '' }))
    .filter((s) => !near(s.t) && s.shown !== s.expected);
  // Late by how long after the first frame drawn past the edge: the frame rate alone (a loaded machine draws a few a second) is not lag.
  const lag = (at: number, ok: (caption: string) => boolean) => {
    const first = pass.samples.find((s) => s.t >= at);
    const hit = pass.samples.find((s) => s.t >= at && ok(s.caption));
    return first && hit ? Math.round((hit.t - first.t) * 1000) : null;
  };
  const edges = cues.filter((c) => c.kind === 'speech').map((c) => ({ text: c.text, showLagMs: lag(c.from, (x) => x === c.text), hideLagMs: c.to >= (pass.samples.at(-1)?.t ?? 0) ? 0 : lag(c.to, (x) => x !== c.text) }));
  return { language: track?.language ?? null, cues, frames: pass.samples.length, wrongFrames, edges, passStartedAt: pass.startedAt, passTakeTime: pass.samples[0]?.t ?? 0 };
}

/** Where the recording sounds, in take time, against where each source in the file first sounds. */
async function hear(file: string, recording: string, motionAt: number, soundAt: number | null, duration: number): Promise<HeardReading> {
  const RATE = 16000;
  const r = spawnSync(ffmpegPath(), ['-v', 'error', '-i', recording, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`decode the recording: ${r.stderr.toString()}`);
  const pcm = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
  // The sound clock is what the card plays by; motion runs beside it.
  const from = soundAt ?? motionAt;
  const take = (t: number): number => (from + t) % duration;
  const spans = voicedSpans(envelopeOf(pcm, RATE)).map((sp) => ({ start: take(sp.start), end: take(sp.start) + (sp.end - sp.start) }));
  const report = await speechReport(file);
  const sources = report.sources.map((src) => {
    const onset = src.onset;
    if (onset === null || !spans.length) return { name: src.name, fileOnset: onset, heardOnset: null, deltaMs: null };
    const near = spans.reduce((best, sp) => (Math.abs(sp.start - onset) < Math.abs(best.start - onset) ? sp : best));
    return { name: src.name, fileOnset: onset, heardOnset: near.start, deltaMs: Math.round((near.start - onset) * 1000) };
  });
  return { seconds: pcm.length / RATE, motionAt, soundAt, spans, sources };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const videoOut = flag('--video');
  const reportOut = flag('--report');
  const framesOut = flag('--frames');
  const audioOut = flag('--audio');
  const captionsOn = args.includes('--captions');
  if (captionsOn) args.splice(args.indexOf('--captions'), 1);
  const file = args[0];
  if (!file) { console.error('usage: viewer-check.ts <take.glb> [--video out.mp4] [--frames dir] [--audio out.webm] [--captions] [--report out.json]'); process.exit(2); }
  const videoDir = videoOut ? await tempDir('viewer-check-') : undefined;
  const servers = await startViewer();
  try {
    const open = await openTake(servers, file, { viewport: { width: 900, height: 900 }, ...(framesOut ? { deviceScaleFactor: 2 } : {}), ...(videoDir ? { recordVideoDir: videoDir.path } : {}), ...(audioOut ? { recordAudio: true } : {}) });
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
    // The feed starts muted, so the captions pass comes first; `--audio` unmutes after it.
    let captions: CaptionsReading | undefined = captionsOn ? await watchCaptions(page, uploaded.url, file) : undefined;
    let heard: HeardReading | undefined;
    let heardStartedAt = 0;
    if (audioOut) {
      // Hear one real-time pass as the card plays it. The feed starts muted, so press the card's own control, as a viewer would.
      // Motion is not reset: the card's sound keeps its own clock, so a seek would split them.
      // The controls unfold when a pointer comes near (as apps/viewer-web/e2e/bootstrap.ts reachFor does).
      await card.locator('.feed-card-portal').hover({ force: true, position: { x: 40, y: 40 } });
      await page.waitForFunction((id) => document.querySelector(`.feed-card[data-card-id="${id}"] .portal-controls`)?.getAttribute('data-reach') === 'shown', open.id, { timeout: 5_000 });
      await card.getByRole('button', { name: 'Unmute audio' }).click();
      await card.getByRole('button', { name: 'Mute audio' }).waitFor({ timeout: 5_000 });
      const ready = await page.waitForFunction(() => (window as unknown as { __heard?: { ready(): boolean } }).__heard?.ready(), null, { timeout: 15_000 }).then(() => true, () => false);
      if (!ready) throw new Error('the card sent nothing to its speakers: no sound to hear');
      const at = await page.evaluate((u) => {
        type Voices = { readVoices(): { offset: number | null }[] };
        const p = Object.entries((window as unknown as { __feedProbes: Record<string, { actions: Record<string, { time: number } | null>; sound?: { current: Voices | null } }> }).__feedProbes).find(([k]) => k.endsWith(u))![1];
        const startedAt = (window as unknown as { __heard: { start(): number } }).__heard.start();
        const motion = Object.values(p.actions).find((a) => a)?.time ?? 0;
        const voices = p.sound?.current?.readVoices() ?? [];
        return { startedAt, motion, sound: voices[0]?.offset ?? null };
      }, uploaded.url);
      heardStartedAt = at.startedAt;
      await new Promise((r) => setTimeout(r, (result.duration + 1) * 1000)); // wall-clock: what the card plays is heard in real time.
      const { base64 } = await page.evaluate(() => (window as unknown as { __heard: { stop(): Promise<{ base64: string }> } }).__heard.stop());
      await writeFile(audioOut, Buffer.from(base64, 'base64'));
      heard = { ...(await hear(file, audioOut, at.motion, at.sound, result.duration)), startedAt: at.startedAt };
      if (captions) {
        const spans = heard.spans;
        captions = { ...captions, voice: captions.cues.map((c) => {
          if (!spans.length) return { text: c.text, from: c.from, heardOnset: null, deltaMs: null };
          const nearest = spans.reduce((best, sp) => (Math.abs(sp.start - c.from) < Math.abs(best.start - c.from) ? sp : best));
          return { text: c.text, from: c.from, heardOnset: nearest.start, deltaMs: Math.round((nearest.start - c.from) * 1000) };
        }) };
      }
    } else if (videoOut) {
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
      // With `--audio`, what the card played is the soundtrack, placed where its recording began in the page's video.
      const sound = audioOut ? ['-itsoffset', String((heardStartedAt - open.openedAt) / 1000), '-i', audioOut, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '160k'] : [];
      const enc = spawnSync(audioOut ? ffmpegPath() : 'ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, ...sound, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', `${videoOut}.tmp.mp4`]);
      if (enc.status !== 0) throw new Error(`ffmpeg: ${enc.stderr.toString()}`);
      await rename(`${videoOut}.tmp.mp4`, videoOut);
    }
    console.log(`${basename(file)} in viewer-web: ${result.samples} samples over ${result.duration.toFixed(2)} s, humanoid resolved by ${result.anchorSource}`);
    for (const p of result.performers) {
      console.log(`  ${p.name}: bones ${p.bonesMoving}/${p.bones} move, fingers ${p.fingerBonesMoving}/${p.fingerBones}, face ${p.morphTargetsMoving}/${p.morphTargets} targets (peak ${p.peakInfluence}), ${p.anchoredBones} anchor bones`);
    }
    for (const o of result.objects) console.log(`  ${o.name}: ${o.meshes} mesh(es), ${o.moves ? 'moves' : 'still'}, credit ${o.credit ?? 'none'}`);
    if (heard) {
      console.log(`  heard ${heard.seconds.toFixed(1)} s from take time ${heard.motionAt.toFixed(2)} s (sound clock ${heard.soundAt?.toFixed(2) ?? '-'} s): sounding ${heard.spans.map((sp) => `${sp.start.toFixed(2)}-${sp.end.toFixed(2)}`).join(', ') || 'never'}`);
      for (const h of heard.sources) console.log(`  ${h.name}: in the file from ${h.fileOnset?.toFixed(2) ?? '-'} s, heard from ${h.heardOnset?.toFixed(2) ?? '-'} s (${h.deltaMs ?? '-'} ms)`);
    }
    if (captions) {
      console.log(`  captions (${captions.language ?? 'none'}): ${captions.cues.length} cues, ${captions.frames} frames, ${captions.wrongFrames.length} showed the wrong caption`);
      for (const e of captions.edges) console.log(`  "${e.text}": shown ${e.showLagMs ?? '-'} ms after the first frame past its start, cleared ${e.hideLagMs ?? '-'} ms after the first past its end`);
      for (const v of captions.voice ?? []) console.log(`  "${v.text}" from ${v.from.toFixed(2)} s, voice heard from ${v.heardOnset?.toFixed(2) ?? '-'} s (${v.deltaMs ?? '-'} ms)`);
    }
    console.log(`  card: ${shot}`);
    if (reportOut) await writeFile(reportOut, `${JSON.stringify({ ...result, ...(heard ? { heard } : {}), ...(captions ? { captions } : {}) }, null, 2)}\n`);
    if (captions) {
      const late = captions.edges.some((e) => e.showLagMs === null || e.showLagMs > CAPTION_SYNC_MS || e.hideLagMs === null || e.hideLagMs > CAPTION_SYNC_MS);
      const offVoice = (captions.voice ?? []).some((v) => v.deltaMs === null || Math.abs(v.deltaMs) > CAPTION_SYNC_MS);
      if (!captions.cues.length || captions.wrongFrames.length || late || offVoice) { console.error('the card\'s captions are not the file\'s, in time with the clock and the voice'); process.exitCode = 1; }
    }
    if (heard && heard.sources.some((h) => h.deltaMs === null || Math.abs(h.deltaMs) > 100)) { console.error('a sound in the file was not heard where the file puts it'); process.exitCode = 1; }
  } finally {
    servers.close();
    if (videoDir) await videoDir.remove();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
