import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeModuleUrl } from '../../lib/dsh-paths.mjs';
import { renderCatalogForCoordinator } from '../../lib/recipe-catalog.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: SystemPrompt } = await import(runtimeModuleUrl('@deepseek-ai/dsh-system-prompt'));
const { default: ToolRuntime, defineTool } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));
const { createScope } = await import(runtimeModuleUrl('@deepseek-ai/dsh-scope'));

const moduleUrl = new URL('../../lib/coordinator.mjs', import.meta.url);
const coordinator = await import(moduleUrl).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href) return {};
  throw error;
});

// Every model-facing tool the Auto preset registers today (verified against installed packages),
// plus a third-party plugin tool the coordinator must never inherit implicitly.
const PRESET_TOOLS = ['bash', 'pwsh', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'job_output', 'job_list', 'job_kill',
  'skill', 'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode', 'send_message', 'interrupt_agent', 'list_subagent_models',
  'list_agents', 'subagent_fork', 'workflow', 'ralph', 'ask_user_question', 'todo_write', 'web_search', 'web_fetch', 'present', 'task_memory'];
const PLUGIN_TOOL = 'ego_click';
const EXECUTION = ['bash', 'pwsh', 'write', 'edit', 'job_kill', PLUGIN_TOOL];
const COORDINATION = ['read', 'glob', 'grep', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'list_subagent_models', 'todo_write', 'web_fetch', 'ask_user_question', 'task_memory'];
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const define = name => defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => `ran ${name}` });

async function harness() {
  const root = new Context();
  root.plugin(SystemPrompt);
  root.plugin(ToolRuntime);
  await tick();
  const env = { agents: [] };
  root.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    const standingKey = { id: 'auto-standing' };
    const standing = createScope(ctx, standingKey);
    ctx.tools.register(define(PLUGIN_TOOL));
    for (const name of PRESET_TOOLS) standing.ctx.tools.register(define(name));
    const agent = (id, header, preset = 'auto-subagents') => {
      const key = { id };
      const scope = createScope(ctx, key, { parent: standingKey });
      const created = { id, key, ctx: scope.ctx, preset, session: { header } };
      env.agents.push(created);
      return created;
    };
    const policy = () => new coordinator.CoordinatorPolicy({
      listAgents: () => env.agents,
      knownNames: () => new Set(ctx.tools.schemas(standingKey).map(tool => tool.name)),
      // standing view is unrestricted by design: the coordinator restriction lives in the agent's own layer
      presetOf: agent => agent.preset,
    });
    Object.assign(env, { ctx, standingKey, standing, agent, policy });
  } });
  await tick();
  return env;
}
const visible = (env, agent) => env.ctx.tools.schemas(agent.key).map(tool => tool.name);
const run = (env, agent, name) => env.ctx.tools.execute({ callId: `${name}-call`, name, arguments: {}, agent: agent.key, signal: new AbortController().signal });

