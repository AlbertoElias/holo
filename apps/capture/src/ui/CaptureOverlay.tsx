import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';

import { tokens } from '@holoim/design-tokens';
import { Chip, ChoiceGroup, defaultHitInput, Dock, GlyphControl, GlyphSvg, Halo, HaloRing, HandednessPicker, SettingsSection, SideSheet, Type, typeRoleStyle, useHint } from '@holoim/ui-dom';
import {
  FLAT_CAPTURE_HALO_ACTIONS,
  PHONE_EDGES,
  VIEW_TARGETS,
  chromeVisible,
  createRecordingUiState,
  glyphAppearance,
  glyphDrawing,
  glyphMetrics,
  hitAreaApx,
  recordingText,
  type Control,
  type HitInput,
  type ViewTarget
} from '@holoim/xr-ui-core';

import { ObjectFinder } from './ObjectFinder';
import { DockGlyphButton, TrayRow, useAboveDock, useTrayGlyph } from './TrayRow';
import type { UiViewModel, XrEntryOffer } from '../types/contracts';
import type { CaptureUiBridge } from './captureUiBridge';
import { captureHelp, isTouchDevice } from './captureHelp';
import { PostPanel } from './PostPanel';
import { isSelfieJourney } from '../post/postFlow';

// Capture on a flat screen (styleguide 1.2, 5.2, 8.5; docs/features/ui-redesign.md
// slice 4): state on the top status line, actions in the bottom dock on its
// shade, lists and settings in the side sheet. While a take runs only the
// stop control and "Recording 0:12" show.

function resolveStatusText(state: UiViewModel): string {
  if (state.loadState === 'loading') {
    return 'Loading scene...';
  }

  if (state.loadState === 'error') {
    return state.warning ?? 'Failed to load scene/avatar assets.';
  }

  if (state.loadState === 'warning') {
    return state.warning ?? 'Loaded with warnings: spawn/physics setup incomplete.';
  }

  return state.warning ?? `Loaded. ${state.controls}`;
}

/** The one notice the top status line carries, most urgent first; null when there is nothing to say. */
function resolveNotice(state: UiViewModel): string | null {
  if (state.notice) return state.notice;
  if (state.loadState === 'loading') return 'Loading the scene…';
  if (state.loadState === 'error' || state.loadState === 'warning') return state.warning ?? resolveStatusText(state);
  if (state.recordingState === 'exporting') return state.recordingMessage ?? 'Exporting…';
  if (state.recordingState === 'idle' && state.recordingMessage) return state.recordingMessage;
  if (state.object.status === 'error' && state.object.message) return state.object.message;
  if (state.tray.message) return state.tray.message;
  if (state.micPermission === 'denied') return 'No microphone: takes save without sound.';
  return null;
}

function useTouchDevice(): boolean {
  const [touch, setTouch] = useState(isTouchDevice);
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(pointer: coarse)');
    } catch {
      return undefined;
    }
    const update = (): void => setTouch(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return touch;
}

// A dock control pressed by pointer gives focus back to the scene, so Space
// (jump) or R (record) never re-presses it. Keyboard presses keep focus.
function returnFocusToScene(event: ReactMouseEvent<HTMLElement>): void {
  if (event.detail === 0) return;
  const control = (event.target as Element).closest('button');
  if (control instanceof HTMLElement) queueMicrotask(() => control.blur());
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap'
} as const;

