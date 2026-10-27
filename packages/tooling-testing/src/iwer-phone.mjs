// A phone for IWER (docs/features/archive/ar-recording.md, slice 0). IWER 2.x has no
// phone profile, so a Playwright page that wants a handheld AR session calls
// `emulatePhone(page)` before navigation:
//   - mono view (`stereoEnabled = false`);
//   - controllers and hands disconnected;
//   - `interactionMode = 'screen-space'`, or unset. IWER reads it only from
//     the device config at construction (`deviceConfig.interactionMode`,
//     copied into a private state object under a symbol key, and read back by
//     `XRSession.interactionMode`). There is no public setter and the apps do
//     not construct the device, so this patches that private state;
//   - screen taps, holds, drags and pinches delivered as transient `screen`
//     input sources inside XR frames. The event's frame is the spec's: its
//     `getViewerPose` throws (InvalidStateError), as on any frame that is not
//     an animation frame, so an app that calls it from a touch handler fails;
//   - two faults an app must survive, off until asked for: a view rotated
//     against the viewer (`phoneViewOffset`) and a viewer space with no pose
//     relations (`phoneViewerSpaceUnavailable`).
//
// App-agnostic: the session comes from `IWER_DEVICE.activeSession` and the
// finger's ray is computed from the device's own head pose and vertical fov,
// so a point is a point in the space `IWER_DEVICE.position` lives in (the
// session's reference space), which is the app's world while its XR rig sits
// at the origin. Frames in IWER take about 150 ms, so holds are counted in
// frames plus a wall-clock wait.

/**
 * Makes the page's IWER device a handheld phone. Call before the page loads.
 * `interactionMode: 'unset'` leaves the mode undefined, as Chrome on Android
 * may, to check that an unknown device is never taken for a phone.
 */
