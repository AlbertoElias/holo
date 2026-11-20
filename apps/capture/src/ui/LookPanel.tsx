// The look panel (docs/features/your-look.md): the house base's look, set on
// the live avatar before a take. A sheet on the chip above the dock, in the
// slot Find and Post use. Each row is a strip of pictures, one per value: the
// house avatar in its default look with only that row changed, so a choice
// shows what it does before it is made. The chosen picture holds the gold
// ring and the gold dot on a small deep-sea lens, and every picture carries
// its word, so the state is never colour or picture alone.
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { BUILDS, CLOTHING, EYES, FINISHES, GLASSES, HAIR_COLOUR, HAIR_STYLES, SKIN, type LookCard } from '@holoim/avatar-look';
import { tokens } from '@holoim/design-tokens';
import { Chip, Type } from '@holoim/ui-dom';
import { PHONE_EDGES, glyphMetrics, type HitInput, type ViewTarget } from '@holoim/xr-ui-core';

import type { HouseLook } from '../avatar/houseLook';
import type { HouseLookUi } from '../types/contracts';
import { clothingWords, lookPicture, traitWords, type LookRow } from './lookPictures';

const options = <T extends string>(values: readonly T[], words: (value: string) => string = traitWords) =>
  values.map((value) => ({ value, label: words(value) }));

const keys = <T extends string>(record: Record<T, unknown>): T[] => Object.keys(record) as T[];

/** A picture's side, CSS px; the pictures are drawn at three times this. */
const PICTURE = 72;

export function LookPanel({
  look,
  input,
  target,
  bottom,
  onChange,
  onHeight
}: {
  look: HouseLookUi;
  input: HitInput;
  target: ViewTarget;
  bottom: string;
  onChange: (next: HouseLook) => void;
  /** The panel's top, in CSS pixels from the screen's bottom; 0 once it closes. */
  onHeight: (px: number) => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sheet.current;
    if (!element) return undefined;
    const report = (): void => onHeight(Math.max(0, window.innerHeight - element.getBoundingClientRect().top));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      onHeight(0);
    };
  }, [onHeight]);
  const gap = glyphMetrics({ headset: false }).gapApx;
  const card = look.look;
  const set = (patch: Partial<LookCard>): void => onChange({ look: { ...card, ...patch }, finish: look.finish });
  const status = look.status === 'dressing' ? 'Changing the look' : look.status === 'error' ? look.message : null;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom, display: 'flex', justifyContent: 'center', paddingInline: `max(env(safe-area-inset-left), ${PHONE_EDGES.side}px)`, pointerEvents: 'none' }}>
      <div ref={sheet} style={{ pointerEvents: 'auto', width: 'min(100%, 28rem)', maxHeight: '46vh', overflowY: 'auto', borderRadius: tokens.chip.radius }}>
        <Chip target={target} role="dialog" aria-label="Your look" data-testid="look-panel" data-look-status={look.status} style={{ display: 'grid', gap: gap * 1.5, padding: gap * 1.5 }}>
          <Type variant="captionUnderCard" as="p" aria-live="polite" data-testid="look-status" style={{ margin: 0, minHeight: '1.2em' }}>
            {status ?? 'Your look shows on the avatar before you record.'}
          </Type>
          <Row title="Finish">
            <Pictures label="Finish" row="finish" value={look.finish} options={options(FINISHES)} input={input} onChange={(finish) => onChange({ look: card, finish })} />
          </Row>
          <Row title="Build">
            <Pictures label="Build" row="build" value={card.build} options={options(BUILDS)} input={input} onChange={(build) => set({ build })} />
          </Row>
          <Row title="Skin">
            <Pictures label="Skin" row="skin" value={card.skin} options={options(keys(SKIN))} input={input} onChange={(skin) => set({ skin })} />
          </Row>
          <Row title="Hair">
            <Pictures label="Hair" row="hair" value={card.hair.style} options={options(HAIR_STYLES)} input={input} onChange={(style) => set({ hair: { ...card.hair, style } })} />
          </Row>
          <Row title="Hair colour">
            <Pictures label="Hair colour" row="hairColour" value={card.hair.colour} options={options(keys(HAIR_COLOUR))} input={input} onChange={(colour) => set({ hair: { ...card.hair, colour } })} />
          </Row>
          <Row title="Eyes">
            <Pictures label="Eyes" row="eyes" value={card.eyes} options={options(keys(EYES))} input={input} onChange={(eyes) => set({ eyes })} />
          </Row>
          <Row title="Glasses">
            <Pictures label="Glasses" row="glasses" value={card.glasses} options={options(GLASSES)} input={input} onChange={(glasses) => set({ glasses })} />
          </Row>
          <Row title="Clothes">
            <Pictures label="Clothes" row="clothing" value={card.clothing} options={options(keys(CLOTHING), clothingWords)} input={input} onChange={(clothing) => set({ clothing })} />
          </Row>
        </Chip>
      </div>
    </div>
  );
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  const gap = glyphMetrics({ headset: false }).gapApx;
  return (
    <section style={{ display: 'grid', gap: gap / 2 }}>
      <Type variant="controlLabel" as="h3" style={{ margin: 0, color: tokens.color.textMuted }}>
        {title}
      </Type>
      {children}
    </section>
  );
}

