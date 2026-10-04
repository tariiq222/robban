# Auto recipe audit repairs — verified local TDD evidence

## Scope and user journeys
The direct user asked to fix the audited Auto recipe gaps. Source audit: `/Users/tariq/Desktop/dsh-recipes/auto-recipes-verification-ar.md`.

1. A coordinator chooses an approved recipe by request intent, including non-writing workflows, without granting new permission to implement a plan.
2. A recipe executes only in a session whose workspace resolves to the intended repository; wrong/missing workspace must stop before cache, resume or model admission.
3. A failed QA criterion keeps its evidence when the independent checker is unavailable; unconfirmed PASS must not become success.
4. Refactor review verdicts attach to actual reviewer agents in durable telemetry.
5. Each saved recipe displays its actual stages and active agents without pretending to be feature-pipeline.

No Git repository exists at the installed plugin path, so no checkpoint commits were made. No installs, service restarts or live model calls are authorized in this repair.

## Runner
Package scripts use Node's built-in test runner, not Jest/Vitest. Commands use `/Users/tariq/.local/share/deepseek-harness/node-v24.21.0-darwin-arm64/bin/node` (24.21.0), from the plugin directory.

## Intent guidance
- RED: `node --test test/recipe-intent-guidance.test.mjs`: 3 executed tests, 0 passed, 3 failed, exit 1. Existing generic coordinator instructions excluded non-code workflows and omitted planning/authorization/workspace safeguards.
- Implemented intent-based generic guidance in `lib/recipe-catalog.mjs`, preserving approved-only names, human decision receipts, no-writing substitution and no implementation authorization from planning alone.
- First compatibility run: 17/18 passed; one legacy test expected the phrase `fitting approved recipe`. Kept this truthful phrase in the revised text rather than weakening the test.
- GREEN: `node --test test/recipe-intent-guidance.test.mjs test/legacy/coordinator.test.mjs`: 18/18 passed, 0 failed/cancelled/skipped, exit 0.

## Workspace admission
- RED: `node --test test/recipe-workspace.test.mjs`: 15 tests, 5 pass / 10 fail, exit 1. Invalid workspaces were actually admitted by the installed worker/fake provider; invalid resume took precedence over mismatch.
- Minimal host-layer guard added after approval/contract checks and before cache/claims/routing. `realpath` and directory status must match session cwd and repo. Missing cwd fails closed; aliases accepted; supplied repo remains unchanged for resume identity.
- GREEN same target: 15/15. Affected integration target `test/recipe-workspace.test.mjs test/run-recipe-events.test.mjs test/recipe-engine-meta.test.mjs test/recipe-speedups.test.mjs test/new-recipes-worker.test.mjs test/recipe-catalog.test.mjs`: 70/70, exit 0. Fake provider, actual installed worker, no live models. Existing mock headers were made faithful using actual temp directories; no production bypass introduced.
- Parent independently ran workspace+intent regressions: 18/18, exit 0. Read-only reviewer `01e3039a-e4a8-4891-909e-9ea66282e3c4` found no actionable guard or guidance issue.

## QA and refactor
- Intended RED: targeted QA/refactor suites, 90 tests /78 pass /12 fail, exit 1. Nine verifier-status × checker null/malformed/throw failures and three actual-reviewer-to-card telemetry failures. A first fixture binding mistake was corrected before repeating intended RED, not counted as defect evidence.
- Additional author failed/blocked + valid checker PASS evidence regressions: 92 tests /90 pass /2 fail, exit 1 before merge change.
- Implementation preserves observed verifier failure/blocker evidence when independent output is missing and prevents author-only PASS. Final merged records retain verifierEvidence/checkerEvidence and choose evidence from a failed/blocked stage. Refactor emits valid per-actual-reviewer verdicts, including synthetic rejection for missing/malformed evidence, without replacing review gates.
- Final focused GREEN: 92/92, exit 0; parent independently 92/92. Independent reviewer `01e3039a-e4a8-4891-909e-9ea66282e3c4` inspected final bodies/gates and independently ran 92/92 with PASS recommendation.
- Only qa-verify/refactor locks renewed AFTER that PASS using `scripts/approve-recipe.mjs <name> --yes --by audit-repairs-independent-review-01e3039a`. Unchanged metadata hashes retained. Offline actual-worker + seven-catalog target: 7/7, exit 0. No service restart.

