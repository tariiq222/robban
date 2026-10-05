import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { apply, getTaskWorkStore } from '../lib/task-memory.mjs';
import { releaseTaskAttempt } from '../lib/task-work-store.mjs';
import * as TaskMemory from '../lib/task-memory.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-work-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), memoryDir = path.join(root, 'memory');
  await mkdir(repo);
  let tool;
  const ctx = { effect: fn => fn(), tools: { register(value) { tool = value; return () => {}; } } };
  apply(ctx, { memoryDir });
  const agent = { session: { id: 'session-1', header: { cwd: repo } } };
  const call = (args, caller = agent) => tool.execute(args, { agent: caller });
  const created = await call({ action: 'create', title: 'Feature task', goal: 'Ship a scoped feature with QA' });
  return { ctx, repo, memoryDir, agent, call, taskId: created.task.taskId };
}
const goals = [{ id: 'behavior', description: 'Requested behavior' }];
const items = () => [
  { id: 'edit', title: 'Implement', description: 'Scoped feature change', goalIds: ['behavior'], writePaths: ['src.js'], readPaths: ['package.json'], acceptance: ['Requested behavior present'], verifyCommands: ['node --test'], dependencies: [], recipe: 'feature-pipeline' },
  { id: 'check', title: 'Verify', description: 'Check edited behavior', goalIds: ['behavior'], writePaths: [], readPaths: ['src.js'], acceptance: ['Requested behavior verified'], verifyCommands: ['node --test'], dependencies: ['edit'], recipe: 'qa-verify' },
];

test('work plan tool refuses model completion and start actions', async t => {
  const f = await fixture(t);
  for (const action of ['complete', 'start', 'claim', 'settle']) await assert.rejects(f.call({ action, taskId: f.taskId }), /action/);
});

test('all plan mutations deny live and durable children while read_plan stays available', async t => {
  const f = await fixture(t);
  for (const child of [
    { parentAgent: f.agent, session: { id: 'child', header: { cwd: f.repo } } },
    { session: { id: 'child', header: { cwd: f.repo, origin: 'subagent' } } },
    { session: { id: 'child', header: { cwd: f.repo, delegationDepth: 2 } } },
  ]) {
    for (const action of ['define_plan', 'block_item', 'reopen_item']) await assert.rejects(f.call({ action, taskId: f.taskId, expectedRevision: 0, goals, items: items(), itemId: 'edit', reason: 'Reported blocker' }, child), /top-level coordinator/);
    assert.equal((await f.call({ action: 'read_plan', taskId: f.taskId }, child)).plan, null);
  }
});

test('work store helper uses the notes directory configuration without a second config source', async t => {
  const f = await fixture(t);
  assert.equal(getTaskWorkStore(f.ctx, { memoryDir: f.memoryDir }), getTaskWorkStore(f.ctx, { memoryDir: f.memoryDir }));
  assert.throws(() => getTaskWorkStore(f.ctx, { memoryDir: 'relative' }), /nonempty absolute/);
});

test('define and read plan preserve root goal, criteria, readiness and separate work revisions', async t => {
  const f = await fixture(t);
  const defined = await f.call({ action: 'define_plan', taskId: f.taskId, expectedRevision: 0, goals, items: items() });
  assert.equal(defined.observedWorkRevision, 1);
  assert.equal(defined.plan.rootGoal, 'Ship a scoped feature with QA');
  assert.deepEqual(defined.plan.ready, ['edit']);
  assert.deepEqual(defined.plan.waiting, ['check']);
  assert.deepEqual(defined.plan.items[0].acceptance, ['Requested behavior present']);
  assert.equal(defined.plan.goalProgress[0].completedCount, 0);
  assert.equal(defined.plan.goalProgress[0].totalCount, 2);
  assert.equal(defined.plan.counts.completed, 0);
  assert.equal(defined.plan.totalItems, 2);
  assert.equal(defined.plan.items[0].attempt, undefined);
  await f.call({ action: 'append', taskId: f.taskId, expectedRevision: 0, entry: { kind: 'progress', text: 'All work completed according to the model' } });
  const read = await f.call({ action: 'read_plan', taskId: f.taskId });
  assert.equal(read.plan.revision, 1);
  assert.equal(read.plan.counts.completed, 0);
  assert.equal((await f.call({ action: 'read', taskId: f.taskId })).task.revision, 1);
  await assert.rejects(f.call({ action: 'define_plan', taskId: f.taskId, expectedRevision: 0, goals, items: items() }), /stale work revision.*read_plan/);
});

test('block and reopen expose blocker and restore readiness without certifying completion', async t => {
  const f = await fixture(t);
  await f.call({ action: 'define_plan', taskId: f.taskId, expectedRevision: 0, goals, items: items() });
  const blocked = await f.call({ action: 'block_item', taskId: f.taskId, expectedRevision: 1, itemId: 'edit', reason: 'Acceptance intent needs clarification' });
  assert.equal(blocked.plan.items[0].status, 'blocked');
  assert.equal(blocked.plan.items[0].blocker, 'Acceptance intent needs clarification');
  assert.deepEqual(blocked.plan.ready, []);
  await assert.rejects(f.call({ action: 'reopen_item', taskId: f.taskId, expectedRevision: 1, itemId: 'edit', reason: 'Clarified' }), /stale work revision/);
  const reopened = await f.call({ action: 'reopen_item', taskId: f.taskId, expectedRevision: 2, itemId: 'edit', reason: 'Clarified' });
  assert.deepEqual(reopened.plan.ready, ['edit']);
  assert.equal(reopened.plan.items[0].status, 'pending');
  assert.equal(reopened.plan.counts.completed, 0);
});

