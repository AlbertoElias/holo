import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import { tokens } from '@holoim/design-tokens';
import { Chip, defaultHitInput, Dock, GlyphControl, GlyphSvg, Halo, HaloRing, HandednessPicker, SideSheet, Type } from '@holoim/ui-dom';
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

      <Dock input={input} unfold aria-label="Capture" data-capture-dock="" onClickCapture={returnFocusToScene} style={{ pointerEvents: 'none' }}>
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
              if (recording.canToggle) bridge.toggleRecording();
            }}
          />
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
            title={touch ? 'Tray' : 'Tray · hold T'}
            testId="dock-tray"
            input={input}
            highlighted={trayOpen}
            expanded={trayOpen}
            onPress={trayGlyph.toggle}
            pointerHandlers={trayGlyph.pointerHandlers}
          />
        ) : null}
        {flat && show('putBack') && state.tray.holding && state.recordingState !== 'exporting' ? (
          <DockGlyphButton glyph="putBack" label="Put back" title={touch ? 'Put back' : 'Put back · Backspace'} testId="dock-put-back" input={input} onPress={() => bridge.putBackHeld()} />
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

      {flat ? <TrayRow tray={state.tray} touch={touch} input={input} armedSlot={trayGlyph.armedSlot} bottom={aboveDock} onSummon={summonSlot} onRemove={(slot) => bridge.removeTraySlot(slot)} /> : null}

      {flat && findOpen ? (
        <FindSheet
          input={input}
          target={target}
          bottom={aboveDock}
          raised={trayOpen}
          loading={state.tray.loading}
          onPick={(url) => bridge.loadTrayUrls([url])}
          onClose={() => setFindOpen(false)}
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
function FindSheet({ input, target, bottom, raised, loading, onPick, onClose }: { input: HitInput; target: ViewTarget; bottom: string; raised: boolean; loading: boolean; onPick: (url: string) => void; onClose: () => void }) {
  const gap = glyphMetrics({ headset: false }).gapApx;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: raised ? `calc(${bottom} + 96px)` : bottom, display: 'flex', justifyContent: 'center', paddingInline: `max(env(safe-area-inset-left), ${PHONE_EDGES.side}px)`, pointerEvents: 'none' }}>
      <div style={{ pointerEvents: 'auto', width: 'min(100%, 26rem)', maxHeight: '50vh', overflowY: 'auto' }}>
        <Chip target={target} role="dialog" aria-label="Find an object" data-testid="find-sheet" style={{ display: 'grid', gap, padding: gap }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap }}>
            <Type variant="byline" as="h3" style={{ margin: 0 }}>
              Find
            </Type>
            <GlyphControl glyph="close" label="Close" input={input} onPress={onClose} />
          </div>
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
  return (
    <span data-capture-halo="" style={{ pointerEvents: 'auto', display: 'inline-flex' }}>
      <Halo
        actions={FLAT_CAPTURE_HALO_ACTIONS}
        ringLiftApx={layout.radiusApx + layout.slotApx / 2 + glyphMetrics({ headset: false }).gapApx}
        onCommit={(commit) => {
          if (commit.action) bridge.runHaloAction(commit.action, touch ? 'touch' : 'mouse');
        }}
        trigger={(view) => (
          <span role="img" aria-label="Halo: click, or hold and move to a direction" style={{ display: 'inline-grid', placeItems: 'center', width: hit, height: hit, cursor: 'pointer' }}>
            <GlyphSvg drawing={glyphDrawing('halo')} appearance={glyphAppearance({ hovered: view.ringDrawn }, { headset: false })} />
          </span>
        )}
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  const gap = glyphMetrics({ headset: false }).gapApx;
  return (
    <section style={{ display: 'grid', gap: gap / 2, marginTop: gap * 2 }}>
      <Type variant="byline" as="h3" style={{ margin: 0 }}>
        {title}
      </Type>
      {children}
    </section>
  );
}

function SettingsBody({ bridge, state, touch, input }: { bridge: CaptureUiBridge; state: UiViewModel; touch: boolean; input: HitInput }) {
  const desktop = state.mode === 'desktop-third' || state.mode === 'desktop-first';
  return (
    <>
      <Section title="Hand">
        <HandednessPicker value={state.handedness} onChange={(handedness) => bridge.setHandedness(handedness)} wristControl="Record" input={input} />
      </Section>

      {desktop ? (
        <Section title="Face">
          <div>
            <GlyphControl glyph={null} label={faceCameraLabel(state.faceCamera)} input={input} onPress={() => bridge.toggleFaceCamera()} />
          </div>
        </Section>
      ) : null}

      <Section title="Props">
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          <ObjectPicker bridge={bridge} object={state.object} disabled={state.recordingState !== 'idle'} input={input} />
          <TrayPicker bridge={bridge} tray={state.tray} disabled={false} input={input} />
        </div>
        <ObjectFinder disabled={state.tray.loading} input={input} onPick={(url) => bridge.loadTrayUrls([url])} />
      </Section>

      <Section title="Microphone">
        <Type variant="captionUnderCard" as="p" style={{ margin: 0 }}>
          {state.micPermission === 'granted'
            ? 'On: takes save with sound.'
            : state.micPermission === 'denied'
              ? 'Off: takes save without sound.'
              : 'Waiting for permission.'}
        </Type>
      </Section>

      <Section title={touch ? 'Touch' : 'Keys'}>
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
      </Section>
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

// The supplied object (PRD-043): one GLB, chosen before recording.
function ObjectPicker({ bridge, object, disabled, input }: { bridge: CaptureUiBridge; object: UiViewModel['object']; disabled: boolean; input: HitInput }) {
  const label = object.status === 'ready' ? `Object: ${object.name}` : object.status === 'loading' ? 'Loading object…' : 'Choose object…';
  return (
    <FilePickerWord
      label={label}
      ariaLabel="Choose an object (.glb)"
      accept=".glb,model/gltf-binary"
      disabled={disabled || object.status === 'loading'}
      input={input}
      onFiles={(files) => bridge.loadObjectFile(files[0]!)}
    />
  );
}

// The prepared tray (PRD-045): up to five GLBs or images, before recording.
function TrayPicker({ bridge, tray, disabled, input }: { bridge: CaptureUiBridge; tray: UiViewModel['tray']; disabled: boolean; input: HitInput }) {
  const label = tray.loading ? 'Loading tray…' : tray.names.length > 0 ? `Tray: ${tray.names.length}` : 'Tray…';
  return (
    <FilePickerWord
      label={label}
      ariaLabel="Add tray items (.glb, .png, .jpg)"
      accept=".glb,model/gltf-binary,.png,image/png,.jpg,.jpeg,image/jpeg"
      multiple
      disabled={disabled || tray.loading}
      input={input}
      onFiles={(files) => bridge.loadTrayFiles(files)}
    />
  );
}

function faceCameraLabel(state: UiViewModel['faceCamera']): string {
  switch (state) {
    case 'off':
      return 'Face camera: off';
    case 'starting':
      return 'Face camera: starting…';
    case 'tracking':
      return 'Face camera: tracking';
    case 'no-face':
      return 'Face camera: no face in view';
    case 'denied':
      return 'Face camera: permission denied';
    case 'unavailable':
      return 'Face camera: unavailable';
  }
}
