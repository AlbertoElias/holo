import { useState } from "react";
import type { FormEvent } from "react";
import type { UserDTO } from "@holoim/contracts";
import { UiButton, UiField, UiInput, UiNotice, UiPanel, UiStack } from "@holoim/ui-dom";

import { requestMagicLink } from "./auth";

type AuthPanelProps = {
  user: UserDTO | null;
  onSignOut: () => Promise<void> | void;
};

export function AuthPanel({ user, onSignOut }: AuthPanelProps) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSending(true);
    setError(null);
    setStatus(null);
    setDevToken(null);
    try {
      const result = await requestMagicLink({
        email: email.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {})
      });
      setStatus("Check your inbox for a sign-in link. It expires in 15 minutes.");
      if (result.devMagicLinkToken) {
        setDevToken(result.devMagicLinkToken);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the sign-in link.");
    } finally {
      setIsSending(false);
    }
  }

  if (user) {
    return (
      <section className="auth-panel" aria-label="Account">
        <UiPanel style={{ padding: "0.95rem" }}>
          <UiStack gap="0.65rem">
            <p className="auth-signed-in">
              Signed in as <strong>{user.displayName}</strong>
              <span className="verified-badge">Verified creator</span>
            </p>
            <p className="upload-caption">{user.email}</p>
            <UiButton type="button" tone="ghost" onClick={() => void onSignOut()}>
              Sign out
            </UiButton>
          </UiStack>
        </UiPanel>
      </section>
    );
  }

  return (
    <section className="auth-panel" aria-label="Sign in">
      <UiPanel style={{ padding: "0.95rem" }}>
        <form onSubmit={onSubmit}>
          <UiStack gap="0.65rem">
            <span className="upload-title">Creator account</span>
            <UiField label="Email">
              <UiInput
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={254}
                required
              />
            </UiField>
            <UiField label="Display name (first sign-in)">
              <UiInput value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} />
            </UiField>
            <UiButton type="submit" disabled={isSending || !email.trim()}>
              {isSending ? "Sending..." : "Email me a sign-in link"}
            </UiButton>
            {status ? <UiNotice>{status}</UiNotice> : null}
            {devToken ? (
              <a className="auth-dev-link" href={`/auth/verify?token=${encodeURIComponent(devToken)}`}>
                Continue with the local sign-in link
              </a>
            ) : null}
            {error ? <UiNotice tone="danger">{error}</UiNotice> : null}
          </UiStack>
        </form>
      </UiPanel>
    </section>
  );
}
