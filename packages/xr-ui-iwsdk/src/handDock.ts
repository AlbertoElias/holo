import { apxToMeters, hitAreaMeters, tokens } from "@holoim/design-tokens";
import { PokeInteractable, RayInteractable, UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import { glyphGapApx, type DockAction } from "@holoim/xr-ui-core";
import { CanvasTexture, Euler, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3, type Material, type Object3D } from "three";

import { createGlyph, type GlyphElement, type GlyphName } from "./glyphs.js";
import { POKE } from "./pointers.js";
import { COLOR, GLYPH, HIT, SHADE } from "./tokens.js";

// The hand dock (styleguide §1.2, §9.1): glyphs on the non-dominant wrist or
// controller in a headset, within reach and so without text; on a phone, the
// bottom dock in the thumb zone. IWSDK has no DOM overlay in phone AR, so the
// phone dock is a strip attached to the camera, the one exemption from "no
// interactive UI follows the head": on a phone the screen is the hand.
//
// Commits come from IWSDK's pointers only: a ray (or a phone tap) on click,
// a poke on contact (pointerdown), and only for a fingertip that arrived from
// in front of the glyph's face. Each poke approach commits once.

/** Phone dock depth in front of the camera: inside the near view, clear of the scene. */
const PHONE_DOCK_DEPTH_M = 0.3;

/** In a headset the row is read at arm's reach (§6.1: 45 cm). */
const ARM_REACH_M = tokens.placement.armReachM;

export type HandDockMount =
  /** `ownPointerIds`: the pointers of the hand the dock rides on, which must reach past it. */
  | { kind: "hand"; space: Object3D; ownPointerIds: readonly number[] }
  | { kind: "phone"; camera: Object3D; verticalFovRad: number; viewportHeightCss: number; viewportWidthCss: number };

export interface HandDockOptions {
  /** Headset hit areas: "poke" for a tracked pressing hand, "ray" for a controller (§6.1). Default poke. */
  input?: "poke" | "ray";
  /** Draws over everything, for a wrist inside the wearer's own avatar sleeve. */
  drawOverBody?: boolean;
  /** Whether this commit may run now (a held select owned by something else, a take still exporting). */
  canCommit?(action: DockAction, pointerId: number): boolean;
  /** After a commit ran, for feedback: a tick for a poke, a pulse for a ray. */
  onCommit?(action: DockAction, pointerId: number, kind: "poke" | "ray"): void;
  /** A pointer came onto or left a glyph. */
  onHover?(action: DockAction, pointerId: number, hovered: boolean): void;
}

export interface HandDockProbe {
  mount: HandDockMount["kind"];
  input: "poke" | "ray" | "touch";
  visible: boolean;
  metresPerApx: number;
  hitApx: number;
  glyphApx: number;
  /** Drawn and hit sizes in metres (ring or icon; hit area per input). */
  drawnSizeM: number;
  hitSizeM: number;
  buttons: Record<string, { worldPosition: [number, number, number]; hovered: boolean; recording: boolean }>;
}

interface DockButton {
  action: DockAction;
  hit: InstanceType<typeof UIKit.Container>;
  glyph: GlyphElement;
  /** Rays (or taps) resting on it. */
  hovering: Set<number>;
  /** Fingertips within the poke's proximity in front of it. */
  near: Set<number>;
  pressed: boolean;
  recording: boolean;
}

// 4 cm out of the back of the wrist (its local +Y), faces looking along it (§1.2).
const WRIST_OFFSET = new Matrix4().compose(
  new Vector3(0, tokens.placement.wristOffsetM, 0),
  new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0)),
  new Vector3(1, 1, 1)
);
const followMatrix = new Matrix4();

const tipLocal = new Vector3();
const faceCentre = new Vector3();
const faceNormal = new Vector3();
const faceRotation = new Quaternion();

export class HandDock {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly buttons: DockButton[] = [];
  private readonly mount: HandDockMount;
  private readonly options: HandDockOptions;
  private readonly metresPerApx: number;
  private readonly hitApx: number;
  private readonly glyphApx: number;
  private readonly drawnSizeM: number;
  private readonly hitSizeM: number;
  /** Touch pointers seen in front of a glyph's face since their last commit. */
  private readonly armed = new Set<number>();
  private pressedUntilMs = 0;
  private shade: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;
  /** A wrist space outside IWSDK's entity tree, whose pose the dock copies each frame. */
  private follows: Object3D | null = null;

