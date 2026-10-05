import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskMemoryStore } from '../lib/task-memory-store.mjs';
import { TaskWorkStore, projectTaskWork, releaseTaskAttempt } from '../lib/task-work-store.mjs';
const execute = promisify(execFile);
const moduleUrl = new URL('../lib/task-work-store.mjs', import.meta.url).href;
const goals = [{ id: 'routing', description: 'Preserve model route admission' }];
const item = (id, extra = {}) => ({ id, title: `Repair ${id}`, description: 'Preserve existing behavior', goalIds: ['routing'], writePaths: [`src/${id}.js`], readPaths: [], acceptance: ['Existing route tests pass'], verifyCommands: ['npm test'], dependencies: [], recipe: 'bug-fix', ...extra });
const report = (status = 'completed', passed = true, extra = {}) => ({ kind: 'reported_recipe_result', status, summary: 'Reported recipe result', verification: { passed, summary: 'Recipe reported exact acceptance checks passing' }, ...extra });
const code = value => ({ code: `TASK_WORK_${value}` });
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'task-work-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), other = path.join(root, 'other'), dir = path.join(root, 'memory'); await mkdir(repo); await mkdir(other);
  const memory = new TaskMemoryStore({ dir }), store = new TaskWorkStore({ dir });
  const task = await memory.create({ repo, title: 'Task', goal: 'Original task goal', sessionId: 'session-a' });
  const taskId = task.taskId, define = (items, custom = {}) => store.define({ repo, taskId, sessionId: 'session-a', expectedRevision: 0, goals, items, ...custom });
  const claim = (itemId, extra = {}) => store.claim({ repo, taskId, itemId, sessionId: 'session-a', recipe: 'bug-fix', runId: `run-${itemId}`, ...extra });
  const settle = (itemId, attempt, outcome = report()) => store.settle({ repo, taskId, itemId, sessionId: attempt.sessionId, attemptId: attempt.id, outcome });
  return { root, repo, other, dir, memory, store, taskId, task, define, claim, settle };
}
async function remember(t, promise) { const result = await promise; t.after(() => releaseTaskAttempt(result.attempt.id)); return result; }

test('plans persist across stores and sessions without changing released task note JSON', async t => {
  const f = await fixture(t), file = f.memory.filename(f.taskId, f.repo), before = await readFile(file, 'utf8');
  assert.equal(await f.store.get({ repo: f.repo, taskId: f.taskId }), null);
  const saved = await f.define([item('first'), item('second', { dependencies: ['first'] })]);
  assert.equal(saved.revision, 1); assert.equal(saved.items[0].evidenceMode, 'runtime');
  const restored = await new TaskWorkStore({ dir: f.dir }).get({ repo: f.repo, taskId: f.taskId }); assert.deepEqual(restored, saved);
  assert.deepEqual(projectTaskWork(restored).items.map(value => value.readiness), ['ready', 'waiting']);
  assert.equal(projectTaskWork(restored).goals[0].completedCount, 0); assert.equal(Object.hasOwn(projectTaskWork(restored).goals[0], 'status'), false);
  assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(f.store.get({ repo: f.other, taskId: f.taskId }), { code: 'TASK_MEMORY_NOT_FOUND' });
});

test('definition validates graph coverage, IDs, cycles, duplicate edges and literal scopes', async t => {
  const f = await fixture(t);
  const invalid = [
    [item('first'), item('first')], [item('first', { goalIds: ['unknown'] })], [item('first', { dependencies: ['first'] })],
    [item('first', { dependencies: ['second'] }), item('second', { dependencies: ['first'] })], [item('first', { dependencies: ['unknown'] })],
    [item('first', { dependencies: ['second', 'second'] }), item('second')], [item('Bad')], [item('first', { writePaths: ['../outside'] })],
    [item('first', { writePaths: ['src/*.js'] })], [item('first', { writePaths: [] })], [item('first', { verifyCommands: [] })],
    [item('first', { evidenceMode: 'source_only' })], [item('first', { recipe: 'plan-to-packages' })],
  ];
  for (const items of invalid) await assert.rejects(f.define(items), code('INVALID'));
  await assert.rejects(f.define([item('first')], { goals: [...goals, { id: 'extra', description: 'Uncovered goal' }] }), code('INVALID'));
  assert.equal(await f.store.get({ repo: f.repo, taskId: f.taskId }), null);
});