export function CaptureOverlay({ bridge }: { bridge: CaptureUiBridge }) {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const touch = useTouchDevice();
  const recording = createRecordingUiState(state.recordingState, state.recordingMessage);
  const isRecording = recording.status === 'recording';
  const target = touch ? VIEW_TARGETS.phone : VIEW_TARGETS.desktop;
  // The layout and help follow the primary pointer; hit areas take a finger
  // wherever one can reach the screen, a touch laptop's too (6.1).
  const input: HitInput = touch ? 'touch' : defaultHitInput();
  const show = (control: Control): boolean => chromeVisible(control, isRecording);
  const notice = resolveNotice(state);
  const vrMode = state.mode === 'vr' || state.mode === 'mock-vr';
  const flat = !vrMode && state.mode !== 'ar';
  const [findOpen, setFindOpen] = useState(false);
  // True while the tray was opened by the dock glyph: Escape or a press elsewhere then closes it (T held opens it without this).
  const trayOpenedByUi = useRef(false);
  const aboveDock = useAboveDock(input);
  const selfie = touch && isSelfieJourney();
  const countdown = useCountdown(3, () => bridge.toggleRecording());
  const trayGlyph = useTrayGlyph(bridge, state.tray.open, touch, trayOpenedByUi);
  const trayOpen = state.tray.open;

  const summonSlot = (slot: number): void => {
    bridge.summonTraySlot(slot);
    trayOpenedByUi.current = false;
    bridge.setTrayOpen(false);
  };
  const openFind = (): void => {
    if (document.pointerLockElement) document.exitPointerLock();
    setFindOpen(true);
  };

  useEffect(() => {
    if (!trayOpen) trayOpenedByUi.current = false;
  }, [trayOpen]);

  useEffect(() => {
    if (!trayOpen) return undefined;
    const close = (): void => {
      if (!trayOpenedByUi.current) return;
      trayOpenedByUi.current = false;
      bridge.setTrayOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-capture-tray-row], [data-testid="dock-tray"]')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [trayOpen, bridge]);

  useEffect(() => {
    if (!findOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFindOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [findOpen]);

  // Everything but stop and the running time leaves while a take runs.
  useEffect(() => {
    if (isRecording) setSettingsOpen(false);
  }, [isRecording]);

  return (
    <div data-capture-overlay="" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 10 }}>
      <div id="status" role="status" style={visuallyHidden}>
        {resolveStatusText(state)}
      </div>

      {notice !== null && show('status') ? (
        <div
          data-capture-status-line=""
          style={{
            position: 'absolute',
            top: `max(env(safe-area-inset-top), ${glyphMetrics({ headset: false }).gapApx}px)`,
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            // Clear of the back-swipe edges on a phone.
            paddingInline: `max(env(safe-area-inset-left), ${PHONE_EDGES.side}px)`
          }}
        >
          <Chip target={target}>
            <Type variant="controlLabel" style={{ color: 'var(--holoim-color-text)' }}>
              {notice}
            </Type>
          </Chip>
        </div>
      ) : null}

      <Dock input={input} unfold aria-label="Capture" data-capture-dock="" onClickCapture={returnFocusToScene} style={{ pointerEvents: 'none', ...(settingsOpen ? { visibility: 'hidden' } : null) }}>
        {show('settings') ? (
          <GlyphControl
            glyph={null}
            label="Settings"
            input={input}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onPress={() => setSettingsOpen((open) => !open)}
          />
        ) : null}
        <span data-capture-record="" style={{ display: 'inline-flex', alignItems: 'center', gap: glyphMetrics({ headset: false }).gapApx }}>
          <GlyphControl
            glyph="record"
            recording={isRecording}
            label={recording.actionLabel}
            input={input}
            onPress={() => {
              if (!recording.canToggle) return;
              if (countdown.running) countdown.cancel();
              else if (!isRecording && selfie && state.mode !== 'ar') countdown.start();
              else bridge.toggleRecording();
            }}
          />
          {countdown.running ? (
            <Type variant="timecode" as="span" data-capture-countdown="" aria-live="assertive">
              {countdown.value}
            </Type>
          ) : null}
          {isRecording ? (
            <Type variant="timecode" as="time" data-capture-running-time="">
              {recordingText(state.recordingElapsedMs)}
            </Type>
          ) : null}
        </span>
        {flat && show('halo') ? <DockHalo bridge={bridge} input={input} touch={touch} /> : null}
        {flat && show('tray') ? (
          <DockGlyphButton
            glyph="tray"
            label="Tray"
            hint={touch ? undefined : 'Tray · hold T'}
            testId="dock-tray"
            input={input}
            highlighted={trayOpen}
            expanded={trayOpen}
            onPress={trayGlyph.toggle}
            pointerHandlers={trayGlyph.pointerHandlers}
          />
        ) : null}
        {flat && show('putBack') && state.tray.holding && state.recordingState !== 'exporting' ? (
          <DockGlyphButton glyph="putBack" label="Put back" hint={touch ? undefined : 'Put back · Backspace'} testId="dock-put-back" input={input} onPress={() => bridge.putBackHeld()} />
        ) : null}
        {flat && show('find') ? (
          <DockGlyphButton glyph="find" label="Find" testId="dock-find" input={input} highlighted={findOpen} expanded={findOpen} onPress={() => (findOpen ? setFindOpen(false) : openFind())} />
        ) : null}
        {vrMode && show('record') && !isRecording ? (
          <GlyphControl glyph={null} label="Refit height" input={input} disabled={!state.heightFit.enabled} onPress={() => bridge.refitHeight()} />
        ) : null}
        {state.mode === 'ar' && show('exitAr') ? <GlyphControl glyph={null} label="Recenter AR" input={input} onPress={() => bridge.recenterAr()} /> : null}
        {show('exitAr') ? <XrEntryControl id="VRButton" mode="VR" offer={state.xrEntry.vr} input={input} onPress={() => bridge.toggleXr('vr')} /> : null}
        {show('exitAr') ? <XrEntryControl id="ARButton" mode="AR" offer={state.xrEntry.ar} input={input} onPress={() => bridge.toggleXr('ar')} /> : null}
      </Dock>

      <KeyHaloRing bridge={bridge} />

      {flat ? <TrayRow tray={state.tray} touch={touch} input={input} armedSlot={trayGlyph.armedSlot} bottom={aboveDock} addFiles={<TrayFilesPicker bridge={bridge} tray={state.tray} input={input} />} onSummon={summonSlot} onRemove={(slot) => bridge.removeTraySlot(slot)} /> : null}

      <PostPanel input={input} target={target} bottom={aboveDock} hidden={isRecording || findOpen || trayOpen} exporting={state.recordingState === 'exporting'} />

      {flat && findOpen ? (
        <FindSheet
          input={input}
          target={target}
          bottom={aboveDock}
          raised={trayOpen}
          loading={state.tray.loading}
          onPick={(url) => bridge.loadTrayUrls([url])}
        />
      ) : null}

      <div style={{ pointerEvents: 'auto' }}>
        <SideSheet open={settingsOpen && !isRecording} title="Settings" target={target} onClose={() => setSettingsOpen(false)}>
          <SettingsBody bridge={bridge} state={state} touch={touch} input={input} />
        </SideSheet>
      </div>
    </div>
  );
}

// Find on a flat screen: the object finder in a small sheet above the dock, so
// it stays reachable during a take, when the Settings sheet is closed.
function FindSheet({ input, target, bottom, raised, loading, onPick }: { input: HitInput; target: ViewTarget; bottom: string; raised: boolean; loading: boolean; onPick: (url: string) => void }) {
  const gap = glyphMetrics({ headset: false }).gapApx;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: raised ? `calc(${bottom} + 96px)` : bottom, display: 'flex', justifyContent: 'center', paddingInline: `max(env(safe-area-inset-left), ${PHONE_EDGES.side}px)`, pointerEvents: 'none' }}>
      <div style={{ pointerEvents: 'auto', width: 'min(100%, 28rem)', maxHeight: '60vh', overflowY: 'auto', borderRadius: tokens.chip.radius }}>
        <Chip target={target} role="dialog" aria-label="Find an object" data-testid="find-sheet" style={{ display: 'grid', gap, padding: gap * 1.5 }}>
          <ObjectFinder disabled={loading} input={input} onPick={onPick} />
        </Chip>
      </div>
    </div>
  );
}

