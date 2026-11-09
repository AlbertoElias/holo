import * as THREE from 'three';
import { UIKit, UIKitDocument, PokeInteractable, RayInteractable, type Entity, type World } from '@iwsdk/core';
import { apxToMeters, hitAreaMeters, tokens } from '@holoim/design-tokens';
import { dominantHand, markChrome, markChromeTree, type Handedness } from '@holoim/xr-ui-core';
import { COLOR, CHIP, CHIP_OPACITY, GLYPH, HIT, PHONE_DOCK_DEPTH_M, createGlyph, withAlpha, type GlyphElement } from '@holoim/xr-ui-iwsdk';
import type { ObjectTray } from '../objects/ObjectTray';
import type { TrayThumbnail } from '../objects/trayThumbnail';
import type { TrayUiState } from '../types/contracts';
import type { XrTracking } from '../xr/XrTracking';
import { dashedRingGeometry, ringGeometry, ringMaterial } from './trayRings';

// How each tray slot says it can be summoned on a headset and on a phone's AR
// screen (docs/features/archive/tray-everywhere.md, "The tray UI"). Both are chrome:
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
/** A miniature's Close ring stands this far above its top (docs/features/tray-remove.md). */
const CLOSE_ABOVE_M = 0.035;

export type SummonGlyph = 'pinch' | 'squeeze';

export interface TraySignifierSlotProbe {
  slot: number;
  filled: boolean;
  reachable: boolean;
  /** The glyph beside the ring: pinch for tracked hands, squeeze for controllers; only on the reachable slot. */
  glyph: SummonGlyph | null;
  /** The ring's opacity: 1, or 0.4 while blocked; 0 when no ring shows at this slot. */
  opacity: number;
  /** The Close ring above the miniature shows (docs/features/tray-remove.md): the arc is open and the summoning hand is empty. */
  close: boolean;
  /** A held prop let go now would go back into this slot: it carries the Put back glyph. */
  returning: boolean;
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
  /** A Close ring was poked (hands) or selected by a controller's ray: the slot's item leaves the tray. */
  onRemove: (slot: number) => void;
}

