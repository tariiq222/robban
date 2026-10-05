# tariq/ — سجل كل تعديل على ملفات upstream

| commit | الحزمة | الوصف | مرشّح PR؟ |
|---|---|---|---|

| Current retained extension | `core/session`, owning README and generated API docs | Preserve the existing ignorable envelope marker when appending Auto events. Host activation checks detached append and restore. | Required by current upstream writer; provider-backed acceptance pending |

| Preparation recovery moved into Auto | `tariq/packages/auto-subagents/lib/llm-provider.mjs`, bundle composition | Public LlmRuntime provider owns bounded preparation recovery. Agent and AgentLoop sources and APIs match upstream; the local preparation-error hook is removed. | Native and pristine-upstream verification |

| Runtime repairs | `scripts/verify-concrete-terms`, translation pairing manifest, architecture docs, `core/agent-loop` tests | Keep immutable historical payload exceptions hash-scoped, preserve local Robban documentation policy, and remove two redundant test assertions. | Fork maintenance |
