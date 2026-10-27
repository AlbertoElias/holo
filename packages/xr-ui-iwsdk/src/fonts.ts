// Figtree (styleguide §7, font.ui), generated as MSDF atlases from the OFL
// TTFs (fonts/OFL.txt) with @zappar/msdf-generator: printable ASCII plus
// "·×–—…". UIKit's default is Inter; every root sets these instead. UIKit
// fetches each weight's atlas on first use; the bundler emits it as an asset.
export const FONT_FAMILY = "figtree";

export const FONT_FAMILIES = {
  [FONT_FAMILY]: {
    400: new URL("./fonts/figtree-regular.json", import.meta.url).href,
    500: new URL("./fonts/figtree-medium.json", import.meta.url).href
  }
};
