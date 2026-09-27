# IWSDK AI Development Workflow

HoloIM uses IWSDK `0.5.3` as a development layer around the existing capture
runtime. The integration provides a managed browser, IWER 2.3 XR emulation,
screenshots, console inspection, reloads, and XR input control without migrating
the application to IWSDK's ECS or native scene format.

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
`REUSE_DEV_SERVER=1` intentionally.

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

The IWSDK CLI remains a useful fallback when an MCP client is not available:

```bash
pnpm --filter @holoim/capture exec iwsdk xr status
pnpm --filter @holoim/capture exec iwsdk xr enter --input-json '{}'
pnpm --filter @holoim/capture exec iwsdk browser screenshot \
  --output-file /tmp/holoim-iwsdk.png
```

## Integration boundary

HoloIM does not instantiate `@iwsdk/core`'s `World`; it owns a custom Three.js and
Rapier runtime. `iwsdkMcpRuntime.ts` announces command readiness and declines
framework methods it does not implement. The plugin can therefore route browser
and IWER commands while native IWSDK ECS and scene-composition methods stay
unavailable instead of returning misleading results.

IWSDK 0.5.3 deduplicates browser-side Three.js imports and requires the SDK's
`super-three` r181 fork, so the workspace runtime catalog uses that same build.
HoloIM identifies loaded bones and meshes with Three.js's structural `isBone`,
`isMesh`, and `isSkinnedMesh` flags instead of constructor identity. This keeps
GLTF rig discovery reliable when the dev plugin or Vite produces more than one
module instance.

## What to adopt next

- Use the managed runtime for fast visual verification, console triage, XR session
  control, and reproducible screenshots during implementation.
- Keep the existing IWER Playwright suites as CI regression gates; the interactive
  agent loop complements them but does not replace assertions.
- Consider `@iwsdk/reference` if HoloIM begins using more IWSDK-native APIs and
  agents need indexed SDK examples.
- Evaluate MetaVR separately for physical Quest automation. It adds device access
  and native build/install requirements, so it should remain an explicit opt-in.
- Do not migrate HoloIM scenes or systems to IWSDK ECS solely to unlock editor
  methods. Treat that as an architecture decision with a concrete product need.

## Sources

- [IWSDK AI overview](https://iwsdk.dev/ai/)
- [Getting started](https://iwsdk.dev/ai/getting-started.html)
- [Development modes](https://iwsdk.dev/ai/modes.html)
- [Recommended workflows](https://iwsdk.dev/ai/workflows.html)
- [Project manifest guide](https://iwsdk.dev/guides/01a-project-manifest.html)
- [Meta announcement](https://developers.meta.com/horizon/blog/accelerate-vr-development-with-ai-and-immersive-web-sdk/)
