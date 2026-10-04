import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { LOCK_FILE, recipeDigest, verifyRecipeIntegrity, approveRecipe } from '../lib/recipe-integrity.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../scripts/approve-recipe.mjs', import.meta.url));

async function fixture(t, name = 'demo') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ars-integrity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = path.join(dir, name);
  await mkdir(base);
  const metaText = JSON.stringify({ name, description: 'd' });
  await writeFile(path.join(base, 'meta.json'), metaText);
  await writeFile(path.join(base, 'script.js'), 'return 1;\n');
  return { dir, base, metaText, script: 'return 1;\n', meta: { name } };
}
async function cli(args) {
  try { const r = await run(process.execPath, [CLI, ...args]); return { code: 0, ...r }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

test('recipeDigest hashes both files with sha256 hex', () => {
  const d = recipeDigest({ metaText: 'a', script: 'b' });
  assert.equal(d.meta, 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  assert.match(d.script, /^[0-9a-f]{64}$/);
});

test('missing lock is not approved, with an actionable hint', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyRecipeIntegrity(f.base, f), /recipe "demo" is not approved; run node scripts\/approve-recipe\.mjs demo/);
});

test('approve then verify succeeds; lock is 0600 and well-formed', async t => {
  const f = await fixture(t);
  const lock = await approveRecipe(f.base, { approvedBy: 'tester' });
  assert.equal(lock.version, 1); assert.equal(lock.name, 'demo'); assert.equal(lock.approvedBy, 'tester');
  assert.deepEqual(lock.sha256, recipeDigest(f));
  assert.ok(!Number.isNaN(Date.parse(lock.approvedAt)));
  assert.equal((await stat(path.join(f.base, LOCK_FILE))).mode & 0o777, 0o600);
  assert.deepEqual(await verifyRecipeIntegrity(f.base, f), lock);
  // metaText absent → falls back to reading meta.json
  assert.deepEqual(await verifyRecipeIntegrity(f.base, { meta: f.meta, script: f.script }), lock);
});

test('edited script or meta is detected and named', async t => {
  const f = await fixture(t);
  await approveRecipe(f.base);
  await assert.rejects(verifyRecipeIntegrity(f.base, { ...f, script: 'return 2;' }), /changed since approval \(script\.js\); review and re-approve/);
  await assert.rejects(verifyRecipeIntegrity(f.base, { ...f, metaText: f.metaText + ' ' }), /changed since approval \(meta\.json\)/);
  await writeFile(path.join(f.base, 'meta.json'), f.metaText + '\n');
  await assert.rejects(verifyRecipeIntegrity(f.base, { meta: f.meta, script: f.script }), /meta\.json/);
});

test('malformed, wrong-version and wrong-name locks are rejected', async t => {
  const f = await fixture(t);
  const lockPath = path.join(f.base, LOCK_FILE);
  const good = await approveRecipe(f.base);
  for (const [text, re] of [
    ['{not json', /malformed JSON/],
    ['[]', /malformed/],
    [JSON.stringify({ ...good, version: 2 }), /unsupported .* version 2/],
    [JSON.stringify({ ...good, name: 'other' }), /names "other"/],
    [JSON.stringify({ ...good, sha256: { meta: 'x', script: good.sha256.script } }), /malformed digests/],
  ]) {
    await writeFile(lockPath, text);
    await assert.rejects(verifyRecipeIntegrity(f.base, f), re);
  }
});

test('approve refuses a meta.name that does not match the directory', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.base, 'meta.json'), JSON.stringify({ name: 'evil' }));
  await assert.rejects(approveRecipe(f.base), /meta\.name is "evil"/);
  await assert.rejects(verifyRecipeIntegrity(f.base, { meta: { name: 'evil' }, script: f.script }), /not approved/);
});

test('CLI: --check exit codes, approve, diff requires --yes', async t => {
  const f = await fixture(t);
  const dirArgs = ['--recipes-dir', f.dir];
  assert.equal((await cli(['demo', ...dirArgs, '--check'])).code, 1);
  const approved = await cli(['demo', ...dirArgs, '--by', 'cli-test']);
  assert.equal(approved.code, 0, approved.stderr);
  assert.equal(JSON.parse(await readFile(path.join(f.base, LOCK_FILE), 'utf8')).approvedBy, 'cli-test');
  assert.equal((await cli(['demo', ...dirArgs, '--check'])).code, 0);
  await writeFile(path.join(f.base, 'script.js'), 'return 3;\n');
  assert.equal((await cli(['demo', ...dirArgs, '--check'])).code, 1);
  const refused = await cli(['demo', ...dirArgs]);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /script\s+[0-9a-f]{12} -> [0-9a-f]{12}/);
  assert.match(refused.stderr, /--yes/);
  assert.equal((await cli(['demo', ...dirArgs, '--yes'])).code, 0);
  assert.equal((await cli(['demo', ...dirArgs, '--check'])).code, 0);
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli(['Bad/Name'])).code, 2);
});
