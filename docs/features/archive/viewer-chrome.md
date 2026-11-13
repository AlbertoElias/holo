# Feature brief: simpler viewer chrome

**Lead:** Claude (Opus)
**Status:** Complete (2026-11-13)
**Layer:** view (`docs/product/concepts/what-a-hologram-is.md`)

## User outcome

A viewer sees a calm, centred control row under each hologram: playback on
one side of Play, ways out of the screen on the other. Finding and settings
wait in the top right corner as two glyphs. The Settings sheet's account
section reads as one group.

## Scope

**Included:**

- The card's control row becomes timecode and sound left of Play, and the
  ways out of the screen the device has (View in your room, AR Quick Look,
  Step inside) plus Return (only after the viewer has moved the view) right
  of Play. A phone has at most one of these, a desktop none; only a headset
  shows both View in your room and Step inside.
- Removed from the row: Copy link (the title already links to `/h/:id`),
  Free / Look around (a drag, the wheel or the arrow keys already move the
  view), and the highlights toggle (the author's marks always show).
- Delete, for the creator only, moves from the row to a word at the end of
  the card's byline, still behind a confirmation.
- Search leaves the feed's bottom dock for the top right corner, as a lens
  glyph beside Settings; Settings becomes a glyph too (sliders). The dock
  holds Upload alone.
- The Settings account section: name and email as one block, Sign out on the
  same row, no divider.

**Excluded:** the experimental tilt portal variant keeps its tilt glyph; the
XR (AR/VR) shells, capture, and the share sheet on touch phones (the
browser's own long-press share on the title link remains).

## Undo

None: the viewer has no authoring actions.

## Acceptance criteria

- [x] On a card that has sound and can enter AR or VR, the reached row reads
      timecode, sound | Play | enter, with Play in the middle of the card.
- [x] After a drag moves the view, Return shows right of Play and puts the
      view back; no Look around, highlights or Copy link glyph exists.
- [x] A headset that supports both AR and VR keeps both View in your room
      and Step inside, so stepping inside stays reachable there.
- [x] The creator sees "Delete" in the byline; a visitor does not; deleting
      still asks first and leaves the hologram's page for the feed.
- [x] Search and Settings are glyphs in the top right corner; the dock holds
      Upload alone; a long title stops short of the corner.
- [x] The Settings sheet shows the name over the email with Sign out on the
      same row, and no divider.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Play drifts off centre with unequal sides | Row keeps Play's middle (existing mechanism); redesign spec measures it |
| Return hidden or missing after a drag | pointing / place specs drive a drag and check `data-portal-mode` and Return |
| Owner loses the only way to delete | profiles spec deletes from the byline |
| Corner glyphs collide with a long title | redesign spec measures the title against the corner |
| Touch reveals a hidden reach glyph and fires it on the same tap | Existing reach guard unchanged; sound moves to the "before" reach side, which shares the guard |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead / implementer | Claude (Opus) | `apps/viewer-web`, `packages/ui-dom`, styleguide, tokens |
| Independent verifier | Codex (`-p standard`); Opus design-reviewer stood in (Codex at its usage limit, Muse billing error) | Screenshot review against the styleguide |

## Design decision

The user chose a balanced row with playback on one side (2026-11-13) over a
"more" menu or moving the enter actions under the title, and asked whether
anything beyond one enter glyph and a reset was needed. Look around is
already the default drag; Return is the reset. Showing only one enter glyph
on a headset was rejected: it would leave Step inside unreachable on a Quest,
the one device that has both. Settings becomes a glyph so
the corner reads as one pair with Search.

On a phone the two sides do not both fit beside Play (the paused timecode
plus sound alone outgrow half the card), so both groups unfold together on
one line above Play, parting at Play's axis: playback left, ways out right.
The timecode reserves its paused width so sound does not shift when the
viewer pauses. A desktop keeps the single row.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Row layout, corner, dock | `redesign.spec.ts` | 9 passed; with `portal.spec.ts` 23 passed |
| Delete in byline | `profiles.pipeline.spec.ts` | passed in `verify:pr` (pipeline) |
| Return after drag, no toggle | `pointing.pipeline.spec.ts` | passed in `verify:pr` (pipeline) |
| Whole viewer | `pnpm run verify:pr` | all stages passed (2026-11-13) |
| Screenshots vs styleguide | design review (Opus; Codex and Muse unavailable that day) | 2 real findings fixed: timecode padding on the upper chip, and the styleguide now says the playback group grows away from Play's axis on pause |

## Physical-device limits

The headset row (both enter glyphs) is checked in IWER emulation, not on a
Quest.
