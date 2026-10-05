# Auto recipes on Robban DSH 0.2.1-alpha.1

## Summary

Auto recipe integration fixtures use the public PTC workflow engine and Node process runtime. The seven saved recipes retain integrity locks covering their current scripts and metadata. The offline suite exercises all seven saved bodies through real PTC processes with scripted child answers; [current acceptance](../../../docs/AUTO-V020-STATUS.md) distinguishes this evidence from provider-backed operation.

## Table of Contents

- [Runtime composition](#runtime-composition)
- [Focused acceptance](#focused-acceptance)
- [Recipe method assessment](#recipe-method-assessment)
- [Limitations](#limitations)

## Runtime composition

The [test fixture](../test/helpers/ptc-runtime.mjs) mounts Cordis, Sessions, Session Projections, local filesystem and subprocess services, the local sandbox, Sandbox Policy, Node PTC Runtime, Subagent Runtime, and Workflow PTC. It uses the public package exports. The Node PTC runtime requires its built process entry as well as its main module. Tests use a private temporary workspace and dispose workflow runs and the owning Cordis context before removing it.

The child provider supplies deterministic offline answers. The workflow program itself executes in the real PTC process; no model provider is contacted. `run_recipe` registers a private routing provider for each invocation and passes its name through `subagentProvider`. The PTC engine resolves that provider before starting the program. Workflow metadata remains restricted to name, description, whenToUse and phases; approved recipe extensions stay in the recipe loader.

## Focused acceptance

Build the declared target dependencies before process tests. The focused files are:

| Test | Evidence required |
|---|---|
| `recipe-engine-meta.test.mjs` | Metadata projection, a structured PTC child, cancellation cleanup, checkpoint resume and single-use consumption |
| `recipe-workspace.test.mjs` | Rejection before admission for invalid workspaces; real PTC execution for matching directories and symlink aliases |
| `new-recipes-worker.test.mjs` | All seven current saved bodies through `run_recipe` and PTC, selected routes, read-only filters and private-provider removal |
| `seven-recipes-catalog.test.mjs` | Approval integrity, discovery and target metadata validation for all seven recipes |

The focused invocation from the package directory is `node --test test/recipe-engine-meta.test.mjs test/recipe-workspace.test.mjs test/new-recipes-worker.test.mjs test/seven-recipes-catalog.test.mjs`, with `DSH_AUTO_RECIPES_DIR` pointing to the copied recipe directory. Use Node 24 or newer and the package's declared dependencies. Process execution must permit inherited IPC descriptors; command sandboxes that block child processes cannot establish PTC acceptance.

## Recipe method assessment

A recipe is appropriate when its stages establish the evidence its result claims. Source inspection, executed regression tests, bounded acceptance checks and planning consistency are different kinds of evidence. A checker inspects the current source and evidence independently of the implementer's reasoning; model diversity does not make correlated reports statistically independent or guarantee truth.

| Recipe | Current method | Valid conclusion and remaining limit |
|---|---|---|
| [bug-fix](../../../recipes/bug-fix/README.md) | One read-only preparation, regression RED before production changes, GREEN with the same command, two parallel reviews, fresh final verification | The specified regression and acceptance checks passed. A source diagnosis is a candidate until RED; it does not establish every cause of an incident. |
| [refactor](../../../recipes/refactor/README.md) | One read-only preparation, untouched GREEN baseline, scoped restructuring, two parallel reviews, fresh invariant verification | The declared invariants remain satisfied under the selected checks. Passing tests do not establish complete behavioral equivalence. |
| [feature-pipeline](../../../recipes/feature-pipeline/README.md) | Source analysis includes a compact specification for local, decision-free changes to at most two files; other changes retain requirements/design/plan. Implementation has two parallel reviews and exact final acceptance and command accounting. | The declared acceptance criteria and verification commands passed. File count alone does not establish low risk; compact specifications must state local impact and valid command evidence. |
| [investigate](../../../recipes/investigate/README.md) | Bounded source scope, competing hypotheses, independent source checking and a proposed discriminating observation/test | A source proposition is supported, rejected or inconclusive. The result explicitly leaves the runtime cause unverified; incident diagnosis needs the proposed reproduction or observation. |
| [code-audit](../../../recipes/code-audit/README.md) | Bounded scope, parallel security/correctness scans, independent evidence checking and retained unresolved findings | A limited source audit report. An empty finding list does not certify the repository clean, and a source finding is not an executed exploit. |
| [qa-verify](../../../recipes/qa-verify/README.md) | Discover explicit acceptance and command definitions, verify, independently account for every criterion | Source claims require inspected evidence; runtime claims require command results. Missing, failed or blocked criteria cannot be reported as passed. |
| [plan-to-packages](../../../recipes/plan-to-packages/README.md) | Ground goals in source, draft cohesive packages, check goal accounting, dependency cycles and parallel write scopes independently | A structurally consistent plan, without implementation. Recipe suggestions need a currently approved matching recipe; disjoint writes alone do not establish safe concurrency with dependent readers. |

The reduction combines preparation stages that inspect the same repository facts. It preserves experiments, untouched baselines and independent final checks. The compact feature path removes a separate specification child only when analysis supplies all required fields; incomplete, risky or unresolved inputs retain the full path. Initial successful runs use five children for bug-fix, six for refactor and six for a compact feature, excluding retries and cached setup. These are structural counts, not measured latency, token savings or real-model success rates.

Users describe the task in ordinary language. The coordinator chooses the fitting approved recipe; stages execute automatically. Recipes keep unknown facts and unresolved user-owned decisions explicit rather than asking for approval at every stage or silently inventing answers.

## Limitations

These fixtures exercise real PTC execution with scripted child answers. They do not establish real-model behavior, a live profile upgrade, physical sandbox enforcement in restrictive modes, or fresh-child structured-output recovery against the full in-process agent stack. The migration does not replace existing focused router and lifecycle tests.
