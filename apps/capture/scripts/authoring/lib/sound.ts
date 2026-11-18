/**
 * Sound in a directed take (sound brief slice 1a): a spoken line on a beat
 * and effects tied to a beat or a put, each written into the GLB as a
 * `KHR_audio` source padded with silence to the clip's length and looping
 * with it, since the format has no start time and every player starts every
 * source at the clip's 0 (brief, design decision 0).
 *
 * Voices are `file:<path>` (relative to the sheet; any format ffmpeg reads) or
 * `local:<voice>`, the local Kokoro model (Apache-2.0) run by kokoro-js
 * (Apache-2.0) from an ignored cache, `output/authoring/tools/kokoro/`, at a
 * pinned version and model revision (the model checked by sha256), with no key and no network after the first fetch. Effects
 * are `synth:<name>` (made here, the project's own, CC0) or a file with a
 * credit. Encoding is Opus in WebM through an ffmpeg that has libopus.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Beat, BeatSheet, CreditSpec } from './beats.ts';
import type { SolvedTake } from './direct.ts';
import { parseGlb } from './gltf-read.ts';
import { lineLips, type LineLips } from './lips.ts';

const TOOLS = fileURLToPath(new URL('../../../output/authoring/tools/', import.meta.url));
const KOKORO_DIR = join(TOOLS, 'kokoro');
export const KOKORO = { package: 'kokoro-js', version: '1.2.1', model: 'onnx-community/Kokoro-82M-v1.0-ONNX', revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231', dtype: 'q8', modelFile: 'onnx/model_quantized.onnx', modelSha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478', licence: 'Apache-2.0 (kokoro-js, phonemizer, @huggingface/transformers; Kokoro-82M weights and voices); onnxruntime-node MIT' } as const;
/** PCM rate the lips read. */
const RATE = 16000;
/** Opus bitrate per source: mono speech and effects. */
export const OPUS_KBPS = 64;
export const AUDIO_MIME = 'audio/webm;codecs=opus';
/** How a voice on a head fades, as capture's recorded voice does (`src/recording/GLTFAudioPlugin.ts`). */
const VOICE_DISTANCE = { distanceModel: 'inverse', refDistance: 2, maxDistance: 10000, rolloffFactor: 1 } as const;
/** An effect is heard close up: full level within a metre. */
const EFFECT_DISTANCE = { distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1 } as const;

const SPEAK_SCRIPT = `// Written by scripts/authoring/lib/sound.ts: node speak.mjs <voice> <out.wav> <text>; prints the phonemiser's phrases as JSON.
import { KokoroTTS } from 'kokoro-js';
import { phonemize } from 'phonemizer';
const [voice, out, ...words] = process.argv.slice(2);
const text = words.join(' ');
const tts = await KokoroTTS.from_pretrained('${KOKORO.model}', { dtype: '${KOKORO.dtype}', device: 'cpu', revision: '${KOKORO.revision}' });
const audio = await tts.generate(text, { voice });
await audio.save(out);
// The phonemiser's language as kokoro-js picks it for the voice ('a…' American, else British), so the lips read the phones it spoke.
process.stdout.write(JSON.stringify({ phrases: await phonemize(text, voice.startsWith('a') ? 'en-us' : 'en') }));
`;
const PHONEMIZE_SCRIPT = `import { phonemize } from 'phonemizer';
process.stdout.write(JSON.stringify({ phrases: await phonemize(process.argv.slice(2).join(' ')) }));
`;

/** An ffmpeg with libopus: \`FFMPEG\`, else the first on a known path that has it. */
export function ffmpegPath(): string {
  const candidates = [process.env.FFMPEG, 'ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    const r = spawnSync(c, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (r.status === 0 && /\blibopus\b/.test(r.stdout)) return c;
  }
  throw new Error('sound needs an ffmpeg built with libopus (set FFMPEG, or `brew install ffmpeg`)');
}

function run(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}…: ${r.stderr || r.error?.message}`);
  return r.stdout;
}

/** Mono float PCM at `rate` of any audio file ffmpeg reads. */
export function decode(file: string, rate = RATE): Float32Array {
  const r = spawnSync(ffmpegPath(), ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg decode ${file}: ${r.stderr.toString()}`);
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

