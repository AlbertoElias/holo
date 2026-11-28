import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "./bootstrap";
import { stubSignedInCreator } from "./sign-in";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const avatarGlb = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");

test.describe("Mobile AI prompt-to-hologram flow", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("navigates from feed dock to /create, supports BYOK headers, previews 3D GLB, revises, and posts to feed", async ({
    page
  }) => {
    await stubSignedInCreator(page);

    const capturedHeaders: Array<{ provider?: string; apiKey?: string; url: string }> = [];
    let pollCount = 0;

    await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.route("**/api/holograms", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));

    await page.route("**/api/prompts/capabilities", (route) =>
      route.fulfill({
        json: {
          serverLlmAvailable: true,
          serverProvider: "anthropic",
          voiceAvailable: true,
          supportedByokProviders: ["anthropic", "openai", "openrouter"]
        }
      })
    );

    await page.route("**/api/prompts", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const headers = route.request().headers();
      capturedHeaders.push({
        ...(headers["x-llm-provider"] ? { provider: headers["x-llm-provider"] } : {}),
        ...(headers["x-llm-api-key"] ? { apiKey: headers["x-llm-api-key"] } : {}),
        url: route.request().url()
      });
      pollCount = 0;
      return route.fulfill({
        status: 202,
        json: {
          id: "job-1",
          parentJobId: null,
          prompt: "Notice me, smile warmly, wave hello, and say 'Good to see you!'",
          revisionNote: null,
          finish: "ink",
          includeVoice: true,
          status: "queued",
          title: null,
          intent: null,
          durationSec: null,
          beatCount: null,
          hasVoice: false,
          previewUrl: null,
          sizeBytes: null,
          error: null,
          publishedHologramId: null,
          createdAt: "2026-11-27T20:00:00.000Z",
          updatedAt: "2026-11-27T20:00:00.000Z"
        }
      });
    });

    await page.route("**/api/prompts/job-1", (route) => {
      pollCount += 1;
      const ready = pollCount >= 1;
      return route.fulfill({
        json: {
          id: "job-1",
          parentJobId: null,
          prompt: "Notice me, smile warmly, wave hello, and say 'Good to see you!'",
          revisionNote: null,
          finish: "ink",
          includeVoice: true,
          status: ready ? "ready" : "directing",
          title: "Warm Hello",
          intent: "Warm wave and spoken greeting.",
          durationSec: 6,
          beatCount: 3,
          hasVoice: true,
          previewUrl: ready ? "/api/prompts/job-1/preview.glb" : null,
          sizeBytes: ready ? 2048 : null,
          error: null,
          publishedHologramId: null,
          createdAt: "2026-11-27T20:00:00.000Z",
          updatedAt: "2026-11-27T20:00:01.000Z"
        }
      });
    });

    await page.route("**/api/prompts/job-1/revise", (route) => {
      const headers = route.request().headers();
      capturedHeaders.push({
        ...(headers["x-llm-provider"] ? { provider: headers["x-llm-provider"] } : {}),
        ...(headers["x-llm-api-key"] ? { apiKey: headers["x-llm-api-key"] } : {}),
        url: route.request().url()
      });
      return route.fulfill({
        status: 202,
        json: {
          id: "job-2",
          parentJobId: "job-1",
          prompt: "Notice me, smile warmly, wave hello, and say 'Good to see you!'",
          revisionNote: "Make them look even happier",
          finish: "ink",
          includeVoice: true,
          status: "ready",
          title: "Warm Hello (Brighter)",
          intent: "Brighter warm wave and spoken greeting.",
          durationSec: 6,
          beatCount: 3,
          hasVoice: true,
          previewUrl: "/api/prompts/job-2/preview.glb",
          sizeBytes: 2048,
          error: null,
          publishedHologramId: null,
          createdAt: "2026-11-27T20:00:02.000Z",
          updatedAt: "2026-11-27T20:00:03.000Z"
        }
      });
    });

    await page.route("**/api/prompts/*/preview.glb", (route) =>
      route.fulfill({ status: 200, path: avatarGlb, contentType: "model/gltf-binary" })
    );

    const publishedDto = {
      id: "holo-prompt-1",
      url: "/uploads/holo-prompt-1.glb",
      usdzUrl: null,
      usdzStatus: "none",
      quickLookEnabled: true,
      createdAt: "2026-11-27T20:00:04.000Z",
      sizeBytes: 2048,
      filenameOriginal: "warm-hello-brighter.glb",
      hologramName: "Warm Hello (Brighter)",
      submittedBy: "E2E Creator",
      submittedByVerified: false,
      ownerId: "e2e-creator",
      ownedByViewer: true
    };

    await page.route("**/api/prompts/job-2/publish", (route) =>
      route.fulfill({ status: 201, json: publishedDto })
    );
    await page.route("**/api/holograms/holo-prompt-1", (route) =>
      route.fulfill({ status: 200, json: publishedDto })
    );
    await page.route("**/uploads/holo-prompt-1.glb", (route) =>
      route.fulfill({ status: 200, path: avatarGlb, contentType: "model/gltf-binary" })
    );

    // 1. Enter from the feed dock on mobile.
    await page.goto("/");
    await page.getByRole("button", { name: "Create with AI" }).click();
    await expect(page).toHaveURL(/\/create$/);

    // 2. Tap a starter chip, pick Ink finish, and add a BYOK key.
    await page.getByRole("button", { name: /Notice me, smile warmly/i }).click();
    await page.getByRole("button", { name: "Ink" }).click();
    await page.getByRole("button", { name: /Use my own API key/i }).click();
    await page.getByLabel("Provider").selectOption("openai");
    await page.getByLabel(/API key/i).fill("sk-test-byok-e2e-9999");

    // 3. Generate and wait for the 3D preview canvas.
    await page.getByRole("button", { name: "Generate hologram" }).click();
    await expect(page.getByRole("status")).toContainText("Warm Hello");
    await expect(page.locator(".prompt-stage canvas")).toBeVisible();
    expect(capturedHeaders[0]).toMatchObject({ provider: "openai", apiKey: "sk-test-byok-e2e-9999" });

    // 4. Revise in one line.
    await page.getByLabel("Tweak this hologram").fill("Make them look even happier");
    await page.getByRole("button", { name: "Revise hologram" }).click();
    await expect(page.getByRole("status")).toContainText("Warm Hello (Brighter)");
    expect(capturedHeaders[1]).toMatchObject({ provider: "openai", apiKey: "sk-test-byok-e2e-9999" });

    // 5. Explicitly Post to feed.
    await page.getByRole("button", { name: "Post to feed" }).click();
    await expect(page).toHaveURL(/\/h\/holo-prompt-1\?posted=1$/);
    await expect(page.getByText("Warm Hello (Brighter)")).toBeVisible();
  });
});
