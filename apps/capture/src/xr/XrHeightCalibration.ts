/** A neutral entry posture defines size; movement afterwards never changes it. */
export class XrHeightCalibration {
  refitting = false;
  eyeHeight: number | undefined;
  private candidate: number | undefined;
  private stableSeconds = 0;

  reset(): void {
    this.eyeHeight = undefined;
    this.refitting = false;
    this.interrupt();
  }

  requestRefit(): void {
    this.refitting = true;
    this.interrupt();
  }

  interrupt(): void {
    this.candidate = undefined;
    this.stableSeconds = 0;
  }

  update(height: number | undefined, deltaSec: number): number | undefined {
    if (this.eyeHeight !== undefined && !this.refitting) return undefined;
    if (height === undefined || !Number.isFinite(height) || height < 0.65 || height > 2.4) {
      this.interrupt();
      return undefined;
    }
    if (this.candidate === undefined || Math.abs(height - this.candidate) > 0.02) {
      this.candidate = height;
      this.stableSeconds = 0;
    }
    this.stableSeconds += Math.max(0, Math.min(deltaSec, 1 / 15));
    if (this.stableSeconds < 0.5) return undefined;
    this.eyeHeight = height;
    this.refitting = false;
    return height;
  }
}
