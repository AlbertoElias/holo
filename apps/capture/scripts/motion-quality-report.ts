// Motion-quality report over saved samples from any avatar source. Usage
// (from apps/capture): node --import tsx scripts/motion-quality-report.ts
// [--source <name> <samples.json>]... ; with no arguments it reads the body
// and hand replay samples in output/. Prints one table and writes
// output/motion-quality/report.json. See scripts/lib/motion-quality.ts.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { judgeMotion, measureMotion, type JointName, type MotionFrame, type MotionSource, type Vec3 } from './lib/motion-quality';

type Loaded = { label: string; source: MotionSource; frames: MotionFrame[]; inputFloor?: MotionFrame[] };

const BODY_JOINTS: JointName[] = ['head', 'neck', 'chest', 'hips', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'leftToe', 'rightToe'];
type Bodyish = { timeMs: number; body?: { bones: Record<string, Vec3>; ground?: Record<string, { y: number }>; trackedHead?: { world: Vec3 } | null }; hands?: Record<string, { source?: string; tracked?: Record<string, Vec3>; avatar?: Record<string, Vec3> }> };

const unit = (a: Vec3, b: Vec3): Vec3 => {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
};
const ray = (hand?: Record<string, Vec3>) => (hand?.['index-finger-phalanx-proximal'] && hand['index-finger-tip'] ? unit(hand['index-finger-phalanx-proximal'], hand['index-finger-tip']) : undefined);

// Body replay and hand replay samples share one shape: body bones (when the
// solver ran) plus per-hand tracked and avatar joints.
function fromSamples(samples: Bodyish[], side: 'avatar' | 'tracked'): MotionFrame[] {
  return samples.map((s) => {
    const joints: MotionFrame['joints'] = {};
    for (const name of side === 'avatar' ? BODY_JOINTS : []) {
      const v = s.body?.bones?.[name];
      if (v) joints[name] = v;
    }
    const input: NonNullable<MotionFrame['input']> = {};
    for (const hand of ['left', 'right'] as const) {
      const h = s.hands?.[hand];
      if (!h || (h.source && h.source !== 'xr-hand' && h.source !== 'controller' && h.source !== 'camera-hand')) continue;
      const own = side === 'avatar' ? h.avatar : h.tracked;
      if (own?.wrist) joints[`${hand}Wrist`] = own.wrist;
      if (h.tracked?.wrist) input[`${hand}Wrist`] = h.tracked.wrist;
    }
    if (s.body?.trackedHead?.world) input.head = s.body.trackedHead.world;
    const g = s.body?.ground;
    const own = side === 'avatar' ? s.hands?.right?.avatar : s.hands?.right?.tracked;
    return {
      timeSec: s.timeMs / 1000,
      joints,
      input,
      ...(g ? { ground: { left: g.leftToe?.y ?? g.leftAnkle?.y ?? 0, right: g.rightToe?.y ?? g.rightAnkle?.y ?? 0 } } : {}),
      ...(ray(own) ? { aimRay: ray(own) } : {})
    };
  });
}

async function loadDir(dir: string, source: MotionSource): Promise<Loaded[]> {
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('-samples.json')).sort();
  return Promise.all(
    names.map(async (n) => {
      const samples = JSON.parse(await readFile(path.join(dir, n), 'utf8')) as Bodyish[];
      return { label: n.replace('-samples.json', ''), source, frames: fromSamples(samples, 'avatar'), inputFloor: fromSamples(samples, 'tracked') };
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
      const samples = JSON.parse(await readFile(file, 'utf8')) as Bodyish[];
      loaded.push({ label: path.basename(file).replace(/(-samples)?\.json$/, ''), source, frames: fromSamples(samples, 'avatar'), inputFloor: fromSamples(samples, 'tracked') });
    }
  }
  if (!args.length) {
    loaded.push(...(await loadDir('output/ci-body-replay', 'vr-body')), ...(await loadDir('output/ci-hand-replay', 'vr-hands')));
  }
  const rows = loaded.map((l) => {
    const metrics = measureMotion(l.frames);
    const floor = l.inputFloor ? measureMotion(l.inputFloor) : null;
    return { label: l.label, source: l.source, metrics, inputJitterP95Mm: floor?.jitterP95Mm ?? null, inputRayJitterP95Deg: floor?.rayJitterP95Deg ?? null, verdicts: judgeMotion(metrics, l.source) };
  });
  for (const r of rows) {
    const m = r.metrics;
    const fails = r.verdicts.filter((v) => !v.pass).map((v) => `${v.metric}=${fmt(v.value, 2)}`);
    console.log(
      `${r.source.padEnd(8)} ${r.label.padEnd(42)} skate ${fmt(m.footSkateMaxCm)}cm/${fmt((m.footSkateShare ?? NaN) * 100)}% float ${fmt(m.footFloatP95Cm)} pen ${fmt(m.footPenetrationCm)} limits ${fmt((m.jointLimitShare ?? NaN) * 100)}%${m.jointLimitWorst ? ` [${m.jointLimitWorst}]` : ''} jitter ${fmt(m.jitterP95Mm)}mm (input ${fmt(r.inputJitterP95Mm)}) ray ${fmt(m.rayJitterP95Deg)}° (input ${fmt(r.inputRayJitterP95Deg)}) wrist ${fmt(m.wristErrorP95Cm)}cm lag ${fmt(m.latencyMs, 0)}ms jerk× ${fmt(m.jerkRatio, 2)} aim ${fmt(m.aimErrorMedianDeg)}°` +
        (fails.length ? `\n         MISS ${fails.join(' ')}` : '')
    );
  }
  await mkdir('output/motion-quality', { recursive: true });
  await writeFile('output/motion-quality/report.json', JSON.stringify(rows, null, 2));
  if (process.env.MOTION_QUALITY_STRICT && rows.some((r) => r.verdicts.some((v) => !v.pass))) process.exitCode = 1;
}

await main();
