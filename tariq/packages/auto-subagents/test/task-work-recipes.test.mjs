import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply, saveResume } from '../lib/recipes.mjs';
import { getTaskMemoryStore, getTaskWorkStore } from '../lib/task-memory.mjs';
import { approveRecipe } from '../lib/recipe-integrity.mjs';
import { createPtcFixture } from './helpers/ptc-runtime.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
import { releaseTaskAttempt } from '../lib/task-work-store.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { createScope, scopeParentOf, bindScopeParent } = await import(runtimeModuleUrl('@deepseek-ai/dsh-scope'));

async function fixture(t, { recipe = 'feature-pipeline', result = { status: 'completed', changedPaths: ['src.js'] } } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'task-work-recipes-'));
  let runtime;
  t.after(async () => { try { await runtime?.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  const repo = path.join(root, 'repo'); await mkdir(repo);
  const recipesDir = path.join(root, 'recipes'), base = path.join(recipesDir, recipe); await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'meta.json'), JSON.stringify({ name: recipe, description: 'Assigned work fixture' }));
  await writeFile(path.join(base, 'script.js'), `await agent('__AUTO_RECIPE_ROLE__'+JSON.stringify({token:args.routingToken,role:'analysis',label:'analysis',readOnly:true})+'\\nFresh assigned analysis of '+args.task,{label:'analysis',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}});return ${JSON.stringify(result)};`);
  await approveRecipe(base, { approvedBy: 'offline-assigned-work-fixture' });
  const listeners = new Map(), requests = [], calls = { engine: 0, registration: 0, child: 0, disposed: 0 };
  const started = Promise.withResolvers(), bothStarted = Promise.withResolvers(), release = Promise.withResolvers(); let gate = false, tool;
  const provider = { capabilities: { agentOptions: true, outputSchema: true, toolFilter: true }, inheritsParentContext: false, async start(request) {
    requests.push(request); const id = 'work-child-' + ++calls.child; started.resolve(); if (calls.child === 2) bothStarted.resolve();
    if (gate) await release.promise;
    return { id, result: Promise.resolve({ stopReason: 'completed', structured: { ok: true }, output: [] }), async dispose() { calls.disposed++; } };
  } };
  const ctx = { logger: { warn() {} }, tools: { register(value) { tool = value; } },
    on(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); },
    emit(name, ...args) { for (const callback of listeners.get(name) ?? []) callback(...args); },
    events: { dispatch(_kind, [name, ...args]) { return [...(listeners.get(name) ?? [])].map(callback => () => callback(...args)); } },
    subagentModelSelection: { current: () => ({ enabled: true, allowedModels: [{ provider: 'fixture', model: 'model' }], modelTiers: [{ provider: 'fixture', model: 'model', tier: 'medium' }] }) },
    llm: { listProviders: () => [{ id: 'fixture' }], resolveCallConfig: async config => config },
  };
  runtime = await createPtcFixture({ cwd: repo, provider, events: ctx });
  ctx.subagents = { getProvider: name => runtime.subagents.getProvider(name), registerProvider(value) { calls.registration++; return runtime.subagents.registerProvider(value); } };
  ctx.workflowEngine = { start(request) { calls.engine++; return runtime.engine.start(request); } };
  const memoryDir = path.join(root, 'memory'), runsDir = path.join(root, 'runs');
  apply(ctx, { recipesDir, memoryDir, runsDir, setupCacheDir: path.join(root, 'cache') });
  const memory = getTaskMemoryStore(ctx, { memoryDir }), work = getTaskWorkStore(ctx, { memoryDir });
  const first = runtime.createParent(), second = runtime.createParent();
  const task = await memory.create({ repo, title: 'Explicit package task', goal: 'Preserve stored scope and exact acceptance', sessionId: String(first.session.id) });
  const item = (id = 'one', changes = {}) => ({ id, title: 'Stored package', description: 'Stored description controls this run', goalIds: ['goal'], writePaths: ['src.js'], readPaths: [], acceptance: ['Exact stored acceptance'], verifyCommands: ['node --test'], dependencies: [], recipe, ...changes });
  const define = items => work.define({ repo, taskId: task.taskId, sessionId: String(first.session.id), expectedRevision: 0, goals: [{ id: 'goal', description: 'Original goal' }], items });
  const execute = (agent = first, args = {}) => { const request = { recipe, repo, task: 'Clarification cannot authorize extra paths', taskId: task.taskId, workItemId: 'one', ...args }; for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key]; return tool.execute(request, { agent, signal: new AbortController().signal }); };
  const plan = () => work.get({ repo, taskId: task.taskId });
  return { root, repo, recipesDir, runsDir, ctx, memory, work, first, second, task, item, define, execute, plan, calls, requests, runtime, listeners, started: started.promise, bothStarted: bothStarted.promise, hold() { gate = true; }, release() { release.resolve(); } };
}

