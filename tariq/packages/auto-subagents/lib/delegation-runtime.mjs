/** Auto delegation policy over the public subagents service; Cordis definitions enter through the plugin. */
import { automaticRouter, routeKey } from './router.mjs';

const textOf = blocks => blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');

async function settleForeground(run) {
  let value, failure;
  try {
    const result = await run.result;
    if (result.stopReason !== 'completed') {
      const partial = textOf(result.output);
      throw new Error(`subagent run ended abnormally (${result.stopReason})`
        + (result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`)
        + (partial ? `\nPartial output before the run ended:\n${partial}` : ''));
    }
    value = { kind: 'foreground', runId: run.id, output: result.output };
  } catch (error) { failure = { error }; }
  try { await run.dispose(); }
  catch (error) {
    if (failure) throw new AggregateError([failure.error, error], `subagent run failed: ${String(failure.error)}; dispose failed: ${String(error)}`);
    throw error;
  }
  if (failure) throw failure.error;
  return value;
}

function selectionEvent(tool, selected, verifies) {
  return {
    tool, route: selected.route, tier: selected.tier, requestedTier: selected.requestedTier,
    ...(verifies === undefined ? {} : { verifies }),
    ...(selected.excludedRoute === undefined ? {} : { excludedRoute: selected.excludedRoute }),
    ...(selected.sameModelAsExecutor ? { sameModelAsExecutor: true } : {}),
    ...(selected.verifiesUnknown ? { verifiesUnknown: true } : {}),
    preflightFailures: selected.failures,
  };
}

function registerDiscovery(ctx, router, defineTool) {
  const currentRoutes = () => router.routes();
  const admitted = (provider, model) => {
    const allowed = currentRoutes().filter(route => route.provider === provider && (model === undefined || route.model === model));
    if (!allowed.length) throw new Error(`child LLM route ${provider}${model === undefined ? '' : `/${model}`} is not allowed by current Auto settings`);
    return allowed;
  };
  const modelLine = (provider, model) => `${provider}/${model.id} — ${model.name}${model.description === undefined ? '' : `: ${model.description}`}`;
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description: 'Discover currently allowed Auto subagent providers, advertised models, and exact-model reasoning efforts. Supply no arguments for providers, provider for models, or provider and model for efforts. Catalog membership is advisory; saved settings authorize each route.',
    parameters: {
      provider: { type: 'string', description: 'LLM provider id; omit to list providers.' },
      model: { type: 'string', description: 'Exact model id; requires provider.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (args.model !== undefined && args.provider === undefined) throw new Error('model requires provider');
      const routes = currentRoutes();
      if (args.provider === undefined) {
        return ctx.llm.listProviders().filter(provider => routes.some(route => route.provider === provider.id))
          .map(provider => `${provider.id} — ${provider.name}`).join('\n');
      }
      admitted(args.provider, args.model);
      if (args.model === undefined) {
        const models = await ctx.llm.listModels(args.provider);
        exec.signal.throwIfAborted();
        const allowed = admitted(args.provider);
        return models.filter(model => allowed.some(route => route.model === model.id)).map(model => modelLine(args.provider, model)).join('\n') || `(no advertised models for ${args.provider})`;
      }
      const model = await ctx.llm.resolveModelInfo(args.provider, args.model, exec.signal);
      exec.signal.throwIfAborted();
      admitted(args.provider, args.model);
      const efforts = model.reasoning?.efforts.map(effort => `${effort.id}${model.reasoning.defaultEffort === effort.id ? ' (default)' : ''} — ${effort.name}${effort.description === undefined ? '' : `: ${effort.description}`}`).join('\n') || '(no advertised reasoning efforts)';
      return `${modelLine(args.provider, model)}\nReasoning efforts:\n${efforts}`;
    },
  })));
}

/**
 * Register Auto's spawn or fork consumer and optional spawn-owned route discovery.
 * @param ctx - Preset-scoped Context with the host settings singleton and public runtime services.
 * @param config - Validated delegation configuration; background mode is continuable.
 * @param defineTool - Host tool-definition constructor, preserving its ESM identity.
 */
export function installDelegation(ctx, config, defineTool) {
  if (!['spawn', 'fork'].includes(config.provider)) throw new Error('Auto delegation provider must be spawn or fork');
  if (!['subagent', 'subagent_fork'].includes(config.toolName)) throw new Error('Auto delegation toolName must be subagent or subagent_fork');
  if (config.backgroundMode !== 'continuable') throw new Error('Auto delegation requires backgroundMode: continuable');
  if (config.provider !== 'spawn' && config.registerModelDiscovery) throw new Error('Auto model discovery belongs only to the spawn consumer');
  const settings = ctx.get('subagentModelSelection');
  if (settings === undefined) throw new Error('Auto delegation requires the auto-model-selection Host entry');
  const router = automaticRouter(settings, ctx.llm);
  if (config.registerModelDiscovery) registerDiscovery(ctx, router, defineTool);
  let mounted;
  const assertProvider = provider => {
    if (!provider.capabilities.agentOptions) throw new Error(`Auto provider ${provider.name} cannot select child models`);
    if (typeof provider.prepareContinuable !== 'function') throw new Error(`Auto provider ${provider.name} cannot start continuable children`);
    if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== undefined && !provider.capabilities.depthLimit) throw new Error(`Auto provider ${provider.name} cannot enforce maxDepth`);
  };
  const mount = provider => {
    assertProvider(provider);
    const tool = defineTool({
      name: config.toolName,
      description: (provider.inheritsParentContext ? 'Delegate to a child that inherits completed conversation turns.' : 'Delegate to a fresh child using a self-contained prompt.')
        + ' Runs in the background by default; continue it with send_message and receive a settlement notice. Pass tier for every delegation: strong for implementation, repair, review and verification; medium for research, analysis and planning; light for simple reads, listings and summaries. Auto picks the least-loaded allowed route, preserving saved priority on ties, and escalates upward only. For review, pass verifies with the executor id to prefer a different route, reusing its model only if no alternative is usable. Explicit allowed provider/model pairs override tier and verifies. Disabled or empty settings block delegation.',
      parameters: {
        description: { type: 'string', required: true, description: 'Short task description for display.' },
        prompt: { type: 'string', required: true, description: provider.inheritsParentContext ? 'Instructions for the child, which sees completed parent turns.' : 'Self-contained task, context, file ownership, constraints, and acceptance criteria.' },
        tier: { type: 'string', enum: ['light', 'medium', 'strong'], description: 'Minimum tier: strong for implementation, repair and review; medium for research and planning; light for simple reads. Selects the least-loaded route; omitted tier defaults to medium.' },
        verifies: { type: 'string', description: 'Executor subagent id whose work this delegation verifies or reviews. Ignored for an explicit provider/model pair.' },
        provider: { type: 'string', description: 'Explicit allowed LLM provider; requires model.' },
        model: { type: 'string', description: 'Explicit allowed model; requires provider.' },
        reasoning_effort: { type: 'string', description: 'Adapter-owned effort for the first selected route; escalation uses the model default.' },
        run_in_background: { type: 'boolean', description: 'Defaults to true. Set false when the next action requires this result.' },
      },
      output: {
        schema: { oneOf: [
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'continuable' }, subagentId: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'foreground' }, runId: { type: 'string', required: true }, output: { type: 'array', required: true, items: { type: 'json' } } } },
        ] },
        render: (_args, value) => [{ type: 'text', text: value.kind === 'continuable' ? `started subagent ${value.subagentId}` : textOf(value.output) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('Auto delegation requires a calling agent');
        let selected, childId, transferred = false;
        // Recovery may switch the child before its public startup promise fulfills.
        const earlyRoutes = new Map();
        const stopObserving = ctx.on('auto-subagents/route-changed', ({ childId: id, route }) => earlyRoutes.set(id, route));
        const adopt = (id, continuable) => {
          router.adoptChild(id, selected.route, selected.token, continuable);
          const earlyRoute = earlyRoutes.get(id);
          if (earlyRoute !== undefined) router.switchChildRoute(id, earlyRoute);
          stopObserving();
          earlyRoutes.clear();
        };
        try {
          selected = await router.select(exec.agent, args, exec.signal);
          exec.signal.throwIfAborted();
          if (ctx.subagents.getProvider(config.provider) !== provider) throw new Error(`subagent provider ${config.provider} changed during route resolution; retry delegation`);
          if (!router.routes().some(route => routeKey(route) === routeKey(selected.route))) throw new Error('selected model is no longer allowed; retry delegation');
          exec.agent.session.append('auto-subagent/selected', selectionEvent(config.toolName, selected, args.verifies), { ignorable: true });
          if (selected.sameModelAsExecutor) ctx.logger.warn(`Auto verification of ${args.verifies} uses the executor's own route because no other allowed route is usable.`);
          const maxDepth = ctx.subagents.resolveMaxDepth(config.maxDepth);
          const { reasoningEffort: _effort, ...defaults } = config.agentOptions ?? {};
          const request = {
            label: args.description, parent: exec.agent, prompt: [{ type: 'text', text: args.prompt }],
            agentOptions: { ...defaults, ...selected.route, reasoningEffort: selected.reasoningEffort },
            ...(maxDepth === undefined ? {} : { maxDepth }),
            ...(config.persona === undefined ? {} : { persona: config.persona }),
            ...(config.toolFilter === undefined ? {} : { toolFilter: config.toolFilter }),
          };
          if (args.run_in_background !== false) {
            const started = await ctx.subagents.startContinuable({ provider: config.provider, label: args.description, request, signal: exec.signal });
            childId = started.childId;
            adopt(childId, true);
            transferred = true;
            // Inbox acceptance can race an entire first turn or residency disposal.
            const child = ctx.get('agents')?.get(childId);
            if (child === undefined) router.childDisposed(childId);
            else if (child.status === 'idle') router.childTurnIdle(childId);
            return { kind: 'continuable', subagentId: childId };
          }
          const run = await ctx.subagents.start(config.provider, { ...request, signal: exec.signal });
          childId = run.id;
          adopt(childId, false);
          return await settleForeground(run);
        } finally {
          stopObserving();
          if (!transferred) {
            if (childId !== undefined) router.childDisposed(childId);
            selected?.token?.release();
          }
        }
      },
    });
    mounted = { provider, dispose: ctx.effect(() => ctx.tools.register(tool)) };
  };
  ctx.on('subagent/provider-added', provider => { if (provider.name === config.provider && mounted === undefined) mount(provider); });
  ctx.on('subagent/provider-removed', name => {
    if (name !== config.provider || mounted === undefined) return;
    mounted.dispose(); mounted = undefined;
  });
  const provider = ctx.subagents.getProvider(config.provider);
  if (provider !== undefined) mount(provider);
  else ctx.logger.info(`Auto provider ${config.provider} is not registered; ${config.toolName} awaits its provider.`);
  ctx.systemPrompt.section({
    name: `tool:${config.toolName}`, order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: context => mounted === undefined || ctx.tools.get(config.toolName, context.scope) === undefined ? '' : `Start independent ${config.toolName} delegations together in one assistant message and continue useful work while they run.`,
  });
}