test('oversized execution context is rejected at definition without persisting an unrunnable item', async t => {
  const f = await fixture(t); await assert.rejects(f.define([item('first', { acceptance: Array.from({ length: 20 }, (_, n) => `${n} ${'x'.repeat(1800)}`) })]), code('LIMIT'));
  assert.equal(await f.store.get({ repo: f.repo, taskId: f.taskId }), null);
});

test('dependency readiness advances only after exact owning verified recipe completion', async t => {
  const f = await fixture(t); await f.define([item('first'), item('second', { dependencies: ['first'] })]);
  await assert.rejects(f.claim('second'), code('DEPENDENCY'));
  const first = await remember(t, f.claim('first'));
  await assert.rejects(f.store.settle({ repo: f.repo, taskId: f.taskId, itemId: 'first', sessionId: 'foreign', attemptId: first.attempt.id, outcome: report() }), code('OWNERSHIP'));
  const completed = await f.settle('first', first.attempt); assert.equal(completed.items[0].status, 'completed');
  assert.deepEqual(projectTaskWork(completed).items.map(value => value.readiness), ['completed', 'ready']);
  assert.equal(projectTaskWork(completed).goals[0].completedCount, 1);
  await assert.rejects(f.settle('first', first.attempt), code('OWNERSHIP'));
  releaseTaskAttempt(first.attempt.id); const second = await remember(t, f.claim('second')); assert.equal(second.plan.items[1].status, 'in_progress');
});

test('unverified completed and non-success outcomes stay blocked; note-like reports cannot complete work', async t => {
  const f = await fixture(t); await f.define([item('first')]); const claimed = await remember(t, f.claim('first'));
  await assert.rejects(f.settle('first', claimed.attempt, { kind: 'note', status: 'completed', summary: 'Done', verification: { passed: true, summary: 'Trust me' } }), code('INVALID'));
  const blocked = await f.settle('first', claimed.attempt, report('completed', false)); assert.equal(blocked.items[0].status, 'blocked');
  releaseTaskAttempt(claimed.attempt.id);
  const reopened = await f.store.reopen({ repo: f.repo, taskId: f.taskId, itemId: 'first', sessionId: 'session-b', expectedRevision: blocked.revision, reason: 'Retry verification' }); assert.equal(reopened.items[0].status, 'pending');
  const retry = await remember(t, f.claim('first', { runId: 'run-first-retry', sessionId: 'session-b' }));
  await assert.rejects(f.settle('first', claimed.attempt), code('OWNERSHIP'));
  assert.equal((await f.settle('first', retry.attempt, report('needs_decision', false))).items[0].status, 'blocked');
});

