import * as THREE from 'three';
import { UIKit, UIKitDocument, RayInteractable, type Entity, type World } from '@iwsdk/core';
import { apxToMeters, tokens } from '@holoim/design-tokens';
import { dominantHand, markChrome, markChromeTree, type Handedness } from '@holoim/xr-ui-core';
import { COLOR, CHIP, CHIP_OPACITY, GLYPH, HIT, PHONE_DOCK_DEPTH_M, createGlyph, withAlpha, type GlyphElement } from '@holoim/xr-ui-iwsdk';
import type { ObjectTray } from '../objects/ObjectTray';
import type { TrayThumbnail } from '../objects/trayThumbnail';
import type { TrayUiState } from '../types/contracts';
import type { XrTracking } from '../xr/XrTracking';
import { dashedRingGeometry, ringGeometry, ringMaterial } from './trayRings';

// How each tray slot says it can be summoned on a headset and on a phone's AR
// screen (docs/features/tray-everywhere.md, "The tray UI"). Both are chrome:
// flagged so recording, export and pointing skip them.

const SLOTS = 5;
/** Headset signifiers are read at arm's reach, drawn at the headset's 2.5×. */
const ARM_REACH_M = tokens.placement.armReachM;
/** A miniature fits an 8 cm cube and its neighbour stands 10 cm away (ObjectTray); the ring is a little under the spacing. */
const RING_RADIUS_M = 0.045;
const TRAY_SPACING_M = 0.1;
/** While the summoning hand is full or reaching every signifier dims, which says why a pinch does nothing (§ Unavailable). */
const BLOCKED_OPACITY = 0.4;
/** The reachable ring's pinch or squeeze glyph stands this far toward the author from the ring's centre. */
const GLYPH_TOWARD_M = 0.07;

export type SummonGlyph = 'pinch' | 'squeeze';

export interface TraySignifierSlotProbe {
  slot: number;
  filled: boolean;
  reachable: boolean;
  /** The glyph beside the ring: pinch for tracked hands, squeeze for controllers; only on the reachable slot. */
  glyph: SummonGlyph | null;
  /** The ring's opacity: 1, or 0.4 while blocked; 0 when no ring shows at this slot. */
  opacity: number;
}

export interface XrTraySignifiersProbe {
  /** Rings are showing: the tray is open in a headset VR session. */
  visible: boolean;
  input: 'hands' | 'controllers';
  slots: TraySignifierSlotProbe[];
}

interface XrTraySignifiersDeps {
  world: World;
  tray: ObjectTray;
  tracking: XrTracking;
  getHandedness: () => Handedness;
}

interface SlotRing {
  group: THREE.Group;
  solid: THREE.Mesh;
  dashed: THREE.Mesh;
}

const box = new THREE.Box3();
const centre = new THREE.Vector3();
const right = new THREE.Vector3();
const quat = new THREE.Quaternion();
const eye = new THREE.Vector3();

/**
 * The headset's tray signifiers: a gold ring at each filled miniature's base,
 * and a muted dashed ring at the next empty place (a single "next" ring: the
 * arc re-centres as items arrive, so five fixed empty places would lie). The
 * ring the dominant palm would summon now brightens to the cream highlight and
 * carries the pinch (tracked hands) or squeeze (controllers) glyph. No text:
 * everything here is within arm's reach (§7.3). The miniatures themselves are
 * `ObjectTray`'s arc; this only adds rings and one glyph.
 */
export class XrTraySignifiers {
  /** Child of the VR chrome root; every object is chrome-flagged. */
  readonly root = new THREE.Group();
  private readonly rings: SlotRing[] = [];
  private glyphEntity: Entity | null = null;
  private glyph: GlyphElement | null = null;
  private glyphDocument: UIKitDocument | null = null;
  private lastProbe: XrTraySignifiersProbe = { visible: false, input: 'hands', slots: emptySlots() };

