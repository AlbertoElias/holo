---
name: launch-qa
description: Pre-launch QA with five simulated first-time users (impatient, skeptic, mobile, non-native speaker, breaker) who each browse the live HoloIM app in a real browser, then a ranked, fixed and re-verified issue list. Run before any public launch, announcement, share link, or "going live" step, and whenever the user says they are thinking of launching, going public, or posting the app.
---

# Launch QA: five first users

Source: RoundtableSpace's "send 5 subagents in as your first users" prompt
(https://x.com/RoundtableSpace/status/2111717667228770611). Real first users
rarely say why they left; these five will.

## When this applies

Run it before anything that puts the app in front of strangers: a public
post, a share link, a Product Hunt style launch, inviting testers, or
pointing a domain at it. If the user mentions launching or going live and has
not run this on the current `main`, remind them first and offer to run it.

## Setup

1. Work in your own worktree (see AGENTS.md "Sharing work between agents").
   The personas only read the target; fixes happen on a branch.
2. Pick the target: the deployed URLs in `docs/DEPLOYMENT.md` (viewer
   `https://holoim-viewer.pages.dev`, capture `https://holoim-capture.pages.dev`)
   for a real launch check, or a local build for a fix loop. Confirm the
   deploy is the commit you intend to launch.
3. Browser: Playwright MCP (or the built-in browser) per persona. Each persona
   uses its own browser context or tab so cookies and state do not leak
   between them. Save screenshots under `output/launch-qa/<date>/<persona>/`
   (ignored directory; never commit). Preview images with
   `node packages/tooling-testing/src/preview.mjs` before reading them.
4. Scope the journey: landing page → first success. For HoloIM the first
   success is viewing a hologram in the feed (and AR/portal entry where the
   device allows), plus capture → upload for the capture app. Read
   `docs/product/concepts/what-a-hologram-is.md` so personas judge the product
   by what it claims to be. XR emulation is not a physical headset; say so in
   the report.

## The five personas

Spawn them as five parallel subagents (this is the "parallel, discard context
afterward" case in AGENTS.md). Set `model: "opus"` explicitly on every `Agent`
call, as the source prompt specifies. This is a deliberate exception to the
Standard-tier default for browsing work: launch judgment is the point. Each persona opens
the app from the landing page, tries to reach first success, and screenshots
every moment of confusion, stall, or annoyance with a one-line note of what
they expected.

1. **Impatient**: skims, clicks the first prominent button, quits at the first
   error or any wait over a few seconds.
2. **Skeptic**: reads pricing, terms, privacy, and permission prompts (camera,
   mic, location, WebXR) before committing. Flags missing, vague, or broken
   legal and trust copy, and anything asking for data without saying why.
3. **Mobile**: everything at 375px wide, touch only, CPU and network throttled
   to slow 3G. Flags overflow, tiny tap targets, layout shifts, load times, and
   heavy GLB and media payloads.
4. **Non-native English speaker**: follows only what the UI literally says.
   Flags idioms, jargon, icon-only buttons, and unexplained terms ("hologram",
   "portal", "anchor").
5. **Breaker**: junk and huge input in every form and upload (wrong file
   types, oversized or corrupt GLB, emoji, empty), back button mid-flow,
   double-clicks, reload during upload, offline mid-action. Flags crashes,
   console errors, duplicate records, and dead ends.

Each persona returns a compact list: step, what happened, severity, screenshot
path. No fixes, no editorializing.

## Merge, fix, prove

1. Merge into one list, dedupe, and rank by how many personas hit each issue
   (tie-break by severity). Write it to `output/launch-qa/<date>/report.md`.
2. Show the user the ranked list. Fix everything in one pass on a branch, in
   the order of the list; product or scope decisions go to the user. Follow
   AGENT_CONTRACT.md for validation scope and `docs/product/design/styleguide.md`
   for UI changes. Record anything deferred in `BUGS.md` (the owning file).
3. Rerun all five personas against the fixed build. The launch check passes
   only when no persona hits a previously listed issue and nothing new ranks
   above low severity. If the rerun still fails, repeat from step 2.
4. Finish per AGENTS.md: `pnpm run verify:pr`, merge to `main`, confirm the
   deploy health checks, then rerun the personas once against the live URLs.
   The proof video rule applies to the fixes (record in ignored `output/`,
   send to the user, never commit).

## Report back

Give the user: pass or fail for launch, the ranked list with counts, what was
fixed and what was deferred (with `BUGS.md` entries), the live URLs tested and
commit, and what could not be covered (physical headset, real network).