test('claim races reserve one item exactly once without lost revisions', async t => {
  const f = await fixture(t); await f.define([item('first')]); const other = new TaskWorkStore({ dir: f.dir });
  const results = await Promise.allSettled([f.store, other].map((store, n) => store.claim({ repo: f.repo, taskId: f.taskId, itemId: 'first', sessionId: `s-${n}`, recipe: 'bug-fix', runId: `r-${n}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'fulfilled') t.after(() => releaseTaskAttempt(result.value.attempt.id));
  assert.equal((await f.store.get({ repo: f.repo, taskId: f.taskId })).revision, 2);
});

test('read/write and ancestor scopes serialize while disjoint edits may overlap', async t => {
  const f = await fixture(t); await f.define([item('first', { writePaths: ['src/shared'] }), item('second', { readPaths: ['src/shared/api.js'], dependencies: ['first'] }), item('third')]);
  const first = await remember(t, f.claim('first')); await assert.rejects(f.claim('second'), code('DEPENDENCY')); await remember(t, f.claim('third'));
  await f.settle('first', first.attempt); await assert.rejects(f.claim('second'), code('SCOPE'));
  releaseTaskAttempt(first.attempt.id); await remember(t, f.claim('second'));
});

test('live attempts cannot be reopened or erased; host cleanup permits conservative interrupted recovery', async t => {
  const f = await fixture(t); await f.define([item('first')]); const claimed = await remember(t, f.claim('first'));
  await assert.rejects(f.define([item('other')], { expectedRevision: claimed.plan.revision }), code('STATE'));
  const request = { repo: f.repo, taskId: f.taskId, itemId: 'first', sessionId: 'session-b', expectedRevision: claimed.plan.revision, reason: 'Owner interrupted' };
  await assert.rejects(f.store.reopen(request), code('BUSY'));
  releaseTaskAttempt(claimed.attempt.id); const reopened = await f.store.reopen(request); assert.equal(reopened.items[0].status, 'pending'); assert.equal(reopened.items[0].lastOutcome.status, 'interrupted');
  assert.match(reopened.items[0].lastOutcome.verification.summary, /current diff/);
});

test('CAS protects definition/block/reopen and completed work cannot be manually reopened', async t => {
  const f = await fixture(t); await f.define([item('first')]); await assert.rejects(f.define([item('second')]), code('CONFLICT'));
  const blocked = await f.store.block({ repo: f.repo, taskId: f.taskId, itemId: 'first', sessionId: 'session-b', expectedRevision: 1, reason: 'Need clarification' });
  await assert.rejects(f.store.reopen({ repo: f.repo, taskId: f.taskId, itemId: 'first', sessionId: 'session-b', expectedRevision: 1, reason: 'Answered' }), code('CONFLICT'));
  await f.store.reopen({ repo: f.repo, taskId: f.taskId, itemId: 'first', sessionId: 'session-b', expectedRevision: blocked.revision, reason: 'Answered' });
  const claimed = await remember(t, f.claim('first')), done = await f.settle('first', claimed.attempt); releaseTaskAttempt(claimed.attempt.id);
  await assert.rejects(f.store.reopen({ repo: f.repo, taskId: f.taskId, itemId: 'first', sessionId: 'session-b', expectedRevision: done.revision, reason: 'Change again' }), code('STATE'));
});

test('read-only source items preserve source evidence mode and manual items never run', async t => {
  const f = await fixture(t); const saved = await f.define([item('first', { recipe: 'code-audit', writePaths: [], readPaths: ['src'], verifyCommands: [] }), item('manual', { recipe: 'manual', writePaths: [], verifyCommands: [] })]);
  assert.equal(saved.items[0].evidenceMode, 'source_only'); assert.equal(saved.items[1].status, 'blocked');
  await assert.rejects(f.claim('manual', { recipe: 'manual' }), code('INVALID'));
  const claimed = await remember(t, f.claim('first', { recipe: 'code-audit' }));
  await assert.rejects(f.settle('first', claimed.attempt, report('completed', true, { verification: { passed: true, summary: 'Runtime proof', evidenceMode: 'runtime' } })), code('INVALID'));
  const done = await f.settle('first', claimed.attempt); assert.equal(done.items[0].lastOutcome.verification.evidenceMode, 'source_only');
});

test('repository-wide reservations serialize overlapping tasks and fail closed on malformed work records', async t => {
  const f = await fixture(t); await f.define([item('first')]); const claimed = await remember(t, f.claim('first'));
  const second = await f.memory.create({ repo: f.repo, title: 'Other', goal: 'Other goal', sessionId: 's' });
  await f.store.define({ repo: f.repo, taskId: second.taskId, sessionId: 's', expectedRevision: 0, goals, items: [item('first')] });
  const request = { repo: f.repo, taskId: second.taskId, itemId: 'first', sessionId: 's', recipe: 'bug-fix', runId: 'other-run' };
  await assert.rejects(f.store.claim(request), code('SCOPE'));
  await f.settle('first', claimed.attempt); releaseTaskAttempt(claimed.attempt.id);
  await writeFile(f.store.filename(f.taskId, f.repo), '{malformed');
  await assert.rejects(f.store.claim(request), { code: 'TASK_MEMORY_INVALID' });
});

test('two real processes claiming overlapping task plans cannot bypass durable repository admission', async t => {
  const f = await fixture(t); await f.define([item('first')]);
  const second = await f.memory.create({ repo: f.repo, title: 'Second', goal: 'Second', sessionId: 's' });
  await f.store.define({ repo: f.repo, taskId: second.taskId, sessionId: 's', expectedRevision: 0, goals, items: [item('first')] });
  const run = async taskId => {
    const request = { repo: f.repo, taskId, itemId: 'first', sessionId: 'child', recipe: 'bug-fix', runId: taskId };
    const source = `import {TaskWorkStore} from ${JSON.stringify(moduleUrl)};const store=new TaskWorkStore({dir:${JSON.stringify(f.dir)}});try{const r=await store.claim(${JSON.stringify(request)});console.log(JSON.stringify({ok:true,attempt:r.attempt}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}`;
    return JSON.parse((await execute(process.execPath, ['--input-type=module', '-e', source], { env: {}, timeout: 10000 })).stdout);
  };
  const results = await Promise.all([f.taskId, second.taskId].map(run)); assert.equal(results.filter(value => value.ok).length, 1);
  assert.ok(['TASK_MEMORY_BUSY', 'TASK_WORK_SCOPE'].includes(results.find(value => !value.ok).code));
  const claimedIndex = results.findIndex(value => value.ok), taskId = [f.taskId, second.taskId][claimedIndex], saved = await f.store.get({ repo: f.repo, taskId });
  const recovered = await f.store.reopen({ repo: f.repo, taskId, itemId: 'first', sessionId: 'session-b', expectedRevision: saved.revision, reason: 'Child process exited' });
  assert.equal(recovered.items[0].status, 'pending');
});

test('symbolic-link scope aliases and work data files fail before claiming or overwriting targets', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await mkdir(outside); await symlink(outside, path.join(f.repo, 'alias'), 'dir');
  await assert.rejects(f.define([item('first', { writePaths: ['alias/file.js'] })]), code('UNSAFE'));
  await f.define([item('first')]); const work = f.store.filename(f.taskId, f.repo), before = await readFile(work, 'utf8'); await rm(work); const target = path.join(f.root, 'foreign'); await writeFile(target, before, { mode: 0o600 }); await symlink(target, work);
  await assert.rejects(f.claim('first'), { code: 'TASK_MEMORY_UNSAFE' }); assert.equal(await readFile(target, 'utf8'), before);
});

test('unknown read scopes serialize repository writers while explicit empty reads allow disjoint edits', async t => {
  const f = await fixture(t), unknown = item('unknown'); delete unknown.readPaths;
  await f.define([unknown, item('writer')]);
  const claimed = await remember(t, f.claim('writer'));
  assert.equal(projectTaskWork(claimed.plan).items[0].readScopeDeclared, false);
  await assert.rejects(f.claim('unknown'), code('SCOPE'));
  await f.settle('writer', claimed.attempt); releaseTaskAttempt(claimed.attempt.id);
  await remember(t, f.claim('unknown'));
  const task = await f.memory.create({ repo: f.repo, title: 'Different', goal: 'Different', sessionId: 's' });
  await f.store.define({ repo: f.repo, taskId: task.taskId, sessionId: 's', expectedRevision: 0, goals, items: [item('disjoint')] });
  await assert.rejects(f.store.claim({ repo: f.repo, taskId: task.taskId, itemId: 'disjoint', sessionId: 's', recipe: 'bug-fix', runId: 'cross-unknown' }), code('SCOPE'));
});

test('definition budget reserves space for bounded runtime attempt and outcome metadata', async t => {
  const f = await fixture(t); const acceptance = Array.from({ length: 12 }, (_, n) => `${n} ${'x'.repeat(1800)}`);
  await f.define([item('large', { acceptance })]); const claimed = await remember(t, f.claim('large'));
  const done = await f.settle('large', claimed.attempt, report('completed', true, { summary: 's'.repeat(2000), verification: { passed: true, summary: 'v'.repeat(2000) } }));
  assert.equal(done.items[0].status, 'completed');
});

test('a reused live PID with a foreign process token is never treated as local abandoned work', async t => {
  const f = await fixture(t); await f.define([item('first')]); const claimed = await remember(t, f.claim('first'));
  releaseTaskAttempt(claimed.attempt.id); const saved = await f.store.get({ repo: f.repo, taskId: f.taskId });
  saved.items[0].attempt.processToken = '11111111-1111-4111-8111-111111111111';
  await writeFile(f.store.filename(f.taskId, f.repo), JSON.stringify(saved), { mode: 0o600 });
  await assert.rejects(f.store.reopen({ repo: f.repo, taskId: f.taskId, itemId: 'first', sessionId: 's', expectedRevision: saved.revision, reason: 'Attempt appears abandoned' }), code('BUSY'));
});

test('simultaneous independent claims across store instances both publish before their recipes settle', async t => {
  const f = await fixture(t); await f.define([item('first'), item('second')]);
  const other = new TaskWorkStore({ dir: f.dir });
  const claimed = await Promise.all(['first', 'second'].map((itemId, n) => [f.store, other][n].claim({ repo: f.repo, taskId: f.taskId, itemId, sessionId: `s-${n}`, recipe: 'bug-fix', runId: `r-${n}` })));
  for (const result of claimed) t.after(() => releaseTaskAttempt(result.attempt.id));
  const plan = await f.store.get({ repo: f.repo, taskId: f.taskId }); assert.equal(plan.revision, 3); assert.deepEqual(plan.items.map(value => value.status), ['in_progress', 'in_progress']);
});

test('simultaneous independent task plans share the local admission queue without blocking whole runs', async t => {
  const f = await fixture(t); await f.define([item('first')]);
  const second = await f.memory.create({ repo: f.repo, title: 'Second', goal: 'Second', sessionId: 's' }), other = new TaskWorkStore({ dir: f.dir });
  await other.define({ repo: f.repo, taskId: second.taskId, sessionId: 's', expectedRevision: 0, goals, items: [item('second')] });
  const claimed = await Promise.all([
    f.claim('first'),
    other.claim({ repo: f.repo, taskId: second.taskId, itemId: 'second', sessionId: 's', recipe: 'bug-fix', runId: 'second-run' }),
  ]);
  for (const result of claimed) t.after(() => releaseTaskAttempt(result.attempt.id));
  assert.equal((await f.store.get({ repo: f.repo, taskId: f.taskId })).items[0].status, 'in_progress');
  assert.equal((await other.get({ repo: f.repo, taskId: second.taskId })).items[0].status, 'in_progress');
});

test('overlapping local claim rejection does not poison the queued independent follower', async t => {
  const f = await fixture(t), unknown = item('unknown'); delete unknown.readPaths;
  await f.define([item('first'), unknown, item('third'), item('fourth')]);
  await remember(t, f.claim('first'));
  const other = new TaskWorkStore({ dir: f.dir }), third = new TaskWorkStore({ dir: f.dir });
  const results = await Promise.allSettled([other, third].map((store, n) => store.claim({ repo: f.repo, taskId: f.taskId, itemId: ['unknown', 'third'][n], sessionId: 's', recipe: 'bug-fix', runId: `r-${n}` })));
  for (const result of results) if (result.status === 'fulfilled') t.after(() => releaseTaskAttempt(result.value.attempt.id));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'TASK_WORK_SCOPE');
  await remember(t, f.claim('fourth'));
  assert.deepEqual((await f.store.get({ repo: f.repo, taskId: f.taskId })).items.filter(value => value.status === 'in_progress').map(value => value.id), ['first', 'third', 'fourth']);
});


test('settlement waits for an in-process note writer and preserves both durable revisions', async t => {
  const f = await fixture(t); await f.define([item('first')]);
  const claimed = await remember(t, f.claim('first'));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const write = f.memory.write.bind(f.memory);
  f.memory.write = async record => { entered.resolve(); await release.promise; return write(record); };
  const append = f.memory.append({ repo: f.repo, taskId: f.taskId, sessionId: 'note-owner', expectedRevision: 0, entry: { kind: 'progress', text: 'Independent recipe outcome' } });
  const pending = [append];
  append.catch(() => {});
  let note, work;
  try {
    await entered.promise;
    // The second directory check belongs to the task lock nested inside admission.
    const directory = f.store.directory.bind(f.store);
    const attempted = Promise.withResolvers(); let checks = 0;
    f.store.directory = async repo => { await directory(repo); if (++checks === 2) attempted.resolve(); };
    const settlement = f.settle('first', claimed.attempt); pending.push(settlement);
    settlement.catch(() => {});
    await attempted.promise;
    await f.memory.get({ repo: f.repo, taskId: f.taskId });
    release.resolve();
    [note, work] = await Promise.all(pending);
  } finally { release.resolve(); await Promise.allSettled(pending); }
  assert.equal(note.revision, 1); assert.equal(work.revision, 3);
  assert.equal((await f.store.get({ repo: f.repo, taskId: f.taskId })).items[0].status, 'completed');
  assert.equal((await f.memory.get({ repo: f.repo, taskId: f.taskId })).entries[0].text, 'Independent recipe outcome');
});

test('same-process note and work-plan writers of one task queue instead of reporting a busy lock', async t => {
  const f = await fixture(t); await f.define([item('first'), item('second')]);
  const first = await remember(t, f.claim('first')), second = await remember(t, f.claim('second'));
  const note = index => f.memory.append({ repo: f.repo, taskId: f.taskId, sessionId: 'session-a', expectedRevision: index, entry: { kind: 'run', text: `outcome ${index}` } });
  await Promise.all([note(0), f.settle('first', first.attempt), f.settle('second', second.attempt), note(0).catch(error => { assert.equal(error.code, 'TASK_MEMORY_CONFLICT'); return note(1); })]);
  assert.deepEqual((await f.store.get({ repo: f.repo, taskId: f.taskId })).items.map(value => value.status), ['completed', 'completed']);
  assert.equal((await f.memory.get({ repo: f.repo, taskId: f.taskId })).entries.length, 2);
});