export async function emulatePhone(page, options = {}) {
  // tsx compiles with keepNames, which wraps named inner functions of the
  // init script in an __name helper the page lacks.
  await page.addInitScript('globalThis.__name = globalThis.__name || ((target) => target);');
  await page.addInitScript((interactionMode) => {
    let deviceValue;
    // WebXR faults for the phone, installed once per page and inert until `phoneViewOffset`,
    // `phoneViewerSpaceUnavailable` or `phoneTargetRayLost` turns them on.
    function patchWebXr() {
      if (globalThis.__phoneWebXrPatched) return;
      globalThis.__phoneWebXrPatched = true;
      const viewerSpaces = new WeakSet();
      const requestReferenceSpace = XRSession.prototype.requestReferenceSpace;
      XRSession.prototype.requestReferenceSpace = function (type) {
        return requestReferenceSpace.call(this, type).then((space) => {
          if (type === 'viewer') viewerSpaces.add(space);
          return space;
        });
      };
      // The spec lets getPose return null when a relation cannot be determined.
      const getPose = XRFrame.prototype.getPose;
      XRFrame.prototype.getPose = function (space, baseSpace) {
        if (globalThis.__phoneViewerSpaceUnavailable && viewerSpaces.has(baseSpace)) return null;
        if (globalThis.__phoneTargetRayLost && !viewerSpaces.has(baseSpace)) {
          for (const source of this.session.inputSources) if (source.targetRaySpace === space) return null;
        }
        return getPose.call(this, space, baseSpace);
      };
      // The spec lets a view sit rotated against the viewer: each view's transform is the viewer's turned by
      // the offset about the view's own up axis, with its projection and viewport unchanged.
      const getViewerPose = XRFrame.prototype.getViewerPose;
      XRFrame.prototype.getViewerPose = function (space) {
        const pose = getViewerPose.call(this, space);
        const yawDeg = globalThis.__phoneViewYawDeg;
        if (!pose || !yawDeg) return pose;
        const half = (yawDeg * Math.PI) / 360;
        const b = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
        for (const view of pose.views) {
          const { position: p, orientation: a } = view.transform;
          const turned = {
            x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
          };
          const transform = new XRRigidTransform({ x: p.x, y: p.y, z: p.z, w: 1 }, turned);
          Object.defineProperty(view, 'transform', { value: transform, configurable: true });
        }
        return pose;
      };
    }
    Object.defineProperty(window, 'IWER_DEVICE', {
      configurable: true,
      get: () => deviceValue,
      set: (device) => {
        deviceValue = device;
        device.stereoEnabled = false;
        // A phone reports screen-space interaction; IWER keeps it in private device state.
        let patched = false;
        for (const key of Object.getOwnPropertySymbols(device)) {
          const state = device[key];
          if (state && typeof state === 'object' && 'interactionMode' in state) {
            state.interactionMode = interactionMode === 'unset' ? undefined : 'screen-space';
            patched = true;
          }
        }
        if (!patched) throw new Error('emulatePhone: IWER device state with interactionMode not found (IWER changed?)');
        const InputSource = device.controllers.right.inputSource.constructor;
        const SpaceCtor = device.controllers.right.inputSource.targetRaySpace.constructor;
        for (const side of ['left', 'right']) {
          device.controllers[side].connected = false;
          if (device.hands?.[side]) device.hands[side].connected = false;
        }
        const screenSources = [];
        patchWebXr();
        const baseGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(device), 'inputSources').get;
        Object.defineProperty(device, 'inputSources', { get: () => [...baseGetter.call(device), ...screenSources] });

        // The frame a touch event carries: everything of the animation frame, except `getViewerPose`, which the
        // spec refuses on a frame that is not passed to a requestAnimationFrame callback. (IWER keeps the real
        // frame's private state behind its methods, so they are bound to it.)
        const eventFrame = (frame) =>
          new Proxy(frame, {
            get(target, key) {
              if (key === 'getViewerPose') {
                return () => {
                  throw new DOMException('getViewerPose can only be called on XRFrame objects passed to XRSession.requestAnimationFrame callbacks.', 'InvalidStateError');
                };
              }
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            }
          });
        const touchEvent = (type, frame, source) => new EventCtor(type, { frame: eventFrame(frame), inputSource: source });

        const frameOf = (session, inFrame) =>
          new Promise((resolve) =>
            session.requestAnimationFrame((_t, frame) => {
              inFrame?.(frame);
              resolve();
            })
          );
        const sessionOf = () => {
          const session = device.activeSession;
          if (!session) throw new Error('phone: no XR session');
          return session;
        };
        // A point in viewer space: conjugate(head rotation) applied to (point - head position).
        const toViewerSpace = (target) => {
          const dx = target[0] - device.position.x;
          const dy = target[1] - device.position.y;
          const dz = target[2] - device.position.z;
          const { x: qx, y: qy, z: qz, w: qw } = device.quaternion;
          // v' = q^-1 * v * q, with q^-1 = (-x, -y, -z, w) for a unit quaternion.
          const ix = qw * dx - qy * dz + qz * dy;
          const iy = qw * dy - qz * dx + qx * dz;
          const iz = qw * dz - qx * dy + qy * dx;
          const iw = qx * dx + qy * dy + qz * dz;
          return [ix * qw + iw * qx + iy * qz - iz * qy, iy * qw + iw * qy + iz * qx - ix * qz, iz * qw + iw * qz + ix * qy - iy * qx];
        };
        // The inverse of the above: a viewer-space point back in the reference space.
        const fromViewerSpace = (local) => {
          const { x: qx, y: qy, z: qz, w: qw } = device.quaternion;
          // v' = q * v * q^-1.
          const ix = qw * local[0] + qy * local[2] - qz * local[1];
          const iy = qw * local[1] + qz * local[0] - qx * local[2];
          const iz = qw * local[2] + qx * local[1] - qy * local[0];
          const iw = -qx * local[0] - qy * local[1] - qz * local[2];
          return [
            ix * qw + iw * -qx + iy * -qz - iz * -qy + device.position.x,
            iy * qw + iw * -qy + iz * -qx - ix * -qz + device.position.y,
            iz * qw + iw * -qz + ix * -qy - iy * -qx + device.position.z
          ];
        };
        // The ray from the viewer through a point, as a column-major viewer-space matrix (rotation only).
        const aimAt = (target) => {
          const local = toViewerSpace(target);
          const length = Math.hypot(local[0], local[1], local[2]) || 1;
          const [x, y, z] = [local[0] / length, local[1] / length, local[2] / length];
          // Rotation taking -Z onto (x, y, z).
          const axis = [y, -x, 0];
          const axisLength = Math.hypot(axis[0], axis[1]);
          const angle = Math.acos(Math.min(1, Math.max(-1, -z)));
          const [ax, ay] = axisLength > 1e-6 ? [axis[0] / axisLength, axis[1] / axisLength] : [1, 0];
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          const t = 1 - c;
          return new Float32Array([t * ax * ax + c, t * ax * ay, -s * ay, 0, t * ax * ay, t * ay * ay + c, s * ax, 0, s * ay, -s * ax, c, 0, 0, 0, 0, 1]);
        };
        // The device's vertical fov and the page's aspect give the screen mapping.
        const tanHalf = () => Math.tan(device.fovy / 2);
        // A finger mark where the finger is, so recordings show it.
        const fingerMark = () => {
          const mark = document.createElement('div');
          mark.dataset.phoneTap = '';
          mark.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #ffffff;background:rgb(255 255 255 / 40%)';
          document.body.append(mark);
          const move = (target) => {
            const [x, y, z] = toViewerSpace(target);
            if (z >= 0) return;
            const tan = tanHalf();
            const ndcX = x / -z / (tan * (innerWidth / innerHeight));
            const ndcY = y / -z / tan;
            mark.style.left = `${((ndcX + 1) / 2) * innerWidth}px`;
            mark.style.top = `${((1 - ndcY) / 2) * innerHeight}px`;
          };
          return Object.assign(move, { remove: () => setTimeout(() => mark.remove(), 600) });
        };
        const EventCtor = globalThis.XRInputSourceEvent;
        const newFinger = (point) => {
          const space = new SpaceCtor(device.viewerSpace, aimAt(point));
          const state = Object.getOwnPropertySymbols(space)
            .map((key) => space[key])
            .find((value) => value?.offsetMatrix);
          const source = new InputSource('none', 'screen', ['generic-touchscreen', 'generic-button'], space);
          const mark = fingerMark();
          mark(point);
          return {
            source,
            move(next) {
              state.offsetMatrix.set(aimAt(next));
              mark(next);
            },
            remove: () => mark.remove()
          };
        };
        /**
         * A finger down toward `path[0]`, held while it moves along `path` (one point per frame), then lifted.
         * With `screenLocked` the finger stays at the screen position it went down on while the head moves
         * (walking or turning with a finger on the glass); otherwise it follows the point in the room.
         */
        const press = async (path, holdMs, screenLocked = false) => {
          const session = sessionOf();
          if (!EventCtor) throw new Error('phone: XRInputSourceEvent unavailable');
          const finger = newFinger(path[0]);
          const lockedAt = screenLocked ? toViewerSpace(path[0]) : null;
          const place = (point) => (lockedAt ? fromViewerSpace(lockedAt) : point);
          screenSources.push(finger.source);
          const lift = (frame) => {
            session.dispatchEvent(touchEvent('select', frame, finger.source));
            session.dispatchEvent(touchEvent('selectend', frame, finger.source));
          };
          // A tap is down and up between two frames: one emulated frame can outlast pointer-events' 300 ms click.
          const tap = path.length === 1 && holdMs === 0;
          await frameOf(session);
          await frameOf(session, (frame) => {
            session.dispatchEvent(touchEvent('selectstart', frame, finger.source));
            if (tap) lift(frame);
          });
          for (const point of path.slice(1)) {
            // The finger moves: the source's target ray follows it, frame by frame.
            await frameOf(session, () => finger.move(place(point)));
          }
          // The ray keeps tracking the last point while held, so a camera that walks still points the finger at it.
          const until = performance.now() + holdMs;
          while (performance.now() < until) await frameOf(session, () => finger.move(place(path[path.length - 1])));
          if (!tap) await frameOf(session, lift);
          screenSources.splice(screenSources.indexOf(finger.source), 1);
          finger.remove();
          await frameOf(session);
        };
        // Two fingers either side of a point, `fromPx` then `toPx` apart on the screen over `frames` frames.
        const pinch = async (centre, fromPx, toPx, frames) => {
          const session = sessionOf();
          if (!EventCtor) throw new Error('phone: XRInputSourceEvent unavailable');
          // A point `side * spreadPx / 2` CSS px from the centre's screen position, at the centre's depth.
          const [cx, cy, cz] = toViewerSpace(centre);
          const at = (spreadPx, side) => {
            const tan = tanHalf();
            const dx = ((side * spreadPx) / 2 / (innerWidth / 2)) * (-cz * tan * (innerWidth / innerHeight));
            return fromViewerSpace([cx + dx, cy, cz]);
          };
          const fingers = [1, -1].map((side) => ({ side, ...newFinger(at(fromPx, side)) }));
          for (const finger of fingers) {
            screenSources.push(finger.source);
            await frameOf(session);
            await frameOf(session, (frame) => session.dispatchEvent(touchEvent('selectstart', frame, finger.source)));
          }
          for (let i = 1; i <= frames; i++) {
            const spread = fromPx + (toPx - fromPx) * (i / frames);
            await frameOf(session, () => {
              for (const finger of fingers) finger.move(at(spread, finger.side));
            });
          }
          for (const finger of fingers) {
            await frameOf(session, (frame) => session.dispatchEvent(touchEvent('selectend', frame, finger.source)));
            screenSources.splice(screenSources.indexOf(finger.source), 1);
            finger.remove();
          }
          await frameOf(session);
        };
        // One finger that the caller moves between frames by hand, for what `press` cannot do: touch down, move
        // before the simulation steps, and lift later. A frame passes at each call.
        let held = null;
        const fingerDown = async (point, headPose) => {
          const session = sessionOf();
          if (!EventCtor) throw new Error('phone: XRInputSourceEvent unavailable');
          if (held) throw new Error('phone: a finger is already down');
          const finger = newFinger(point);
          held = finger;
          screenSources.push(finger.source);
          if (!headPose) {
            await frameOf(session);
            await frameOf(session, (frame) => session.dispatchEvent(touchEvent('selectstart', frame, finger.source)));
            return;
          }
          // The touch lands in the frame after the head moved, before the app's callback for that frame has drawn it, as
          // a browser delivers input ahead of the next animation frame: the event's poses are the new ones and the app's
          // camera still holds the last drawn frame's. The app's next callback is held up behind the touch.
          const original = session.requestAnimationFrame;
          let landing = null;
          let landed;
          const touched = new Promise((resolve) => (landed = resolve));
          session.requestAnimationFrame = function (callback) {
            return original.call(this, (time, frame) => {
              if (landing) {
                const land = landing;
                landing = null;
                session.requestAnimationFrame = original;
                land(frame);
              }
              callback(time, frame);
            });
          };
          await frameOf(session, () => {
            device.position.set(...headPose.position);
            device.quaternion.set(...headPose.quaternion);
            landing = (frame) => {
              session.dispatchEvent(touchEvent('selectstart', frame, finger.source));
              landed();
            };
          });
          await touched;
          await frameOf(session);
        };
        const fingerMove = async (point) => {
          if (!held) throw new Error('phone: no finger is down');
          const finger = held;
          await frameOf(sessionOf(), () => finger.move(point));
        };
        const fingerUp = async () => {
          if (!held) throw new Error('phone: no finger is down');
          const session = sessionOf();
          const finger = held;
          held = null;
          await frameOf(session, (frame) => {
            session.dispatchEvent(touchEvent('select', frame, finger.source));
            session.dispatchEvent(touchEvent('selectend', frame, finger.source));
          });
          screenSources.splice(screenSources.indexOf(finger.source), 1);
          finger.remove();
          await frameOf(session);
        };
        const phone = window;
        phone.__phoneFingerDown = fingerDown;
        phone.__phoneFingerMove = fingerMove;
        phone.__phoneFingerUp = fingerUp;
        // A tap toward a point, lifted within the frame it lands on.
        phone.__phoneTap = (target) => press([target], 0);
        // A hold toward a point for `holdMs` of wall-clock time, frame by frame (the ray follows the moving head).
        phone.__phoneHold = (target, holdMs, screenLocked) => press([target], holdMs, screenLocked);
        // The room point `distance` m along the ray through a CSS px position of the screen, from the head as it is now.
        phone.__phoneScreenPoint = (x, y, distance) => {
          const tan = tanHalf();
          const ndcX = (x / innerWidth) * 2 - 1;
          const ndcY = 1 - (y / innerHeight) * 2;
          return fromViewerSpace([ndcX * tan * (innerWidth / innerHeight) * distance, ndcY * tan * distance, -distance]);
        };
        // A held drag from one point to another over `frames` frames.
        phone.__phoneDrag = (from, to, frames, holdMs) =>
          press(
            Array.from({ length: frames + 1 }, (_, i) => from.map((v, k) => v + (to[k] - v) * (i / frames))),
            holdMs
          );
        phone.__phonePinch = pinch;
      }
    });
  }, options.interactionMode ?? 'screen-space');
}

