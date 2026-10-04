import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { apply } from '../lib/recipes.mjs';
import { approveRecipe } from '../lib/recipe-integrity.mjs';
import { startFailureMessage } from '../lib/workflow-routing.mjs';
// Live finding: a stage worker (origin "subagent") inherited run_recipe, and a feature-pipeline
// setup child launched nested recipes instead of delivering its report. Recipes are coordinator-only.
async function fixture(t, header) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recipesDir = path.join(root, 'recipes'), base = path.join(recipesDir, 'fixture');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'meta.json'), JSON.stringify({ name: 'fixture', description: 'guard' }));
  await writeFile(path.join(base, 'script.js'), 'return {status:"completed"};');
  await approveRecipe(base, { approvedBy: 'offline-fixture-only' });
  let tool, touches = 0;
  const ctx = { tools: { register(value) { tool = value; } } };
  for (const key of ['workflowEngine', 'subagents', 'subagentModelSelection', 'llm']) Object.defineProperty(ctx, key, { get() { touches++; throw new Error('must not touch runtime'); } });
  apply(ctx, { recipesDir, runsDir: path.join(root, 'runs'), setupCacheDir: path.join(root, 'cache') });
  const agent = { session: { id: 's', header, append() {}, snapshotEvents: () => [] } };
  return { root, tool, agent, touches: () => touches, run: () => tool.execute({ recipe: 'fixture', task: 't', repo: root }, { agent, signal: new AbortController().signal }) };
}

test('a subagent session cannot start a recipe and nothing is touched', async t => {
  const f = await fixture(t, { id: 's', origin: 'subagent', cwd: undefined });
  await assert.rejects(f.run(), /top-level Auto coordinator|subagent/i);
  assert.equal(f.touches(), 0);
});

test('depth-marked subagent headers are refused as well', async t => {
  const f = await fixture(t, { id: 's', origin: 'subagent', delegationDepth: 2 });
  await assert.rejects(f.run(), /top-level Auto coordinator|subagent/i);
});

test('the guard runs before workspace, cache or resume work', async t => {
  const f = await fixture(t, { id: 's', origin: 'subagent', cwd: '/definitely/not/here' });
  await assert.rejects(f.run(), /top-level Auto coordinator|subagent/i);
});

test('a top-level coordinator is NOT refused by the guard', async t => {
  const f = await fixture(t, { id: 's' });
  // No cwd on the header: the next gate (workspace) must be what rejects, proving the guard passed.
  await assert.rejects(f.run(), /workspace|session cwd/i);
});

test('startup failure text is sanitized, bounded and free of secrets', () => {
  const long = 'x'.repeat(2000);
  const text = startFailureMessage('scope', new Error(`tools.restrict() names unknown global tool "structured_output" token=abc123 Bearer sk-aaaaaaaaaaaaaaaaaaaaaaaa ${long}`));
  assert.ok(text.length <= 360, 'bounded');
  assert.match(text, /scope/);
  assert.match(text, /unknown global tool/);
  assert.doesNotMatch(text, /abc123|sk-aaaa/);
  assert.match(startFailureMessage('x', undefined), /unknown/i);
});

test('startup failure text also redacts JSON, colon, Basic and JWT-shaped secrets', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz012345';
  const text = startFailureMessage('scope', new Error(`failed {"token":"jsonsecret99"} password: colonsecret99 Authorization: Basic dXNlcjpwYXNzd29yZA== jwt ${jwt} key=hex ${'a1b2c3d4'.repeat(8)}`));
  assert.doesNotMatch(text, /jsonsecret99|colonsecret99|dXNlcjpwYXNzd29yZA|eyJhbGciOi|a1b2c3d4a1b2c3d4a1b2c3d4/);
  assert.match(text, /failed/);
});
