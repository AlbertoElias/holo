import { useEffect, useRef, useState } from "react";

import { decodeGltfAudio, getAudioContext, type GltfAudioSource } from "./gltfAudio";

export { resumeAudioContext } from "./gltfAudio";

export interface GltfAudioResult {
  hasAudio: boolean;
}

/** Playback time running back by more than this is the motion wrapping, not frame noise. */
const WRAP_BACK_SEC = 0.05;

/**
 * `playing` starts and stops the sound. `getPlaybackTime` reports the
 * animation's current time, so every (re)start lands where the motion is,
 * including each time the motion loops back to its start.
 */
export function useGltfAudio(
  gltf: GltfAudioSource,
  playing: boolean,
  muted: boolean,
  getPlaybackTime?: () => number
): GltfAudioResult {
  const [hasAudio, setHasAudio] = useState(false);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const loopRef = useRef(true);
  const getPlaybackTimeRef = useRef(getPlaybackTime);
  getPlaybackTimeRef.current = getPlaybackTime;

  // Decode audio from KHR_audio extension on mount
  useEffect(() => {
    let cancelled = false;

    decodeGltfAudio(gltf)
      .then((decoded) => {
        if (cancelled) return;
        audioBufferRef.current = decoded?.buffer ?? null;
        loopRef.current = decoded?.loop ?? true;
        setHasAudio(Boolean(decoded));
      })
      .catch((err: unknown) => {
        console.warn("Failed to decode KHR_audio data:", err);
        if (!cancelled) setHasAudio(false);
      });

    return () => {
      cancelled = true;
    };
  }, [gltf]);

  // Create/destroy audio source based on playing + muted state.
  // muted is included so the gain node always reflects the current value.
  useEffect(() => {
    if (!playing || !audioBufferRef.current) {
      // Stop playback when paused or inactive
      if (sourceRef.current) {
        try {
          sourceRef.current.stop();
        } catch {
          // already stopped
        }
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      if (gainRef.current) {
        gainRef.current.disconnect();
        gainRef.current = null;
      }
      return;
    }

    const ctx = getAudioContext();
    const gain = ctx.createGain();
    gain.gain.value = muted ? 0 : 1;
    gain.connect(ctx.destination);
    gainRef.current = gain;

    const buffer = audioBufferRef.current;
    let source: AudioBufferSourceNode | null = null;
    // (Re)starts the sound where the motion is. Looping alone would run the sound by its own length, which
    // is not the motion's (a camera take's audio is not as long as its motion).
    const start = (time: number): void => {
      if (source) {
        try {
          source.stop();
        } catch {
          // already stopped
        }
        source.disconnect();
        source = null;
      }
      const next = ctx.createBufferSource();
      next.buffer = buffer;
      next.loop = loopRef.current;
      next.connect(gain);
      const offset = next.loop ? time % buffer.duration : time;
      if (offset < buffer.duration) {
        next.start(0, offset);
      }
      source = next;
      sourceRef.current = next;
    };
    let lastTime = Math.max(getPlaybackTimeRef.current?.() ?? 0, 0);
    start(lastTime);

    // The motion wrapping to its start restarts the sound with it, as the XR player does.
    let frame = 0;
    const watch = (): void => {
      const time = Math.max(getPlaybackTimeRef.current?.() ?? 0, 0);
      if (time < lastTime - WRAP_BACK_SEC) start(time);
      lastTime = time;
      frame = requestAnimationFrame(watch);
    };
    if (getPlaybackTimeRef.current) frame = requestAnimationFrame(watch);

    return () => {
      cancelAnimationFrame(frame);
      try {
        source?.stop();
      } catch {
        // already stopped
      }
      source?.disconnect();
      sourceRef.current = null;
      gain.disconnect();
      gainRef.current = null;
    };
  }, [playing, hasAudio, muted]);

  return { hasAudio };
}