  constructor(world: World, mount: HandDockMount, actions: readonly DockAction[], options: HandDockOptions = {}) {
    this.mount = mount;
    this.options = options;
    const phone = mount.kind === "phone";
    const input = options.input ?? "poke";
    const ringed = actions.some((action) => action.glyph === "record");
    // Record sits in the 36 apx ring; Exit is a 16 apx icon.
    const drawnApx = ringed ? GLYPH.ring : GLYPH.icon;
    if (phone) {
      // A phone draws flat sizes in CSS pixels at the dock's depth.
      this.metresPerApx = (2 * PHONE_DOCK_DEPTH_M * Math.tan(mount.verticalFovRad / 2)) / mount.viewportHeightCss;
      this.glyphApx = drawnApx;
      this.hitApx = Math.max(HIT.touch, drawnApx);
      this.drawnSizeM = drawnApx * this.metresPerApx;
      this.hitSizeM = this.hitApx * this.metresPerApx;
    } else {
      // A headset dock is read at arm's reach, drawn at 2.5×; hit areas are per input and never scaled.
      this.metresPerApx = apxToMeters(1, ARM_REACH_M, { headset: false });
      this.drawnSizeM = apxToMeters(drawnApx, ARM_REACH_M, { headset: true });
      this.hitSizeM = hitAreaMeters(input, drawnApx * tokens.size.headsetScale, ARM_REACH_M, { headset: false });
      this.glyphApx = this.drawnSizeM / this.metresPerApx;
      this.hitApx = this.hitSizeM / this.metresPerApx;
    }

    const root = new UIKit.Container({
      pixelSize: this.metresPerApx,
      flexDirection: "row",
      alignItems: "center",
      gap: phone ? GLYPH.gap : glyphGapApx(input, { headset: true }),
      anchorY: phone ? "bottom" : "center",
      pointerEventsType: this.pointerFilter()
    });
    for (const action of actions) {
      const hit = new UIKit.Container({ width: this.hitApx, height: this.hitApx, alignItems: "center", justifyContent: "center" });
      const record = action.glyph === "record";
      const glyph = createGlyph(record ? "recordIdle" : (action.glyph as GlyphName), {
        size: this.glyphApx,
        color: COLOR.gold,
        // Record: rose shapes inside the gold ring, at the ring's full 16-unit box (§6).
        ...(record ? { ring: { innerSize: GLYPH.icon }, fill: COLOR.record } : {})
      });
      glyph.element.setProperties({ pointerEvents: "none" });
      hit.add(glyph.element);
      root.add(hit);
      const button: DockButton = { action, hit, glyph, hovering: new Set(), near: new Set(), pressed: false, recording: false };
      this.bindPointer(button);
      this.buttons.push(button);
    }

    this.document = new UIKitDocument(root);
    this.entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    const object = this.entity.object3D!;
    object.name = "HandDock";
    object.add(this.document);
    this.entity.addComponent(RayInteractable);
    if (!phone) this.entity.addComponent(PokeInteractable);

    if (mount.kind === "hand") {
      // IWSDK's TransformSystem moves an entity back under the level unless its
      // parent is an entity too, so a plain three space (capture's wrist) is
      // followed instead of parented.
      if ((mount.space as Object3D & { entityIdx?: number }).entityIdx !== undefined) {
        mount.space.add(object);
        WRIST_OFFSET.decompose(object.position, object.quaternion, object.scale);
      } else {
        this.follows = mount.space;
        this.follow();
      }
    } else {
      mount.camera.add(object);
      // Bottom centre, above the home bar and safe area (§6.1, §9.3).
      const halfHeight = PHONE_DOCK_DEPTH_M * Math.tan(mount.verticalFovRad / 2);
      object.position.set(0, -halfHeight + (HIT.phoneHomeBar + GLYPH.gap) * this.metresPerApx, -PHONE_DOCK_DEPTH_M);
      // The dock sits on the soft shade a hologram casts, spread along the bottom of the screen (§5.2).
      this.shade = phoneShade(mount.viewportWidthCss * this.metresPerApx, SHADE.phoneHeight * mount.viewportHeightCss * this.metresPerApx);
      this.shade.position.set(0, (this.hitApx / 2) * this.metresPerApx, -0.001);
      object.add(this.shade);
    }
  }

