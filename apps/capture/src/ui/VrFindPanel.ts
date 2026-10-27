import { tokens } from '@holoim/design-tokens';
import { licenceLabel } from '@holoim/objects';
import { CHIP, COLOR, FONT_FAMILIES, FONT_FAMILY, GLYPH, HEADSET_SCALE, HIT, LABEL_MIN_DISTANCE_M, TYPE, metresPerApx, withAlpha } from '@holoim/xr-ui-iwsdk';
import { RayInteractable, UIKit, UIKitDocument, type Entity, type World } from '@iwsdk/core';
import * as THREE from 'three';

import { objectGlbUrl } from '../objects/objectSearch';
import { OBJECT_CATEGORIES, type ObjectSearchSession, type ObjectSearchState } from '../objects/objectSearchSession';

// The headset Find panel (PRD-060 slice 2): a world panel (styleguide 1.2,
// 9.1) opened 1.5 m ahead from the hand dock's Find glyph. Category
// shortcuts search at once; the query line takes the system keyboard where
// the session offers it and an in-world keyboard otherwise; Speak is held
// while talking; up to six tiles show a thumbnail, title, author and licence,
// and a pick goes to the tray through the desktop's path. At 1.5 m its
// controls take rays only (a poke cannot reach), hand rays included, each
// at least a ray's 56 apx (6.1); type is at 2.5× (7.3).

const DISTANCE_M = tokens.placement.worldPanelDefaultM;
const S = HEADSET_SCALE;
const LABEL_APX = TYPE.controlLabel.size * S;
const BYLINE_APX = tokens.type.byline.fontSize * S;
const GAP_APX = GLYPH.gap * S;
// The styleguide's 80 × 64 thumbnail, at 2.5×.
const THUMB_W_APX = 80 * S;
const THUMB_H_APX = 64 * S;
const TILE_W_APX = THUMB_W_APX + 2 * GAP_APX;
const RESULT_SLOTS = 6;
const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

export type FindTargetId = 'query' | 'search' | 'speak' | 'close' | `category:${string}` | `result:${number}` | `key:${string}`;

export interface VrFindPanelOptions {
  /** A pick: the result's GLB URL, for the tray's loader. */
  onPick(url: string): void;
  onClose(): void;
  /** The query line was selected and the session's system keyboard should rise; false falls back to the in-world keyboard. */
  openSystemKeyboard(): boolean;
  /** The system keyboard should go away without searching what it holds. */
  closeSystemKeyboard(): void;
  canCommit(pointerId: number): boolean;
  onCommit(pointerId: number): void;
  /** Speak was pressed by this pointer; the caller ends the hold when that select is released. */
  onHoldStart(pointerId: number): void;
  onHover(pointerId: number, hovered: boolean): void;
  /** The chip's opacity: VR 72%, Quest passthrough 97% (2.3, 9.2). */
  chipOpacity: number;
}

export interface VrFindPanelProbe {
  visible: boolean;
  worldPosition: number[];
  query: string;
  status: string;
  keyboard: 'none' | 'in-world' | 'system';
  results: Array<{ title: string; byline: string; thumbnailUrl: string }>;
  targets: Array<{ id: FindTargetId; text: string; enabled: boolean; visible: boolean; hitHeightM: number; hitWidthM: number }>;
}

interface Target {
  id: FindTargetId;
  hit: InstanceType<typeof UIKit.Container>;
  labels: Array<InstanceType<typeof UIKit.Text>>;
  enabled: boolean;
  shown: boolean;
  /** At least 1 m from the head (7.3); nearer, its words are hidden and it takes no hits. */
  readable: boolean;
  hovering: Set<number>;
  /** Pointers whose select is down on this target (6: pressed is 55%). */
  pressing: Set<number>;
}

const headPosition = new THREE.Vector3();
const headQuaternion = new THREE.Quaternion();
const headScale = new THREE.Vector3();
const level = new THREE.Euler();
const forward = new THREE.Vector3();
const scratch = new THREE.Vector3();