// The Halo on a flat screen (slice 5): press and hold its dock glyph, move
// towards a direction, let go; a flick commits without the ring drawing. Its
// ring is lifted above the dock so the south place stays on screen.
function DockHalo({ bridge, input, touch }: { bridge: CaptureUiBridge; input: HitInput; touch: boolean }) {
  const { layout } = bridge.halo;
  const hit = hitAreaApx(input, glyphMetrics({ headset: false }).iconApx);
  // The shared hover hint names the key, as on Tray; touch has no hover and no key.
  const { handlers: hintOn, hint } = useHint(touch ? undefined : 'Halo · hold B');
  return (
    <span data-capture-halo="" style={{ pointerEvents: 'auto', display: 'inline-flex' }}>
      {hint}
      <Halo
        actions={FLAT_CAPTURE_HALO_ACTIONS}
        ringLiftApx={layout.radiusApx + layout.slotApx / 2 + glyphMetrics({ headset: false }).gapApx}
        onCommit={(commit) => {
          if (commit.action) bridge.runHaloAction(commit.action, touch ? 'touch' : 'mouse');
        }}
        trigger={(view) => {
          const appearance = glyphAppearance({ hovered: view.ringDrawn }, { headset: false });
          return (
            <span
              role="img"
              aria-label="Halo: click, or hold and move to a direction"
              {...hintOn}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: hit, minHeight: hit, cursor: 'pointer' }}
            >
              <span style={{ display: 'inline-flex', width: tokens.glyph.icon, height: tokens.glyph.icon }}>
                <GlyphSvg drawing={glyphDrawing('halo')} appearance={appearance} />
              </span>
            </span>
          );
        }}
      />
    </span>
  );
}

