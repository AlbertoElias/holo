// Motion-quality report over saved samples from any avatar source. Usage
// (from apps/capture): node --import tsx scripts/motion-quality-report.ts
// [--source <name> <samples.json>]... ; with no arguments it grades every
// source's latest saved run in output/: desktop-motion (the shipped avatar
// and each skeleton), the body and hand replays, the avatars check's
// per-skeleton body, passthrough (ar-quest) and hand replays, and the camera
// rows `bodycam:report --avatars all` graded (camera aim needs the clip's
// landmarks and holds, so those rows are read from its report.json, which
// the same measureMotion/judgeMotion wrote). Phone AR drives no avatar.
// Prints one table and writes output/motion-quality/report.json; a source
// with no saved run is listed as missing. MOTION_QUALITY_STRICT=1 fails on
// any miss. See scripts/lib/motion-quality.ts.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { framesFromBodySamples, judgeMotion, measureMotion, type BodyLikeSample, type MotionFrame, type MotionMetrics, type MotionSource } from './lib/motion-quality';

type Loaded = { label: string; source: MotionSource; frames: MotionFrame[]; inputFloor?: MotionFrame[] };
async function loadDir(dir: string, source: MotionSource, prefix = ''): Promise<Loaded[]> {
  // `<fixture>--<fault>` samples are the body fault matrix's, not real takes.
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('-samples.json') && !n.includes('--')).sort();
  return Promise.all(
    names.map(async (n) => {
      const samples = JSON.parse(await readFile(path.join(dir, n), 'utf8')) as BodyLikeSample[];
      return { label: prefix + n.replace('-samples.json', ''), source, frames: framesFromBodySamples(samples, 'avatar'), inputFloor: framesFromBodySamples(samples, 'tracked') };
    })
  );
}

// The avatars check's per-skeleton replays: output/ci-avatars/<fixture>/{body,body-ar,hands}.
async function loadAvatarDirs(root: string): Promise<Loaded[]> {
  const fixtures = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const out: Loaded[] = [];
  for (const fixture of fixtures) {
    out.push(
      ...(await loadDir(path.join(root, fixture, 'body'), 'vr-body', `${fixture}/`)),
      ...(await loadDir(path.join(root, fixture, 'body-ar'), 'ar-quest', `${fixture}/`)),
      ...(await loadDir(path.join(root, fixture, 'hands'), 'vr-hands', `${fixture}/`))
    );
  }
  return out;
}

type Graded = { label: string; source: MotionSource; metrics: MotionMetrics; inputJitterP95Mm: number | null; inputRayJitterP95Deg: number | null; verdicts: ReturnType<typeof judgeMotion> };
async function loadCameraReport(file: string): Promise<Graded[]> {
  const report = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as { results?: Array<{ avatar: string; metrics: MotionMetrics; verdicts: Graded['verdicts'] }> };
  return (report.results ?? []).map((r) => ({ label: `camera/${r.avatar}`, source: 'camera', metrics: r.metrics, inputJitterP95Mm: null, inputRayJitterP95Deg: null, verdicts: r.verdicts }));
}

// Avatars each source's saved runs should cover: the shipped avatar and the 7 skeletons the avatars check
// replays (passthrough runs only on the 7: the shipped avatar's passthrough run shares the body replay's
// directory), and the 17 the camera report drives (gap 2).
const EXPECTED_AVATARS = { desktop: 8, 'vr-body': 8, 'ar-quest': 7, 'vr-hands': 8, camera: 17 } as const;
const SOURCES = Object.keys(EXPECTED_AVATARS) as Array<keyof typeof EXPECTED_AVATARS>;
// A label is `<skeleton>/<take>`, or `<take>` for the shipped avatar; desktop's is `desktop/<avatar>`.
const skeletonOf = (label: string) => {
  const parts = label.split('/');
  if (parts[0] === 'desktop' || parts[0] === 'camera') return parts[1]!;
  return parts.length > 1 ? parts[0]! : 'shipped';
};
const takeOf = (label: string) => (/^(desktop|camera)\//.test(label) ? label.split('/')[0]! : label.split('/').at(-1)!);
// Misses the owner accepted: camera aim is rough (natural-avatar-motion.md, Decision 4).
const accepted = (source: MotionSource, metric: string) => source === 'camera' && metric === 'aimErrorMedianDeg';

const fmt = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '–' : v.toFixed(digits));

