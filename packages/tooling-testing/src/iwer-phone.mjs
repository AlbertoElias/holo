// A phone for IWER (docs/features/ar-recording.md, slice 0). IWER 2.x has no
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
//     input sources inside XR frames.
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
        const baseGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(device), 'inputSources').get;
        Object.defineProperty(device, 'inputSources', { get: () => [...baseGetter.call(device), ...screenSources] });

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
        /** A finger down toward `path[0]`, held while it moves along `path` (one point per frame), then lifted. */
        const press = async (path, holdMs) => {
          const session = sessionOf();
          if (!EventCtor) throw new Error('phone: XRInputSourceEvent unavailable');
          const finger = newFinger(path[0]);
          screenSources.push(finger.source);
          await frameOf(session);
          await frameOf(session, (frame) => session.dispatchEvent(new EventCtor('selectstart', { frame, inputSource: finger.source })));
          for (const point of path.slice(1)) {
            // The finger moves: the source's target ray follows it, frame by frame.
            await frameOf(session, () => finger.move(point));
          }
          // The ray keeps tracking the last point while held, so a camera that walks still points the finger at it.
          const until = performance.now() + holdMs;
          while (performance.now() < until) await frameOf(session, () => finger.move(path[path.length - 1]));
          await frameOf(session, (frame) => {
            session.dispatchEvent(new EventCtor('select', { frame, inputSource: finger.source }));
            session.dispatchEvent(new EventCtor('selectend', { frame, inputSource: finger.source }));
          });
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
            await frameOf(session, (frame) => session.dispatchEvent(new EventCtor('selectstart', { frame, inputSource: finger.source })));
          }
          for (let i = 1; i <= frames; i++) {
            const spread = fromPx + (toPx - fromPx) * (i / frames);
            await frameOf(session, () => {
              for (const finger of fingers) finger.move(at(spread, finger.side));
            });
          }
          for (const finger of fingers) {
            await frameOf(session, (frame) => session.dispatchEvent(new EventCtor('selectend', { frame, inputSource: finger.source })));
            screenSources.splice(screenSources.indexOf(finger.source), 1);
            finger.remove();
          }
          await frameOf(session);
        };
        const phone = window;
        // A tap toward a point, released on the next frame: emulated frames take ~150 ms, and
        // pointer-events counts a press longer than 300 ms as no click.
        phone.__phoneTap = (target) => press([target], 0);
        // A hold toward a point for `holdMs` of wall-clock time, frame by frame (the ray follows the moving head).
        phone.__phoneHold = (target, holdMs) => press([target], holdMs);
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

/** A touch held on a point for `ms` of wall-clock time, then lifted. Frames advance while held. */
export function phoneHold(page, point, ms) {
  return page.evaluate(([target, holdMs]) => window.__phoneHold(target, holdMs), [point, ms]);
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
