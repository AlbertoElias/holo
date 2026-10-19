import { expect, test } from "@playwright/test";
import { readFile, writeFile, unlink, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const documentUrl = (filename: string) => `/#/doc/${filename}`;

test("grouped territories, complete registry, filters, PRD relationships and history", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Keep the event. Choose the view." }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Explore ideas/ }).click();
  await expect(page.locator(".territory-card")).toHaveCount(6);
  await expect(page.locator(".idea-card")).toHaveCount(0);
  const registry = await readFile(
    path.join(repoRoot, "docs/product/IDEAS.md"),
    "utf8",
  );
  const count = registry.match(/^\| IDEA-\d+ \|/gm)?.length ?? 0;
  await page
    .getByRole("link", { name: new RegExp("All " + count + " ideas") })
    .click();
  await expect(page.locator(".idea-card")).toHaveCount(count);
  await page.getByText("More filters", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Filter by detail" })
    .selectOption("With PRDs");
  await page.locator(".idea-card").filter({ hasText: "IDEA-002" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Anchored notes",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".page-heading")).toContainText("Parked");
  await page
    .locator(".document-card")
    .filter({ hasText: "Anchored notes" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "PRD: Anchored notes" }),
  ).toBeVisible();
  await expect(page.locator(".reader-meta")).toContainText("Parked");
  await page.goBack();
  await expect(
    page.getByRole("heading", {
      name: "Anchored notes",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await page.goForward();
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "PRD: Anchored notes" }),
  ).toBeVisible();
  await page.goto("/#/ideas");
  await page
    .getByRole("textbox", { name: "Search ideas" })
    .fill("no-such-idea-xyz");
  await expect(
    page.getByRole("heading", { name: "Nothing growing here yet." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".territory-card")).toHaveCount(6);
  await page.getByText("More filters", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Filter by theme" })
    .selectOption("Spatial language");
  await expect(page.locator(".idea-card")).not.toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Filter by theme" })
    .selectOption("All themes");
  await page
    .getByRole("combobox", { name: "Filter by layer" })
    .selectOption("View");
  await expect(page.locator(".idea-card")).not.toHaveCount(0);
  for (const layer of await page.locator(".idea-layer").all())
    await expect(layer).toHaveText("View");
  await page.getByRole("textbox", { name: "Search ideas" }).fill("IDEA-045");
  await expect(page.locator(".idea-card")).toHaveCount(1);
  await expect(page.locator(".idea-card")).toContainText("Portal view");
  await page.reload();
  await page.getByText("More filters", { exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Filter by layer" }),
  ).toHaveValue("View");
  await page.screenshot({
    path: testInfo.outputPath("ideas-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("wiki, internal Markdown links, bug source boundaries, and missing routes", async ({
  page,
}) => {
  await page.goto("/#/wiki");
  await page
    .locator(".document-card")
    .filter({ hasText: "Async Holograms" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Async Holograms" }),
  ).toBeVisible();
  await expect(
    page.locator(".reader-aside a").filter({ hasText: "IDEA-002" }),
  ).toBeVisible();
  await page.goto(documentUrl("docs/product/README.md"));
  await page
    .locator(".markdown")
    .getByRole("link", { name: "Vision", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "HoloIM Product Vision" }),
  ).toBeVisible();
  await page.goto("/#/bugs");
  const bugs = await readFile(path.join(repoRoot, "BUGS.md"), "utf8");
  const open = bugs.split("## Open")[1]?.split("\n## ")[0] ?? "";
  await expect(page.locator(".bug-card")).toHaveCount(
    open.match(/^### B-\d+ /gm)?.length ?? 0,
  );
  await expect(
    page.locator(".bug-card").filter({ hasText: "Short symptom" }),
  ).toHaveCount(0);
  await page.goto(documentUrl("docs/missing-knowledge-file.md"));
  await expect(
    page.getByRole("heading", { name: "Document not found." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Return to the atlas" }).click();
  await expect(
    page.getByRole("heading", { name: /Keep the event/ }),
  ).toBeVisible();
  await page.goto("/#/%E0%A4%A");
  await expect(
    page.getByRole("heading", { name: "Document not found." }),
  ).toBeVisible();
});

test("phone layout keeps navigation, filters, and source documents usable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".backbone .source-diagram img")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("approach-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("link", { name: /Explore ideas/ }).click();
  await page.getByRole("textbox", { name: "Search ideas" }).fill("IDEA-002");
  // Stable-ID search opens the original source idea.
  await page.locator(".idea-card").filter({ hasText: "IDEA-002" }).click();
  await page
    .locator(".document-card")
    .filter({ hasText: "Anchored notes" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "PRD: Anchored notes" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("prd-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("new Markdown sources, edits, deletion, fragments, and unsafe content", async ({
  page,
}) => {
  const fixture = path.join(repoRoot, "docs/product/prds/PRD-999-atlas-e2e.md");
  const content =
    "# Atlas browser fixture\n\n**Status:** Draft\n\n**Source ideas:** IDEA-001\n\nAn explanation mentions IDEA-018 without owning that idea.\n\n[Next section](#detail)\n\n## Detail\n\nVisible original text.\n\n[External](https://example.com)\n\n[Unsafe](javascript:alert(1))\n\n<script>window.atlasInjected=true</script>\n\n![External image](https://example.com/tracker.png)\n";
  let externalRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("example.com")) externalRequests += 1;
  });
  try {
    await page.goto("/#/prds");
    await writeFile(fixture, content);
    await expect(
      page
        .locator(".document-card")
        .filter({ hasText: "Atlas browser fixture" }),
    ).toBeVisible();
    await page
      .locator(".document-card")
      .filter({ hasText: "Atlas browser fixture" })
      .click();
    await page
      .locator(".markdown")
      .getByRole("link", { name: "Next section" })
      .click();
    await expect(page).toHaveURL(/section=detail/);
    await expect(page.locator("#detail")).toBeVisible();
    expect(await page.evaluate(() => "atlasInjected" in window)).toBe(false);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(page.locator(".markdown img")).toHaveCount(0);
    expect(externalRequests).toBe(0);
    await expect(page.getByRole("link", { name: /External/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    await writeFile(
      fixture,
      content.replace("Visible original text.", "Visible updated text."),
    );
    await expect(page.locator(".markdown")).toContainText(
      "Visible updated text.",
    );
    await page.goto("/#/idea/IDEA-018");
    await expect(
      page
        .locator(".document-card")
        .filter({ hasText: "Atlas browser fixture" }),
    ).toHaveCount(0);
    await page.goto("/#/idea/IDEA-001");
    await expect(
      page
        .locator(".document-card")
        .filter({ hasText: "Atlas browser fixture" }),
    ).toBeVisible();
    await unlink(fixture);
    await page.goto(documentUrl("docs/product/prds/PRD-999-atlas-e2e.md"));
    await expect(
      page.getByRole("heading", { name: "Document not found." }),
    ).toBeVisible();
  } finally {
    await unlink(fixture).catch(() => undefined);
  }
});

test("empty canonical bug list does not turn a template into a defect", async ({
  page,
}) => {
  const filename = path.join(repoRoot, "BUGS.md");
  const original = await readFile(filename, "utf8");
  try {
    await page.goto("/#/bugs");
    await writeFile(
      filename,
      "# Open Bugs\n\n## Open\n\nNo verified open bugs.\n\n## Entry template\n\n```md\n### B-999 — Template only\n- **Severity:** P2\n```\n",
    );
    await expect(
      page.getByRole("heading", { name: "No verified open bugs." }),
    ).toBeVisible();
    await expect(page.locator(".bug-card")).toHaveCount(0);
  } finally {
    await writeFile(filename, original);
  }
});

test("desktop approach and wiki evidence", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Keep the event/ }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("approach-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto("/#/wiki");
  await page.screenshot({
    path: testInfo.outputPath("wiki-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("any docs Markdown is discoverable and live updates through atomic replacement and rename", async ({
  page,
}) => {
  const original = path.join(repoRoot, "docs/atlas-live-source.md");
  const renamed = path.join(repoRoot, "docs/atlas-renamed-source.md");
  const staging = path.join(repoRoot, "docs/atlas-source.tmp");
  try {
    await page.goto("/#/wiki");
    await page
      .getByRole("combobox", { name: "Document collection" })
      .selectOption("All repository documents");
    await writeFile(
      original,
      "# Live document outside product\n\nFirst content.\n",
    );
    // A source update reloads the page; choose the collection again if needed.
    await expect(async () => {
      await page
        .getByRole("combobox", { name: "Document collection" })
        .selectOption("All repository documents");
      await expect(
        page
          .locator(".document-card")
          .filter({ hasText: "Live document outside product" }),
      ).toBeVisible();
    }).toPass({ timeout: 10000 });
    await page
      .locator(".document-card")
      .filter({ hasText: "Live document outside product" })
      .click();
    await writeFile(
      staging,
      "# Live document outside product\n\nAtomic replacement content.\n",
    );
    await rename(staging, original);
    await expect(page.locator(".markdown")).toContainText(
      "Atomic replacement content.",
    );
    await rename(original, renamed);
    await expect(
      page.getByRole("heading", { name: "Document not found." }),
    ).toBeVisible();
    await page.goto(documentUrl("docs/atlas-renamed-source.md"));
    await expect(page.locator(".markdown")).toContainText(
      "Atomic replacement content.",
    );
    await unlink(renamed);
    await expect(
      page.getByRole("heading", { name: "Document not found." }),
    ).toBeVisible();
  } finally {
    await Promise.all(
      [original, renamed, staging].map((filename) =>
        unlink(filename).catch(() => undefined),
      ),
    );
  }
});

test("visual backbone, conceptual wireframe, keyboard controls, learning loop and Markdown diagrams", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("img", { name: "Event, meaning and view remain connected" }),
  ).toBeVisible();
  const words = (await page.locator("main").innerText()).split(/\s+/).length;
  expect(words).toBeLessThan(380);
  await page.locator("#layer-Meaning").press("Enter");
  await expect(page.locator("#layer-explanation")).toContainText("body first");
  await expect(page.locator(".inference-label")).toHaveText(
    "INFERRED REFERENCE",
  );
  await page.locator("#layer-View").press("Enter");
  await page.getByRole("button", { name: "Free", exact: true }).click();
  const slider = page.getByRole("slider", {
    name: "Explore viewpoint in wireframe",
  });
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await expect(page.locator(".scene-volume")).toHaveAttribute(
    "style",
    /rotateY\(1deg\)/,
  );
  await expect(page.locator(".wireframe-disclaimer")).toContainText(
    "not a running product demo",
  );
  await page.screenshot({
    path: testInfo.outputPath("wireframe-free-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("link", { name: /How we test/ }).click();
  await expect(page.locator(".process-section img")).toBeVisible();
  await page.locator("#process-3").press("Enter");
  await expect(page.locator("#process-detail")).toContainText(
    "Technical success alone is not communication success",
  );
  await page.screenshot({
    path: testInfo.outputPath("process-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.goto(documentUrl("docs/product/ATLAS_GUIDE.md"));
  await expect(page.locator(".markdown .source-diagram img")).toHaveCount(5);
  for (const image of await page
    .locator(".markdown .source-diagram img")
    .all()) {
    await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml/);
    expect(
      await image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth > 0,
      ),
    ).toBe(true);
  }
});

test("editorial copy and diagrams update from Markdown; new ideas need no app configuration", async ({
  page,
}) => {
  const guideFile = path.join(repoRoot, "docs/product/ATLAS_GUIDE.md");
  const labelsFile = path.join(
    repoRoot,
    "docs/product/research/idea-labels.md",
  );
  const registryFile = path.join(repoRoot, "docs/product/IDEAS.md");
  const [guide = "", labels = "", registry = ""] = await Promise.all(
    [guideFile, labelsFile, registryFile].map((file) => readFile(file, "utf8")),
  );
  try {
    await page.goto("/");
    await writeFile(
      guideFile,
      guide
        .replace(
          "Keep the event. Choose the view.",
          "A live Markdown headline.",
        )
        .replace("EVENT / What happened", "EVENT / Live diagram"),
    );
    await expect(
      page.getByRole("heading", { name: "A live Markdown headline." }),
    ).toBeVisible();
    await expect(page.locator(".backbone .source-diagram img")).toHaveAttribute(
      "src",
      /Live%20diagram/,
    );
    await writeFile(
      labelsFile,
      labels.replace("| Portal view |", "| A live portal label |"),
    );
    await page.goto("/#/idea/IDEA-045");
    await expect(
      page.getByRole("heading", { name: "A live portal label", exact: true }),
    ).toBeVisible();
    const row =
      "| IDEA-999 | Fresh uncurated idea | New territory | Exploration | Idea | Can a future idea be found? | |\n";
    const lastRow = [...registry.matchAll(/^\| IDEA-\d+ .*$/gm)].at(-1)![0];
    await writeFile(
      registryFile,
      registry.replace(lastRow, lastRow + "\n" + row.trim()),
    );
    await page.goto("/#/ideas");
    await expect(
      page.locator(".territory-card").filter({ hasText: "New territory" }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "Search ideas" }).fill("IDEA-999");
    await expect(page.locator(".idea-card")).toContainText(
      "Fresh uncurated idea",
    );
  } finally {
    await Promise.all(
      [
        [guideFile, guide],
        [labelsFile, labels],
        [registryFile, registry],
      ].map(([file, content]) => writeFile(file!, content!)),
    );
  }
});

test("local Markdown images and Mermaid render safely, refresh, and degrade readably", async ({
  page,
}) => {
  const fixture = path.join(repoRoot, "docs/atlas-visual-fixture.md");
  const asset = path.join(repoRoot, "docs/atlas-visual-fixture.png");
  const content =
    '# Visual fixture\n\n![Local diagram](atlas-visual-fixture.png)\n\n![Remote](https://example.com/tracker.png)\n\n```mermaid\nflowchart LR\n  A["Recorded"] --> B["Viewed"]\n```\n';
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=",
    "base64",
  );
  let remote = 0;
  page.on("request", (request) => {
    if (request.url().includes("example.com")) remote++;
  });
  try {
    await writeFile(asset, png);
    await writeFile(fixture, content);
    await page.goto(documentUrl("docs/atlas-visual-fixture.md"));
    await expect(
      page.getByRole("img", { name: "Local diagram" }),
    ).toHaveAttribute("src", /^data:image\/png/);
    await expect(page.locator(".source-diagram img")).toBeVisible();
    await expect(page.locator(".image-reference")).toContainText("Remote");
    expect(remote).toBe(0);
    await unlink(asset);
    await expect(page.getByRole("img", { name: "Local diagram" })).toHaveCount(
      0,
    );
    await expect(page.locator(".image-reference")).toContainText([
      "Local diagram",
      "Remote",
    ]);
    await writeFile(
      fixture,
      content.replace(
        'flowchart LR\n  A["Recorded"] --> B["Viewed"]',
        "this is not valid mermaid",
      ),
    );
    await expect(page.getByRole("status")).toContainText("Diagram unavailable");
    await page.getByText("Diagram source", { exact: true }).click();
    await expect(page.locator(".source-diagram code")).toHaveText(
      "this is not valid mermaid",
    );
  } finally {
    await Promise.all(
      [fixture, asset].map((file) => unlink(file).catch(() => undefined)),
    );
  }
});

test("source refresh preserves reading state, and missing guide leaves canonical exits", async ({
  page,
}) => {
  const guideFile = path.join(repoRoot, "docs/product/ATLAS_GUIDE.md");
  const hidden = path.join(repoRoot, "docs/product/ATLAS_GUIDE.atlas-test");
  const original = await readFile(guideFile, "utf8");
  try {
    await page.goto("/");
    await page.locator("#layer-View").click();
    await page.getByRole("button", { name: "Free", exact: true }).click();
    await writeFile(
      guideFile,
      original.replace(
        "| Speech | “Turn this hinge, like this.” |",
        "| Speech | A source-backed explanation. |",
      ),
    );
    await expect(page.locator(".speech-chip")).toHaveText(
      "A source-backed explanation.",
    );
    await expect(page.locator("#layer-View")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page.getByRole("button", { name: "Free", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.goto("/#/ideas");
    await page
      .locator(".relationship-section")
      .getByRole("button", { name: "Portal view", exact: true })
      .click();
    await writeFile(guideFile, original);
    await expect(
      page
        .locator(".relationship-section")
        .getByRole("button", { name: "Portal view", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("textbox", { name: "Search ideas" }).fill("IDEA-045");
    await writeFile(guideFile, original + "\n");
    await expect(
      page.getByRole("textbox", { name: "Search ideas" }),
    ).toHaveValue("IDEA-045");
    await expect(page.locator(".idea-card")).toHaveCount(1);
    await rename(guideFile, hidden);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Reading guide unavailable." }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Hologram model", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "What a Hologram Is", level: 1 }),
    ).toBeVisible();
    await page.goto("/#/process");
    await expect(
      page.getByRole("heading", { name: "Reading guide unavailable." }),
    ).toBeVisible();
  } finally {
    await rename(hidden, guideFile).catch(() => undefined);
    await writeFile(guideFile, original);
  }
});
