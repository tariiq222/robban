import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realpath, mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apply, saveResume } from '../lib/recipes.mjs';
import { getTaskMemoryStore } from '../lib/task-memory.mjs';
import { approveRecipe } from '../lib/recipe-integrity.mjs';
import { createPtcFixture } from './helpers/ptc-runtime.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'task-memory-recipes-')));
  let runtime;
  t.after(async () => { try { await runtime?.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  const repo = path.join(root, 'repo'), other = path.join(root, 'other');
  await mkdir(repo); await mkdir(other);
  const recipesDir = path.join(root, 'recipes'), base = path.join(recipesDir, 'fixture');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'meta.json'), JSON.stringify({ name: 'fixture', description: 'Fresh read-only task analysis' }));
  await writeFile(path.join(base, 'script.js'), `const value=await agent('__AUTO_RECIPE_ROLE__'+JSON.stringify({token:args.routingToken,role:'analysis',label:'analysis',readOnly:true})+'\\nFresh analysis of '+args.task,{label:'analysis',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}});return {status:'completed',changedPaths:['src.js'],next_actions:['RAW_REPLY_CREDENTIAL'],answers:['RAW_HUMAN_ANSWER'],resumeId:'RAW_RESUME_ID',ok:value.ok};`);
  await approveRecipe(base, { approvedBy: 'offline-task-memory-fixture' });
  const listeners = new Map(), requests = [];
  const calls = { engine: 0, registration: 0, child: 0 };
  let tool;
  const provider = { capabilities: { agentOptions: true, outputSchema: true, toolFilter: true }, inheritsParentContext: false,
    async start(request) {
      requests.push(request); const id = 'task-child-' + ++calls.child;
      return { id, result: Promise.resolve({ stopReason: 'completed', output: [], structured: { ok: true } }), async dispose() {} };
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
  const store = getTaskMemoryStore(ctx, { memoryDir });
  const first = runtime.createParent(), second = runtime.createParent();
  const execute = (agent, args = {}) => tool.execute({ recipe: 'fixture', repo, task: 'Initial request', ...args }, { agent, signal: new AbortController().signal });
  const create = () => store.create({ repo, title: 'Explicit task', goal: 'Preserve the fixed original goal', sessionId: String(first.session.id) });
  return { root, repo, other, ctx, store, first, second, execute, create, requests, calls, runsDir };
}

test('explicit task id connects two sessions as bounded untrusted notes while every run starts fresh analysis', async t => {
  const h = await fixture(t), task = await h.create();
  h.first.session.append('private/session-fixture', { text: 'DO_NOT_COPY_RAW_SESSION' }, { ignorable: true });
  const initial = await h.execute(h.first, { taskId: task.taskId });
  assert.equal(initial.result.taskId, task.taskId); assert.equal(initial.result.taskMemorySaved, true);
  const next = await h.execute(h.second, { taskId: task.taskId, task: 'Refined request with the same explicit goal' });
  assert.equal(next.result.taskMemorySaved, true);
  const saved = await h.store.get({ repo: h.repo, taskId: task.taskId });
  assert.equal(saved.goal, task.goal); assert.equal(saved.entries.length, 2);
  assert.deepEqual(saved.entries.map(entry => entry.sessionId), [String(h.first.session.id), String(h.second.session.id)]);
  assert.equal(h.calls.child, 2, 'each new session enters one fresh analysis child');
  const prompt = h.requests[1].prompt.map(block => block.text ?? '').join('\n');
  assert.match(prompt, /UNTRUSTED PRIOR TASK NOTES/); assert.match(prompt, /Preserve the fixed original goal/);
  assert.match(prompt, new RegExp(initial.result.cardRunId)); assert.match(prompt, /Refined request/);
  assert.deepEqual(h.requests[1].toolFilter, { allow: ['read', 'read_image', 'glob', 'grep'] });
  for (const privateValue of ['DO_NOT_COPY_RAW_SESSION', 'RAW_REPLY_CREDENTIAL', 'RAW_HUMAN_ANSWER', 'RAW_RESUME_ID']) {
    assert.ok(!JSON.stringify(saved).includes(privateValue)); assert.ok(!prompt.includes(privateValue));
  }
});

test('unknown and foreign repository task ids fail before cache, resume claims or engine admission', async t => {
  const h = await fixture(t), foreign = await h.store.create({ repo: h.other, title: 'Other', goal: 'Other goal', sessionId: 'foreign-session' });
  for (const taskId of [randomUUID(), foreign.taskId]) await assert.rejects(h.execute(h.first, { taskId, resumeId: 'invalid-token' }), error => error.code === 'TASK_MEMORY_NOT_FOUND' || error.code === 'TASK_MEMORY_REPO_MISMATCH');
  assert.deepEqual(h.calls, { engine: 0, registration: 0, child: 0 });
  assert.ok(!(await readdir(h.root)).some(name => ['runs', 'cache'].includes(name)));
});

test('memory write failure reports unsaved notes without rerunning or failing successful work', async t => {
  const h = await fixture(t), task = await h.create();
  h.store.append = async () => { throw Object.assign(new Error('PRIVATE_WRITE_DETAIL'), { code: 'EIO' }); };
  const result = await h.execute(h.first, { taskId: task.taskId });
  assert.equal(result.result.status, 'completed'); assert.equal(result.result.taskMemorySaved, false);
  assert.match(result.result.taskMemoryWarning, /do not rerun completed work/);
  assert.ok(!JSON.stringify(result.result).includes('PRIVATE_WRITE_DETAIL')); assert.equal(h.calls.child, 1);
  assert.equal((await h.store.get({ repo: h.repo, taskId: task.taskId })).entries.length, 0);
});

test('CAS retry preserves concurrent notes and the original session identity, with three attempts maximum', async t => {
  const h = await fixture(t), task = await h.create();
  const append = h.store.append.bind(h.store); let attempts = 0;
  h.store.append = async args => {
    if (++attempts === 1) await append({ ...args, sessionId: 'concurrent-session', entry: { kind: 'progress', text: 'Concurrent note' } });
    return append(args);
  };
  assert.equal((await h.execute(h.first, { taskId: task.taskId })).result.taskMemorySaved, true);
  const saved = await h.store.get({ repo: h.repo, taskId: task.taskId });
  assert.equal(attempts, 2); assert.equal(saved.entries[0].text, 'Concurrent note');
  assert.equal(saved.entries[1].sessionId, String(h.first.session.id));
  attempts = 0;
  h.store.append = async () => { attempts++; throw Object.assign(new Error('conflict'), { code: 'TASK_MEMORY_CONFLICT' }); };
  const result = await h.execute(h.second, { taskId: task.taskId });
  assert.equal(attempts, 3); assert.equal(result.result.taskMemorySaved, false); assert.equal(h.calls.child, 2);
});

test('cross-session notes never transfer an owning-session resume token or human decision receipt', async t => {
  const h = await fixture(t), task = await h.create();
  const resumeId = await saveResume({ version: 1, ownerSessionId: String(h.first.session.id), cardRunId: 'old-run', recipe: 'fixture', task: 'Initial request', repo: h.repo, consumed: false, pendingQuestions: [], overridable: [], resume: {} }, h.runsDir);
  await assert.rejects(h.execute(h.second, { taskId: task.taskId, resumeId }), /session|owner/i);
  assert.deepEqual(h.calls, { engine: 0, registration: 0, child: 0 });
  assert.equal(JSON.parse(await readFile(path.join(h.runsDir, resumeId + '.json'), 'utf8')).consumed, false);
});

test('task context includes only bounded last ten notes and preserves read-only tool restrictions', async t => {
  const h = await fixture(t); let task = await h.create();
  for (let index = 0; index < 15; index++) task = await h.store.append({ repo: h.repo, taskId: task.taskId, sessionId: String(h.first.session.id), expectedRevision: task.revision, entry: { kind: 'progress', text: 'NOTE_' + index + '_' + 'x'.repeat(1000) } });
  await h.execute(h.second, { taskId: task.taskId });
  const prompt = h.requests[0].prompt.map(block => block.text ?? '').join('\n');
  assert.ok(!prompt.includes('NOTE_0_')); assert.ok(prompt.includes('NOTE_5_')); assert.ok(prompt.includes('NOTE_14_'));
  assert.ok(prompt.length < 12000); assert.deepEqual(h.requests[0].toolFilter, { allow: ['read', 'read_image', 'glob', 'grep'] });
});

test('omitting taskId retains the existing run contract without automatic task discovery or writes', async t => {
  const h = await fixture(t);
  const result = await h.execute(h.first);
  assert.equal(result.result.status, 'completed'); assert.ok(!Object.hasOwn(result.result, 'taskId'));
  assert.ok(!Object.hasOwn(result.result, 'taskMemorySaved')); assert.equal(h.calls.child, 1);
  assert.ok(!(await readdir(h.root)).includes('memory'));
});

test('native cancelled PTC runs retain cancellation as the task outcome without copying failure text', async t => {
  const h = await fixture(t), task = await h.create();
  const start = h.ctx.workflowEngine.start.bind(h.ctx.workflowEngine);
  h.ctx.workflowEngine.start = request => { const run = start(request); run.cancel('PRIVATE_CANCEL_REASON'); return run; };
  await assert.rejects(h.execute(h.first, { taskId: task.taskId }), error => error.taskId === task.taskId && error.taskMemorySaved === true);
  const saved = await h.store.get({ repo: h.repo, taskId: task.taskId });
  assert.equal(saved.entries.length, 1); assert.equal(JSON.parse(saved.entries[0].text).status, 'cancelled');
  assert.ok(!JSON.stringify(saved).includes('PRIVATE_CANCEL_REASON'));
});

test('synchronous engine failure records only a generic failed outcome in the originating session', async t => {
  const h = await fixture(t), task = await h.create();
  h.ctx.workflowEngine.start = () => { throw new Error('RAW_START_CREDENTIAL'); };
  await assert.rejects(h.execute(h.first, { taskId: task.taskId }), error => error.taskMemorySaved === true);
  const saved = await h.store.get({ repo: h.repo, taskId: task.taskId });
  assert.equal(JSON.parse(saved.entries[0].text).status, 'error'); assert.equal(saved.entries[0].sessionId, String(h.first.session.id));
  assert.ok(!JSON.stringify(saved).includes('RAW_START_CREDENTIAL'));
});

test('recipe memory and stage-skill configuration errors fail at load before tool registration', () => {
  let registrations = 0;
  const ctx = { tools: { register() { registrations++; } } };
  for (const memoryDir of ['', 'relative', null, 42]) assert.throws(() => apply(ctx, { memoryDir }), /memoryDir/);
  for (const stageSkillsEnabled of ['false', 0, null]) assert.throws(() => apply(ctx, { stageSkillsEnabled }), /stageSkillsEnabled/);
  assert.equal(registrations, 0);
});
