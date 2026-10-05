import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { apply, getTaskMemoryStore } from '../lib/task-memory.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
const { bindScopeParent } = await import(runtimeModuleUrl('@deepseek-ai/dsh-scope'));
const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-memory-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), memoryDir = path.join(root, 'memory');
  await mkdir(repo);
  let tool, registered = false;
  const disposers = [];
  const ctx = { effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; }, tools: { register(value) { tool = value; registered = true; return () => { registered = false; }; } } };
  apply(ctx, { memoryDir });
  t.after(() => disposers.reverse().forEach(dispose => dispose()));
  const agent = { session: { id: 'session-1', header: { cwd: repo } } };
  return { root, repo, memoryDir, ctx, tool, agent, registered: () => registered, dispose: () => disposers.forEach(fn => fn()), call: (args, caller = agent) => tool.execute(args, { agent: caller }) };
}

test('actual tool declares bounded actions and canonical JSON output with registration cleanup', async t => {
  const f = await fixture(t);
  assert.equal(f.tool.name, 'task_memory');
  assert.match(f.tool.description, /not verified human permission/);
  const created = await f.call({ action: 'create', title: 'Repair', goal: 'Fix scoped defect' });
  assert.equal(created.task.revision, 0);
  assert.equal(created.task.entryCount, 0);
  assert.equal(created.task.entries, undefined);
  assert.equal(f.tool.parameters.properties.repo, undefined);
  const rendered = f.tool.output.render({}, created);
  assert.deepEqual(JSON.parse(rendered[0].text), created);
  assertObjectJsonSchema(f.tool.parameters);
  assert.deepEqual(validateJsonSchemaValue(f.tool.parameters, { action: 'create', title: 'Repair', goal: 'Fix scoped defect' }), []);
  assert.deepEqual(validateJsonSchemaValue(f.tool.output.schema, created), []);
  await assert.rejects(f.call({ action: 'destroy' }), /action/);
  await assert.rejects(f.call({ action: 'list', limit: '20' }), /limit/);
  assert.equal(f.registered(), true);
  f.dispose();
  assert.equal(f.registered(), false);
});

test('explicit task id persists across sessions without joining same-title tasks', async t => {
  const f = await fixture(t);
  const a = await f.call({ action: 'create', title: 'Same', goal: 'First' });
  const b = await f.call({ action: 'create', title: 'Same', goal: 'Second' });
  assert.notEqual(a.task.taskId, b.task.taskId);
  const caller = { session: { id: 'session-2', header: { cwd: f.repo } } };
  const appended = await f.call({ action: 'append', taskId: a.task.taskId, expectedRevision: 0, entry: { kind: 'progress', text: 'Reported progress', refs: ['src.js:1'] } }, caller);
  assert.equal(appended.task.revision, 1);
  assert.equal(appended.appendedEntry.sessionId, 'session-2');
  assert.equal(appended.task.entries, undefined);
  const read = await f.call({ action: 'read', taskId: a.task.taskId }, caller);
  assert.equal(read.task.entries[0].text, 'Reported progress');
  assert.equal(read.remainingEntries, 0);
  assert.equal((await f.call({ action: 'read', taskId: b.task.taskId })).task.entries.length, 0);
  assert.equal((await f.call({ action: 'list' })).tasks.length, 2);
});

test('children cannot create or append even with root-looking headers but may read/list', async t => {
  const f = await fixture(t);
  const created = await f.call({ action: 'create', title: 'Root', goal: 'Root task' });
  const scoped = { parentAgent: f.agent, session: { id: 'child', header: { cwd: f.repo } } };
  bindScopeParent(scoped, f.agent);
  for (const child of [scoped, { session: { id: 'child', header: { cwd: f.repo, origin: 'subagent' } } }, { session: { id: 'child', header: { cwd: f.repo, delegationDepth: 1 } } }]) {
    await assert.rejects(f.call({ action: 'create', title: 'No', goal: 'No' }, child), /top-level coordinator/);
    await assert.rejects(f.call({ action: 'append', taskId: created.task.taskId, expectedRevision: 0, entry: { kind: 'decision', text: 'No authority' } }, child), /top-level coordinator/);
    assert.equal((await f.call({ action: 'read', taskId: created.task.taskId }, child)).task.revision, 0);
    assert.equal((await f.call({ action: 'list' }, child)).tasks.length, 1);
  }
});

