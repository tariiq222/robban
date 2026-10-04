# Structured-output fallback: TDD evidence

## Source and user journey

Derived from the implementation request (no separate source plan). As a recipe user, I need a schema step to recover once on another eligible fresh child when a model ends without using `structured_output`, without leaked reservations or lost card telemetry.

## RED → GREEN

Runner: Node.js built-in `node --test`, with the supplied Node 24 executable. No git commands or commits were used.

1. Before production changes, ran `node --test test/workflow-routing.test.mjs test/run-recipe-events.test.mjs test/recipe-gates.test.mjs`: `tests 70`, `pass 57`, `fail 13`. Intended failures included only one child instead of two, absent `markStructuredFailure`, missing original-seq annotation, and the old `step "setup" failed (agent returned null)` error.
2. Initial implementation passed the same 70 tests. Further disposal edge tests reproduced premature disposal completion during replacement preflight and a missing-output child not being disposed without alternatives: `tests 25`, `pass 23`, `fail 2`. Both were fixed.
3. Expanded targeted suite: `tests 77`, `pass 77`, `fail 0`.
4. Full requested command, `node --test test/*.test.mjs test/legacy/*.test.mjs`: `tests 260`, `pass 260`, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0`.

## Review-fix round (F1-F5)

Tests for F1-F4 were added to `test/workflow-routing.test.mjs` in the same pass as the fixes (not captured as a separate red run). Covered: implementer not retried by default; opt-in warning text; reviewer excludes both implementer routes; Proxy delegation of `interrupt`/`steer` to the current child; startup failure keeps the original result with a warning; abort propagates; chained `structuredRetries: 2` reports the original `replacedChildId`; dispose before replacement launch starts no child. End-to-end `onRouteChange` wiring is covered by the existing `private provider replacement emits route change into parent audit` test in `run-recipe-events.test.mjs` (real `recipes.mjs` wiring).

## Guarantees

| Behavior | Evidence | Type |
|---|---|---|
| Schema completion without output starts another fresh same-tier child and returns replacement structured value | workflow-routing.test.mjs | Unit |
| No alternative preserves original result; no third child by default; configurable/disabled budgets | workflow-routing.test.mjs | Unit |
| No downgrade; reviewer replacements strictly avoid implementer and failed routes, preserving verifies metadata | workflow-routing.test.mjs | Unit |
| No-schema, failed/aborted and structured-null results are not retried | workflow-routing.test.mjs | Unit |
| Active counts return to zero on settle, failure, publication failure, disposal and abort, including pending preflight/publication | workflow-routing.test.mjs | Unit |
| Replacement updates implementer identity, childInfo and route-change payload; disposal targets current child | workflow-routing.test.mjs | Unit |
| Reliability is opt-in, tier-local, keeps failed models usable, and expires at injected TTL boundary | workflow-routing.test.mjs | Unit |
| Replacement route-change and later changes annotate original seq; actual callback writes parent audit | run-recipe-events.test.mjs | Offline integration |
| Real recipe missing setup output explains structured_output, bounded recovery and tier settings | recipe-gates.test.mjs | Integration |

## Verification outputs

`node scripts/approve-recipe.mjs feature-pipeline --check` (exit 0):

```text
ok: recipe "feature-pipeline" matches recipe.lock.json (approved 2026-10-03T10:35:10.253Z by codex-structured-fallback)
```

`node build.mjs && node --check lib/client.js` (exit 0):

```text
built lib/client.js (71474 bytes)
```

Path scan using the filesystem grep tool separately against `lib`, `test`, and `scripts` for `/Users/`: each returned `No matches found` (equivalent empty matches to the requested shell grep; the shell grep command was not run).

Coverage command:

```sh
node --experimental-test-coverage --test-coverage-include='lib/router.mjs' --test-coverage-include='lib/workflow-routing.mjs' --test-coverage-include='lib/recipes.mjs' --test test/*.test.mjs test/legacy/*.test.mjs
```

All 260 tests passed. Coverage: router 100% lines / 95.38% branches; workflow routing 100% lines / 93.48% branches; recipes 98.36% lines / 78.83% branches. Aggregate 99.19% lines / 87.18% branches / 90.08% functions. Remaining recipe branches include existing restore/error paths, not the retry mechanism.

## Boundaries and risks

No server restart, process termination, runtime modification, live session writes, or live `.runs` operations were performed. Tests use isolated temporary storage. This is offline verification, not a live-model run. Fresh retry children do not share conversation history, but the first child's repository side effects remain; retry prompts must still respect the recipe's scope. The already-running server may retain loaded modules until a future user-managed reload/restart. Shared reliability memory is in-process and ephemeral.

## Self-evaluation

| Axis | Score | Evidence / improvement |
|---|---|---|
| Accuracy | 4 | 260 passing tests and exact approval/build evidence; no live model validation due the requested no-restart/protected-storage boundaries. |
| Completeness | 4 | All requested behaviors covered; unavailable live-model verification remains explicit. |
| Clarity | 4 | Error copy avoids claiming a retry occurred when no alternative exists, but lifecycle logic merits careful future maintenance. |
| Actionability | 4 | Changes and approved recipe are ready; activating already-loaded server modules is intentionally left to the user. |
| Conciseness | 4 | Compact final report with detailed evidence separated here. |

Overall: 4.0/5. Most useful follow-up is a user-authorized live schema run after a separately scheduled reload; watch for repository side effects from retries. The user should agree the implemented scope is verified without claiming live activation.