async function ensureKokoro(): Promise<void> {
  const pkg = join(KOKORO_DIR, 'node_modules', KOKORO.package, 'package.json');
  if (!existsSync(pkg) || (JSON.parse(await readFile(pkg, 'utf8')) as { version: string }).version !== KOKORO.version) {
    await mkdir(KOKORO_DIR, { recursive: true });
    await writeFile(join(KOKORO_DIR, 'package.json'), '{"name":"kokoro-cache","private":true,"type":"module"}\n');
    run('npm', ['install', '--no-audit', '--no-fund', `${KOKORO.package}@${KOKORO.version}`], KOKORO_DIR);
  }
  await writeFile(join(KOKORO_DIR, 'speak.mjs'), SPEAK_SCRIPT);
  await writeFile(join(KOKORO_DIR, 'phonemize.mjs'), PHONEMIZE_SCRIPT);
}

/** The fetched model must be the pinned one: its sha256 against the revision's LFS hash. */
function verifyKokoroModel(): void {
  const file = join(KOKORO_DIR, 'node_modules', '@huggingface', 'transformers', '.cache', KOKORO.model, KOKORO.modelFile);
  if (!existsSync(file)) throw new Error(`the voice model is not at ${file}; the transformers cache moved`);
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (sha !== KOKORO.modelSha256) throw new Error(`${KOKORO.model} ${KOKORO.modelFile} is ${sha}, not the pinned ${KOKORO.modelSha256}; delete ${KOKORO_DIR} and build again`);
}

export interface Line {
  readonly beat: string;
  readonly performer: string;
  /** Take time the line starts (s). */
  readonly at: number;
  readonly text: string;
  readonly voice: string;
  readonly gain: number;
  /** The line's own audio, unpadded (WAV or as supplied). */
  readonly file: string;
  /** Its length (s). */
  readonly seconds: number;
  readonly lips: LineLips;
  readonly credit: string;
}

/** A spoken line's audio and lips: synthesised locally (cached by text and voice) or read from the file the sheet names. */
export async function prepareLine(beat: Beat, sheetFile: string, cacheDir: string): Promise<Line> {
  const say = beat.say!;
  let file: string;
  let phrases: string[];
  let credit: string;
  if (say.voice.startsWith('local:')) {
    await ensureKokoro();
    const voice = say.voice.slice('local:'.length);
    const key = createHash('sha256').update(JSON.stringify([KOKORO.version, KOKORO.model, KOKORO.revision, KOKORO.dtype, voice, say.text])).digest('hex').slice(0, 16);
    file = join(cacheDir, `line-${key}.wav`);
    const phrasesFile = `${file}.json`;
    if (!existsSync(file) || !existsSync(phrasesFile)) {
      await mkdir(cacheDir, { recursive: true });
      const out = run('node', ['speak.mjs', voice, file, say.text], KOKORO_DIR);
      verifyKokoroModel();
      await writeFile(phrasesFile, out);
    }
    phrases = (JSON.parse(await readFile(phrasesFile, 'utf8')) as { phrases: string[] }).phrases;
    credit = `voice: Kokoro-82M ${voice} (${KOKORO.model}, Apache-2.0), made locally with kokoro-js ${KOKORO.version}`;
  } else if (say.voice.startsWith('file:')) {
    file = resolve(dirname(sheetFile), say.voice.slice('file:'.length));
    await ensureKokoro();
    phrases = (JSON.parse(run('node', ['phonemize.mjs', say.text], KOKORO_DIR)) as { phrases: string[] }).phrases;
    credit = `voice: ${say.credit === undefined || say.credit === 'own' ? 'own recording' : `${say.credit.title} by ${say.credit.author} (${say.credit.licence}, ${say.credit.sourceUrl})`}`;
  } else throw new Error(`beat ${beat.id}: say.voice is local:<voice> or file:<path>`);
  const pcm = decode(file);
  return { beat: beat.id, performer: beat.performer, at: beat.at + (say.delay ?? 0), text: say.text, voice: say.voice, gain: say.gain ?? 1, file, seconds: pcm.length / RATE, lips: lineLips(phrases, pcm, RATE), credit };
}

