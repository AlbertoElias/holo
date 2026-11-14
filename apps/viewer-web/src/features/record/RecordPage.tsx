import { useEffect, useRef, useState } from "react";
import { GlyphControl, Type } from "@holoim/ui-dom";

import { mintPostGrant } from "../auth/auth";
import { SignInForm } from "../auth/SignInForm";
import { useCurrentUser } from "../auth/useCurrentUser";
import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";

const captureOrigin = (import.meta.env.VITE_CAPTURE_ORIGIN as string | undefined) || "https://localhost:5173";

/** Capture's address with a post grant in the fragment, which never reaches a server. */
export function captureUrlWithGrant(grant: string): string {
  return `${captureOrigin.replace(/\/$/, "")}/#post=${encodeURIComponent(grant)}`;
}

// Record (docs/features/phone-capture.md, slice 1): signed in, mint a post
// grant and replace this page with capture, so Back returns to the feed.
// Signed out, sign in first; the emailed link comes back here.
export function RecordPage() {
  const { user, isLoading } = useCurrentUser();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);

  useEffect(() => {
    if (!user || started.current === attempt) return;
    started.current = attempt;
    mintPostGrant()
      .then((grant) => window.location.replace(captureUrlWithGrant(grant)))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not open the recorder."));
  }, [user, attempt]);

  return (
    <main className="app-shell">
      <section className="auth-verify" aria-label="Record a hologram">
        {isLoading ? null : !user ? (
          <>
            <Type variant="titlePhoneCard" as="h1">Record a hologram</Type>
            <SignInForm
              next="record"
              intro="Sign in once, then record. The link in the email opens the recorder, and your hologram is posted under your name."
            />
          </>
        ) : error ? (
          <>
            <p className="feed-error" role="alert">{error}</p>
            <GlyphControl glyph={null} showLabel label={VIEWER_CONTROL_NAMES.retry} word={VIEWER_CONTROL_NAMES.retry} onPress={() => { setError(null); setAttempt((n) => n + 1); }} />
            <a href="/">Back to the feed</a>
          </>
        ) : (
          <p className="feed-state" role="status">Opening the recorder…</p>
        )}
      </section>
    </main>
  );
}
