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
/**
 * When the feed last scrolled, followed on the window like the wheel: a touch
 * that lands while the feed is still gliding stops or continues the scroll,
 * whatever slid under the finger.
 */
let lastScrollAt = Number.NEGATIVE_INFINITY;
let followingScrolls = false;
const SCROLL_SETTLE_MS = 200;

function followScrolls(): void {
  if (followingScrolls || typeof window === "undefined") return;
  followingScrolls = true;
  window.addEventListener("scroll", (event) => {
    lastScrollAt = event.timeStamp;
  }, { capture: true, passive: true });
}

/** A flick this fast, or a drag this far into the card, turns the feed to the next card. */
const FLICK_PX_PER_MS = 0.3;
const FLICK_CARD_FRACTION = 0.2;
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

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/** The scroll positions the feed snaps to, from its children's snap alignment. */
function snapStops(scroller: HTMLElement): number[] {
  return [...scroller.children]
    .filter((child): child is HTMLElement => child instanceof HTMLElement && getComputedStyle(child).scrollSnapAlign.includes("start"))
    .map((child) => child.offsetTop);
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
    // A touch looks around only when it starts on the hologram itself, as
    // the wheel zooms; any other one-finger swipe belongs to the feed.
    let looking = false;
    // A swipe the browser would not scroll, because it began sideways, is
    // scrolled here and settled on a card on release.
    let feedSwipe: { scroller: HTMLElement; startTop: number; velocity: number; at: number } | null = null;

    const canDrag = () => (store.getState().paused ? triggers.dragWhilePaused : triggers.dragWhilePlaying);
    const canPinch = () => (store.getState().paused ? triggers.pinchWhilePaused : triggers.pinchWhilePlaying);
    const captures = () => store.getState().paused && !triggers.scrollWhilePaused;

    const endFeedSwipe = (settle: boolean) => {
      if (!feedSwipe) return;
      const { scroller, startTop, velocity } = feedSwipe;
      feedSwipe = null;
      const restore = () => delete scroller.dataset.portalScrolling;
      if (!settle) {
        restore();
        return;
      }
      const stops = snapStops(scroller);
      const from = stops.reduce((best, stop) => (Math.abs(stop - startTop) < Math.abs(best - startTop) ? stop : best), startTop);
      const moved = scroller.scrollTop - from;
      const turns = Math.abs(velocity) > FLICK_PX_PER_MS || Math.abs(moved) > card.clientHeight * FLICK_CARD_FRACTION;
      const direction = Math.abs(velocity) > FLICK_PX_PER_MS ? Math.sign(velocity) : Math.sign(moved);
      const target = turns
        ? (direction > 0 ? stops.find((stop) => stop > from + 1) : [...stops].reverse().find((stop) => stop < from - 1)) ?? from
        : from;
      scroller.scrollTo({ top: target, behavior: "smooth" });
      // Snapping comes back once the glide has landed on the card.
      let restored = false;
      const once = () => {
        if (restored) return;
        restored = true;
        restore();
      };
      scroller.addEventListener("scrollend", once, { once: true });
      window.setTimeout(once, 800);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (isInteractive(event.target) || (event.pointerType === "mouse" && event.button !== 0)) return;
      if (pointers.size === 0) {
        dragging = false;
        lastPinch = 0;
        looking = event.pointerType === "mouse"
          || captures()
          || (event.timeStamp - lastScrollAt > SCROLL_SETTLE_MS && (store.runtime.hitTest?.(event.clientX, event.clientY, { glass: true }) ?? false));
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
        const scroller = looking && canDrag() ? null : scrollParent(card);
        if (scroller) {
          scroller.dataset.portalScrolling = "";
          feedSwipe = { scroller, startTop: scroller.scrollTop, velocity: 0, at: event.timeStamp };
        }
        if (scroller || (looking && canDrag())) card.setPointerCapture?.(event.pointerId);
      }
      if (!dragging) return;
      if (feedSwipe) {
        const { scroller } = feedSwipe;
        scroller.scrollTo({ top: scroller.scrollTop - dy, behavior: "instant" });
        const elapsed = Math.max(event.timeStamp - feedSwipe.at, 1);
        feedSwipe.velocity = feedSwipe.velocity * 0.5 + (-dy / elapsed) * 0.5;
        feedSwipe.at = event.timeStamp;
      } else if (looking && canDrag()) {
        const radiansPerPixel = ORBIT_RADIANS_PER_CARD_WIDTH / Math.max(card.clientWidth, 1);
        store.orbitBy(-dx * radiansPerPixel, dy * radiansPerPixel);
      }
    };

    // The browser scrolls a vertical swipe by itself (touch-action: pan-y);
    // one that starts on the hologram is kept from it, to look around.
    const onTouchMove = (event: TouchEvent) => {
      if (looking && pointers.size > 0 && canDrag() && event.cancelable) event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
      const pointer = pointers.get(event.pointerId);
      pointers.delete(event.pointerId);
      if (!pointer) return;
      const wasTap = !dragging
        && pointers.size === 0
        && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) <= TAP_MAX_MOVE_PX;
      if (pointers.size === 0) {
        dragging = false;
        endFeedSwipe(true);
      }
      if (pointers.size < 2) lastPinch = 0;
      if (wasTap && triggers.tapToPause) store.togglePause();
    };

    // The browser took the touch over for scrolling; the gesture is not ours.
    const onPointerCancel = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      if (pointers.size === 0) {
        dragging = false;
        endFeedSwipe(false);
      }
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
    card.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    followWheelGestures();
    followScrolls();
    card.addEventListener("wheel", onWheel, { passive: false });
    card.addEventListener("keydown", onKeyDown);
    return () => {
      card.removeEventListener("pointerdown", onPointerDown);
      card.removeEventListener("pointermove", onPointerMove);
      card.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      card.removeEventListener("wheel", onWheel);
      card.removeEventListener("keydown", onKeyDown);
      endFeedSwipe(false);
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
