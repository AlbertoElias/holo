import * as THREE from 'three';

import type { AvatarRig } from '../avatar/AvatarRig';
import type { VrHandSide } from '../types/contracts';
import type { SceneObject, SceneObjectRegistry } from './SceneObjectRegistry';
import type { TrayItemKind } from './trayItem';

export const MAX_TRAY_ITEMS = 5;
/** A take must stay under the 25 MB upload; textures are re-encoded as PNG. */
export const MAX_TRAY_BYTES = 16 * 1024 * 1024;
// Each miniature fits this cube.
const MINIATURE_M = 0.08;
const SPACING_M = 0.1;
const ABOVE_PALM_M = 0.12;
// The arc bows toward the author by this much at its ends.
const ARC_DEPTH_M = 0.03;
// Desktop: the arc floats in front of the chest.
const DESKTOP_FORWARD_M = 0.38;
const DESKTOP_BELOW_EYES_M = 0.32;
/** The right palm within this of a miniature's bounds is "in the tray". */
export const TRAY_ZONE_M = 0.25;

export interface TrayItem {
  /** 1-based slot: the desktop key that summons it. */
  slot: number;
  kind: TrayItemKind;
  bytes: number;
  /** The full-size model, as an `authoring` object shown as a miniature while the tray is open. */
  object: SceneObject;
  miniatureScale: number;
}

export interface TraySnapshot {
  open: boolean;
  items: Array<{ slot: number; name: string; kind: TrayItemKind; position: [number, number, number]; visible: boolean }>;
  summons: Array<{ slot: number; objectId: string; timeSec: number }>;
}

/**
 * The prepared tray (PRD-045): up to five items, seen only by the author.
 * Items are `authoring` objects in the registry, so the recorder and the
 * exporter never see them; while the tray is open they show as miniatures in
 * an arc above the avatar's holding palm (desktop: in front of the chest),
 * facing the author. `ObjectSystem` lays them out each step after the arms
 * have their final pose. A summon adds a new full-size `event` object.
 */
export class ObjectTray {
  private readonly items: TrayItem[] = [];
  private open = false;
  private readonly summonLog: TraySnapshot['summons'] = [];
  private readonly palm = new THREE.Vector3();
  private readonly knuckle = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly toward = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly box = new THREE.Box3();
  private readonly size = new THREE.Vector3();

  constructor(
    private readonly registry: SceneObjectRegistry,
    private readonly avatar: AvatarRig,
    private readonly embodyOffset: number
  ) {}

  getItems(): readonly TrayItem[] {
    return this.items;
  }

  totalBytes(): number {
    return this.items.reduce((sum, item) => sum + item.bytes, 0);
  }

  add(model: THREE.Object3D, options: { name: string; source: SceneObject['source']; kind: TrayItemKind; bytes: number }): TrayItem {
    const object = this.registry.add(model, { name: options.name, source: options.source, origin: 'prepared', layer: 'authoring' });
    // Tray items are laid out here, never placed in the scene.
    object.placed = true;
    object.wrapper.visible = false;
    this.box.setFromObject(model).getSize(this.size);
    const largest = Math.max(this.size.x, this.size.y, this.size.z, 1e-3);
    const item: TrayItem = { slot: this.items.length + 1, kind: options.kind, bytes: options.bytes, object, miniatureScale: MINIATURE_M / largest };
    this.items.push(item);
    return item;
  }

