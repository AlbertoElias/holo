---
name: hologram-authoring
description: Make a hologram from a one-line idea with the customisable house avatar - write a beat sheet, build and check it with one command (make.ts), have a fresh reader judge it, and revise until every bar passes. Use whenever an agent is asked to create, direct, animate, revise or audition a hologram, a take, a beat sheet or a piece with the house avatar.
---

# Make a hologram with the house avatar

A hologram is a recorded event, seen through a portal on a phone's feed card
(`docs/product/concepts/what-a-hologram-is.md`). You write it as a **beat
sheet**: who performs, what they hold, and what they do when. `make.ts`
builds the sheet into a take, checks every bar, records the review pack and
says what to fix. You revise the sheet, not the take.

Run everything from `apps/capture` on Node 24 (`eval "$(../../scripts/agent-node-env.sh)"`).
`M` below is this shell function; define it once per shell (a plain string
variable does not work in zsh):

```bash
M() { node --conditions=development --import tsx scripts/authoring/make.ts "$@"; }
```

## The loop

1. **Start a piece.** `M new <name>` (lower-case, dashes) writes
   `output/authoring/pieces/<name>/sheet.jsonc`: one house avatar who notices
   you, smiles, waves and nods. It builds as it is. Its comments list every
   choice. `M words` prints the same list from the code.
2. **Write the idea into the sheet.** Set the `look` card (every field is
   required; values only from the comments), then write beats, one per thing
   the reader should see. Give the sheet an `intent` and every beat an
   `intent` in plain words ("She waters the plant."): the reading bar is
   checked against those. Comments and trailing commas are fine.
3. **Build and check fast.** `M <sheet> --quick` builds `v1/`, `v2/`, … beside
   the sheet (about 20 s plus a minute for twelve stills). It prints the look
   each performer actually wears and one row per bar, and every failing row
   has a `fix:` line. Do what the fix says and run it again. For a missed
   grip, put or aim, the fix is the edit that lands it, or the best one it
   found ("best found with …"), or "no nudge within 20 cm helps"; then move
   the mark or the reach by hand. Look at
   `vN/frames-sheet.jpg` (already a small contact sheet) to see whether the
   pose reads.
4. **Review.** `M <sheet>` without `--quick` also records the review pack in
   real time: about 6 to 10 minutes for an 8 s take, so run it in the background
   with its output in a log, and wait until the log has a line starting
   `DONE`, `BUILT` or `NOT YET` (or the command exits). Run on an unchanged
   sheet right after `--quick`, it finishes that version instead of making
   another. It
   measures the face on the card (the 40 px bar) and writes
   `vN/review/reader/` (the video and stills a reader sees) and
   `vN/review/comparison.json` (your intents, with blanks for the reader).
5. **Have a visual reviewer judge the motion.** The review also writes
   `vN/review/visual/BRIEF.md`: the card, close and side stills, the worst
   measured arm moments, and what to judge (arm motion, clipping, face). From
   the repo root, run `scripts/gemini-review.sh <version dir>/review/visual/BRIEF.md`
   (Gemini Neon, in the background: it can take minutes). On exit 75, give the
   same brief to the `design-reviewer` subagent (`model: "opus"`) instead.
   Save the JSON block at the end of its answer as
   `vN/review/visual/verdict.json`. Look at the stills it names yourself too:
   the measured bars do not see everything (a hand facing an odd way, an arm
   that snaps). No piece goes to the owner before this review passes.