  private bindPointer(button: DockButton): void {
    const { action, hit } = button;
    type DockPointerEvent = { pointerId: number; pointerType: string; pointerPosition: Vector3 };
    hit.addEventListener("pointerenter" as never, ((event: DockPointerEvent) => {
      // A touch pointer hovers from 20 cm away; it counts as near only within the poke's proximity.
      if (event.pointerType === "touch") return;
      button.hovering.add(event.pointerId);
      this.options.onHover?.(action, event.pointerId, true);
    }) as never);
    hit.addEventListener("pointerleave" as never, ((event: DockPointerEvent) => {
      button.near.delete(event.pointerId);
      button.pressed = false;
      if (event.pointerType === "touch" || !button.hovering.delete(event.pointerId)) return;
      this.options.onHover?.(action, event.pointerId, false);
    }) as never);
    hit.addEventListener("pointermove" as never, ((event: DockPointerEvent) => {
      if (event.pointerType !== "touch") return;
      // Armed only from in front of the face: a tip arriving from the side or behind never commits.
      const depth = this.depthInFront(hit, event.pointerPosition);
      if (depth > POKE.rearmM) this.armed.add(event.pointerId);
      if (depth <= POKE.proximityM && depth >= -POKE.throughM) button.near.add(event.pointerId);
      else button.near.delete(event.pointerId);
    }) as never);
    hit.addEventListener("pointerdown" as never, ((event: DockPointerEvent) => {
      button.pressed = true;
      if (event.pointerType !== "touch" || !this.armed.has(event.pointerId)) return;
      this.armed.delete(event.pointerId);
      this.commit(button, event.pointerId, "poke");
    }) as never);
    hit.addEventListener("pointerup" as never, (() => (button.pressed = false)) as never);
    hit.addEventListener("click" as never, ((event: DockPointerEvent) => {
      if (event.pointerType === "touch") return;
      this.commit(button, event.pointerId, "ray");
    }) as never);
  }

  private commit(button: DockButton, pointerId: number, kind: "poke" | "ray"): void {
    if (!this.isShown() || this.options.canCommit?.(button.action, pointerId) === false) return;
    this.pressedUntilMs = performance.now() + PRESSED_SHOW_MS;
    button.action.onSelect();
    this.options.onCommit?.(button.action, pointerId, kind);
  }

  /** How far a world point sits in front of a glyph's face, along its normal (metres; negative behind). */
  private depthInFront(hit: Object3D, point: Vector3): number {
    hit.getWorldPosition(faceCentre);
    faceNormal.set(0, 0, 1).applyQuaternion(hit.getWorldQuaternion(faceRotation));
    return tipLocal.copy(point).sub(faceCentre).dot(faceNormal);
  }

  /**
   * The other hand pokes or points at the dock; the hand it rides on never
   * does. Its touch pointer would otherwise hover the dock all the time, and
   * IWSDK prefers touch over grab, so that hand could never grab.
   */
  private pointerFilter(): (id: number, type: string) => boolean {
    const own = new Set(this.mount.kind === "hand" ? this.mount.ownPointerIds : []);
    return (id, type) => type !== "grab" && !own.has(id);
  }

  private isShown(): boolean {
    for (let node: Object3D | null = this.entity.object3D!; node; node = node.parent) if (!node.visible) return false;
    return true;
  }

  setVisible(visible: boolean): void {
    this.entity.object3D!.visible = visible;
  }

  /** Record turns into Stop: the rose shape alone carries the state (§8.5). */
  setRecording(recording: boolean): void {
    for (const button of this.buttons) {
      if (button.action.glyph !== "record" || button.recording === recording) continue;
      button.recording = recording;
      button.glyph.setDrawing(recording ? "recordStop" : "recordIdle");
    }
    if (this.options.drawOverBody) drawOverBody(this.entity.object3D!);
  }

  /** Copies a followed wrist space's world pose, with the wrist offset, onto the dock. */
  follow(): void {
    if (!this.follows) return;
    const object = this.entity.object3D!;
    this.follows.updateWorldMatrix(true, false);
    followMatrix.multiplyMatrices(this.follows.matrixWorld, WRIST_OFFSET);
    if (object.parent) {
      object.parent.updateWorldMatrix(true, false);
      followMatrix.premultiply(object.parent.matrixWorld.clone().invert());
    }
    followMatrix.decompose(object.position, object.quaternion, object.scale);
    object.updateMatrixWorld(true);
  }

