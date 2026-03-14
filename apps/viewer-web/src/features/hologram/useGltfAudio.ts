import { useEffect, useRef, useState } from "react";

/** Minimal GLTF result shape needed for audio extraction. */
interface GltfResult {
  parser: { loadBufferView: (index: number) => Promise<ArrayBuffer> };
  userData: Record<string, unknown>;
}

interface KhrAudioData {
  audio: Array<{ bufferView: number; mimeType: string }>;
  sources: Array<{ audio: number; autoPlay?: boolean; loop?: boolean }>;
  emitters: Array<{ type: string; sources: number[]; gain?: number }>;
}

export interface GltfAudioResult {
  hasAudio: boolean;
}

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContext();
  }
  return sharedAudioContext;
}

/** Resume AudioContext after a user gesture (browser autoplay policy). */
export function resumeAudioContext(): void {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
}

function extractKhrAudio(gltf: GltfResult): KhrAudioData | null {
  const userData = gltf.userData as Record<string, unknown> | undefined;
  const extensions = userData?.gltfExtensions as
    | Record<string, unknown>
    | undefined;
  if (!extensions) return null;

  const khrAudio = extensions["KHR_audio"] as KhrAudioData | undefined;
  if (!khrAudio?.audio?.length) return null;

  return khrAudio;
}

export function useGltfAudio(
  gltf: GltfResult,
  active: boolean,
  muted: boolean
): GltfAudioResult {
  const [hasAudio, setHasAudio] = useState(false);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const loopRef = useRef(true);

  // Decode audio from KHR_audio extension on mount
  useEffect(() => {
    let cancelled = false;

    const khrAudio = extractKhrAudio(gltf);
    if (!khrAudio) {
      setHasAudio(false);
      return;
    }

    const audioEntry = khrAudio.audio[0];
    if (audioEntry === undefined) {
      setHasAudio(false);
      return;
    }

    const source = khrAudio.sources?.[0];
    loopRef.current = source?.loop !== false;

    // Load the buffer view containing audio data
    gltf.parser
      .loadBufferView(audioEntry.bufferView)
      .then((rawBuffer: ArrayBuffer) => {
        if (cancelled) return;
        const ctx = getAudioContext();
        // decodeAudioData may detach the buffer, so pass a copy
        return ctx.decodeAudioData(rawBuffer.slice(0));
      })
      .then((decodedBuffer: AudioBuffer | undefined) => {
        if (cancelled || !decodedBuffer) return;
        audioBufferRef.current = decodedBuffer;
        setHasAudio(true);
      })
      .catch((err: unknown) => {
        console.warn("Failed to decode KHR_audio data:", err);
        setHasAudio(false);
      });

    return () => {
      cancelled = true;
    };
  }, [gltf]);

  // Create/destroy audio source based on active + muted state.
  // muted is included so the gain node always reflects the current value.
  useEffect(() => {
    if (!active || !audioBufferRef.current) {
      // Stop playback when inactive
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
    source.start(0);
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
  }, [active, hasAudio, muted]);

  return { hasAudio };
}
