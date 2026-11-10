import { useEffect, useRef, useState } from "react";
import type { Object3D } from "three";

import { decodeGltfAudio, ScheduledGltfAudio, type DecodedGltfAudio, type GltfAudioSource } from "./gltfAudio";

export { resumeAudioContext } from "./gltfAudio";

export interface GltfAudioResult {
  hasAudio: boolean;
  /** The card's sound once decoded; the canvas places its sounds and the ear each frame. */
  audio: ScheduledGltfAudio | null;
}

/** Playback time running back by more than this is the motion wrapping, not frame noise. */
const WRAP_BACK_SEC = 0.05;

/**
 * Flat screens pan HRTF too, the user's pick of 2026-11-10
 * (docs/features/positional-audio.md): 3D cues on headphones, at the cost of
 * some colouring on speakers.
 */
export const FEED_PANNING_MODEL: PanningModelType = "HRTF";

/**
 * `playing` starts and stops every sound. `getPlaybackTime` reports the
 * animation's current time, so every (re)start lands where the motion is,
 * including each time the motion loops back to its start. `root` is the
 * card's clone: placed sounds are bound to its objects.
 */
export function useGltfAudio(
  gltf: GltfAudioSource,
  root: Object3D,
  playing: boolean,
  muted: boolean,
  getPlaybackTime?: () => number
): GltfAudioResult {
  const [decoded, setDecoded] = useState<DecodedGltfAudio | null>(null);
  const [audio, setAudio] = useState<ScheduledGltfAudio | null>(null);
  const getPlaybackTimeRef = useRef(getPlaybackTime);
  getPlaybackTimeRef.current = getPlaybackTime;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Decode audio from KHR_audio extension on mount
  useEffect(() => {
    let cancelled = false;
    setDecoded(null);
    decodeGltfAudio(gltf)
      .then((result) => {
        if (!cancelled) setDecoded(result);
      })
      .catch((err: unknown) => {
        console.warn("Failed to decode KHR_audio data:", err);
        if (!cancelled) setDecoded(null);
      });
    return () => {
      cancelled = true;
    };
  }, [gltf]);

  useEffect(() => {
    if (!decoded) return;
    const created = new ScheduledGltfAudio(decoded, root, { panningModel: FEED_PANNING_MODEL });
    created.setMuted(mutedRef.current);
    setAudio(created);
    return () => {
      created.dispose();
      setAudio(null);
    };
  }, [decoded, root]);

  useEffect(() => {
    if (!audio) return;
    audio.setMuted(muted);
    // The feed starts muted, often with the context suspended until this click resumes it, so a sound
    // "playing" until now stood still while the motion ran: unmuting restarts every sound where the motion
    // is, as each mute change did before positional audio.
    if (!muted && audio.playing) audio.start(Math.max(getPlaybackTimeRef.current?.() ?? 0, 0));
  }, [audio, muted]);

  useEffect(() => {
    if (!audio || !playing) return;
    // (Re)starts every sound where the motion is. Looping alone would run a sound by its own length, which
    // is not the motion's (a camera take's audio is not as long as its motion).
    let lastTime = Math.max(getPlaybackTimeRef.current?.() ?? 0, 0);
    audio.start(lastTime);

    // The motion wrapping to its start restarts the sound with it, as the XR player does.
    let frame = 0;
    const watch = (): void => {
      const time = Math.max(getPlaybackTimeRef.current?.() ?? 0, 0);
      if (time < lastTime - WRAP_BACK_SEC) audio.start(time);
      lastTime = time;
      frame = requestAnimationFrame(watch);
    };
    if (getPlaybackTimeRef.current) frame = requestAnimationFrame(watch);

    return () => {
      cancelAnimationFrame(frame);
      audio.stop();
    };
  }, [audio, playing]);

  return { hasAudio: decoded !== null, audio };
}