/** One-frame tap with a transient `screen` source aimed at a point (reference-space coordinates). */
export function phoneTap(page, point) {
  return page.evaluate((target) => window.__phoneTap(target), point);
}

/**
 * A touch held on a point for `ms` of wall-clock time, then lifted. Frames advance while held, and the
 * finger follows the point as the head moves. With `screenLocked` it stays where it went down on the
 * screen instead (a finger on the glass while the phone walks or turns).
 */
export function phoneHold(page, point, ms, options = {}) {
  return page.evaluate(([target, holdMs, locked]) => window.__phoneHold(target, holdMs, locked), [point, ms, options.screenLocked === true]);
}

/**
 * One finger moved by hand: `phoneFingerDown` puts it down on a point, `phoneFingerMove` moves it (one frame
 * each), `phoneFingerUp` lifts it. Frames pass, the simulation does not step; the caller steps it when it
 * wants the finger judged (a drag that finishes before the first step). With `headPose` the head moves to it
 * inside the touch's own frame, after the app has taken that frame's camera: the touch event carries the new
 * viewer pose while the app's camera still holds the old one (a phone turning as the finger lands).
 */
export function phoneFingerDown(page, point, options = {}) {
  return page.evaluate(([target, headPose]) => window.__phoneFingerDown(target, headPose), [point, options.headPose ?? null]);
}
export function phoneFingerMove(page, point) {
  return page.evaluate((target) => window.__phoneFingerMove(target), point);
}
export function phoneFingerUp(page) {
  return page.evaluate(() => window.__phoneFingerUp());
}