  constructor(private readonly deps: XrTraySignifiersDeps) {
    this.root.name = 'tray-signifiers';
    const stroke = apxToMeters(GLYPH.stroke, ARM_REACH_M, { headset: true });
    for (let i = 0; i < SLOTS; i += 1) {
      const group = new THREE.Group();
      group.name = `tray-ring-${i + 1}`;
      const solid = new THREE.Mesh(ringGeometry(RING_RADIUS_M, stroke), ringMaterial(COLOR.gold));
      const dashed = new THREE.Mesh(dashedRingGeometry(RING_RADIUS_M, stroke), ringMaterial(COLOR.textMuted));
      for (const mesh of [solid, dashed]) {
        // Flat under the miniature, facing up; never a pointer's target.
        mesh.rotation.x = -Math.PI / 2;
        mesh.renderOrder = 989;
        mesh.raycast = () => undefined;
        group.add(mesh);
      }
      group.visible = false;
      this.root.add(group);
      this.rings.push({ group, solid, dashed });
    }
    markChromeTree(this.root);
  }

  /** The glyph's UIKit entity and each ring are posed in world space; `parent` is the chrome root they hang from. */
  update(camera: THREE.Camera, shown: boolean, open: boolean, tray: TrayUiState, parent: THREE.Object3D): void {
    const input = this.deps.tracking.getHandPoseSource(dominantHand(this.deps.getHandedness())) === 'xr-hand' ? 'hands' : 'controllers';
    const visible = shown && open && tray.open;
    const slots = emptySlots();
    for (const ring of this.rings) ring.group.visible = false;
    let reachableAt: THREE.Vector3 | null = null;
    if (visible) {
      parent.updateWorldMatrix(true, false);
      const items = this.deps.tray.getItems();
      const opacity = tray.blocked ? BLOCKED_OPACITY : 1;
      let last: THREE.Vector3 | null = null;
      let spacing = TRAY_SPACING_M;
      items.slice(0, SLOTS).forEach((item, i) => {
        const wrapper = item.object.wrapper;
        wrapper.updateWorldMatrix(true, false);
        box.setFromObject(wrapper);
        box.getCenter(centre);
        const at = new THREE.Vector3(centre.x, box.min.y, centre.z);
        if (last) spacing = last.distanceTo(at) || spacing;
        last = at;
        const reachable = tray.reachableSlot === item.slot;
        this.place(this.rings[i]!, at, parent, false, reachable ? COLOR.highlight : COLOR.gold, opacity);
        slots[i] = { slot: item.slot, filled: true, reachable, glyph: reachable ? (input === 'hands' ? 'pinch' : 'squeeze') : null, opacity };
        if (reachable) reachableAt = at;
      });
      // One dashed ring where the next item will stand, continuing the arc's spacing along its right-hand axis.
      const lastItem = items[Math.min(items.length, SLOTS) - 1];
      if (lastItem && last && items.length < SLOTS) {
        lastItem.object.wrapper.getWorldQuaternion(quat);
        right.set(1, 0, 0).applyQuaternion(quat);
        const next = (last as THREE.Vector3).clone().addScaledVector(right, spacing);
        const index = items.length;
        this.place(this.rings[index]!, next, parent, true, COLOR.textMuted, opacity);
        slots[index] = { slot: index + 1, filled: false, reachable: false, glyph: null, opacity };
      }
    }
    this.updateGlyph(camera, reachableAt, input, tray.blocked);
    this.lastProbe = { visible, input, slots };
    markChromeTree(this.root);
    if (this.glyphEntity) markChromeTree(this.glyphEntity.object3D!);
  }

  probe(): XrTraySignifiersProbe {
    return { ...this.lastProbe, slots: this.lastProbe.slots.map((slot) => ({ ...slot })) };
  }

  hide(): void {
    for (const ring of this.rings) ring.group.visible = false;
    if (this.glyphEntity) this.glyphEntity.object3D!.visible = false;
    this.lastProbe = { visible: false, input: this.lastProbe.input, slots: emptySlots() };
  }

