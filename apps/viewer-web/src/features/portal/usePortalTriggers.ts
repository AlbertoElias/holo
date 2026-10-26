import { useEffect } from "react";
import type { RefObject } from "react";
import { MathUtils } from "three";

import type { PortalStore } from "./portalStore";
import type { PortalTriggers } from "./portalVariant";

// Triggers translate input into portal actions. Each one checks its variant
// switch at event time, so pausing or changing variant needs no re-binding.

// A tap is a press released without moving; its duration does not matter,
// so a slow device or a loaded test runner cannot turn a tap into nothing.
const TAP_MAX_MOVE_PX = 10;
/** A drag across the full card width turns the view half a circle. */
const ORBIT_RADIANS_PER_CARD_WIDTH = Math.PI;
const WHEEL_ZOOM_PER_PIXEL = 0.0015;
const CTRL_WHEEL_ZOOM_PER_PIXEL = 0.01;
/** Wheel events closer than this belong to one gesture, trackpad momentum included. */
const WHEEL_GESTURE_GAP_MS = 250;
/**
 * The wheel gesture under way, followed on the window rather than per card: a
 * scroll crosses cards, the card that slides under the pointer must not start
 * a gesture of its own, and none may be missed while focus moves between cards.
 * A card decides it on the gesture's first event; a gesture that began
 * anywhere else has no card and only scrolls.
 */
let wheelGesture: { first: WheelEvent; card: HTMLElement | null; zooms: boolean; lastAt: number } | null = null;
let followingWheelGestures = false;

function followWheelGestures(): void {
  if (followingWheelGestures || typeof window === "undefined") return;
  followingWheelGestures = true;
  window.addEventListener("wheel", (event) => {
    // A trackpad pinch (ctrl+wheel) zooms wherever it lands; it is no scroll.
    if (event.ctrlKey) return;
    if (!wheelGesture || event.timeStamp - wheelGesture.lastAt > WHEEL_GESTURE_GAP_MS) {
      wheelGesture = { first: event, card: null, zooms: false, lastAt: event.timeStamp };
    }
    wheelGesture.lastAt = event.timeStamp;
  }, { capture: true, passive: true });
}
const KEY_ORBIT_RADIANS = 0.15;
const KEY_ZOOM_SCALE = 1.25;
/** Device rotation is amplified so a small wrist turn shows a useful new angle. */
const TILT_GAIN = 1.5;
const TILT_MAX_RADIANS = MathUtils.degToRad(75);
const TILT_FOLLOW_DEADZONE_RADIANS = MathUtils.degToRad(6);
const INTERACTIVE_SELECTOR = "button, a, input, textarea, select, label";

type Pointer = { x: number; y: number; startX: number; startY: number };

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null;
}