/**
 * The room point `distance` m along the ray through a CSS px position on the screen, for the head
 * as it is now: where to put a finger that starts on a screen position (the dock, a chip).
 */
export function phoneScreenPoint(page, x, y, distance = 1.5) {
  return page.evaluate(([px, py, d]) => window.__phoneScreenPoint(px, py, d), [x, y, distance]);
}

/**
 * A touch that goes down on `from`, moves to `to` over `frames` frames, holds
 * there for `holdMs` (default 100) and lifts.
 */
export function phoneDrag(page, from, to, frames, holdMs = 100) {
  return page.evaluate(([f, t, n, ms]) => window.__phoneDrag(f, t, n, ms), [from, to, frames, holdMs]);
}

/**
 * Two fingers either side of `centre`, `fromPx` then `toPx` apart in CSS px on
 * the screen, moving over `frames` frames, then lifted.
 */
export function phonePinch(page, centre, fromPx, toPx, frames) {
  return page.evaluate(([c, f, t, n]) => window.__phonePinch(c, f, t, n), [centre, fromPx, toPx, frames]);
}

/** Sets the emulated phone's head pose in the session's reference space. */
export function setHeadPose(page, position, quaternion) {
  return page.evaluate(
    ([p, q]) => {
      const device = window.IWER_DEVICE;
      device.position.set(p[0], p[1], p[2]);
      device.quaternion.set(q[0], q[1], q[2], q[3]);
    },
    [position, quaternion]
  );
}

