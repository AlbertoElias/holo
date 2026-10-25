// The edge as SVG: the same points from the same seed everywhere (styleguide 3.1, 3.3, 8.5).
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VIEW_TARGETS, edgeFrame, edgeOutline, edgePathData, edgeStrokes } from "@holoim/xr-ui-core";

import { EdgeSvg, type EdgeSvgProps } from "./EdgeSvg.js";

function draw(props: Partial<EdgeSvgProps> = {}) {
  const { container } = render(<EdgeSvg seed="hologram-1" width={400} height={300} {...props} />);
  return container;
}

const paths = (container: HTMLElement) => Array.from(container.querySelectorAll<SVGPathElement>("path"));

describe("same outline from the same seed (3.1)", () => {
  it("draws every stroke with the core's points for the seed, in the order soot, halo, core, highlight", () => {
    const expected = edgePathData(edgeOutline({ seed: "hologram-1", width: 400, height: 300 }).points);
    const drawn = paths(draw());
    expect(drawn.map((path) => path.getAttribute("data-edge"))).toEqual(["soot", "halo", "core", "highlight"]);
    for (const path of drawn) expect(path.getAttribute("d")).toBe(expected);
  });

  it("matches between two cards with one seed, and differs for another seed", () => {
    const first = paths(draw())[0]!.getAttribute("d");
    document.body.innerHTML = "";
    const second = paths(draw())[0]!.getAttribute("d");
    document.body.innerHTML = "";
    const other = paths(draw({ seed: "hologram-2" }))[0]!.getAttribute("d");
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe("strokes (3.2, 3.3)", () => {
  it("takes widths and colours from the core's strokes for the short side", () => {
    const strokes = edgeStrokes(300);
    const [soot, halo, core, highlight] = paths(draw());
    expect(Number(halo!.getAttribute("stroke-width"))).toBeCloseTo(strokes.halo.width);
    expect(Number(soot!.getAttribute("stroke-width"))).toBeCloseTo(strokes.soot.width);
    expect(Number(core!.getAttribute("stroke-width"))).toBeCloseTo(strokes.core.width);
    expect(Number(highlight!.getAttribute("stroke-width"))).toBeCloseTo(strokes.highlight.width);
    expect(halo!.getAttribute("stroke")).toBe(strokes.halo.color);
    expect(soot!.getAttribute("stroke")).toBe(strokes.soot.color);
    expect(core!.getAttribute("stroke")).toBe(strokes.core.color);
    expect(highlight!.getAttribute("stroke")).toBe(strokes.highlight.color);
  });

  it("blurs the halo and the soot by half the halo's width, and leaves the core and highlight sharp", () => {
    const container = draw();
    const [soot, halo, core, highlight] = paths(container);
    for (const path of [soot!, halo!]) {
      const id = /url\(#(.+)\)/.exec(path.getAttribute("filter")!)![1]!;
      const blur = container.querySelector(`[id="${id}"] feGaussianBlur`)!;
      expect(Number(blur.getAttribute("stdDeviation"))).toBeCloseTo(Number(path.getAttribute("stroke-width")) / 2);
    }
    expect(core!.getAttribute("filter")).toBeNull();
    expect(highlight!.getAttribute("filter")).toBeNull();
  });

  it("gives each instance its own filter ids", () => {
    const { container } = render(<div><EdgeSvg seed="a" width={400} height={300} /><EdgeSvg seed="a" width={400} height={300} /></div>);
    const ids = Array.from(container.querySelectorAll("filter")).map((filter) => filter.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("is hidden from assistive technology and takes no pointer events", () => {
    const svg = draw().querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.style.pointerEvents).toBe("none");
  });
});

describe("opacities from the frame (3.2, 8.5)", () => {
  const frameOptions = { timeMs: 0, reducedMotion: false, inFocus: true, soot: { groundLuminance: 0 } } as const;
  const opacities = (container: HTMLElement) => paths(container).map((path) => Number(path.getAttribute("opacity")));

  it("rests at glow 0.5, no soot, core and highlight full", () => {
    expect(opacities(draw())).toEqual([0, 0.5, 1, 1]);
  });

  it("follows the frame: glow level, soot opacity, core and highlight", () => {
    const frame = edgeFrame(VIEW_TARGETS.desktop, { ...frameOptions, recording: false, soot: { groundLuminance: 0.16 } });
    expect(frame.sootOpacity).toBeGreaterThan(0);
    expect(opacities(draw({ frame }))).toEqual([frame.sootOpacity, frame.glowLevel, frame.coreOpacity, frame.highlightOpacity]);
  });

  it("holds the halo at 0.08 and core and highlight at 0.55 while recording on a flat screen", () => {
    const frame = edgeFrame(VIEW_TARGETS.phone, { ...frameOptions, recording: true });
    expect(opacities(draw({ frame }))).toEqual([0, 0.08, 0.55, 0.55]);
  });

  it("draws nothing while the frame says it is not drawn (a headset recording)", () => {
    const frame = edgeFrame(VIEW_TARGETS.vr, { ...frameOptions, recording: true });
    expect(frame.drawn).toBe(false);
    expect(draw({ frame }).querySelector("svg")).toBeNull();
  });
});
