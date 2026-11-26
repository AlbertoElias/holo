import { tokens } from '@holoim/design-tokens';
import { CHIP, COLOR, FONT_FAMILIES, FONT_FAMILY, GLYPH, HEADSET_SCALE, HIT, LABEL_MIN_DISTANCE_M, TYPE, metresPerApx, withAlpha } from '@holoim/xr-ui-iwsdk';
import { RayInteractable, UIKit, UIKitDocument, type Entity, type World } from '@iwsdk/core';
import * as THREE from 'three';

import type { HouseLook } from '../avatar/houseLook';
import type { HouseLookUi, LookPhotoUi } from '../types/contracts';
import { LOOK_CHOICES, LOOK_ROW_TITLES, lookPicture, lookValue, withLookValue, type LookRow } from './lookPictures';

// The headset look panel (docs/features/your-look.md, slice 2): the phone
// sheet's pictures on a world panel (styleguide 1.2, 9.1) beside the mirror,
// 1.5 m from the head. Three tabs hold the rows (Body, Face, Hair), so the
// widest row of eight pictures fits and nothing scrolls. Each picture is the
// house avatar with only that row changed; the chosen one holds the gold
// ring and the gold dot, and its word is full text colour (the others
// muted), so the state is never colour or picture alone. At 1.5 m its
// controls take rays only, each at least a ray's 56 apx (6.1); type and
// pictures are at 2.5× (7.3).

const DISTANCE_M = tokens.placement.worldPanelDefaultM;
const S = HEADSET_SCALE;
const LABEL_APX = TYPE.controlLabel.size * S;
const WORD_APX = tokens.type.captionUnderCard.fontSize * S;
const GAP_APX = GLYPH.gap * S;
/** A picture's side: 64 apx at 2.5×, about 9 cm at 1.5 m (the phone's is 72 px). */
const PICTURE_APX = 64 * S;
const RING_APX = 2 * S;
const DOT_APX = 16 * S * 0.6;
const WIDEST_ROW = Math.max(...Object.values(LOOK_CHOICES).map((choices) => choices.length));
const PANEL_INNER_APX = WIDEST_ROW * PICTURE_APX + (WIDEST_ROW - 1) * GAP_APX;

export const LOOK_TABS = { body: ['finish', 'build', 'clothing'], face: ['skin', 'eyes', 'glasses'], hair: ['hair', 'hairColour'] } as const satisfies Record<string, readonly LookRow[]>;
export type LookTab = keyof typeof LOOK_TABS;
const TAB_WORDS: Record<LookTab, string> = { body: 'Body', face: 'Face', hair: 'Hair' };

export type LookTargetId = 'close' | 'photo' | 'previous' | `tab:${LookTab}` | `pick:${LookRow}:${string}`;

export interface VrLookPanelOptions {
  onChange(next: HouseLook): void;
  onClose(): void;
  /** "From a photo" (docs/features/directed-performance.md, slice 5b): the device's picker opens. */
  onPhoto(): void;
  /** "Previous look": the look from before the last photo. */
  onPrevious(): void;
  canCommit(pointerId: number): boolean;
  onCommit(pointerId: number): void;
  onHover(pointerId: number, hovered: boolean): void;
  /** The chip's opacity: VR 72%, Quest passthrough 97% (2.3, 9.2). */
  chipOpacity: number;
}

export interface VrLookPanelProbe {
  visible: boolean;
  worldPosition: number[];
  /** The panel's laid-out width and height in metres, for the overlap check. */
  sizeM: [number, number];
  tab: LookTab;
  status: string;
  /** The photo's muted line: the traits kept and why; '' when none. */
  kept: string;
  /** Each shown row's chosen value. */
  chosen: Partial<Record<LookRow, string>>;
  targets: Array<{ id: LookTargetId; text: string; visible: boolean; hitHeightM: number; hitWidthM: number }>;
}

interface Target {
  id: LookTargetId;
  hit: InstanceType<typeof UIKit.Container>;
  labels: Array<InstanceType<typeof UIKit.Text>>;
  shown: boolean;
  readable: boolean;
  hovering: Set<number>;
  pressing: Set<number>;
}