// The ring a held B draws, where the press happened (the screen's centre under pointer lock).
function KeyHaloRing({ bridge }: { bridge: CaptureUiBridge }) {
  const view = useSyncExternalStore(bridge.halo.subscribe, bridge.halo.getSnapshot, bridge.halo.getSnapshot);
  if (!view.open || !view.ringDrawn) return null;
  return (
    <div data-capture-key-halo="" style={{ position: 'absolute', left: view.at.x, top: view.at.y, width: 0, height: 0 }}>
      <HaloRing layout={bridge.halo.layout} highlighted={view.highlighted} />
    </div>
  );
}

function XrEntryControl({ id, mode, offer, input, onPress }: { id: string; mode: 'VR' | 'AR'; offer: XrEntryOffer; input: HitInput; onPress: () => void }) {
  // An entry the browser cannot offer is left out rather than talked about (styleguide 10, principle 5).
  if (offer !== 'available' && offer !== 'active') return null;
  return <GlyphControl glyph={null} id={id} label={`${offer === 'active' ? 'Exit' : 'Enter'} ${mode}`} input={input} onPress={onPress} />;
}

function SettingsBody({ bridge, state, touch, input }: { bridge: CaptureUiBridge; state: UiViewModel; touch: boolean; input: HitInput }) {
  const desktop = state.mode === 'desktop-third' || state.mode === 'desktop-first';
  return (
    <>
      <SettingsSection title="Hand">
        <HandednessPicker value={state.handedness} onChange={(handedness) => bridge.setHandedness(handedness)} input={input} />
      </SettingsSection>

      {desktop ? (
        <SettingsSection title="Face camera">
          <ChoiceGroup
            label="Face camera"
            value={faceCameraOn(state.faceCamera) ? 'on' : 'off'}
            options={FACE_CAMERA_OPTIONS}
            input={input}
            onChange={(next) => {
              if ((next === 'on') !== faceCameraOn(state.faceCamera)) bridge.toggleFaceCamera();
            }}
          />
          {faceCameraProblem(state.faceCamera) ? (
            <Type variant="captionUnderCard" as="p" data-testid="face-camera-status" style={{ margin: 0 }}>
              {faceCameraProblem(state.faceCamera)}
            </Type>
          ) : null}
        </SettingsSection>
      ) : null}

      {state.place.enabled ? (
        <SettingsSection title="Place">
          <div>
            <PlacePicker bridge={bridge} place={state.place} disabled={state.recordingState !== 'idle'} input={input} />
          </div>
          {state.place.message ? (
            <Type variant="captionUnderCard" as="p" style={{ margin: 0 }}>
              {state.place.message}
            </Type>
          ) : null}
        </SettingsSection>
      ) : null}

      <details data-testid="controls-help">
        <summary style={{ ...typeRoleStyle('byline'), cursor: 'pointer', color: 'var(--holoim-color-gold)' }}>{touch ? 'Touch controls' : 'Keys'}</summary>
        <div style={{ display: 'grid', gap: glyphMetrics({ headset: false }).gapApx, paddingTop: glyphMetrics({ headset: false }).gapApx }}>
          {captureHelp(state.mode, touch).map((line) => (
            <Type key={line} variant="captionUnderCard" as="p" style={{ margin: 0 }}>
              {line}
            </Type>
          ))}
          {typeof window !== 'undefined' && window.isSecureContext === false ? (
            <Type variant="captionUnderCard" as="p" style={{ margin: 0 }}>
              VR and AR need HTTPS.
            </Type>
          ) : null}
        </div>
      </details>
    </>
  );
}

