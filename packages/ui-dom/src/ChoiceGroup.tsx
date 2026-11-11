// A choice of one among a few words in settings (a pair of hands, on or off):
// a radio group where each option is a ring that holds a dot when chosen, and
// its word beside it. The dot is the selected look, drawn like every glyph in
// thin gold line (styleguide 6); gold is never a fill, so the choice is
// carried by the dot alone. Options sit two glyph gaps apart, so a keyboard
// focus ring has room on every side.
import { glyphMetrics, type HitInput } from "@holoim/xr-ui-core";

import { GlyphButton } from "./GlyphButton.js";

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
}

export interface ChoiceGroupProps<T extends string> {
  /** The group's accessible name. */
  label: string;
  value: T;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (value: T) => void;
  input?: HitInput;
}

/** The radio mark, in the 16 × 16 glyph box: a ring, and a dot when chosen. */
function RadioMark({ checked, color, strokeApx }: { checked: boolean; color: string; strokeApx: number }) {
  return (
    <svg viewBox="0 0 16 16" width="100%" height="100%" aria-hidden="true" focusable="false" style={{ display: "block" }}>
      <circle cx="8" cy="8" r={8 - strokeApx} fill="none" stroke={color} strokeWidth={strokeApx} />
      {checked ? <circle cx="8" cy="8" r="3.5" fill={color} /> : null}
    </svg>
  );
}

export function ChoiceGroup<T extends string>({ label, value, options, onChange, input }: ChoiceGroupProps<T>) {
  const metrics = glyphMetrics({ headset: false });
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "flex", flexWrap: "wrap", columnGap: metrics.gapApx * 2, rowGap: metrics.gapApx / 2 }}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <GlyphButton
            key={option.value}
            label={option.label}
            drawnApx={metrics.iconApx}
            showLabel
            {...(input ? { input } : {})}
            attributes={{ role: "radio", "aria-checked": checked }}
            onPress={() => onChange(option.value)}
          >
            {(appearance) => <RadioMark checked={checked} color={appearance.color} strokeApx={metrics.strokeApx} />}
          </GlyphButton>
        );
      })}
    </div>
  );
}
