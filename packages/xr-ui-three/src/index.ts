import * as THREE from "three";

import type { RecordingUiState } from "@holoim/xr-ui-core";

export interface LabelPillStyle {
  text: string;
  background: string;
  border: string;
  color: string;
}

// Plain Three.js pill with canvas-drawn text. Replaces the @pmndrs/uikit
// panel, whose instanced glyph panels rendered without text on device and
// at 1/100th scale under its px->unit conversion (B-009).
const AIM_REACH_BEHIND_HAND_M = 0.6;

export class ThreeLabelPill {
  readonly group = new THREE.Group();

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly mesh: THREE.Mesh;
  private readonly tmpRay = new THREE.Ray();
  private readonly tmpRaycaster = new THREE.Raycaster();
  private readonly tmpQuat = new THREE.Quaternion();
  private lastKey = "";
  private lastStyle: LabelPillStyle | null = null;
  private hovered = false;

  constructor(
    private readonly widthM = 0.44,
    private readonly heightM = 0.14
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1024;
    this.canvas.height = Math.round((1024 * heightM) / widthM);
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("ThreeLabelPill: 2d canvas unavailable");
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, heightM),
      // Depth-tested (not always-on-top) so tracked hands in front of the
      // pill correctly occlude it.
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: true })
    );
    this.mesh.renderOrder = 999;
    this.group.add(this.mesh);
  }

  setHovered(hovered: boolean): void {
    if (hovered === this.hovered) return;
    this.hovered = hovered;
    this.lastKey = "";
    if (this.lastStyle) this.setContent(this.lastStyle);
  }

  setContent(style: LabelPillStyle): void {
    this.lastStyle = style;
    const key = `${style.text}|${style.background}|${style.border}|${style.color}|${this.hovered}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const { width, height } = this.canvas;
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    const radius = height / 2;
    ctx.beginPath();
    ctx.roundRect(6, 6, width - 12, height - 12, radius - 6);
    ctx.fillStyle = this.hovered ? "#2b7cc4" : style.background;
    ctx.fill();
    ctx.lineWidth = this.hovered ? 10 : 5;
    ctx.strokeStyle = this.hovered ? "#ffffff" : style.border;
    ctx.stroke();
    ctx.fillStyle = style.color;
    ctx.font = `600 ${Math.round(height * 0.34)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(style.text, width / 2, height / 2 + 2, width - 80);
    this.texture.needsUpdate = true;
  }

  // The controller's aim line, extended behind the hand: hands often reach
  // past the panel plane (0.55 m from the head), where a ray starting at the
  // hand could never hit it, yet the visible aim ray still lines up.
  isPointerOver(controller: THREE.Group): boolean {
    this.tmpRay.direction.set(0, 0, -1).applyQuaternion(controller.getWorldQuaternion(this.tmpQuat));
    controller.getWorldPosition(this.tmpRay.origin).addScaledVector(this.tmpRay.direction, -AIM_REACH_BEHIND_HAND_M);
    this.tmpRaycaster.ray.copy(this.tmpRay);
    return this.tmpRaycaster.intersectObject(this.mesh, false).length > 0;
  }
}

const STATUS_STYLES: Record<RecordingUiState["status"], Omit<LabelPillStyle, "text">> = {
  idle: { background: "#1a5d8f", border: "#8fcfff", color: "#f4fbff" },
  recording: { background: "#7a2530", border: "#ff9ca6", color: "#fff6f7" },
  exporting: { background: "#6f5a1e", border: "#f7cf7a", color: "#fff8d8" }
};

export class ThreeRecordingActionPanel {
  readonly group = new THREE.Group();

  private readonly pill = new ThreeLabelPill(0.44, 0.14);
  private pressT = 0;

  constructor() {
    this.group.add(this.pill.group);
    this.group.position.set(0, -0.15, -0.55);
    this.pill.setContent({ text: "Start Recording", ...STATUS_STYLES.idle });
  }

  updateFromCamera(camera: THREE.Camera): void {
    this.group.position.set(0, -0.15, -0.55);
    this.group.quaternion.copy(camera.quaternion);
  }

  setHovered(hovered: boolean): void {
    this.pill.setHovered(hovered);
  }

  press(): void {
    this.pressT = 1;
  }

  update(deltaSec: number, state: RecordingUiState): void {
    this.pill.setContent({ text: state.actionLabel, ...STATUS_STYLES[state.status] });
    if (this.pressT > 0) {
      this.pressT = Math.max(0, this.pressT - deltaSec / 0.22);
      const phase = 1 - this.pressT;
      this.pill.group.scale.setScalar(1 - 0.1 * Math.sin(phase * Math.PI));
    } else {
      this.pill.group.scale.setScalar(1);
    }
  }

  isPointerOverAction(controller: THREE.Group): boolean {
    return this.pill.isPointerOver(controller);
  }
}