test('invalid graph definitions leave no partial plan or model supplied statuses', async t => {
  const f = await fixture(t);
  for (const invalid of [[], [{ ...items()[0], status: 'completed' }], [{ ...items()[0], dependencies: ['edit'] }]]) {
    await assert.rejects(f.call({ action: 'define_plan', taskId: f.taskId, expectedRevision: 0, goals, items: invalid }));
    assert.equal((await f.call({ action: 'read_plan', taskId: f.taskId })).plan, null);
  }
});

test('selected read_plan item exposes bounded complete scopes and prior host outcome without dumping all details', async t => {
  const f = await fixture(t);
  await f.call({ action: 'define_plan', taskId: f.taskId, expectedRevision: 0, goals, items: items() });
  const work = getTaskWorkStore(f.ctx, { memoryDir: f.memoryDir });
  const claimed = await work.claim({ repo: f.repo, taskId: f.taskId, itemId: 'edit', sessionId: 'session-1', recipe: 'feature-pipeline', runId: 'fixture-run', expectedRevision: 1 });
  t.after(() => releaseTaskAttempt(claimed.attempt.id));
  await work.settle({ repo: f.repo, taskId: f.taskId, itemId: 'edit', attemptId: claimed.attempt.id, sessionId: 'session-1', outcome: { kind: 'reported_recipe_result', status: 'aborted', summary: 'Required acceptance did not pass', verification: { passed: false, summary: 'Existing commands passed but criterion lacked evidence' } } });
  const read = await f.call({ action: 'read_plan', taskId: f.taskId, itemId: 'edit' });
  assert.deepEqual(read.detail.writePaths, ['src.js']);
  assert.deepEqual(read.detail.readPaths, ['package.json']);
  assert.equal(read.detail.description, 'Scoped feature change');
  assert.deepEqual(read.detail.acceptance, ['Requested behavior present']);
  assert.equal(read.detail.attempt.runId, 'fixture-run');
  assert.equal(read.detail.lastOutcome.status, 'aborted');
  assert.equal(read.detail.lastOutcome.verification.passed, false);
  assert.equal(read.plan.items[0].writePaths, undefined);
  assert.equal(read.plan.items[1].description, undefined);
  assert.equal((await f.call({ action: 'read_plan', taskId: f.taskId })).detail, undefined);
  await assert.rejects(f.call({ action: 'read_plan', taskId: f.taskId, itemId: 'unknown' }), /work item not found/);
});

test('real registry ownership denies a live child with root-looking header and permits standing root scope', async t => {
  const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
  const { default: Llm, LlmAdapter } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
  const { bindScopeParent, scopeParentOf } = await import(runtimeModuleUrl('@deepseek-ai/dsh-scope'));
  const services = await Promise.all(['session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop'].map(async name => (await import(runtimeModuleUrl(`@deepseek-ai/dsh-${name}`))).default));
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-work-real-ownership-'));
  const repo = path.join(root, 'repo'), memoryDir = path.join(root, 'memory');
  await mkdir(repo);
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  let requests = 0;
  class Adapter extends LlmAdapter {
    async *stream() { requests++; throw new Error('ownership test must not request a model'); }
  }
  await ctx.plugin(Llm);
  for (const service of services) await ctx.plugin(service, service === services.at(-1) ? { agents: [] } : undefined);
  await ctx.plugin(TaskMemory, { memoryDir });
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  const parent = await ctx.agentLoop.createAgent(ctx, { sessionId: 'ownership-root', meta: { cwd: repo }, agentOptions: { provider: 'fixture', model: 'keyless' } });
  if (!scopeParentOf(parent.agent)) bindScopeParent(parent.agent, {});
  assert.ok(scopeParentOf(parent.agent));
  const child = await ctx.agentLoop.createAgent(ctx, { sessionId: 'ownership-child', parentAgent: parent.agent, meta: { cwd: repo }, agentOptions: { provider: 'fixture', model: 'keyless' } });
  assert.equal(child.agent.session.header.origin, undefined);
  assert.equal(child.agent.session.header.delegationDepth, undefined);
  assert.equal(child.agent.parentAgent, undefined);
  assert.equal(ctx.agents.isOwnedBy(child.agent.id, parent.agent), true);
  let callOrdinal = 0;
  const call = (agent, args) => ctx.tools.execute({ callId: `ownership-call-${++callOrdinal}`, name: 'task_memory', arguments: args, agent, signal: new AbortController().signal });
  const created = await call(parent.agent, { action: 'create', title: 'Native ownership', goal: 'Protect graph mutation ownership' });
  assert.equal(created.isError, false, JSON.stringify(created));
  const taskId = created.value.task.taskId;
  const defined = await call(parent.agent, { action: 'define_plan', taskId, expectedRevision: 0, goals, items: items() });
  assert.equal(defined.isError, false, JSON.stringify(defined));
  for (const args of [
    { action: 'create', title: 'Child', goal: 'Child cannot mutate' },
    { action: 'append', taskId, expectedRevision: 0, entry: { kind: 'progress', text: 'Child cannot write' } },
    { action: 'define_plan', taskId, expectedRevision: 1, goals, items: items() },
    { action: 'block_item', taskId, expectedRevision: 1, itemId: 'edit', reason: 'No authority' },
    { action: 'reopen_item', taskId, expectedRevision: 1, itemId: 'edit', reason: 'No authority' },
  ]) {
    const denied = await call(child.agent, args);
    assert.equal(denied.isError, true, args.action);
    assert.match(JSON.stringify(denied.content), /top-level coordinator/);
  }
  const read = await call(child.agent, { action: 'read_plan', taskId });
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.equal(read.value.plan.revision, 1);
  assert.equal((await getTaskWorkStore(ctx, { memoryDir }).get({ repo, taskId })).revision, 1);
  assert.equal(requests, 0);
});
