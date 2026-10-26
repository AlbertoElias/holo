import type { Page } from 'playwright';

import type {} from '../../src/runtime/automationHooks';

// A phone for IWER (docs/features/ar-recording.md, slice 2a). IWER 2.6 has no
// phone profile, so a Playwright page that wants a handheld AR session calls
// `emulatePhone(page)` before navigation:
//   - mono view (`stereoEnabled = false`);
//   - controllers and hands disconnected;
//   - `interactionMode = 'screen-space'`. IWER 2.6 reads it only from the
//     device config at construction (`deviceConfig.interactionMode`, copied
//     into a private state object under a symbol key, and read back by
//     `XRSession.interactionMode`). There is no public setter and capture
//     does not construct the device, so this patches that private state, the
//     same way the viewer's spec does;
//   - screen taps and holds delivered as transient `screen` input sources.
// Stands in for the viewer's copy until the viewer XR interface lands and
// slice 0 lifts it into `packages/tooling-testing`; drop this file then.
//
// App-agnostic: the session comes from `IWER_DEVICE.activeSession` and the
// finger's ray is computed from the device's own head pose, so a `worldPoint`
// is a point in the space `IWER_DEVICE.position` lives in (the reference
// space of the session, `local-floor`), not in any app's scene graph.
// Frames in IWER take about 150 ms, so holds are counted in frames plus a
// wall-clock wait.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

type PhoneWindow = Window & {
  __phoneTap?: (target: Vec3) => Promise<void>;
  __phoneHold?: (target: Vec3, holdMs: number) => Promise<void>;
};

