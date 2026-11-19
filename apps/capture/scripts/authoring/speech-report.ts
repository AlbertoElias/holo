/**
 * What a take with sound plays, read from the GLB alone (sound brief slice
 * 1a): each `KHR_audio` source decoded with ffmpeg as embedded (its length
 * against the clip, where its sound starts), and the mouth measured from the
 * face's morph-target animation in millimetres, against the voice's own
 * envelope: when the mouth starts and stops moving for each phrase, whether
 * it rests in the voice's pauses, and how closely it follows the loudness.
 *
 *   node --conditions=development --import tsx scripts/authoring/speech-report.ts <take.glb> [--json out.json]
 *
 * Bars, written before the first measurement: every padded source within
 * one frame of the clip; each phrase's mouth onset within ±80 ms of its sound
 * (the mouth may lead); in the voice's pauses of 0.25 s or more the mouth
 * moves less than 15 % of its speaking level; and the mouth follows the
 * loudness with a correlation of at least 0.4.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseGlb, readAccessor, readChannels, sampleChannel, targetNames, type GltfDoc } from './lib/gltf-read.ts';
import { envelopeOf, FRAME, PAUSE, voicedSpans } from './lib/lips.ts';
import { ffmpegPath } from './lib/sound.ts';

const RATE = 16000;
export const BARS = { paddedFrames: 1, onsetMs: 80, restShare: 0.15, correlation: 0.4, pause: 0.25 } as const;

interface KhrAudio { audio: { bufferView: number; mimeType: string }[]; sources: { name?: string; audio: number; loop?: boolean }[]; emitters: { name?: string; sources: number[] }[] }

export interface SourceReport { name: string; node: number | null; loop: boolean; bytes: number; seconds: number; clip: number; onset: number | null; spans: { start: number; end: number }[] }
export interface PhraseReport { start: number; end: number; mouthOn: number | null; mouthOff: number | null; leadMs: number | null; lagOffMs: number | null }
export interface SpeechReport {
  file: string;
  clip: number;
  fps: number;
  sources: SourceReport[];
  voice: string | null;
  mouth: { speakingP90Mm: number; phrases: PhraseReport[]; pauses: { start: number; end: number; p95Mm: number; share: number }[]; outsideShare: number; correlation: number; series: { t: number; mm: number; env: number }[] };
  /** With the sheet beside the take (`<take>.beats.json`): each spoken line's first sound against its beat (plus delay). */
  cues: { source: string; cue: number; onset: number | null; ms: number | null }[] | null;
  pass: { padded: boolean; onsets: boolean; rest: boolean; correlation: boolean; cues: boolean; all: boolean };
}

/**
 * Mouth opening per frame (mm): on each face mesh, the vertices the mesh's own
 * opening shape moves (`jawOpen`, else `mouthOpen`, else `viseme_aa`), and how
 * far the animated morph weights move them along that shape's direction,
 * weighted by how far the shape moves each. A smile or a frown moves the lips
 * sideways and barely registers; only an open mouth does.
 */
function mouthSeries(doc: GltfDoc, times: number[]): Float64Array {
  const json = doc.json as GltfDoc['json'] & { nodes: { mesh?: number }[] };
  const out = new Float64Array(times.length);
  for (const ch of readChannels(doc).filter((c) => c.path === 'weights')) {
    const meshIndex = json.nodes[ch.node]?.mesh;
    if (meshIndex === undefined) continue;
    const names = targetNames(doc, meshIndex);
    const opening = ['jawOpen', 'mouthOpen', 'viseme_aa'].map((n) => names.indexOf(n)).find((i) => i >= 0);
    if (opening === undefined) continue;
    const prim = doc.json.meshes![meshIndex]!.primitives[0]!;
    const targets = (prim.targets ?? []) as { POSITION?: number }[];
    const deltas = targets.map((t) => (t.POSITION === undefined ? null : readAccessor(doc, t.POSITION).data));
    const open = deltas[opening];
    if (!open) continue;
    const region: { v: number; ux: number; uy: number; uz: number; len: number }[] = [];
    for (let v = 0; v < open.length / 3; v += 1) {
      const len = Math.hypot(open[v * 3]!, open[v * 3 + 1]!, open[v * 3 + 2]!);
      if (len > 0.002) region.push({ v, ux: open[v * 3]! / len, uy: open[v * 3 + 1]! / len, uz: open[v * 3 + 2]! / len, len });
    }
    if (!region.length) continue;
    const total = region.reduce((s, r) => s + r.len, 0);
    const w = new Float64Array(ch.width);
    times.forEach((t, f) => {
      sampleChannel(ch, t, w);
      let sum = 0;
      for (const r of region) {
        let along = 0;
        for (let k = 0; k < w.length; k += 1) {
          const d = deltas[k];
          if (!d || !w[k]) continue;
          along += w[k]! * (d[r.v * 3]! * r.ux + d[r.v * 3 + 1]! * r.uy + d[r.v * 3 + 2]! * r.uz);
        }
        sum += Math.max(0, along) * r.len;
      }
      out[f] = Math.max(out[f]!, (sum / total) * 1000);
    });
  }
  return out;
}

