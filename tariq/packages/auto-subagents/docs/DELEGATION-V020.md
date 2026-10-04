# Auto delegation on DSH 0.2.0

## Summary

Auto delegates through the public subagent service using live saved model authorization. Spawn starts with a self-contained prompt; fork inherits completed parent turns. Both use the same router, tier priorities, active-load counts, and executor-route records.

## Contents

- [Composition](#composition)
- [Routing and ownership](#routing-and-ownership)
- [Saved settings](#saved-settings)
- [Verification](#verification)

## Composition

The Host entry `auto-model-selection` loads [model-selection.mjs](../lib/model-selection.mjs) and provides the singleton service `subagentModelSelection`. The isolated Auto profile must remove the stock `subagent-model-selection-settings` Host row before installing this service. Its volatile config fields are `enabled`, `allowedModels`, and `modelTiers`; the settings editor addresses the `auto-model-selection` entry.

The Auto preset loads [delegation.mjs](../lib/delegation.mjs) twice: `provider: spawn`, `toolName: subagent`, `registerModelDiscovery: true`; and `provider: fork`, `toolName: subagent_fork`, `registerModelDiscovery: false`. Both use `backgroundMode: continuable`. Discovery has one owner. The stock consumers stay available in other presets.

The plugin requires `tools`, `subagents`, `systemPrompt`, `llm`, and `agents`, and fails activation if the Host settings owner is absent. Runtime modules resolve declared public package exports through [dsh-paths.mjs](../lib/dsh-paths.mjs). Configuration also accepts `maxDepth`, `persona`, `toolFilter`, and `agentOptions.maxTokens`. Omitted depth reads the current Host depth policy at each delegation.

## Routing and ownership

Every call uses [router.mjs](../lib/router.mjs). Disabled or empty authorization rejects creation, including explicitly named routes. Route resolution checks saved authorization again after asynchronous model preflight. A replaced subagent provider rejects the call before creation. Model selection and verification evidence are appended to the parent Session as `auto-subagent/selected` with the ignorable envelope flag.

Continuable calls transfer ownership to `subagents.startContinuable()` and return `{ kind: 'continuable', subagentId }`. Foreground calls use `subagents.start()` and return `{ kind: 'foreground', runId, output }` only after successful settlement and disposal. Cancellation, abnormal stop reasons, and infrastructure failures remain failures; foreground diagnostics retain partial text and independent disposal errors. Auto does not expose one-shot background Jobs.

The router reserves load before model preflight. Failed admission releases it. Continuable adoption reconciles an already-idle or disposed child, and route changes during startup update the adopted route. [runtime.mjs](../lib/runtime.mjs) owns later status, disposal, and recovery events: idle releases load, a new running interval reacquires it, and disposal releases the current route. Foreground settlement releases the current route even after recovery switches models. Executor-route records remain available for later `verifies` calls.

## Saved settings

[migrateLegacyModelSelection(section)](../lib/settings-migration.mjs) validates the legacy `subagent-model-selection` section and returns detached fields for the `auto-model-selection` entry. It preserves allowed-model order, provider/model identities, tier assignments, and disabled or empty authorization. Tier assignments outside the allowed list remain saved but authorize no route. Malformed fields, duplicate route pairs, and unsupported tiers reject conversion. The function performs no filesystem writes; the migration caller owns reading a copied source and applying the returned fields.

The Host `current()` method uses the same validation and returns detached lists from volatile config. An enabled empty list remains empty and blocks delegation; reading or migration never invents an authorized route.

## Verification

Run the focused policy tests from the repository root:

```sh
node --test tariq/packages/auto-subagents/test/delegation-v020.test.mjs tariq/packages/auto-subagents/test/model-selection-v020.test.mjs
```

These tests exercise the Auto policy through service doubles. The legacy integration test imports the actual exported tool constructor and settings service once target dependencies are built. Loader composition, real provider execution, settings-editor persistence, and continuation cold resume require the integrated target acceptance suite.