test('standing preset scope parent does not make a root coordinator a child', async t => {
  const f = await fixture(t);
  bindScopeParent(f.agent, {});
  const created = await f.call({ action: 'create', title: 'Root preset', goal: 'Legitimate root task' });
  assert.equal(created.task.revision, 0);
  const appended = await f.call({ action: 'append', taskId: created.task.taskId, expectedRevision: 0, entry: { kind: 'progress', text: 'root note' } });
  assert.equal(appended.task.revision, 1);
});

test('revision-pinned newest-first pagination reports omitted history and rejects shifted pages', async t => {
  const f = await fixture(t);
  const created = await f.call({ action: 'create', title: 'History', goal: 'Keep notes' });
  for (let i = 0; i < 3; i++) await f.call({ action: 'append', taskId: created.task.taskId, expectedRevision: i, entry: { kind: 'evidence', text: `reported-${i}` } });
  const first = await f.call({ action: 'read', taskId: created.task.taskId, limit: 2 });
  assert.deepEqual(first.task.entries.map(e => e.text), ['reported-2', 'reported-1']);
  assert.equal(first.remainingEntries, 1);
  const older = await f.call({ action: 'read', taskId: created.task.taskId, limit: 2, cursor: first.nextCursor, expectedRevision: first.observedRevision });
  assert.deepEqual(older.task.entries.map(e => e.text), ['reported-0']);
  assert.equal(older.nextCursor, null);
  await assert.rejects(f.call({ action: 'read', taskId: created.task.taskId, cursor: 2 }), /expectedRevision/);
  await f.call({ action: 'append', taskId: created.task.taskId, expectedRevision: 3, entry: { kind: 'next_step', text: 'new' } });
  await assert.rejects(f.call({ action: 'read', taskId: created.task.taskId, cursor: 2, expectedRevision: 3 }), /stale revision.*reread/);
  await assert.rejects(f.call({ action: 'append', taskId: created.task.taskId, expectedRevision: 3, entry: { kind: 'decision', text: 'Reported only' } }), /stale revision.*reread/);
  assert.equal((await f.call({ action: 'read', taskId: created.task.taskId })).totalEntries, 4);
});

test('workspace is session-owned and invalid bounds fail before returning unbounded context', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call({ action: 'list', repo: '/other' }), /calling session/);
  await assert.rejects(f.call({ action: 'list' }, { session: { id: 'x', header: {} } }), /workspace cwd/);
  for (const limit of [0, 21, 1.5]) await assert.rejects(f.call({ action: 'list', limit }), /limit/);
  await assert.rejects(f.call({ action: 'append', taskId: 'missing', entry: { kind: 'progress', text: 'x' } }), /expectedRevision/);
  assert.equal(getTaskMemoryStore(f.ctx, { memoryDir: f.memoryDir }), getTaskMemoryStore(f.ctx, { memoryDir: f.memoryDir }));
  assert.throws(() => getTaskMemoryStore(f.ctx, { memoryDir: path.join(f.root, 'other-memory') }), /differs/);
});

test('invalid configured memory directory fails during registration before tool exposure', () => {
  for (const memoryDir of ['', 'relative/memory', '  ', null, 42]) {
    let exposed = false;
    const ctx = { effect(fn) { return fn(); }, tools: { register() { exposed = true; return () => {}; } } };
    assert.throws(() => apply(ctx, { memoryDir }), /memoryDir must be a nonempty absolute path/);
    assert.equal(exposed, false);
  }
});
