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

## First, the story (before any beat)

A request is one line ("a baker proud of a loaf"). A viewer gets no line: no
title, no words, only a few seconds of a person and things on a small card.
So before you write a beat, turn the line into a story that a viewer gets
with no words. A piece that passes every other bar but tells no story is not
done. These faults made earlier pieces fail:

- Nothing showed who the person was or where. ("A baker" was a person
  behind a brown box.)
- The thing that mattered was already in the hand at the first frame, or it
  was too small to see until it was lifted.
- The event happened nowhere. (A "slip" was a look at an empty point.)

Do these steps and write the result into the sheet's `story` (step 5).
Copy the request word for word into `story.request`: the review checks the
story against it.

1. **Say the story in three parts.**
   - **Setup:** who the person is and where they are.
   - **Event:** what happens. Something in the world must change where the
     viewer can see it: an object comes from a place, moves, falls, spills,
     opens, grows or changes colour. A look, a thought or a feeling alone is
     not an event.
   - **Reaction:** how the person responds to the event. The reaction must
     point at its cause: the person looks at the thing, holds it, shows it.
   The request often names only one part ("proud" is a reaction). Write the
   other two. Choose the simplest event that causes the reaction that the
   request names.
2. **For each part, write what a viewer must see.** Name things, places and
   motions. Name a face only in the reaction, and then name its shape (a
   wide smile, a frown), never a feeling. Use these rules:
   - **The setup shows a role with things and actions, not with a face.** A
     baker has an oven, a tray, loaves on a shelf, flour; a gardener has
     pots and a can. Show the place in the first 1.5 s, before the event.
   - **Every object that matters has a past.** It comes from a place that
     the viewer sees (out of an oven, off a shelf, up from the ground), or
     it is in view from the first frame and the person's eyes go to it
     first. Do not start it in the hand.
   - **A small thing must be made big.** Make the object that matters at
     least 0.15 m across (a loaf 0.3 m, a stone 0.12 to 0.16 m, a glass
     0.18 m tall). A little oversize is better than unseen. Give it a colour
     that contrasts with what is behind it: the outfit's top (`M words` gives
     each outfit's colours) and the surface it is on. Saturated orange, red,
     yellow or white read on `stormGraphite` and `oatmealSlate`; do not put
     orange or brown in front of `rustWalnut`. Put it on a clear surface in
     front of the body, not behind the arms or the hair. The card's
     backdrop is dark teal: a table, shelf or oven in dark teal, blue-grey
     or black disappears into it, so give every set piece a light or warm
     colour (pale wood, cream, terracotta). Hold it still at
     chest height for 1 s or more. A `burst` of a few sparks on it can draw
     the eye before the person sees it.
   - **The event is visible and has a cause.** It happens to an object in
     view, at a place in view, and the person's attention goes to it. An
     accident needs something to go wrong: a thing drops, tips, spills.
     Enough of an event: one object moves by more than its own size or
     changes its state (opens, tips over, appears, changes colour), and the
     person looks at it within 0.5 s.
   - **The reaction is big, slow and points at the cause.** The person looks
     at the thing, then at the viewer. A gift moves toward the viewer and
     waits there: the viewer is the receiver. Pride shows the thing to the
     viewer and smiles. Show or offer an object in both hands, elbows bent,
     in front of the chest (the recipe "Show or offer in both hands"); never
     one arm held straight out. A laugh is face channels
     (`mouthSmileLeft`/`Right` 0.9, `jawOpen` 0.35, `eyeSquintLeft`/`Right`
     0.6, `cheekSquintLeft`/`Right` 0.5) with a small `nod` or a `shrug`.
3. **Check each "must see" against what the tool can show.** Use the table
   below. `M words` lists the names of directions, expressions and looks.
   For objects and world lines, read `apps/capture/scripts/authoring/README.md`,
   sections "Objects and a set" and "Change in the world", and the recipes
   below. Mark each one `shown` (with the directions, objects or world lines
   that show it) or `cannot`.
4. **When a part cannot be shown, change the story.** Find another event,
   role or place that gives the same meaning and that the tool can show.
   Write each change and its reason in `story.changes`. Never drop a part
   and say nothing. If no change keeps the meaning, stop and report the gap
   to whoever started you.
