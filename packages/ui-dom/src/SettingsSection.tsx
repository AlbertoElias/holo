// A titled group in a settings sheet, in both apps: a quiet heading over its
// controls, a glyph gap between them. The sheet itself spaces sections two
// glyph gaps apart, so a section adds no outer margin.
import type { ReactNode } from "react";

import { glyphMetrics } from "@holoim/xr-ui-core";

import { Type } from "./typeRoles.js";

export function SettingsSection({ title, children }: { title: string; children?: ReactNode }) {
  const gap = glyphMetrics({ headset: false }).gapApx;
  return (
    <section style={{ display: "grid", gap }}>
      <Type variant="byline" as="h3" style={{ margin: 0 }}>
        {title}
      </Type>
      {children}
    </section>
  );
}