export class VrFindPanel {
  readonly entity: Entity;
  private readonly document: UIKitDocument;
  private readonly root: InstanceType<typeof UIKit.Container>;
  private readonly pixelSize = metresPerApx(DISTANCE_M);
  private readonly targets = new Map<FindTargetId, Target>();
  private readonly queryText: InstanceType<typeof UIKit.Text>;
  private readonly statusText: InstanceType<typeof UIKit.Text>;
  private readonly debugText: InstanceType<typeof UIKit.Text>;
  private readonly resultsArea: InstanceType<typeof UIKit.Container>;
  private readonly keyboardArea: InstanceType<typeof UIKit.Container>;
  private readonly tiles: Array<{ image: InstanceType<typeof UIKit.Image>; title: InstanceType<typeof UIKit.Text>; byline: InstanceType<typeof UIKit.Text>; src: string | null }> = [];
  private keyboard: VrFindPanelProbe['keyboard'] = 'none';
  private disabled = false;
  private status = '';
  private shownResults: VrFindPanelProbe['results'] = [];
  private urls: string[] = [];

  constructor(world: World, private readonly session: ObjectSearchSession, private readonly options: VrFindPanelOptions) {
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
      width: 3 * TILE_W_APX + 2 * GAP_APX + 2 * CHIP.paddingInline * S,
      // A panel is a container for text: it is on the chip from the start (5.2).
      backgroundColor: withAlpha(COLOR.deepSea, options.chipOpacity)
    }));

    // The query line, its gold rule (as the desktop field's), then Search, Speak, Close.
    const head = row();
    const query = this.target('query', { flexGrow: 1, flexShrink: 1, justifyContent: 'flex-start', borderBottomWidth: Math.max(1, S), borderColor: COLOR.gold }, { onSelect: () => this.openKeyboard() });
    this.queryText = text('', LABEL_APX, TYPE.controlLabel.weight, COLOR.textMuted);
    query.add(this.queryText);
    this.targetOf('query').labels.push(this.queryText);
    head.add(query);
    head.add(this.labelled('search', 'Search', { onSelect: () => this.submit() }));
    head.add(this.labelled('speak', 'Hold to speak', { onPress: (pointerId) => {
      this.session.startVoice();
      this.options.onHoldStart(pointerId);
    } }));
    head.add(this.labelled('close', 'Close', { onSelect: () => this.options.onClose() }));
    root.add(head);

    const categories = row();
    for (const category of OBJECT_CATEGORIES) {
      categories.add(this.labelled(`category:${category}`, capitalise(category), { onSelect: () => this.searchFor(category) }));
    }
    root.add(categories);

    this.statusText = text('', BYLINE_APX * 1.12, 400, COLOR.textMuted);
    root.add(this.statusText);
    this.debugText = text('', BYLINE_APX, 400, COLOR.textMuted);
    this.debugText.setProperties({ display: 'none' });
    root.add(this.debugText);

    this.resultsArea = new UIKit.Container({ flexDirection: 'row', flexWrap: 'wrap', gap: GAP_APX });
    for (let i = 0; i < RESULT_SLOTS; i += 1) {
      const tile = this.target(`result:${i}`, { width: TILE_W_APX, flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start', padding: GAP_APX, gap: GAP_APX / 2 }, { onSelect: () => this.pick(i) });
      const image = new UIKit.Image({ width: THUMB_W_APX, height: THUMB_H_APX, objectFit: 'cover', pointerEvents: 'none', borderRadius: CHIP.radius });
      const title = text('', LABEL_APX, TYPE.controlLabel.weight, COLOR.gold);
      const byline = text('', BYLINE_APX, 400, COLOR.textMuted);
      title.setProperties({ width: THUMB_W_APX, wordBreak: 'break-word' });
      byline.setProperties({ width: THUMB_W_APX, wordBreak: 'break-word' });
      tile.add(image, title, byline);
      this.targetOf(`result:${i}`).labels.push(title, byline);
      tile.setProperties({ display: 'none' });
      this.resultsArea.add(tile);
      this.tiles.push({ image, title, byline, src: null });
    }
    root.add(this.resultsArea);

    // The in-world keyboard: where the session has no system keyboard (and in IWER).
    this.keyboardArea = new UIKit.Container({ flexDirection: 'column', alignItems: 'center', gap: GAP_APX / 2, display: 'none' });
    for (const letters of KEY_ROWS) {
      const keys = row(GAP_APX / 2);
      keys.setProperties({ justifyContent: 'center' });
      for (const letter of letters) keys.add(this.labelled(`key:${letter}`, letter, { onSelect: () => this.type(letter) }, HIT.ray));
      this.keyboardArea.add(keys);
    }
    const last = row(GAP_APX / 2);
    last.setProperties({ justifyContent: 'center' });
    last.add(this.labelled('key:space', 'Space', { onSelect: () => this.type(' ') }, HIT.ray * 3));
    last.add(this.labelled('key:delete', 'Delete', { onSelect: () => this.session.setQuery(this.session.getState().query.slice(0, -1)) }, HIT.ray * 2));
    last.add(this.labelled('key:done', 'Search', { onSelect: () => this.submit() }, HIT.ray * 2));
    this.keyboardArea.add(last);
    root.add(this.keyboardArea);

    this.document = new UIKitDocument(root);
    this.entity = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
    this.entity.object3D!.name = 'FindPanel';
    this.entity.object3D!.add(this.document);
    this.entity.addComponent(RayInteractable);
    this.setVisible(false);
  }

  // --- Building ---

  private target(id: FindTargetId, style: Record<string, unknown>, actions: { onSelect?: () => void; onPress?: (pointerId: number) => void }): InstanceType<typeof UIKit.Container> {
    const hit = new UIKit.Container({ minHeight: HIT.ray, minWidth: HIT.ray, alignItems: 'center', justifyContent: 'center', ...style });
    const entry: Target = { id, hit, labels: [], enabled: true, shown: true, readable: true, hovering: new Set(), pressing: new Set() };
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
    // A hold is the select's, not the ray's: IWSDK turns a controller's ray
    // off while its trigger is down, so the caller ends it on that select's
    // release (6.1, holds), not when the ray leaves.
    if (actions.onPress) {
      hit.addEventListener('pointerdown' as never, ((event: PanelPointerEvent) => {
        if (!this.takesHits(entry) || !this.options.canCommit(event.pointerId)) return;
        actions.onPress!(event.pointerId);
        this.options.onCommit(event.pointerId);
      }) as never);
    }
    if (actions.onSelect) {
      hit.addEventListener('click' as never, ((event: PanelPointerEvent) => {
        if (!this.takesHits(entry) || !this.options.canCommit(event.pointerId)) return;
        actions.onSelect!();
        this.options.onCommit(event.pointerId);
      }) as never);
    }
    this.targets.set(id, entry);
    return hit;
  }

  private labelled(id: FindTargetId, word: string, actions: Parameters<VrFindPanel['target']>[2], minWidth: number = HIT.ray): InstanceType<typeof UIKit.Container> {
    const hit = this.target(id, { minWidth, paddingLeft: GAP_APX / 2, paddingRight: GAP_APX / 2 }, actions);
    const label = text(word, LABEL_APX, TYPE.controlLabel.weight, COLOR.gold);
    hit.add(label);
    this.targetOf(id).labels.push(label);
    return hit;
  }

  private targetOf(id: FindTargetId): Target {
    return this.targets.get(id)!;
  }

  // --- Actions ---

  private searchFor(query: string): void {
    this.closeKeyboard();
    this.session.search(query);
  }

  private submit(): void {
    this.closeKeyboard();
    this.session.search();
  }

  private type(key: string): void {
    this.session.setQuery(`${this.session.getState().query}${key}`);
  }

  private openKeyboard(): void {
    if (this.keyboard !== 'none') {
      this.closeKeyboard();
      return;
    }
    this.keyboard = this.options.openSystemKeyboard() ? 'system' : 'in-world';
  }

  /** The system keyboard closed (submitted or dismissed). */
  systemKeyboardClosed(): void {
    if (this.keyboard === 'system') this.keyboard = 'none';
  }

  private closeKeyboard(): void {
    // A search from the panel ends typing: the system keyboard closes without
    // searching its words, so it cannot later replace these results.
    if (this.keyboard === 'system') this.options.closeSystemKeyboard();
    this.keyboard = 'none';
  }

  private pick(slot: number): void {
    const url = this.urls[slot];
    if (url) this.options.onPick(url);
  }

  // --- Placement and state ---

  /** Opens 1.5 m straight ahead of the head and level with it, facing it (1.2), as the settings panel does. */
  place(headObject: THREE.Object3D): void {
    headObject.updateWorldMatrix(true, false);
    headObject.matrixWorld.decompose(headPosition, headQuaternion, headScale);
    level.setFromQuaternion(headQuaternion, 'YXZ');
    forward.set(-Math.sin(level.y), 0, -Math.cos(level.y));
    const object = this.entity.object3D!;
    const at = scratch.copy(headPosition).addScaledVector(forward, DISTANCE_M);
    object.parent?.updateWorldMatrix(true, false);
    object.position.copy(object.parent ? object.parent.worldToLocal(at.clone()) : at);
    object.lookAt(headPosition);
  }

  /** The chip follows the session: VR 72%, passthrough 97% (2.3, 9.2). */
  setChipOpacity(opacity: number): void {
    this.root.setProperties({ backgroundColor: withAlpha(COLOR.deepSea, opacity) });
  }

  setVisible(visible: boolean): void {
    this.entity.object3D!.visible = visible;
    if (!visible) {
      this.keyboard = 'none';
      for (const target of this.targets.values()) {
        target.hovering.clear();
        target.pressing.clear();
      }
    }
  }

  /**
   * Paints the session's state: the query, a status line, the tiles, the
   * keyboard; hides any text within 1 m of the head (7.3), each by its own distance.
   * `disabled`: a take is running or the tray is loading.
   * `trayLine`: what the tray says after a pick (loading, a refusal).
   */
  update(headObject: THREE.Object3D, { disabled, trayLine, debugLine }: { disabled: boolean; trayLine: string | null; debugLine: string | null }): void {
    const state = this.session.getState();
    this.disabled = disabled;
    headObject.getWorldPosition(headPosition);

    say(this.queryText, state.query || 'Find an object…');
    this.status = statusLine(state, trayLine);
    say(this.statusText, this.status);
    this.statusText.setProperties({ display: this.status ? 'flex' : 'none', opacity: this.readableAt(this.statusText) ? 1 : 0 });
    say(this.debugText, debugLine ?? '');
    this.debugText.setProperties({ display: debugLine ? 'flex' : 'none', opacity: this.readableAt(this.debugText) ? 1 : 0 });

    const results = state.finding.status === 'done' ? state.finding.results : [];
    this.urls = results.map((result) => objectGlbUrl(result));
    this.shownResults = [];
    this.tiles.forEach((tile, i) => {
      const result = results[i];
      const target = this.targetOf(`result:${i}`);
      target.shown = Boolean(result);
      target.hit.setProperties({ display: result ? 'flex' : 'none' });
      if (!result) return;
      const byline = `${result.author} · ${licenceLabel(result.licence)}`;
      if (tile.src !== result.thumbnailUrl) {
        tile.src = result.thumbnailUrl;
        tile.image.setProperties({ src: result.thumbnailUrl });
      }
      say(tile.title, result.title);
      say(tile.byline, byline);
      this.shownResults.push({ title: result.title, byline, thumbnailUrl: result.thumbnailUrl });
    });

    const inWorld = this.keyboard === 'in-world';
    this.keyboardArea.setProperties({ display: inWorld ? 'flex' : 'none' });
    this.resultsArea.setProperties({ display: inWorld ? 'none' : 'flex' });
    for (const target of this.targets.values()) {
      if (target.id.startsWith('key:')) target.shown = inWorld;
      else if (target.id.startsWith('result:')) target.shown = target.shown && !inWorld;
    }

    const busy = state.voice !== 'idle';
    for (const target of this.targets.values()) {
      target.enabled = !disabled && enabledFor(target.id, state, busy);
      const readable = this.readableAt(target.hit);
      target.readable = readable;
      const hovered = target.hovering.size > 0 && this.takesHits(target);
      // Held Speak is pressed for the whole hold, after the ray has gone off.
      const pressed = (target.pressing.size > 0 && this.takesHits(target)) || (target.id === 'speak' && state.voice === 'listening');
      for (const label of target.labels) {
        const muted = (label === this.queryText && !state.query) || this.tiles.some((tile) => tile.byline === label);
        label.setProperties({
          color: hovered || pressed ? COLOR.highlight : muted ? COLOR.textMuted : COLOR.gold,
          opacity: !readable ? 0 : target.enabled && !pressed ? 1 : GLYPH.pressedOpacity
        });
      }
      target.hit.setProperties({ pointerEvents: readable && target.enabled && target.shown ? 'auto' : 'none' });
    }
    const speak = this.targetOf('speak').labels[0]!;
    say(speak, state.voice === 'listening' ? 'Listening…' : state.voice === 'transcribing' ? 'Hearing…' : 'Hold to speak');
  }

  private takesHits(target: Target): boolean {
    return target.enabled && target.shown && target.readable && this.isShown();
  }

  private readableAt(object: THREE.Object3D): boolean {
    return object.getWorldPosition(scratch).distanceTo(headPosition) >= LABEL_MIN_DISTANCE_M;
  }

  isShown(): boolean {
    for (let node: THREE.Object3D | null = this.entity.object3D!; node; node = node.parent) if (!node.visible) return false;
    return true;
  }

  hitTarget(id: FindTargetId): THREE.Object3D | null {
    return this.targets.get(id)?.hit ?? null;
  }

  /** The target a pointer rests on, if any. */
  hoveredBy(pointerId: number): FindTargetId | null {
    for (const target of this.targets.values()) if (target.hovering.has(pointerId) && this.takesHits(target)) return target.id;
    return null;
  }

  /** Every text showing now: target labels, tile bylines, the status and debug lines. */
  readableLabels(): Array<{ id: string; text: string; object: THREE.Object3D }> {
    if (!this.isShown()) return [];
    const labels: Array<{ id: string; text: string; object: THREE.Object3D }> = [...this.targets.values()]
      .filter((target) => target.shown && target.readable)
      .map((target) => ({ id: target.id, text: labelText(target), object: target.hit }));
    for (const [id, label] of [['status', this.statusText], ['debug', this.debugText]] as const) {
      if (this.readableAt(label)) labels.push({ id, text: words.get(label) ?? '', object: label });
    }
    return labels.filter((label) => label.text.trim() !== '');
  }

  probe(): VrFindPanelProbe {
    const state = this.session.getState();
    return {
      visible: this.isShown(),
      worldPosition: this.entity.object3D!.getWorldPosition(new THREE.Vector3()).toArray(),
      query: state.query,
      status: this.status,
      keyboard: this.keyboard,
      results: this.shownResults,
      targets: [...this.targets.values()].map((target) => {
        const size = target.hit.size.value ?? [0, 0];
        return { id: target.id, text: labelText(target), enabled: target.enabled && !this.disabled, visible: this.isShown() && target.shown && target.readable, hitWidthM: size[0] * this.pixelSize, hitHeightM: size[1] * this.pixelSize };
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

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function enabledFor(id: FindTargetId, state: ObjectSearchState, busy: boolean): boolean {
  if (id === 'close') return true;
  if (id === 'speak') return state.voice !== 'transcribing';
  if (busy) return false;
  if (id === 'search' || id === 'key:done') return state.query.trim() !== '';
  return true;
}

function statusLine(state: ObjectSearchState, trayLine: string | null): string {
  if (state.voice === 'listening') return 'Listening…';
  if (state.voice === 'transcribing') return 'Hearing that…';
  if (trayLine) return trayLine;
  if (state.notice) return state.notice;
  if (state.finding.status === 'loading') return 'Searching…';
  if (state.finding.status === 'error') return state.finding.message;
  if (state.finding.status === 'done' && state.finding.results.length === 0) return 'No models found';
  return '';
}
