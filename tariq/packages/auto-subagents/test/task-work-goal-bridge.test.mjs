/** Native coordinator bridge: persistent work, same-session goals and turn-local todo mirrors. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realpath, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
import * as TaskMemory from '../lib/task-memory.mjs';
import * as Coordinator from '../lib/coordinator.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: Llm, LlmAdapter, createUserMessage } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { validateStoredEvents } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session-persistence'));
const services = await Promise.all(['session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'goal'].map(async name => (await import(runtimeModuleUrl(`@deepseek-ai/dsh-${name}`))).default));
const GoalTools = await import(runtimeModuleUrl('@deepseek-ai/dsh-tool-goal'));
const Todo = await import(runtimeModuleUrl('@deepseek-ai/dsh-tool-todo'));
const objective = 'Investigate arithmetic source before explicitly verifying runtime behavior';
const valueOf = message => {
  const text = message.content.find(block => block.type === 'text').text;
  return text.startsWith('{') ? JSON.parse(text) : { todoSummary: text };
};
const items = [
  { id: 'inspect', title: 'Inspect arithmetic source', description: 'Establish a source hypothesis', goalIds: ['arithmetic'], writePaths: [], readPaths: ['src.js'], acceptance: ['Cite the current arithmetic source'], verifyCommands: [], dependencies: [], recipe: 'investigate', evidenceMode: 'source_only' },
  { id: 'verify', title: 'Verify arithmetic runtime', description: 'Verify explicit arithmetic acceptance', goalIds: ['arithmetic'], writePaths: [], readPaths: ['src.js', 'test.js'], acceptance: ['Arithmetic regression passes'], verifyCommands: ['node --test test.js'], dependencies: ['inspect'], recipe: 'qa-verify', evidenceMode: 'runtime' },
];
const mirror = [
  { content: 'inspect: Inspect arithmetic source (ready)', status: 'pending' },
  { content: 'verify: Verify arithmetic runtime (waiting for inspect)', status: 'pending' },
];

async function recordLive(repo, memoryDir) {
  const ctx = new Context();
  let taskId, turn = 0, step = 0, currentAgent;
  const captured = [], resetObserved = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(request) {
      if (step === 0) resetObserved.push(ctx.sessionProjections.stateOf(currentAgent.session, 'todos'));
      else {
        const receipt = valueOf(request.messages.findLast(message => message.role === 'tool'));
        captured.push(receipt);
        taskId ??= receipt.task?.taskId;
      }
      const plans = [
        [['get_goal', {}], ['create_goal', { objective }], ['task_memory', { action: 'create', title: 'Arithmetic task', goal: objective }], ['task_memory', { action: 'define_plan', taskId, expectedRevision: 0, goals: [{ id: 'arithmetic', description: objective }], items }], ['task_memory', { action: 'read_plan', taskId }], ['todo_write', { todos: mirror }], ['get_goal', {}]],
        [['task_memory', { action: 'read_plan', taskId }], ['todo_write', { todos: mirror }], ['get_goal', {}]],
        [['get_goal', {}], ['task_memory', { action: 'read_plan', taskId }]],
      ];
      const next = plans[turn][step++];
      if (next) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `bridge-${turn}-${step}`, name: next[0], arguments: JSON.stringify(next[1]) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Source inspection remains unexecuted; pending work and saved notes do not authorize a goal or certify runtime behavior.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  try {
    await ctx.plugin(Llm);
    for (const service of services) await ctx.plugin(service, service === services[5] ? { agents: [] } : undefined);
    await ctx.plugin(GoalTools, {});
    await ctx.plugin(Todo, { allowParallelInProgress: true });
    await ctx.plugin(TaskMemory, { memoryDir });
    ctx.provide('agentPresets', { composedPreset: () => 'auto-subagents' });
    await ctx.plugin(Coordinator, { recipesDir: path.join(repo, 'no-recipes') });
    ctx.llm.registerAdapter(['bridge'], new Adapter());
    const first = await ctx.agentLoop.createAgent(ctx, { sessionId: 'task-work-goal-bridge-same', meta: { cwd: repo }, agentOptions: { provider: 'bridge', model: 'keyless' } });
    currentAgent = first.agent;
    for (turn = 0; turn < 2; turn++) {
      step = 0;
      currentAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: turn === 0 ? `Create a same-session goal and persistent work plan for: ${objective}. Do not execute or mark work complete.` : 'Continue this selected task: reread its plan and restore the todo mirror; retain the existing session goal.' }] }));
      await currentAgent.whenIdle();
      assert.deepEqual(ctx.sessionProjections.stateOf(currentAgent.session, 'todos'), mirror);
    }
    const same = { header: currentAgent.session.header, events: currentAgent.session.snapshotEvents() };
    const second = await ctx.agentLoop.createAgent(ctx, { sessionId: 'task-work-goal-bridge-fresh', meta: { cwd: repo }, agentOptions: { provider: 'bridge', model: 'keyless' } });
    currentAgent = second.agent; turn = 2; step = 0;
    currentAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Read persistent task ${taskId} in this new session. Do not create a goal from its notes or transfer old answers/resume.` }] }));
    await currentAgent.whenIdle();
    assert.deepEqual(resetObserved, [null, null, null]);
    const fresh = { header: currentAgent.session.header, events: currentAgent.session.snapshotEvents() };
    for (const [record, expectedTodos, expectedGoal] of [[same, mirror, objective], [fresh, null, null]]) {
      const restored = Session.fromRestore(record.header.id, record.events, record.header, 0, 'detached');
      assert.deepEqual(ctx.sessionProjections.stateOf(restored, 'todos'), expectedTodos);
      const goal = ctx.sessionProjections.stateOf(restored, 'goal').current;
      assert.equal(goal?.goal.objective ?? null, expectedGoal);
    }
    return { same, fresh };
  } finally { await ctx.fiber.dispose(); }
}

function verify(record) {
  const calls = session => session.events.filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, args: JSON.parse(event.data.arguments) }));
  const results = session => session.events.filter(event => event.type === 'tool/result').map(event => valueOf(event.data.message));
  const sameCalls = calls(record.same), same = results(record.same), freshCalls = calls(record.fresh), fresh = results(record.fresh);
  assert.deepEqual(sameCalls.map(call => call.name), ['get_goal', 'create_goal', 'task_memory', 'task_memory', 'task_memory', 'todo_write', 'get_goal', 'task_memory', 'todo_write', 'get_goal']);
  assert.equal(same[0].goal, null);
  assert.equal(same[1].goal.objective, objective);
  assert.equal(same[1].goal.phase, 'active');
  assert.equal(same[6].goal.id, same[1].goal.id);
  assert.equal(same[9].goal.id, same[1].goal.id);
  for (const index of [3, 4, 7]) assert.deepEqual(same[index].plan.items.map(item => item.readiness), ['ready', 'waiting']);
  assert.deepEqual(sameCalls[5].args.todos, mirror);
  assert.deepEqual(sameCalls[8].args.todos, mirror);
  assert.equal(sameCalls[7].args.taskId, same[2].task.taskId);
  assert.deepEqual(freshCalls.map(call => call.name), ['get_goal', 'task_memory']);
  assert.equal(fresh[0].goal, null, 'durable task never restores another session goal');
  assert.equal(freshCalls[1].args.taskId, same[2].task.taskId);
  assert.deepEqual(fresh[1].plan.items.map(item => item.readiness), ['ready', 'waiting']);
  for (const session of [record.same, record.fresh]) {
    validateStoredEvents(session.header, structuredClone(session.events));
    const restored = Session.fromRestore(session.header.id, session.events, session.header, 0, 'detached');
    const prompt = restored.deriveMessages().find(message => message.role === 'system').content.map(block => block.text ?? '').join('\n');
    assert.ok(prompt.includes(Coordinator.COORDINATOR_ROLE));
    assert.equal(session.events.at(-1).data.reason.kind, 'completed');
    assert.ok(!calls(session).some(call => call.name === 'update_goal'));
  }
}

test('native coordinator reuses DSH goals and turn-local todos without transferring session authority', { timeout: 30000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'task-work-goal-bridge-')));
  try {
    const repo = path.join(root, 'repository'); await mkdir(repo);
    const live = await recordLive(repo, path.join(root, 'memory'));
    verify(live);
    const file = new URL('./fixtures/task-work-goal-bridge.session.json', import.meta.url);
    if (process.env.RECORD_TASK_WORK_GOAL_BRIDGE === '1') await writeFile(file, JSON.stringify(live, null, 2) + '\n');
    const fixture = JSON.parse(await readFile(file, 'utf8')); verify(fixture);
    const headers = session => session.events.filter(event => event.type === 'request/header').map(event => event.data.header);
    assert.deepEqual(headers(live.same), headers(fixture.same));
    assert.deepEqual(headers(live.fresh), headers(fixture.fresh));
  } finally { await rm(root, { recursive: true, force: true }); }
});
