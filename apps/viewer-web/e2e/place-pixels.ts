import type { Page } from "@playwright/test";

// Pixel readings of a card screenshot, taken in the page (it has a canvas to
// decode a PNG with; the test side has no image library).

export type ShotStats = {
  width: number;
  height: number;
  /** Pixels that are the fixture's magenta ring (red and blue high, green low). */
  magenta: number;
  /** Pixels that are the fixture's red, green, blue or yellow boxes. */
  boxes: number;
};

/** Counts the fixture's saturated colours in a PNG. */
export async function shotStats(page: Page, png: Buffer): Promise<ShotStats> {
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let magenta = 0;
    let boxes = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
      if (r > 170 && b > 170 && g < 90) magenta += 1;
      else if ((r > 170 && g < 90 && b < 90) || (g > 140 && r < 90 && b < 110) || (b > 170 && r < 90 && g < 110) || (r > 190 && g > 170 && b < 90)) boxes += 1;
    }
    return { width: bitmap.width, height: bitmap.height, magenta, boxes };
  }, png.toString("base64"));
}

/** The share of pixels that differ between two PNGs of one size by more than `tolerance` in any channel. */
export async function shotDifference(page: Page, a: Buffer, b: Buffer, tolerance = 6): Promise<number> {
  return page.evaluate(async ({ a, b, tolerance }) => {
    const read = async (base64: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [first, second] = await Promise.all([read(a), read(b)]);
    if (first.width !== second.width || first.height !== second.height) return 1;
    let differing = 0;
    for (let i = 0; i < first.data.length; i += 4) {
      if (Math.abs(first.data[i]! - second.data[i]!) > tolerance || Math.abs(first.data[i + 1]! - second.data[i + 1]!) > tolerance || Math.abs(first.data[i + 2]! - second.data[i + 2]!) > tolerance) differing += 1;
    }
    return differing / (first.data.length / 4);
  }, { a: a.toString("base64"), b: b.toString("base64"), tolerance });
}
