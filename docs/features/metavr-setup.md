# Feature brief: MetaVR setup for physical Quest automation

**Lead:** Muse (quartz-orbit)
**Status:** Verifying

## User outcome

An agent can run capture on a USB-connected physical Quest, pull
screenshots and frame-rate profiles, and read device logs — without the
user wearing the headset beyond a one-time setup — while MetaVR stays
an explicit opt-in that no default workflow depends on.

## Scope

**Included:** `scripts/mcp/metavr.sh` launcher; registration as `metavr`
in `.mcp.json` and `.codex/config.toml` per the repo's MCP rule;
operator setup steps in `docs/IWSDK_AI_WORKFLOW.md`; `TODOS.md` item
checked off when wiring lands.
**Excluded:** Adding `@meta-quest/metavr` as a workspace dependency
(its postinstall downloads a native binary from Meta's CDN; it stays a
host-level opt-in); CI usage; wearing-based validation itself.

## Acceptance criteria

- [x] `pnpm run doctor` passes with `metavr` registered for both agents.
- [ ] `scripts/mcp/metavr.sh` starts the MetaVR MCP stdio server when
  the binary is present on the host. (Pending: installed
  `@meta-quest/metavr` via npm with caches redirected, then drove a real
  MCP `initialize` + `tools/list` exchange through the launcher — it
  exits before responding because the platform binary cannot be fetched:
  `getaddrinfo ENOTFOUND securecdn.oculus.com` under the sandbox's
  proxy-only network. No Quest is currently connected either.)
- [x] Setup doc states the one-time wearing step (USB-debugging prompt)
  and the no-wear testing split.
- [x] No default script or CI job invokes MetaVR.

## Failure cases considered

| Failure case | Prevention or evidence |
|---|---|
| Native binary missing or CDN unreachable | Launcher is opt-in only; iwsdk-runtime keeps working; setup doc gives the exact host install command |
| Quest in developer mode off / ADB unauthorized | Setup doc lists developer-mode and one-time on-headset accept steps |
| MCP name drift between agents | Same `metavr` name and script registered in both configs; `doctor` enforces the layout |

## Ownership

| Role | Owner | Files or modules |
|---|---|---|
| Lead | Muse (quartz-orbit) | Brief, integration, final handoff |
| Design reviewer | Muse (quartz-orbit, pre-implementation pass) | Read-only review before implementation |
| Implementer | Muse (quartz-orbit) | `scripts/mcp/metavr.sh`, `.mcp.json`, `.codex/config.toml`, `docs/IWSDK_AI_WORKFLOW.md`, `TODOS.md`, this brief |
| Independent verifier | Muse (quartz-orbit, fresh pass) | Read-only verification; test artifacts only |

## Design decision

Follow the repo's MCP rule exactly: launch logic in
`scripts/mcp/metavr.sh`, registered under one name in both agent
configs. The launcher resolves the host-installed binary via `npx`
rather than a workspace dependency, so the native download and device
access stay off every default install, typecheck, and CI path. MetaVR
complements IWER: emulation remains the deterministic gate; MetaVR is
for real-device evidence only.

## Test plan and evidence

| Acceptance criterion | Workflow or command | Inspectable artifact/result |
|---|---|---|
| Both-agent registration | `pnpm run doctor` | Terminal output |
| Launcher starts server | `sh scripts/mcp/metavr.sh` with binary present | Pending host binary (sandbox cannot reach Meta CDN) |
| No default-path impact | `pnpm run verify:agent` diff scope (config/docs only) | Terminal output |

## Physical-device limits

One-time wearing is required to accept the USB-debugging prompt (and
set a guardian) after enabling developer mode in the Meta Horizon app.
After that, launching, screenshots, profiling, and logs run against the
desk-bound headset. Hand-tracking quality, comfort, and tracking feel
still need a person; see the headset checklist in `TODOS.md`.

## Landing note (2026-10-18)

Merged to `main` as the opt-in `metavr` MCP registration. The one open
acceptance item above (launcher starts the MCP server with the binary
present) remains an operator step: download the host binary from Meta's
CDN on an unrestricted network, connect a Quest, and accept the one-time
USB-debugging prompt in-headset. No default script or CI job invokes it.
