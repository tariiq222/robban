import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compactResult, loadRecipe, listRecipes, loadResume, saveResume, ROLE_TIERS, RECIPES_DIR, RUNS_DIR } from '../lib/recipes.mjs';
import * as recipes from '../lib/recipes.mjs';
import { WORKFLOW_ROLE_TIERS } from '../lib/workflow-routing.mjs';
import { approveRecipe } from '../lib/recipe-integrity.mjs';
import { RECIPES_DIR as PATHS_RECIPES_DIR } from '../lib/dsh-paths.mjs';

async function recipeDir(script = 'return 1;') {
  const dir = await mkdtemp(path.join(tmpdir(), 'recipes-'));
  await mkdir(path.join(dir, 'demo'));
  await writeFile(path.join(dir, 'demo', 'meta.json'), JSON.stringify({ name: 'demo', description: 'd' }));
  await writeFile(path.join(dir, 'demo', 'script.js'), script);
  return dir;
}

test('compactResult swaps resume for a resumeId and round-trips through storage', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'recipe-runs-'));
  try {
    const resume = { task: 't', repo: '/r', round: 1, setup: { a: 1 }, analysis: { b: 2 } };
    const out = await compactResult({ status: 'needs_decision', questions: [], resume }, (value) => saveResume(value, dir));
    assert.equal(out.resume, undefined);
    assert.match(out.resumeId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await loadResume(out.resumeId, dir), resume);
    assert.deepEqual(await compactResult({ status: 'completed' }), { status: 'completed' });
    await assert.rejects(loadResume('../../etc/passwd', dir), /invalid resumeId/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recipe loading validates names and requires a matching approval lock', async () => {
  await assert.rejects(loadRecipe('../x'), /invalid recipe name/);
  const dir = await recipeDir();
  try {
    assert.deepEqual(await listRecipes(dir), [{ name: 'demo', description: 'd' }]);
    await assert.rejects(loadRecipe('demo', dir), /not approved/, 'unapproved recipe is refused');
    await approveRecipe(path.join(dir, 'demo'), { approvedBy: 'test' });
    const loaded = await loadRecipe('demo', dir);
    assert.equal(loaded.script, 'return 1;');
    await writeFile(path.join(dir, 'demo', 'script.js'), 'return 2;');
    await assert.rejects(loadRecipe('demo', dir), /changed since approval/, 'edited script is refused');
    await writeFile(path.join(dir, 'demo', 'meta.json'), '{not json');
    await assert.rejects(loadRecipe('demo', dir), /not valid JSON/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the installed feature-pipeline recipe is approved and loads', async () => {
  const installed = await loadRecipe('feature-pipeline', RECIPES_DIR);
  assert.equal(installed.meta.name, 'feature-pipeline');
  assert.match(installed.script, /__AUTO_RECIPE_ROLE__/);
});

test('paths come from dsh-paths; one role→tier table; no up-front route resolution in production', () => {
  assert.equal(RECIPES_DIR, PATHS_RECIPES_DIR);
  assert.equal(RUNS_DIR, path.join(PATHS_RECIPES_DIR, '.runs'));
  assert.equal(ROLE_TIERS, WORKFLOW_ROLE_TIERS, 'single source of truth');
  assert.ok(Object.keys(ROLE_TIERS).includes('implementer'));
  for (const removed of ['resolveRoutes', 'pickRoute', 'REVIEWER_COUNT']) assert.equal(recipes[removed], undefined, `${removed} removed`);
});