function pinchDistance(pointers: Map<number, Pointer>): number {
  const [a, b] = [...pointers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

function wrapDegrees(degrees: number): number {
  return ((degrees + 540) % 360) - 180;
}

export function usePortalTriggers(
  cardRef: RefObject<HTMLElement | null>,
  store: PortalStore,
  triggers: PortalTriggers,
  active: boolean
): void {
  useEffect(() => {
    const card = cardRef.current;
    if (!card || !active) return;

    const pointers = new Map<number, Pointer>();
    let dragging = false;
    let lastPinch = 0;

    const canDrag = () => (store.getState().paused ? triggers.dragWhilePaused : triggers.dragWhilePlaying);
    const canPinch = () => (store.getState().paused ? triggers.pinchWhilePaused : triggers.pinchWhilePlaying);

    const onPointerDown = (event: PointerEvent) => {
      if (isInteractive(event.target) || (event.pointerType === "mouse" && event.button !== 0)) return;
      if (pointers.size === 0) {
        dragging = false;
        lastPinch = 0;
      }
      pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY
      });
      if (pointers.size === 2) {
        lastPinch = pinchDistance(pointers);
        dragging = true;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;

      if (pointers.size >= 2) {
        const distance = pinchDistance(pointers);
        if (canPinch() && lastPinch > 0 && distance > 0) {
          store.zoomByScale(distance / lastPinch);
        }
        lastPinch = distance;
        return;
      }

      if (!dragging && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > TAP_MAX_MOVE_PX) {
        dragging = true;
        if (canDrag()) card.setPointerCapture?.(event.pointerId);
      }
      if (dragging && canDrag()) {
        const radiansPerPixel = ORBIT_RADIANS_PER_CARD_WIDTH / Math.max(card.clientWidth, 1);
        store.orbitBy(-dx * radiansPerPixel, dy * radiansPerPixel);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      pointers.delete(event.pointerId);
      if (!pointer) return;
      const wasTap = !dragging
        && pointers.size === 0
        && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) <= TAP_MAX_MOVE_PX;
      if (pointers.size === 0) dragging = false;
      if (pointers.size < 2) lastPinch = 0;
      if (wasTap && triggers.tapToPause) store.togglePause();
    };

    // The browser took the touch over for scrolling; the gesture is not ours.
    const onPointerCancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size === 0) dragging = false;
      lastPinch = 0;
    };

    const onWheel = (event: WheelEvent) => {
      const paused = store.getState().paused;
      // Browsers report a trackpad pinch as ctrl+wheel.
      if (event.ctrlKey) {
        if (!canPinch()) return;
        event.preventDefault();
        store.zoomByScale(Math.exp(-event.deltaY * CTRL_WHEEL_ZOOM_PER_PIXEL));
        return;
      }
      // The feed scrolls unless the gesture began on the hologram itself. A
      // scroll that began over empty space stays a scroll when this or the
      // next card's hologram then passes under the pointer.
      if (!wheelGesture) return;
      if (wheelGesture.first === event) {
        const overHologram = !isInteractive(event.target) && (store.runtime.hitTest?.(event.clientX, event.clientY) ?? false);
        wheelGesture.card = card;
        wheelGesture.zooms = overHologram && ((paused && triggers.wheelZoomWhilePaused) || triggers.wheelZoomOverBubble);
      }
      if (!wheelGesture.zooms || wheelGesture.card !== card) return;
      // Fully zoomed out, wheeling further out belongs to the feed.
      const { mode, zoom } = store.getState();
      const atOutsideEnd = mode === "follow" || zoom >= 1;
      if (!paused && event.deltaY > 0 && atOutsideEnd) return;
      event.preventDefault();
      store.zoomByScale(Math.exp(-event.deltaY * WHEEL_ZOOM_PER_PIXEL));
    };

    // Keyboard works in every variant so the portal stays usable without a pointer.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
      const handled = (() => {
        switch (event.key) {
          case " ":
          case "k":
            if (isInteractive(event.target)) return false;
            store.togglePause();
            return true;
          case "ArrowLeft":
            store.orbitBy(KEY_ORBIT_RADIANS, 0);
            return true;
          case "ArrowRight":
            store.orbitBy(-KEY_ORBIT_RADIANS, 0);
            return true;
          case "ArrowUp":
            store.orbitBy(0, KEY_ORBIT_RADIANS);
            return true;
          case "ArrowDown":
            store.orbitBy(0, -KEY_ORBIT_RADIANS);
            return true;
          case "+":
          case "=":
            store.zoomByScale(KEY_ZOOM_SCALE);
            return true;
          case "-":
          case "_":
            store.zoomByScale(1 / KEY_ZOOM_SCALE);
            return true;
          case "Escape":
          case "0":
            store.returnToFollow();
            return true;
          default:
            return false;
        }
      })();
      if (handled) event.preventDefault();
    };

    // Gestures start on the card but may end anywhere, such as over the
    // upload panel; releases are heard on the window so none is missed.
    card.addEventListener("pointerdown", onPointerDown);
    card.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    followWheelGestures();
    card.addEventListener("wheel", onWheel, { passive: false });
    card.addEventListener("keydown", onKeyDown);
    return () => {
      card.removeEventListener("pointerdown", onPointerDown);
      card.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      card.removeEventListener("wheel", onWheel);
      card.removeEventListener("keydown", onKeyDown);
    };
  }, [active, cardRef, store, triggers]);

  // Device orientation turns the camera relative to how the phone was held
  // when tilt started, so any starting posture works.
  useEffect(() => {
    if (!active || !triggers.tilt) return;
    let baseline: { alpha: number; beta: number } | null = null;

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (store.getState().tiltStatus !== "on") {
        baseline = null;
        return;
      }
      if (event.alpha === null || event.beta === null) return;
      baseline ??= { alpha: event.alpha, beta: event.beta };
      const yaw = MathUtils.degToRad(wrapDegrees(event.alpha - baseline.alpha)) * TILT_GAIN;
      const pitch = MathUtils.degToRad(event.beta - baseline.beta) * TILT_GAIN;
      // Hand tremor alone should not leave Follow.
      if (store.getState().mode === "follow" && Math.hypot(yaw, pitch) < TILT_FOLLOW_DEADZONE_RADIANS) return;
      store.setTilt(
        MathUtils.clamp(-yaw, -TILT_MAX_RADIANS, TILT_MAX_RADIANS),
        MathUtils.clamp(-pitch, -TILT_MAX_RADIANS, TILT_MAX_RADIANS)
      );
    };

    // Return re-centres tilt on the phone's current posture.
    let previousMode = store.getState().mode;
    const unsubscribe = store.subscribe(() => {
      const { mode, tiltStatus } = store.getState();
      if (tiltStatus !== "on" || (mode === "follow" && previousMode === "free")) baseline = null;
      previousMode = mode;
    });
    window.addEventListener("deviceorientation", onOrientation);
    return () => {
      unsubscribe();
      window.removeEventListener("deviceorientation", onOrientation);
    };
  }, [active, store, triggers.tilt]);
}

type OrientationPermissionApi = { requestPermission?: () => Promise<"granted" | "denied"> };

/** Must run inside a user gesture: iOS only shows its motion prompt then. */
export async function enableTilt(store: PortalStore): Promise<void> {
  if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) {
    store.setTiltStatus("unsupported");
    return;
  }
  const api = window.DeviceOrientationEvent as unknown as OrientationPermissionApi;
  if (typeof api.requestPermission === "function") {
    try {
      const result = await api.requestPermission();
      store.setTiltStatus(result === "granted" ? "on" : "denied");
    } catch {
      store.setTiltStatus("denied");
    }
    return;
  }
  store.setTiltStatus("on");
}
