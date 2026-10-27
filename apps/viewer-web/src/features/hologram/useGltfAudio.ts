import { useEffect, useRef, useState } from "react";

import { decodeGltfAudio, getAudioContext, type GltfAudioSource } from "./gltfAudio";

export { resumeAudioContext } from "./gltfAudio";

export interface GltfAudioResult {
  hasAudio: boolean;
}

/**
 * `playing` starts and stops the sound. `getPlaybackTime` reports the
 * animation's current time, so every (re)start lands where the motion is.
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
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loopRef.current;
    source.connect(gain);
    const time = Math.max(getPlaybackTimeRef.current?.() ?? 0, 0);
    const offset = source.loop ? time % buffer.duration : time;
    if (offset < buffer.duration) {
      source.start(0, offset);
    }
    sourceRef.current = source;

    return () => {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
      sourceRef.current = null;
      gain.disconnect();
      gainRef.current = null;
    };
  }, [playing, hasAudio, muted]);

  return { hasAudio };
}
