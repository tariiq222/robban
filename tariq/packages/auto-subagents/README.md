# Auto Subagents

Auto Subagents provides tier-based routing, upward provider fallback, a read-only coordinator, seven approved workflow recipes and a replay-driven chat card on Robban's DSH 0.2.1-alpha.1 branch. Preparation recovery uses an Auto-owned public LLM provider; one Session append extension remains required. See [upstream compatibility](docs/UPSTREAM-COMPATIBILITY.md).

Ongoing tasks use persistent memory across turns and sessions, and recipe children receive selected bundled method skills. See [task memory and stage methods](docs/TASK-MEMORY.md).

## Use

From the repository root, install dependencies with `pnpm install`, build DSH with `pnpm run build`, then run `node tariq/packages/auto-subagents/build.mjs`. Start the isolated browser profile with `node tariq/scripts/auto-preview.mjs`; its default port is 3181. The launcher uses `.artifacts/auto-home`, excludes provider credentials from the inherited environment and disables telemetry. The launcher permits its own browser-session grant and saved scalar Web interface settings; it refuses provider credential records, dotenv files and executable overlays. Use `--instance <safe-name>` for a separate preview home. It does not copy personal settings, credentials or Sessions.

Select Auto Subagents as the session preset. The Auto settings page groups the routing switch, model/provider rows and save actions in a responsive English layout inside the installed bundle page. Full application localization is deferred. It owns the live enabled switch, exact allowed routes, their priority order and strong/medium/light tiers, shown as Build & Review, Analyze & Plan and Read & Search. Models are grouped in one section per tier; each section explains its tier, numbers its models by priority within that tier, and has Move up/Move down buttons and its own add list. The page warns when no route is Build & Review, when only one is, or when none is Analyze & Plan. Disabled or empty settings refuse delegation. Saved routes remain editable if their provider disappears. Saving all routing fields uses one revision-fenced mutation; a stale draft requires discard and reload. Legacy routing settings can be converted from an explicit copy to an unapplied overlay; see [copied-settings conversion](docs/DELEGATION-V020.md#copied-settings-conversion).

The Recipes section of the same page draws each approved recipe as a stage canvas. Selecting a role opens its tier and step-timeout fields; each recipe also has an enable switch and its documented boolean options. These values are saved as `recipeOverrides` in the same revision-fenced mutation and never edit recipe files, so approval locks stay valid. `run_recipe` validates them against the approved recipe at run start: a disabled recipe is refused, strong-only roles (implementer, reviewer, validate) keep the strong tier, and an override naming an unknown role or option fails the run. The canvas data is built from approved recipes by `build.mjs`; rebuild after approving a new recipe. Stage graphs live in `lib/recipe-flows.mjs`, which `test/recipe-flows.test.mjs` checks against each script and its metadata.

The Execution Sidebar Graph tab reuses the latest loaded recipe run from materialized Chat nodes. Its compact flow preserves the feature pipeline’s reviewer branches and return loops; other recipes keep ordered observed stage lanes without dependency arrows. Hover or focus an icon to read its recorded role, state, provider/model/tier, round, timing and available result. Clicking selects the existing detail panel; Open session navigates to that child. Missing recorded effort is omitted. Changing run or session resets local selection and completed-step visibility; unmounting stops the live timer. The chat card retains its full flow layout, with separate SVG marker ids for each mounted graph.

The package resolves declared dependencies through Node's public package exports. `DSH_RUNTIME_DIR` does not select runtime modules. `DSH_HOME` selects data storage; `DSH_AUTO_RECIPES_DIR` selects the approved recipe directory. The supplied preview selects `tariq/recipes`.

## Components

- `lib/delegation.mjs`, `lib/model-selection.mjs`: Auto-owned spawn/fork consumers and volatile routing settings. See [delegation](docs/DELEGATION-V020.md).
- `lib/router.mjs`, `lib/runtime.mjs`: live authorization, least-loaded routing, verifier separation and bounded upward recovery within the same child. See [native context overflow recovery](docs/UPSTREAM-COMPATIBILITY.md#context-overflow-recovery).
- `lib/llm-provider.mjs`, `lib/compatibility.mjs`: native LLM service replacement and an activation check for safe custom-event append and restore.
- `lib/coordinator.mjs`: read-only coordinator tool admission and child report policy.
- `lib/recipe-flows.mjs`, `lib/recipe-overrides.mjs`: settings-canvas stage graphs and validated per-recipe overrides.
- `lib/recipes.mjs`, `lib/workflow-routing.mjs`: approved recipes, private workflow routing, cancellation and resume. See [PTC execution](docs/WORKFLOW-V020.md).
- `lib/decision-receipt.mjs`: accepts only successful canonical Session tool messages matched to this run's human questions.
- `lib/task-memory.mjs`, `lib/task-memory-store.mjs`: explicit task identities, bounded historical notes and revision-checked local persistence.
- `lib/task-work-store.mjs`: persistent subgoals and work items, dependency readiness and repository-scoped execution reservations. See [persistent work plans](docs/TASK-WORK.md).
- `lib/stage-skills.mjs`, `skills/`: trusted method instructions selected for authenticated recipe stages and included in their logged prompts.
- `src/client.src.js`, `src/settings.src.js`: current chat card and Auto settings page, assembled into `lib/client.js` by `build.mjs`.
- `cordis.patch.yml`, generated `preset.patch.yml`: host service, default xKiro provider route (18 models, key supplied separately as `XKIRO_API_KEY`) and declarative preset bundle; canonical agent rows live in `tariq/presets/auto-subagents/agent.cordis.yml`.
- `core-patches/`: historical 0.1.5 reference evidence, not installation instructions for 0.2.0. Never apply those compiled patches to this branch.

## Verification

After building the runtime, run from this package:

```sh
DSH_AUTO_RECIPES_DIR=../../recipes node --test test/*.test.mjs test/legacy/*.test.mjs ../../presets/auto-subagents/auto-subagents.test.mjs
```

Use Node 24 or later. Pure routing/receipt tests are separate from PTC process tests and Loader/browser acceptance. A passing offline suite does not establish real-provider behavior. See [migration evidence](../../docs/AUTO-0.2.0-COMPATIBILITY.md) for the source audit and [repository instructions](../../README.md) for the baseline.
