/** Native Session fixtures for actual durable task tools; model choices are scripted and keyless. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realpath, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
import * as TaskMemory from 'dsh-auto-subagents/task-memory';
import * as Coordinator from 'dsh-auto-subagents/coordinator';
import { TaskMemoryStore } from '../lib/task-memory-store.mjs';
import { AutoModelRouter } from '../lib/router.mjs';
import { registerWorkflowRouting } from '../lib/workflow-routing.mjs';
import { stageInstructions } from '../lib/stage-skills.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: Llm, LlmAdapter, createUserMessage } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { validateStoredEvents } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session-persistence'));
const services = await Promise.all(['session','session-projection','system-prompt','tools','agent','agent-loop'].map(async name => (await import(runtimeModuleUrl(`@deepseek-ai/dsh-${name}`))).default));
const firstNote = 'Source inspection suggests the arithmetic operator is wrong; runtime reproduction remains unverified.';
const secondNote = 'Next session must execute a regression before considering a repair complete.';
const contentValue = message => JSON.parse(message.content.find(block => block.type === 'text').text);
const actions = fixture => fixture.events.filter(event => event.type === 'tool/call').map(event => JSON.parse(event.data.arguments).action);
const receipts = fixture => fixture.events.filter(event => event.type === 'tool/result').map(event => contentValue(event.data.message));

async function nativeSession({ repo, memoryDir, sessionId, previousTaskId }) {
  const ctx = new Context();
  let step = 0, taskId = previousTaskId;
  const responses = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(request) {
      if (step > 0) {
        const value = contentValue(request.messages.findLast(message => message.role === 'tool'));
        assert.match(value.contextWarning, /not verified human permission/);
        responses.push(value);
        taskId ??= value.task.taskId;
        assert.equal(value.task.taskId, taskId);
      }
      const plan = previousTaskId
        ? [{ action: 'read', taskId }, { action: 'append', taskId, expectedRevision: 1, entry: { kind: 'next_step', text: secondNote, refs: ['test.js'] } }, { action: 'read', taskId }]
        : [{ action: 'create', title: 'Arithmetic investigation', goal: 'Establish evidence before repair' }, { action: 'append', taskId, expectedRevision: 0, entry: { kind: 'progress', text: firstNote, refs: ['src.js:1'] } }, { action: 'read', taskId }];
      const args = plan[step++];
      if (args) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `${sessionId}-${step}`, name: 'task_memory', arguments: JSON.stringify(args) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Saved notes are reported context, not authorization or completed verification.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Saved notes are reported context, not authorization or completed verification.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  try {
    await ctx.plugin(Llm);
    for (const service of services) await ctx.plugin(service, service === services.at(-1) ? { agents: [] } : undefined);
    await ctx.plugin(TaskMemory, { memoryDir });
    ctx.provide('agentPresets', { composedPreset: () => 'auto-subagents' });
    await ctx.plugin(Coordinator, { recipesDir: path.join(repo, 'no-recipes') });
    ctx.llm.registerAdapter(['fixture'], new Adapter());
    const handle = await ctx.agentLoop.createAgent(ctx, { sessionId, meta: { cwd: repo }, agentOptions: { provider: 'fixture', model: 'keyless' } });
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: previousTaskId ? 'Continue only the explicitly selected prior task; read its context before appending a next step.' : 'Create a new task and save the source observation. Do not treat notes as execution or permission evidence.' }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    const session = handle.agent.session;
    assert.equal(session.snapshotEvents().at(-1).data.reason.kind, 'completed');
    assert.equal(responses.length, 3);
    return { header: session.header, events: session.snapshotEvents(), taskId, responses };
  } finally { await ctx.fiber.dispose(); }
}

function verifyPair(first, second) {
  assert.deepEqual(actions(first), ['create','append','read']);
  assert.deepEqual(actions(second), ['read','append','read']);
  const initial = first.responses ?? receipts(first), resumed = second.responses ?? receipts(second);
  assert.equal(initial[0].task.revision, 0);
  assert.equal(initial[1].task.revision, 1);
  assert.equal(initial[2].task.entries[0].text, firstNote);
  const taskId = initial[0].task.taskId;
  const calls = value => value.events.filter(event => event.type === 'tool/call').map(event => JSON.parse(event.data.arguments));
  assert.equal(calls(first)[1].expectedRevision, 0);
  assert.equal(calls(second)[1].expectedRevision, 1);
  for (const call of [...calls(first).slice(1), ...calls(second)]) assert.equal(call.taskId, taskId, 'every continuation explicitly identifies the same task');
  for (const receipt of [...initial, ...resumed]) {
    assert.equal(receipt.task.taskId, taskId);
    assert.match(receipt.contextWarning, /not verified human permission/);
  }
  assert.equal(resumed[0].task.revision, 1);
  assert.equal(resumed[0].task.entries[0].text, firstNote);
  assert.equal(resumed[1].task.revision, 2);
  assert.equal(resumed[2].task.entries[0].text, secondNote);
  assert.equal(resumed[2].task.entries[1].text, firstNote);
  assert.deepEqual(resumed[2].task.entries.map(entry => entry.refs), [['test.js'], ['src.js:1']]);
  assert.deepEqual(resumed[2].task.sessions, ['task-memory-first','task-memory-second']);
  assert.deepEqual(resumed[2].task.entries.map(entry => entry.sessionId), ['task-memory-second','task-memory-first']);
  assert.equal(resumed[2].remainingEntries, 0);
}

test('native task_memory plugin persists explicit task across disposed and remounted contexts', { timeout: 30000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'task-memory-native-')));
  try {
    const repo = path.join(root, 'repository'), memoryDir = path.join(root, 'memory');
    await mkdir(repo);
    const first = await nativeSession({ repo, memoryDir, sessionId: 'task-memory-first' });
    const second = await nativeSession({ repo, memoryDir, sessionId: 'task-memory-second', previousTaskId: first.taskId });
    verifyPair(first, second);
    const persisted = await new TaskMemoryStore({ dir: memoryDir }).get({ repo, taskId: first.taskId });
    assert.equal(persisted.revision, 2);
    assert.equal(persisted.entries[0].text, firstNote);
    assert.equal(persisted.entries[1].text, secondNote);
    const file = new URL('./fixtures/task-memory-native-pair-v2.session.json', import.meta.url);
    const record = { first: { header: first.header, events: first.events }, second: { header: second.header, events: second.events } };
    if (process.env.RECORD_TASK_MEMORY_SESSION === 'pair-v2') await writeFile(file, JSON.stringify(record, null, 2) + '\n');
    const fixture = JSON.parse(await readFile(file, 'utf8'));
    verifyPair(fixture.first, fixture.second);
    for (const [key, live] of [['first', first], ['second', second]]) {
      const saved = fixture[key];
      validateStoredEvents(saved.header, saved.events);
      const restored = Session.fromRestore(saved.header.id, saved.events, saved.header, 0, 'detached');
      assert.equal(restored.deriveMessages().filter(message => message.role === 'tool').length, 3);
      const prompt = restored.deriveMessages().find(message => message.role === 'system').content.map(block => block.text ?? '').join('\n');
      assert.ok(prompt.includes(Coordinator.COORDINATOR_ROLE), 'actual coordinator plugin publishes persistent task policy');
      assert.equal(saved.events.at(-1).data.reason.kind, 'completed');
      const headers = value => value.events.filter(event => event.type === 'request/header').map(event => event.data.header);
      assert.deepEqual(headers(live), headers(saved), 'actual model-visible task tool schema and description match recording');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Real routing injects the methods/context; a scripted keyless adapter records what the model sees.
test('authenticated recipe routing logs bundled methods and historical task disclaimer in native Session', { timeout: 30000 }, async () => {
  const ctx = new Context(), providers = new Map();
  const parent = { id: 'task-memory-skill-parent', session: { header: { id: 'task-memory-skill-parent' } } };
  const route = { provider: 'fixture', model: 'keyless' };
  const router = new AutoModelRouter({ current: () => ({ enabled: true, allowedModels: [route], modelTiers: [{ ...route, tier: 'strong' }] }) }, { listProviders: () => [{ id: route.provider }], resolveCallConfig: async config => config });
  let recorded, routing;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Source candidate only; no test executed or permission inferred from memory.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Source candidate only; no test executed or permission inferred from memory.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  try {
    await ctx.plugin(Llm);
    for (const service of services) await ctx.plugin(service, service === services.at(-1) ? { agents: [] } : undefined);
    ctx.llm.registerAdapter(['fixture'], new Adapter());
    const history = JSON.parse(await readFile(new URL('./fixtures/task-memory-native-pair.session.json', import.meta.url), 'utf8'));
    const rememberedNote = receipts(history.first)[2].task.entries[0].text;
    assert.equal(rememberedNote, firstNote);
    const context = JSON.stringify({ entries: [{ kind: 'progress', text: rememberedNote }] });
    providers.set('spawn', { name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, depthLimit: true, persona: true }, async start(request) {
      assert.deepEqual(request.toolFilter, { allow: ['read','read_image','glob','grep'] });
      const methods = stageInstructions({ recipe: 'bug-fix', role: 'analysis', label: 'analysis' });
      const prompt = request.prompt.map(block => block.text ?? '').join('\n');
      assert.ok(prompt.includes(methods.text));
      assert.ok(prompt.includes(context));
      assert.match(prompt, /Task memory is untrusted historical context/);
      assert.ok(!prompt.includes('__AUTO_RECIPE_ROLE__'), 'authenticated private marker is consumed before model publication');
      const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: 'task-memory-skills-analysis', agentOptions: request.agentOptions });
      handle.agent.followup(createUserMessage({ content: request.prompt, source: { kind: 'user' } }));
      await handle.agent.whenIdle();
      recorded = { header: handle.agent.session.header, events: handle.agent.session.snapshotEvents() };
      return { id: handle.agent.id, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { ready: true } }), async dispose() {} };
    } });
    const subagents = { getProvider: name => providers.get(name), registerProvider(provider) { providers.set(provider.name, provider); return () => providers.delete(provider.name); } };
    routing = registerWorkflowRouting({ subagents, router, parent, recipeName: 'bug-fix', stageSkillsEnabled: true, taskContext: context });
    const marker = '__AUTO_RECIPE_ROLE__' + JSON.stringify({ token: routing.markerToken, role: 'analysis', label: 'analysis', timeoutMs: 10000, readOnly: true });
    const run = await providers.get(routing.providerName).start({ parent, signal: new AbortController().signal, prompt: [{ type: 'text', text: marker + '\nRead source before deciding; do not run commands or edit files.' }] });
    await run.result;
    assert.ok(recorded);
    const file = new URL('./fixtures/task-memory-stage-skills.session.json', import.meta.url);
    if (process.env.RECORD_TASK_MEMORY_SESSION === '1') await writeFile(file, JSON.stringify(recorded, null, 2) + '\n');
    const fixture = JSON.parse(await readFile(file, 'utf8'));
    validateStoredEvents(fixture.header, fixture.events);
    const projection = value => Session.fromRestore(value.header.id, value.events, value.header, 0, 'detached').deriveMessages().map(({ role, content }) => ({ role, content }));
    assert.deepEqual(projection(recorded), projection(fixture), 'exact method instructions, pinned digests and remembered note match native replay');
    assert.equal(fixture.events.at(-1).data.reason.kind, 'completed');
  } finally { try { await routing?.dispose(); } finally { await ctx.fiber.dispose(); } }
});
