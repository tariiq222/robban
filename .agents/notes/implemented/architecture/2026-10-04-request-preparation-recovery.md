# Agent Note: Request preparation recovery before input admission

Status: implemented

English | [中文](2026-10-04-request-preparation-recovery.zh.md)

## Problem

A routing plugin can choose a provider in `agent/request`, but adapter binding can fail afterward in `prepareCall()`. Stream recovery cannot observe that failure because no stream exists. Retrying the entire step would repeat input admission or completed tools, while resolving the adapter inside the routing listener would not bind the later call.

## Decision

The agent loop awaits `agent/request-prepare-error` for a non-aborted preparation `LlmError`. The agent-scoped waterfall carries the existing structured failure facts and returns `RequestErrorAction`. A retry reruns routing and adapter binding within the same step, retaining the accepted assembly and messages. Routing policy owns finite attempt limits; the loop supplies cancellation checks before and after recovery.

A listener that returns `undefined` without delegation terminates the failure. Calling `next()` preserves native handling: an unregistered route may still reach stream middleware. This distinction prevents an exhausted managed `NO_ADAPTER` route from silently entering compatibility streaming. Listener exceptions remain terminal, and neither cancellation nor non-LLM preparation errors enters recovery.

The [stream recovery decision](2026-06-21-bounded-llm-request-recovery.md) continues to own failures after streaming starts. The [external-event decision](2026-08-30-retain-ignorable-external-session-events.md) continues to own portable informational receipts; `Session.append()` preserves its existing `ignorable: true` envelope field without changing the Session format. Neither decision is superseded.

## Alternatives considered

**Reuse `agent/request-error`.** That event describes an admitted model request and its settled stream attempt. Preparation has no attempt stream or serving adapter retry policy.

**Bind the adapter inside `agent/request`.** A configuration listener cannot bind the adapter used by the later loop call. A second preparation can still fail.

**Retry the step or fall through after every `NO_ADAPTER`.** Repeating the step can replay completed tools; unconditional fallthrough can bypass a managed route's exhausted policy.

## Consequences

Recovery policy can change routes without admitting a failed request's input or replaying tools. Policy must stop requesting retries when its finite route budget is exhausted. Unknown informational events remain portable only when the producer explicitly marks them ignorable; the flag does not bypass validation of known event types.

Focused regressions cover routing, scope, cancellation, finite attempts, native compatibility, terminal failures, and immutable append metadata. The shared SDK scheduler-recovery scenario exercises preparation receipts through TypeScript and Python without duplicating user admission or completed tool results.