interface Picture {
  row: LookRow;
  value: string;
  frame: InstanceType<typeof UIKit.Container>;
  dot: InstanceType<typeof UIKit.Container>;
  word: InstanceType<typeof UIKit.Text>;
}

const headPosition = new THREE.Vector3();
const headQuaternion = new THREE.Quaternion();
const headScale = new THREE.Vector3();
const level = new THREE.Euler();
const scratch = new THREE.Vector3();

export class VrLookPanel {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly root: InstanceType<typeof UIKit.Container>;
  private readonly pixelSize = metresPerApx(DISTANCE_M);
  private readonly targets = new Map<LookTargetId, Target>();
  private readonly pictures: Picture[] = [];
  private readonly rows = new Map<LookRow, InstanceType<typeof UIKit.Container>>();
  private readonly tabRules = new Map<LookTab, InstanceType<typeof UIKit.Container>>();
  private readonly statusText: InstanceType<typeof UIKit.Text>;
  private readonly keptText: InstanceType<typeof UIKit.Text>;
  private tab: LookTab = 'body';
  private look: HouseLookUi | null = null;
  private status = '';
  private kept = '';

  constructor(world: World, private readonly options: VrLookPanelOptions) {
    const root = (this.root = new UIKit.Container({
      pixelSize: this.pixelSize,
      fontFamilies: FONT_FAMILIES,
      fontFamily: FONT_FAMILY,
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: GAP_APX,
      paddingTop: CHIP.paddingBlock * S,
      paddingBottom: CHIP.paddingBlock * S,
      paddingLeft: CHIP.paddingInline * S,
      paddingRight: CHIP.paddingInline * S,
      borderRadius: CHIP.radius * S,
      width: PANEL_INNER_APX + 2 * CHIP.paddingInline * S,
      // A panel is a container for text: it is on the chip from the start (5.2).
      backgroundColor: withAlpha(COLOR.deepSea, options.chipOpacity)
    }));

    // The tabs, each with its gold rule when chosen, then the photo's actions and Close at the far end.
    const head = row();
    for (const tab of Object.keys(LOOK_TABS) as LookTab[]) {
      const hit = this.labelled(`tab:${tab}`, TAB_WORDS[tab], () => {
        this.tab = tab;
      });
      const rule = new UIKit.Container({ positionType: 'absolute', positionBottom: 0, positionLeft: GAP_APX / 2, positionRight: GAP_APX / 2, height: Math.max(1, S), backgroundColor: COLOR.gold, pointerEvents: 'none' });
      hit.add(rule);
      this.tabRules.set(tab, rule);
      head.add(hit);
    }
    head.add(new UIKit.Container({ flexGrow: 1, pointerEvents: 'none' }));
    head.add(this.labelled('photo', 'From a photo', () => this.options.onPhoto()));
    head.add(this.labelled('previous', 'Previous look', () => this.options.onPrevious()));
    head.add(this.labelled('close', 'Close', () => this.options.onClose()));
    root.add(head);

    this.statusText = text('', WORD_APX * 1.12, 400, COLOR.textMuted);
    root.add(this.statusText);
    this.keptText = text('', WORD_APX, 400, COLOR.textMuted);
    this.keptText.setProperties({ display: 'none' });
    root.add(this.keptText);

    for (const rowId of Object.values(LOOK_TABS).flat() as LookRow[]) {
      const section = new UIKit.Container({ flexDirection: 'column', alignItems: 'flex-start', gap: GAP_APX / 2 });
      section.add(text(LOOK_ROW_TITLES[rowId], LABEL_APX, TYPE.controlLabel.weight, COLOR.textMuted));
      const strip = row();
      strip.setProperties({ alignItems: 'flex-start' });
      for (const choice of LOOK_CHOICES[rowId]) strip.add(this.picture(rowId, choice.value, choice.label));
      section.add(strip);
      this.rows.set(rowId, section);
      root.add(section);
    }

    this.document = new UIKitDocument(root);
    this.entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    this.entity.object3D!.name = 'LookPanel';
    this.entity.object3D!.add(this.document);
    this.entity.addComponent(RayInteractable);
    this.setVisible(false);
  }

