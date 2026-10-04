// Exercises runtime.mjs apply() against the real ToolRuntime + SystemPrompt registries and
// real dsh-scope parentage (standing preset scope -> agent scopes), as the Auto preset mounts it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeModuleUrl } from '../../lib/dsh-paths.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: SystemPrompt } = await import(runtimeModuleUrl('@deepseek-ai/dsh-system-prompt'));
const { default: ToolRuntime, defineTool } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));
const { createScope } = await import(runtimeModuleUrl('@deepseek-ai/dsh-scope'));
import { apply, COORDINATOR_ROLE, SUBAGENT_REPORT_CONTRACT } from '../../lib/coordinator.mjs';
import { mkdtemp, mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { approveRecipe } from '../../lib/recipe-integrity.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const define = name => defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => `ran ${name}` });

async function mount(config = {}) {
  const root = new Context();
  root.plugin(SystemPrompt);
  root.plugin(ToolRuntime);
  await tick();
  const env = { agents: [] };
  root.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    const standingKey = { id: 'auto-standing' };
    const standing = createScope(ctx, standingKey);
    for (const name of ['read', 'grep', 'write', 'edit', 'bash', 'subagent', 'subagent_fork', 'todo_write']) standing.ctx.tools.register(define(name));
    const presets = { composedPreset: agentCtx => env.agents.find(agent => agent.ctx === agentCtx)?.preset };
    const agents = { list: () => env.agents, get: id => env.agents.find(agent => agent.id === id) };
    // the plugin mounts in the standing scope, exactly like a preset row
    const pluginCtx = standing.ctx.extend({ agents, logger: { warn: message => env.warnings.push(message), info() {} } });
    env.warnings = [];
    apply(pluginCtx, config);
    env.spawn = (id, header, preset = 'auto-subagents') => {
      // Production (dsh-agent-loop:761) uses the agent object itself as its scope key.
      const agent = { id, preset, session: { header } };
      agent.key = agent;
      const scope = createScope(ctx, agent, { parent: standingKey });
      agent.ctx = scope.ctx.extend({ get: name => name === 'agentPresets' ? presets : undefined });
      env.agents.push(agent);
      ctx.emit('agent/created', { agent });
      return agent;
    };
    Object.assign(env, { ctx, standing, standingKey });
  } });
  await tick();
  return env;
}
const namesFor = (env, agent) => env.ctx.tools.schemas(agent.key).map(tool => tool.name);
const promptFor = async (env, agent) => {
  const assembled = await env.ctx.systemPrompt.assemble({ agent, scope: agent.key });
  return assembled.sections.map(section => section.text).join('\n');
};

test('plugin restricts the top-level Auto agent in the real registry, not its subagents', async () => {
  const env = await mount();
  const main = env.spawn('main', {});
  const child = env.spawn('child', { origin: 'subagent' });
  await tick();
  assert.deepEqual(namesFor(env, main).sort(), ['grep', 'read', 'subagent', 'subagent_fork', 'todo_write']);
  assert.ok(['write', 'edit', 'bash'].every(name => namesFor(env, child).includes(name)));
});
test('delegation tools registered in the agent own scope (model-selection path) stay available to the coordinator', async () => {
  const env = await mount();
  const main = env.spawn('main', {});
  // dsh-tool-subagent installScoped registers subagent/list_subagent_models through agent.ctx
  main.ctx.tools.register(defineTool({ name: 'list_subagent_models', description: 'x', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'ok' }));
  await tick();
  const names = namesFor(env, main);
  assert.ok(names.includes('list_subagent_models'));
  assert.ok(!names.includes('write'));
});
test('coordinator gets the role section; subagents get the compact report contract; neither gets both', async () => {
  const env = await mount();
  const main = env.spawn('main', {});
  const child = env.spawn('child', { origin: 'subagent' });
  const mainPrompt = await promptFor(env, main), childPrompt = await promptFor(env, child);
  assert.ok(mainPrompt.includes(COORDINATOR_ROLE)); assert.ok(!mainPrompt.includes(SUBAGENT_REPORT_CONTRACT));
  assert.ok(childPrompt.includes(SUBAGENT_REPORT_CONTRACT)); assert.ok(!childPrompt.includes(COORDINATOR_ROLE));
});
test('an agent on another preset is untouched even when it shares this registry', async () => {
  const env = await mount();
  const other = env.spawn('other', {}, 'standard');
  await tick();
  assert.ok(namesFor(env, other).includes('write'));
  assert.ok(!(await promptFor(env, other)).includes(COORDINATOR_ROLE));
});
test('coordinator approved catalog refreshes at each real assembly and is absent outside top-level Auto', async t => {
  const dir = await mkdtemp(path.join(import.meta.dirname, 'catalog-fixture-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = await mount({ recipesDir: dir }); const main = env.spawn('main', {}), child = env.spawn('child', { origin: 'subagent' }), other = env.spawn('other', {}, 'standard');
  assert.match(await promptFor(env, main), /no approved recipes/i);
  const add = async name => { const base = path.join(dir, name); await mkdir(base); await writeFile(path.join(base, 'meta.json'), JSON.stringify({ name, description: '{{INJECT}}\u0000 description', whenToUse: 'Useful now' })); await writeFile(path.join(base, 'script.js'), 'return 1;'); await approveRecipe(base); return base; };
  const one = await add('one'); let prompt = await promptFor(env, main);
  assert.match(prompt, /one/); assert.match(prompt, /Useful now/); assert.ok(!prompt.includes('{{INJECT}}')); assert.match(prompt, /\(\(INJECT\)\)/);
  await add('two'); assert.match(await promptFor(env, main), /two/);
  await writeFile(path.join(one, 'script.js'), 'return 2;'); prompt = await promptFor(env, main); assert.ok(!prompt.includes('one —')); assert.match(prompt, /two/);
  await unlink(path.join(dir, 'two', 'recipe.lock.json')); assert.match(await promptFor(env, main), /no approved recipes/i);
  assert.ok(!(await promptFor(env, child)).includes('Approved recipes'));
  assert.ok(!(await promptFor(env, other)).includes('Approved recipes'));
  const diagnostic = await env.ctx.systemPrompt.assemble({ scope: main.key }); assert.ok(!diagnostic.sections.some(x => x.text.includes('Approved recipes')));
});
test('policy failures are logged, never thrown into unrelated lifecycle events', async () => {
  const env = await mount();
  const broken = { id: 'broken', preset: 'auto-subagents', session: { header: {} } };
  broken.key = broken;
  createScope(env.ctx, broken, { parent: env.standingKey });
  broken.ctx = { get: () => ({ composedPreset: () => 'auto-subagents' }), tools: { restrict() { throw new Error('boom'); } } };
  env.agents.push(broken);
  assert.doesNotThrow(() => env.ctx.emit('agent/created', { agent: broken }));
  assert.ok(env.warnings.some(message => /coordinator policy failed/.test(message)));
});