  clear(): void {
    for (const item of this.items) this.registry.remove(item.object);
    this.items.length = 0;
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Opens or closes the tray and lays out the miniatures for this step. */
  update(open: boolean, step: { vrActive: boolean; bodyYaw: number; hand: VrHandSide }): void {
    this.open = open && this.items.length > 0;
    for (const item of this.items) item.object.wrapper.visible = this.open;
    if (!this.open) return;

    const anchor = step.vrActive ? this.palmAnchor(step.hand) : null;
    const yaw = this.facingYaw(anchor, step.bodyYaw);
    if (anchor) {
      this.center.copy(anchor).addScaledVector(this.up, ABOVE_PALM_M);
    } else {
      this.avatar.getEyeAnchorWorldPosition(this.center, this.embodyOffset);
      this.center.x += -Math.sin(step.bodyYaw) * DESKTOP_FORWARD_M;
      this.center.z += -Math.cos(step.bodyYaw) * DESKTOP_FORWARD_M;
      this.center.y -= DESKTOP_BELOW_EYES_M;
    }
    this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this.toward.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.quat.setFromAxisAngle(this.up, yaw);
    const count = this.items.length;
    this.items.forEach((item, i) => {
      const offset = (i - (count - 1) / 2) * SPACING_M;
      const bow = count > 1 ? ARC_DEPTH_M * (2 * Math.abs(offset) / ((count - 1) * SPACING_M)) ** 2 : 0;
      this.pos.copy(this.center).addScaledVector(this.right, offset).addScaledVector(this.toward, bow);
      const wrapper = item.object.wrapper;
      const parent = wrapper.parent;
      parent?.updateWorldMatrix(true, false);
      wrapper.position.copy(parent ? parent.worldToLocal(this.pos.clone()) : this.pos);
      wrapper.quaternion.copy(this.quat);
      wrapper.scale.setScalar(item.miniatureScale);
      wrapper.updateMatrixWorld(true);
    });
  }

  /** The open tray's miniature nearest `point`, within `reach` of its bounds. */
  nearestItem(point: THREE.Vector3, reach: number): TrayItem | null {
    if (!this.open) return null;
    let best: TrayItem | null = null;
    let bestDistance = reach;
    for (const item of this.items) {
      const distance = this.box.setFromObject(item.object.model).distanceToPoint(point);
      if (distance <= bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Whether `point` is in the open tray's zone (the reach that counts as operating it). */
  inZone(point: THREE.Vector3): boolean {
    return this.nearestItem(point, TRAY_ZONE_M) !== null;
  }

  /** The item's miniature world pose with its scale removed: where a summoned object appears. */
  miniaturePose(item: TrayItem, out: THREE.Matrix4): THREE.Matrix4 {
    const wrapper = item.object.wrapper;
    wrapper.updateWorldMatrix(true, false);
    wrapper.matrixWorld.decompose(this.pos, this.quat, this.size);
    return out.compose(this.pos, this.quat, this.size.set(1, 1, 1));
  }

  /** Summons `item`: a new full-size event object, sharing the item's geometry and materials. */
  summon(item: TrayItem, timeSec: number): SceneObject {
    const object = this.registry.summon(item.object);
    this.summonLog.push({ slot: item.slot, objectId: object.id, timeSec });
    return object;
  }

  /** Summoned objects leave with their take: the next take starts without them. */
  clearSummoned(): void {
    this.registry.clearSummoned();
    this.summonLog.length = 0;
  }

  snapshot(): TraySnapshot {
    return {
      open: this.open,
      items: this.items.map((item) => {
        item.object.wrapper.updateWorldMatrix(true, false);
        this.pos.setFromMatrixPosition(item.object.wrapper.matrixWorld);
        return { slot: item.slot, name: item.object.name, kind: item.kind, position: [this.pos.x, this.pos.y, this.pos.z], visible: item.object.wrapper.visible };
      }),
      summons: [...this.summonLog]
    };
  }

  /** Between the holding hand's wrist and middle knuckle, on the avatar. */
  private palmAnchor(side: VrHandSide): THREE.Vector3 | null {
    const wrist = this.avatar.getBoneWorldPosition(`${side}Hand`, this.palm);
    if (!wrist) return null;
    const knuckle = this.avatar.getBoneWorldPosition(`${side}MiddleProximal`, this.knuckle);
    return knuckle ? this.palm.lerp(knuckle, 0.5) : this.palm;
  }

  /** The yaw that turns the arc's front toward the author's eyes. */
  private facingYaw(anchor: THREE.Vector3 | null, bodyYaw: number): number {
    if (!anchor) return bodyYaw;
    this.avatar.getEyeAnchorWorldPosition(this.pos, this.embodyOffset);
    const dx = this.pos.x - anchor.x;
    const dz = this.pos.z - anchor.z;
    return Math.hypot(dx, dz) < 1e-3 ? bodyYaw : Math.atan2(dx, dz);
  }
}
