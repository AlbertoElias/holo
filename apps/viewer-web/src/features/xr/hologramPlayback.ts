import { createComponent, createSystem, Types, type Entity } from "@iwsdk/core";
import { AnimationMixer, LoopRepeat } from "three";
import type { AnimationAction, AnimationClip, Object3D } from "three";

import { ScheduledGltfAudio, type DecodedGltfAudio } from "../hologram/gltfAudio";
import { rankClipsForPlayback } from "../hologram/hologramScene";

// IWSDK has no animation system and its AudioSystem cannot seek, so each
// hologram's clip clock, mixer and audio live here. The clock is the single
// source of truth: every frame the actions are set to it, and audio is
// (re)started from it whenever play, seek, restart or a loop wrap happens,
// or when the audio's own clock has drifted from it.

const SECONDARY_CLIP_WEIGHT = 0.35;
/** Audio further than this from the clip clock is restarted from it (its clock ran slow or fast; well under lip-sync's ~45 ms). */
const AUDIO_DRIFT_RESYNC_S = 0.03;

export interface HologramRuntime {
  mixer: AnimationMixer;
  actions: AnimationAction[];
  audio: ScheduledGltfAudio | null;
  /** Where the audio was, sampled on the last frame with the clip clock; null when silent. */
  audioOffset: number | null;
}

export const HologramPlayback = createComponent("HologramPlayback", {
  playing: { type: Types.Boolean, default: true },
  clipTime: { type: Types.Float64, default: 0 },
  duration: { type: Types.Float64, default: 0 },
  loop: { type: Types.Boolean, default: true },
  // Only the focused hologram is heard.
  audible: { type: Types.Boolean, default: true },
  // Set by seek/restart; the system restarts audio from clipTime.
  resync: { type: Types.Boolean, default: false },
  runtime: { type: Types.Object, default: undefined }
});

/** Builds the mixer for a loaded hologram; returns the clip length (0 = still). */
export function createHologramRuntime(
  root: Object3D,
  clips: readonly AnimationClip[],
  audio: DecodedGltfAudio | null
): { runtime: HologramRuntime; duration: number } {
  const mixer = new AnimationMixer(root);
  const ranked = rankClipsForPlayback(clips);
  const actions = ranked.map((clip, index) => {
    const action = mixer.clipAction(clip);
    action.setLoop(LoopRepeat, Infinity);
    action.setEffectiveWeight(index === 0 ? 1 : SECONDARY_CLIP_WEIGHT);
    action.play();
    return action;
  });
  const duration = ranked[0]?.duration ?? 0;
  return { runtime: { mixer, actions, audio: audio ? new ScheduledGltfAudio(audio) : null, audioOffset: null }, duration };
}

export function disposeHologramRuntime(runtime: HologramRuntime): void {
  runtime.mixer.stopAllAction();
  runtime.mixer.uncacheRoot(runtime.mixer.getRoot());
  runtime.audio?.dispose();
}

export function setHologramPlaying(entity: Entity, playing: boolean): void {
  if (entity.getValue(HologramPlayback, "playing") === playing) return;
  entity.setValue(HologramPlayback, "playing", playing);
  entity.setValue(HologramPlayback, "resync", true);
}

export function seekHologram(entity: Entity, clipTime: number): void {
  const duration = entity.getValue(HologramPlayback, "duration") ?? 0;
  entity.setValue(HologramPlayback, "clipTime", Math.min(Math.max(clipTime, 0), duration));
  entity.setValue(HologramPlayback, "resync", true);
}

export function restartHologram(entity: Entity): void {
  seekHologram(entity, 0);
}

export class HologramPlaybackSystem extends createSystem({
  holograms: { required: [HologramPlayback] }
}) {
  update(delta: number): void {
    for (const entity of this.queries.holograms.entities) {
      const runtime = entity.getValue(HologramPlayback, "runtime") as HologramRuntime | undefined;
      if (!runtime) continue;
      const playing = Boolean(entity.getValue(HologramPlayback, "playing"));
      const duration = entity.getValue(HologramPlayback, "duration") ?? 0;
      const loop = Boolean(entity.getValue(HologramPlayback, "loop"));
      let clipTime = entity.getValue(HologramPlayback, "clipTime") ?? 0;
      let resync = Boolean(entity.getValue(HologramPlayback, "resync"));

      if (playing && duration > 0) {
        clipTime += delta;
        if (clipTime >= duration) {
          if (loop) {
            clipTime %= duration;
            // Motion and sound wrap together.
            resync = true;
          } else {
            clipTime = duration;
            entity.setValue(HologramPlayback, "playing", false);
            resync = true;
          }
        }
        entity.setValue(HologramPlayback, "clipTime", clipTime);
      }

      for (const action of runtime.actions) {
        const clipDuration = action.getClip().duration;
        action.time = clipDuration > 0 ? clipTime % clipDuration : 0;
      }
      runtime.mixer.update(0);

      const audio = runtime.audio;
      if (audio) {
        const audible = Boolean(entity.getValue(HologramPlayback, "audible"));
        const shouldPlay = Boolean(entity.getValue(HologramPlayback, "playing")) && audible;
        if (!shouldPlay) {
          audio.stop();
        } else if (resync || !audio.playing || audioDrift(audio, clipTime) > AUDIO_DRIFT_RESYNC_S) {
          audio.start(clipTime);
        }
        runtime.audioOffset = audio.scheduledOffset();
      }
      if (resync) entity.setValue(HologramPlayback, "resync", false);
    }
  }
}

/** How far the playing audio is from the clip clock, in seconds (0 once a non-looping track has ended). */
function audioDrift(audio: ScheduledGltfAudio, clipTime: number): number {
  const heard = audio.scheduledOffset();
  if (heard === null) return 0;
  if (!audio.loop) return clipTime < audio.duration ? Math.abs(heard - clipTime) : 0;
  const drift = Math.abs(heard - (clipTime % audio.duration));
  return Math.min(drift, audio.duration - drift);
}