  dispose(): void {
    for (const ring of this.rings) for (const mesh of [ring.solid, ring.dashed]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.glyph?.dispose();
    this.glyphDocument?.dispose();
    this.glyphEntity?.object3D?.removeFromParent();
    this.glyphEntity?.destroy();
    this.glyphEntity = null;
    this.root.removeFromParent();
  }

  private place(ring: SlotRing, world: THREE.Vector3, parent: THREE.Object3D, dashed: boolean, color: string, opacity: number): void {
    ring.group.position.copy(parent.worldToLocal(world.clone()));
    // The chrome root may carry a rotation: counter it so the ring stays flat in the world.
    ring.group.quaternion.copy(parent.getWorldQuaternion(quat).invert());
    ring.group.visible = true;
    ring.solid.visible = !dashed;
    ring.dashed.visible = dashed;
    const mesh = dashed ? ring.dashed : ring.solid;
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.color.set(color);
    material.opacity = opacity;
  }

  /** The pinch or squeeze glyph in its own gold ring, beside the reachable slot's ring, turned to the eyes. */
  private updateGlyph(camera: THREE.Camera, at: THREE.Vector3 | null, input: 'hands' | 'controllers', blocked: boolean): void {
    if (!at) {
      if (this.glyphEntity) this.glyphEntity.object3D!.visible = false;
      return;
    }
    if (!this.glyphEntity) this.buildGlyph(input);
    const entity = this.glyphEntity!;
    const object = entity.object3D!;
    this.glyph!.setDrawing(input === 'hands' ? 'pinch' : 'squeeze');
    this.glyph!.setColor(COLOR.highlight);
    this.glyph!.setOpacity(blocked ? BLOCKED_OPACITY : 1);
    camera.getWorldPosition(eye);
    // Toward the author, level, so it sits in front of the ring rather than over a neighbour.
    centre.copy(eye).sub(at).setY(0);
    if (centre.lengthSq() > 1e-6) centre.normalize();
    const place = at.clone().addScaledVector(centre, GLYPH_TOWARD_M);
    place.y += 0.02;
    object.parent?.updateWorldMatrix(true, false);
    object.position.copy(object.parent ? object.parent.worldToLocal(place) : place);
    object.lookAt(eye);
    object.visible = true;
  }

  private buildGlyph(input: 'hands' | 'controllers'): void {
    const m = apxToMeters(1, ARM_REACH_M, { headset: true });
    this.glyph = createGlyph(input === 'hands' ? 'pinch' : 'squeeze', { size: GLYPH.ring, color: COLOR.highlight, ring: { innerSize: GLYPH.icon } });
    const root = new UIKit.Container({ pixelSize: m, flexDirection: 'row', alignItems: 'center', anchorX: 'center', anchorY: 'center', pointerEvents: 'none' });
    this.glyph.element.setProperties({ pointerEvents: 'none' });
    root.add(this.glyph.element);
    this.glyphDocument = new UIKitDocument(root);
    this.glyphEntity = this.deps.world.createTransformEntity(undefined, { parent: this.deps.world.activeLevel.value });
    const object = this.glyphEntity.object3D!;
    object.name = 'tray-summon-glyph';
    markChrome(object);
    object.add(this.glyphDocument);
  }
}

function emptySlots(): TraySignifierSlotProbe[] {
  return Array.from({ length: SLOTS }, (_, i) => ({ slot: i + 1, filled: false, reachable: false, glyph: null, opacity: 0 }));
}

// --- Phone AR: the row above the dock ---

export interface PhoneTrayRowSlotProbe {
  slot: number;
  filled: boolean;
  name: string | null;
  /** The slot's hit area on the screen (apx): at least 44. */
  hitApx: number;
  /** A thumbnail texture is on it. */
  thumbnail: boolean;
}

export interface PhoneTrayRowProbe {
  built: boolean;
  open: boolean;
  slots: PhoneTrayRowSlotProbe[];
  /** The row's backing chip on the screen (CSS px from the top left), null while closed. */
  chip: { left: number; top: number; width: number; height: number } | null;
}

interface PhoneTrayRowDeps {
  world: World;
  /** The XR camera: the row hangs on it like the dock, so it never lags the view. */
  camera: THREE.Object3D;
  verticalFovRad: number;
  viewportHeightCss: number;
  viewportWidthCss: number;
  /** Where the dock's chip stands, so the row sits just above it. */
  dockTopCss: () => number | null;
  thumbnail: (slot: number) => TrayThumbnail | null;
  onSlot: (slot: number) => void;
}

interface PhoneSlot {
  hit: InstanceType<typeof UIKit.Container>;
  solid: InstanceType<typeof UIKit.Content>;
  dashed: InstanceType<typeof UIKit.Content>;
  image: InstanceType<typeof UIKit.Image>;
  texture: THREE.CanvasTexture | null;
  canvas: HTMLCanvasElement | null;
  filled: boolean;
  name: string | null;
  committedAt: number;
}

/** A tap commits on the press or on the click, whichever the pointer delivers first. */
const COMMIT_DEBOUNCE_MS = 400;

/**
 * Phone AR's tray row (camera author): five 44 apx slots on the Android AR
 * chip, above the dock, children of the XR camera. A filled slot holds its
 * thumbnail in a gold ring; an empty one is a muted dashed ring. The chip
 * under the row is chrome as well, so a finger that lands between slots hits
 * chrome and `ScreenHolds` never takes it for a point hold.
 */
export class PhoneTrayRow {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly slots: PhoneSlot[] = [];
  private readonly chip: InstanceType<typeof UIKit.Container>;
  private readonly metresPerApx: number;
  private open = false;
  private chipRect: PhoneTrayRowProbe['chip'] = null;

