import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { tokens } from '@holoim/design-tokens';

import { REST, chrome, headsetShooter, selectTarget, until } from './find-take.mjs';
import { readGlb } from './object-glb.mjs';
import { clickButton, openCapture, saveDownload, setupPage } from './object-take.mjs';
import { enterIwer, stepper } from './summon-take.mjs';

// The house avatar's look in a headset (docs/features/your-look.md, slice 2),
// in IWER, through capture's real input paths:
//   - headset-look: a controller ray on the wrist's Look glyph opens the
//     mirror and the look panel on the 1.5 m arc, apart, with no text within
//     1 m and every hit at least a ray's 56 apx; the Hair tab and a hair pick,
//     the Face tab and round glasses, change the live avatar; the mirror's own
//     pass shows the head while the eye's does not; Record closes Look; the
//     take exports the look (its hair, its glasses, its card) and no mirror or
//     panel; after Close the mirror draws no more.
// IWER has no multiview, so the mirror's stereo under multiview is not shown here.

const HOUSE_BASE = '/gltf/models/house-base.glb';

const sampleLook = (page) => page.evaluate(() => window.__sampleHouseLook());

/** Each world-space box's horizontal extent along the head's right axis: the mirror and the panel must not overlap. */
function apart(head, a, b) {
  const along = (position) => {
    const dx = position[0] - head[0];
    const dz = position[2] - head[2];
    return Math.atan2(dx, -dz);
  };
  const angleA = along(a.worldPosition);
  const angleB = along(b.worldPosition);
  const halfA = Math.atan2(a.sizeM[0] / 2, a.distanceFromHeadM);
  const halfB = Math.atan2(b.sizeM[0] / 2, b.distanceFromHeadM);
  return Math.abs(angleA - angleB) - halfA - halfB;
}

async function pick(page, step, fail, target, want) {
  const picked = await selectTarget(page, step, target);
  if (picked.hit !== target) fail(`the right ray rested on ${picked.hit}, not ${target}`);
  await until(page, step, (vr) => vr.look?.panel?.status === 'Your look shows in the mirror.', `${target} worn`, fail, 600);
  const sample = await sampleLook(page);
  if (!want(sample)) fail(`after ${target} the live look is ${JSON.stringify(sample.look)} (${sample.meshes.join(', ')})`);
  return sample;
}

