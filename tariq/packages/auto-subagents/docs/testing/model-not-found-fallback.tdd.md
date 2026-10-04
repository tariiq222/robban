# Auto Subagents model-not-found fallback regression

## Scope and incident evidence

Journey: an Auto child whose provider no longer serves its selected model should continue the same task on an allowed same-tier or stronger model, without manual model-list changes or tool replay.

Recorded child: `0ada6f3d-0a98-44a6-af1b-b1c12c5d25f9`, parent `session-13bc14ca-a46d-4b1e-b986-a4f1498d5a53`, in `home/sessions/--Users-tariq-code-nasq--/`. Session header identifies `origin: subagent`, `agentPreset: auto-subagents`. Request header selects `xkiro/deepseek/deepseek-v4.1-flash:free`. At decoded line 18, `assistant/attempt` finish reports:

```json
{"code":"PI_AI_ERROR","message":"404: {\"message\":\"Model \\\"deepseek/deepseek-v4.1-flash:free\\\" does not exist.\",\"type\":\"not_found_error\",\"code\":\"not_found\"}"}
```

Line 20 terminates the turn with the same code. There are no `auto-subagent/route` or `auto-subagent/exhausted` records in this child. Other recent children show the same envelope for DeepSeek and `moonshotai/kimi-k3`. This is missed availability classification, not proof that all candidate routes were exhausted.

The installed `dsh-llm-pi-ai/lib/index.js` classifier (lines 1366–1376) handles auth, quota, 400, 5xx and transport failures but leaves 404 as `PI_AI_ERROR`. The package whitelist recognizes `HTTP_404`, not this adapter's actual code. Core request-error dispatch already exists and needs no patch.

## Narrow change

`lib/router.mjs` recognizes only `PI_AI_ERROR` with a parseable `404:` JSON envelope, `type: not_found_error`, `code: not_found`, and an exact `Model "…" does not exist.` message. Everything else retains its prior classification. Existing bounded routing, same-tier/upward-only policy, history preservation and route telemetry remain unchanged. No settings, allowlist, core artifacts, running servers or model endpoints were changed.

## RED / GREEN evidence

- First `node --test test/legacy/router.test.mjs test/legacy/runtime.test.mjs`: **59 passed, 2 failed**, exit 1. New classifier test received false instead of true; request-error hook returned undefined instead of retry.
- Same command after fix: **61 passed, 0 failed**, exit 0.
- Native-loop test expanded to the incident envelope as well as QUOTA. Temporarily restoring the old classifier behavior produced **1 passed, 1 failed**, exit 1, with the incident `LlmError`/`PI_AI_ERROR` at the installed native agent-loop seam. Restored the fix immediately.
- Final `npm test`: **186 passed, 0 failed, 0 skipped**, exit 0.
- `node --test /Users/tariq/.local/share/deepseek-harness/home/.agent-presets/auto-subagents/auto-subagents.test.mjs`: **4 passed, 0 failed**, exit 0.
- `node --test --experimental-test-coverage test/*.test.mjs test/legacy/*.test.mjs`: **186 passed**; aggregate **98.75% lines, 81.90% branches, 93.37% functions**. Router: **99.62% lines, 93.94% branches, 100% functions**; runtime: **100% lines, 88.89% branches, 100% functions**.
- `node --check` on router and the three changed test files: exit 0.

| Guarantee | Test | Type | Result |
|---|---|---|---|
| Actual structured pi-ai 404 model-not-found is retryable, including wrapped failure | legacy/router.test.mjs | Unit | PASS |
| Arbitrary pi-ai errors, malformed JSON, file/endpoint errors and invalid requests are not newly retryable | legacy/router.test.mjs | Unit | PASS |
| Same child switches through alternatives once, then records genuine exhaustion | legacy/runtime.test.mjs | Hook integration | PASS |
| Installed native loop retries same child, admits task once and never executes partial/replayed tools | legacy/native-loop.test.mjs | Offline native integration | PASS |
| Existing upward-only tiers, explicit routes, workflow adoption and coordinator restrictions remain compatible | Full suite + Auto preset suite | Regression | PASS |

## Known limits

No live model requests were made, and port 3080 was not restarted. Tests use the installed native loop with fake provider streams. Already loaded Node modules are not updated in place; activation for an existing server requires a separately authorized restart. No browser bundle build was needed because this change affects an imported server-side `.mjs` module only. There are no configured lint/typecheck scripts for this package. No commits were made, as requested.