interface CloseRing {
  entity: Entity;
  document: UIKitDocument;
  glyph: GlyphElement;
  /** The tray slot it stands over now, or null while hidden. */
  slot: number | null;
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
  private readonly closeRings: CloseRing[] = [];
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
        const returning = tray.returnSlot === item.slot;
        this.place(this.rings[i]!, at, parent, false, reachable || returning ? COLOR.highlight : COLOR.gold, opacity);
        // Close: only while the summoning hand is empty, so a hand carrying a prop back into the arc never pokes one.
        const close = !tray.holding;
        this.placeClose(i, close ? item.slot : null, camera, new THREE.Vector3(centre.x, box.max.y + CLOSE_ABOVE_M, centre.z));
        slots[i] = { slot: item.slot, filled: true, reachable, glyph: reachable ? (input === 'hands' ? 'pinch' : 'squeeze') : null, opacity, close, returning };
        if (reachable || returning) reachableAt = at;
      });
      for (let i = Math.min(items.length, SLOTS); i < SLOTS; i += 1) this.placeClose(i, null, camera, null);
      // One dashed ring where the next item will stand, continuing the arc's spacing along its right-hand axis.
      const lastItem = items[Math.min(items.length, SLOTS) - 1];
      if (lastItem && last && items.length < SLOTS) {
        lastItem.object.wrapper.getWorldQuaternion(quat);
        right.set(1, 0, 0).applyQuaternion(quat);
        const next = (last as THREE.Vector3).clone().addScaledVector(right, spacing);
        const index = items.length;
        this.place(this.rings[index]!, next, parent, true, COLOR.textMuted, opacity);
        slots[index] = { slot: index + 1, filled: false, reachable: false, glyph: null, opacity, close: false, returning: false };
      }
    }
    if (!visible) for (let i = 0; i < SLOTS; i += 1) this.placeClose(i, null, camera, null);
    this.updateGlyph(camera, reachableAt, tray.returnSlot !== null ? 'putBack' : input === 'hands' ? 'pinch' : 'squeeze', tray.blocked && tray.returnSlot === null);
    this.lastProbe = { visible, input, slots };
    markChromeTree(this.root);
    if (this.glyphEntity) markChromeTree(this.glyphEntity.object3D!);
    for (const ring of this.closeRings) markChromeTree(ring.entity.object3D!);
  }

  probe(): XrTraySignifiersProbe {
    return { ...this.lastProbe, slots: this.lastProbe.slots.map((slot) => ({ ...slot })) };
  }

  /** The world position of slot `slot`'s Close ring while it shows, for a check that pokes or aims at it. */
  closePosition(slot: number): number[] | null {
    const ring = this.closeRings.find((candidate) => candidate.slot === slot);
    return ring && ring.entity.object3D!.visible ? ring.entity.object3D!.getWorldPosition(new THREE.Vector3()).toArray() : null;
  }

  hide(): void {
    for (const ring of this.rings) ring.group.visible = false;
    for (let i = 0; i < this.closeRings.length; i += 1) this.placeClose(i, null, null, null);
    if (this.glyphEntity) this.glyphEntity.object3D!.visible = false;
    this.lastProbe = { visible: false, input: this.lastProbe.input, slots: emptySlots() };
  }

  dispose(): void {
    for (const ring of this.rings) for (const mesh of [ring.solid, ring.dashed]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    for (const ring of this.closeRings) {
      ring.glyph.dispose();
      ring.document.dispose();
      ring.entity.object3D?.removeFromParent();
      ring.entity.destroy();
    }
    this.closeRings.length = 0;
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

  /**
   * Slot index `i`'s Close ring: shown over `slot`'s miniature at `at` (world),
   * turned to the eyes, or hidden when `slot` is null. Built on first use.
   */
  private placeClose(i: number, slot: number | null, camera: THREE.Camera | null, at: THREE.Vector3 | null): void {
    if (slot === null || !camera || !at) {
      const ring = this.closeRings[i];
      if (ring?.entity.object3D!.visible) {
        ring.slot = null;
        ring.entity.object3D!.visible = false;
        ring.glyph.setColor(COLOR.gold);
      }
      return;
    }
    const ring = this.closeRings[i] ?? this.buildClose(i);
    ring.slot = slot;
    const object = ring.entity.object3D!;
    object.parent?.updateWorldMatrix(true, false);
    object.position.copy(object.parent ? object.parent.worldToLocal(at.clone()) : at);
    camera.getWorldPosition(eye);
    object.lookAt(eye);
    object.visible = true;
  }

  private buildClose(i: number): CloseRing {
    const m = apxToMeters(1, ARM_REACH_M, { headset: true });
    // A poke's hit (§6.1): 72 apx, never under 20 mm, at arm's reach.
    const hitApx = hitAreaMeters('poke', GLYPH.ring * tokens.size.headsetScale, ARM_REACH_M, { headset: false }) / m;
    const glyph = createGlyph('close', { size: GLYPH.ring, color: COLOR.gold, ring: { innerSize: GLYPH.icon } });
    glyph.element.setProperties({ pointerEvents: 'none' });
    const hit = new UIKit.Container({ width: hitApx, height: hitApx, alignItems: 'center', justifyContent: 'center' });
    hit.add(glyph.element);
    const root = new UIKit.Container({ pixelSize: m, flexDirection: 'row', alignItems: 'center', anchorX: 'center', anchorY: 'center' });
    root.add(hit);
    const document = new UIKitDocument(root);
    const entity = this.deps.world.createTransformEntity(undefined, { parent: this.deps.world.activeLevel.value });
    const object = entity.object3D!;
    object.name = `tray-close-${i + 1}`;
    markChrome(object);
    object.add(document);
    entity.addComponent(RayInteractable);
    entity.addComponent(PokeInteractable);
    object.visible = false;
    const ring: CloseRing = { entity, document, glyph, slot: null };
    type ClosePointerEvent = { pointerType: string };
    let committedAt = 0;
    const commit = (event: ClosePointerEvent): void => {
      // A fingertip poke (hands), or a controller's ray and trigger. A tracked hand's ray selects with the
      // same pinch that summons a miniature beneath it, so it never removes.
      const hands = this.deps.tracking.getHandPoseSource(dominantHand(this.deps.getHandedness())) === 'xr-hand';
      if (event.pointerType !== 'touch' && hands) return;
      const now = performance.now();
      if (ring.slot === null || !object.visible || now - committedAt < COMMIT_DEBOUNCE_MS) return;
      committedAt = now;
      this.deps.onRemove(ring.slot);
    };
    // Hover or a fingertip near it: the highlight (§6), so the ring about to remove an item shows it first.
    hit.addEventListener('pointerenter' as never, (() => glyph.setColor(COLOR.highlight)) as never);
    hit.addEventListener('pointerleave' as never, (() => glyph.setColor(COLOR.gold)) as never);
    hit.addEventListener('pointerdown' as never, ((event: ClosePointerEvent) => { if (event.pointerType === 'touch') commit(event); }) as never);
    hit.addEventListener('click' as never, ((event: ClosePointerEvent) => { if (event.pointerType !== 'touch') commit(event); }) as never);
    this.closeRings[i] = ring;
    return ring;
  }

  /** The pinch, squeeze or Put back glyph in its own gold ring, beside a slot's ring, turned to the eyes. */
  private updateGlyph(camera: THREE.Camera, at: THREE.Vector3 | null, drawing: 'pinch' | 'squeeze' | 'putBack', blocked: boolean): void {
    if (!at) {
      if (this.glyphEntity) this.glyphEntity.object3D!.visible = false;
      return;
    }
    if (!this.glyphEntity) this.buildGlyph(drawing);
    const entity = this.glyphEntity!;
    const object = entity.object3D!;
    this.glyph!.setDrawing(drawing);
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

  private buildGlyph(drawing: 'pinch' | 'squeeze' | 'putBack'): void {
    const m = apxToMeters(1, ARM_REACH_M, { headset: true });
    this.glyph = createGlyph(drawing, { size: GLYPH.ring, color: COLOR.highlight, ring: { innerSize: GLYPH.icon } });
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
  return Array.from({ length: SLOTS }, (_, i) => ({ slot: i + 1, filled: false, reachable: false, glyph: null, opacity: 0, close: false, returning: false }));
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
  /** A slot's Close glyph, tapped and lifted on it: the item leaves the tray (docs/features/tray-remove.md). */
  onRemove: (slot: number) => void;
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
  /** The Close glyph's hit above the slot, shown while the slot is filled. */
  close: InstanceType<typeof UIKit.Container>;
  closeGlyph: GlyphElement;
}

/** Between a phone slot and its Close glyph above it. */
const CLOSE_GAP_APX = 12;
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
      // Each slot is a column: its Close glyph over it, then the slot.
      const column = new UIKit.Container({ flexDirection: 'column', alignItems: 'center', gap: CLOSE_GAP_APX });
      // Hidden, it takes no pointer either: a hold on the scene behind it is a point hold, not chrome.
      const close = new UIKit.Container({ width: hitApx, height: hitApx, alignItems: 'center', justifyContent: 'center', visibility: 'hidden', pointerEvents: 'none' });
      const closeGlyph = createGlyph('close', { size: GLYPH.icon, color: COLOR.gold });
      closeGlyph.element.setProperties({ pointerEvents: 'none' });
      close.add(closeGlyph.element);
      const hit = new UIKit.Container({ width: hitApx, height: hitApx, alignItems: 'center', justifyContent: 'center' });
      const solid = this.ring(ringGeometry(outer, GLYPH.stroke), COLOR.gold, hitApx);
      const dashed = this.ring(dashedRingGeometry(outer, GLYPH.stroke), COLOR.textMuted, hitApx);
      const inner = hitApx - 2 * (GLYPH.stroke + 3);
      const image = new UIKit.Image({ width: inner, height: inner, borderRadius: inner / 2, objectFit: 'cover', display: 'none', pointerEvents: 'none' });
      hit.add(solid, dashed, image);
      column.add(close, hit);
      this.chip.add(column);
      const slot: PhoneSlot = { hit, solid, dashed, image, texture: null, canvas: null, filled: false, name: null, committedAt: 0, close, closeGlyph };
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
    this.chip.setProperties({ display: 'none' });
    this.layout();
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.entity.object3D!.visible = open;
    // Closed, the row is out of the layout too: a hidden UIKit panel still takes the screen's ray, and one finger on
    // the scene behind it would begin on chrome and never mark.
    this.chip.setProperties({ display: open ? 'flex' : 'none' });
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
        slot.close.setProperties({ visibility: filled ? 'visible' : 'hidden', pointerEvents: filled ? 'auto' : 'none' });
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
    const rowHeight = 2 * hitApx + CLOSE_GAP_APX + 2 * CHIP.controlRowPaddingStart;
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

  /** The world position of a filled slot's Close glyph, for a check that taps it. */
  closePosition(slot: number): number[] | null {
    const entry = this.slots[slot - 1];
    return entry?.filled ? entry.close.getWorldPosition(new THREE.Vector3()).toArray() : null;
  }

  /** The world position of a slot's hit area, for a check that taps it. */
  slotPosition(slot: number): number[] | null {
    const hit = this.slots[slot - 1]?.hit;
    return hit ? hit.getWorldPosition(new THREE.Vector3()).toArray() : null;
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.texture?.dispose();
      slot.closeGlyph.dispose();
    }
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
    // Close removes, so it commits only on a click: a press lifted on the glyph itself, never on the press.
    slot.close.addEventListener('click' as never, ((_event: PointerEvent) => {
      const now = performance.now();
      if (!this.open || !slot.filled || !this.entity.object3D!.visible || now - slot.committedAt < COMMIT_DEBOUNCE_MS) return;
      slot.committedAt = now;
      this.deps.onRemove(number);
    }) as never);
  }
}
