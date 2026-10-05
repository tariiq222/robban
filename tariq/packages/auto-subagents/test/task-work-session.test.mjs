/** Native keyless Session recordings of real durable work tools; no recipe execution is simulated as proof. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realpath, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as TaskMemory from 'dsh-auto-subagents/task-memory';
import * as Coordinator from 'dsh-auto-subagents/coordinator';
import { TaskMemoryStore } from '../lib/task-memory-store.mjs';
import { TaskWorkStore } from '../lib/task-work-store.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: Llm, LlmAdapter, createUserMessage } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { validateStoredEvents } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session-persistence'));
const services = await Promise.all(['session','session-projection','system-prompt','tools','agent','agent-loop'].map(async name => (await import(runtimeModuleUrl(`@deepseek-ai/dsh-${name}`))).default));
const goals = [{ id: 'addition-contract', description: 'Establish and preserve correct addition behavior' }];
const items = [
  { id: 'repair-addition', title: 'Repair source candidate', description: 'Diagnose then obtain regression before repair', goalIds: ['addition-contract'], writePaths: ['src.js','test.js'], readPaths: ['package.json'], acceptance: ['Addition regression passes without weakening existing assertions'], verifyCommands: ['node --test test.js'], dependencies: [], recipe: 'bug-fix' },
  { id: 'verify-addition', title: 'Independent addition check', description: 'Check repaired behavior independently', goalIds: ['addition-contract'], writePaths: [], readPaths: ['src.js','test.js'], acceptance: ['Current addition behavior satisfies explicit acceptance'], verifyCommands: ['node --test test.js'], dependencies: ['repair-addition'], recipe: 'qa-verify' },
];
const valueOf = message => JSON.parse(message.content.find(block => block.type === 'text').text);
const results = fixture => fixture.events.filter(event => event.type === 'tool/result').map(event => valueOf(event.data.message));
const calls = fixture => fixture.events.filter(event => event.type === 'tool/call').map(event => JSON.parse(event.data.arguments));

async function runSession({ repo, memoryDir, sessionId, continuedTaskId }) {
  const ctx = new Context();
  let step = 0, taskId = continuedTaskId;
  const responses = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(request) {
      if (step > 0) {
        const response = valueOf(request.messages.findLast(message => message.role === 'tool'));
        responses.push(response);
        assert.match(response.contextWarning, /not verified human permission/);
        taskId ??= response.task?.taskId;
      }
      const actions = continuedTaskId
        ? [{ action: 'read_plan', taskId }, { action: 'reopen_item', taskId, expectedRevision: 2, itemId: 'repair-addition', reason: 'Explicit coordinator continuation; fresh diagnosis still required' }, { action: 'read_plan', taskId }]
        : [{ action: 'create', title: 'Addition work', goal: goals[0].description }, { action: 'define_plan', taskId, expectedRevision: 0, goals, items }, { action: 'read_plan', taskId }, { action: 'block_item', taskId, expectedRevision: 1, itemId: 'repair-addition', reason: 'Regression not executed; no completion claim authorized' }, { action: 'read_plan', taskId }];
      const args = actions[step++];
      if (args) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `${sessionId}-${step}`, name: 'task_memory', arguments: JSON.stringify(args) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = 'The durable work plan remains pending; no recipe ran and no verification or human approval is inferred.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
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
    const text = continuedTaskId ? 'Resume the explicitly selected task: inspect its graph, reopen blocked work with a reason, and retain every goal and dependency.' : 'Create the addition task, define its goal and dependent work, then block unverified repair instead of claiming completion.';
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    const session = handle.agent.session;
    assert.equal(session.snapshotEvents().at(-1).data.reason.kind, 'completed');
    assert.equal(responses.length, continuedTaskId ? 3 : 5);
    return { header: session.header, events: session.snapshotEvents(), taskId, responses };
  } finally { await ctx.fiber.dispose(); }
}

function verifyPair(first, second) {
  assert.deepEqual(calls(first).map(call => call.action), ['create','define_plan','read_plan','block_item','read_plan']);
  assert.deepEqual(calls(second).map(call => call.action), ['read_plan','reopen_item','read_plan']);
  const taskId = results(first)[0].task.taskId;
  assert.equal(results(first)[0].task.goal, goals[0].description);
  for (const call of [...calls(first).slice(1), ...calls(second)]) assert.equal(call.taskId, taskId);
  assert.equal(calls(first)[1].expectedRevision, 0);
  assert.equal(calls(first)[3].expectedRevision, 1);
  assert.equal(calls(second)[1].expectedRevision, 2);
  const snapshots = [results(first)[2], results(first)[4], results(second)[0], results(second)[2]];
  for (const response of snapshots) {
    assert.match(response.contextWarning, /not verified human permission/);
    assert.equal(response.plan.rootGoal, goals[0].description);
    assert.deepEqual(response.plan.goals.map(({ id, description }) => ({ id, description })), goals);
    assert.deepEqual(response.plan.items.map(item => ({ id: item.id, goalIds: item.goalIds, acceptance: item.acceptance, dependencies: item.dependencies, recipe: item.recipe })), items.map(item => ({ id: item.id, goalIds: item.goalIds, acceptance: item.acceptance, dependencies: item.dependencies, recipe: item.recipe })));
    assert.deepEqual(response.plan.items.map(item => item.evidenceMode), ['runtime','runtime']);
    assert.deepEqual(response.plan.goalProgress, [{ ...goals[0], totalCount: 2, completedCount: 0 }], 'item counts never assert the human goal completed');
    assert.ok(response.plan.items.every(item => !Object.hasOwn(item, 'attempt')), 'model projection excludes private host attempt ownership');
    assert.ok(!JSON.stringify(response).includes('confirmedDecisions'), 'work graph never transfers verified human answers');
  }
  assert.deepEqual(snapshots.map(response => response.plan.revision), [1,2,2,3]);
  assert.deepEqual(snapshots.map(response => response.plan.items.map(item => item.readiness)), [['ready','waiting'], ['blocked','waiting'], ['blocked','waiting'], ['ready','waiting']]);
  assert.deepEqual(snapshots.map(response => response.plan.items.map(item => item.status)), [['pending','pending'], ['blocked','pending'], ['blocked','pending'], ['pending','pending']]);
  assert.deepEqual(snapshots.map(response => response.plan.ready), [['repair-addition'], [], [], ['repair-addition']]);
  assert.deepEqual(snapshots.map(response => response.plan.waiting), [['verify-addition'], ['verify-addition'], ['verify-addition'], ['verify-addition']]);
}

test('native durable work tools preserve explicit goal and blocked dependencies across fresh Sessions', { timeout: 30000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'task-work-native-')));
  try {
    const repo = path.join(root, 'repository'), memoryDir = path.join(root, 'memory');
    await mkdir(repo);
    const first = await runSession({ repo, memoryDir, sessionId: 'task-work-first' });
    const second = await runSession({ repo, memoryDir, sessionId: 'task-work-second', continuedTaskId: first.taskId });
    verifyPair(first, second);
    const rootTask = await new TaskMemoryStore({ dir: memoryDir }).get({ repo, taskId: first.taskId });
    assert.equal(rootTask.goal, goals[0].description);
    assert.equal(rootTask.revision, 0, 'plan mutations do not rewrite note revisions');
    const savedPlan = await new TaskWorkStore({ dir: memoryDir }).get({ repo, taskId: first.taskId });
    assert.equal(savedPlan.revision, 3);
    assert.deepEqual(savedPlan.goals, goals);
    const file = new URL('./fixtures/task-work-native-pair.session.json', import.meta.url);
    if (process.env.RECORD_TASK_WORK_SESSION === '1') await writeFile(file, JSON.stringify({ first: { header: first.header, events: first.events }, second: { header: second.header, events: second.events } }, null, 2) + '\n');
    const fixture = JSON.parse(await readFile(file, 'utf8'));
    verifyPair(fixture.first, fixture.second);
    for (const [key, live] of [['first', first], ['second', second]]) {
      const saved = fixture[key];
      validateStoredEvents(saved.header, saved.events);
      const restored = Session.fromRestore(saved.header.id, saved.events, saved.header, 0, 'detached');
      assert.equal(restored.deriveMessages().filter(message => message.role === 'tool').length, key === 'first' ? 5 : 3);
      const prompt = restored.deriveMessages().find(message => message.role === 'system').content.map(block => block.text ?? '').join('\n');
      assert.ok(prompt.includes(Coordinator.COORDINATOR_ROLE));
      const headers = value => value.events.filter(event => event.type === 'request/header').map(event => event.data.header);
      assert.deepEqual(headers(live), headers(saved), 'current tool description and schema match successor recording');
      assert.equal(saved.events.at(-1).data.reason.kind, 'completed');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