/** IWER controllers: Look on the wrist, the mirror and the panel, two picks, Record closes it, the export wears the look. */
export async function runIwerLookTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'headset-look';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  // Readable evidence of the panel and the mirror (LOOK_VIEWPORT=WxH, default 1280x720), in the shots and a proof video.
  const [width, height] = (process.env.LOOK_VIEWPORT ?? '1280x720').split('x').map(Number);
  const { context, page } = await setupPage(browser, { iwer: true, consoleErrors, label, viewport: { width, height } });
  try {
    await openCapture(page, baseUrl, { avatar: HOUSE_BASE });
    await enterIwer(page, 'controller');
    // What the headset sees, not IWER's spectator.
    await page.evaluate(() => window.__setSpectatorView(false));
    const { step } = stepper(page);
    const shot = headsetShooter(page, step, artifactDir, label);
    const controller = (side, position, quaternion) => page.evaluate(({ s, p, q }) => {
      const c = window.IWER_DEVICE.controllers[s];
      c.position.set(...p);
      if (q) c.quaternion.set(...q);
    }, { s: side, p: position, q: quaternion });
    await controller('left', REST.left, [0, 0, 0, 1]);
    await controller('right', REST.right, [0, 0, 0, 1]);
    await step(20);
    await until(page, step, (vr) => vr.look?.dockGlyph === true, 'the Look glyph on the wrist', fail, 300);

    // Look on the wrist opens the mirror and the panel; the settings panel steps aside.
    const dock = await selectTarget(page, step, 'look');
    if (dock.hit !== 'look') fail(`the right ray rested on ${dock.hit}, not the wrist's Look glyph`);
    await until(page, step, (vr) => vr.look?.panel?.visible && vr.look?.mirror?.visible, 'the mirror and the look panel', fail, 120);
    let vr = await chrome(page);
    const { panel, mirror } = vr.look;
    const rayMinM = tokens.hit.ray * tokens.size.radiansPerApx * tokens.placement.worldPanelDefaultM;
    const visibleTargets = panel.targets.filter((t) => t.visible);
    const opened = {
      panelDistanceM: Number(panel.distanceFromHeadM.toFixed(3)),
      // The mirror stands on the floor: its horizontal distance is the arc's.
      mirrorDistanceM: Number(Math.hypot(mirror.worldPosition[0] - vr.head[0], mirror.worldPosition[2] - vr.head[2]).toFixed(3)),
      panelSizeM: panel.sizeM.map((v) => Number(v.toFixed(3))),
      gapRad: Number(apart(vr.head, { ...mirror, distanceFromHeadM: Math.hypot(mirror.worldPosition[0] - vr.head[0], mirror.worldPosition[2] - vr.head[2]) }, panel).toFixed(3)),
      mirrorBottomM: Number((mirror.worldPosition[1] - mirror.sizeM[1] / 2).toFixed(3)),
      settingsVisible: vr.panel?.visible ?? null,
      findVisible: vr.find?.visible ?? null,
      tab: panel.tab,
      nearestLabelM: Math.min(...vr.labels.map((l) => l.distanceFromHeadM)),
      smallestHitM: Math.min(...visibleTargets.map((t) => Math.min(t.hitWidthM, t.hitHeightM))),
      visibleTargets: visibleTargets.length
    };
    for (const [name, distance] of [['panel', opened.panelDistanceM], ['mirror', opened.mirrorDistanceM]]) {
      if (Math.abs(distance - tokens.placement.worldPanelDefaultM) > 0.05) fail(`the ${name} opened ${distance} m away`);
    }
    if (opened.gapRad <= 0) fail(`the mirror and the panel overlap (gap ${opened.gapRad} rad)`);
    if (opened.panelSizeM[0] > 0.95 || opened.panelSizeM[1] > 0.65) fail(`the look panel is ${opened.panelSizeM.join(' × ')} m, over about 0.9 × 0.6 m`);
    if (opened.settingsVisible || opened.findVisible) fail(`settings=${opened.settingsVisible} find=${opened.findVisible} stayed open beside Look`);
    if (opened.tab !== 'body') fail(`Look opened on the ${opened.tab} tab`);
    if (opened.nearestLabelM < tokens.type.headsetLabelMinDistanceM) fail(`text shows ${opened.nearestLabelM} m from the head`);
    if (opened.smallestHitM < rayMinM - 1e-4) fail(`a look target is ${opened.smallestHitM} m, under the ray minimum ${rayMinM} m`);
    const start = (await sampleLook(page)).look;
    const shots = { opened: await shot('1-opened') };
    // A second in the mirror, so a proof video shows the change.
    await step(60);

    // The Hair tab, then a hair the start does not wear.
    await selectTarget(page, step, 'look:tab:hair');
    await step(4);
    vr = await chrome(page);
    if (vr.look.panel.tab !== 'hair') fail(`the Hair tab shows ${vr.look.panel.tab}`);
    const hair = start.look.hair.style === 'highBun' ? 'sweptCrop' : 'highBun';
    const afterHair = await pick(page, step, fail, `look:pick:hair:${hair}`, (s) => s.look?.look.hair.style === hair && s.meshes.includes(`Hair_${hair}`));
    vr = await chrome(page);
    if (vr.look.panel.chosen.hair !== hair) fail(`the panel marks ${vr.look.panel.chosen.hair} as the chosen hair`);
    shots.hair = await shot('2-hair');
    // A second in the mirror, so a proof video shows the change.
    await step(60);

    // The Face tab and round glasses.
    await selectTarget(page, step, 'look:tab:face');
    await step(4);
    const afterGlasses = await pick(page, step, fail, 'look:pick:glasses:round', (s) => s.look?.look.glasses === 'round' && s.meshes.includes('Glasses_round'));
    shots.glasses = await shot('3-glasses');
    // A second in the mirror, so a proof video shows the change.
    await step(60);

    // The mirror's own pass shows the head; the eye's does not (first person).
    vr = await chrome(page);
    const head = { mirrorRenders: vr.look.mirror.renders, headShownRenders: vr.look.mirror.headShownRenders, headVisibleToEye: vr.look.headVisibleToEye };
    if (head.mirrorRenders < 1) fail('the mirror never drew');
    if (head.headShownRenders < 1) fail('the mirror drew without the head');
    if (head.headVisibleToEye) fail('the head shows to the eye after a look change');

    // Close: the mirror draws no more; the settings panel comes back.
    await selectTarget(page, step, 'look:close');
    await step(4);
    const closedAt = (await chrome(page)).look.mirror.renders;
    await shot('4-closed');
    vr = await chrome(page);
    const closed = { panelVisible: vr.look.panel.visible, mirrorVisible: vr.look.mirror.visible, rendersAfterClose: vr.look.mirror.renders - closedAt, settingsVisible: vr.panel?.visible };
    if (closed.panelVisible || closed.mirrorVisible) fail(`Close left panel=${closed.panelVisible} mirror=${closed.mirrorVisible}`);
    if (closed.rendersAfterClose !== 0) fail(`the mirror drew ${closed.rendersAfterClose} times after Close`);
    if (!closed.settingsVisible) fail('the settings panel did not come back after Close');

    // Open it again, then a take: Record closes Look and Look leaves the wrist.
    await selectTarget(page, step, 'look');
    await until(page, step, (v) => v.look?.panel?.visible, 'Look open again', fail, 120);
    await controller('right', REST.right, [0, 0, 0, 1]);
    await clickButton(page, 'Start Recording');
    await page.getByRole('button', { name: 'Stop Recording', exact: true }).waitFor({ timeout: 10_000 });
    await step(10);
    vr = await chrome(page);
    const duringTake = { open: vr.look.open, panelVisible: vr.look.panel.visible, mirrorVisible: vr.look.mirror.visible, dockGlyph: vr.look.dockGlyph };
    if (duringTake.open || duringTake.panelVisible || duringTake.mirrorVisible) fail(`Look stayed open in the take (${JSON.stringify(duringTake)})`);
    if (duringTake.dockGlyph) fail('Look stayed on the wrist during the take');
    await step(20);
    const glb = path.join(artifactDir, `${label}.glb`);
    await saveDownload(page, async () => {
      await clickButton(page, 'Stop Recording');
      for (let i = 0; i < 20; i += 1) await step(1);
    }, glb);
    const { json } = readGlb(await readFile(glb));
    const names = (json.nodes ?? []).map((node) => node.name ?? '');
    const record = [...(json.nodes ?? []).map((node) => node.extras), ...(json.scenes ?? []).map((scene) => scene.extras)].map((extras) => extras?.holoimAvatar).filter(Boolean).map((value) => (typeof value === 'string' ? JSON.parse(value) : value)).find((avatar) => avatar?.look);
    const exported = {
      hair: names.filter((name) => /^Hair_/.test(name)),
      glasses: names.filter((name) => /^Glasses_/.test(name)),
      card: record?.look ?? null,
      chromeNodes: names.filter((name) => /look-mirror|LookPanel/i.test(name))
    };
    if (!exported.hair.some((name) => name.startsWith(`Hair_${hair}`))) fail(`the export's hair is ${exported.hair.join(', ')}, not ${hair}`);
    if (!exported.glasses.some((name) => name.startsWith('Glasses_round'))) fail(`the export's glasses are ${exported.glasses.join(', ')}`);
    if (JSON.stringify(exported.card) !== JSON.stringify(afterGlasses.look.look)) fail(`the export's card is ${JSON.stringify(exported.card)}`);
    if (exported.chromeNodes.length) fail(`the export holds look chrome: ${exported.chromeNodes.join(', ')}`);
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, shots, opened, start, afterHair: afterHair.look, afterGlasses: afterGlasses.look, head, closed, duringTake, export: exported };
  } finally {
    await context.close();
  }
}
