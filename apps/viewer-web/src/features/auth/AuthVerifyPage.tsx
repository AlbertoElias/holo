import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { verifyMagicLink } from "./auth";

export function AuthVerifyPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // Magic links are single-use; StrictMode double-invokes effects in dev,
  // so never exchange the same token twice from this page instance.
  const startedTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setError("This sign-in link is missing its token.");
      return;
    }
    if (startedTokenRef.current === token) {
      return;
    }
    startedTokenRef.current = token;
    // No cancellation guard: StrictMode's simulated unmount would cancel
    // the one real exchange, and the ref guard blocks a second attempt.
    verifyMagicLink(token)
      .then(() => {
        navigate("/", { replace: true });
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "This sign-in link is invalid or expired.");
      });
  }, [navigate, params]);

  return (
    <main className="app-shell">
      <section className="auth-verify" aria-label="Signing in">
        {error ? (
          <>
            <h1>Sign-in link not accepted</h1>
            <p className="feed-error">{error}</p>
            <a href="/">Back to the feed</a>
          </>
        ) : (
          <p className="feed-state">Signing you in…</p>
        )}
      </section>
    </main>
  );
}
