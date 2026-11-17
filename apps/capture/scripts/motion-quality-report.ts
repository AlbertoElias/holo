// Motion-quality report over saved samples from any avatar source. Usage
// (from apps/capture): node --import tsx scripts/motion-quality-report.ts
// [--source <name> <samples.json>]... ; with no arguments it reads the body
// and hand replay samples in output/. Prints one table and writes
// output/motion-quality/report.json. See scripts/lib/motion-quality.ts.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { framesFromBodySamples, judgeMotion, measureMotion, type BodyLikeSample, type MotionFrame, type MotionSource } from './lib/motion-quality';

type Loaded = { label: string; source: MotionSource; frames: MotionFrame[]; inputFloor?: MotionFrame[] };
async function loadDir(dir: string, source: MotionSource): Promise<Loaded[]> {
  // `<fixture>--<fault>` samples are the body fault matrix's, not real takes.
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('-samples.json') && !n.includes('--')).sort();
  return Promise.all(
    names.map(async (n) => {
      const samples = JSON.parse(await readFile(path.join(dir, n), 'utf8')) as BodyLikeSample[];
      return { label: n.replace('-samples.json', ''), source, frames: framesFromBodySamples(samples, 'avatar'), inputFloor: framesFromBodySamples(samples, 'tracked') };
    })
  );
}

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
  if (!args.length) {
    loaded.push(...(await loadDir('output/ci-body-replay', 'vr-body')), ...(await loadDir('output/ci-hand-replay', 'vr-hands')));
  }
  const rows = loaded.map((l) => {
    const metrics = measureMotion(l.frames);
    const floor = l.inputFloor ? measureMotion(l.inputFloor) : null;
    return { label: l.label, source: l.source, metrics, inputJitterP95Mm: floor?.jitterP95Mm ?? null, inputRayJitterP95Deg: floor?.rayJitterP95Deg ?? null, verdicts: judgeMotion(metrics, l.source, { withoutInput: !l.frames.some((f) => f.input?.leftWrist || f.input?.rightWrist), inputJitterP95Mm: floor?.jitterP95Mm ?? null }) };
  });
  for (const r of rows) {
    const m = r.metrics;
    const fails = r.verdicts.filter((v) => !v.pass).map((v) => `${v.metric}=${fmt(v.value, 2)}`);
    console.log(
      `${r.source.padEnd(8)} ${r.label.padEnd(42)} skate ${fmt(m.footSkateMaxCm)}cm/${fmt((m.footSkateShare ?? NaN) * 100)}% float ${fmt(m.footFloatP95Cm)} pen ${fmt(m.footPenetrationCm)} pop ${fmt(m.popP99MS2, 0)} limits ${fmt((m.jointLimitShare ?? NaN) * 100)}%${m.jointLimitWorst ? ` [${m.jointLimitWorst}]` : ''} jitter ${fmt(m.jitterP95Mm)}mm (input ${fmt(r.inputJitterP95Mm)}) ray ${fmt(m.rayJitterP95Deg)}° (input ${fmt(r.inputRayJitterP95Deg)}) wrist ${fmt(m.wristErrorP95Cm)}cm lag ${fmt(m.latencyMs, 0)}ms jerk× ${fmt(m.jerkRatio, 2)} aim ${fmt(m.aimErrorMedianDeg)}°` +
        (fails.length ? `\n         MISS ${fails.join(' ')}` : '')
    );
  }
  await mkdir('output/motion-quality', { recursive: true });
  await writeFile('output/motion-quality/report.json', JSON.stringify(rows, null, 2));
  if (process.env.MOTION_QUALITY_STRICT && rows.some((r) => r.verdicts.some((v) => !v.pass))) process.exitCode = 1;
}

await main();
