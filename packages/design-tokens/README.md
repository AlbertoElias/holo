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