  /**
   * Hover (cream) when a pointer rests on a glyph or `approached` names it
   * (a fingertip near it); pressed (55%) while held and just after a commit.
   */
  update(approached: ReadonlySet<string> = NO_IDS): void {
    this.follow();
    const justCommitted = performance.now() < this.pressedUntilMs;
    for (const button of this.buttons) {
      const hovered = button.hovering.size > 0 || button.near.size > 0 || approached.has(button.action.id);
      button.glyph.setColor(hovered ? COLOR.highlight : COLOR.gold);
      button.glyph.setOpacity(button.pressed || justCommitted ? GLYPH.pressedOpacity : 1);
    }
    if (this.options.drawOverBody) drawOverBody(this.entity.object3D!);
  }

  /** The hit area of an action's glyph: its centre is the glyph's centre, its +Z the face's normal. */
  hitTarget(actionId: string): Object3D | null {
    return this.buttons.find((button) => button.action.id === actionId)?.hit ?? null;
  }

  /** Whether a pointer rests on an action's glyph. */
  isHoveredBy(actionId: string, pointerId: number): boolean {
    return this.buttons.find((button) => button.action.id === actionId)?.hovering.has(pointerId) ?? false;
  }

  get sizes(): { drawnSizeM: number; hitSizeM: number } {
    return { drawnSizeM: this.drawnSizeM, hitSizeM: this.hitSizeM };
  }

  probe(): HandDockProbe {
    const buttons: HandDockProbe["buttons"] = {};
    for (const button of this.buttons) {
      buttons[button.action.id] = {
        worldPosition: button.hit.getWorldPosition(new Vector3()).toArray() as [number, number, number],
        hovered: button.hovering.size > 0,
        recording: button.recording
      };
    }
    return {
      mount: this.mount.kind,
      input: this.mount.kind === "phone" ? "touch" : (this.options.input ?? "poke"),
      visible: this.isShown(),
      metresPerApx: this.metresPerApx,
      hitApx: this.hitApx,
      glyphApx: this.glyphApx,
      drawnSizeM: this.drawnSizeM,
      hitSizeM: this.hitSizeM,
      buttons
    };
  }

  dispose(): void {
    for (const button of this.buttons) button.glyph.dispose();
    this.shade?.geometry.dispose();
    this.shade?.material.map?.dispose();
    this.shade?.material.dispose();
    this.entity.object3D!.removeFromParent();
    this.document.dispose();
    this.entity.destroy();
  }
}

/** How long a committed glyph shows pressed (§6 states). */
const PRESSED_SHOW_MS = 120;
const NO_IDS: ReadonlySet<string> = new Set();
/** Above the scene and the avatar, below the aim rays. */
const OVER_BODY_ORDER = 990;

/**
 * Held on a controller, the wrist glyph sits inside the avatar's sleeve and
 * cuff, and depth testing hides it there (capture, measured in IWER). Nothing
 * else comes between the eye and a wrist at arm's reach, so the dock draws
 * over everything. Glyph drawings are rebuilt when Record turns into Stop,
 * so this runs after each change.
 */
function drawOverBody(root: Object3D): void {
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.renderOrder = OVER_BODY_ORDER;
    for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[]) {
      material.depthTest = false;
      material.depthWrite = false;
    }
  });
}

/**
 * The shade (§5.1) as a `width` × `height` m plane: radial-gradient(closest-side,
 * deepSea .7, deepSea .5 at 60%, transparent). It takes no pointer, so taps
 * through it still reach the scene.
 */
function phoneShade(width: number, height: number): Mesh<PlaneGeometry, MeshBasicMaterial> {
  // A square gradient; the plane stretches it into the closest-side ellipse.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  const rgb = [1, 3, 5].map((i) => parseInt(COLOR.deepSea.slice(i, i + 2), 16)).join(",");
  gradient.addColorStop(0, `rgba(${rgb},${SHADE.inner})`);
  gradient.addColorStop(SHADE.midStop, `rgba(${rgb},${SHADE.mid})`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(
    new PlaneGeometry(width, height),
    new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false })
  );
  mesh.name = "PhoneDockShade";
  mesh.renderOrder = -1;
  mesh.raycast = () => undefined;
  return mesh;
}
