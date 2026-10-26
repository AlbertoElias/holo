// Feed-wide notices (styleguide 5.2, 9.3, 9.4): the empty feed, offline, a
// server error and the upload's status have no hologram, so they sit on the
// chip, above every other panel. Errors are cream text with a gold action.
import { Chip, GlyphControl, Type } from "@holoim/ui-dom";
import type { ViewTarget } from "@holoim/xr-ui-core";


export type FeedNoticeContent = {
  kind: "loading" | "empty" | "offline" | "error" | "upload";
  text: string;
  action?: { label: string; onPress: () => void };
};

export function FeedNotice({ notice, target }: { notice: FeedNoticeContent | null; target: ViewTarget }) {
  if (!notice) return null;
  return (
    <div className="feed-notice" role={notice.kind === "error" ? "alert" : "status"} data-notice={notice.kind}>
      <Chip target={target} className="feed-notice-chip">
        <Type variant="captionUnderCard" as="p" className="feed-notice-text">
          {notice.text}
        </Type>
        {notice.action ? <GlyphControl glyph={null} label={notice.action.label} onPress={notice.action.onPress} /> : null}
      </Chip>
    </div>
  );
}