/**
 * Turns every XR view `yawDeg` degrees about its own up axis against the viewer pose (0 clears it), as a
 * runtime may place a view: the app's render camera then points elsewhere than the viewer, while the
 * touch rays stay in viewer space. Takes effect from the next frame.
 */
export function phoneViewOffset(page, yawDeg) {
  return page.evaluate((deg) => {
    globalThis.__phoneViewYawDeg = deg;
  }, yawDeg);
}

/**
 * While on, `getPose` against a viewer reference space returns null, as a runtime may before it can relate
 * the two (and as a viewer space that never resolved would leave an app without one). Needs the session to
 * have started after `emulatePhone`.
 */
export function phoneViewerSpaceUnavailable(page, unavailable) {
  return page.evaluate((flag) => {
    globalThis.__phoneViewerSpaceUnavailable = flag;
  }, unavailable);
}

/**
 * While on, `getPose` of an input source's target-ray space returns null against any space but a viewer
 * reference space (the touchdown's viewer-local direction still resolves), as a runtime may for a frame in
 * which it cannot place the finger. Needs the session to have started after `emulatePhone`.
 */
export function phoneTargetRayLost(page, lost) {
  return page.evaluate((flag) => {
    globalThis.__phoneTargetRayLost = flag;
  }, lost);
}