/** The project's own effects, made from numbers (CC0). */
export const SYNTH_EFFECTS = {
  /** A light thing set into a ceramic cup: a soft knock and two short inharmonic rings. */
  'cup-clink': (rate: number): Float32Array => {
    const n = Math.round(rate * 0.45);
    const out = new Float32Array(n);
    const modes = [[2350, 0.5, 0.06], [3910, 0.3, 0.035], [5630, 0.16, 0.02], [1180, 0.22, 0.05]] as const;
    let seed = 7;
    const noise = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
    for (let i = 0; i < n; i += 1) {
      const t = i / rate;
      let v = 0;
      for (const [f, a, tau] of modes) v += a * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / tau);
      v += 0.35 * noise() * Math.exp(-t / 0.004);
      // A second, smaller contact 70 ms later as it settles.
      const t2 = t - 0.07;
      if (t2 > 0) for (const [f, a, tau] of modes) v += 0.35 * a * Math.sin(2 * Math.PI * f * 1.01 * t2) * Math.exp(-t2 / tau);
      out[i] = v * 0.55;
    }
    return out;
  }
} as const satisfies Record<string, (rate: number) => Float32Array>;

export interface Effect {
  readonly id: string;
  readonly at: number;
  /** Object id or `<performer>.head`. */
  readonly on: string;
  readonly gain: number;
  readonly file: string;
  readonly seconds: number;
  readonly credit: string;
}

/** When a sound plays: a beat's `at`, or the moment a beat's put lands. */
export function soundTime(take: SolvedTake, at: NonNullable<BeatSheet['sounds']>[number]['at']): number {
  const beat = take.sheet.beats.find((b) => b.id === at.beat)!;
  if (at.event === 'put') {
    for (const p of take.props) for (const h of p.holdings) if (h.put && h.put.beat.id === beat.id) return h.to + (at.delay ?? 0);
    throw new Error(`sound at beat ${beat.id}: the beat has no put`);
  }
  return beat.at + (at.delay ?? 0);
}

async function writeWav(file: string, pcm: Float32Array, rate: number): Promise<void> {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i]!)) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  await writeFile(file, Buffer.concat([h, data]));
}

export async function prepareEffects(take: SolvedTake, sheetFile: string, cacheDir: string): Promise<Effect[]> {
  const out: Effect[] = [];
  for (const s of take.sheet.sounds ?? []) {
    let file: string;
    let credit: string;
    if (s.file.startsWith('synth:')) {
      const name = s.file.slice('synth:'.length) as keyof typeof SYNTH_EFFECTS;
      file = join(cacheDir, `synth-${name}.wav`);
      await mkdir(cacheDir, { recursive: true });
      await writeWav(file, SYNTH_EFFECTS[name](48000), 48000);
      credit = `sound ${s.id}: ${name}, made by HoloIM from numbers (CC0-1.0)`;
    } else {
      file = resolve(dirname(sheetFile), s.file);
      const c = s.credit as Exclude<CreditSpec, 'own'> | 'own';
      credit = `sound ${s.id}: ${c === 'own' ? 'own recording' : `${c.title} by ${c.author} (${c.licence}, ${c.sourceUrl})`}`;
    }
    out.push({ id: s.id, at: soundTime(take, s.at), on: s.on, gain: s.gain ?? 1, file, seconds: decode(file).length / RATE, credit });
  }
  return out;
}

/** One source padded to the clip: `onset` seconds of silence, the sound, silence to `clip` seconds; Opus in WebM. */
export function padAndEncode(file: string, onset: number, clip: number, out: string): Uint8Array {
  const delay = Math.max(0, Math.round(onset * 1000));
  run(ffmpegPath(), ['-y', '-v', 'error', '-i', file, '-af', `aformat=channel_layouts=mono,aresample=48000,adelay=${delay}:all=1,apad,atrim=0:${clip.toFixed(3)}`,
    '-c:a', 'libopus', '-b:a', `${OPUS_KBPS}k`, '-application', 'audio', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'webm', out]);
  return new Uint8Array(readFileSync(out));
}

