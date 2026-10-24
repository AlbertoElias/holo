import { HOLOIM_MEANING_EXTENSION, validateHoloimMeaning } from '../../../../packages/meaning/src/index.ts';

// Scores the HOLOIM_meaning record of an exported GLB against a labels file
// (fixtures/pointing-labels/). Two label shapes:
//   segments: a real headset take. Point segments (with a hand) must each
//     yield exactly one link on that hand's index fingertip, timed within
//     TOLERANCE_SEC of the label; every other segment is silent. No referent
//     is scored: the take was recorded in a room the replay scene lacks.
//   points: a synthetic take with intended referents, in order. Points with a
//     referent must yield a link on it; `referent: null` (sky) and `brief`
//     points must yield none.

export const TOLERANCE_SEC = 0.5;
const SILENT_OVERLAP_SEC = 0.05;

/** Reads the JSON chunk of a binary glTF. */
export function readGlbJson(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB has no leading JSON chunk');
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

const overlap = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
const handOf = (bone) => (bone.startsWith('left') ? 'left' : bone.startsWith('right') ? 'right' : null);
const round = (value) => Math.round(value * 100) / 100;

/** Normalises either label shape into expected link points and silent windows. */
function expectations(labels) {
  const points = [];
  const silent = [];
  if (labels.segments) {
    for (const segment of labels.segments) {
      if (segment.kind === 'point') points.push({ name: segment.name, hand: segment.hand, start: segment.start, end: segment.end, referent: undefined });
      else silent.push({ name: segment.name, start: segment.start, end: segment.end, allowedOverlapSec: TOLERANCE_SEC });
    }
  } else {
    labels.points.forEach((point, index) => {
      const name = `${point.brief ? 'brief' : point.referent === null ? 'sky' : 'point'}-${index + 1}${point.referent ? `-${point.referent}` : ''}`;
      if (point.brief || point.referent === null) silent.push({ name, start: point.start, end: point.end, allowedOverlapSec: SILENT_OVERLAP_SEC });
      else points.push({ name, hand: labels.hand, start: point.start, end: point.end, referent: point.referent });
    });
  }
  return { points, silent };
}

function describeTo(gltf, to) {
  return to.bone ? `bone ${to.bone}` : `node ${to.node} (${gltf.nodes?.[to.node]?.name ?? 'unnamed'})`;
}

/**
 * Returns { status, failures, links, matches, silence }. `status` is
 * 'no-meaning' when the GLB has no extension at all, so the check can say so
 * plainly instead of reporting every label as missed.
 */
export function scorePointing({ labels, gltf }) {
  const failures = [];
  const raw = gltf.extensions?.[HOLOIM_MEANING_EXTENSION];
  if (raw === undefined) {
    return {
      status: 'no-meaning',
      failures: [`no ${HOLOIM_MEANING_EXTENSION} in the exported GLB (capture has not emitted the extension, or the take had no marks)`],
      links: [],
      matches: [],
      silence: []
    };
  }
  const validation = validateHoloimMeaning(raw);
  if (!validation.ok) {
    return { status: 'invalid', failures: [`${HOLOIM_MEANING_EXTENSION} fails the v0 schema: ${validation.errors.join('; ')}`], links: [], matches: [], silence: [] };
  }
  if (!(gltf.extensionsUsed ?? []).includes(HOLOIM_MEANING_EXTENSION)) failures.push(`${HOLOIM_MEANING_EXTENSION} is not listed in extensionsUsed`);
  if ((gltf.extensionsRequired ?? []).includes(HOLOIM_MEANING_EXTENSION)) failures.push(`${HOLOIM_MEANING_EXTENSION} must never be in extensionsRequired`);

  const links = validation.value.marks.map((mark) => ({
    from: mark.anchor.from,
    to: mark.anchor.to,
    start: mark.span.start,
    end: mark.span.end,
    provenance: mark.provenance,
    hand: handOf(mark.anchor.from.bone),
    fromNodeName: gltf.nodes?.[mark.anchor.from.node]?.name ?? null,
    toNodeName: gltf.nodes?.[mark.anchor.to.node]?.name ?? null
  }));
  const { points, silent } = expectations(labels);

  const matches = [];
  const matched = new Set();
  for (const hand of ['left', 'right']) {
    const expected = points.filter((point) => point.hand === hand).sort((a, b) => a.start - b.start);
    const found = links.filter((link) => link.hand === hand).sort((a, b) => a.start - b.start);
    if (expected.length !== found.length) {
      failures.push(`${hand} hand: ${found.length} link(s) for ${expected.length} labelled point(s)${found.length ? ` (links at ${found.map((link) => `${round(link.start)}–${round(link.end)} s`).join(', ')})` : ''}`);
    }
    expected.forEach((point, index) => {
      const link = found[index];
      if (!link || expected.length !== found.length) {
        matches.push({ point: point.name, link: null });
        return;
      }
      matched.add(link);
      const problems = [];
      if (link.from.bone !== `${hand}IndexDistal`) problems.push(`from is ${link.from.bone}, not ${hand}IndexDistal`);
      if (link.provenance.value !== 'inferred') problems.push(`provenance ${link.provenance.value}, expected inferred`);
      else if (!(link.provenance.confidence > 0 && link.provenance.confidence <= 1)) problems.push(`confidence ${link.provenance.confidence} not in (0, 1]`);
      const startError = link.start - point.start;
      const endError = link.end - point.end;
      if (Math.abs(startError) > TOLERANCE_SEC) problems.push(`starts ${round(startError)} s from the label (limit ${TOLERANCE_SEC})`);
      if (Math.abs(endError) > TOLERANCE_SEC) problems.push(`ends ${round(endError)} s from the label (limit ${TOLERANCE_SEC})`);
      if (point.referent !== undefined) {
        const hit = point.referent === 'leftHand'
          ? link.to.bone === 'leftHand'
          : link.toNodeName === `${point.referent}_RecordedBubble`;
        if (!hit) problems.push(`links to ${describeTo(gltf, link.to)}, expected ${point.referent}`);
      }
      for (const problem of problems) failures.push(`${point.name}: ${problem}`);
      matches.push({
        point: point.name,
        referent: point.referent ?? null,
        label: { start: point.start, end: point.end },
        link: { start: round(link.start), end: round(link.end), startError: round(startError), endError: round(endError), from: link.from.bone, to: describeTo(gltf, link.to), provenance: link.provenance },
        ok: problems.length === 0
      });
    });
  }
  for (const link of links) {
    if (!matched.has(link) && !points.some((point) => point.hand === link.hand)) {
      failures.push(`link ${round(link.start)}–${round(link.end)} s from ${link.from.bone} matches no labelled point`);
    }
  }

  const silence = silent.map((window) => {
    const intruders = links
      .map((link) => ({ link, overlapSec: overlap(link.start, link.end, window.start, window.end) }))
      .filter((entry) => entry.overlapSec > window.allowedOverlapSec);
    for (const { link, overlapSec } of intruders) {
      failures.push(`${window.name} (${window.start}–${window.end} s) should be silent, but a link ${round(link.start)}–${round(link.end)} s overlaps it by ${round(overlapSec)} s`);
    }
    return { window: window.name, start: window.start, end: window.end, allowedOverlapSec: window.allowedOverlapSec, links: intruders.length };
  });

  return { status: failures.length === 0 ? 'passed' : 'failed', failures, links, matches, silence };
}

export { expectations };