test('ready exact package uses stored scope and acceptance, then completes only after PTC child disposal', async t => {
  const h = await fixture(t); await h.define([h.item()]);
  const settle = h.work.settle.bind(h.work);
  h.work.settle = args => { assert.equal(h.calls.disposed, 1); assert.deepEqual(h.runtime.subagents.list(), ['spawn']); return settle(args); };
  const result = await h.execute();
  assert.equal(result.result.taskWorkSaved, true); assert.equal(result.result.taskWorkState, 'completed'); assert.equal(result.result.workItemId, 'one');
  const prompt = h.requests[0].prompt.map(part => part.text ?? '').join('\n');
  for (const text of ['ASSIGNED WORK PACKAGE', 'Stored description controls this run', 'Exact stored acceptance', 'src.js', 'node --test', 'cannot widen']) assert.ok(prompt.includes(text));
  const item = (await h.plan()).items[0]; assert.equal(item.status, 'completed'); assert.equal(item.attempt.sessionId, String(h.first.session.id));
  assert.match(item.lastOutcome.verification.summary, /not independently attested/);
});

test('dependency, recipe mismatch, unknown item and missing task id deny before engine or cache', async t => {
  const h = await fixture(t); await h.define([h.item('one'), h.item('two', { writePaths: ['other.js'], dependencies: ['one'] })]);
  await assert.rejects(h.execute(h.first, { workItemId: 'two', resumeId: 'invalid' }), /dependenc/i);
  await assert.rejects(h.execute(h.first, { workItemId: 'missing' }), /does not exist/);
  await assert.rejects(h.execute(h.first, { taskId: undefined }), /requires.*taskId/);
  const other = (await h.plan()).items.find(item => item.id === 'one');
  const claim = h.work.claim.bind(h.work);
  await assert.rejects(claim({ repo: h.repo, taskId: h.task.taskId, itemId: other.id, sessionId: 'caller', recipe: 'bug-fix', runId: 'mismatch' }), /recipe/i);
  assert.equal(h.calls.engine, 0); assert.equal(h.calls.registration, 0);
  assert.ok(!(await readdir(h.root)).some(name => ['cache', 'runs'].includes(name)));
});

test('same work item cannot admit concurrent sessions while the first PTC child is active', async t => {
  const h = await fixture(t); await h.define([h.item()]); h.hold();
  const running = h.execute(); await h.started;
  try { await assert.rejects(h.execute(h.second), /in.progress|pending|state|active/i); assert.equal(h.calls.engine, 1); }
  finally { h.release(); }
  assert.equal((await running).result.taskWorkState, 'completed');
});

