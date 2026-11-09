import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

import { tokens } from '@holoim/design-tokens';
import { GlyphSvg, Type, fontStack, useReducedMotion } from '@holoim/ui-dom';
import {
  PHONE_EDGES,
  PROVISIONAL_GLYPHS,
  chromeTransition,
  glyphAppearance,
  glyphDrawing,
  glyphMetrics,
  hitAreaApx,
  type GlyphDrawing,
  type HitInput,
  type ProvisionalGlyphName
} from '@holoim/xr-ui-core';

import type { TrayUiState } from '../types/contracts';
import type { CaptureUiBridge } from './captureUiBridge';

// The tray on a flat screen (docs/features/archive/tray-everywhere.md, decision 5):
// the dock's Tray and Find glyphs and a row of five slots above the dock.
// DOM chrome, never recorded.

const SLOTS = 5;
const TILE_APX = 54;
const TOUCH_TILE_APX = 44;
/** A slot dragged further than this (half a touch target) is no longer a click (styleguide 6.1). */
const DRAG_SLOP_APX = 22;
/** A slot dragged up past this and let go leaves the tray (docs/features/tray-remove.md). */
const LIFT_OFF_APX = 30;
/** Touch: a press held this long on the Tray glyph starts press-hold-slide. */
const HOLD_MS = 300;
/** Height of a dock row on its chip: the glyph's hit area plus the chip's 5 apx padding twice. */
function dockHeightApx(input: HitInput): number {
  return hitAreaApx(input, glyphMetrics({ headset: false }).iconApx) + tokens.chip.paddingBlock * 2;
}

/** Distance from the screen bottom to the top of a one-row dock, plus one gap. */
export function aboveDockApx(input: HitInput): string {
  return `calc(max(env(safe-area-inset-bottom), ${PHONE_EDGES.bottom}px) + ${dockHeightApx(input) + glyphMetrics({ headset: false }).gapApx}px)`;
}

/**
 * Distance from the screen bottom to the top of the dock as laid out, plus one
 * gap: a dock unfolded onto a second line lifts what sits above it. Falls back
 * to the one-row height until the dock has been measured.
 */
