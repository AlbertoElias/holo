import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import type { ObjectSearchResult } from '@holoim/contracts';
import { licenceLabel } from '@holoim/objects';
import { GlyphControl, Type } from '@holoim/ui-dom';
import { glyphAppearance, glyphMetrics, hitAreaApx, type HitInput } from '@holoim/xr-ui-core';

import { objectGlbUrl, searchObjects } from '../objects/objectSearch';

type Finding = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; results: ObjectSearchResult[] };

const THUMBNAIL_APX = 48;

function sizeLabel(dimensionsM: ObjectSearchResult['dimensionsM']): string | null {
  if (!dimensionsM) return null;
  return `${dimensionsM.map((m) => Math.round(m * 100)).join(' × ')} cm`;
}

// A result row as a control with the styleguide's section 6 states: cream on
// hover, 55% pressed, the token gold ring on keyboard focus (the same
// appearance GlyphControl draws, which cannot hold a thumbnail and a byline).
function ResultButton({ label, disabled, hit, gap, onPress, children }: { label: string; disabled: boolean; hit: number; gap: number; onPress: () => void; children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const appearance = glyphAppearance(disabled ? { dimmed: true } : { hovered, focusVisible, pressed, dimmed: false }, { headset: false });
  const ring = appearance.focusRing;
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onPress}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') setHovered(true); }}
      onPointerLeave={() => { setHovered(false); setPressed(false); }}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setPressed(true); }}
      onKeyUp={() => setPressed(false)}
      onFocus={(event) => setFocusVisible(event.currentTarget.matches(':focus-visible'))}
      onBlur={() => { setFocusVisible(false); setPressed(false); }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap,
        width: '100%',
        minHeight: hit,
        padding: 0,
        background: 'transparent',
        border: 0,
        color: appearance.color,
        opacity: appearance.opacity,
        textAlign: 'left',
        cursor: disabled ? 'default' : 'pointer',
        outline: ring ? `${ring.width}px solid ${ring.color}` : 'none',
        outlineOffset: ring ? `${ring.offset}px` : undefined,
        WebkitTapHighlightColor: 'transparent'
      }}
    >
      {children}
    </button>
  );
}

// Find an object by asking (PRD-060): a text query, up to six registry
// results, one click to put a result in the tray. Picking goes through the
// tray's loader, so its limits and messages apply unchanged.
export function ObjectFinder({ disabled, input, onPick }: { disabled: boolean; input: HitInput; onPick: (url: string) => void }) {
  const [query, setQuery] = useState('');
  const [finding, setFinding] = useState<Finding>({ status: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const hit = hitAreaApx(input, 0);
  const gap = glyphMetrics({ headset: false }).gapApx;

  useEffect(() => () => abort.current?.abort(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    run();
  };

  const run = () => {
    const q = query.trim();
    if (!q || disabled) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setFinding({ status: 'loading' });
    searchObjects(q, controller.signal).then(
      (results) => setFinding({ status: 'done', results }),
      (error: Error) => {
        if (!controller.signal.aborted) setFinding({ status: 'error', message: error.message });
      }
    );
  };

  return (
    <div style={{ display: 'grid', gap: gap / 2 }}>
      <form onSubmit={submit} style={{ display: 'flex', alignItems: 'center', gap, opacity: disabled ? 0.5 : 1 }}>
        <input
          type="search"
          aria-label="Find an object"
          placeholder="Find an object…"
          maxLength={100}
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.currentTarget.value)}
          style={{ flex: 1, minWidth: 0, minHeight: hit, background: 'transparent', border: 0, borderBottom: '1px solid var(--holoim-color-gold)', color: 'var(--holoim-color-text)', font: 'inherit' }}
        />
        <GlyphControl glyph={null} label="Find" input={input} disabled={disabled || query.trim() === ''} onPress={() => run()} />
      </form>
      {finding.status === 'loading' ? (
        <Type variant="captionUnderCard" as="p" style={{ margin: 0 }}>
          Searching…
        </Type>
      ) : null}
      {finding.status === 'error' ? (
        <Type variant="captionUnderCard" as="p" role="alert" style={{ margin: 0 }}>
          {finding.message}
        </Type>
      ) : null}
      {finding.status === 'done' && finding.results.length === 0 ? (
        <Type variant="captionUnderCard" as="p" style={{ margin: 0 }}>
          No models found
        </Type>
      ) : null}
      {finding.status === 'done' ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: gap / 2 }}>
          {finding.results.map((result) => {
            const size = sizeLabel(result.dimensionsM);
            return (
              <li key={result.id}>
                <ResultButton label={`Add ${result.title} to the tray`} disabled={disabled} hit={hit} gap={gap} onPress={() => onPick(objectGlbUrl(result))}>
                  <img src={result.thumbnailUrl} alt="" loading="lazy" width={THUMBNAIL_APX} height={THUMBNAIL_APX} style={{ objectFit: 'cover', flex: 'none' }} />
                  <span style={{ display: 'grid', minWidth: 0 }}>
                    <Type variant="controlLabel">{result.title}</Type>
                    <Type variant="byline">
                      {result.author} · {result.source} · {licenceLabel(result.licence)}
                      {size ? ` · ${size}` : ''}
                    </Type>
                  </span>
                </ResultButton>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
