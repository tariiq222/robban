# Auto Subagents compatibility with DSH 0.2.0-rc.2

The execution status is tracked separately in [migration status](AUTO-V020-STATUS.md).

## Summary

Auto Subagents 0.3.0 cannot run unchanged on DSH 0.2.0-rc.2. None of the twelve installed-file patches has a complete upstream replacement. Six routing/settings patches can instead become plugin-owned functionality; four preparation-error patches represent one missing engine extension point, including generated metadata; two Session patches represent one missing append option. Additional preset, workflow, lifecycle and message-format changes require adaptation inside Auto.

This is a source compatibility audit, not runtime acceptance or an implemented migration. Preserve the working 0.1.5 installation and the current Robban baseline while preparing an isolated target environment. A fully external plugin on unmodified upstream 0.2.0-rc.2 is not established: the two engine changes below remain required by the proposed approach.

## Evidence and scope

- Audit date: 2026-10-04.
- Robban HEAD: `tariq/baseline-0.1.5`, plus the uncommitted 0.3.0 synchronization and documentation edits.
- Target: [`dsh-v0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2). The local tag matches `git ls-remote upstream refs/tags/dsh-v0.2.0-rc.2`; the target package manifest declares 0.2.0-rc.2.
- Patch inventory: [manifest](../packages/auto-subagents/core-patches/manifest.json), comparing every original/patched pair with target source. Target paths below refer to this immutable commit, not the current checkout.
- An independent read-only review covered the six delegation/settings/UI patches. The coordinator inspected the other six and the integration dependencies.
- The earlier 728 passing tests exercise Auto against the installed 0.1.5 runtime. They do not prove compatibility with 0.2.0.

## Twelve-patch disposition

| Patch ID | Target evidence | Required treatment |
|---|---|---|
| `tool-subagent` | `packages/subagent/tool-subagent/src/index.ts:400–419,478–512,620–646`: explicit route controls and session-sampled allowlist; no Auto tier/verifies/reservation admission | Port the behavior into an Auto-owned delegation consumer for both spawn and fork, using the public subagent service. Preserve live authorization, upward-only fallback and verifier exclusion. |
| `tool-subagent-types` | Same source, lines 48–131: no `automaticModelSelection` or `registerModelDiscovery` options | Generate declarations from the Auto consumer; do not copy patched declarations over upstream files. |
| `model-selection-settings` | `packages/subagent/tool-subagent/src/model-selection-settings.ts:28–57`: volatile config references, enabled/allowedModels only | Define plugin-owned live configuration that also represents tiers; adapt router access and settings migration. |
| `model-selection-settings-types` | Same source, lines 20–33 | Derive types from the new configuration owner; old declarations do not describe the target implementation. |
| `agent-loop` | `packages/core/agent-loop/src/agent.ts:547–598`: prepareCall catch has only native NO_ADAPTER handling | Add a typed, bounded preparation-error recovery extension before model-visible input admission. The existing request-error hook runs after stream failure and cannot cover this point. |
| `agent-runtime-types` | `packages/core/agent/src/runtime-types.ts:353`: stream request-error exists; preparation-error event absent | Declare the new event with complete scoped dispatch and waterfall documentation. |
| `scope-invariant` | `packages/core/scope/src/scoped-events.generated.ts:11–22`: no preparation-error resolver | Regenerate from the typed event declaration using `gen-scoped-events`; do not patch the compiled invariant. |
| `tool-cordis-metadata` | `packages/extensions/tool-cordis/src/api-catalog.ts:1–13`: generated API catalog | Regenerate with `gen-cordis-api` after adding the event; do not hand-edit the compiled bundle. |
| `session` | `packages/core/session/src/index.ts:722–750`: append copies surface metadata but drops ignorable | Add validated `ignorable?: true` preservation to append. The target already reads that envelope field; declaration-merging Auto event names alone does not make external-client history portable. |
| `session-types` | Same append signature, lines 722–726 | Add the matching optional append field to source types and generate declarations. Preserve mandatory surface intent for message events. |
| `settings-ui-client` | `packages/client/ui-settings-plugins/src/client/index.ts` owns tab composition; subagent settings moved to `packages/client/ui-settings-subagent/src/client/index.ts:62–92` | Build an Auto-owned settings page through configForms/plugins.item. Reuse the existing card concept without overwriting upstream's browser bundle. |
| `settings-ui-card-types` | `packages/client/ui-settings-subagent/src/client/subagent-model-selection-card-controller.ts:9–36,279–286`: new namespace and no tier field | Generate the Auto page's client types from its own model; do not apply the old card declarations. |

The preparation-error change must preserve unhandled native behavior, abort propagation and finite route attempts, with no replay of completed tools. A terminal managed NO_ADAPTER must not fall through into native compatibility streaming. Calling resolveCallConfig inside the existing request hook is not equivalent: target `packages/llm/llm/src/index.ts:936–940` binds a later adapter call that can still fail.

## Integration blockers beyond the patch inventory

### Preset installation

The target replaces directory-scanned `dsh-agent-presets` with `dsh-agent-preset-registry` plus declarative `dsh-agent-preset` rows. The registry no longer scans `home/.agent-presets`. Package the Auto composition as a bundle insertion, following `packages/bundle/web-app/presets/standard.patch.yml`. `agentPresets.composedPreset()` still exists at registry `src/index.ts:290`, so Auto's preset identity check can remain after registration is adapted.

### Workflow execution

The target removes `dsh-workflow-worker-thread` and supplies `dsh-workflow-ptc`. Its `src/index.ts` requires the Node PTC runtime and sandbox policy. The script helpers and WorkflowStartRequest remain broadly similar, but execution, JSON transport, cancellation and cleanup move to a sandboxed process. Replace the preset engine row and worker-specific tests; prove recipe results, private routing, timeout cleanup and resume under PTC. Do not keep the old worker package merely to conceal the migration.

### Agent initialization

The target removes `agent/session-start`. `packages/core/agent/src/runtime-types.ts:247–261` defines awaited serial `agent/created` with `source` and optional cancellation instead. Auto `lib/runtime.mjs` currently initializes managed route state on the removed event, so fallback would not initialize correctly. Port initialization to the new lifecycle and test startup, resumed agents, fork admission and disposal. Preserve the existing intentional startup-only behavior unless a separately reviewed change broadens it.

### Human decision receipts and Session v4

The target uses Session format 4 and first-class tool-role messages. `packages/llm/llm/src/message.ts:299–306` puts text blocks directly in message.content and isError on the message. Auto's [decision receipt reader](../packages/auto-subagents/lib/decision-receipt.mjs) expects nested tool-result blocks and therefore misses valid target answers.

A coordinator-run Node probe passed the same successful answer to the current reader in both formats: the old nested fixture returned the answer; the target-shaped fixture threw `No verified human answer`. This is a synthetic compatibility diagnostic, not a live Session migration test. Update the reader against target canonical records and preserve rejection of failed results, foreign question IDs, missing answers and coordinator-supplied decisions. Exercise official v3-to-v4 migration on copied fixtures, never on the working installation's Session files.

### Saved settings

The target settings import matches old settings sections to entry IDs; its documentation retains rejected sections in settings.yaml.imported. Auto uses `subagent-model-selection`, while the new stock page uses `subagent-model-selection-settings` and has no modelTiers. Automatic import cannot be assumed to preserve Auto policy. Use an explicit validated conversion on copied settings, retaining allowed-model order, provider/model identity, tiers and the disabled/empty state. Keep source data intact until acceptance.

### UI and packaging

The target still exposes the conversation.chat.node slot and Conversation event registry, so the existing run-card design is reusable. This does not establish compatibility of injected hooks, pending interaction answers or session navigation. Verify them through the target browser before declaring acceptance. Replace absolute installed-runtime module discovery with declared package dependencies/peer dependencies where appropriate, preserving one host instance for services, tools and error classes. Auto 0.3.0's current handwritten lib modules are source, not build outputs.

## Recommended execution sequence

| Stage | Deliverable | Acceptance before proceeding |
|---|---|---|
| 1. Isolated target | DSH 0.2.0-rc.2 checkout and separate home/profile/port; fixture credentials/settings only | Stock Web starts; no paths resolve to the working home or Session store. Keep the baseline as the comparison reference. |
| 2. Minimal engine support | Preparation-error event plus ignorable append option; generated resolvers/catalogs/types | Focused failure, abort, event-scope and persistence round-trip tests; required TS/Python SDK and keyless snapshots for the changed interfaces. |
| 3. Auto bundle integration | Declarative preset, Auto delegation/config owner, PTC workflow wiring, lifecycle and receipt adaptations | Loader activation; spawn and fork; live routing and cancellation; settings conversion from fixtures; all seven recipe locks and recipe execution tests. |
| 4. Existing UI acceptance | Tier settings page and current replay-driven run card | Save/reload, unavailable routes, actual model labels, answer-and-resume, stop/retry, refresh/reopen; one complete real-provider journey with explicit execution authorization. |
| 5. Robban UI design | Product-specific Web layout using the accepted plugin/event interfaces | Separate agreed design and visual acceptance; desktop packaging remains later work. |

Target provider candidates from the prior registry check are subscriptions 0.9.7 and CommandCode 0.12.3. Recheck their exact manifests during target installation; registry compatibility declarations are not runtime evidence. Do not select CommandCode latest blindly: 0.12.4 targets 0.2.1-alpha.1.

## Decision and remaining evidence

Proceed toward a target-specific Auto plugin on an isolated 0.2.0-rc.2 environment. Avoid spending a full implementation cycle porting every installed patch into 0.1.5 before repeating the migration. This is a proposed revision to the older two-stage implementation sequence in [PLAN.md](PLAN.md), not an executed upgrade or a replacement of its other accepted product decisions.

No live runtime, profile, credentials, settings or Session data changed during this audit. No target build, target full suite, browser acceptance or live provider request ran. Existing uncommitted synchronization work remains in place. The bilingual README requirement reported earlier is separate from these runtime compatibility blockers.