5. **Write the story into the sheet.** Then write the beats from it: the
   setup beats first, then the event, then the reaction. Every beat serves
   one part. Example:

   ```jsonc
   "story": {
     "request":  "a baker proud of a loaf",
     "setup":    { "says": "A baker at work in her bakery.",
                   "see": ["an oven with a warm glow behind her", "loaves on a shelf", "she wears an apron", "she looks into the oven"] },
     "event":    { "says": "She takes a fresh loaf out of the oven.",
                   "see": ["the loaf comes out of the oven mouth in her hands", "steam rises from it"] },
     "reaction": { "says": "She is proud of it and shows it to you.",
                   "see": ["she lifts it near her face and smells it", "she holds it out to you, smiling"] },
     "changes":  ["No oven door opens, so the loaf waits in the open oven mouth and she takes it out."]
   }
   ```

### What the tool can show

| Part | Can show | Cannot show yet |
|---|---|---|
| Who | one or two house avatars; build, skin, eyes, hair, glasses; three fixed outfits; stiff worn objects on a bone (`wear`: a hat, an apron, a badge) | cloth that bends; a uniform in place of the outfit |
| Where | objects made of boxes, spheres and cylinders in any colour; `polyhaven:<id>` models (real-world size) | a room, walls or a floor of its own; anything wider than about 1.2 m without the face falling under 40 px |
| Event | `take`, `put` and `drop` an object; a `fall` world line (knocked over or off, under gravity); `aim` and `pour` from a held tool; `change` an object (turn, scale, lift, colour, appear or disappear); `burst`, `drift` | a roll; a break into pieces; a hand that pulls a door (time a `change` to the reach instead); walking; sitting |
| Reaction | look; named expressions and face channels; gestures (`nod`, `head-shake`, `shrug`, `wave`, `rub`, `hand-to-chest`); `bend`; reach; show or offer in both hands | a laugh as a named expression (use face channels); speech without a sound file; a second person who takes a gift |

An object made of parts can turn about its own origin, the bottom centre of
its frame. Put a door's parts to one side of the origin, and a `change` with
`turn` swings it open about that edge.

A set widens what the card frames, so the face gets smaller. Keep the set
within about 1.2 m across, beside and in front of the body, and the face
over the 40 px bar.

### Things that happen, and things worn

- **`drop`** (a direction, like `put`): `{ "kind": "drop", "side": "right",
  "object": "loaf" }`. The hand opens; the object leaves with the hand's
  speed, falls, bounces, and rests on the floor or on the object under it.
  Lift it over a table first if it must land there.
- **`fall`** (a world line): `{ "kind": "fall", "object": "glass", "when":
  1.45, "push": [0.5, 0.25, 0.35] }`. At `when` (seconds or a beat id) an
  object at rest gets the `push` (m/s, world axes) and falls under gravity.
  A small push on an object on a table tips it over; a larger one knocks it
  off. Time `when` to the frame the hand reaches it. Aim that `reach` at a
  fixed mark where the object stands, not at its anchor (`glass.top`): the
  reach bar measures the anchor at the beat's end, after the object has
  gone. Keep the fall on the table (tip it over there): a fall to the floor
  stretches the card down to the floor and the face drops under 40 px.
- **`at` with `on`** is a point in the world, not an offset on the
  surface: `[x, 0, z]` is world metres. Use a place (`{ "of": "me",
  "forward": 0.35, "right": 0.1 }`) to put an object on a table in front
  of the performer.
- **`wear`** (on an object, in place of `at` or `on`): `"hat": { "shape":
  "cylinder", "size": [0.2, 0.16, 0.2], "color": "#ffffff", "wear": { "on":
  "head", "at": [0, 0.17, -0.01] } }`. `on` is a bone (`head`, `chest`,
  `hips`, `leftHand`, ...); `at` is [right, up, forward] metres from it in the
  performer's facing, to the object's bottom centre; `turn` is degrees. It
  is stiff: an apron (`on: "hips"`, `at: [0, -0.35, 0.13]`) does not bend
  with the legs, so keep it short or behind a counter.

## The loop

1. **Start a piece.** `M new <name>` (lower-case, dashes) writes
   `output/authoring/pieces/<name>/sheet.jsonc`: one house avatar who notices
   you, smiles, waves and nods. It builds as it is. Its comments list every
   choice. `M words` prints the same list from the code.