  constructor(private readonly deps: PhoneTrayRowDeps) {
    const m = (2 * PHONE_DOCK_DEPTH_M * Math.tan(deps.verticalFovRad / 2)) / deps.viewportHeightCss;
    this.metresPerApx = m;
    const hitApx = HIT.touch;
    const root = new UIKit.Container({ pixelSize: m, flexDirection: 'row', alignItems: 'center', anchorX: 'center', anchorY: 'bottom' });
    this.chip = new UIKit.Container({
      flexDirection: 'row',
      alignItems: 'center',
      gap: GLYPH.gap,
      paddingTop: CHIP.controlRowPaddingStart,
      paddingBottom: CHIP.controlRowPaddingStart,
      paddingLeft: CHIP.controlRowPaddingStart,
      paddingRight: CHIP.controlRowPaddingStart,
      borderRadius: CHIP.radius,
      backgroundColor: withAlpha(COLOR.deepSea, CHIP_OPACITY.arAndroidChrome)
    });
    root.add(this.chip);
    const outer = hitApx / 2;
    for (let i = 0; i < SLOTS; i += 1) {
      const hit = new UIKit.Container({ width: hitApx, height: hitApx, alignItems: 'center', justifyContent: 'center' });
      const solid = this.ring(ringGeometry(outer, GLYPH.stroke), COLOR.gold, hitApx);
      const dashed = this.ring(dashedRingGeometry(outer, GLYPH.stroke), COLOR.textMuted, hitApx);
      const inner = hitApx - 2 * (GLYPH.stroke + 3);
      const image = new UIKit.Image({ width: inner, height: inner, borderRadius: inner / 2, objectFit: 'cover', display: 'none', pointerEvents: 'none' });
      hit.add(solid, dashed, image);
      this.chip.add(hit);
      const slot: PhoneSlot = { hit, solid, dashed, image, texture: null, canvas: null, filled: false, name: null, committedAt: 0 };
      this.bind(slot, i + 1);
      this.slots.push(slot);
    }
    this.document = new UIKitDocument(root);
    this.entity = deps.world.createTransformEntity(undefined, { parent: deps.world.activeLevel.value });
    const object = this.entity.object3D!;
    object.name = 'PhoneTrayRow';
    markChrome(object);
    object.add(this.document);
    this.entity.addComponent(RayInteractable);
    deps.camera.add(object);
    object.visible = false;
    this.layout();
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.entity.object3D!.visible = open;
    if (!open) this.chipRect = null;
  }

  isOpen(): boolean {
    return this.open;
  }