const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0; };

export async function speechReport(file: string): Promise<SpeechReport> {
  const doc = parseGlb(new Uint8Array(await readFile(file)));
  const json = doc.json as GltfDoc['json'] & { nodes: { extensions?: { KHR_audio?: { emitter: number } } }[]; extensions?: { KHR_audio?: KhrAudio }; bufferViews: { byteOffset?: number; byteLength: number }[] };
  const khr = json.extensions?.KHR_audio;
  const channels = readChannels(doc);
  const clip = Math.max(...channels.map((c) => c.times[c.times.length - 1] ?? 0));
  const fps = Math.round(1 / ((channels[0]!.times[1] ?? 1) - channels[0]!.times[0]!));
  const sources: SourceReport[] = [];
  const pcm = new Map<string, Float32Array>();
  for (const [i, s] of (khr?.sources ?? []).entries()) {
    const view = json.bufferViews[khr!.audio[s.audio]!.bufferView]!;
    const bytes = doc.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const name = s.name ?? `source-${i}`;
    const emitter = khr!.emitters.findIndex((e) => e.sources.includes(i));
    const nodes = json.nodes as { extensions?: { KHR_audio?: { emitter: number } } }[];
    const node = nodes.findIndex((n) => n.extensions?.KHR_audio?.emitter === emitter);
    const r = spawnSync(ffmpegPath(), ['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { input: bytes, maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error(`decode ${name}: ${r.stderr.toString()}`);
    const samples = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
    pcm.set(name, samples);
    const spans = voicedSpans(envelopeOf(samples, RATE));
    sources.push({ name, node: node >= 0 ? node : null, loop: s.loop !== false, bytes: bytes.byteLength, seconds: samples.length / RATE, clip, onset: spans[0]?.start ?? null, spans });
  }
  const voice = sources.find((s) => s.name.startsWith('say-'))?.name ?? null;
  const times = Array.from({ length: Math.round(clip * fps) + 1 }, (_, f) => f / fps);
  const mm = mouthSeries(doc, times);
  const env = voice ? envelopeOf(pcm.get(voice)!, RATE) : new Float32Array(0);
  const envAt = (t: number): number => env[Math.min(env.length - 1, Math.max(0, Math.round(t / FRAME)))] ?? 0;
  // Phrase groups of the voice: voiced spans joined across pauses shorter than the lips' PAUSE.
  const spans = voice ? sources.find((s) => s.name === voice)!.spans : [];
  const groups: { start: number; end: number }[] = [];
  for (const s of spans) { const g = groups[groups.length - 1]; if (g && s.start - g.end < PAUSE) g.end = s.end; else groups.push({ ...s }); }
  const inGroups = (t: number): boolean => groups.some((g) => t >= g.start && t <= g.end);
  const speakingP90 = pct(times.flatMap((t, f) => (inGroups(t) ? [mm[f]!] : [])), 0.9) || 1;
  const on = 0.2 * speakingP90;
  const phrases: PhraseReport[] = groups.map((g, i) => {
    const from = Math.max(g.start - 0.3, (groups[i - 1]?.end ?? -1) + 0.05);
    const to = Math.min(g.end + 0.3, (groups[i + 1]?.start ?? Infinity) - 0.05);
    const near = times.map((t, f) => ({ t, v: mm[f]! })).filter((x) => x.t >= from && x.t <= to);
    const first = near.find((x) => x.v > on);
    const last = [...near].reverse().find((x) => x.v > on);
    return { start: g.start, end: g.end, mouthOn: first?.t ?? null, mouthOff: last?.t ?? null, leadMs: first ? Math.round((g.start - first.t) * 1000) : null, lagOffMs: last ? Math.round((last.t - g.end) * 1000) : null };
  });
  // Pauses: gaps between groups, and around the line, of at least BARS.pause; trimmed by 0.12 s at each end for the release.
  const gaps: { start: number; end: number }[] = [];
  if (groups.length) {
    gaps.push({ start: Math.max(0, groups[0]!.start - 1), end: groups[0]!.start });
    for (let i = 1; i < groups.length; i += 1) gaps.push({ start: groups[i - 1]!.end, end: groups[i]!.start });
    gaps.push({ start: groups[groups.length - 1]!.end, end: Math.min(clip, groups[groups.length - 1]!.end + 1) });
  }
  const pauses = gaps.filter((g) => g.end - g.start >= BARS.pause).map((g) => {
    const vals = times.flatMap((t, f) => (t >= g.start + 0.12 && t <= g.end - 0.12 ? [mm[f]!] : []));
    const p95 = pct(vals, 0.95);
    return { start: g.start, end: g.end, p95Mm: p95, share: p95 / speakingP90 };
  });
  // Correlation over the line's window: mouth against loudness.
  const window = groups.length ? { from: groups[0]!.start - 0.3, to: groups[groups.length - 1]!.end + 0.3 } : { from: 0, to: 0 };
  const xs: number[] = [];
  const ys: number[] = [];
  times.forEach((t, f) => { if (t >= window.from && t <= window.to) { xs.push(mm[f]!); ys.push(Math.min(1, envAt(t))); } });
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i += 1) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2; }
  const correlation = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  const outside = times.flatMap((t, f) => (!groups.some((g) => t >= g.start - 0.3 && t <= g.end + 0.3) ? [mm[f]!] : []));
  const padded = sources.every((s) => Math.abs(s.seconds - clip) <= BARS.paddedFrames / fps && s.loop);
  const onsets = phrases.length > 0 && phrases.every((p) => p.leadMs !== null && Math.abs(p.leadMs) <= BARS.onsetMs);
  const rest = pauses.every((p) => p.share < BARS.restShare);
  const corr = correlation >= BARS.correlation;
  const sheetFile = file.replace(/\.glb$/, '.beats.json');
  const sheet = existsSync(sheetFile) ? JSON.parse(await readFile(sheetFile, 'utf8')) as { beats: { id: string; at: number; say?: { delay?: number } }[] } : null;
  const cues = sheet ? sheet.beats.filter((b) => b.say).map((b) => {
    const src = sources.find((x) => x.name === `say-${b.id}`);
    const cue = b.at + (b.say!.delay ?? 0);
    const onset = src?.onset ?? null;
    return { source: `say-${b.id}`, cue, onset, ms: onset === null ? null : (onset - cue) * 1000 };
  }) : null;
  const cued = (cues ?? []).every((c) => c.ms !== null && Math.abs(c.ms) <= 1000 / fps);
  return {
    file, clip, fps, sources, voice,
    mouth: { speakingP90Mm: speakingP90, phrases, pauses, outsideShare: pct(outside, 0.95) / speakingP90, correlation, series: times.map((t, f) => ({ t, mm: mm[f]!, env: envAt(t) })) },
    cues,
    pass: { padded, onsets, rest, correlation: corr, cues: cued, all: padded && onsets && rest && corr && cued }
  };
}

