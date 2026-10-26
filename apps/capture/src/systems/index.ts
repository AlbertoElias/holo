import type { World } from '@iwsdk/core';
import { ScreenInputSystem } from '@holoim/xr-ui-iwsdk';
import { BodyPoseSystem } from './BodyPoseSystem';
import { CalibrationSystem } from './CalibrationSystem';
import { CameraSystem } from './CameraSystem';
import { CaptureControlSystem } from './CaptureControlSystem';
import { CaptureStateSystem } from './CaptureStateSystem';
import { CaptureUiSystem } from './CaptureUiSystem';
import { captureContext } from './captureContext';
import { CAPTURE_COMPONENTS } from './components';
import { DiagnosticsSystem } from './DiagnosticsSystem';
import { FaceSystem } from './FaceSystem';
import { MovementSystem } from './MovementSystem';
import { ObjectSystem } from './ObjectSystem';
import { RecordingSystem } from './RecordingSystem';
import { RoomScaleSystem } from './RoomScaleSystem';
import { SimulationClockSystem } from './SimulationClockSystem';
import { TrackedHandsSystem } from './TrackedHandsSystem';
import { VrLocomotionSystem } from './VrLocomotionSystem';
import { XrSessionSystem } from './XrSessionSystem';

// One simulation step, in priority order. Each system writes only what it
// owns; the order is the frame contract: input before pose math, the record
// after the final pose, the draw (FrameLoop) after simulation.
export function registerCaptureSystems(world: World): void {
  world
    .registerSystem(SimulationClockSystem, { priority: 0 })
    .registerSystem(XrSessionSystem, { priority: 10 })
    .registerSystem(VrLocomotionSystem, { priority: 15 })
    .registerSystem(RoomScaleSystem, { priority: 20 })
    .registerSystem(CalibrationSystem, { priority: 30 })
    .registerSystem(MovementSystem, { priority: 40 })
    .registerSystem(BodyPoseSystem, { priority: 50 })
    .registerSystem(CameraSystem, { priority: 60 })
    .registerSystem(TrackedHandsSystem, { priority: 70 })
    .registerSystem(ObjectSystem, { priority: 75 })
    .registerSystem(FaceSystem, { priority: 76 })
    .registerSystem(CaptureUiSystem, { priority: 80 })
    .registerSystem(RecordingSystem, { priority: 90 })
    .registerSystem(DiagnosticsSystem, { priority: 100 });
  // A phone camera author's taps arrive as screen input sources, which IWSDK's
  // own input never drives; this turns them into the pointer events the dock
  // listens to. Without the flag, phone AR is as it was.
  if (captureContext(world).config.arCameraAuthor) world.registerSystem(ScreenInputSystem, { priority: 12 });
  // Native state and controls serve IWSDK's ECS tools, which (like World's
  // MCP runtime) exist only in development builds.
  if (import.meta.env.DEV) registerNativeStateAndControls(world);
}

function registerNativeStateAndControls(world: World): void {
  const capture = world.createEntity();
  for (const component of CAPTURE_COMPONENTS) {
    world.registerComponent(component);
    capture.addComponent(component);
  }
  world
    .registerSystem(CaptureControlSystem, { priority: 5 })
    .registerSystem(CaptureStateSystem, { priority: 110 });
}
