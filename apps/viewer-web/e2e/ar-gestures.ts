import type { Page } from "@playwright/test";

/**
 * Two fingers spread or close on the screen, as a phone's pinch, through
 * Chromium's touch input: the viewer's rescale gesture in AR (brief Q13).
 */
export async function pinch(page: Page, from: number, to: number, centre = { x: 320, y: 240 }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const points = (spread: number) => [
    { x: centre.x - spread / 2, y: centre.y, id: 1 },
    { x: centre.x + spread / 2, y: centre.y, id: 2 }
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(from + ((to - from) * step) / 6) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