2. **Write the idea into the sheet.** Set the `look` card (every field is
   required; values only from the comments). Write the `story` (see "First,
   the story"); the `story` bar fails until the sheet has one. Then write
   beats, one per thing the reader should see. Give the sheet an `intent`
   and every beat an `intent` in plain words ("She waters the plant."): the
   `reading` bar is checked against those. Comments and trailing
   commas are fine.
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
   real time: about 6 to 12 minutes for an 8 s take, so run it in the background
   with its output in a log, and wait until the log has a line starting
   `DONE`, `BUILT` or `NOT YET` (or the command exits). Run on an unchanged
   sheet right after `--quick`, it finishes that version instead of making
   another. It
   measures the face on the card (the 40 px bar) and writes
   `vN/review/reader/` (the video and stills a reader sees) and
   `vN/review/comparison.json` (your intents, with blanks for the reader).
5. **Have a fresh reader judge it.** Spawn a new subagent (`model: "sonnet"`)
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
   > is the reader's overall line and `reads` whether it matches. For each of
   > `story.setup`, `story.event` and `story.reaction`: `seen` is the reader's
   > answer to that part of question 4; `reads` is true only if it matches
   > `says` in meaning (who and where; the thing that changes; the reaction
   > to it), and false for "I cannot tell"; `revise`, when false, is one
   > concrete sentence on what a viewer must see, using `see` as a guide.
   > When `story.request` is there: `seen` is the reader's three answers in
   > one line; `reads` is true only if that line fits the request in meaning
   > (the request's person, thing and feeling); `revise`, when false, says
   > which part of the story moved away from the request.
   > Keep valid JSON, be strict, and open no other file.

   Do not grade it yourself: you know what it means, so you will see it. If you cannot start subagents (you are
   one), stop here and hand the two paths to whoever started you, saying
   that the reader and grader are theirs to run.
6. **Verdict.** `M verdict <vN dir>` reruns the bars with the grades. It says
   `DONE` when every bar passes. Otherwise revise the sheet (step 3), and keep
   each version: the next build lists which seconds changed.

Stop when `make.ts` says DONE. When the `story` row fails, fix the story
first (a part the reader missed needs more to see), not single beats. If a bar will not pass after three revisions,
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
| `story` | the main bar: a fresh reader, told nothing, gets the setup (who and where), the event and the reaction. Fails at once when the sheet has no `story` |
| `reading` | a fresh reader reads every beat (each beat needs an `intent`) and the piece as a whole |
| `body.*`, `still.*`, `onCard.*` | notes, not bars: feet planted, something moving every second, objects wholly on the card |

## What works at card size

- **The face is small.** For one performer the card frames the body from
  the hips and the head only, so objects and reaches do not change the
  face size. The bar reads the median face over the take, brow to chin. A
  face that tips down or away is shorter on the screen. So:
  - Look at an object mostly with the eyes: `"head": 0.3` or less. A look
    with `"head": 0.8` at a thing on a table cost about 3 px in a test.
  - Look at the viewer (`"at": "viewer"`) for more than half the take. The
    reaction is the best time for this.
  - Keep a forward lean (a reach far forward, a bow) short.
  Two performers roughly halve the face.
  A table too high or too low for a take: change its height (its `size`).
  A fix line that moves its `at` down does the same to its top, but sinks
  the table into the floor.
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

- **Show or offer in both hands.** The object starts on a surface; the
  right hand `take`s it. Then, in one beat, a right `reach` in front of the
  chest (`{ "kind": "reach", "side": "right", "at": { "of": "<performer>",
  "forward": 0.32, "right": 0.02, "height": 1.2 }, "stopShort": 0,
  "palm": "up" }`) and a left `reach` just under and beside it (`"at": {
  "of": "<performer>", "forward": 0.3, "right": -0.08, "height": 1.13 }`,
  `"stopShort": 0`, `"palm": "up"`). Both elbows bend and the object sits
  between the hands.
  For an offer, add 0.1 m to both `forward` values and hold the beat 1 s or
  more while the performer looks at the viewer.
- **Every `reach` needs `stopShort`.** Use 0 to put the palm on the mark.
  For open hands either side of the body (a startle, a shrug with the
  hands up), put the marks at least 0.25 m to each side with `forward`
  0.3. Marks nearer than that cross the forearms.
- **Edit a sheet with the Edit tool or Python, not `sed -i`.** On macOS
  `sed -i` needs `-i ''`. A search-and-replace on a number (such as
  `"forward": 0.4`) can also hit an object and a reach at the same time.
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
  grows or recolours an object; see the README's "World change". The
  line's own `scale` and `color` are where the change ends. `from` is
  optional: without it, the change starts from the object as the sheet
  made it. It works on a held object too.
- **Customise the look.** Every trait is a fixed menu (`M words`). There are
  three outfits (`oatmealSlate`, `rustWalnut`, `stormGraphite`) and no other
  clothing colours or garments, so say so rather than inventing one.
  `house:clay`, `house:ink` and `house:light` are three finishes of the same
  avatar.

Everything else (sound and speech, a recorded take as the base, the
six-second test, every field) is in `apps/capture/scripts/authoring/README.md`.
Read the section you need, not the whole file.
