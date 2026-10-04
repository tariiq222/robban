# Recipe foundation repair — direct execution evidence

## Scope and intent

User resumed work after stopping an opaque, long-running recipe attempt. This repair was executed directly, outside `workflow` / `run_recipe`. It repairs three confirmed defects, not the entire recipes roadmap. No installs, runtime patches, saved-recipe/lock edits, service restarts, commits, deployment or live-model acceptance runs were performed.

Changed production paths: `lib/recipe-contract.mjs`, `lib/workflow-routing.mjs`. Tests: `test/recipe-contract.test.mjs`, `test/workflow-routing.test.mjs`. Documentation: `README.md` and this report.

## Guarantees

| Behavior | Evidence | Type |
|---|---|---|
| Canonical implementer/reviewer/validate metadata cannot lower strong tiers | Six downgrade regressions in recipe-contract.test.mjs | Unit |
| Exact designReview name accepts overlays; custom camel-case and reserved names remain forbidden | Canonical naming/retry/default-table tests | Unit |
| Real installed spawn driver maps completed-but-uncaptured schema output to error, and routing can recover once | Installed-driver fidelity tests use actual spawn, startInProcessRun, Session and capture runtime; only the child loop is faked | Offline integration |
| Recovery can complete with an actual committed structured capture on the replacement | Replacement capture and opt-in implementer/reviewer independence test | Offline integration |
| Stale/foreign/seeded/restored/multiple-turn sessions, missing proof and foreign steering cannot trigger error-shaped recovery | Negative driver-fidelity tests | Offline integration |
| Provider error/refusal/max-tokens/abort, no schema and default implementer are not retried by this classifier | Negative driver-fidelity tests | Offline integration |
| Existing bounded retry, schema/filter forwarding, reviewer exclusions, cancellation, timeout and reservation cleanup remain covered | Existing routing, timeout and run-recipe event suites | Unit / offline integration |

## RED → GREEN

Attributed implementation-worker evidence (reported before their later session failures):

- Contract: supplied Node24 `--test test/recipe-contract.test.mjs` before production edit: 43 tests, 36 pass, 7 intended failures, exit 1. After edit: 43/43 pass, exit 0.
- Routing: supplied Node24 `--test --test-name-pattern='installed driver fidelity' test/workflow-routing.test.mjs` before production edit: 19 tests, 18 pass, 1 intended failure (one child instead of replacement), exit 1. Expanded GREEN: 21/21 pass, exit 0. Test-harness setup mistakes were corrected separately and were not counted as RED.

The routing implementation worker and first routing reviewer subsequently failed without final reports. Their failure is not a passing review. Parent re-read persisted files and independently reran verification.

## Parent verification

Executable: `/Users/tariq/.local/share/deepseek-harness/node-v24.21.0-darwin-arm64/bin/node`.

Working directory: `/Users/tariq/.local/share/deepseek-harness/home/plugins-src/dsh-auto-subagents` (not a Git checkout).

- `node --test test/*.test.mjs test/legacy/*.test.mjs`: **399 tests, 399 pass, 0 fail/cancelled/skipped/todo, exit 0**, reported runner duration 759.779542 ms.
- `node --test test/recipe-contract.test.mjs test/recipe-catalog.test.mjs test/recipe-integrity.test.mjs`: **60/60 pass**, exit 0.
- `node --experimental-test-coverage --test-coverage-include='lib/workflow-routing.mjs' --test-coverage-include='lib/recipe-contract.mjs' --test test/workflow-routing.test.mjs test/replacement-timeout.test.mjs test/recipe-contract.test.mjs test/run-recipe-events.test.mjs`: **134/134 pass**, exit 0. Contract: 100% lines, 98.28% branches, 100% functions. Routing: 100% lines, 92.57% branches, 91.43% functions. These percentages cover only the two selected files, not the whole product.
- `node --check lib/workflow-routing.mjs` and `node --check lib/recipe-contract.mjs`: exit 0.
- `node scripts/approve-recipe.mjs feature-pipeline --check`: unchanged approved lock matches, exit 0.
- `node scripts/reapply-core-patches.mjs --check`: all 12 applied, exit 0; no apply operation.

## Independent review

- Contract review: PASS. Independent contract/catalog/integrity run 60/60 plus 34 read-only probe assertions; no actionable findings.
- Routing review: PASS from a replacement independent reviewer. Inspected actual spawn/driver/session/inbox/fold APIs and classifier/lifecycle gates; independently ran installed-driver fidelity regressions **21/21 pass**, exit 0. No actionable findings. Prior failed reviewer turn was not used as evidence.

## Compatibility and limits

Error-shaped recovery is deliberately narrow: exact installed spawn prototype and start method, real fresh unseeded Session with matching id/parent/origin and zero activation boundary, matching pre-admission input/descriptor, one claimed input and one completed consumed-work turn. Missing/unknown evidence fails closed. Existing synthetic completed results retain compatibility. Arbitrary errors are not relabeled as missing capture. Default retry budget remains one and implementer retries remain opt-in.

Provider identity/session internals are version-sensitive; a wrapped or changed provider is intentionally not granted this recovery automatically. Future runtime upgrades require revalidation. `readOnlyRetry` still declares retry eligibility, not enforced tool permissions; code-enforced read-only roles remain a separate roadmap item.

No live-model workflow or live module activation is claimed. Existing Web service may retain previously loaded server modules until a safe user-approved restart. `code-audit`, `bug-fix`, dynamic recipe cards and shared permission enforcement remain undelivered.
