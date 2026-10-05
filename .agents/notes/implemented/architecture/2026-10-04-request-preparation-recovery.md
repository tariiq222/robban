# Agent Note: Request preparation recovery before input admission

Status: implemented

English | [中文](2026-10-04-request-preparation-recovery.zh.md)

## Problem

A routing plugin can choose a provider in `agent/request`, but adapter binding can fail afterward in `prepareCall()`. Stream recovery cannot observe that failure because no stream exists. Retrying the entire step would repeat input admission or completed tools, while resolving the adapter inside the routing listener would not bind the later call.

## Decision

Auto's LLM service provider extends the public `LlmRuntime` and owns preparation recovery. Its routing listener binds a finite recovery policy to the exact configuration returned from `agent/request`; the provider consumes that binding once and calls the original `prepareCall()`. An authorized fallback returns the native prepared call for its actual provider, model, defaults and capabilities before the original AgentLoop admits input. Agent and AgentLoop require no preparation extension.

A bound policy that returns no alternative terminates preparation. A terminal managed `NO_ADAPTER` error retains its cause and failure facts in an owned error, preventing the original loop from entering unregistered-route middleware compatibility. Unbound requests retain native handling. Cancellation, disposed routing owners and non-availability failures stop recovery. The bundle substitutes the provider before adapters register, and routing refuses a base provider that cannot bind preparation recovery.

The [stream recovery decision](2026-06-21-bounded-llm-request-recovery.md) continues to own failures after streaming starts. The [external-event decision](2026-08-30-retain-ignorable-external-session-events.md) continues to own portable informational receipts; `Session.append()` preserves its existing `ignorable: true` envelope field without changing the Session format. Neither decision is superseded.

## Alternatives considered

**Reuse `agent/request-error`.** That event describes an admitted model request and its settled stream attempt. Preparation has no attempt stream or serving adapter retry policy.

**Bind the adapter inside `agent/request`.** A configuration listener cannot bind the adapter used by the later loop call. A second preparation can still fail.

**Extend the loop or disguise fallback behind a virtual provider.** A loop-specific hook adds upstream maintenance when the public service provider can own the same decision. A virtual route changes logged identity and can repeat stream middleware; the owned provider returns the original prepared stream unchanged.

**Retry the step or fall through after every `NO_ADAPTER`.** Repeating the step can replay completed tools; unconditional fallthrough can bypass a managed route's exhausted policy.

## Consequences

Recovery policy can change routes without admitting a failed request's input or replaying tools. Policy must stop requesting retries when its finite route budget is exhausted. Unknown informational events remain portable only when the producer explicitly marks them ignorable; the flag does not bypass validation of known event types.

Native Auto regressions and an isolated original-upstream probe cover routing, request identity, cancellation, finite attempts, native compatibility, disposal, terminal failures and unchanged input admission. A new keyless Session recording checks restored model messages and actual fallback headers. The existing Session extension remains necessary for live Auto telemetry; original upstream append drops its marker. These checks do not establish external-provider acceptance.