  /** The tray's slots, each frame the row shows. */
  update(tray: TrayUiState): void {
    if (!this.open) return;
    for (let i = 0; i < SLOTS; i += 1) {
      const slot = this.slots[i]!;
      const info = tray.slots.find((candidate) => candidate.slot === i + 1) ?? null;
      const filled = info !== null;
      if (filled !== slot.filled) {
        slot.filled = filled;
        slot.solid.setProperties({ display: filled ? 'flex' : 'none' });
        slot.dashed.setProperties({ display: filled ? 'none' : 'flex' });
      }
      slot.name = info?.name ?? null;
      const canvas = filled ? this.deps.thumbnail(i + 1)?.canvas ?? null : null;
      if (canvas !== slot.canvas) {
        slot.texture?.dispose();
        slot.texture = null;
        slot.canvas = canvas;
        if (canvas) {
          slot.texture = new THREE.CanvasTexture(canvas);
          slot.texture.colorSpace = THREE.SRGBColorSpace;
          slot.image.setProperties({ src: slot.texture, display: 'flex' });
        } else {
          slot.image.setProperties({ display: 'none' });
        }
      }
    }
    this.layout();
    markChromeTree(this.entity.object3D!);
  }

  /** The chip sits a glyph gap above the dock's chip (or the home-bar clearance when the dock is hidden). */
  private layout(): void {
    const { viewportHeightCss: height, viewportWidthCss: width } = this.deps;
    const hitApx = HIT.touch;
    const rowHeight = hitApx + 2 * CHIP.controlRowPaddingStart;
    const rowWidth = CHIP.controlRowPaddingStart * 2 + SLOTS * hitApx + (SLOTS - 1) * GLYPH.gap;
    const dockTop = this.deps.dockTopCss();
    // Distance from the screen's bottom edge to the row's bottom edge, in apx.
    const bottomApx = (dockTop === null ? 0 : height - dockTop) + GLYPH.gap;
    const halfHeight = PHONE_DOCK_DEPTH_M * Math.tan(this.deps.verticalFovRad / 2);
    this.entity.object3D!.position.set(0, -halfHeight + bottomApx * this.metresPerApx, -PHONE_DOCK_DEPTH_M);
    this.chipRect = { left: (width - rowWidth) / 2, top: height - bottomApx - rowHeight, width: rowWidth, height: rowHeight };
  }

  probe(): PhoneTrayRowProbe {
    return {
      built: true,
      open: this.open,
      slots: this.slots.map((slot, i) => ({ slot: i + 1, filled: slot.filled, name: slot.name, hitApx: HIT.touch, thumbnail: slot.texture !== null })),
      chip: this.open && this.chipRect ? { ...this.chipRect } : null
    };
  }

  /** The world position of a slot's hit area, for a check that taps it. */
  slotPosition(slot: number): number[] | null {
    const hit = this.slots[slot - 1]?.hit;
    return hit ? hit.getWorldPosition(new THREE.Vector3()).toArray() : null;
  }

  dispose(): void {
    for (const slot of this.slots) slot.texture?.dispose();
    this.entity.object3D!.removeFromParent();
    this.document.dispose();
    this.entity.destroy();
  }

  /** A ring drawn as a UIKit Content of `size` apx, its geometry centred on the layout box's centre. */
  private ring(geometry: THREE.BufferGeometry, color: string, size: number): InstanceType<typeof UIKit.Content> {
    const element = new UIKit.Content({ positionType: 'absolute', positionTop: 0, positionLeft: 0, width: size, height: size, keepAspectRatio: true, depthAlign: 'center', pointerEvents: 'none' });
    (element.boundingBox as { value: unknown }).value = { center: new THREE.Vector3(0, 0, 0), size: new THREE.Vector3(size, size, 0.00001) };
    const mesh = new THREE.Mesh(geometry, ringMaterial(color));
    mesh.renderOrder = 992;
    mesh.matrixAutoUpdate = true;
    (element as unknown as { addUnsafe(...objects: THREE.Mesh[]): void }).addUnsafe(mesh);
    return element;
  }

  private bind(slot: PhoneSlot, number: number): void {
    type PointerEvent = { pointerId: number; pointerType: string };
    const commit = (): void => {
      const now = performance.now();
      if (!this.open || !slot.filled || !this.entity.object3D!.visible || now - slot.committedAt < COMMIT_DEBOUNCE_MS) return;
      slot.committedAt = now;
      this.deps.onSlot(number);
    };
    slot.hit.addEventListener('pointerdown' as never, ((_event: PointerEvent) => commit()) as never);
    slot.hit.addEventListener('click' as never, ((_event: PointerEvent) => commit()) as never);
  }
}
