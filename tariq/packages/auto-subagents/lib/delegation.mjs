/** Cordis plugin exposing Auto policy through the target's public subagent service. */
import { runtimeModuleUrl } from './dsh-paths.mjs';
import { installDelegation } from './delegation-runtime.mjs';
const { defineTool } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));
const { default: z } = await import(runtimeModuleUrl('@deepseek-ai/schemastery'));

export const name = 'auto-delegation';
export const inject = ['tools', 'subagents', 'systemPrompt', 'llm', 'agents'];
export const Config = z.object({
  provider: z.union(['spawn', 'fork']).required(),
  toolName: z.union(['subagent', 'subagent_fork']).default('subagent'),
  backgroundMode: z.const('continuable').default('continuable'),
  registerModelDiscovery: z.boolean().default(false),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed')]),
  agentOptions: z.object({ maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER) }).default(undefined),
  persona: z.string(),
  toolFilter: z.object({ allow: z.array(z.string()).default(undefined), deny: z.array(z.string()).default(undefined) }).default(undefined),
});

/**
 * Install the configured Auto delegation consumer in its preset scope.
 * @param ctx - Injected runtime Context.
 * @param config - Validated provider, tool identity, and child defaults.
 */
export function apply(ctx, config) { installDelegation(ctx, config, defineTool); }
