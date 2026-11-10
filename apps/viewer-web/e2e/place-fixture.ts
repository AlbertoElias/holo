import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// A Gaussian-splat scan of a room, written at runtime (nothing committed): a
// floor, a table-height band, floaters under the floor, coloured boxes and
// clutter of every size, and a magenta ring just past the glass of a dome the
// caller measured, where that dome stands at one time of a take. Binary little-endian 3DGS PLY in the trainers' convention,
// y down and z back (a half turn about x from the y-up room), which is the
// convention the viewer falls back on for `.ply`; `yUp` writes it the other way.

export type FixtureOptions = {
  /** The scan's own floor height, y up: not zero, so the floor must be found. */
  floorY?: number;
  /** The floor spans the room's middle by this much each way, metres. */
  half: number;
  /** A magenta ring of splats, `radius` around the point `x`, `z` from the middle of the floor; none when the radius is 0. */
  ring: { x: number; z: number; radius: number };
  /** Single splats of one colour, `x` and `z` from the middle of the floor, `height` above it, `scale` their standard deviation, metres. */
  blobs?: Array<{ x: number; z: number; height: number; scale: number; color: [number, number, number] }>;
  /** Every splat's height is not a number: a scan with no floor to find. */
  noFloor?: boolean;
  /** A ceiling this far above the floor, as dense as the floor: the other strong peak, which the wrong way up is the lowest. */
  ceiling?: number;
  /** Written y up, the other way from the trainers' convention `.ply` is read as by default. */
  yUp?: boolean;
};

export type Fixture = { bytes: Buffer; floorY: number; middle: { x: number; z: number }; count: number };

const SH_C0 = 0.28209479177387814;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Splat = { x: number; y: number; z: number; r: number; g: number; b: number; opacity: number; scale: number };

export function makeFixture({ floorY = 0.35, half, ring, blobs = [], noFloor = false, ceiling, yUp = false }: FixtureOptions): Fixture {
  const rand = mulberry32(0x5ca17);
  const middle = { x: 1, z: -0.5 };
  const splats: Splat[] = [];
  const add = (x: number, y: number, z: number, color: [number, number, number], scale: number, opacity = 0.95) => splats.push({ x, y, z, r: color[0], g: color[1], b: color[2], opacity, scale });

  // The floor, a checker of two greys (the one thing in the scan that is everywhere).
  const step = 0.06;
  for (let ix = -Math.round(half / step); ix <= Math.round(half / step); ix += 1) {
    for (let iz = -Math.round(half / step); iz <= Math.round(half / step); iz += 1) {
      const tile = (Math.floor((ix * step + 1000) / 0.5) + Math.floor((iz * step + 1000) / 0.5)) % 2 === 0;
      add(middle.x + ix * step, floorY + (rand() - 0.5) * 0.01, middle.z + iz * step, tile ? [0.55, 0.56, 0.5] : [0.38, 0.4, 0.36], 0.045);
    }
  }
  if (ceiling !== undefined) {
    for (let ix = -Math.round(half / step); ix <= Math.round(half / step); ix += 1) {
      for (let iz = -Math.round(half / step); iz <= Math.round(half / step); iz += 1) add(middle.x + ix * step, floorY + ceiling + (rand() - 0.5) * 0.01, middle.z + iz * step, [0.85, 0.85, 0.82], 0.045);
    }
  }
  // A table band, 74 cm up: a smaller peak than the floor's, and higher.
  for (let ix = 0; ix < 20; ix += 1) for (let iz = 0; iz < 12; iz += 1) add(middle.x + 1.4 + ix * 0.05, floorY + 0.74 + rand() * 0.02, middle.z - 0.3 + iz * 0.05, [0.5, 0.33, 0.18], 0.04);
  // Floaters under the floor and in the air, as a phone scan leaves them.
  for (let i = 0; i < 200; i += 1) add(middle.x + (rand() - 0.5) * 2 * half, floorY - 0.1 - rand() * 2.5, middle.z + (rand() - 0.5) * 2 * half, [0.9, 0.9, 0.95], 0.08, 0.7);
  // Four boxes around the middle, solid.
  const boxes: Array<[number, number, [number, number, number]]> = [[0.9, 0, [0.9, 0.12, 0.1]], [-0.9, 0, [0.15, 0.8, 0.2]], [0, 0.9, [0.15, 0.3, 0.95]], [0, -0.9, [0.95, 0.85, 0.1]]];
  for (const [bx, bz, color] of boxes) for (let ix = 0; ix < 6; ix += 1) for (let iy = 0; iy < 6; iy += 1) for (let iz = 0; iz < 6; iz += 1) add(middle.x + bx - 0.15 + ix * 0.06, floorY + 0.03 + iy * 0.06, middle.z + bz - 0.15 + iz * 0.06, color, 0.04);
  // Clutter in every size, up to ones that could never sit inside a dome.
  for (let i = 0; i < 3000; i += 1) {
    const scale = 0.02 * Math.exp(rand() * Math.log(40));
    add(middle.x + (rand() - 0.5) * 2 * half, floorY + rand() * 2.6, middle.z + (rand() - 0.5) * 2 * half, [0.25 + rand() * 0.4, 0.3 + rand() * 0.4, 0.25 + rand() * 0.4], scale, 0.5 + rand() * 0.5);
  }
  if (ring.radius > 0) {
    for (let i = 0; i < 900; i += 1) {
      const angle = rand() * Math.PI * 2;
      add(middle.x + ring.x + Math.cos(angle) * ring.radius, floorY + 0.05 + rand() * 1.4, middle.z + ring.z + Math.sin(angle) * ring.radius, [1, 0, 1], 0.06);
    }
  }
  for (const blob of blobs) add(middle.x + blob.x, floorY + blob.height, middle.z + blob.z, blob.color, blob.scale, 0.99);

  const names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${names.map((name) => `property float ${name}`).join("\n")}\nend_header\n`;
  const body = Buffer.alloc(splats.length * names.length * 4);
  splats.forEach((splat, index) => {
    const values = [
      splat.x, noFloor ? Number.NaN : yUp ? splat.y : -splat.y, yUp ? splat.z : -splat.z, 0, 0, 0,
      (splat.r - 0.5) / SH_C0, (splat.g - 0.5) / SH_C0, (splat.b - 0.5) / SH_C0,
      Math.log(splat.opacity / (1 - splat.opacity)),
      Math.log(splat.scale), Math.log(splat.scale), Math.log(splat.scale),
      1, 0, 0, 0
    ];
    values.forEach((value, slot) => body.writeFloatLE(value, (index * names.length + slot) * 4));
  });
  return { bytes: Buffer.concat([Buffer.from(header, "ascii"), body]), floorY, middle, count: splats.length };
}

export async function writeFixture(dir: string, name: string, options: FixtureOptions): Promise<{ file: string } & Fixture> {
  const fixture = makeFixture(options);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, fixture.bytes);
  return { file, ...fixture };
}
