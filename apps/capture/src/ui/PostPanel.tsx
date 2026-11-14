import { useSyncExternalStore } from 'react';
import { Chip, GlyphControl, Type } from '@holoim/ui-dom';
import type { HitInput, ViewTarget } from '@holoim/xr-ui-core';
import { postFlow, type PostState } from '../post/postFlow';

// After Stop, with a post grant (docs/features/phone-capture.md, slice 1):
// Post goes first and Save file stays, above the dock, where the thumb is.
// Without a grant nothing shows and takes download as before.
export const POST_CONTROL_NAMES = { post: 'Post', save: 'Save file', retry: 'Try again', signInAgain: 'Sign in again' } as const;

function line(state: PostState, exporting: boolean): string | null {
  switch (state.kind) {
    case 'waiting':
      // Stop to Post takes seconds on a phone; say so rather than show nothing.
      return exporting ? 'Getting your take ready…' : null;
    case 'ready':
      return 'Your take is ready.';
    case 'posting':
      return 'Posting…';
    case 'posted':
      return 'Posted. Opening it…';
    case 'failed':
    case 'expired':
      return state.message;
    default:
      return null;
  }
}

export function PostPanel({ input, target, bottom, hidden, exporting }: { input: HitInput; target: ViewTarget; bottom: string; hidden: boolean; exporting: boolean }) {
  const state = useSyncExternalStore(postFlow.subscribe, postFlow.getSnapshot, postFlow.getSnapshot);
  const text = line(state, exporting);
  if (hidden || text === null) return null;
  const hasTake = state.kind === 'ready' || state.kind === 'posting' || state.kind === 'failed';
  const canPost = state.kind === 'ready' || (state.kind === 'failed' && state.retry);
  // A spent grant: a new tab signs in and records again, and this tab keeps the take for Save file.
  const signInAgain = (state.kind === 'expired' || (state.kind === 'failed' && !state.retry)) ? postFlow.signInAgainUrl : null;
  return (
    <div data-capture-post="" data-post-state={state.kind} style={{ position: 'absolute', left: 0, right: 0, bottom, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <Chip target={target} style={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <Type variant="controlLabel" as="p" role={state.kind === 'failed' ? 'alert' : 'status'} style={{ color: 'var(--holoim-color-text)', margin: 0, textAlign: 'center' }}>
          {text}
        </Type>
        {hasTake || signInAgain ? (
          <div style={{ display: 'flex', gap: 8 }}>
            {canPost ? (
              <GlyphControl
                glyph={null}
                showLabel
                label={state.kind === 'failed' ? POST_CONTROL_NAMES.retry : POST_CONTROL_NAMES.post}
                word={state.kind === 'failed' ? POST_CONTROL_NAMES.retry : POST_CONTROL_NAMES.post}
                input={input}
                onPress={() => void postFlow.post()}
              />
            ) : null}
            {hasTake ? (
              <GlyphControl glyph={null} showLabel label={POST_CONTROL_NAMES.save} word={POST_CONTROL_NAMES.save} input={input} disabled={state.kind === 'posting'} onPress={() => postFlow.save()} />
            ) : null}
            {signInAgain ? (
              <GlyphControl glyph={null} showLabel label={POST_CONTROL_NAMES.signInAgain} word={POST_CONTROL_NAMES.signInAgain} input={input} onPress={() => window.open(signInAgain, '_blank', 'noopener')} />
            ) : null}
          </div>
        ) : null}
      </Chip>
    </div>
  );
}