/** Makes the page's IWER device a handheld phone. Call before the page loads. */
export async function emulatePhone(page: Page): Promise<void> {
  // tsx compiles with keepNames, which wraps named inner functions of the
  // init script in an __name helper the page lacks.
  await page.addInitScript('globalThis.__name = globalThis.__name || ((target) => target);');
  await page.addInitScript(() => {
    type Space = object;
    type Device = {
      stereoEnabled: boolean;
      fovy: number;
      viewerSpace: unknown;
      position: { x: number; y: number; z: number };
      quaternion: { x: number; y: number; z: number; w: number };
      activeSession?: XRSession;
      controllers: Record<'left' | 'right', { connected: boolean; inputSource: { targetRaySpace: Space } & object }>;
      hands?: Record<'left' | 'right', { connected: boolean }>;
      inputSources: unknown[];
    };
    let deviceValue: Device | undefined;
    Object.defineProperty(window, 'IWER_DEVICE', {
      configurable: true,
      get: () => deviceValue,
      set: (device: Device) => {
        deviceValue = device;
        device.stereoEnabled = false;
        // A phone reports screen-space interaction; IWER keeps it in private device state.
        let patched = false;
        for (const key of Object.getOwnPropertySymbols(device)) {
          const state = (device as unknown as Record<symbol, { interactionMode?: string }>)[key];
          if (state && typeof state === 'object' && 'interactionMode' in state) {
            state.interactionMode = 'screen-space';
            patched = true;
          }
        }
        if (!patched) throw new Error('emulatePhone: IWER device state with interactionMode not found (IWER changed?)');
        const InputSource = device.controllers.right.inputSource.constructor as new (...args: unknown[]) => object;
        const SpaceCtor = device.controllers.right.inputSource.targetRaySpace.constructor as new (...args: unknown[]) => object;
        for (const side of ['left', 'right'] as const) {
          device.controllers[side].connected = false;
          if (device.hands?.[side]) device.hands[side].connected = false;
        }
        const screenSources: object[] = [];
        const baseGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(device), 'inputSources')!.get!;
        Object.defineProperty(device, 'inputSources', { get: () => [...(baseGetter.call(device) as unknown[]), ...screenSources] });

        const frameOf = (session: XRSession, inFrame?: (frame: XRFrame) => void) =>
          new Promise<void>((resolve) =>
            session.requestAnimationFrame((_t, frame) => {
              inFrame?.(frame);
              resolve();
            })
          );
        const sessionOf = (): XRSession => {
          const session = device.activeSession;
          if (!session) throw new Error('phone: no XR session');
          return session;
        };
        // The target in viewer space: conjugate(head rotation) applied to (target - head position).
        const toViewerSpace = (target: Vec3): Vec3 => {
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
        // The ray from the viewer through a point, as a column-major viewer-space matrix (rotation only).
        const aimAt = (target: Vec3): Float32Array => {
          const local = toViewerSpace(target);
          const length = Math.hypot(local[0], local[1], local[2]) || 1;
          const [x, y, z] = [local[0] / length, local[1] / length, local[2] / length];
          // Rotation taking -Z onto (x, y, z).
          const axis = [y, -x, 0];
          const axisLength = Math.hypot(axis[0]!, axis[1]!);
          const angle = Math.acos(Math.min(1, Math.max(-1, -z)));
          const [ax, ay] = axisLength > 1e-6 ? [axis[0]! / axisLength, axis[1]! / axisLength] : [1, 0];
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          const t = 1 - c;
          return new Float32Array([t * ax * ax + c, t * ax * ay, -s * ay, 0, t * ax * ay, t * ay * ay + c, s * ax, 0, s * ay, -s * ax, c, 0, 0, 0, 0, 1]);
        };
        // A finger mark where the finger is, so recordings show it. Projected with the device's vertical fov.
        const fingerMark = (): ((target: Vec3) => void) & { remove(): void } => {
          const mark = document.createElement('div');
          mark.dataset.phoneTap = '';
          mark.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #ffffff;background:rgb(255 255 255 / 40%)';
          document.body.append(mark);
          const move = (target: Vec3) => {
            const [x, y, z] = toViewerSpace(target);
            if (z >= 0) return;
            const tan = Math.tan(device.fovy / 2);
            const ndcX = x / -z / (tan * (innerWidth / innerHeight));
            const ndcY = y / -z / tan;
            mark.style.left = `${((ndcX + 1) / 2) * innerWidth}px`;
            mark.style.top = `${((1 - ndcY) / 2) * innerHeight}px`;
          };
          return Object.assign(move, { remove: () => setTimeout(() => mark.remove(), 600) });
        };
        const EventCtor = (globalThis as { XRInputSourceEvent?: new (type: string, init: object) => Event }).XRInputSourceEvent;
        /** A finger down toward `path[0]`, held while it moves along `path` (one point per frame), then lifted. */
        const press = async (path: Vec3[], holdMs: number) => {
          const session = sessionOf();
          if (!EventCtor) throw new Error('phone: XRInputSourceEvent unavailable');
          const mark = fingerMark();
          mark(path[0]!);
          const space = new SpaceCtor(device.viewerSpace, aimAt(path[0]!));
          const state = Object.getOwnPropertySymbols(space)
            .map((key) => (space as Record<symbol, { offsetMatrix?: Float32Array }>)[key])
            .find((value) => value?.offsetMatrix)!;
          const source = new InputSource('none', 'screen', ['generic-touchscreen', 'generic-button'], space);
          screenSources.push(source);
          await frameOf(session);
          await frameOf(session, (frame) => session.dispatchEvent(new EventCtor('selectstart', { frame, inputSource: source })));
          for (const point of path.slice(1)) {
            // The finger moves: the source's target ray follows it, frame by frame.
            await frameOf(session, () => {
              state.offsetMatrix!.set(aimAt(point));
              mark(point);
            });
          }
          // The ray keeps tracking the first point while held, so a camera that walks still points the finger at it.
          const until = performance.now() + holdMs;
          while (performance.now() < until) {
            await frameOf(session, () => {
              state.offsetMatrix!.set(aimAt(path[path.length - 1]!));
              mark(path[path.length - 1]!);
            });
          }
          await frameOf(session, (frame) => {
            session.dispatchEvent(new EventCtor('select', { frame, inputSource: source }));
            session.dispatchEvent(new EventCtor('selectend', { frame, inputSource: source }));
          });
          screenSources.splice(screenSources.indexOf(source), 1);
          mark.remove();
          await frameOf(session);
        };
        const phone = window as unknown as PhoneWindow;
        // A tap toward a point, released on the next frame: a press longer than 300 ms counts as no click.
        phone.__phoneTap = (target) => press([target], 0);
        // A hold toward a point for `holdMs` of wall-clock time, frame by frame (the ray follows the moving head).
        phone.__phoneHold = (target, holdMs) => press([target], holdMs);
      }
    });
  });
}

/** One-frame tap with a transient `screen` source aimed at a point (reference-space coordinates). */
export function phoneTap(page: Page, point: Vec3): Promise<void> {
  return page.evaluate((target) => (window as PhoneWindow).__phoneTap!(target), point);
}

/** A touch held on a point for `ms` of wall-clock time, then lifted. Frames advance while held. */
export function phoneHold(page: Page, point: Vec3, ms: number): Promise<void> {
  return page.evaluate(([target, holdMs]) => (window as PhoneWindow).__phoneHold!(target as Vec3, holdMs as number), [point, ms] as const);
}

/** Sets the emulated phone's head pose in the session's reference space (`local-floor`). */
export function setHeadPose(page: Page, position: Vec3, quaternion: Quat): Promise<void> {
  return page.evaluate(
    ([p, q]) => {
      const device = window.IWER_DEVICE!;
      device.position.set(p[0], p[1], p[2]);
      device.quaternion.set(q[0], q[1], q[2], q[3]);
    },
    [position, quaternion] as const
  );
}
