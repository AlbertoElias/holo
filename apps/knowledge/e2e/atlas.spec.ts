import { expect, test } from "@playwright/test";
import { readFile, writeFile, unlink, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const documentUrl = (filename: string) => `/#/doc/${filename}`;

test("approach, canonical ideas, filters, PRD relationships, and history", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Ideas deserve/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Idea garden/ }).click();
  const registry = await readFile(
    path.join(repoRoot, "docs/product/IDEAS.md"),
    "utf8",
  );
  const count = registry.match(/^\| IDEA-\d+ \|/gm)?.length ?? 0;
  await expect(page.locator(".idea-card")).toHaveCount(count);
  await page
    .getByRole("combobox", { name: "Filter by detail" })
    .selectOption("With PRDs");
  await expect(
    page.locator(".idea-card").filter({ hasText: "IDEA-002" }),
  ).toBeVisible();
  await page.locator(".idea-card").filter({ hasText: "IDEA-002" }).click();
  await expect(
    page.getByRole("heading", { name: /Notes the author adds/ }),
  ).toBeVisible();
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
    page.getByRole("heading", { name: /Notes the author adds/ }),
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
  await expect(page.locator(".idea-card")).toHaveCount(count);
  await page
    .getByRole("combobox", { name: "Filter by theme" })
    .selectOption("Spatial language");
  await expect(page.locator(".idea-card")).not.toHaveCount(0);
  for (const card of await page.locator(".idea-card .card-bottom").all())
    await expect(card).toContainText("Spatial language");
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
  await expect(page.locator(".bug-card")).not.toContainText("Short symptom");
  await page.goto(documentUrl("docs/missing-knowledge-file.md"));
  await expect(
    page.getByRole("heading", { name: "Document not found." }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Return to the atlas" }).click();
  await expect(
    page.getByRole("heading", { name: /Ideas deserve/ }),
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
  await page.screenshot({
    path: testInfo.outputPath("approach-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("link", { name: /Idea garden/ }).click();
  await page.getByRole("textbox", { name: "Search ideas" }).fill("IDEA-002");
  // Search also includes note text; filter to its known primary PRD before opening.
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
    page.getByRole("heading", { name: /Ideas deserve/ }),
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
