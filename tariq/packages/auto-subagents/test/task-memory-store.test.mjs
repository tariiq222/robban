import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, stat, readFile, writeFile, readdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskMemoryStore, TASK_MEMORY_DIR } from '../lib/task-memory-store.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), other = path.join(root, 'other'), dir = path.join(root, 'memory');
  await mkdir(repo); await mkdir(other);
  const store = new TaskMemoryStore({ dir, ...options });
  const create = () => store.create({ repo, title: 'Repair routing', goal: 'Preserve route admission', sessionId: 'session-1' });
  return { root, repo, other, dir, store, create, dataDir: store.namespace(repo) };
}
const entry = { kind: 'evidence', text: 'Focused test passed', refs: ['test/router.test.mjs:42'] };
const error = code => ({ code: `TASK_MEMORY_${code}` });

test('fresh store restores exact same-task facts across sessions with private durable files', async t => {
  const f = await fixture(t), record = await f.create();
  assert.equal(record.revision, 0); assert.equal(record.entries.length, 0);
  const saved = await f.store.append({ repo: f.repo, taskId: record.taskId, sessionId: 'session-2', expectedRevision: 0, entry });
  const restored = await new TaskMemoryStore({ dir: f.dir }).get({ repo: f.repo, taskId: record.taskId });
  assert.deepEqual(restored, saved); assert.deepEqual(restored.sessions, ['session-1', 'session-2']);
  assert.equal(restored.entries[0].text, entry.text); assert.equal(restored.entries[0].sessionId, 'session-2');
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(f.dataDir, record.taskId + '.json'))).mode & 0o777, 0o600);
  }
  assert.deepEqual((await readdir(f.dataDir)).sort(), [record.taskId + '.json']);
  assert.ok(path.isAbsolute(TASK_MEMORY_DIR));
});

test('repository aliases resolve to one identity, wrong repositories cannot read or append', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias'); await symlink(f.repo, alias, 'dir');
  const record = await f.create();
  assert.deepEqual(await f.store.get({ repo: alias, taskId: record.taskId }), record);
  await assert.rejects(f.store.get({ repo: f.other, taskId: record.taskId }), error('NOT_FOUND'));
  await assert.rejects(f.store.append({ repo: f.other, taskId: record.taskId, sessionId: 'x', expectedRevision: 0, entry }), error('NOT_FOUND'));
  assert.deepEqual(await f.store.list({ repo: f.other }), []);
});

test('distinct same-title tasks never merge and list returns bounded repository summaries', async t => {
  const f = await fixture(t), first = await f.create(), second = await f.create();
  assert.notEqual(first.taskId, second.taskId);
  await f.store.append({ repo: f.repo, taskId: first.taskId, sessionId: 'session-1', expectedRevision: 0, entry });
  assert.equal((await f.store.get({ repo: f.repo, taskId: second.taskId })).entries.length, 0);
  const list = await f.store.list({ repo: f.repo, limit: 1 }); assert.equal(list.length, 1);
  assert.ok(!Object.hasOwn(list[0], 'entries')); assert.ok(!Object.hasOwn(list[0], 'goal'));
  assert.equal((await f.store.list({ repo: f.repo })).length, 2);
});

test('two independent stores racing one revision save exactly one fact without lost writes', async t => {
  const f = await fixture(t), record = await f.create(), other = new TaskMemoryStore({ dir: f.dir });
  const results = await Promise.allSettled([f.store, other].map((store, index) => store.append({ repo: f.repo, taskId: record.taskId, sessionId: `s${index}`, expectedRevision: 0, entry: { kind: 'progress', text: `fact${index}` } })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failure = results.find(r => r.status === 'rejected').reason; assert.ok(['TASK_MEMORY_BUSY', 'TASK_MEMORY_CONFLICT'].includes(failure.code));
  const saved = await f.store.get({ repo: f.repo, taskId: record.taskId }); assert.equal(saved.revision, 1); assert.equal(saved.entries.length, 1);
  await assert.rejects(other.append({ repo: f.repo, taskId: record.taskId, sessionId: 'retry', expectedRevision: 0, entry }), error('CONFLICT'));
  assert.equal((await other.append({ repo: f.repo, taskId: record.taskId, sessionId: 'retry', expectedRevision: 1, entry })).revision, 2);
});

test('entry and session capacity fail without deleting existing facts or pretending to save', async t => {
  const f = await fixture(t, { maxEntries: 2, maxSessions: 1 }), record = await f.create();
  const append = (sessionId, expectedRevision) => f.store.append({ repo: f.repo, taskId: record.taskId, sessionId, expectedRevision, entry });
  await assert.rejects(append('new-session', 0), error('LIMIT'));
  await append('session-1', 0); const saved = await append('session-1', 1);
  await assert.rejects(append('session-1', 2), error('LIMIT'));
  assert.deepEqual(await f.store.get({ repo: f.repo, taskId: record.taskId }), saved);
});

test('stale or linked writer locks are never reclaimed or overwritten', async t => {
  const f = await fixture(t), record = await f.create(), lock = path.join(f.dataDir, record.taskId + '.lock'), target = path.join(f.root, 'foreign');
  await writeFile(target, 'foreign data'); await symlink(target, lock);
  await assert.rejects(f.store.append({ repo: f.repo, taskId: record.taskId, sessionId: 'x', expectedRevision: 0, entry }), error('BUSY'));
  assert.equal(await readFile(target, 'utf8'), 'foreign data');
  assert.equal((await f.store.get({ repo: f.repo, taskId: record.taskId })).revision, 0);
});

test('linked data files and linked storage parents reject without touching foreign data', async t => {
  const f = await fixture(t), record = await f.create(), file = path.join(f.dataDir, record.taskId + '.json'), target = path.join(f.root, 'foreign');
  await writeFile(target, 'foreign data'); await rm(file); await symlink(target, file);
  await assert.rejects(f.store.get({ repo: f.repo, taskId: record.taskId }), error('UNSAFE'));
  await assert.rejects(f.store.append({ repo: f.repo, taskId: record.taskId, sessionId: 'x', expectedRevision: 0, entry }), error('UNSAFE'));
  await assert.rejects(f.store.list({ repo: f.repo }), error('UNSAFE'));
  const alias = path.join(f.root, 'linked-memory'); await symlink(f.dir, alias, 'dir');
  await assert.rejects(new TaskMemoryStore({ dir: path.join(alias, 'child') }).create({ repo: f.repo, title: 't', goal: 'g', sessionId: 's' }), error('UNSAFE'));
  assert.equal(await readFile(target, 'utf8'), 'foreign data');
});

test('malformed or oversized durable records fail before facts reach consumers', async t => {
  const f = await fixture(t), record = await f.create(), file = path.join(f.dataDir, record.taskId + '.json');
  for (const value of [{ ...record, version: 2 }, { ...record, revision: 1 }, { ...record, unexpected: true }, { ...record, sessions: ['s', 's'] }]) {
    await writeFile(file, JSON.stringify(value), { mode: 0o600 }); await assert.rejects(f.store.get({ repo: f.repo, taskId: record.taskId }), e => e.code.startsWith('TASK_MEMORY_'));
  }
  await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1)); await assert.rejects(f.store.get({ repo: f.repo, taskId: record.taskId }), error('UNSAFE'));
});

