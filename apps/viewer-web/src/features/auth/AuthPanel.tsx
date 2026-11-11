import type { UserDTO } from "@holoim/contracts";
import { GlyphControl, Type } from "@holoim/ui-dom";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { SignInForm } from "./SignInForm";

type AuthPanelProps = {
  user: UserDTO | null;
  onSignOut: () => Promise<void> | void;
};

// The contents of the Settings sheet's Account section; the section and its heading come from the sheet.
export function AuthPanel({ user, onSignOut }: AuthPanelProps) {
  if (!user) {
    return <SignInForm intro="Sign in to upload holograms under your name and delete your own." />;
  }

  return (
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
  );
}
