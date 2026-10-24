import type * as THREE from 'three';

// Set for slice 4 (docs/features/ui-redesign.md): the styleguide asks for a
// soft spatial tick on a poke's commit and gives no sound, so these are
// open to revisit with device check "the tick on a real poke".
const TICK_HZ = 2200;
const TICK_SEC = 0.018;
const TICK_GAIN = 0.12;

/**
 * The soft spatial tick a poke makes on commit (styleguide 6.1). It plays
 * on its own AudioContext straight to the speakers, never through the
 * recorder's graph, so it stays out of the capture mix; whether the headset
 * microphone hears it through the air is a device check.
 */
export class SpatialTick {
  private context: AudioContext | null = null;

  private ensure(): AudioContext | null {
    try {
      this.context ??= new AudioContext();
    } catch {
      return null;
    }
    if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
    return this.context;
  }

  /**
   * Creates and resumes the context while the page still has the user
   * activation of the Enter VR press; a context first made at a poke, with no
   * activation, stays suspended and the first ticks would be silent.
   */
  prime(): void {
    this.ensure();
  }

  play(at: THREE.Vector3, listener: THREE.Camera): void {
    const context = this.ensure();
    if (!context) return;
    listener.updateWorldMatrix(true, false);
    const e = listener.matrixWorld.elements;
    const audioListener = context.listener;
    // Forward is the camera's −Z, up its +Y, both in world space.
    if (audioListener.positionX) {
      audioListener.positionX.value = e[12]!;
      audioListener.positionY.value = e[13]!;
      audioListener.positionZ.value = e[14]!;
      audioListener.forwardX.value = -e[8]!;
      audioListener.forwardY.value = -e[9]!;
      audioListener.forwardZ.value = -e[10]!;
      audioListener.upX.value = e[4]!;
      audioListener.upY.value = e[5]!;
      audioListener.upZ.value = e[6]!;
    }
    const now = context.currentTime;
    const oscillator = new OscillatorNode(context, { type: 'sine', frequency: TICK_HZ });
    const gain = new GainNode(context, { gain: 0 });
    const panner = new PannerNode(context, { panningModel: 'HRTF', positionX: at.x, positionY: at.y, positionZ: at.z, refDistance: 0.3 });
    gain.gain.setValueAtTime(TICK_GAIN, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + TICK_SEC);
    oscillator.connect(gain).connect(panner).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + TICK_SEC);
  }
}
