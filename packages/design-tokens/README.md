# @holoim/design-tokens

Typed values and CSS custom properties generated from
[`docs/product/design/tokens.json`](../../docs/product/design/tokens.json),
the machine-readable copy of the [styleguide](../../docs/product/design/styleguide.md)
(which wins where the two differ). Edit the token file, then run
`pnpm --filter @holoim/design-tokens run generate` and commit the outputs.
The package's `test` fails while they are out of date.

| Import | What |
| --- | --- |
| `@holoim/design-tokens` | `tokens` (sRGB hex colours, apx sizes, ms durations, shares of the short side), `apxToMeters`, `hitAreaMeters` |
| `@holoim/design-tokens/three` | `tokenColor(hex)` (sRGB, converted once) and `chromeMaterial` (`toneMapped: false`) |
| `@holoim/design-tokens/tokens.css` | `--holoim-*` custom properties; colours also as `--holoim-…-rgb` triplets |
| `@holoim/design-tokens/fonts.css` | Self-hosted Fraunces and Figtree (variable WOFF2, OFL) |
| `@holoim/design-tokens/tokens.json` | The same values, flat, for tools that do not read TypeScript |

Only tokens with a `$value` are generated. Copying a token colour by hand
fails lint (`holoim/no-token-colour-literal` in `@holoim/config-eslint`, and
`check-css-literals.mjs` for CSS).

## MSDF atlases

`src/fonts/msdf/` holds the multi-channel distance-field atlases 3D text uses
(`<face>-<weight>.json` in the BMFont layout `@pmndrs/uikit` reads, plus the
PNG it names), exported as `@holoim/design-tokens/msdf/*`. Weights: Fraunces
600 (titles, optical size pinned at 32) and Figtree 400, 500 and 600, from the
`latin` fonts above. Charset: printable ASCII, Latin-1 Supplement, and
‘ ’ “ ” – — … · • × (glyphs a font lacks are skipped; Figtree has no U+00AD).
Each atlas is 1024 px, font size 42, field range 4, overlaps fixed.

Re-bake after changing a font or the weights: `pnpm --filter
@holoim/design-tokens run bake:msdf`, then commit the outputs; the result is
byte-for-byte reproducible. It needs `python3` with `fonttools` and `brotli`
(`HOLOIM_PYTHON` points at another interpreter) to pin the variable axes, and
runs `@zappar/msdf-generator` (msdfgen as WASM) in a Node worker thread, so no
browser is needed. `src/msdf.test.ts` fails when an atlas loses a character,
is not `msdf`, or points at a missing PNG.
