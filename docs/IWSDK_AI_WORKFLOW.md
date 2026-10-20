# IWSDK AI Development Workflow

Capture runs on IWSDK `1.0.1`: World owns the scene, renderer, XR session
lifecycle and ECS, and capture's behavior runs as ordered ECS systems. The dev
integration adds a managed browser, IWER 2.6 XR emulation, screenshots, console
inspection, reloads, XR input control, and native ECS inspection and control of
capture's real simulation. Capture does not use IWSDK's native scene format.

## Start a session

From the workspace root:

```bash
# Shared visible browser for a developer and an agent
pnpm run dev:capture:ai

# Headless 640 x 640 browser for autonomous agent work
pnpm run dev:capture:agent

# Inspect or stop the managed runtime
pnpm run dev:capture:status
pnpm run dev:capture:down
```

The managed capture runtime uses `https://127.0.0.1:5174`. Do not run the
deterministic capture XR suite against that port at the same time unless using
`REUSE_DEV_SERVER=1` intentionally. A second worktree can run its own managed
runtime on another port with `CAPTURE_RUNTIME_PORT=<port>` (the `dev:runtime`
script reads it); drive it with that checkout's CLI, since the project MCP
server is bound to the main checkout.

The IWSDK runtime MCP server is launched by `scripts/mcp/iwsdk-runtime.sh` from
`apps/capture` and registered for both agents: `.codex/config.toml` for Codex and
`.mcp.json` for Claude Code. Start a new agent session after pulling or installing
this change so the project MCP configuration reloads; Claude Code asks once to
approve the project server. MCP tool calls continue to use each agent's normal
approval policy.

## Recommended loop

1. Start `dev:capture:ai` for paired work or `dev:capture:agent` for headless work.
2. Check runtime and XR state before editing.
3. Make a localized change, reload the managed page, and inspect console errors.
4. Capture a screenshot and exercise the relevant XR session, headset, controller,
   or hand state.
5. Run `pnpm --filter @holoim/capture run verify:fast`.
6. For XR behavior, run `pnpm run test:xr:capture` as the deterministic gate.
7. Record what the emulated run proves separately from physical-headset results.

The IWSDK CLI exposes the same tools when an MCP client is not available:

```bash
pnpm --filter @holoim/capture exec iwsdk xr status
pnpm --filter @holoim/capture exec iwsdk xr enter --input-json '{}'
pnpm --filter @holoim/capture exec iwsdk browser screenshot \
  --output-file /tmp/holoim-iwsdk.png
pnpm --filter @holoim/capture exec iwsdk ecs systems
```

## Inspecting and driving capture through ECS

In development builds one `capture` entity carries capture's domain state as
native components, published after every simulation step:

| Component | Fields |
| --- | --- |
| `CaptureSimulation` | `steps`, `elapsedSec`, `clockMode`, `appMode`, `xrSession` |
| `CaptureCharacter` | `x`, `y`, `z`, `grounded`, `horizontalSpeed`, `locomotion`, `crouch` |
| `CaptureBody` | `active`, `headTracked`, `aligned`, `translating`, `turning`, `bodyYaw`, `steps`, `leftHandSource`, `rightHandSource` |
| `CaptureHeightFit` | `eyeHeight` (-1 before a fit), `avatarScale`, `refitPending`, `sizeLocked`, control `refitRequested`, result `refitResult` |
| `CaptureRecording` | `state`, `frames`, `lastFrameSec`, control `toggleRequested` |

Find it with `ecs find --input-json '{"withComponents":["CaptureSimulation"]}'`
and read it with `ecs query`. Set a control with `ecs set-component` (for
example `CaptureHeightFit.refitRequested = true`); it is applied before the
next step with the same rules as the UI. `ecs pause`, `ecs step`,
`ecs snapshot`/`ecs diff` and `ecs toggle-system` act on the real simulation:
pausing freezes simulation time and recording samples, and one step advances
them once. Use `ecs step` with the default realtime clock; the deterministic
`?manualClock=1` / `advanceTime` hooks are a separate clock mode, and
`advanceTime` throws while the debugger holds the simulation. See
[the CLI transcript](evidence/iwsdk-runtime-refactor/ecs-cli-transcript.md).

