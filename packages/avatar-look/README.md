# @holoim/avatar-look

The house base's traits and the dressing function (slice 2d of
`docs/features/directed-performance.md`).

- `SKIN`, `EYES`, `HAIR_COLOUR`, `HAIR_STYLES`, `GLASSES`, `BUILDS`, `CLOTHING`:
  every value a look card may name, colours in sRGB 0–255 from the
  clay-traits sheet; `linear()` converts to a glTF base colour factor.
- `LookCard`, `parseLook(input)` (throws naming every bad trait), `lookKey(card)`.
- `dressAvatar(doc, card)`: dresses a house-base wardrobe (a glTF-Transform
  `Document` of one build, carrying every `Hair_<style>` and `Glasses_<kind>`)
  in place: keeps the card's hair and glasses, removes the rest, sets the
  skin, iris, hair, brow, top and trouser colours, and records the card in
  the scene's `holoimAvatar` extras.

Used by `apps/capture/scripts/authoring/direct.ts` (a performer's `look`) and
`house-base.ts` (the default look of `public/gltf/models/house-base.glb`).
