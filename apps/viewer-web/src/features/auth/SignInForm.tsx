import { useId, useState } from "react";
import type { FormEvent } from "react";
import { GlyphControl, Type } from "@holoim/ui-dom";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { requestMagicLink } from "./auth";

type SignInFormProps = {
  /** One line above the fields: why signing in is asked of this person here. */
  intro?: string;
  /** Where the emailed link returns to after sign-in. */
  next?: "record";
};

// The sign-in form, in the same fields and word-and-glyph control as the
// upload form: Settings and the Upload sheet both show it to anyone not yet
// signed in. It says "sent" only after the API says the email went out.
export function SignInForm({ intro, next }: SignInFormProps) {
  const emailId = useId();
  const nameId = useId();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  async function send() {
    const trimmedEmail = email.trim();
    if (isSending) return;
    if (!trimmedEmail) {
      setError("Enter your email address.");
      return;
    }
    setIsSending(true);
    setError(null);
    setSentTo(null);
    setDevToken(null);
    try {
      const result = await requestMagicLink({
        email: trimmedEmail,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(next ? { next } : {})
      });
      setSentTo(trimmedEmail);
      if (result.devMagicLinkToken) {
        setDevToken(result.devMagicLinkToken);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the sign-in link.");
    } finally {
      setIsSending(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send();
  }

  return (
    <form className="upload-form" onSubmit={onSubmit} aria-label="Sign in">
      {intro ? <Type variant="byline" as="p">{intro}</Type> : null}
      <label className="upload-field" htmlFor={emailId}>
        <Type variant="byline">Email</Type>
        <input
          id={emailId}
          className="upload-input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          maxLength={254}
          disabled={isSending}
        />
      </label>
      <label className="upload-field" htmlFor={nameId}>
        <Type variant="byline">Your name, if you are new</Type>
        <input
          id={nameId}
          className="upload-input"
          autoComplete="name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={80}
          disabled={isSending}
        />
      </label>
      {sentTo ? (
        <Type variant="byline" as="p" role="status">
          {`We emailed a sign-in link to ${sentTo}. It works once and expires in 15 minutes.`}
        </Type>
      ) : null}
      {devToken ? (
        <a className="auth-dev-link" href={`/auth/verify?token=${encodeURIComponent(devToken)}${next ? `&next=${next}` : ""}`}>
          Continue with the local sign-in link
        </a>
      ) : null}
      {error ? <Type variant="byline" as="p" role="alert">{error}</Type> : null}
      <div className="upload-actions">
        <GlyphControl
          glyph={null}
          showLabel
          label={VIEWER_CONTROL_NAMES.emailSignInLink}
          word={isSending ? "Sending…" : VIEWER_CONTROL_NAMES.emailSignInLink}
          onPress={() => void send()}
        />
      </div>
    </form>
  );
}
