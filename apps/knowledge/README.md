# HoloIM Knowledge Atlas

A read-only window into the repository's Markdown knowledge base: approach,
ideas, linked concepts and PRDs, and verified open bugs.

```bash
pnpm install
pnpm --filter @holoim/knowledge dev
# http://127.0.0.1:4176
pnpm --filter @holoim/knowledge verify:full
```

The app is independent of capture/viewer servers and uses port 4176. It does
not require a database or API. Run it locally; deploying the generated site
would expose the included repository documents to that site's audience.

## Sources and freshness

- `docs/product/ATLAS_GUIDE.md`: concise narrative, Mermaid diagrams, conceptual wireframe, idea territories and learning loop.
- `docs/product/research/idea-labels.md`: short scanning labels and takeaways; not decisions.
- `docs/product/APPROACH.md`: full thinking and experiment method.
- `docs/product/IDEAS.md`: the idea table (stable IDs and original ordering).
- `docs/product/concepts/`: the wiki.
- `docs/product/prds/`: real PRDs, excluding the template.
- `docs/product/research/`: supporting research and conversation coverage.
- `BUGS.md`, under `## Open`: verified defects only.
- All Markdown under `docs/` plus the named root guides (`BUGS.md`, `TODOS.md`,
  `HANDOFF.md`, `AGENT_CONTRACT.md`, `README.md`) can be read through source links.

The Vite plugin reads only this allowlist. It does not expose a filesystem
endpoint or follow links to expand access. Raw HTML is disabled. Mermaid fences render as sanitized, inert SVG images with
a readable source disclosure. Relative raster images (PNG/JPEG/WebP/GIF/AVIF)
under `docs/`, up to 5 MiB each, are bundled only when referenced by Markdown.
Missing, oversized, symlinked, SVG and remote images remain textual references;
the reader makes no unsolicited remote-image requests. Include meaningful alt
text and an adjacent explanation so the raw Markdown is useful to agents too.

In development, source edits, new files, and deletions invalidate the content
module and reload the page. A production build is a snapshot; rebuild after
changing Markdown. Nothing is written back to the knowledge base. Search, selection and secondary filters are local tab-session preferences so a
source refresh preserves your place; the selected idea territory lives in the
URL. These preferences do not write to the knowledge base. Hash routes support deep links and history.

All `docs/**/*.md` files are discoverable in **Reference library -> All documents**, including guides and feature briefs outside the product wiki.
This collection choice is part of the URL and survives a source refresh.
The watcher polls only the app and allowlisted documents every 300 ms, including
atomic editor saves and file renames. Run it from the checkout whose docs you
want to read; changes in another worktree appear after integration into that checkout.

## Keeping it running

For an editing session, use `pnpm run dev:knowledge` from the repository root.
It stays local to `127.0.0.1:4176` and refreshes the browser as Markdown changes.
An open Codex terminal can own this process while you work.

For an always-available personal site on macOS, supervise the same command with
a user LaunchAgent (`launchd`), using the main checkout as its working directory
and log files outside the source corpus. Run at login and restart on failure;
stop the foreground server before enabling it so port 4176 has one owner.
Do not point a persistent service at a temporary feature worktree. Installing a
login service is a separate machine configuration step; this app does not
silently install one. A static host with a build triggered on Git pushes is
appropriate for sharing committed documentation, but will not reflect local
uncommitted edits. Do not expose the development server to the internet.

## Verification

`pnpm --filter @holoim/knowledge test:e2e` runs the real browser workflows, writes
an HTML report and captures desktop/mobile screenshots under `test-results/`.
The source-freshness scenario creates temporary Markdown fixtures and removes
them in `finally`; it verifies a newly added PRD appears without app edits.

Browser tests use isolated port 4276 (override with `KNOWLEDGE_TEST_PORT`) and
never reuse a foreground server. Set `KNOWLEDGE_PORT` to override development
port 4176. Tests temporarily change sources in their checkout; use a worktree
if another reader is using the main checkout.