export function useAboveDock(input: HitInput): string {
  const [measured, setMeasured] = useState<number | null>(null);
  useEffect(() => {
    const row = document.querySelector<HTMLElement>('[data-capture-dock] [data-dock-row]');
    if (!row) return undefined;
    const measure = () => setMeasured(Math.round(window.innerHeight - row.getBoundingClientRect().top));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return measured === null ? aboveDockApx(input) : `${measured + glyphMetrics({ headset: false }).gapApx}px`;
}

function drawingOf(name: DockTrayGlyph): GlyphDrawing {
  if (name === 'tray') return glyphDrawing('tray');
  return { kind: 'path', d: PROVISIONAL_GLYPHS[name].d, fill: false, linejoin: 'round', ringed: false, drawnApx: tokens.glyph.icon };
}

/** The dock's Tray and Find: Tray is drawn from tokens.json, Find's lens is still provisional. */
type DockTrayGlyph = 'tray' | ProvisionalGlyphName;

/** A dock glyph action that may carry a provisional drawing (GlyphControl takes only decided drawings). */
export function DockGlyphButton({
  glyph,
  label,
  title,
  highlighted = false,
  expanded,
  input,
  onPress,
  pointerHandlers,
  testId
}: {
  glyph: DockTrayGlyph;
  label: string;
  title?: string;
  highlighted?: boolean;
  expanded?: boolean;
  input: HitInput;
  onPress: () => void;
  pointerHandlers?: {
    onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerMove?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerUp?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerCancel?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  };
  testId: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const base = glyphAppearance({ hovered, focusVisible, pressed }, { headset: false });
  // The open state takes the cream highlight the hover lift uses.
  const appearance = highlighted ? { ...base, color: tokens.color.highlight } : base;
  const hit = hitAreaApx(input, tokens.glyph.icon);
  const ring = appearance.focusRing;
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={expanded}
      data-testid={testId}
      data-open={highlighted ? 'true' : 'false'}
      onClick={onPress}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') setHovered(true); }}
      onPointerLeave={() => { setHovered(false); setPressed(false); }}
      onPointerDown={(event) => { setPressed(true); pointerHandlers?.onPointerDown?.(event); }}
      onPointerMove={pointerHandlers?.onPointerMove}
      onPointerUp={(event) => { setPressed(false); pointerHandlers?.onPointerUp?.(event); }}
      onPointerCancel={(event) => { setPressed(false); pointerHandlers?.onPointerCancel?.(event); }}
      onFocus={(event) => setFocusVisible(event.currentTarget.matches(':focus-visible'))}
      onBlur={() => { setFocusVisible(false); setPressed(false); }}
      style={{
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: hit,
        minHeight: hit,
        padding: 0,
        margin: 0,
        border: 'none',
        background: 'transparent',
        outline: 'none',
        cursor: 'pointer',
        color: appearance.color,
        opacity: appearance.opacity,
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'none'
      }}
    >
      <span
        data-glyph-visual=""
        style={{
          display: 'inline-flex',
          width: tokens.glyph.icon,
          height: tokens.glyph.icon,
          borderRadius: '50%',
          outline: ring ? `${ring.width}px solid ${ring.color}` : 'none',
          outlineOffset: ring ? `${ring.offset}px` : undefined
        }}
      >
        <GlyphSvg drawing={drawingOf(glyph)} appearance={appearance} />
      </span>
    </button>
  );
}

/**
 * The Tray glyph: a click or tap toggles the tray; on touch a press held
 * HOLD_MS then slid onto a slot and lifted summons it and closes. Touch
 * captures the pointer, so the slot under the finger is found with
 * `elementFromPoint` (the glyph's own events are the only ones that arrive).
 */
export function useTrayGlyph(bridge: CaptureUiBridge, open: boolean, touch: boolean, openedByUi: React.MutableRefObject<boolean>) {
  const [armedSlot, setArmedSlot] = useState<number | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
  const swallowClick = useRef(false);

  const slotAt = (x: number, y: number): number | null => {
    const slot = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-tray-slot]');
    const n = slot ? Number(slot.dataset.traySlot) : NaN;
    return Number.isFinite(n) && slot?.dataset.trayFilled === 'true' ? n : null;
  };
  const clear = (): void => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holding.current = false;
    setArmedSlot(null);
  };
  const setOpen = (next: boolean): void => {
    openedByUi.current = next;
    bridge.setTrayOpen(next);
  };

  useEffect(() => clear, []);

  return {
    armedSlot,
    toggle: () => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      setOpen(!open);
    },
    pointerHandlers: {
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (!touch || event.pointerType === 'mouse') return;
        clear();
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          holding.current = true;
          setOpen(true);
        }, HOLD_MS);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (holding.current) setArmedSlot(slotAt(event.clientX, event.clientY));
      },
      onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (!holding.current) {
          clear();
          return;
        }
        const slot = slotAt(event.clientX, event.clientY);
        clear();
        // The click that follows this lift must not toggle the tray again.
        swallowClick.current = true;
        setTimeout(() => { swallowClick.current = false; }, 0);
        if (slot !== null) bridge.summonTraySlot(slot);
        setOpen(false);
      },
      onPointerCancel: () => clear()
    }
  };
}