export function summarizeSpeech(r: SpeechReport): string {
  const lines = [`${r.file.split('/').pop()}: clip ${r.clip.toFixed(3)} s at ${r.fps} fps`];
  for (const s of r.sources) lines.push(`  ${s.name} (node ${s.node}, ${s.loop ? 'loop' : 'once'}): decodes to ${s.seconds.toFixed(3)} s (${((s.seconds - r.clip) * 1000).toFixed(0)} ms from the clip), ${(s.bytes / 1e3).toFixed(0)} KB, sound from ${s.onset?.toFixed(2) ?? '-'} s`);
  const m = r.mouth;
  lines.push(`  mouth while speaking: p90 ${m.speakingP90Mm.toFixed(2)} mm; follows loudness r = ${m.correlation.toFixed(2)}; outside the line p95 ${(m.outsideShare * 100).toFixed(0)} % of that`);
  for (const p of m.phrases) lines.push(`  phrase ${p.start.toFixed(2)}-${p.end.toFixed(2)} s: mouth on ${p.mouthOn?.toFixed(3) ?? '-'} s (leads the sound by ${p.leadMs ?? '-'} ms), off ${p.mouthOff?.toFixed(3) ?? '-'} s (${p.lagOffMs ?? '-'} ms after)`);
  for (const p of m.pauses) lines.push(`  pause ${p.start.toFixed(2)}-${p.end.toFixed(2)} s: mouth p95 ${p.p95Mm.toFixed(2)} mm (${(p.share * 100).toFixed(0)} % of speaking)`);
  for (const c of r.cues ?? []) lines.push(`  ${c.source}: its beat cues it at ${c.cue.toFixed(2)} s; first sound ${c.onset?.toFixed(3) ?? '-'} s (${c.ms === null ? 'not heard' : `${c.ms >= 0 ? '+' : ''}${c.ms.toFixed(0)} ms`})`);
  lines.push(`  bars: padded ${r.pass.padded ? 'pass' : 'FAIL'}, onsets ±${BARS.onsetMs} ms ${r.pass.onsets ? 'pass' : 'FAIL'}, rest <${BARS.restShare * 100} % ${r.pass.rest ? 'pass' : 'FAIL'}, r ≥ ${BARS.correlation} ${r.pass.correlation ? 'pass' : 'FAIL'}${r.cues ? `, lines on their beat ±1 frame ${r.pass.cues ? 'pass' : 'FAIL'}` : ''}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const j = args.indexOf('--json');
  const out = j >= 0 ? args.splice(j, 2)[1] : undefined;
  if (!args[0]) { console.error('usage: speech-report.ts <take.glb> [--json out.json]'); process.exit(2); }
  const r = await speechReport(args[0]);
  console.log(summarizeSpeech(r));
  if (out) await writeFile(out, `${JSON.stringify(r, null, 2)}\n`);
  if (!r.pass.all) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
