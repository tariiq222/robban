# Auto integration on DSH 0.2.1-alpha.1

## Current state

Auto `0.4.0-dev.0` is integrated with `dsh-v0.2.1-alpha.1` for the local `master` branch. The original baseline is retained at the `robban-baseline-0.1.5-backup` tag. Personal settings and the installed 0.1.5 runtime have not been migrated. No remote push or live provider request is part of this acceptance.

The integration replaces six installed routing/settings/UI patches with Auto-owned delegation, live model settings and a settings editor. One source change remains necessary: ignorable Session append metadata. Preparation recovery belongs to Auto's public LLM service provider; Agent and AgentLoop source match upstream. The preset retains the newer Standard time-context and scheduling capability, including its child-agent scheduling deny list. The bundle registers its preset declaratively, uses PTC for workflows, initializes routing through `agent/created`, reads canonical tool messages and resolves declared package dependencies. Historical compiled patches are retained as evidence; their command-line application is disabled on this target.

On 2026-10-04, `upstream/master` was fetched from `deepseek-ai/deepseek-harness` at the DSH `0.2.1-alpha.1` release merge. It is an ancestor of this checkout: `HEAD...upstream/master` reports two Robban commits and zero missing upstream commits. Uncommitted runtime repairs remain in the working tree. No new upstream merge was needed or performed. The [update procedure](../README.md#keeping-dsh-updates) keeps future merges on a separate candidate branch and requires engine and Auto compatibility checks; fetching is not scheduled automatically.

## Verification

| Surface | Evidence |
|---|---|
| Target build | Host and Client TypeScript project builds, both tsdown passes, and `pnpm run build:web` passed on Node 24.21.0 after merging the newer master. Desktop packaging was not tested. |
| Auto package | 747 tests passed, zero failures/skips, with target-built packages. Covers routing, delegation, receipts, card rendering, all seven recipe bodies, real PTC execution, cancellation and single-use resume. |
| Engine | 65 focused Session append, request-preparation recovery and agent-loop regression tests passed after the merge. The newer master removes the old generated scope invariant files. |
| TypeScript SDK | The scheduler-recovery snapshot was refreshed to a v4 successor and replay passed through `dsh --profile sdk`. The committed v3 Session remains intact. |
| Python SDK | `sdk-recovery` refreshed and replayed with Python 3.11 against the built `dsh` CLI and a local scripted provider. This is not single-executable packaging acceptance. |
| Browser / Loader | Isolated Web booted at port 3181. Auto appears in the preset menu and can be selected. Its settings page renders, saves a model tier and retains it after reload. Auto uses English copy inside the installed bundle page; full application localization is deferred. |
| Recipe integrity | The integration initially preserved all 21 baseline files. Current user-authorized simplification updates bug-fix, refactor, feature-pipeline, investigate and plan-to-packages with reviewed integrity locks. Code-audit and qa-verify bodies and metadata retain their baseline. The approved catalog and actual PTC recipe execution are checked after each change. |
| Review | Separate read-only engine and Auto reviews completed. Removed client navigation APIs, locale registration and preview dotenv isolation findings were corrected. |
| Documentation | Initial doc-sync passed 38 of 43 gates. Type equivalence, graph freshness, budgets and repository references were repaired and checked separately. Private Robban README files have exact-path translation exclusions; maintained upstream pages retain bilingual pairing. Frozen historical patch payloads are exempt from the concrete-term check only when their pinned SHA256 matches. The architecture word budget is within its ceiling. |

Master integration logs are local under `/tmp/robban-master-*`; earlier migration logs remain under `/tmp/robban-v020-*`; the preview screenshot is `.artifacts/auto-migration/auto-settings.png`. These paths contain disposable verification evidence, not portable test dependencies.

## Run locally

Use Node 24 or newer. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
node tariq/packages/auto-subagents/build.mjs
node tariq/scripts/auto-preview.mjs
```

The launcher stores preview data under `.artifacts/auto-home`, defaults to port 3181, strips provider environment variables and refuses local dotenv files and provider credential records. It uses the seven approved repository recipes. Auto routing starts disabled; browser verification saved one tier in this disposable profile without making a model request.

## Remaining acceptance

- A complete provider-backed Auto journey, including spawn/fork execution, actual model labels, human answer-and-resume, stop/retry and reopening the run card, requires separately authorized provider access.
- The current UI is the existing run card plus functional English Auto settings; Robban-specific product design and desktop packaging remain later stages.
- The standalone plugin still requires the Session append extension; it cannot claim complete compatibility with unmodified upstream. [Upstream compatibility](../packages/auto-subagents/docs/UPSTREAM-COMPATIBILITY.md) owns the remaining requirement and preparation recovery.
- Private Robban READMEs retain their local language policy through exact-path exclusions; public release still requires a documentation policy review.
- Historical reference files contain installation-specific paths. They are not executed by the new plugin; review them before public publication.

## Runtime repairs on 2026-10-04

- Automatic selection, verifier fallback and recovery recheck the requested minimum model tier after asynchronous preflight. Explicit authorized routes retain their existing override behavior.
- Human decision receipts accept answers only to questions in the matching tool call and ignore malformed answer collections.
- Preset generation preserves canonical multiline prompt paragraphs and all plugin configuration. An internal variable in the investigate recipe uses the required concrete terminology; its result fields and logic stay unchanged, and its lock was renewed for the user-authorized repair.
- The offline preview validates plugin links, saved Auto routing and scalar Web interface settings and launch arguments, disables telemetry using the supported switch, and forwards termination to descendant processes. `--instance <safe-name>` selects a new `.artifacts/auto-home-<name>` without accessing an existing credential store. The launcher accepts a credential store containing only its own browser-session grant; provider records and malformed stores require a fresh instance.
- `scripts/migrate-settings.mjs` validates a copied legacy Auto settings section and creates a private, unapplied overlay without overwriting files or exporting unrelated settings. See [copied-settings conversion](../packages/auto-subagents/docs/DELEGATION-V020.md#copied-settings-conversion).
- The combined Auto, preset, build, settings-migration and preview suite passes 791 tests with no skips outside the command sandbox. The same environment's sandbox blocks child-process IPC, so its earlier 14 failures were not product failures.
- A fresh offline preview instance serves authenticated HTML with HTTP 200 on localhost and stops through process-group termination; no provider request was submitted. Engine recovery/cancellation/Session metadata tests pass 137 cases; historical migration/publication tests pass 34 cases. Read-only migration preserves source bytes and write migration publishes a successor. No personal Session migration or provider-backed request was performed.
- A recorded keyless native AgentLoop Session is validated and replayed through `Session.fromRestore`; its receipt regression rejects an answer to an unasked question after reload and accepts a later matching call. This is native-loop replay evidence, not a full shipped-profile provider journey.
- Final documentation checks pass: `test:docs` 21/21 and `doc-sync` 42/42. Full `lint:contracts-ready` passes after removing two redundant assertions in the agent-loop test; that test file passes 65 cases. The frozen lockfile passes supply-chain policy checks, and `git diff --check` is clean.
- Legacy V3 Auto events migrate to `plugin:auto-recipe/...`. Payloads survive, but the current card reader does not recognize that prefix. Card replay compatibility is queued for the final interface stage.

The routing measurement receipt is incomplete: the coordinator baseline was late and the local receipt ledger rejected participant attachment. Whole-task tokens and subscription savings remain unknown.

## Recipe simplification and method review

The user-authorized reduction merges read-only preparation in bug-fix and refactor, and uses a complete compact specification from feature analysis for local, decision-free changes to at most two canonical relative files. Successful fresh child counts change from six to five, seven to six and seven to six respectively. Source preparation uses authenticated read-only tool filters. Experiments, baselines, two parallel code reviews and final acceptance checks remain. Feature final validation accounts for every planned command with a fresh receipt; missing, duplicate, extra, failed or insufficient receipts prevent completion. These receipts are model reports, not independent proof of execution.

Investigate explicitly returns source-only evidence and leaves the runtime cause unverified. Package planning now offers all appropriate non-recursive recipes and permits source-only plans without invented writes or commands. [The method assessment](../packages/auto-subagents/docs/WORKFLOW-V020.md#recipe-method-assessment) records the valid conclusion and limitation of each recipe.

The combined Auto, preset and preview suite passes 849 tests with no failures or skips. All seven current scripts execute through real PTC processes; bug-fix and refactor integration fixtures also run local Node commands for actual qualifying RED/GREEN and untouched baseline evidence, with a scripted provider. Six new native AgentLoop Session recordings check generated preparation, investigation, planning and final validation prompts, real local source reading, structured-output schemas and restored message projections. Later feature command receipts in those recordings are scripted and explicitly identified as such. These checks do not establish external-model quality, installed child-tool execution end to end, latency or token savings.

## Task memory and selected stage methods

Auto mounts a persistent task-memory tool and admits it to the coordinator. Explicit task identities retain bounded notes across turns and fresh sessions, with canonical repository isolation and revision-checked writes. Recipes accept a task id, include selected historical context in each child's logged prompt and save a bounded outcome without copying human answers or resume tokens. Session-bound decision and checkpoint validation remains intact. [Task memory and stage methods](../packages/auto-subagents/docs/TASK-MEMORY.md) owns configuration, limits and the continuation procedure.

Three bundled methods cover evidence, independent review and design dependencies. Authenticated stages receive at most two methods from fixed hash-checked package files without widening read-only tools or adding recipe stages. New keyless native Session recordings exercise actual public plugin mounting, persistent task creation and updates after full context disposal, coordinator policy publication, and exact method/context prompt restoration. Independent review corrected preset-scope lineage detection and a concurrent atomic reader race; no remaining blocker was identified. These recordings establish local persistence and logged inputs, not external-model improvements or provider-backed acceptance.

The final combined Auto, preset and preview suite passes 904 tests with no failures or skips. Memory checks include repository isolation, cooperating writers, revision conflicts, bounded reads, source-stage restrictions, persistence failures, cancelled outcomes and same-task use across fresh sessions. The generated preset preserves the canonical plugin rows and mounts the public task-memory export.

Documentation checks pass 21/21, the full `lint:contracts-ready` check passes, and Markdown wrapping and `git diff --check` are clean. A package dry run includes the memory modules, three bundled methods, owning documentation and generated preset. After capturing immutable task/session identities, the two affected cross-session and concurrent-write checks pass again.

## Persistent subgoals and work items

Task memory now attaches a durable work graph with explicit subgoals, assigned packages, criteria, declared scopes and dependencies. Repository-scoped claims reject unmet dependencies, duplicate starts and conflicting cooperative writers or readers across task plans. Unknown read scopes serialize conservatively against writers. Recipe outcomes settle only after owned resource disposal; cleanup failures retain their live reservation. Note text cannot start or complete an item, and resumed work retains the existing session-bound answer checks.

The coordinator uses existing DSH goals for same-session continuation and todos as a refreshed turn-local mirror. Neither tool is replaced, and remembered context cannot activate a session goal. New native keyless recordings show goal creation from current human input, todo reset and refresh, and plan restoration in a fresh session whose session goal remains empty. [Persistent work plans](../packages/auto-subagents/docs/TASK-WORK.md) owns the data limits, recovery behavior and the distinction between reported completion and independently established acceptance. The frontend remains deferred.

The final combined Auto, preset and preview suite passes 948 tests with no failures or skips. A gated PTC integration admits two independent children before either finishes, then checks both durable completions and resource disposal. Store tests cover local concurrent claims, independent plans, recovery after a rejected mutation and a race between two real processes. Native agent tests permit the coordinator under its preset scope while rejecting delegated agents' plan and note mutations, including children without lineage markers in their session header.

Documentation checks pass 21/21 and the full `lint:contracts-ready` check passes. Markdown wrapping and `git diff --check` are clean. The package builds, and a package dry run contains the work store, ownership guard, memory modules, selected methods, owning documentation and generated preset. This work adds private plugin modules and reuses existing DSH goal and todo tools without introducing another engine extension. The later compatibility work below reduces the earlier two extensions to one.

## Preparation recovery without an engine extension

Auto now substitutes a public LlmRuntime service provider through official bundle composition. Recovery owns only exact bound Auto requests and returns the original prepared call for the actual fallback route; unmanaged requests retain original behavior. Agent and AgentLoop production sources match the fetched upstream reference. The preparation-error event, its engine implementation and its engine-only tests are removed. The existing decision note now locates recovery in Auto's provider.

The combined Auto, preset and preview suite passes 966 tests; focused original AgentLoop and retained Session append tests pass 73 cases. A separate source-archive test executes six scenarios against the captured `upstream/master` commit and audits every DSH workspace import to the archive's source. It proves preparation fallback, bounded exhaustion, refusal of non-availability recovery and unchanged unmanaged middleware behavior. Eleven provider tests also cover cancellation, isolated sibling requests, disposed recovery owners and a new native Session recording that replays the actual route and task once. Three composition tests cover official patch application, public exports and Loader dependency ordering.

The full Auto host still requires the Session append extension. A detached activation probe rejects an original writer that drops `ignorable`, before creating user-session telemetry. The pristine-source test explicitly checks this refusal and the original reader's support for incoming marked events; it does not claim full Auto compatibility with an unmodified runtime. [Upstream compatibility](../packages/auto-subagents/docs/UPSTREAM-COMPATIBILITY.md) owns the supported provider and remaining limit.

A fresh credential-free profile boots through the supported source CLI and serves authenticated HTML with HTTP 200, then stops cleanly. The preview launcher's global pnpm invocation first failed on environment package-manager setup; the direct source CLI bypassed that launcher issue without changing product behavior or making provider requests. The package builds, and a package dry run contains the new provider, compatibility probe, bundle patch and owning reference. UI design remains deferred.

The full `lint:contracts-ready` check passes with one worker after a concurrent run exceeded the environment's memory limit. The initial `doc-sync` run passes 39 of 42 checks; its three failed checks pass independently after regenerating event graphs, replacing a prohibited fixed commit reference with a captured upstream reference, and running the host build and documentation typecheck separately. That typecheck compiles 78 blocks. A fresh built-artifact smoke passes 19 provider, Loader, Session compatibility and streamed-recovery cases. Pairing, Markdown wrapping and `git diff --check` pass. The fetched upstream comparison reports no missing upstream commits.