function SlotFallbackGlyph({ kind }: { kind: 'model' | 'image' }) {
  // A globe for a model, a sun over a peak for an image (styleguide 6).
  const d = kind === 'model' ? tokens.glyph.path.slotModel.d : tokens.glyph.path.slotImage.d;
  return (
    <svg width={tokens.glyph.icon} height={tokens.glyph.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <path d={d} fill="none" stroke="var(--holoim-color-gold)" strokeWidth={tokens.glyph.stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Slot({
  slot,
  item,
  touch,
  blocked,
  loading,
  armed,
  tileApx,
  onSummon,
  onRemove
}: {
  slot: number;
  item: TrayUiState['slots'][number] | undefined;
  touch: boolean;
  blocked: boolean;
  loading: boolean;
  armed: boolean;
  tileApx: number;
  onSummon: (slot: number) => void;
  onRemove: (slot: number) => void;
}) {
  const stroke = tokens.glyph.stroke;
  const lift = useLiftOff(slot, onSummon, onRemove);
  const tile: CSSProperties = {
    position: 'relative',
    boxSizing: 'border-box',
    width: tileApx,
    height: tileApx,
    borderRadius: tokens.chip.radius / 2,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden'
  };
  const keycap = !touch ? (
    <span
      data-tray-keycap=""
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 2,
        left: 2,
        minWidth: 16,
        height: 16,
        boxSizing: 'border-box',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--holoim-color-deep-sea)',
        border: '1px solid var(--holoim-color-gold)',
        borderRadius: 4,
        color: 'var(--holoim-color-gold)',
        fontFamily: fontStack(tokens.type.controlLabel.fontFamily),
        fontSize: 11,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      {slot}
    </span>
  ) : null;

  if (item) {
    return (
      <div data-tray-slot-wrap="" style={{ display: 'grid', justifyItems: 'center', gap: 4, flexShrink: 0, width: tileApx, opacity: blocked ? 0.4 : 1 }}>
        <button
          type="button"
          data-tray-slot={slot}
          data-tray-filled="true"
          data-testid={`tray-slot-${slot}`}
          aria-label={`Summon ${item.name}`}
          aria-description="Drag up off the row to remove it from the tray"
          data-tray-lifting={lift.state}
          {...lift.handlers}
          style={{
            ...tile,
            padding: 0,
            cursor: lift.state === 'idle' ? 'pointer' : 'grabbing',
            transform: `translate(${lift.offset.x}px, ${lift.offset.y}px)`,
            opacity: lift.state === 'off' ? 0.55 : 1,
            transition: lift.state === 'idle' ? 'transform 200ms ease-out' : 'none',
            background: 'rgb(var(--holoim-color-deep-sea-rgb) / 72%)',
            // Lifted past the line, it shows it will leave on release: the highlight, like an armed slot.
            border: `${stroke}px solid ${armed || lift.state === 'off' ? 'var(--holoim-color-highlight)' : 'var(--holoim-color-gold)'}`,
            outline: armed ? `${stroke}px solid var(--holoim-color-highlight)` : 'none',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'none'
          }}
        >
          {item.thumbnail ? (
            <img src={item.thumbnail} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          ) : (
            <SlotFallbackGlyph kind={item.kind} />
          )}
          {keycap}
        </button>
        <span data-tray-caption="" style={captionStyle(tileApx)}>
          {item.name}
        </span>
      </div>
    );
  }

  return (
    <div data-tray-slot-wrap="" style={{ display: 'grid', justifyItems: 'center', gap: 4, flexShrink: 0, width: tileApx }}>
      <div
        data-tray-slot={slot}
        data-tray-filled="false"
        data-tray-loading={loading ? 'true' : 'false'}
        data-testid={`tray-slot-${slot}`}
        className={loading ? 'tray-slot-loading' : undefined}
        style={{
          ...tile,
          background: 'rgb(var(--holoim-color-deep-sea-rgb) / 72%)',
          border: `${stroke}px dashed rgb(var(--holoim-color-text-muted-rgb) / ${loading ? 90 : 55}%)`,
          color: 'var(--holoim-color-text-muted)'
        }}
      >
        {!touch ? (
          <span aria-hidden="true" style={{ fontFamily: fontStack(tokens.type.controlLabel.fontFamily), fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
            {slot}
          </span>
        ) : null}
      </div>
      <span style={{ height: 15 }} aria-hidden="true" />
    </div>
  );
}

/** Dragged up past LIFT_OFF_APX, more up than sideways: a slide along the row never removes. */
function liftedOff(x: number, y: number): boolean {
  return y < -LIFT_OFF_APX && -y > Math.abs(x);
}

/**
 * Lift a slot off the shelf (docs/features/tray-remove.md): a press that
 * stays within the slop is a click that summons; dragged up past
 * LIFT_OFF_APX and let go, the item leaves the tray; anything else snaps
 * back. The pointer is captured, so a touch drag keeps its events.
 */
function useLiftOff(slot: number, onSummon: (slot: number) => void, onRemove: (slot: number) => void) {
  const start = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const state: 'idle' | 'dragging' | 'off' = !start.current?.dragging ? 'idle' : liftedOff(offset.x, offset.y) ? 'off' : 'dragging';
  const end = (commit: boolean, event: ReactPointerEvent<HTMLButtonElement>): void => {
    const press = start.current;
    if (!press || press.id !== event.pointerId) return;
    start.current = null;
    setOffset({ x: 0, y: 0 });
    // A pointer leaves no focus on the slot: a key pressed next (Backspace to put back) is the scene's, not the slot's.
    event.currentTarget.blur();
    if (!commit) return;
    if (!press.dragging) onSummon(slot);
    else if (liftedOff(event.clientX - press.x, event.clientY - press.y)) onRemove(slot);
  };
  return {
    offset,
    state,
    handlers: {
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        start.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
        const press = start.current;
        if (!press || press.id !== event.pointerId) return;
        const x = event.clientX - press.x;
        const y = event.clientY - press.y;
        if (!press.dragging && Math.hypot(x, y) < DRAG_SLOP_APX) return;
        press.dragging = true;
        // It lifts up off the shelf, never down into the dock.
        setOffset({ x, y: Math.min(0, y) });
      },
      onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => end(true, event),
      onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => end(false, event),
      // Keyboard: Enter or Space summons; a pointer's click was handled on its lift.
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        if (event.detail === 0) onSummon(slot);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        // Delete or Backspace on a slot focused from the keyboard removes it, for keyboard users. After a
        // click the slot keeps focus without `:focus-visible`, and Backspace there puts the held object back.
        if ((event.key === 'Delete' || event.key === 'Backspace') && event.currentTarget.matches(':focus-visible')) {
          event.preventDefault();
          event.stopPropagation();
          onRemove(slot);
        }
      }
    }
  };
}

function captionStyle(widthApx: number): CSSProperties {
  return {
    width: widthApx + 12,
    textAlign: 'center',
    fontFamily: fontStack(tokens.type.controlLabel.fontFamily),
    fontSize: 12.5,
    lineHeight: 1.2,
    color: 'var(--holoim-color-text-muted)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  };
}

/** The five slots above the dock; unfolds in 240 ms and leaves in 400 ms (crossfade under reduced motion). */
export function TrayRow({
  tray,
  touch,
  input,
  armedSlot,
  bottom,
  onSummon,
  onRemove
}: {
  tray: TrayUiState;
  touch: boolean;
  input: HitInput;
  armedSlot: number | null;
  bottom: string;
  onSummon: (slot: number) => void;
  onRemove: (slot: number) => void;
}) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(tray.open);
  const [shown, setShown] = useState(false);
  const outMs = chromeTransition('out', { reducedMotion: reduced }).durationMs;

  useEffect(() => {
    if (tray.open) {
      setMounted(true);
      // Paint the closed position first so the change is a transition.
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), outMs);
    return () => clearTimeout(timer);
  }, [tray.open, outMs]);

  if (!mounted) return null;
  const motion = chromeTransition(shown ? 'in' : 'out', { reducedMotion: reduced });
  const easing = `cubic-bezier(${motion.easing.join(', ')})`;
  const gap = glyphMetrics({ headset: false }).gapApx;
  const tileApx = touch ? Math.max(TOUCH_TILE_APX, hitAreaApx(input, 0)) : TILE_APX;
  const rowGap = touch ? 4 : gap;
  const bySlot = new Map(tray.slots.map((item) => [item.slot, item]));
  const firstEmpty = tray.slots.length + 1;
  const empty = tray.slots.length === 0;

  return (
    <div
      data-capture-tray-row=""
      data-testid="tray-row"
      data-tray-blocked={tray.blocked ? 'true' : 'false'}
      role="group"
      aria-label="Tray"
      style={{
        position: 'absolute',
        bottom,
        // On touch the row keeps right, clear of the walk stick's zone where it
        // fits; on a narrow phone it reaches in rather than shrink a slot below
        // 44 apx (its slots are buttons, so a touch on one never walks).
        left: 0,
        right: 0,
        paddingInline: `max(env(safe-area-inset-right), ${PHONE_EDGES.side}px)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: touch ? 'flex-end' : 'center',
        gap: 4,
        pointerEvents: 'none',
        transformOrigin: '50% 100%',
        ...(motion.style === 'unfold'
          ? { opacity: shown ? 1 : 0, transform: shown ? 'translateY(0) scale(1)' : 'translateY(12px) scale(0.94)', transition: `opacity ${motion.durationMs}ms ${easing}, transform ${motion.durationMs}ms ${easing}` }
          : { opacity: shown ? 1 : 0, transition: `opacity ${motion.durationMs}ms ${easing}` })
      }}
    >
      <div style={{ display: 'flex', gap: rowGap, flexShrink: 0, pointerEvents: tray.open ? 'auto' : 'none' }}>
        {Array.from({ length: SLOTS }, (_, index) => {
          const slot = index + 1;
          return (
            <Slot
              key={slot}
              slot={slot}
              item={bySlot.get(slot)}
              touch={touch}
              blocked={tray.blocked}
              loading={tray.loading && slot === firstEmpty}
              armed={armedSlot === slot || tray.returnSlot === slot}
              tileApx={tileApx}
              onSummon={onSummon}
              onRemove={onRemove}
            />
          );
        })}
      </div>
      {empty ? (
        <Type variant="captionUnderCard" as="p" data-testid="tray-empty-caption" style={{ margin: 0, color: 'var(--holoim-color-text-muted)' }}>
          Empty: search with Find
        </Type>
      ) : null}
    </div>
  );
}
