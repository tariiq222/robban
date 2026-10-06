# Changelog

## Unreleased

- Settings label tiers by job: Build & Review (`strong`), Analyze & Plan (`medium`) and Read & Search (`light`). Saved values, recipe metadata and the delegation `tier` enum keep the `strong`/`medium`/`light` ids. Each model row and recipe role shows its tier description.
- Model rows have Move up/Move down buttons; `allowedModels` order is the priority among equally loaded routes of one tier. A hint explains that reviews prefer a different model than the writer.
- Enabled settings warn when no model is Build & Review, when only one is (reviews reuse the writer's model), and when no model is Analyze & Plan (analysis escalates to Build & Review).
- Scope-only steps run on new medium roles: `audit-scope` (code-audit), `investigation-scope` (investigate) and `plan-evidence` (plan-to-packages). Scanning, gathering, packaging and checking stay strong. The three recipes need re-approval.

## 0.3.0

- Engine-boundary compatibility fix: approved recipe metadata may retain plugin documentation fields (`version`, `args`), but `run_recipe` passes only `name`, `description`, `whenToUse` and `phases` to DSH's strict WorkflowMeta contract. Supported field values remain unchanged and subject to engine validation. Four regression tests use the installed validator and a real worker-thread engine; full suite now 315/315. The recipe files and approval lock were not altered by this fix.
- Feature-pipeline defaults to one medium quick-spec for changes scoped to one or two concrete files with no needs_user or pending decisions. Empty scope, directories, globs, `.` and `..` take the full path with an eligibility explanation. The fast path intentionally exempts design approval and reports `designReview: 'skipped (fast path)'`, never "approved". Code approval and exact validate acceptance coverage remain mandatory. `fastPath:false` restores full design review.
- Manifest-content/realpath/recipe SHA-256 setup cache: seven-day TTL, atomic mode-0600 writes in a mode-0700 directory (existing directory chmod is best-effort), stored-key matching, strict setup validation and never-throw failures. Tests use temporary directories only.
- Deterministic review union avoids the aggregate agent by default (`useAggregator:true` opts in). Repair reviews include previous findings and changed-path delta instructions. Missing/rejecting/blocking reviews and exact acceptance coverage remain mandatory gates.
- Validation runs concurrently with reviewers by default (`earlyValidate:false` opts out); rejected iterations discard their validation.
- Per-role timeout configuration travels in the authenticated recipe marker because the worker rejects timeoutMs/signal in agent options. Routing-side enforcement is implemented: every attempt (the original child and each replacement) runs under a per-attempt AbortController linked to the run's signal and a timer covering route selection, child admission and the result wait. Expiry aborts only that attempt, disposes its child, releases its reservation exactly once and marks its route as a structured failure, then retries on another route under the existing read-only allowlist with the shared `structuredRetries` budget (timeout and no-structured-output failures draw from it); implementer retry remains opt-in via retryImplementer and retains the partial-edits warning. Without a retry the step resolves a synthetic `stopReason:'error'` result ("step timed out after N ms on provider/model") so `must()` throws its message. Telemetry reports reason `TIMEOUT` with the original child id and timeoutMs; run-level aborts still propagate as aborts. Invalid timeoutMs values (non-positive, non-integer, over four hours) are ignored; unauthorized markers are still rejected. Timers are unref()ed and cleared on settle, dispose and abort.
- Pure timing replay and a read-only JSONL/zstd CLI report agent work, stages, role/model timing, wall time and observed sequential critical-path time. No session is read unless explicitly supplied to the CLI.
- Fastest-first allowedModels ordering is reserved for the captain's settings change, not code here.

## 0.2.1

- Saved recipe schema steps retry once on a fresh child on a different same-tier-or-stronger route when the model completes without `structured_output`; `structuredRetries` can override the budget. Reviewer replacements continue excluding the implementer. Exhausted alternatives preserve the original result.
- Shared router remembers structured-output failures for 30 minutes, preferring reliable routes within each tier only for opted-in recipe selections. Ordinary subagent routing is unchanged.
- Retry reservations and children are cleaned up on settlement, disposal and abort, including pending preflight/publication. Replacement model telemetry annotates the original workflow node and parent session audit.
- Feature-pipeline missing-output errors explain the tool requirement and point to Subagent tier settings; the recipe is re-approved after the change.

- Review fixes: the structured-output fallback is read-only by default (setup, analysis, requirements, design, designReview, plan, reviewer, aggregate, validate). An `implementer` is retried only with `retryImplementer: true`; its replacement prompt warns about partial edits and reviewers exclude every implementer route of the round. The returned run delegates all methods except `dispose` to the current child (`id` stays the original, `currentChildId` is read-only). A failed replacement start returns the original result and logs through an injectable `warn`; abort still propagates. Failure memory in the router is documented as bounded and pruned on read.

## 0.2.0

Hardening and self-containment pass after a full audit of 0.1.0 (13 findings), followed by two independent review rounds.

### Packaging and portability
- Preset rows name the package (`dsh-auto-subagents/runtime`, `/coordinator`, `/recipes`) instead of absolute paths; resolved from the web profile's `node_modules`. The headless profile does not mount agent presets, so it needs no dependency.
- `lib/dsh-paths.mjs` is the single source of installation paths (`DSH_HOME`, `DSH_RUNTIME_DIR`, realpath-resolved so symlinked installs share the host's module instances). No module or test embeds a machine path; the suite passes from a copied package.
- Installed-runtime patches live in the package: `core-patches/` (12 targets, originals verified against npm `@deepseek-ai/*@0.1.5-rc.2`, sha256 manifest) and `scripts/reapply-core-patches.mjs --check | --apply` (refuses on drift, verified backups first, rolls back on a failed write).
- The router registry is process-global (`Symbol.for('dsh-auto-subagents.routers')`), so the patched `tool-subagent` and any copy of the package share one router and one load count.
- `engines.node >= 24`; React/react-dom pinned as devDependencies (no `/tmp` install). `.gitignore` added.
- `home/local-plugins/auto-subagent-routing/*.mjs` are relative re-export shims, still required by the `tool-subagent` core patch.

### Recipes and resume
- Recipe approval lock (`recipe.lock.json`, `scripts/approve-recipe.mjs`): an unapproved or changed recipe does not run. The lock is tamper-evident, not a signature.
- A resume token is consumed only when the run settles (completed, completed_with_failures, needs_decision, ended, aborted). Engine errors and cancellations leave it retryable with the same answers; a settled run can never be replayed, even if bookkeeping fails.
- Claims record `{pid, createdAt}`. A live owner is never robbed. Dead owners are reclaimed immediately, unknown (legacy empty) owners after 6 h; reclaim is serialized and re-checked.
- `.runs` garbage collection: records older than 14 days, abandoned claims and stale temporary files.
- `decidedForYou` overrides come only from verified human answers in `ask_user_question` (ids `<cardRunId>:<id>`). An untouched override sends the `__keep__` sentinel, which is dropped and never reaches the recipe. The coordinator's `decisions` argument is ignored.
- Answers split across several verified question batches are accepted (a later answer wins).
- Removed dead up-front routing (`resolveRoutes`, `pickRoute`, `REVIEWER_COUNT`) and the always-empty `routes` fields; one role→tier table.

### Coordinator
- `list_agents` (read-only) added to the coordinator allowlist.

### UI
- The card's direction follows the active DSH locale (ltr for English, rtl for Arabic) instead of always being rtl.
- Durations use h:mm:ss from one hour; option keys are unique; the flow graph scrolls on narrow widths.
- The decision box binds to batches that carry optional override questions.

### Tests
- 237 tests (was 183): new core-patch, recipe-integrity, path, router-registry, claim race, end-to-end decision and fault-injection tests. Tests never write to the live recipes directory.

## 0.1.0

Initial packaged foundation: tier router, coordinator policy, `run_recipe`, durable run events and the chat card.