6. **Have a fresh reader judge it.** Spawn a new subagent (`model: "sonnet"`)
   that is told nothing about the idea and gets only the path of
   `vN/review/reader/`. Prompt it with exactly this, filling the paths:

   > You are a reader. You have been told nothing about what you are about to
   > watch. Read `<reader dir>/README.md` and answer it, using only the files
   > in that folder. To look at an image, never open the full file: run
   > `node packages/tooling-testing/src/preview.mjs <file>` from the repo root
   > and look at the small JPEG it prints. Watch the video too, since motion
   > such as a wave shows only there: extract PNG frames at 10 fps
   > (`ffmpeg -ss <s> -t 2 -i <video> -vf fps=10 <dir>/f%03d.png`) into an
   > empty folder in your scratch directory and preview that folder (a
   > contact sheet), one stretch of two seconds at a time, through the whole
   > video. Write your answer to
   > `<version dir>/review/reader.md`.

   Then spawn a second fresh subagent (the grader, `model: "sonnet"`):

   > You are a grader. In `<version dir>/review/`, `reader.md` is a blind
   > reader's account of a short hologram, and `comparison.json` holds the
   > author's intent per beat (with its time span) and for the whole `piece`,
   > with `seen`, `reads` and `revise` null. Fill only those fields, in place.
   > Per beat: `seen` is what the reader said about that span, quoted or
   > closely paraphrased; `reads` is true only if the reader saw that beat's
   > intent without being told (a near synonym counts, a different meaning
   > does not); `revise`, when `reads` is false, is one concrete sentence on
   > what would make the intent plain at phone-card size. For `piece`: `seen`
   > is the reader's overall line and `reads` whether it matches. Keep valid
   > JSON, be strict, and open no other file.

   Do not grade it yourself: you know what it means, so you will see it. If you cannot start subagents (you are
   one), stop here and hand the two paths to whoever started you, saying
   that the reader and grader are theirs to run.
7. **Verdict.** `M verdict <vN dir>` reruns the bars with the grades and the visual verdict. It says
   `DONE` when every bar passes. Otherwise revise the sheet (step 3), and keep
   each version: the next build lists which seconds changed.

Stop when `make.ts` says DONE. If a bar will not pass after three revisions,
stop and report which bar and why, rather than weakening the piece's idea in
secret. Never loosen a bar, and never publish: `publish.ts` targets
production and needs the owner's word.

## The bars

| Row | Bar |
|---|---|
| `grip.*`, `put.*`, `aim.*` | the hand lands on the object's grip (1 cm, 5°), puts it level (1 cm, 3°), and points its tool at the target (10°) |
| `reach.*` | the palm gets to its point (leaning allowed) |
| `size.*` | each dressed avatar file is at most 1.8 MB (house avatars are about 1.1-1.5) |
| `quickLook` | the take fits the iPhone Quick Look budget |
| `faceBox.*` | the face is at least 40 device px brow to chin on the phone card |
| `arms.body.*` | no arm or hand more than 2 cm into the torso, the legs or the head (measured on the posed skin, every frame) |
| `arms.prop.*` | no arm or hand more than 1 cm into an object it does not hold or touch |
| `arms.twist.*`, `arms.wrist.*` | the forearm twists at most 90° from neutral (palm up and palm down are each a quarter turn), the wrist bends at most 80° |
| `arms.elbow.*` | the elbow goes at most 10° past straight and at most 15° off its hinge (an elbow bends only one way) |
| `visual` | a visual reviewer (Gemini Neon, else the `design-reviewer`) passes the arm motion, the clipping and the face |
| `reading` | a fresh reader reads every beat (each beat needs an `intent`), and the piece as a whole |
| `body.*`, `still.*`, `onCard.*` | notes, not bars: feet planted, something moving every second, objects wholly on the card |

## What works at card size

- **The face is small.** The card frames the performers, every object and
  everything that moves, so each thing you add shrinks the face. One
  performer, objects within about 0.6 m and below the head, no steps. Two
  performers roughly halve the face.
- **Big and slow reads, small and fast does not.** Hold an expression for 1 s
  or more at `strength` 0.7-0.9. `smile` and `sad` read best, `noticing` and
  `concerned` need the body too. Wave with `count` 3. Look at the viewer
  (`"at": "viewer"` with a `viewer` mark at `[0, 1.55, 2.5]`) to address the
  person holding the phone.
