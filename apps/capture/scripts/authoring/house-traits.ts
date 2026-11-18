/**
 * The trait audition: dress the house base in looks that between them put
 * every trait value on stage (each build, skin, eye colour, hair style and
 * colour, glasses kind and clothing set), run the full avatar audition on
 * each with its bars unchanged, and write one table.
 *
 *   node --conditions=development --import tsx scripts/authoring/house-traits.ts [--geometry] [--only <n>]
 *
 * Writes output/authoring/house-traits/<n>-<lookKey>/ (the audition and its
 * card.png) and output/authoring/house-traits/report.json. Exits 1 when any
 * look fails a binding row.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILDS, CLOTHING, EYES, GLASSES, HAIR_COLOUR, HAIR_STYLES, lookKey, parseLook, SKIN, type LookCard } from '@holoim/avatar-look';

import { audition, summarizeAudition } from './avatar-audition.ts';
import { dressedFile } from './lib/house-look.ts';

const OUT = fileURLToPath(new URL('../../output/authoring/house-traits/', import.meta.url));

const look = (build: string, skin: string, eyes: string, style: string, colour: string, glasses: string, clothing: string): LookCard =>
  parseLook({ build, skin, eyes, hair: { style, colour }, glasses, clothing }, 'house-traits');

/** Eight looks that cover every value; extremes (slight/broad, lightest/darkest skin, tallest hair) are paired on purpose. */
export const TRAIT_LOOKS: LookCard[] = [
  look('slight', 'porcelain', 'blue', 'centrePart', 'wheat', 'square', 'oatmealSlate'),
  look('broad', 'espresso', 'darkBrown', 'tightCoils', 'black', 'round', 'stormGraphite'),
  look('medium', 'linen', 'coolGrey', 'highBun', 'silver', 'none', 'rustWalnut'),
  look('slight', 'umber', 'amber', 'wavyBob', 'espresso', 'round', 'rustWalnut'),
  look('broad', 'goldenSand', 'hazel', 'shortTwists', 'plum', 'square', 'oatmealSlate'),
  look('medium', 'honey', 'mossGreen', 'sweptCrop', 'ashBrown', 'square', 'stormGraphite'),
  look('broad', 'caramel', 'blue', 'centrePart', 'copper', 'none', 'rustWalnut'),
  look('slight', 'copper', 'darkBrown', 'sweptCrop', 'chestnut', 'none', 'stormGraphite'),
];

/** Every value of every trait that no look puts on stage (empty when the set covers them all). */
export function uncovered(looks: LookCard[]): string[] {
  const seen = (pick: (l: LookCard) => string) => new Set(looks.map(pick));
  const check = (name: string, all: readonly string[], pick: (l: LookCard) => string) =>
    all.filter((v) => !seen(pick).has(v)).map((v) => `${name}.${v}`);
  return [
    ...check('build', BUILDS, (l) => l.build),
    ...check('skin', Object.keys(SKIN), (l) => l.skin),
    ...check('eyes', Object.keys(EYES), (l) => l.eyes),
    ...check('hair.style', HAIR_STYLES, (l) => l.hair.style),
    ...check('hair.colour', Object.keys(HAIR_COLOUR), (l) => l.hair.colour),
    ...check('glasses', GLASSES, (l) => l.glasses),
    ...check('clothing', Object.keys(CLOTHING), (l) => l.clothing),
  ];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const geometryOnly = args.includes('--geometry');
  const onlyAt = args.indexOf('--only');
  const only = onlyAt === -1 ? null : Number(args[onlyAt + 1]);
  const missing = uncovered(TRAIT_LOOKS);
  if (missing.length) throw new Error(`the trait looks leave out ${missing.join(', ')}`);

  const results: { n: number; look: string; fails: string[]; notRun: number; sizeMb: number }[] = [];
  for (const [i, card] of TRAIT_LOOKS.entries()) {
    const n = i + 1;
    if (only !== null && only !== n) continue;
    const file = await dressedFile(card);
    const out = join(OUT, `${n}-${lookKey(card)}`);
    const report = await audition(file, { render: !geometryOnly, out });
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'audition.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${n}. ${lookKey(card)}\n${summarizeAudition(report)}`);
    const size = report.rows.find((r) => r.id === 'file.size');
    results.push({
      n,
      look: lookKey(card),
      fails: report.fails,
      notRun: report.rows.filter((r) => r.binding && r.pass === null).length,
      sizeMb: Number(size?.value ?? 0),
    });
  }
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'report.json'), `${JSON.stringify({ looks: results }, null, 2)}\n`);
  console.log('\nlook | fails | not run');
  for (const r of results) console.log(`${r.n}. ${r.look} | ${r.fails.length ? r.fails.join('; ') : 'none'} | ${r.notRun}`);
  if (results.some((r) => r.fails.length)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
