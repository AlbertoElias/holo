import type { UserDTO } from "@holoim/contracts";
import { GlyphControl, Type } from "@holoim/ui-dom";

import { VIEWER_CONTROL_NAMES } from "../chrome/controlNames";
import { SignInForm } from "./SignInForm";

type AuthPanelProps = {
  user: UserDTO | null;
  onSignOut: () => Promise<void> | void;
};

// The contents of the Settings sheet's Account section; the section and its heading come from the sheet.
// Who is signed in reads as one block, and Sign out stands on its row: one group, no footer.
export function AuthPanel({ user, onSignOut }: AuthPanelProps) {
  if (!user) {
    return <SignInForm />;
  }

  return (
    <div className="account-row">
      <div className="account-identity">
        <Type variant="note" as="p" className="account-name">{user.displayName}</Type>
        <Type variant="byline" as="p">{user.email}</Type>
      </div>
      <GlyphControl glyph={null} showLabel label={VIEWER_CONTROL_NAMES.signOut} onPress={() => void onSignOut()} />
    </div>
  );
}
