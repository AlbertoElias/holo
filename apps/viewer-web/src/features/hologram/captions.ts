// The take's captions (docs/features/sound-voice-captions.md, slice 3), read
// from the GLB's JSON like the stored place; a malformed extension or cue is
// dropped with a warning and never stops the take.
import { CAPTIONS_EXTENSION, parseCaptions, primaryTrack, type CaptionTrack } from "@holoim/contracts";

export function readCaptionTrack(json: unknown): CaptionTrack | null {
  const raw = (json as { extensions?: Record<string, unknown> } | null)?.extensions?.[CAPTIONS_EXTENSION];
  if (raw === undefined) return null;
  const parsed = parseCaptions(raw);
  if (!parsed.ok) {
    console.warn(`The hologram's captions are unreadable and are not shown: ${parsed.errors.join("; ")}`);
    return null;
  }
  if (parsed.dropped.length) console.warn(`Some of the hologram's caption cues are malformed and are not shown: ${parsed.dropped.join("; ")}`);
  return primaryTrack(parsed.value);
}
