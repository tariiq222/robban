import { automaticRouter, isAvailabilityFailure, routeConfig, routeKey } from './router.mjs';
import { AUTO_PRESET, presetOf } from './coordinator.mjs';
import { runtimeModuleUrl } from './dsh-paths.mjs';
// Same file URL as the host's dsh-llm → same ESM instance (LlmError identity preserved).
const { boundContextSummary, createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));

// Model routing and provider fallback for Auto subagents. Role policy lives in coordinator.mjs.
export const name = 'auto-subagent-routing';
export const inject = ['agents', 'llm', 'subagentModelSelection'];

export function apply(ctx) {
  if (typeof ctx.llm.bindAutoPreparation !== 'function') throw new Error('Auto routing requires the auto-subagents LLM service provider; replace the base llm entry with dsh-auto-subagents/llm-provider');
  const router = automaticRouter(ctx.subagentModelSelection, ctx.llm);
  const managed = new WeakMap();
  let routingActive = true;
  ctx.effect?.(() => () => { routingActive = false; });
  const assertRoutingActive = () => {
    if (!routingActive) throw new Error('Auto routing was disposed during preparation');
    ctx.fiber?.assertActive();
  };
  ctx.on('agent/created', ({ agent, source }) => {
    if (source !== 'startup' || agent.session.header.origin !== 'subagent') return;
    if (presetOf(agent) !== AUTO_PRESET) return;
    managed.set(agent, { route: { provider: agent.options.provider, model: agent.options.model }, effort: agent.options.reasoningEffort, attempts: new Set(), stepKey: undefined, switching: false });
  });
  function stepState(state, turn, step) {
    const key = `${turn}:${step}`;
    if (key !== state.stepKey) { state.stepKey = key; state.attempts = new Set(); state.limit = new Set([routeKey(state.route), ...ctx.subagentModelSelection.current().allowedModels.map(routeKey)]).size; }
  }
  function record(agent, state, route, reason, turn, step, streamFailure) {
    const previous = state.route;
    agent.session.append('auto-subagent/route', { from: previous, to: route, reason, turn, step }, { ignorable: true });
    // A durable notice is admitted with the next retry, so the model knows the history's route changed.
    // Retrying the request never recreates the child or replays completed tool calls.
    if (streamFailure) agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `[Auto Subagents switched from ${previous.provider}/${previous.model} to ${route.provider}/${route.model}: ${reason}. Continue from the existing history and completed tool results; do not restart the task.]` }], source: { kind: 'plugin', plugin: name, form: 'notice', summary: boundContextSummary(`${previous.model} → ${route.model}: ${reason}`) } }), { surfaceOp: 'append' });
    state.route = route;
    state.effort = undefined;
    state.switching = true;
    // Load spreading follows the switch: the child's reservation moves to the new route,
    // and the executor registry (used by `verifies`) records the current route.
    router.switchChildRoute(agent.id, route);
    ctx.emit?.('auto-subagents/route-changed', { childId: agent.id, route });
    ctx.logger.warn(`Auto Subagents ${agent.id}: ${previous.provider}/${previous.model} → ${route.provider}/${route.model} (${reason})`);
  }
  async function recover(agent, state, failure, turn, step, signal, streamFailure = false) {
    signal.throwIfAborted();
    assertRoutingActive();
    stepState(state, turn, step);
    const route = await router.fallback(state.route, state.attempts, signal, state.limit);
    assertRoutingActive();
    if (!route) {
      agent.session.append('auto-subagent/exhausted', { route: state.route, reason: failure.code, turn, step }, { ignorable: true });
      ctx.logger.warn(`Auto Subagents ${agent.id}: routes exhausted (${failure.code}); no inherited parent fallback.`);
      return false;
    }
    record(agent, state, route, failure.code, turn, step, streamFailure);
    return true;
  }
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    const state = managed.get(context.agent);
    return state ? { ...assembled, variables: { ...assembled.variables, ...state.route } } : assembled;
  }, { prepend: true });
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const state = managed.get(agent);
    if (!state) return next();
    signal.throwIfAborted();
    stepState(state, turn, step);
    const config = await next();
    while (true) {
      signal.throwIfAborted();
      const same = routeKey(config) === routeKey(state.route);
      // Clear route-owned effort. Core requestProposal already removes adapter defaults;
      // preserve deliberate output ceilings rather than silently increasing a user's budget.
      const proposed = same && !state.switching ? { ...config } : routeConfig(config, state.route, state.effort);
      try {
        await ctx.llm.resolveCallConfig(proposed, signal);
        signal.throwIfAborted();
        ctx.llm.bindAutoPreparation(proposed, async (error, failedConfig) => {
          signal.throwIfAborted();
          assertRoutingActive();
          if (!isAvailabilityFailure(error)) return undefined;
          if (!await recover(agent, state, error.failure ?? error, turn, step, signal)) return undefined;
          return routeConfig(failedConfig, state.route, state.effort);
        });
        return proposed;
      } catch (error) {
        signal.throwIfAborted();
        if (!isAvailabilityFailure(error)) throw error;
        if (!await recover(agent, state, error.failure ?? error, turn, step, signal)) throw error;
      }
    }
  }, { prepend: true });
  ctx.on('agent/request-error', async ({ agent, turn, step, failure, retryPolicy, signal }, next) => {
    const state = managed.get(agent);
    if (!state) return next();
    if (signal.aborted) return undefined;
    // Native compaction owns overflow progress and retry bounds. Generic policies that
    // retry overflow cannot safely delegate after compaction declines or exhausts.
    if (failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) {
      if (retryPolicy === undefined || (retryPolicy.mode === 'normal' && !retryPolicy.retryableCodes.includes(failure.code))) return next();
      return undefined;
    }
    if (!isAvailabilityFailure(failure)) return undefined;
    return await recover(agent, state, failure, turn, step, signal, true) ? { kind: 'retry' } : undefined;
  }, { prepend: true });
  // Load-spreading release points. The delegation tool adopts every Auto child into the
  // router's registry at creation, holding the route reservation made at selection.
  // Continuable children (status-driven) are released when their turn settles and counted
  // again when a later send_message turn starts, on their current route; `agent/disposed`
  // is the final safety net for every adopted child. One-shot children are released by
  // their own tool settle path and ignore status transitions here.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') router.childTurnActive(agent.id);
    else if (status === 'idle') router.childTurnIdle(agent.id);
  });
  ctx.on('agent/disposed', ({ agent }) => router.childDisposed(agent.id));
}
