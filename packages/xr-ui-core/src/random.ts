// Seeded randomness for the edge outline (styleguide 3.1; brief Q10: the seed
// is the hologram's id, so one hologram keeps the same tears in the feed, in
// AR and in Quick Look). Written to be ported line for line to the Python
// USDZ builder: FNV-1a (32-bit) over the seed's UTF-8 bytes, then mulberry32.
// Changing either changes every hologram's edge and fails the golden test.

export type Random = () => number;

export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(seed)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Uniform numbers in [0, 1), the same sequence for the same seed. */
export function seededRandom(seed: string): Random {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