test('input limits, traversal ids and omitted revision fail with no writes', async t => {
  const f = await fixture(t), record = await f.create();
  for (const data of [{ expectedRevision: undefined, entry }, { expectedRevision: -1, entry }, { expectedRevision: 0, entry: { kind: 'unknown', text: 'x' } }, { expectedRevision: 0, entry: { ...entry, text: 'x'.repeat(4001) } }, { expectedRevision: 0, entry: { ...entry, refs: ['x'.repeat(513)] } }, { expectedRevision: 0, entry: { ...entry, refs: Array(17).fill('x') } }]) {
    await assert.rejects(f.store.append({ repo: f.repo, taskId: record.taskId, sessionId: 's', ...data }), error('INVALID'));
  }
  await assert.rejects(f.store.get({ repo: f.repo, taskId: '../foreign' }), error('INVALID'));
  await assert.rejects(f.store.create({ repo: f.repo, title: 'x'.repeat(201), goal: 'g', sessionId: 's' }), error('INVALID'));
  assert.equal((await f.store.get({ repo: f.repo, taskId: record.taskId })).revision, 0);
});

test('malformed foreign repository records cannot affect current repository listing', async t => {
  const f = await fixture(t), own = await f.create();
  const foreign = await f.store.create({ repo: f.other, title: 'foreign', goal: 'other task', sessionId: 'other' });
  await writeFile(path.join(f.store.namespace(f.other), foreign.taskId + '.json'), '{bad');
  const listed = await f.store.list({ repo: f.repo }); assert.equal(listed.length, 1); assert.equal(listed[0].taskId, own.taskId);
});


test('shared-permission data directory is rejected before saving a task', async t => {
  if (process.platform === 'win32') return t.skip('POSIX mode permissions');
  const f = await fixture(t); await mkdir(f.dir, { mode: 0o755 }); await chmod(f.dir, 0o755);
  await assert.rejects(f.create(), error('UNSAFE'));
  assert.deepEqual(await readdir(f.dir), []);
});

test('listing scan overflow fails explicitly instead of returning an incomplete task list', async t => {
  const f = await fixture(t); await f.create();
  await Promise.all(Array.from({ length: 1000 }, (_, n) => writeFile(path.join(f.dataDir, `unrecognized-${n}`), '')));
  await assert.rejects(f.store.list({ repo: f.repo }), error('LIMIT'));
});

test('append snapshots the submitted note before awaiting repository resolution', async t => {
  const f = await fixture(t), record = await f.create(), mutable = { kind: 'progress', text: 'original', refs: ['original-reference'] };
  const pending = f.store.append({ repo: f.repo, taskId: record.taskId, sessionId: 'session-1', expectedRevision: 0, entry: mutable });
  mutable.text = 'mutated'; mutable.refs[0] = 'mutated-reference';
  const saved = await pending; assert.equal(saved.entries[0].text, 'original'); assert.deepEqual(saved.entries[0].refs, ['original-reference']);
});

test('readers see complete committed generations while another store publishes atomic updates', async t => {
  const f = await fixture(t), record = await f.create(), reader = new TaskMemoryStore({ dir: f.dir });
  await Promise.all([
    (async () => { for (let expectedRevision = 0; expectedRevision < 8; expectedRevision++) await f.store.append({ repo: f.repo, taskId: record.taskId, sessionId: 'session-1', expectedRevision, entry }); })(),
    (async () => { for (let n = 0; n < 24; n++) { const saved = await reader.get({ repo: f.repo, taskId: record.taskId }); assert.equal(saved.entries.length, saved.revision); assert.ok(saved.revision <= 8); } })(),
  ]);
  assert.equal((await reader.get({ repo: f.repo, taskId: record.taskId })).revision, 8);
});
