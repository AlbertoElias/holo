// The handedness pair in an app's settings (brief Q8): a radio group of two
// words, right-handed first, with the choice said in words beneath, since an
// option has no selected look in the styleguide yet (brief, slice 4,
// placeholder).
import { nonDominantHand, type Handedness, type HitInput } from "@holoim/xr-ui-core";

import { GlyphControl } from "./GlyphControl.js";
import { Type } from "./typeRoles.js";

export interface HandednessPickerProps {
  value: Handedness;
  onChange: (handedness: Handedness) => void;
  /** What sits on the non-dominant wrist in a headset, for the sentence beneath: "Record", "Exit AR". */
  wristControl: string;
  input?: HitInput;
}

const OPTIONS: ReadonlyArray<{ value: Handedness; label: string }> = [
  { value: "right", label: "Right-handed" },
  { value: "left", label: "Left-handed" }
];

export function HandednessPicker({ value, onChange, wristControl, input }: HandednessPickerProps) {
  const chosen = OPTIONS.find((option) => option.value === value)!;
  return (
    <>
      <div role="radiogroup" aria-label="Dominant hand" style={{ display: "flex", flexWrap: "wrap" }}>
        {OPTIONS.map((option) => (
          <GlyphControl
            glyph={null}
            key={option.value}
            role="radio"
            aria-checked={value === option.value}
            label={option.label}
            {...(input ? { input } : {})}
            onPress={() => onChange(option.value)}
          />
        ))}
      </div>
      <Type variant="captionUnderCard" as="p" style={{ margin: 0 }}>
        {chosen.label}: in a headset, {wristControl} sits on your {nonDominantHand(value)} wrist.
      </Type>
    </>
  );
}
