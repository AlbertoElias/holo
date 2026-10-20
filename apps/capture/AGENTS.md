# Capture app

This WebXR runtime records avatar motion and exports GLTF for the viewer pipeline.
Use the shared workspace guide in `../../AGENTS.md`. Read `../../AGENT_CONTRACT.md`
for command and validation choices, and `../../docs/IWSDK_AI_WORKFLOW.md` when working
with the managed XR runtime or emulator.

Implementation areas: `src/runtime` composes IWSDK's World with capture (stage,
XR entry, the single frame loop and clock modes, automation hooks), and
`src/systems` runs one simulation step as ordered ECS systems over typed
services. `src/xr` handles tracking, hands and height fit, `src/body` the
room-scale body and crouch, `src/physics` locomotion, `src/recording` capture
and export, and `src/ui` controls. Keep one writer per transform; the system
order in `src/systems/index.ts` is the frame contract.
Preserve the export/upload/render contract and automation debug hooks unless intentionally
versioned. Validate contract changes with the workspace smoke pipeline.
