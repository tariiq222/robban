# tariq/ — Robban (رُبّان): customization layer for DSH

All Robban-specific components live in this directory. Upstream code lives outside it; changes to upstream files require explicit commits prefixed with `tariq(core):` and an entry in [the change log](docs/CHANGES.md).

| Path | Contents | Status |
|---|---|---|
| `packages/auto-subagents/` | Auto Subagents plugin: router, coordinator, recipes and run card | Integrated on DSH 0.2.1-alpha.1; historical patches retained as references |
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

## Integration target

The current source integrates Auto with DSH `0.2.1-alpha.1`. The earlier 0.1.5 baseline and 0.2.0 compatibility audit are historical references; [migration status](docs/AUTO-V020-STATUS.md) owns current acceptance and remaining work. Sanad and Agent Teams are excluded from the agreed Auto-only scope. Product interface work follows runtime repair and migration acceptance.

## Keeping DSH updates

`origin` is Robban; `upstream` is `https://github.com/deepseek-ai/deepseek-harness.git`, whose default branch is `master`. Robban retains upstream history and receives DSH changes by merging source commits. Replacing the runtime with a stock npm release can remove the remaining Session append extension; a plugin update alone does not preserve it. [Auto's compatibility reference](packages/auto-subagents/docs/UPSTREAM-COMPATIBILITY.md) owns the public LLM provider replacement and required Session behavior.

Fetch and compare without changing working files:

```sh
git fetch --no-tags upstream master
git rev-list --left-right --count HEAD...upstream/master
```

The second number counts upstream commits missing from this checkout. When it is nonzero, first commit the reviewed local work, including new files, then create an update branch in a separate worktree. The clean-tree check below prevents a candidate from omitting uncommitted repairs.

```sh
test -z "$(git status --porcelain)" || exit 1
git worktree add -b tariq/update-dsh ../robban-dsh-update HEAD
git -C ../robban-dsh-update merge --no-commit --no-ff upstream/master
```

Resolve conflicts in the candidate worktree using [the upstream change log](docs/CHANGES.md). Preserve ignorable Session append semantics, or adopt an equivalent upstream API and update every Auto consumer. Check the Auto-owned LLM provider against the updated runtime even when Git reports no conflicts:

```sh
pnpm exec vitest run packages/core/session/tests/append-ignorable.spec.ts
node --test tariq/packages/auto-subagents/test/llm-provider.test.mjs tariq/packages/auto-subagents/test/llm-provider-composition.test.mjs tariq/packages/auto-subagents/test/compatibility.test.mjs
```

Run this check from the candidate after installing its frozen lockfile and building it. Run the Auto verification below, relevant SDK/session migration checks and the repository checks required by changed files before committing the merge and integrating the update branch. Preview with a disposable profile; migrate personal Sessions only after migration acceptance. Upstream API changes can require plugin adjustments, so an available update is not automatically a compatible update.

## Auto mode sources and verification in Robban

This branch packages Auto `0.4.0-dev.0`, migrated from the installed `0.3.0` source at `~/.local/share/deepseek-harness/home/plugins-src/dsh-auto-subagents/`. Handwritten `lib/*.mjs` and `lib/index.js` are source; `lib/client.js` and `preset.patch.yml` are generated. Runtime packages resolve from declared workspace dependencies.

The seven approved recipes remain packaged with integrity locks. Run records, credentials and personal Sessions are not copied. Node 24 or later is required for Auto.

```sh
pnpm install --frozen-lockfile
pnpm run build
node tariq/packages/auto-subagents/build.mjs
DSH_AUTO_RECIPES_DIR="$PWD/tariq/recipes" node --test tariq/packages/auto-subagents/test/*.test.mjs tariq/packages/auto-subagents/test/legacy/*.test.mjs tariq/presets/auto-subagents/auto-subagents.test.mjs
node tariq/scripts/auto-preview.mjs
```

The preview uses `.artifacts/auto-home` on port 3181; `--instance <safe-name>` selects a fresh preview directory without touching existing credentials. After that first launch has created the profile, `pnpm run deep` starts the same home and port and accepts its saved credentials and installed plugins, which the offline preview script refuses. See [migration status](docs/AUTO-V020-STATUS.md) for acceptance evidence and remaining limits, and [the package README](packages/auto-subagents/README.md) for plugin behavior.