/** A source's decoded length (s), as ffprobe reads its container. */
export function probeSeconds(file: string): number {
  const probe = ffmpegPath().replace(/ffmpeg$/, 'ffprobe');
  return Number(run(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());
}

export interface AudioSource {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Node index the positional emitter sits on. */
  readonly node: number;
  readonly gain: number;
  readonly kind: 'voice' | 'effect';
}

/**
 * Adds `KHR_audio` to a GLB: each source's bytes appended to the binary chunk
 * as its own bufferView, one looping source per audio, one positional emitter
 * per source on its node (a voice on the head as capture writes it).
 */
export function addAudio(glb: Uint8Array, sources: readonly AudioSource[], credits: readonly string[] = []): Uint8Array {
  if (!sources.length) return glb;
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  type Json = { asset: { copyright?: string; extras?: { holoim?: Record<string, unknown> } }; buffers: { byteLength: number }[]; bufferViews?: { buffer: number; byteOffset: number; byteLength: number }[]; nodes: { extensions?: Record<string, unknown> }[]; extensions?: Record<string, unknown>; extensionsUsed?: string[] };
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Json;
  const binStart = 20 + jsonLength;
  const binLength = view.getUint32(binStart, true);
  const bin = glb.subarray(binStart + 8, binStart + 8 + binLength);
  const pad4 = (n: number): number => (n + 3) & ~3;
  const parts: Uint8Array[] = [bin];
  let offset = bin.byteLength;
  json.bufferViews ??= [];
  const audio: { bufferView: number; mimeType: string }[] = [];
  for (const s of sources) {
    const at = pad4(offset);
    if (at > offset) parts.push(new Uint8Array(at - offset));
    json.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: s.bytes.byteLength });
    audio.push({ bufferView: json.bufferViews.length - 1, mimeType: AUDIO_MIME });
    parts.push(s.bytes);
    offset = at + s.bytes.byteLength;
  }
  const end = pad4(offset);
  if (end > offset) parts.push(new Uint8Array(end - offset));
  json.buffers[0]!.byteLength = end;
  json.extensions = {
    ...(json.extensions ?? {}),
    KHR_audio: {
      audio,
      sources: sources.map((s, i) => ({ name: s.name, audio: i, autoPlay: false, loop: true })),
      emitters: sources.map((s, i) => ({ name: s.name, type: 'positional', sources: [i], gain: s.gain, positional: { ...(s.kind === 'voice' ? VOICE_DISTANCE : EFFECT_DISTANCE) } }))
    }
  };
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'KHR_audio'])];
  if (credits.length) {
    json.asset.copyright = [json.asset.copyright, ...credits].filter(Boolean).join('; ');
    if (json.asset.extras?.holoim) json.asset.extras.holoim.sounds = [...credits];
  }
  sources.forEach((s, i) => {
    const node = json.nodes[s.node]!;
    if ((node.extensions?.KHR_audio as unknown) !== undefined) throw new Error(`node ${s.node} already carries an emitter: one sound per node`);
    node.extensions = { ...(node.extensions ?? {}), KHR_audio: { emitter: i } };
  });
  const text = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(text + ' '.repeat((4 - (Buffer.byteLength(text) % 4)) % 4));
  const total = 20 + jsonBytes.byteLength + 8 + end;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, total, true);
  v.setUint32(12, jsonBytes.byteLength, true); v.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  v.setUint32(20 + jsonBytes.byteLength, end, true); v.setUint32(24 + jsonBytes.byteLength, 0x004e4942, true);
  let p = 28 + jsonBytes.byteLength;
  for (const part of parts) { out.set(part, p); p += part.byteLength; }
  return out;
}

/**
 * A take's sound as one track from clip time 0, for a video of the take:
 * every `KHR_audio` source in the GLB decoded as embedded and mixed at its
 * own level (each is already padded to the clip). Returns false and writes
 * nothing when the take has no sound.
 */
export function takeSoundtrack(glb: Uint8Array, out: string): boolean {
  const doc = parseGlb(glb) as unknown as { json: { bufferViews: { byteOffset?: number; byteLength: number }[]; extensions?: { KHR_audio?: { audio: { bufferView: number }[] } } }; bin: Uint8Array };
  const audio = doc.json.extensions?.KHR_audio?.audio ?? [];
  if (!audio.length) return false;
  const dir = mkdtempSync(join(tmpdir(), 'soundtrack-'));
  try {
    const inputs = audio.flatMap((a, i) => {
      const view = doc.json.bufferViews[a.bufferView]!;
      const file = join(dir, `source-${i}.webm`);
      writeFileSync(file, doc.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
      return ['-i', file];
    });
    const mix = audio.length > 1 ? ['-filter_complex', `amix=inputs=${audio.length}:normalize=0`] : [];
    const r = spawnSync(ffmpegPath(), ['-y', '-loglevel', 'error', ...inputs, ...mix, '-ac', '1', '-ar', '48000', out]);
    if (r.status !== 0) throw new Error(`soundtrack: ${r.stderr.toString()}`);
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