Recording in a VR session saves the raw headset input under
`apps/capture/fixtures/input-recordings/`; delete emulator recordings made while
exercising controls, or the hand replay check will pick them up.

## Integration boundary

`apps/capture/src/runtime/` composes World and capture; `src/systems/` holds the
ordered systems (see the frame contract in
[the refactor brief](features/iwsdk-runtime-refactor.md)). Deliberate
boundaries with the SDK:

- Capture's frame loop replaces World's built-in loop (one `world.update` per
  simulation step, then one draw or matrix-only present), so device input is
  read before simulation and deterministic replay can skip draws.
- SDK input, audio, environment and light systems are unregistered; World's
  locomotion, physics, grabbing and spatial UI are off. Capture reads three's
  controllers and hands, simulates with Rapier, and records audio with
  MediaRecorder.
- Capture's camera rig, cameras, world group and avatar are plain three objects,
  never ECS transform entities, whose transforms IWSDK stores as float32.
- Production builds give UIKitML empty component kits and a two-icon lucide
  subset (`vite.config.ts`); capture never renders UIKitML.

IWSDK requires the SDK's `super-three` r181 fork, which the workspace runtime
catalog uses. HoloIM identifies loaded bones and meshes with Three.js's
structural `isBone`, `isMesh`, and `isSkinnedMesh` flags instead of constructor
identity, which keeps GLTF rig discovery reliable when Vite produces more than
one module instance.

## What to adopt next

- Use the managed runtime for fast visual verification, console triage, XR session
  control, and reproducible screenshots during implementation.
- Keep the existing IWER Playwright suites as CI regression gates; the interactive
  agent loop complements them but does not replace assertions.
- Consider `@iwsdk/reference` if HoloIM begins using more IWSDK-native APIs and
  agents need indexed SDK examples.
- Evaluate MetaVR separately for physical Quest automation. It adds device access
  and native build/install requirements, so it should remain an explicit opt-in.
  Wiring is in place (see "Physical Quest automation (MetaVR)" below); the
  evaluation continues against real-device evidence.
- Do not migrate HoloIM scenes to IWSDK's native scene format solely to unlock
  editor methods. Treat that as an architecture decision with a concrete product need.

## Physical Quest automation (MetaVR)

MetaVR (`@meta-quest/metavr`) is the explicit opt-in path for real-device
evidence: Quest device management, launching the app on a USB-connected
headset, screenshots, frame-rate profiling from the device, and logs.
It is registered as the `metavr` MCP server for both agents via
`scripts/mcp/metavr.sh`; start a new agent session after pulling so the
project MCP configuration reloads. No default script, test, or CI job
invokes it, and it is not a workspace dependency — its install downloads
a native binary from Meta's CDN.

Host setup (once, from a normal terminal):

```bash
# User-writable prefix: the system npm prefix (/usr/local) is root-owned.
npm install -g --prefix "$HOME/.local" @meta-quest/metavr
export PATH="$HOME/.local/bin:$PATH" # add to your shell profile
# Enable Developer Mode for the headset in the Meta Horizon phone app,
# connect a USB-C data cable, then put the headset on once and accept
# the "Allow USB debugging" prompt.
```

After that one-time accept, the headset can sit on a desk: an agent can
launch capture on the device, capture screenshots and performance
profiles, and read logs without anyone wearing it. What still needs a
person is hand tracking with hands moving in front of the cameras,
controller↔hand switching, and comfort or tracking feel — keep those on
the physical-headset checklist in `TODOS.md` and report them separately
from IWER and MetaVR-automated evidence.

## Sources

- [IWSDK AI overview](https://iwsdk.dev/ai/)
- [Getting started](https://iwsdk.dev/ai/getting-started.html)
- [Development modes](https://iwsdk.dev/ai/modes.html)
- [Recommended workflows](https://iwsdk.dev/ai/workflows.html)
- [Project manifest guide](https://iwsdk.dev/guides/01a-project-manifest.html)
- [Meta announcement](https://developers.meta.com/horizon/blog/accelerate-vr-development-with-ai-and-immersive-web-sdk/)