- **What the body cannot do yet.** There is no laugh, no sitting, no
  walking path, and no speech without a sound file (the README's "Sound").
  Act a laugh as a broad `smile` (0.9) with quick `nod`s and a `shrug`, and
  expect a reader to call it a smile.
- **One idea per beat.** If a reader cannot say it in five words, split it.

## Recipes

- **Bend over something low.** `{ "kind": "bend", "amount": 0.8 }` bends from
  the waist and pushes the hips back; reach and look are solved on the bent
  body. Use 0.5 for a lean, 1 for the deepest bend. Give it `attack` 0.8-1.0.
- **Lower the body.** `{ "kind": "crouch", "amount": 1 }` bends the knees and
  sinks the hips over planted feet, the chest a little forward. Add a `look`
  at the floor or at a child so a reader knows why. The head drops about
  0.25 m at 1, so a reader names "crouch" or "sinks down", not "kneels". Use
  `bend` for leaning from the waist with straight legs.
- **Wave.** `{ "kind": "gesture", "name": "wave", "side": "right", "count":
  3 }`, with a `look` at the viewer. It reads at card size.
- **Pinch.** The `pinch` hand shape (thumb tip to index tip, the other fingers
  open) reads in the close view only: at card size the hand is about 25 px
  and a reader sees a flat hand. Stage it beside the face, not in front of
  the mouth: a `reach` to `{ "of": "<performer>", "forward": 0.3, "right":
  0.32, "height": "chin" }` with `"palm": "toward"` and the hand `open`, then
  a later beat that changes the hand to `pinch`. The close from open is what
  a reader sees. Palm down or the back of the hand to the camera reads as a
  watch check or a flat hand. The gap is 3 to 4 mm on the house base and
  14 mm on the stock avatar.
- **Pour or point a tool.** An object with `"grip"` and `"tool"` parts, held
  from the start (`"hold": { "right": "can" }` on the performer). Bring the
  hand to a mark beside and above the target
  (`{ "of": "<performer>", "forward": 0.45, "right": 0.45, "height": 0.95 }`)
  with a `reach` (`"stopShort": 0`, `"palm": "down"`), then add an `aim` at
  the target while the reach holds. Add `world: [{ "kind": "pour", "object":
  "can" }]` for the stream. If the aim misses, `make.ts` says which mark edit
  lands it.
- **Pick up, show and put down.** A surface in reach:
  `"counter": { "shape": "box", "size": [0.5, 0.9, 0.35], "at": { "of":
  "<performer>", "forward": 0.45 }, "facing": "<performer>.hips" }`; the thing
  on it: `"loaf": { "parts": [ … ], "grip": "<part>", "on": "counter" }` (it
  rests on the counter's top). Beats: `{ "kind": "take", "side": "right",
  "object": "loaf" }`, then a `reach` to a mark in front of the chest to show
  it, then `{ "kind": "put", "side": "right", "object": "loaf", "on":
  "counter" }`. A performer can also start holding it (`"hold": { "right":
  "loaf" }`). When a take or put misses, `make.ts` tries moving the surface
  and its height and prints the edit that lands it.
- **Pick up something low.** For a surface below the hips (a low table, the
  ground), bend first and keep the bend through the take: give the bend beat
  a `hold` that reaches past the take's end. The bend ends on its own after
  its `hold` and `settle`. A take that starts after the bend ends
  reaches from standing and misses. Give a small object a `grip` with an
  `axis` that points from the hand along the object (for a stone in front of
  the performer, about `[0.8, 0, 1]`), and try the take's `"palm"` (`in`,
  `down`) when the angle misses. `make.ts` tries the palm and the surface
  for you; it does not try the grip axis yet. A small object is only a few
  pixels on the card, so show it at chest height for a second after the take.
- **Change the world.** `world: [{ "kind": "change", "object": "plant",
  "when": 6, "over": 1.5, "from": { "scale": [1, 0.8, 1], "color": "#8e8644" } }]`
  grows or recolours an object; see the README's "World change".
- **Customise the look.** Every trait is a fixed menu (`M words`). There are
  three outfits (`oatmealSlate`, `rustWalnut`, `stormGraphite`) and no other
  clothing colours or garments, so say so rather than inventing one.
  `house:clay`, `house:ink` and `house:light` are three finishes of the same
  avatar.

Everything else (sound and speech, a recorded take as the base, the
six-second test, every field) is in `apps/capture/scripts/authoring/README.md`.
Read the section you need, not the whole file.
