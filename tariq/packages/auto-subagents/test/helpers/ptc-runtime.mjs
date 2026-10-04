/** Real PTC execution services for offline Auto recipe tests; only child output is scripted. */
import { runtimeModuleUrl } from '../../lib/dsh-paths.mjs';

const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const modules = await Promise.all([
  'session', 'session-projection', 'fs-local', 'subprocess-local', 'sandbox-local',
  'sandbox-policy', 'ptc-runtime-node', 'subagent', 'workflow-ptc',
].map(async name => (await import(runtimeModuleUrl(`@deepseek-ai/dsh-${name}`))).default));
const [Sessions, Projections, Files, Subprocess, Sandbox, Policy, NodeRuntime, Subagents, Engine] = modules;

/** Mount a holder-owned runtime; callers must await dispose before removing cwd. */
export async function createPtcFixture({ cwd, provider, events, maxTotalAgents = 30 }) {
  const ctx = new Context();
  const runs = new Set();
  try {
    for (const service of [Sessions, Projections, Files, Subprocess, Sandbox]) await ctx.plugin(service);
    await ctx.plugin(Policy, { mode: 'danger-full-access', workspaceRoot: cwd });
    await ctx.plugin(NodeRuntime, { graceMs: 50 });
    await ctx.plugin(Subagents);
    ctx.subagents.registerProvider({ ...provider, name: 'spawn', capabilities: {
      agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: false,
      ...provider.capabilities,
    } });
    await ctx.plugin(Engine, { provider: 'spawn', maxConcurrentAgents: 4, maxTotalAgents, maxItemsPerCall: 20 });
    if (events) for (const name of ['workflow/start', 'workflow/phase', 'workflow/agent-start', 'workflow/agent-end', 'workflow/log', 'workflow/end']) {
      ctx.on(name, (...args) => events.emit(name, ...args));
    }
    return {
      subagents: ctx.subagents,
      createParent(workspace = cwd) {
        const session = ctx.sessions.create(undefined, { meta: { cwd: workspace } });
        return { id: session.id, session, options: {} };
      },
      engine: { start(request) {
        const run = ctx.workflowEngine.start(request);
        runs.add(run);
        return run;
      } },
      async dispose() {
        try { await Promise.all([...runs].map(run => run.dispose())); }
        finally { await ctx.fiber.dispose(); }
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
