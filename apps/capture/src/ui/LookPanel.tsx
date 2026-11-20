// The look panel (docs/features/your-look.md): the house base's look, set on
// the live avatar before a take. A sheet on the chip above the dock, in the
// slot Find and Post use. Styles are word choices; colours are discs inside
// the choice ring, and the row's title names the chosen colour in words, so
// the state is never colour alone.
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { BUILDS, CLOTHING, EYES, FINISHES, GLASSES, HAIR_COLOUR, HAIR_STYLES, SKIN, type LookCard, type SRGB } from '@holoim/avatar-look';
import { tokens } from '@holoim/design-tokens';
import { Chip, ChoiceGroup, Type } from '@holoim/ui-dom';
import { PHONE_EDGES, glyphMetrics, hitAreaApx, type HitInput, type ViewTarget } from '@holoim/xr-ui-core';

import type { HouseLook } from '../avatar/houseLook';
import type { HouseLookUi } from '../types/contracts';

/** "sweptCrop" → "Swept crop". */
export function traitWords(value: string): string {
  const words = value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const clothingWords = (value: string): string => traitWords(value).replace(/ /, ' and ');

const options = <T extends string>(values: readonly T[], words: (value: string) => string = traitWords) =>
  values.map((value) => ({ value, label: words(value) }));

const keys = <T extends string>(record: Record<T, unknown>): T[] => Object.keys(record) as T[];

const css = ([r, g, b]: SRGB): string => `rgb(${r} ${g} ${b})`;

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
            <ChoiceGroup label="Finish" value={look.finish} options={options(FINISHES)} input={input} onChange={(finish) => onChange({ look: card, finish })} />
          </Row>
          <Row title="Build">
            <ChoiceGroup label="Build" value={card.build} options={options(BUILDS)} input={input} onChange={(build) => set({ build })} />
          </Row>
          <Row title={`Skin · ${traitWords(card.skin)}`}>
            <Swatches label="Skin" value={card.skin} colours={SKIN} input={input} onChange={(skin) => set({ skin })} />
          </Row>
          <Row title="Hair">
            <ChoiceGroup label="Hair" value={card.hair.style} options={options(HAIR_STYLES)} input={input} onChange={(style) => set({ hair: { ...card.hair, style } })} />
          </Row>
          <Row title={`Hair colour · ${traitWords(card.hair.colour)}`}>
            <Swatches label="Hair colour" value={card.hair.colour} colours={HAIR_COLOUR} input={input} onChange={(colour) => set({ hair: { ...card.hair, colour } })} />
          </Row>
          <Row title={`Eyes · ${traitWords(card.eyes)}`}>
            <Swatches label="Eyes" value={card.eyes} colours={EYES} input={input} onChange={(eyes) => set({ eyes })} />
          </Row>
          <Row title="Glasses">
            <ChoiceGroup label="Glasses" value={card.glasses} options={options(GLASSES)} input={input} onChange={(glasses) => set({ glasses })} />
          </Row>
          <Row title="Clothes">
            <ChoiceGroup label="Clothes" value={card.clothing} options={options(keys(CLOTHING), clothingWords)} input={input} onChange={(clothing) => set({ clothing })} />
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

/** Colour choices: a disc of each colour inside the choice ring; the chosen one holds the gold dot on a small deep-sea lens. */
function Swatches<T extends string>({ label, value, colours, input, onChange }: { label: string; value: T; colours: Record<T, SRGB>; input: HitInput; onChange: (value: T) => void }) {
  const metrics = glyphMetrics({ headset: false });
  const hit = hitAreaApx(input, metrics.iconApx);
  const drawn = Math.max(metrics.iconApx, 24);
  const [focused, setFocused] = useState<T | null>(null);
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: metrics.gapApx / 2 }}>
      {keys(colours).map((key) => {
        const checked = key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={traitWords(key)}
            data-look-swatch={key}
            onClick={() => onChange(key)}
            onFocus={(event) => setFocused(event.currentTarget.matches(':focus-visible') ? key : null)}
            onBlur={() => setFocused(null)}
            style={{
              minWidth: hit,
              minHeight: hit,
              padding: 0,
              border: 'none',
              background: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              borderRadius: '50%',
              outline: focused === key ? `2px solid ${tokens.color.gold}` : 'none',
              outlineOffset: -2
            }}
          >
            <svg viewBox="0 0 24 24" width={drawn} height={drawn} aria-hidden="true" focusable="false" style={{ display: 'block' }}>
              <circle cx="12" cy="12" r="10.5" fill={css(colours[key])} stroke={checked ? tokens.color.gold : tokens.color.text} strokeWidth="1.5" />
              {checked ? (
                <>
                  <circle cx="12" cy="12" r="4.5" fill={tokens.color.deepSea} />
                  <circle cx="12" cy="12" r="2.5" fill={tokens.color.gold} />
                </>
              ) : null}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
