import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright';

import type {} from '../../src/runtime/automationHooks';
import { installHandBlend } from './iwer-hand-blend.ts';
// @ts-expect-error untyped helper modules shared with the object and summon checks
import { clickButton, openCapture, saveDownload, setupPage } from './object-take.mjs';
// @ts-expect-error untyped helper module shared with the summon check
import { enterIwer, stepper } from './summon-take.mjs';

// Scripted IWER headset takes for hand traces (PRD-023), recorded and
// exported by capture's own recorder on a manual clock: both hands in IWER's
// pointing pose, moved by setting `IWER_DEVICE.hands.*.position` each step.
// Every step also reads the tracked index fingertip back (the ground truth a
// trace is judged against) and the phase the script is in.
//
//   shapes: still, a 30 cm circle with the right index at mid-reach, still, a
//     30 cm figure-eight with the left, still, then a circle drawn while
//     leaning in and crouching.
//   travel: a circle drawn while walking 1.6 m, a circle through a teleport
//     (capture's respawn: the character jumps back to its spawn in one step;
//     a headset that jumps is re-origined by capture and never moves the
//     avatar, see HEAD_TRACKING_JUMP_METERS), a circle through a snap turn
//     (the thumbstick), and a second of controllers between hands.

/** 60 Hz, as capture's summon and object takes step. */
const STEP_SEC = 1 / 60;
export const CIRCLE_RADIUS = 0.15;
export const EIGHT_HALF_WIDTH = 0.15;
const HEAD = [0, 1.6, 0] as const;
const REST = { left: [-0.2, 1.25, -0.38], right: [0.2, 1.25, -0.38] } as const;

export type HandTraceScenario = 'shapes' | 'travel';

export type Phase = { name: string; start: number; end: number };
export type GroundTruthSample = {
  /** Seconds since the step after Start Recording (capture's first frame within a step or two). */
  t: number;
  phase: string;
  left: [number, number, number] | null;
  right: [number, number, number] | null;
  source: { left: string; right: string };
};

export type HandTraceTake = {
  scenario: HandTraceScenario;
  glb: string;
  phases: Phase[];
  /** When the one-step events happened, seconds as in `groundTruth`. */
  events: Array<{ name: 'teleport' | 'snap-turn'; t: number }>;
  groundTruth: GroundTruthSample[];
  locomotion: { snapCount: number; rigYaw: number } | null;
};

type Pose = { head: readonly number[]; left: readonly number[]; right: readonly number[]; input?: 'hand' | 'controller'; turn?: number; respawn?: boolean };

const add = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v + b[i]!);
const smooth = (t: number) => t * t * (3 - 2 * t);

/** The script: phases and the pose at each time. */
function script(scenario: HandTraceScenario): { phases: Phase[]; duration: number; pose: (t: number) => Pose; events: Array<{ name: 'teleport' | 'snap-turn'; t: number }> } {
  const circle = (u: number) => [CIRCLE_RADIUS * (Math.cos(2 * Math.PI * u) - 1), CIRCLE_RADIUS * Math.sin(2 * Math.PI * u), 0];
  const eight = (u: number) => {
    const a = 2 * Math.PI * u;
    return [EIGHT_HALF_WIDTH * Math.sin(a), EIGHT_HALF_WIDTH * Math.sin(a) * Math.cos(a), 0];
  };
  const within = (t: number, start: number, end: number) => Math.min(1, Math.max(0, (t - start) / (end - start)));
  if (scenario === 'shapes') {
    const phases: Phase[] = [
      { name: 'still', start: 0, end: 1 },
      { name: 'circle', start: 1, end: 3 },
      { name: 'still-after-circle', start: 3, end: 4 },
      { name: 'figure-eight', start: 4, end: 6.5 },
      { name: 'still-after-eight', start: 6.5, end: 7.5 },
      { name: 'lean-crouch-circle', start: 7.5, end: 9.5 },
      { name: 'still-crouched', start: 9.5, end: 10.5 }
    ];
    return {
      phases,
      duration: 10.5,
      events: [],
      pose: (t) => {
        // Leaning 20 cm in and crouching 30 cm over the last circle; the hands go with the head.
        const body = [0, -0.3 * smooth(within(t, 7.5, 9.5)), -0.2 * smooth(within(t, 7.5, 9.5))];
        const right = t < 7.5 ? circle(within(t, 1, 3)) : circle(within(t, 7.5, 9.5));
        return {
          head: add(HEAD, body),
          right: add(add(REST.right, body), right),
          left: add(add(REST.left, body), eight(within(t, 4, 6.5)))
        };
      }
    };
  }
  const phases: Phase[] = [
    { name: 'still', start: 0, end: 1 },
    { name: 'walk-circle', start: 1, end: 3 },
    { name: 'still-after-walk', start: 3, end: 4 },
    { name: 'teleport-circle', start: 4, end: 6 },
    { name: 'still-after-teleport', start: 6, end: 7 },
    { name: 'snap-circle', start: 7, end: 9 },
    { name: 'still-after-snap', start: 9, end: 9.5 },
    { name: 'controllers', start: 9.5, end: 10.5 },
    { name: 'hands-again', start: 10.5, end: 11.5 }
  ];
  const teleportAt = 5;
  const snapAt = 8;
  return {
    phases,
    duration: 11.5,
    events: [{ name: 'teleport', t: teleportAt }, { name: 'snap-turn', t: snapAt }],
    pose: (t) => {
      // Walking 1.6 m forward at 0.8 m/s; the teleport takes the character back to its spawn.
      const walked = -1.6 * within(t, 1, 3);
      const body = [0, 0, walked];
      const u = t < 4 ? within(t, 1, 3) : t < 7 ? within(t, 4, 6) : within(t, 7, 9);
      return {
        head: add(HEAD, body),
        right: add(add(REST.right, body), circle(u)),
        left: add(REST.left, body),
        input: t >= 9.5 && t < 10.5 ? 'controller' : 'hand',
        turn: t >= snapAt && t < snapAt + STEP_SEC * 1.5 ? 1 : 0,
        respawn: t >= teleportAt && t < teleportAt + STEP_SEC * 0.5
      };
    }
  };
}

