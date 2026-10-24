import { PokeInteractable, RayInteractable, UIKit, UIKitDocument, type Entity, type World } from "@iwsdk/core";
import type { DockAction } from "@holoim/xr-ui-core";
import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3, type Object3D } from "three";

import { createGlyph, type GlyphElement, type GlyphName } from "./glyphs.js";
import { COLOR, DOCK_REFERENCE_DISTANCE_M, GLYPH, HEADSET_SCALE, HIT, SHADE, metresPerApx } from "./tokens.js";

// The hand dock (styleguide §1.2, §9.1): glyphs on the non-dominant hand or
// controller in a headset, within reach and so without text; on a phone, the
// bottom dock in the thumb zone. IWSDK has no DOM overlay in phone AR, so the
// phone dock is a strip attached to the camera, the one exemption from "no
// interactive UI follows the head": on a phone the screen is the hand.

/** Phone dock depth in front of the camera: inside the near view, clear of the scene. */
const PHONE_DOCK_DEPTH_M = 0.3;

const DOCK_GLYPHS: Record<DockAction["glyph"], GlyphName> = { exit: "exit", record: "recordIdle" };

export type HandDockMount =
  /** `ownPointerIds`: the pointers of the hand the dock rides on, which must reach past it. */
  | { kind: "hand"; space: Object3D; ownPointerIds: readonly number[] }
  | { kind: "phone"; camera: Object3D; verticalFovRad: number; viewportHeightCss: number; viewportWidthCss: number };

export interface HandDockProbe {
  mount: HandDockMount["kind"];
  visible: boolean;
  metresPerApx: number;
  hitApx: number;
  glyphApx: number;
  buttons: Record<string, { worldPosition: [number, number, number] }>;
}

interface DockButton {
  action: DockAction;
  hit: InstanceType<typeof UIKit.Container>;
  glyph: GlyphElement;
  hovered: boolean;
  pressed: boolean;
}

export class HandDock {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly buttons: DockButton[] = [];
  private readonly mount: HandDockMount;
  private readonly metresPerApx: number;
  private readonly hitApx: number;
  private readonly glyphApx: number;
  private shade: Mesh<PlaneGeometry, MeshBasicMaterial> | null = null;

  constructor(world: World, mount: HandDockMount, actions: readonly DockAction[]) {
    this.mount = mount;
    const phone = mount.kind === "phone";
    // A phone draws flat sizes in CSS pixels at the dock's depth; a headset dock is read at arm's reach.
    this.metresPerApx = phone
      ? (2 * PHONE_DOCK_DEPTH_M * Math.tan(mount.verticalFovRad / 2)) / mount.viewportHeightCss
      : metresPerApx(DOCK_REFERENCE_DISTANCE_M);
    const scale = phone ? 1 : HEADSET_SCALE;
    this.glyphApx = GLYPH.icon * scale;
    // Touch on a phone; poke in a headset: 72 apx and never under 20 mm (§6.1).
    this.hitApx = phone ? HIT.touch : Math.max(HIT.poke, HIT.pokeFloorMm / 1000 / this.metresPerApx);

    const root = new UIKit.Container({
      pixelSize: this.metresPerApx,
      flexDirection: "row",
      alignItems: "center",
      gap: phone ? GLYPH.gap : HIT.pokeGap,
      anchorY: phone ? "bottom" : "center",
      pointerEventsType: this.pointerFilter()
    });
    for (const action of actions) {
      const hit = new UIKit.Container({ width: this.hitApx, height: this.hitApx, alignItems: "center", justifyContent: "center" });
      const glyph = createGlyph(DOCK_GLYPHS[action.glyph], { size: this.glyphApx, color: COLOR.gold });
      glyph.element.setProperties({ pointerEvents: "none" });
      hit.add(glyph.element);
      root.add(hit);
      const button: DockButton = { action, hit, glyph, hovered: false, pressed: false };
      hit.addEventListener("pointerenter" as never, () => (button.hovered = true));
      hit.addEventListener("pointerleave" as never, () => {
        button.hovered = false;
        button.pressed = false;
      });
      hit.addEventListener("pointerdown" as never, () => (button.pressed = true));
      hit.addEventListener("pointerup" as never, () => (button.pressed = false));
      hit.addEventListener("click" as never, () => {
        if (this.entity.object3D!.visible) action.onSelect();
      });
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
      // Above the back of the hand or controller, tilted toward the eyes.
      mount.space.add(object);
      object.position.set(0, 0.05, 0.02);
      object.rotation.set(-Math.PI / 4, 0, 0);
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

  /**
   * The other hand pokes or points at the dock; the hand it rides on never
   * does. Its touch pointer would otherwise hover the dock all the time, and
   * IWSDK prefers touch over grab, so that hand could never grab.
   */
  private pointerFilter(): (id: number, type: string) => boolean {
    const own = new Set(this.mount.kind === "hand" ? this.mount.ownPointerIds : []);
    return (id, type) => type !== "grab" && !own.has(id);
  }

  setVisible(visible: boolean): void {
    this.entity.object3D!.visible = visible;
  }

  update(): void {
    for (const button of this.buttons) {
      button.glyph.setColor(button.hovered ? COLOR.highlight : COLOR.gold);
      button.glyph.setOpacity(button.pressed ? GLYPH.pressedOpacity : 1);
    }
  }

  probe(): HandDockProbe {
    const buttons: HandDockProbe["buttons"] = {};
    for (const button of this.buttons) {
      buttons[button.action.id] = { worldPosition: button.hit.getWorldPosition(new Vector3()).toArray() as [number, number, number] };
    }
    return { mount: this.mount.kind, visible: this.entity.object3D!.visible, metresPerApx: this.metresPerApx, hitApx: this.hitApx, glyphApx: this.glyphApx, buttons };
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