  // --- Building ---

  private target(id: LookTargetId, style: Record<string, unknown>, onSelect: () => void): InstanceType<typeof UIKit.Container> {
    const hit = new UIKit.Container({ minHeight: HIT.ray, minWidth: HIT.ray, alignItems: 'center', justifyContent: 'center', ...style });
    const entry: Target = { id, hit, labels: [], shown: true, readable: true, hovering: new Set(), pressing: new Set() };
    type PanelPointerEvent = { pointerId: number };
    hit.addEventListener('pointerdown' as never, ((event: PanelPointerEvent) => {
      if (this.takesHits(entry)) entry.pressing.add(event.pointerId);
    }) as never);
    for (const end of ['pointerup', 'pointercancel']) hit.addEventListener(end as never, ((event: PanelPointerEvent) => entry.pressing.delete(event.pointerId)) as never);
    hit.addEventListener('pointerenter' as never, ((event: PanelPointerEvent) => {
      entry.hovering.add(event.pointerId);
      this.options.onHover(event.pointerId, true);
    }) as never);
    hit.addEventListener('pointerleave' as never, ((event: PanelPointerEvent) => {
      entry.pressing.delete(event.pointerId);
      if (entry.hovering.delete(event.pointerId)) this.options.onHover(event.pointerId, false);
    }) as never);
    hit.addEventListener('click' as never, ((event: PanelPointerEvent) => {
      if (!this.takesHits(entry) || !this.options.canCommit(event.pointerId)) return;
      onSelect();
      this.options.onCommit(event.pointerId);
    }) as never);
    this.targets.set(id, entry);
    return hit;
  }

  private labelled(id: LookTargetId, word: string, onSelect: () => void): InstanceType<typeof UIKit.Container> {
    const hit = this.target(id, { paddingLeft: GAP_APX / 2, paddingRight: GAP_APX / 2 }, onSelect);
    const label = text(word, LABEL_APX, TYPE.controlLabel.weight, COLOR.gold);
    hit.add(label);
    this.targets.get(id)!.labels.push(label);
    return hit;
  }

