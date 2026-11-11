import type { UserDTO } from "@holoim/contracts";
import { GlyphControl, Type } from "@holoim/ui-dom";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { SignInForm } from "./SignInForm";

type AuthPanelProps = {
  user: UserDTO | null;
  onSignOut: () => Promise<void> | void;
};

// The account block of the Settings sheet, set below the handedness choice.
export function AuthPanel({ user, onSignOut }: AuthPanelProps) {
  if (!user) {
    return (
      <section className="auth-panel" aria-label="Account">
        <SignInForm intro="Sign in to upload holograms under your name and delete your own." />
      </section>
    );
  }

  return (
    <section className="auth-panel" aria-label="Account">
      <div className="upload-form">
        <Type variant="captionUnderCard" as="p">Creator account</Type>
        <Type variant="byline" as="p">
          Signed in as <strong>{user.displayName}</strong>
          <span className="verified-badge">Verified creator</span>
        </Type>
        <Type variant="byline" as="p">{user.email}</Type>
        <div className="upload-actions">
          <GlyphControl glyph={null} showLabel label={VIEWER_CONTROL_NAMES.signOut} onPress={() => void onSignOut()} />
        </div>
      </div>
    </section>
  );
}
