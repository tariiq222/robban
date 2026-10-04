# tariq/ — Robban (رُبّان): customization layer for DSH

All Robban-specific components live in this directory. Upstream code lives outside it; changes to upstream files require explicit commits prefixed with `tariq(core):` and an entry in [the change log](docs/CHANGES.md).

| Path | Contents | Status |
|---|---|---|
| `packages/auto-subagents/` | Auto Subagents plugin: router, coordinator, recipes and run card | Integrated on DSH 0.2.0-rc.2; historical patches retained as references |
| `packages/rtl-arabic/` | Right-to-left layout for Arabic in the UI | Copied as-is |
| `presets/auto-subagents/` | Declarative Auto mode preset | Packaged by the Auto bundle |
| `recipes/` | Seven mode recipes, excluding `.runs` | Recipe files and approval locks from the local source |
| `reference/subagent-model-colors/` | Patch 13: model colors, retained as a reference | Must be ported to `packages/client/ui-subagent` |
| `docs/PLAN.md` | Full project plan | |

## Mapping the 12 core patches to upstream source

| Core patch | Source path |
|---|---|
| tool-subagent, tool-subagent-types, model-selection-settings(-types) | `packages/subagent/tool-subagent/` |
| agent-loop | `packages/core/agent-loop/` |
| agent-runtime-types | `packages/core/agent/` |
| scope-invariant | `packages/core/scope/` |
| tool-cordis-metadata | `packages/extensions/tool-cordis/` |
| session, session-types | `packages/core/session/` |
| settings-ui-client, settings-ui-card-types | `packages/client/ui-settings-plugins/` |
| (13) subagent-model-colors | `packages/client/ui-subagent/` |
| (Planned) MCP credential references | `packages/mcp/mcp-client/` |
| (Planned) Keychain | `packages/credentials/` |

## Required cleanup before the first public push

Absolute `/Users/tariq/...` paths remain in `core-patches/tool-subagent/patched.js`, `manifest.json`, documentation and `reference/`. Porting the patches to source removes their installation-specific paths. Inspect remaining occurrences with `rg -n "/Users/tariq" tariq`.

## Branches

- `tariq/baseline-0.1.5`: preserved baseline.
- `codex/auto-v020`: isolated migration based on `dsh-v0.2.0-rc.2`.

## Auto mode sources and verification in Robban

This branch packages Auto `0.4.0-dev.0`, migrated from the installed `0.3.0` source at `~/.local/share/deepseek-harness/home/plugins-src/dsh-auto-subagents/`. Handwritten `lib/*.mjs` and `lib/index.js` are source; `lib/client.js` and `preset.patch.yml` are generated. Runtime packages resolve from declared workspace dependencies.

The seven approved recipes and their locks are preserved. Run records, credentials and personal Sessions are not copied. Node 24 or later is required for Auto.

```sh
pnpm install --frozen-lockfile
pnpm run build
node tariq/packages/auto-subagents/build.mjs
DSH_AUTO_RECIPES_DIR="$PWD/tariq/recipes" node --test tariq/packages/auto-subagents/test/*.test.mjs tariq/packages/auto-subagents/test/legacy/*.test.mjs tariq/presets/auto-subagents/auto-subagents.test.mjs
node tariq/scripts/auto-preview.mjs
```

The preview uses `.artifacts/auto-home` on port 3181. See [migration status](docs/AUTO-V020-STATUS.md) for acceptance evidence and remaining limits, and [the package README](packages/auto-subagents/README.md) for plugin behavior.