  /** One choice: the picture in its ring, the dot when chosen, the word under it. */
  private picture(rowId: LookRow, value: string, label: string): InstanceType<typeof UIKit.Container> {
    const id: LookTargetId = `pick:${rowId}:${value}`;
    const hit = this.target(id, { width: PICTURE_APX, flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', gap: GAP_APX / 3 }, () => {
      if (this.look) this.options.onChange(withLookValue(this.look, rowId, value));
    });
    const frame = new UIKit.Container({ width: PICTURE_APX, height: PICTURE_APX, borderRadius: (CHIP.radius / 2) * S, borderWidth: RING_APX, borderColor: COLOR.textMuted, pointerEvents: 'none' });
    const image = new UIKit.Image({ src: `${import.meta.env.BASE_URL}${lookPicture(rowId, value)}`, width: '100%', height: '100%', objectFit: 'cover', borderRadius: (CHIP.radius / 2) * S, pointerEvents: 'none' });
    // The gold dot on a small deep-sea lens, top right (as the phone's).
    const dot = new UIKit.Container({ positionType: 'absolute', positionTop: 5 * S * 0.8, positionRight: 5 * S * 0.8, width: DOT_APX * 2, height: DOT_APX * 2, borderRadius: DOT_APX, backgroundColor: COLOR.deepSea, alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', display: 'none' });
    dot.add(new UIKit.Container({ width: DOT_APX, height: DOT_APX, borderRadius: DOT_APX / 2, backgroundColor: COLOR.gold, pointerEvents: 'none' }));
    frame.add(image, dot);
    const word = text(label, WORD_APX, 400, COLOR.textMuted);
    word.setProperties({ width: PICTURE_APX, textAlign: 'center', wordBreak: 'break-word' });
    hit.add(frame, word);
    this.targets.get(id)!.labels.push(word);
    this.pictures.push({ row: rowId, value, frame, dot, word });
    return hit;
  }

  // --- Placement and state ---

  /** Opens 1.5 m from the head at `yawOffset` radians left of straight ahead (negative: right), level, facing the head (1.2). */
  place(headObject: THREE.Object3D, yawOffset = 0): void {
    headObject.updateWorldMatrix(true, false);
    headObject.matrixWorld.decompose(headPosition, headQuaternion, headScale);
    level.setFromQuaternion(headQuaternion, 'YXZ');
    const yaw = level.y + yawOffset;
    const at = scratch.copy(headPosition).add(new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(DISTANCE_M));
    const object = this.entity.object3D!;
    object.parent?.updateWorldMatrix(true, false);
    object.position.copy(object.parent ? object.parent.worldToLocal(at.clone()) : at);
    object.lookAt(headPosition);
  }

  setChipOpacity(opacity: number): void {
    this.root.setProperties({ backgroundColor: withAlpha(COLOR.deepSea, opacity) });
  }

  setVisible(visible: boolean): void {
    this.entity.object3D!.visible = visible;
    if (!visible) {
      for (const target of this.targets.values()) {
        target.hovering.clear();
        target.pressing.clear();
      }
    }
  }

  /** Paints the look: the chosen tab and pictures, the status lines; hides any text within 1 m of the head (7.3). */
  update(headObject: THREE.Object3D, look: HouseLookUi | null, photo: LookPhotoUi): void {
    this.look = look;
    headObject.getWorldPosition(headPosition);
    this.status = !look
      ? ''
      : look.status === 'dressing'
        ? 'Changing the look'
        : look.status === 'error'
          ? (look.message ?? 'That look did not load.')
          : photo.status !== 'idle' && photo.message
            ? photo.message
            : 'Your look shows in the mirror.';
    say(this.statusText, this.status);
    this.statusText.setProperties({ opacity: this.readableAt(this.statusText) ? 1 : 0 });
    this.kept = look && look.status !== 'error' && photo.status === 'read' ? (photo.kept ?? '') : '';
    say(this.keptText, this.kept);
    this.keptText.setProperties({ display: this.kept ? 'flex' : 'none', opacity: this.readableAt(this.keptText) ? 1 : 0 });
    // While a photo loads or reads, "From a photo" takes no hits (as on the phone): a second pick must not close the reader in use.
    const photoBusy = photo.status === 'loading' || photo.status === 'reading';
    this.targets.get('photo')!.shown = !photoBusy;
    const previous = this.targets.get('previous')!;
    previous.shown = photo.previous;
    previous.hit.setProperties({ display: photo.previous ? 'flex' : 'none' });

    const shownRows = new Set<LookRow>(LOOK_TABS[this.tab]);
    for (const [rowId, section] of this.rows) section.setProperties({ display: shownRows.has(rowId) ? 'flex' : 'none' });
    for (const [tab, rule] of this.tabRules) rule.setProperties({ display: tab === this.tab ? 'flex' : 'none' });
    for (const picture of this.pictures) {
      const chosen = look !== null && lookValue(look, picture.row) === picture.value;
      picture.frame.setProperties({ borderColor: chosen ? COLOR.gold : withAlpha(COLOR.textMuted, 0.33) });
      picture.dot.setProperties({ display: chosen ? 'flex' : 'none' });
      this.targets.get(`pick:${picture.row}:${picture.value}`)!.shown = shownRows.has(picture.row);
    }

    for (const target of this.targets.values()) {
      const readable = this.readableAt(target.hit);
      target.readable = readable;
      const hovered = target.hovering.size > 0 && this.takesHits(target);
      const pressed = target.pressing.size > 0 && this.takesHits(target);
      const pick = target.id.startsWith('pick:') ? this.pictures.find((p) => target.id === `pick:${p.row}:${p.value}`) : null;
      const chosen = pick && look ? lookValue(look, pick.row) === pick.value : target.id === `tab:${this.tab}`;
      for (const label of target.labels) {
        // A picture's word is full text colour when chosen, muted otherwise; a control's word is gold.
        const rest = pick ? (chosen ? COLOR.text : COLOR.textMuted) : (target.id.startsWith('tab:') && !chosen) || (target.id === 'photo' && photoBusy) ? COLOR.textMuted : COLOR.gold;
        label.setProperties({ color: hovered || pressed ? COLOR.highlight : rest, opacity: !readable ? 0 : pressed ? GLYPH.pressedOpacity : 1 });
      }
      target.hit.setProperties({ pointerEvents: readable && target.shown ? 'auto' : 'none' });
    }
  }

  private takesHits(target: Target): boolean {
    return target.shown && target.readable && this.isShown();
  }

  private readableAt(object: THREE.Object3D): boolean {
    return object.getWorldPosition(scratch).distanceTo(headPosition) >= LABEL_MIN_DISTANCE_M;
  }

  isShown(): boolean {
    for (let node: THREE.Object3D | null = this.entity.object3D!; node; node = node.parent) if (!node.visible) return false;
    return true;
  }

  hitTarget(id: LookTargetId): THREE.Object3D | null {
    return this.targets.get(id)?.hit ?? null;
  }

  hoveredBy(pointerId: number): LookTargetId | null {
    for (const target of this.targets.values()) if (target.hovering.has(pointerId) && this.takesHits(target)) return target.id;
    return null;
  }

  /** Every text showing now: the controls' and pictures' words, and the status line. */
  readableLabels(): Array<{ id: string; text: string; object: THREE.Object3D }> {
    if (!this.isShown()) return [];
    const labels: Array<{ id: string; text: string; object: THREE.Object3D }> = [...this.targets.values()]
      .filter((target) => target.shown && target.readable)
      .map((target) => ({ id: target.id, text: labelText(target), object: target.hit }));
    if (this.readableAt(this.statusText)) labels.push({ id: 'status', text: this.status, object: this.statusText });
    if (this.kept && this.readableAt(this.keptText)) labels.push({ id: 'kept', text: this.kept, object: this.keptText });
    return labels.filter((label) => label.text.trim() !== '');
  }

  probe(): VrLookPanelProbe {
    const size = this.root.size.value ?? [0, 0];
    const chosen: VrLookPanelProbe['chosen'] = {};
    if (this.look) for (const rowId of LOOK_TABS[this.tab]) chosen[rowId] = lookValue(this.look, rowId);
    return {
      visible: this.isShown(),
      worldPosition: this.entity.object3D!.getWorldPosition(new THREE.Vector3()).toArray(),
      sizeM: [size[0] * this.pixelSize, size[1] * this.pixelSize],
      tab: this.tab,
      status: this.status,
      kept: this.kept,
      chosen,
      targets: [...this.targets.values()].map((target) => {
        const hit = target.hit.size.value ?? [0, 0];
        return { id: target.id, text: labelText(target), visible: this.isShown() && target.shown && target.readable, hitWidthM: hit[0] * this.pixelSize, hitHeightM: hit[1] * this.pixelSize };
      })
    };
  }

  dispose(): void {
    this.entity.object3D!.removeFromParent();
    this.document.dispose();
    this.entity.destroy();
  }
}

function row(gap = GAP_APX): InstanceType<typeof UIKit.Container> {
  return new UIKit.Container({ flexDirection: 'row', alignItems: 'center', gap });
}

/** Each label's current words, for the probe and the 1 m rule's label list. */
const words = new WeakMap<InstanceType<typeof UIKit.Text>, string>();

function text(value: string, fontSize: number, fontWeight: number, color: string): InstanceType<typeof UIKit.Text> {
  const label = new UIKit.Text({ text: value, fontSize, fontWeight, color, pointerEvents: 'none' });
  words.set(label, value);
  return label;
}

function say(label: InstanceType<typeof UIKit.Text>, value: string): void {
  if (words.get(label) === value) return;
  words.set(label, value);
  label.setProperties({ text: value });
}

function labelText(target: Target): string {
  return target.labels.map((label) => words.get(label) ?? '').join(' ');
}
