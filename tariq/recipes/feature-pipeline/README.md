# feature-pipeline (DSH workflow recipe)

Implement a feature against explicit acceptance criteria, independent reviews and final command evidence. Auto selects and runs the saved recipe from the task description.

```
setup → scoped analysis
  ├─ unresolved user decision → one question batch, then resume
  ├─ already satisfied / not recommended → explain and end
  ├─ complete local compact specification → implementation
  └─ other changes → requirements → design review → plan → implementation
implementation → parallel(two reviewers, validation)
  ├─ rejected review → bounded repair, fresh reviews and validation
  └─ approved reviews + exact acceptance + passing command receipts → completed
```

- Each step is a separate agent with fresh context. A reviewer never sees the implementer's reasoning.
- The stop condition is deterministic: the `verdict` field in the schema is `APPROVED` or `NEEDS_REVISION`.
- If a loop reaches its limit without approval, the run stops with `status: "aborted"` (unless `abortIfUnapproved: false`).
- Each reviewer can run on a different model through `provider`/`model`, for real multi-model review.

## Usage

Select Auto and describe the requested feature, for example: “Add rate limiting to login: five attempts per minute per IP.” The coordinator selects the approved recipe, uses the session repository and routes its children from saved model tiers. The user does not supply recipe paths, model names or phase commands.

`run_recipe` receives the task and repository from the coordinator. It persists decision checkpoints and reads required answers only from verified `ask_user_question` results. The coordinator resumes with the returned `resumeId`; direct `decisions` arguments cannot authorize missing answers. Direct workflow hooks use internal `resume`/`decisions` fields for tests and integrations and do not replace the host's answer verification.

## Scoped analysis and the decision brief

**Scoped analysis:** it does not analyse the whole project. It covers only:
- the files and functions the request names or implies,
- their direct callers (one hop),
- the tests that cover them.

It returns: the current state (with `file:line` evidence), what is missing, and an outcome: `proceed`, `already_satisfied` or `not_recommended`.

**Decision brief:** every decision comes in one batch, and each one includes:
- `current`: what the code does today
- `options`: each option with its concrete consequence
- `recommendation` and `why`

| Type | Behavior |
|---|---|
| `needs_user`: adds a feature, changes behavior, or touches a contract, deletion, security or scope | Stops and asks you |
| `auto`: everything else, including rare edge cases nothing depends on | Decided for you and shown in `decidedForYou` so you can override it |

**Continuing:** answer the required question batch. The coordinator resumes the saved run; setup and scoped analysis are not repeated.

**After the brief:**
- `high_risk` (security, deletion, a contract other code depends on): always stops.
- `follow_up` (a branch opened by your own choice): allowed in **one** extra round only.
- anything else: decided and recorded in `assumptions`.

Every result includes `reviewTrail` (each review and its verdict), including `aborted` results.

## The review verdict is decided in code

- If **any** reviewer returns `NEEDS_REVISION`, the result is `NEEDS_REVISION`, even if the aggregator approves. The aggregator only merges findings. (A real test showed the aggregator approving code that both reviewers had rejected; this rule closes that gap.)
- Reviewers treat any violation of an acceptance criterion or a recorded decision as `high` at minimum, even if the tests pass.

## Testing the repair loop: `faultInjection` (testing only)

```json
{ "faultInjection": { "keepTestsGreen": true } }
```

After the first implementation, an extra agent plants one subtle bug that violates an acceptance criterion while the tests still pass. Reviewers are not told. The result includes `injectedFault` so you can confirm the bug was caught and fixed. **Off by default; do not use it on real work.**

## Speedups (0.3.1)

| Argument | Default | Behavior |
|---|---|---|
| `fastPath` | `true` | One or two literal repository-relative scoped files (no absolute paths, traversal segments, backslashes, colon, control characters, directories or globs), no needs_user decisions (even answered ones), and no open/pending decisions: Scoped analysis also returns a compact specification with `impact: local`, exactly matching files, nonempty unique acceptance criteria, exact verify commands and an ordered plan. Missing or malformed specifications use the full path. No separate quick-spec child is launched. Requirements/design-loop/plan agents are skipped. |
| `earlyValidate` | `true` | Validate in parallel with reviewers after each implementation; discard on rejection, reuse on approval. |
| `useAggregator` | `false` | Merge reviewer findings deterministically without an aggregate agent. Optional aggregate cannot erase rejection/blocker evidence. |
| `stepTimeoutMs` | Role defaults | Positive milliseconds or map by label/role. setup 3m, analysis 6m, quick-spec/requirements/plan 5m, design/designReview 6m, implementer 20m, reviewer 10m, validate 8m. |
| `cachedSetup` | Internal | Validated `{stack,testCommands,lintCommands,conventions}`; skips setup with a cache-reuse log. |

Through run_recipe, setup, analysis, requirements, design, design review and planning carry authenticated read-only markers enforced by the host tool filter; these preparation roles inspect sources without executing commands. Implementation, reviews and final validation retain their execution tools. Direct workflow use without the private routing provider cannot enforce these filters.

The fast path intentionally exempts design approval. Results include `fastPath:true` and `designReview: 'skipped (fast path)'`, never "approved". Code approval and exact validate acceptance coverage remain mandatory. Final validation reruns every planned verify command and must return one exact command receipt with exit code zero and concrete evidence; missing, duplicate, unknown, failed or vague receipts prevent completion. API, security, data and architecture impacts always use the full path; the full path still requires design approval. `run_recipe` caches setup for seven days keyed by repository realpath, root manifest contents and recipe name; fresh setup is returned in result/resume. Corrupt/expired entries are ignored.

From iteration two, reviewers verify every prior finding against the changed-path delta and still flag new problems. The recipe itself never runs git commands; delta wording is guidance to independent reviewers.

The installed worker rejects timeoutMs/signal options. The authenticated role marker carries timeoutMs to the private routing provider; its separate enforcement seam must abort/dispose an expired child, penalize the route and retry once using the structured-output policy. Read-only roles retry by default; implementer retry requires `retryImplementer` plus a partial-edits warning. Direct workflow execution cannot enforce these limits without that provider seam. No runtime restart is performed by this change.

Timing reports: `node scripts/flow-report.mjs /path/to/session.jsonl.zstd` from the plugin; plain JSONL is accepted, compressed input needs zstd. The CLI is read-only and only reads the supplied file. Fastest-first model ordering is a captain-owned settings change, not recipe code.

## Note

The recipe does not commit, push or merge. It leaves the changes in the working tree for you to review.

## Graph

The interactive version: `graph/feature-pipeline.html` (source: `graph/feature-pipeline.workflow.json`). These diagrams are historical references from before 0.3.0: they do not depict the compact analysis specification fast path, default deterministic review union, or concurrent validation. See `script.js` for the current execution order.

```mermaid
flowchart TD
  setup --> requirements --> draft[design-draft] --> dreview[design-review]
  dreview -- NEEDS_REVISION · max 3 --> draft
  dreview -- APPROVED --> plan --> implement
  subgraph parallel
    ra[review-a · model 1]
    rb[review-b · model 2]
  end
  implement --> ra & rb --> aggregate
  aggregate -- NEEDS_REVISION · max 3 --> implement
  aggregate -- APPROVED --> validate
  dreview -. 3 iterations without approval .-> aborted
  aggregate -. 3 iterations without approval .-> aborted
```
