# bug-fix — saved defect repair recipe

## Purpose and flow

Use for a source-confirmed defect with a feasible regression test, not a new feature or speculative refactor. The compact flow is:

1. **setup** reads manifests and records exact existing repository-local verify commands. No guessed commands, installs or execution.
2. **analysis** reads the affected code, direct callers and tests, records current/expected behavior, exact file change scope, acceptance criteria and any security/deletion/API decisions. `not_reproducible` returns `ended`; it never claims a repair.
3. **implementer** writes and executes a regression **before production edits**. A qualifying RED has a nonzero integer exit code, `passed:false`, concrete evidence, `testExecuted:true`, and `failureKind:assertion|behavior`; syntax, setup, dependency and unknown failures are rejected. Then run the same regression command GREEN and every existing verification command.
4. **two independent reviewers** inspect actual code/RED evidence and rerun checks. Either missing report, rejection or high/blocker finding forces repair. Union merging is deterministic; same-id different problems survive. No aggregator model can overrule reviewers.
5. **validate** freshly reruns the regression and verification after the latest approved attempt, returning exactly one result per unchanged acceptance criterion. Missing, extra, duplicate or failing criteria cannot produce `completed`.

There are at most **three total implementation attempts**, including attempts interrupted for a decision. Resume retains original regression evidence, actual cumulative changed paths, command history, prior findings/review trail and attempt count. Review feedback is carried into the next attempt. The recipe reports partial changes on abort; it does not roll back dirty work.

## Inputs and host contract

Required `task` and absolute `repo`; host supplies `routingToken`. Host may supply a validated `cachedSetup` or verified `resume`/`decisions`. Do not invent model routes. Roles use saved tiers; implementer, reviewer and validator remain canonical strong roles. Review selection/executor exclusion belongs to host routing.

Stable decision ids and exact option labels are required. `needs_decision` returns questions plus host-compatible resume `{task,repo,round,setup,analysis,confirmedDecisions,changedPaths,commands,regression,attemptCount,reviewTrail,lastFindings,pendingDecisions}`. `analysis.scope` includes `files`, `tests`, `symbols`, `dependents` for host scoped freshness checks. The host stores the resume and obtains verified human answers. A mismatched task/repo or missing original answer is refused. Direct AsyncFunction tests pass answers directly only to exercise recipe logic; this is not authority to bypass host receipts.

Common final statuses: `completed`, `completed_with_failures`, `aborted`, `needs_decision`, `ended`. Results carry cumulative `changedPaths`, `commands`, `findings`, `reviewTrail`, validation and decisions; successful results also include regression and acceptance counts.

## Read-only and command-safety boundaries

Every agent uses only supported `label`, `phase`, `schema` options. Private prompt markers carry `{token,role,label,timeoutMs,readOnly}`. Initial setup/analysis have `readOnly:true`; the captain's host filter limits these to read/read_image/glob/grep/structured_output (no bash). Implementation marks `readOnly:false`. Review/validation also mark false to allow bash verification, but their prompts forbid edits. Their no-edit requirement is a **prompt restriction**, not a claimed read-only tool sandbox.

Changed-path reports are checked against exact diagnosis paths: absolute, traversal, glob, directory/trailing slash, backslash, colon or control-character paths fail closed before decision persistence. This checks **reported paths**, not a filesystem write sandbox or symlink containment. Reviewers must inspect actual changes for unreported edits. The recipe cannot independently prove that an LLM-reported RED really preceded edits; it requires explicit evidence and independent review rather than accepting any exit 1 as proof.

Commands are project-local verify commands read from manifests. Every execution step must inspect command definitions and refuse destructive/network installers or credentials. A bash-capable model can execute arbitrary commands; this recipe is not a shell-security sandbox. No commit, merge, push, deploy, dependency installation or destructive cleanup is authorized.

## Verification evidence

New test: `test/bug-fix-recipe.test.mjs` in the plugin. It loads this exact source into `AsyncFunction` with deterministic hooks and validates every mocked response against actual installed `validateJsonSchemaValue` schemas. It does not copy the source into a different implementation.

Runner used: `/Users/tariq/.local/share/deepseek-harness/node-v24.21.0-darwin-arm64/bin/node --test test/bug-fix-recipe.test.mjs`.

- Initial RED: **28 executed tests, 28 failures**, exit 1, because this new recipe capability did not yet exist (missing meta/script).
- Initial GREEN: **28/28**, exit 0.
- Late-resume regression RED: **38 tests, 37 pass / 1 fail**, exit 1; then preserved commands/RED evidence.
- Review regression RED: decision-before-scope and missing persistent repair budget reproduced (**43 pass / 2 fail**, 45 tests, exit 1). Explicit RED schema was expanded to require execution/failureKind evidence; the old schema could not satisfy the revised fixtures. Initial new discriminator negatives alone failed closed via schema mismatch, so they are not presented as semantic RED proof.
- Additional exact test-path scope RED: **46 tests, 45 pass / 1 fail**, exit 1; diagnosis test paths now must be concrete paths within the authorized change set.
- Final GREEN: **46/46**, 0 failures/cancelled/skipped/todo, exit 0, runner duration ~127 ms.

Fixtures cover RED→GREEN, no RED, no full verify, initial null/invalid scope, missing/rejecting/high-approved reviewers, exception handling, feedback union and cumulative paths, three-attempt cap across decision resume, exact final validation, final fresh command failure, partial-change abort, wrong task/repo and missing answers.

**No live-model run, live deployment, activation or whole-product coverage is claimed.** After this lane's implementation, independent review passed with 46/46 tests and separate RED/scope/resume probes. The captain created and checked `recipe.lock.json` against the final metadata/script. The approved-only catalog now discovers `bug-fix`, `code-audit` and the unchanged `feature-pipeline`. The existing live process/catalog may still need a safe user-approved restart to load the host changes; that was not performed.
