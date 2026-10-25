// Type roles: two voices (styleguide 7), changing numbers never shift (7.2).
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { tokens } from "@holoim/design-tokens";
import { TYPE_ROLES } from "@holoim/xr-ui-core";

import { cssRgb } from "./testHelpers.js";
import { Type, typeRoleStyle } from "./typeRoles.js";

describe("type roles (7)", () => {
  it("sets the timecode in tabular numbers so changing numbers never shift (7.2), and no other role", () => {
    expect(typeRoleStyle("timecode").fontVariantNumeric).toBe("tabular-nums");
    for (const role of TYPE_ROLES.filter((candidate) => candidate !== "timecode")) {
      expect(typeRoleStyle(role).fontVariantNumeric).toBeUndefined();
    }
  });

  it("sets titles and the wordmark in Fraunces with optical sizing, and everything else in Figtree", () => {
    for (const role of ["titleDesktop", "titlePhoneCard", "wordmarkPhone"] as const) {
      expect(typeRoleStyle(role).fontFamily).toBe('"Fraunces", "Georgia", serif');
      expect(typeRoleStyle(role).fontOpticalSizing).toBe("auto");
    }
    for (const role of ["captionOnHologram", "captionUnderCard", "byline", "controlLabel", "timecode", "note", "authorInitial"] as const) {
      expect(typeRoleStyle(role).fontFamily).toBe('"Figtree", system-ui, sans-serif');
      expect(typeRoleStyle(role).fontOpticalSizing).toBeUndefined();
    }
  });

  it("takes weight, size, line height and spacing from the type tokens", () => {
    const title = typeRoleStyle("titleDesktop");
    expect(title.fontWeight).toBe(tokens.type.titleDesktop.fontWeight);
    expect(title.fontSize).toBe(`${tokens.type.titleDesktop.fontSize}px`);
    expect(title.lineHeight).toBe(tokens.type.titleDesktop.lineHeight);
    expect(title.letterSpacing).toBe("0px");
  });

  it("colours the roles: byline muted, control label gold, titles cream", () => {
    expect(typeRoleStyle("byline").color).toBe(tokens.color.textMuted);
    expect(typeRoleStyle("controlLabel").color).toBe(tokens.color.gold);
    expect(typeRoleStyle("titleDesktop").color).toBe(tokens.color.text);
  });

  it("renders <Type> as the element asked for, in the role's style", () => {
    const { container } = render(<Type variant="byline" as="p">by Ana</Type>);
    const element = container.firstElementChild as HTMLElement;
    expect(element.tagName).toBe("P");
    expect(element.textContent).toBe("by Ana");
    expect(element.style.color).toBe(cssRgb(tokens.color.textMuted));
    expect(element.style.fontFamily).toContain("Figtree");
    expect(render(<Type variant="byline">x</Type>).container.lastElementChild!.tagName).toBe("SPAN");
  });
});