/**
 * One row's choices: a strip of pictures that scrolls sideways, each a radio
 * named by its word. The chosen picture holds the gold ring and the gold dot
 * on a small deep-sea lens; the strip scrolls it into view when it opens.
 */
function Pictures<T extends string>({ label, row, value, options: choices, input, onChange }: { label: string; row: LookRow; value: T; options: { value: T; label: string }[]; input: HitInput; onChange: (value: T) => void }) {
  const metrics = glyphMetrics({ headset: false });
  const strip = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<T | null>(null);
  useEffect(() => {
    const element = strip.current;
    const chosen = element?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!element || !chosen) return;
    // Scroll the strip only, never the sheet: scrollIntoView would move every scroller above it as well.
    const left = chosen.offsetLeft - element.offsetLeft;
    if (left < element.scrollLeft || left + chosen.offsetWidth > element.scrollLeft + element.clientWidth) element.scrollLeft = left - (element.clientWidth - chosen.offsetWidth) / 2;
  }, [value]);
  const touch = input === 'touch';
  return (
    <div
      ref={strip}
      role="radiogroup"
      aria-label={label}
      style={{ display: 'flex', gap: metrics.gapApx, overflowX: 'auto', overscrollBehaviorX: 'contain', scrollSnapType: 'x proximity', scrollbarWidth: touch ? 'none' : 'thin', paddingBlock: 4, marginInline: -4, paddingInline: 4 }}
    >
      {choices.map((choice) => {
        const checked = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={choice.label}
            data-look-option={choice.value}
            onClick={() => onChange(choice.value)}
            onFocus={(event) => setFocused(event.currentTarget.matches(':focus-visible') ? choice.value : null)}
            onBlur={() => setFocused(null)}
            style={{
              flex: 'none',
              width: PICTURE,
              padding: 0,
              border: 'none',
              background: 'none',
              display: 'grid',
              justifyItems: 'center',
              gap: metrics.gapApx / 2,
              cursor: 'pointer',
              scrollSnapAlign: 'start',
              borderRadius: tokens.chip.radius / 2,
              outline: focused === choice.value ? `2px solid ${tokens.color.gold}` : 'none',
              outlineOffset: 2
            }}
          >
            <span style={{ position: 'relative', display: 'block', width: PICTURE, height: PICTURE }}>
              <img
                src={`${import.meta.env.BASE_URL}${lookPicture(row, choice.value)}`}
                alt=""
                width={PICTURE}
                height={PICTURE}
                // Eager: in a row that scrolls sideways, a lazy picture starts loading
                // only as it nears the screen, so a swipe met empty tiles. All rows
                // together weigh about 300 KB.
                decoding="async"
                draggable={false}
                style={{ display: 'block', width: PICTURE, height: PICTURE, borderRadius: tokens.chip.radius / 2, background: tokens.color.ground.mid }}
              />
              <span
                aria-hidden="true"
                style={{ position: 'absolute', inset: 0, borderRadius: tokens.chip.radius / 2, boxShadow: checked ? `inset 0 0 0 2px ${tokens.color.gold}` : `inset 0 0 0 1px ${tokens.color.textMuted}55` }}
              />
              {checked ? (
                <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false" style={{ position: 'absolute', top: 5, right: 5, display: 'block' }}>
                  <circle cx="8" cy="8" r="7" fill={tokens.color.deepSea} />
                  <circle cx="8" cy="8" r="3.5" fill={tokens.color.gold} />
                </svg>
              ) : null}
            </span>
            <Type variant="captionUnderCard" as="span" style={{ display: 'block', width: '100%', textAlign: 'center', color: checked ? tokens.color.text : tokens.color.textMuted, lineHeight: 1.2, overflowWrap: 'anywhere' }}>
              {choice.label}
            </Type>
          </button>
        );
      })}
    </div>
  );
}