test('coordinator allowlist keeps reading, delegation and coordination only', () => {
  for (const name of COORDINATION) assert.ok(coordinator.COORDINATOR_ALLOWED_TOOLS.includes(name), name);
  for (const name of EXECUTION) assert.ok(!coordinator.COORDINATOR_ALLOWED_TOOLS.includes(name), name);
  assert.ok(Object.isFrozen(coordinator.COORDINATOR_ALLOWED_TOOLS));
});
test('coordinator only for a top-level Auto session; subagents and other presets excluded', () => {
  assert.equal(coordinator.isCoordinator({}, 'auto-subagents'), true);
  assert.equal(coordinator.isCoordinator({ origin: 'subagent' }, 'auto-subagents'), false);
  assert.equal(coordinator.isCoordinator({}, 'standard'), false);
  assert.equal(coordinator.isCoordinator({}, undefined), false);
});
test('main Auto agent cannot see or execute execution tools or unknown plugin tools, keeps coordination', async () => {
  const env = await harness();
  const main = env.agent('main', {});
  env.policy().reconcile();
  const names = visible(env, main);
  for (const name of EXECUTION) {
    assert.ok(!names.includes(name), `${name} still visible`);
    const result = await run(env, main, name);
    assert.equal(result.isError, true);
    assert.equal(result.error.info.code, 'UNKNOWN_TOOL');
  }
  for (const name of COORDINATION.filter(name => name !== 'subagent')) assert.ok(names.includes(name), name);
});
test('nested run_code-style dispatch cannot bypass the coordinator restriction', async () => {
  const env = await harness();
  const main = env.agent('main', {});
  env.policy().reconcile();
  const nested = await env.ctx.tools.execute({ callId: 'nested', name: 'write', arguments: {}, agent: main.key, parent: { token: 1 }, signal: new AbortController().signal });
  assert.equal(nested.isError, true);
  assert.equal(nested.error.info.code, 'UNKNOWN_TOOL');
});
test('subagents composed from the same preset keep full execution capability', async () => {
  const env = await harness();
  env.agent('main', {});
  const child = env.agent('child', { origin: 'subagent' });
  env.policy().reconcile();
  for (const name of EXECUTION) {
    assert.ok(visible(env, child).includes(name), name);
    assert.equal((await run(env, child, name)).isError, false);
  }
});
test('late-registered delegation tool becomes visible to the coordinator after tools/change', async () => {
  const env = await harness();
  const main = env.agent('main', {});
  const policy = env.policy();
  env.ctx.on('tools/change', () => policy.reconcile());
  policy.reconcile();
  assert.ok(!visible(env, main).includes('subagent'));
  env.standing.ctx.tools.register(define('subagent'));
  await tick();
  assert.ok(visible(env, main).includes('subagent'));
  assert.ok(!visible(env, main).includes('write'));
});
test('reconcile is re-entrant safe: restriction emitting tools/change does not recurse or duplicate', async () => {
  const env = await harness();
  const main = env.agent('main', {});
  const policy = env.policy();
  let calls = 0;
  env.ctx.on('tools/change', () => { calls += 1; policy.reconcile(); });
  policy.reconcile();
  await tick();
  assert.ok(calls < 10, `tools/change fired ${calls} times`);
  assert.equal(policy.appliedCount(), 1);
  assert.ok(!visible(env, main).includes('write'));
});
test('switching a blank session away from Auto lifts the restriction; switching in applies it', async () => {
  const env = await harness();
  const main = env.agent('main', {}, 'standard');
  const policy = env.policy();
  policy.reconcile();
  assert.ok(visible(env, main).includes('write'));
  main.preset = 'auto-subagents';
  policy.reconcile();
  assert.ok(!visible(env, main).includes('write'));
  main.preset = 'standard';
  policy.reconcile();
  assert.ok(visible(env, main).includes('write'));
});
test('repeated reconciles never shrink the allowlist (known names come from the unrestricted parent view)', async () => {
  const env = await harness();
  const main = env.agent('main', {});
  const policy = env.policy();
  for (let i = 0; i < 5; i += 1) policy.reconcile();
  for (const name of ['read', 'grep', 'subagent_fork', 'send_message', 'todo_write']) assert.ok(visible(env, main).includes(name), name);
});
test('fail closed: an empty known-tool view hides every tool instead of lifting the restriction', async () => {
  const env = await harness();
  const main = env.agent('main', {});
  const policy = new coordinator.CoordinatorPolicy({ listAgents: () => env.agents, knownNames: () => new Set(), presetOf: agent => agent.preset });
  policy.reconcile();
  assert.deepEqual(visible(env, main), []);
});
test('fail closed: a failing new restriction keeps the previous one and still processes later agents', async () => {
  const env = await harness();
  const first = env.agent('first', {}), second = env.agent('second', {});
  let known = new Set(['read', 'grep', 'write']);
  const policy = new coordinator.CoordinatorPolicy({ listAgents: () => env.agents, knownNames: () => known, presetOf: agent => agent.preset });
  policy.reconcile();
  // ctx.tools is shared between agents; fail only the first agent's restriction.
  const realCtx = first.ctx;
  first.ctx = { ...realCtx, get: realCtx.get?.bind(realCtx), tools: { restrict() { throw new Error('boom'); } } };
  known = new Set(['read', 'glob', 'write']);
  assert.throws(() => policy.reconcile(), /boom/);
  assert.ok(!visible(env, first).includes('write'), 'previous restriction was lifted');
  assert.ok(visible(env, second).includes('glob'), 'later agent was not processed');
  first.ctx = realCtx;
});
test('disposing the policy restores every agent', async () => {
  const env = await harness();
  const main = env.agent('main', {});
  const policy = env.policy();
  policy.reconcile();
  policy.dispose();
  assert.ok(visible(env, main).includes('write'));
  assert.equal(policy.appliedCount(), 0);
});
test('coordinator prompt defines scope, architecture, regression verification; children do not receive it', () => {
  const text = coordinator.COORDINATOR_ROLE;
  assert.match(text, /cannot edit files or run commands/i);
  assert.match(text, /impact/i);
  assert.match(text, /independent/i);
  assert.match(text, /regression/i);
  assert.match(text, /read_plan/);
  assert.match(text, /workItemId/);
  assert.match(text, /Only|only.*current human intent|current human intent/);
  assert.match(text, /Refresh this mirror each turn/);
  assert.match(text, /completed work-item counts alone do not establish/);
  assert.match(text, /duplicat/i);
  assert.match(text, /tier: "strong"/); assert.match(text, /tier: "medium"/); assert.match(text, /tier: "light"/);
  assert.doesNotMatch(text, /gpt-|claude-|gemini|qwen|deepseek-v/i);
  assert.equal(coordinator.roleSectionFor({ origin: 'subagent' }, 'auto-subagents'), '');
  assert.equal(coordinator.roleSectionFor({}, 'standard'), '');
  assert.equal(coordinator.roleSectionFor({}, 'auto-subagents'), text);
});
test('generic recipe renderer owns decision, keep and retry guidance instead of static coordinator role', () => {
  const text = renderCatalogForCoordinator([{ name: 'custom', description: 'Custom change', whenToUse: 'When needed' }]);
  assert.match(text, /custom — Custom change; when to use: When needed/);
  assert.match(text, /fitting approved recipe/);
  assert.match(text, /LARGE requests/);
  assert.match(text, /__keep__/);
  assert.match(text, /same.*resumeId.*stays valid/);
  assert.match(text, /verified ask_user_question result/);
  assert.doesNotMatch(text, /feature-pipeline/);
  assert.doesNotMatch(coordinator.COORDINATOR_ROLE, /__keep__|needs_decision|feature-pipeline/);
});
test('subagent contract is compact, structured and bounded; coordinator does not receive it', () => {
  const text = coordinator.SUBAGENT_REPORT_CONTRACT;
  for (const field of ['Status', 'Changed', 'Verification', 'Impact', 'Risks']) assert.match(text, new RegExp(`\\b${field}\\b`));
  assert.match(text, /\b\d{2,3} words\b/);
  assert.equal(coordinator.reportSectionFor({ origin: 'subagent' }, 'auto-subagents'), text);
  assert.equal(coordinator.reportSectionFor({}, 'auto-subagents'), '');
  assert.equal(coordinator.reportSectionFor({ origin: 'subagent' }, 'standard'), '');
});
