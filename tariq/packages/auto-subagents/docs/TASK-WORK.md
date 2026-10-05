# Persistent work plans

## Goal, plan and session tools

A task memory record owns the main objective. A linked work plan stores subgoals and concrete work items that contribute to them. Each item has a stable id, description, goal ids, write paths, optional read paths, acceptance criteria, verification commands, dependencies and an approved recipe. One item may serve several subgoals. Every declared subgoal must have assigned work; unknown ids, dependency cycles and unordered overlapping declared scopes are rejected.

The coordinator defines the plan with `task_memory` action `define_plan`, or runs the approved planning recipe with a task id. A completed planning result saves its checked packages as a new plan when none exists. It does not start implementation or replace an existing graph. Small work can use one subgoal and one item. Plan definitions can be replaced only while all items are pending and none has been attempted; started plans retain their acceptance and identity.

Existing DSH tools remain responsible for session behavior. The session goal drives continuing work under its existing human-input and activation rules; remembered objectives do not create, activate or complete it. The coordinator mirrors the persistent plan through `todo_write`: ready/waiting/blocked work appears as pending with dependency or blocker context, running work as in_progress, and completed work as completed. The todo projection clears at the next turn start, so the coordinator refreshes it from the plan. This mirror is model-directed, not an automatic mutation of DSH's goal or todo services.

Subgoal completion counts show reported work progress. They do not declare that the main objective is achieved. The coordinator checks current evidence against the whole objective before completing a session goal.

## Readiness and execution

`read_plan` reports work states, dependency readiness, goal coverage and the independent graph revision. Passing `itemId` returns the selected item's full scope and prior outcome. `define_plan`, `block_item` and `reopen_item` require the last observed graph revision. Note revisions belong only to note updates; the two counters are not interchangeable.

Stored states are pending, in_progress, blocked and completed. Pending work is ready when all its dependencies are completed; otherwise it is waiting. Readiness does not waive scope checks or verify that dependency results remain valid in the current repository. The coordinator inspects current inputs before continuing a remembered plan.

`run_recipe` accepts an optional `workItemId` together with `taskId`. Before cache lookup, resume claims or child admission, the host reserves the exact ready item and checks that the recipe matches. It supplies the saved description, acceptance, scopes and verification commands to the actual logged child prompts. Manual tools and note text cannot start or complete an item. Calls without a work item retain their existing behavior.

Cooperating claims share a canonical repository lock and check active reader/writer conflicts within and across task plans. Explicit disjoint scopes permit independent work; a missing read scope is unknown and conservatively conflicts with writers. An explicitly empty read array declares no reads. These reservations coordinate declared work; they do not confine actual filesystem effects or detect every alias. Each claim rechecks the stored paths and rejects observed symbolic-link components.

The host disposes owned workflow resources before recording the work outcome. A completed recipe whose acceptance gates report success can complete the item. Other outcomes, including cancellation, failed acceptance or a request for human decisions, block it. A literal write scope covers its exact relative path and segment descendants: `src` includes `src/a.js`, but excludes `src-other/a.js` and `src/../outside`. Admission conflicts and reported completion use the same containment rule. Reported changed paths outside the saved write scope prevent completion. Results explicitly remain recipe reports: unreported writes, semantic drift from acceptance and model-reported runtime receipts are not independently attested.

Items distinguish source_only evidence from runtime verification. Investigate and code-audit cannot claim runtime acceptance; runtime items require verification commands. This classification does not establish that commands executed. Stored criteria and evidence type guide recipe selection and review; model interpretation of the requested objective remains a limitation.

## Continuing and recovering

A fresh session reads the same explicit task and plan, checks current files and chooses ready work. The host retains the originating session and run identity for each attempt. Recipe resume tokens and verified human answers remain session-bound. For a blocked decision within the owning session, collect verified answers, inspect and reopen the item, then use the same recipe, request, repository and resume token. Another session starts fresh analysis instead of transferring that checkpoint.

`block_item` records a reason on idle work. `reopen_item` reopens executable blocked work or an interrupted attempt only when its owner is known inactive. Local attempts use a process-lifetime identity and live registry; foreign attempts require the owning process to be absent. Alive or unknown owners, reused process ids and unresolved cleanup prevent recovery. There is no timeout-based or force override.

If owned cleanup fails, the reservation remains live until the owning process safely stops. If outcome persistence fails after successful cleanup, the result reports `taskWorkSaved: false`; completed execution must not be repeated merely to save state. Inspect the durable session result and current repository before recovery or further verification. A work-item completion is not inferred from a note about that failed save.

## Persistence and bounds

Work plans use separate versioned `.work.json` records in the task memory namespace. Existing note format v1 remains unchanged. Plans and notes use the same private storage directory, canonical repository isolation and atomic writer machinery. In-process writes share a queue per exclusive lock; repository admission and task writes use distinct queues so nested acquisition can complete. Foreign locks remain exclusive, and note and graph revisions remain independently checked. The graph supports at most 20 subgoals and 20 work items; static item data is bounded to fit the logged work context. Repository admission has a bounded scan and fails explicitly when data or capacity cannot be checked.

Keyless native Session recordings exercise the actual task, goal and todo plugins, restored projections and fresh-session plan reads. Store tests exercise cooperating writers in separate processes. Recipe integration tests cover real local PTC execution and blocked admission. These establish local coordination and persistence, not external-model quality or a provider-backed product journey.