test('independent explicitly disjoint packages admit both real PTC children before either finishes', async t => {
  const h = await fixture(t, { result: { status: 'completed', changedPaths: [] } });
  await h.define([h.item('one', { writePaths: ['one.js'], readPaths: [] }), h.item('two', { writePaths: ['two.js'], readPaths: [] })]);
  h.hold();
  const first = h.execute(h.first, { workItemId: 'one' });
  const second = h.execute(h.second, { workItemId: 'two' });
  // Observe failures immediately, while provider results remain held for both children.
  const results = Promise.all([first, second]); results.catch(() => {});
  let timer;
  try {
    await Promise.race([h.bothStarted, results.then(() => { throw new Error('Both children must be admitted before completion'); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Independent PTC admissions did not both arrive')), 3000); })]);
    assert.equal(h.calls.engine, 2); assert.equal(h.calls.child, 2); assert.equal(h.calls.disposed, 0);
    assert.deepEqual((await h.plan()).items.map(item => item.status), ['in_progress', 'in_progress']);
  } finally { clearTimeout(timer); h.release(); }
  const completed = await results;
  assert.deepEqual(completed.map(value => value.result.taskWorkState), ['completed', 'completed']);
  assert.deepEqual((await h.plan()).items.map(item => item.status), ['completed', 'completed']);
  assert.equal(h.calls.disposed, 2);
});

test('reported scope escape never completes stored work or publishes a completed run outcome', async t => {
  const h = await fixture(t, { result: { status: 'completed', changedPaths: ['outside.js'] } }); await h.define([h.item()]);
  const result = await h.execute(); assert.equal(result.result.status, 'completed_with_failures'); assert.equal(result.result.passed, false);
  assert.equal(result.result.taskWorkState, 'blocked'); assert.equal((await h.plan()).items[0].status, 'blocked');
  const end = h.first.session.snapshotEvents().find(event => event.type === 'auto-recipe/run-end'); assert.equal(end.data.status, 'completed_with_failures');
});

test('failed resume admission blocks and releases the reserved attempt before a fresh session may reopen', async t => {
  const h = await fixture(t); await h.define([h.item()]);
  await assert.rejects(h.execute(h.first, { resumeId: 'invalid-token' }), error => error.taskWorkSaved === true && error.taskWorkState === 'blocked');
  assert.equal(h.calls.engine, 0);
  const old = await h.plan();
  await h.work.reopen({ repo: h.repo, taskId: h.task.taskId, itemId: 'one', sessionId: String(h.second.session.id), expectedRevision: old.revision, reason: 'Inspected unchanged workspace; start fresh analysis' });
  assert.equal((await h.execute(h.second)).result.taskWorkState, 'completed');
});

test('work result save failure leaves recovery state and never retries completed work', async t => {
  const h = await fixture(t); await h.define([h.item()]);
  h.work.settle = async () => { throw new Error('PRIVATE_SAVE_REASON'); };
  const result = await h.execute(); assert.equal(result.result.status, 'completed'); assert.equal(result.result.taskWorkSaved, false);
  assert.equal(result.result.taskWorkState, 'in_progress'); assert.equal(h.calls.engine, 1); assert.equal((await h.plan()).items[0].status, 'in_progress');
  assert.ok(!JSON.stringify(result.result).includes('PRIVATE_SAVE_REASON'));
  const current = await h.plan();
  await h.work.reopen({ repo: h.repo, taskId: h.task.taskId, itemId: 'one', sessionId: String(h.second.session.id), expectedRevision: current.revision, reason: 'Inspect completed diff and rerun verification before retrying the inactive attempt' });
});

test('cleanup failure never settles or releases potentially live package ownership', async t => {
  const h = await fixture(t); await h.define([h.item()]); const start = h.ctx.workflowEngine.start.bind(h.ctx.workflowEngine);
  h.ctx.workflowEngine.start = request => { const run = start(request); return { ...run, id: run.id, result: run.result, cancel: reason => run.cancel(reason), async dispose() { await run.dispose(); throw new Error('cleanup failed'); } }; };
  await assert.rejects(h.execute(), error => error.taskWorkSaved === false && error.taskWorkState === 'in_progress');
  const current = await h.plan(); assert.equal(current.items[0].status, 'in_progress');
  await assert.rejects(h.work.reopen({ repo: h.repo, taskId: h.task.taskId, itemId: 'one', sessionId: String(h.second.session.id), expectedRevision: current.revision, reason: 'Must not release unresolved process ownership' }), /active|process|recovery/i);
});

test('partial event registration failure disposes the route and unlocks the owning resume token', async t => {
  const h = await fixture(t); await h.define([h.item()]);
  const canonicalTask = 'Stored description controls this run\nSupplementary clarification (cannot widen the assigned package): Clarification cannot authorize extra paths';
  const resumeId = await saveResume({ version: 1, ownerSessionId: String(h.first.session.id), cardRunId: 'earlier', recipe: 'feature-pipeline', task: canonicalTask, repo: h.repo, consumed: false, pendingQuestions: [], overridable: [], resume: {} }, h.runsDir);
  const on = h.ctx.on.bind(h.ctx); let subscriptions = 0;
  h.ctx.on = (name, callback) => { if (++subscriptions === 3) throw new Error('registration failed'); return on(name, callback); };
  await assert.rejects(h.execute(h.first, { resumeId }), error => error.taskWorkSaved === true && error.taskWorkState === 'blocked');
  assert.equal(h.calls.engine, 0); assert.deepEqual(h.runtime.subagents.list(), ['spawn']);
  assert.ok(!(await readdir(h.runsDir)).includes(resumeId + '.claim'));
  assert.equal(JSON.parse(await readFile(path.join(h.runsDir, resumeId + '.json'), 'utf8')).consumed, false);
});

test('source-only stored contracts preserve read-only stages and never imply runtime evidence', async t => {
  const h = await fixture(t, { recipe: 'qa-verify', result: { status: 'completed', changedPaths: [] } }); await h.define([h.item('one', { writePaths: [], readPaths: ['src.js'], verifyCommands: [] })]);
  const result = await h.execute(); assert.equal(result.result.taskWorkState, 'completed');
  assert.deepEqual(h.requests[0].toolFilter, { allow: ['read', 'read_image', 'glob', 'grep'] });
  assert.equal((await h.plan()).items[0].lastOutcome.verification.evidenceMode, 'source_only');
});

test('standing preset scope remains a root coordinator while real parentAgent lineage denies nested recipe execution', async t => {
  const h = await fixture(t), ctx = new Context(); t.after(() => ctx.fiber.dispose()); await h.define([h.item()]);
  for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop']) {
    await ctx.plugin((await import(runtimeModuleUrl('@deepseek-ai/dsh-' + name))).default, name === 'agent-loop' ? { agents: [] } : undefined);
  }
  const standing = { id: 'standing-auto-preset' }, standingScope = createScope(ctx, standing);
  const rootHandle = await ctx.agentLoop.createAgent(standingScope.ctx, { sessionId: 'actual-work-root', setup: (_agentCtx, agent) => { bindScopeParent(agent, standing); }, meta: { cwd: h.repo }, agentOptions: { provider: 'fixture', model: 'model' } });
  h.ctx.agents = ctx.agents; assert.equal(scopeParentOf(rootHandle.agent), standing); assert.equal(rootHandle.agent.parentAgent, undefined);
  h.ctx.workflowEngine.start = () => { h.calls.engine++; throw new Error('real root passed admission'); };
  await assert.rejects(h.execute(rootHandle.agent), /real root passed admission/);
  assert.equal((await h.plan()).items[0].status, 'blocked');
  const childHandle = await ctx.agentLoop.createAgent(ctx, { sessionId: 'actual-work-child', parentAgent: rootHandle.agent, meta: { cwd: h.repo }, agentOptions: { provider: 'fixture', model: 'model' } });
  assert.equal(ctx.agents.isOwnedBy(childHandle.agent.id, rootHandle.agent), true);
  await assert.rejects(h.execute(childHandle.agent), /top-level Auto coordinator/); assert.equal(h.calls.engine, 1);
});

test('reviewed planning automatically saves one graph without overwriting it or inventing known read scopes', async t => {
  const packageItem = { id: 'one', title: 'Inspect source', description: 'Source QA', goalIds: ['goal'], writePaths: [], acceptance: ['Inspect source'], verifyCommands: [], dependencies: [], recipe: 'qa-verify' };
  const result = { status: 'completed', changedPaths: [], packages: [packageItem], reviewTrail: [{ stage: 'evidence', goals: [{ id: 'goal', description: 'Source verification' }] }] };
  const h = await fixture(t, { recipe: 'plan-to-packages', result });
  const first = await h.execute(h.first, { workItemId: undefined }); assert.equal(first.result.taskWorkSaved, true);
  const initial = await h.plan(); assert.ok(!Object.hasOwn(initial.items[0], 'readPaths'));
  const second = await h.execute(h.second, { workItemId: undefined }); assert.equal(second.result.taskWorkSaved, false);
  assert.deepEqual(await h.plan(), initial, 'the first reviewed graph is preserved');
  const other = await h.memory.create({ repo: h.repo, title: 'Concurrent writer', goal: 'Separate task writer', sessionId: 'other-session' });
  await h.work.define({ repo: h.repo, taskId: other.taskId, sessionId: 'other-session', expectedRevision: 0, goals: [{ id: 'goal', description: 'Writer goal' }], items: [h.item('writer', { recipe: 'feature-pipeline', writePaths: ['other.js'], readPaths: [] })] });
  const writer = await h.work.claim({ repo: h.repo, taskId: other.taskId, itemId: 'writer', sessionId: 'other-session', recipe: 'feature-pipeline', runId: 'writer-run' });
  try {
    await assert.rejects(h.work.claim({ repo: h.repo, taskId: h.task.taskId, itemId: 'one', sessionId: String(h.second.session.id), recipe: 'qa-verify', runId: 'reader-run' }), /writer|scope|overlap/i);
  } finally { releaseTaskAttempt(writer.attempt.id); }
});

test('native cancellation blocks the owning item and a fresh session may reopen only after disposal', async t => {
  const h = await fixture(t); await h.define([h.item()]); const start = h.ctx.workflowEngine.start.bind(h.ctx.workflowEngine);
  h.ctx.workflowEngine.start = request => { const run = start(request); run.cancel('offline stop'); return run; };
  await assert.rejects(h.execute(), error => error.taskWorkSaved === true && error.taskWorkState === 'blocked');
  const current = await h.plan(); assert.equal(current.items[0].lastOutcome.status, 'cancelled');
  await h.work.reopen({ repo: h.repo, taskId: h.task.taskId, itemId: 'one', sessionId: String(h.second.session.id), expectedRevision: current.revision, reason: 'Inspected current workspace and restart with fresh analysis' });
  h.ctx.workflowEngine.start = start;
  assert.equal((await h.execute(h.second)).result.taskWorkState, 'completed');
  assert.equal(h.requests.at(-1).parent.session.id, h.second.session.id);
});
