// The handedness pair in an app's settings (brief Q8): a choice of two words,
// right-handed first, the chosen one marked by the choice group's dot.
import type { Handedness, HitInput } from "@holoim/xr-ui-core";

import { ChoiceGroup } from "./ChoiceGroup.js";

export interface HandednessPickerProps {
  value: Handedness;
  onChange: (handedness: Handedness) => void;
  input?: HitInput;
}

const OPTIONS: ReadonlyArray<{ value: Handedness; label: string }> = [
  { value: "right", label: "Right-handed" },
  { value: "left", label: "Left-handed" }
];

export function HandednessPicker({ value, onChange, input }: HandednessPickerProps) {
  return <ChoiceGroup label="Dominant hand" value={value} options={OPTIONS} onChange={onChange} {...(input ? { input } : {})} />;
}