// A file input under its word: the input is the control (one tab stop, named
// for assistive tech and checks), the word its drawing, at the input's hit
// area and dimmed like a disabled glyph control.
function FilePickerWord({ label, ariaLabel, accept, multiple, disabled, input, onFiles }: { label: string; ariaLabel: string; accept: string; multiple?: boolean; disabled: boolean; input: HitInput; onFiles: (files: File[]) => void }) {
  const hit = hitAreaApx(input, 0);
  return (
    <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', minWidth: hit, minHeight: hit, paddingInline: glyphMetrics({ headset: false }).gapApx / 2, opacity: disabled ? tokens.glyph.idleOpacity : 1 }}>
      <Type variant="controlLabel" aria-hidden="true" style={{ color: 'var(--holoim-color-gold)', whiteSpace: 'nowrap' }}>
        {label}
      </Type>
      <input
        aria-label={ariaLabel}
        type="file"
        multiple={multiple}
        accept={accept}
        disabled={disabled}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: disabled ? 'default' : 'pointer' }}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          if (files.length > 0) onFiles(files);
          event.currentTarget.value = '';
        }}
      />
    </label>
  );
}

// A scanned place (docs/features/splat-capture.md): one .spz or .ply, chosen before recording, replaces the set.
function PlacePicker({ bridge, place, disabled, input }: { bridge: CaptureUiBridge; place: UiViewModel['place']; disabled: boolean; input: HitInput }) {
  const label = place.status === 'loading' ? 'Reading the scan…' : place.status === 'ready' ? `Place: ${place.name}` : 'Choose a scan…';
  return (
    <FilePickerWord
      label={label}
      ariaLabel="Choose a scanned place (.spz, .ply)"
      accept=".spz,.ply"
      disabled={disabled || place.status === 'loading'}
      input={input}
      onFiles={(files) => bridge.loadPlaceFile(files[0]!)}
    />
  );
}

const FACE_CAMERA_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
] as const;

// A file input under a glyph: the input is the control (one tab stop, named for assistive tech), the glyph its drawing, a hint its name.
function FilePickerGlyph({ hint, ariaLabel, accept, multiple, disabled, input, onFiles }: { hint: string; ariaLabel: string; accept: string; multiple?: boolean; disabled: boolean; input: HitInput; onFiles: (files: File[]) => void }) {
  const hit = hitAreaApx(input, tokens.glyph.icon);
  const { handlers, hint: bubble } = useHint(input === 'touch' ? undefined : hint);
  const appearance = glyphAppearance({}, { headset: false });
  return (
    <label {...handlers} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: hit, minHeight: hit, opacity: disabled ? tokens.glyph.idleOpacity : 1 }}>
      <span style={{ display: 'inline-flex', width: tokens.glyph.icon, height: tokens.glyph.icon }}>
        <GlyphSvg drawing={glyphDrawing('upload')} appearance={appearance} />
      </span>
      <input
        aria-label={ariaLabel}
        type="file"
        multiple={multiple}
        accept={accept}
        disabled={disabled}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: disabled ? 'default' : 'pointer' }}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          if (files.length > 0) onFiles(files);
          event.currentTarget.value = '';
        }}
      />
      {bubble}
    </label>
  );
}

// The prepared tray (PRD-045): up to five GLBs or images, added from the tray itself.
function TrayFilesPicker({ bridge, tray, input }: { bridge: CaptureUiBridge; tray: UiViewModel['tray']; input: HitInput }) {
  return (
    <FilePickerGlyph
      hint="Add files"
      ariaLabel="Add tray items (.glb, .png, .jpg)"
      accept=".glb,model/gltf-binary,.png,image/png,.jpg,.jpeg,image/jpeg"
      multiple
      disabled={tray.loading}
      input={input}
      onFiles={(files) => bridge.loadTrayFiles(files)}
    />
  );
}

function faceCameraOn(state: UiViewModel['faceCamera']): boolean {
  return state === 'starting' || state === 'tracking' || state === 'no-face';
}

/** Said only when the camera needs attention: on and off speak for themselves. */
function faceCameraProblem(state: UiViewModel['faceCamera']): string | null {
  switch (state) {
    case 'denied':
      return 'The camera is blocked. Allow it in the browser.';
    case 'unavailable':
      return 'No camera found.';
    default:
      return null;
  }
}

/**
 * Before a selfie take, 3-2-1 in the dock beside Record: time to put the phone
 * down or step back. Record again cancels it.
 */
function useCountdown(from: number, onDone: () => void): { running: boolean; value: number; start: () => void; cancel: () => void } {
  const [value, setValue] = useState<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (value === null) return undefined;
    const timer = window.setTimeout(() => {
      if (value <= 1) {
        setValue(null);
        done.current();
      } else setValue(value - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [value]);
  return { running: value !== null, value: value ?? 0, start: () => setValue(from), cancel: () => setValue(null) };
}
