import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { ObjectSearchResult } from '@holoim/contracts';
import { licenceLabel } from '@holoim/objects';
import { Type } from '@holoim/ui-dom';
import { glyphMetrics, hitAreaApx, type HitInput } from '@holoim/xr-ui-core';

import { objectGlbUrl, searchObjects } from '../objects/objectSearch';

type Finding = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; results: ObjectSearchResult[] };

const THUMBNAIL_APX = 48;

function sizeLabel(dimensionsM: ObjectSearchResult['dimensionsM']): string | null {
  if (!dimensionsM) return null;
  return `${dimensionsM.map((m) => Math.round(m * 100)).join(' × ')} cm`;
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
        <button type="submit" disabled={disabled || query.trim() === ''} style={{ minHeight: hit, minWidth: hit, background: 'transparent', border: 0, cursor: 'pointer' }}>
          <Type variant="controlLabel" style={{ whiteSpace: 'nowrap' }}>
            Find
          </Type>
        </button>
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
                <button
                  type="button"
                  aria-label={`Add ${result.title} to the tray`}
                  disabled={disabled}
                  onClick={() => onPick(objectGlbUrl(result))}
                  style={{ display: 'flex', alignItems: 'center', gap, width: '100%', minHeight: hit, padding: 0, background: 'transparent', border: 0, color: 'inherit', textAlign: 'left', cursor: disabled ? 'default' : 'pointer' }}
                >
                  <img src={result.thumbnailUrl} alt="" loading="lazy" width={THUMBNAIL_APX} height={THUMBNAIL_APX} style={{ objectFit: 'cover', flex: 'none' }} />
                  <span style={{ display: 'grid', minWidth: 0 }}>
                    <Type variant="controlLabel">{result.title}</Type>
                    <Type variant="byline">
                      {result.author} · {result.source} · {licenceLabel(result.licence)}
                      {size ? ` · ${size}` : ''}
                    </Type>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
