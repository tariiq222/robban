import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, readdir, rm, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const module = await import('../lib/setup-cache.mjs').catch(() => null);
const setup = { stack: 'JS', testCommands: [], lintCommands: [], conventions: [] };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'setup-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), dir = path.join(root, 'cache');
  await mkdir(repo); await writeFile(path.join(repo, 'package.json'), '{"name":"first"}');
  return { root, repo, dir };
}
test('cache APIs exist and content changes invalidate setup key', async t => {
  assert.ok(module, 'setup-cache module is implemented');
  const { repo } = await fixture(t);
  const key = await module.setupCacheKey(repo, 'feature-pipeline');
  assert.match(key, /^[a-f0-9]{64}$/);
  await writeFile(path.join(repo, 'package.json'), '{"name":"second"}');
  assert.notEqual(await module.setupCacheKey(repo, 'feature-pipeline'), key);
  assert.notEqual(await module.setupCacheKey(repo, 'another'), key);
  await writeFile(path.join(repo, 'requirements-dev.txt'), 'pytest');
  const third = await module.setupCacheKey(repo, 'feature-pipeline');
  await writeFile(path.join(repo, 'requirements-dev.txt'), 'pytest==2');
  assert.notEqual(await module.setupCacheKey(repo, 'feature-pipeline'), third);
});
test('cache realpaths repository and writes private atomic files with seven-day TTL', async t => {
  assert.ok(module);
  const { root, repo, dir } = await fixture(t);
  const alias = path.join(root, 'alias'); await symlink(repo, alias);
  const key = await module.setupCacheKey(repo, 'feature-pipeline');
  assert.equal(await module.setupCacheKey(alias, 'feature-pipeline'), key);
  assert.equal(await module.saveSetupCache(key, setup, { dir, now: 100 }), true);
  assert.deepEqual(await module.loadSetupCache(key, { dir, now: 101 }), setup);
  assert.equal((await stat(path.join(dir, key + '.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), [key + '.json']);
  assert.equal(await module.loadSetupCache(key, { dir, now: 100 + 7 * 86400000 }), null);
});
test('cache ignores an entry whose stored key differs from the requested key', async t => {
  const { repo, dir } = await fixture(t);
  const key = await module.setupCacheKey(repo, 'feature-pipeline');
  await module.saveSetupCache(key, setup, { dir, now: 100 });
  await writeFile(path.join(dir, key + '.json'), JSON.stringify({ key: 'f'.repeat(64), createdAt: 100, setup }));
  assert.equal(await module.loadSetupCache(key, { dir, now: 101 }), null);
  await module.saveSetupCache(key, setup, { dir, now: 100 });
  assert.deepEqual(await module.loadSetupCache(key, { dir, now: 101 }), setup, 'save stores the matching key');
});

test('cache directory is private on POSIX for new and existing directories', { skip: process.platform === 'win32' }, async t => {
  const { repo, dir, root } = await fixture(t);
  const key = await module.setupCacheKey(repo, 'feature-pipeline');
  assert.equal(await module.saveSetupCache(key, setup, { dir }), true);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const existing = path.join(root, 'existing-cache');
  await mkdir(existing, { mode: 0o755 });
  assert.equal(await module.saveSetupCache(key, setup, { dir: existing }), true);
  assert.equal((await stat(existing)).mode & 0o777, 0o700);
});

test('corrupt, invalid or unavailable cache is ignored without throwing', async t => {
  assert.ok(module);
  const { repo, dir } = await fixture(t);
  const key = await module.setupCacheKey(repo, 'feature-pipeline');
  await mkdir(dir); await writeFile(path.join(dir, key + '.json'), '{bad');
  assert.equal(await module.loadSetupCache(key, { dir }), null);
  await writeFile(path.join(dir, key + '.json'), JSON.stringify({ createdAt: Date.now(), setup: { stack: 'bad' } }));
  assert.equal(await module.loadSetupCache(key, { dir }), null);
  assert.equal(await module.setupCacheKey(path.join(repo, 'missing'), 'feature-pipeline'), null);
  assert.equal(await module.saveSetupCache(key, setup, { dir: path.join(repo, 'package.json') }), false);
  assert.equal(await module.loadSetupCache('../bad', { dir }), null);
});
