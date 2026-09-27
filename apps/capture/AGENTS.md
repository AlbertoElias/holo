# Capture app

This WebXR runtime records avatar motion and exports GLTF for the viewer pipeline.
Use the shared workspace guide in `../../AGENTS.md`. Read `../../AGENT_CONTRACT.md`
for command and validation choices, and `../../docs/IWSDK_AI_WORKFLOW.md` when working
with the managed XR runtime or emulator.

Implementation areas: `src/xr` handles sessions and input, `src/recording` handles
capture and export, `src/physics` handles locomotion, and `src/ui` handles controls.
Preserve the export/upload/render contract and automation debug hooks unless intentionally
versioned. Validate contract changes with the workspace smoke pipeline.