async function main() {
  const args = process.argv.slice(2);
  const loaded: Loaded[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source') {
      const source = args[++i] as MotionSource;
      const file = args[++i]!;
      const samples = JSON.parse(await readFile(file, 'utf8')) as BodyLikeSample[];
      loaded.push({ label: path.basename(file).replace(/(-samples)?\.json$/, ''), source, frames: framesFromBodySamples(samples, 'avatar'), inputFloor: framesFromBodySamples(samples, 'tracked') });
    }
  }
  const camera: Graded[] = [];
  const gaps: string[] = [];
  if (!args.length) {
    loaded.push(
      ...(await loadDir('output/ci-desktop-motion', 'desktop', 'desktop/')),
      ...(await loadDir('output/ci-body-replay', 'vr-body')),
      ...(await loadDir('output/ci-hand-replay', 'vr-hands')),
      ...(await loadAvatarDirs('output/ci-avatars'))
    );
    camera.push(...(await loadCameraReport('output/bodycam-avatars/report.json')));
    // Coverage: which skeletons and rows each source's saved runs hold, so a partial run reads as partial.
    const all = [...loaded.map((l) => ({ source: l.source, label: l.label })), ...camera];
    for (const source of SOURCES) {
      const labels = all.filter((r) => r.source === source).map((r) => r.label);
      const skeletons = new Set(labels.map(skeletonOf));
      const takes = new Set(labels.map(takeOf));
      if (!labels.length) gaps.push(`no saved run for ${source}`);
      else if (skeletons.size < EXPECTED_AVATARS[source]) gaps.push(`${source} covers ${skeletons.size} of ${EXPECTED_AVATARS[source]} avatars`);
      const partial = [...skeletons].filter((skeleton) => labels.filter((label) => skeletonOf(label) === skeleton).length < takes.size);
      if (partial.length) gaps.push(`${source}: ${partial.join(', ')} lack some of ${[...takes].join(', ')}`);
      console.log(`coverage ${source.padEnd(8)} ${labels.length} runs, ${skeletons.size} avatars, rows ${[...takes].join(', ') || '–'}`);
    }
    for (const gap of gaps) console.log(`GAP ${gap} (see natural-avatar-motion.md, Test plan)`);
  }
  const rows: Graded[] = loaded.map((l) => {
    const metrics = measureMotion(l.frames);
    const floor = l.inputFloor ? measureMotion(l.inputFloor) : null;
    return { label: l.label, source: l.source, metrics, inputJitterP95Mm: floor?.jitterP95Mm ?? null, inputRayJitterP95Deg: floor?.rayJitterP95Deg ?? null, verdicts: judgeMotion(metrics, l.source, { withoutInput: !l.frames.some((f) => f.input?.leftWrist || f.input?.rightWrist), inputJitterP95Mm: floor?.jitterP95Mm ?? null }) };
  });
  rows.push(...camera);
  for (const r of rows) {
    const m = r.metrics;
    const fails = r.verdicts.filter((v) => !v.pass).map((v) => `${v.metric}=${fmt(v.value, 2)}`);
    console.log(
      `${r.source.padEnd(8)} ${r.label.padEnd(42)} skate ${fmt(m.footSkateMaxCm)}cm/${fmt((m.footSkateShare ?? NaN) * 100)}% float ${fmt(m.footFloatP95Cm)} pen ${fmt(m.footPenetrationCm)} pop ${fmt(m.popP99MS2, 0)} limits ${fmt((m.jointLimitShare ?? NaN) * 100)}%${m.jointLimitWorst ? ` [${m.jointLimitWorst}]` : ''} jitter ${fmt(m.jitterP95Mm)}mm (input ${fmt(r.inputJitterP95Mm)}) ray ${fmt(m.rayJitterP95Deg)}° (input ${fmt(r.inputRayJitterP95Deg)}) wrist ${fmt(m.wristErrorP95Cm)}cm lag ${fmt(m.latencyMs, 0)}ms jerk× ${fmt(m.jerkRatio, 2)} aim ${fmt(m.aimErrorMedianDeg)}°` +
        (fails.length ? `\n         MISS ${fails.join(' ')}${r.verdicts.every((v) => v.pass || accepted(r.source, v.metric)) ? ' (accepted)' : ''}` : '')
    );
  }
  await mkdir('output/motion-quality', { recursive: true });
  await writeFile('output/motion-quality/report.json', JSON.stringify(rows, null, 2));
  if (process.env.MOTION_QUALITY_STRICT && (gaps.length || rows.some((r) => r.verdicts.some((v) => !v.pass && !accepted(r.source, v.metric))))) process.exitCode = 1;
}

await main();
