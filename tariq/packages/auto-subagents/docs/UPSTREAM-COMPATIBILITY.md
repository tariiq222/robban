# Auto and upstream DSH

Auto keeps preparation recovery in its own LLM service provider and uses the original DSH Agent and AgentLoop sources. The complete plugin still needs one Session extension: `Session.append()` must preserve the envelope option `{ ignorable: true }`. The current unmodified DSH `0.2.1-alpha.1` writer drops this option, so installing the original npm runtime is not a supported replacement for Robban's runtime.

## LLM provider composition

The bundle disables the canonical `llm` row and inserts `dsh-auto-subagents/llm-provider`. Cordis waits for this provider before activating dependent adapters. The provider extends the public `LlmRuntime` class and retains its adapter registry, defaults, capabilities, retry metadata and one-shot prepared streams. The canonical base provider has no configuration to transfer; a future upstream configuration change needs a reviewed composition update.

Auto routing binds recovery to the exact request configuration returned by its `agent/request` listener. The provider consumes that binding once and uses the original `prepareCall()` to prepare either the requested route or an authorized alternative. The actual prepared route reaches DSH's header logging before model-visible input is admitted. Unbound requests use the original behavior. Cloned or replaced request objects do not inherit recovery. Cancellation, disposed routing owners and exhausted alternatives stop recovery. A managed terminal `NO_ADAPTER` failure retains its cause in an owned error, preventing the original loop's unregistered-middleware compatibility path from admitting that failed request.

The provider does not replace foreign adapter registrations, mutate the base service, use a virtual provider identity or wrap the prepared stream. A plugin mounted separately from the bundle must install this service provider before adapters; the routing plugin rejects the base provider rather than omitting preparation recovery.

## Remaining Session requirement

Auto's run, child and route records are informational custom events. Original DSH readers already accept their stored `ignorable` envelope marker, but the original public append method does not write it. Removing the option creates a live log that the persistence reader refuses to restore. Auto's host activation checks a detached temporary Session, including append and restore, before accepting that runtime. The probe does not modify user sessions or persist data.

The retained extension only exposes and preserves the existing envelope marker through append. It does not change the Session format, original events or model messages. Old Auto logs remain readable. Unknown required events remain rejected.

Official `tool/result.meta` can retain final presentation data, but it does not preserve progress before the tool finishes. Existing workflow lifecycle events do not represent all Auto phases, decisions and review reports. A separate journal would need its own live transport, reload and fork handling. Those alternatives are not equivalent replacements for the current card and native event history.

## Verification and updates

From the repository root, after building DSH:

```sh
node --test tariq/packages/auto-subagents/test/llm-provider.test.mjs tariq/packages/auto-subagents/test/llm-provider-composition.test.mjs tariq/packages/auto-subagents/test/compatibility.test.mjs
node --test tariq/packages/auto-subagents/test/pristine-upstream.test.mjs
```

The first command checks native preparation recovery, actual route logging, request isolation, cancellation, disposal and official Loader composition. A new keyless native Session recording preserves the preparation-fallback result and restored model messages. Historical recordings remain unchanged.

The second command resolves the fetched `upstream/master` reference once, archives that captured commit into a disposable directory and verifies source hashes and source resolutions before running native probes. It distinguishes successful preparation recovery with the original AgentLoop from the complete plugin's remaining Session requirement. These local scripted-provider checks do not establish external-provider acceptance or compatibility with an untested future upstream release.

DSH updates still enter through a reviewed source merge. [Robban's update procedure](../../../README.md#keeping-dsh-updates) owns fetching, candidate worktrees and acceptance. An upstream release that preserves this Session append option can remove the remaining source extension after the same roundtrip checks pass.