async function applyPose(page: Page, pose: Pose): Promise<void> {
  await page.evaluate((p) => {
    const device = window.IWER_DEVICE!;
    if (p.input && device.primaryInputMode !== p.input) device.primaryInputMode = p.input;
    device.position.set(p.head[0]!, p.head[1]!, p.head[2]!);
    device.hands.left!.position.set(p.left[0]!, p.left[1]!, p.left[2]!);
    device.hands.right!.position.set(p.right[0]!, p.right[1]!, p.right[2]!);
    device.controllers.left?.position.set(p.left[0]!, p.left[1]!, p.left[2]!);
    device.controllers.right?.position.set(p.right[0]!, p.right[1]!, p.right[2]!);
    window.__setMockInput({ thumbstick: { turnX: p.turn ?? 0 } });
    if (p.respawn && !window.__respawnCharacter()) throw new Error('Character respawn failed.');
  }, pose);
}

/** Records one scripted take in the running capture app; the GLB and its ground truth land in `artifactDir`. */
export async function recordHandTraceTake({ browser, baseUrl, artifactDir, consoleErrors, scenario }: {
  browser: Browser;
  baseUrl: string;
  artifactDir: string;
  consoleErrors: string[];
  scenario: HandTraceScenario;
}): Promise<HandTraceTake> {
  await mkdir(artifactDir, { recursive: true });
  const label = `hand-traces-${scenario}`;
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label }) as { context: { close: () => Promise<void> }; page: Page };
  try {
    // tsx keeps function names with an __name helper the page lacks.
    await page.addInitScript('globalThis.__name = (target) => target;');
    await openCapture(page, baseUrl, {});
    await enterIwer(page, 'hand');
    const { step } = stepper(page) as { step: (count?: number) => Promise<void> };
    await page.evaluate(installHandBlend);
    await page.evaluate(() => window.__blendHands!('default', 'point', 1));
    const { phases, duration, pose, events } = script(scenario);
    await applyPose(page, pose(0));
    await step(30);

    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    const groundTruth: GroundTruthSample[] = [];
    const steps = Math.round(duration / STEP_SEC);
    for (let i = 0; i <= steps; i += 1) {
      const t = i * STEP_SEC;
      await applyPose(page, pose(t));
      await step(1);
      const read = await page.evaluate(() => {
        const sample = window.__sampleHands();
        const state = JSON.parse(window.render_game_to_text()) as { body?: { leftHandSource?: string; rightHandSource?: string } };
        return {
          left: sample.left.tracked['index-finger-tip'] ?? null,
          right: sample.right.tracked['index-finger-tip'] ?? null,
          source: { left: sample.left.source, right: sample.right.source, state: state.body ?? null }
        };
      });
      groundTruth.push({
        t,
        phase: phases.find((phase) => t >= phase.start && t < phase.end)?.name ?? phases.at(-1)!.name,
        left: read.left as GroundTruthSample['left'],
        right: read.right as GroundTruthSample['right'],
        source: { left: read.source.left, right: read.source.right }
      });
    }
    // What capture did with the scripted locomotion: snap turns taken and the rig's yaw.
    const locomotion = await page.evaluate(() => (JSON.parse(window.render_game_to_text()) as { thumbstick?: { snapCount: number; rigYaw: number } }).thumbstick ?? null);
    const glb = path.join(artifactDir, `${label}.glb`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      for (let i = 0; i < 40; i += 1) await step(1);
    }, glb);
    const take: HandTraceTake = { scenario, glb, phases, events, groundTruth, locomotion };
    await writeFile(path.join(artifactDir, `${label}-ground-truth.json`), JSON.stringify(take));
    return take;
  } finally {
    await context.close();
  }
}