## Recipe-aware cards
- Intended RED: `node --test test/card-model.test.mjs test/client-render.test.mjs test/run-tracker.test.mjs`: 43 tests /26 pass /17 fail, exit 1; old feature/decision tests remained green.
- Non-feature recipes use ordered stage groups rather than fabricated feature dependency diagrams. Source render tests assemble current modules in memory without writing built artifacts.
- Additional prototype-name regressions were executed RED before fixes (custom recipe constructor, own phase/role data, tracker phase constructor/__proto__). Safe own-property lookups and null-prototype accumulators now retain them as plain replay data.
- Final scoped GREEN47/47, exit0. Independent reviewer `01e3039a-e4a8-4891-909e-9ea66282e3c4` inspected final source and independently ran 47/47, PASS; original feature graph, decisions, reviewer evidence and all active agent visibility preserved.
- Parent built final `lib/client.js` (79679 bytes), then `DSH_TEST_BUILT_CLIENT=1 node --test test/client-render.test.mjs test/decision-e2e.test.mjs`:24/24, exit0. Changed JavaScript syntax checks all exit0.

## Final verification
- `node --test --experimental-test-coverage test/*.test.mjs test/legacy/*.test.mjs`: **701/701 passed**, fail/cancelled/skipped/todo0, exit0; 853.354583ms. Final tracker prototype test is included in this count.
- Instrumented module coverage: **98.16% lines /88.81% branches /93.33% functions**. This covers loaded library/script modules, NOT VM-rendered frontend or AsyncFunction recipe source coverage. `card-model.mjs`100% lines/84.66% branches; `recipe-catalog.mjs`100% lines/95.24% branches; `recipes.mjs`99.43% lines/84.67% branches.
- Seven approval checks exit0: only QA/refactor timestamps and script hashes renewed; other five intact. Core patches check reports12/12 applied, exit0; no core file changed.
- Source-only/human-receipt/role-contract targeted regression56/56, exit0. Narrow secret-shaped scan of changed library surface found no matches; not a full security audit.
- No lint/typecheck script or TypeScript build is configured for this JavaScript plugin. Used `node --check` and its actual build script; no tooling installed.
- Live GUI refresh, interactive/visual acceptance and real Auto-model recipe execution were NOT performed. Existing service was not restarted.

## Guarantees and proof map
| Guarantee | Test target | Type | Current result |
|---|---|---|---|
| Non-writing request chooses from approved intent catalog, no implicit plan execution | recipe-intent-guidance.test.mjs | Prompt-contract regression | PASS3/3; legacy compatibility18/18 |
| Wrong/missing cwd refuses before cache/claims/child; canonical alias works | recipe-workspace.test.mjs | Actual worker admission + offline provider | PASS15/15; related integration70/70 |
| Missing/malformed/throw checker preserves failed/blocked verifier evidence and cannot certify author PASS | qa-verify-recipe.test.mjs | Actual script body with deterministic child results | PASS63/63 in combined92/92 |
| Contradictory checker PASS retains author failed/blocked evidence | qa-verify-recipe.test.mjs | Actual script body regression | PASS within63/63 |
| Actual reviewer verdict/finding telemetry survives repair round replay | refactor-recipe.test.mjs | Actual recipe log → RunTracker → card fold | PASS29/29 in combined92/92 |
| Current approved bodies cross real worker engine and remain discoverable | new-recipes-worker.test.mjs + seven-recipes-catalog.test.mjs | Offline engine integration | PASS7/7 |
| Seven recipe-specific cards/unknown recipe fallback show active agents | card-model/client-render/run-tracker tests | Model + real React static render | PASS47/47 independently; built render/decision24/24 |

## Known boundaries
Intent selection remains model-directed, not a deterministic selector. Workspace admission is a mismatch guard, not a shell security sandbox or complete protection against later path replacement. Source-only stages remain mechanically read-only; shell-capable no-edit policy is prompt-only. Live activation is separate from on-disk verification. Tests use mocked provider outputs: actual worker execution is not actual LLM or target-repository command execution. AsyncFunction recipe bodies are exercised by behavioral tests; ordinary module line-coverage numbers cannot certify their source coverage. Coverage above is measured for instrumented modules only; live model and browser acceptance remain explicitly unverified.
