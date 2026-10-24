// A card's golden edge (styleguide 3, 8): the seeded outline from
// `@holoim/ui-dom`'s EdgeSvg, soot from the ground behind the card, and on
// the card in focus alone the flicker and the sparks (8.2). The others hold
// a steady glow at the resting level and do not redraw.
import { useEffect, useMemo, useRef, useState } from "react";

import { tokens } from "@holoim/design-tokens";
import { EdgeSvg } from "@holoim/ui-dom";
import {
  seededRandom,
  createSpark,
  edgeFrame,
  edgeOutline,
  flatGroundColorAt,
  haloLayers,
  relativeLuminance,
  type EdgeFrame,
  type Spark,
  type ViewTarget
} from "@holoim/xr-ui-core";

type PortalEdgeProps = {
  seed: string;
  width: number;
  height: number;
  target: ViewTarget;
  inFocus: boolean;
  reducedMotion: boolean;
  /** Where the card's foot sits on the screen, 0 at the top to 1 at the bottom: the ground behind the edge. */
  groundFraction: number;
};

type LiveSpark = Spark & { bornMs: number };

/** The luminance of the flat ground at a share of the way down the screen (3.2). */
export function groundLuminanceAt(fraction: number): number {
  return relativeLuminance(flatGroundColorAt(fraction));
}

function restingFrame(target: ViewTarget, groundLuminance: number): EdgeFrame {
  const layers = haloLayers(target, tokens.edge.halo.level, { groundLuminance });
  return { drawn: true, glowLevel: layers.glowLevel, sootOpacity: layers.sootOpacity, coreOpacity: 1, highlightOpacity: 1, sparks: 0 };
}

export function PortalEdge({ seed, width, height, target, inFocus, reducedMotion, groundFraction }: PortalEdgeProps) {
  const groundLuminance = groundLuminanceAt(groundFraction);
  const [frame, setFrame] = useState<EdgeFrame>(() => restingFrame(target, groundLuminance));
  const sparksRef = useRef<HTMLCanvasElement>(null);
  const outline = useMemo(() => edgeOutline({ seed, width, height }), [seed, width, height]);
  const deviceKey = target.kind === "flat" ? target.device : target.kind;

  useEffect(() => {
    if (!inFocus) {
      setFrame(restingFrame(target, groundLuminance));
      const canvas = sparksRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      return undefined;
    }

    const random = seededRandom(`${seed}:sparks`);
    const live: LiveSpark[] = [];
    const start = performance.now();
    let handle = 0;
    const tick = (now: number) => {
      const timeMs = now - start;
      const next = edgeFrame(target, { timeMs, recording: false, inFocus: true, reducedMotion, soot: { groundLuminance } });
      setFrame(next);
      drawSparks(sparksRef.current, live, next.sparks, now, random, outline.points, outline.shortSide);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
    // `target` is compared by its device, so an inline literal does not restart the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFocus, reducedMotion, groundLuminance, seed, outline, deviceKey]);

  const ratio = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  return (
    <div className="feed-card-edge" aria-hidden="true" data-edge-focus={inFocus ? "true" : "false"} data-edge-sparks={String(frame.sparks)}>
      <EdgeSvg seed={seed} width={width} height={height} frame={frame} />
      <canvas
        ref={sparksRef}
        className="feed-card-sparks"
        width={Math.round(width * ratio)}
        height={Math.round(height * ratio)}
        style={{ width, height }}
      />
    </div>
  );
}

/**
 * Embers (8.2): each rises off a random point of the edge, a gold dot of
 * 0.4% to 0.8% of the short side, fading over its 2 to 4 s life. It climbs
 * the halo's width, so it leaves within the glow it came from.
 */
function drawSparks(
  canvas: HTMLCanvasElement | null,
  live: LiveSpark[],
  count: number,
  now: number,
  random: () => number,
  points: readonly { x: number; y: number }[],
  shortSide: number
): void {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  for (let i = live.length - 1; i >= 0; i -= 1) {
    const spark = live[i]!;
    if (now - spark.bornMs >= spark.lifeMs) live.splice(i, 1);
  }
  while (live.length < count) {
    // Staggered births, so a fresh card does not light all its sparks at once.
    const spark = createSpark(random);
    live.push({ ...spark, bornMs: now - random() * spark.lifeMs });
  }
  if (live.length > count) live.length = count;

  const scale = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = tokens.color.gold;
  const rise = tokens.edge.halo.width * shortSide;
  for (const spark of live) {
    const age = (now - spark.bornMs) / spark.lifeMs;
    const point = points[Math.floor(spark.along * points.length) % points.length]!;
    context.globalAlpha = Math.max(0, 1 - age);
    context.beginPath();
    context.arc(point.x, point.y - rise * age, (spark.size * shortSide) / 2, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
}
