import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import * as catalog from '../lib/recipe-catalog.mjs';
import { approveRecipe, verifyRecipeIntegrity } from '../lib/recipe-integrity.mjs';
import { loadRecipe, apply } from '../lib/recipes.mjs';

async function fixture(t, name = 'demo', meta = {}) {
  const dir = await mkdtemp(path.join(import.meta.dirname, 'catalog-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = path.join(dir, name); await mkdir(base);
  await writeFile(path.join(base, 'meta.json'), JSON.stringify({ name, description: 'Description', whenToUse: 'When useful', ...meta }));
  await writeFile(path.join(base, 'script.js'), 'return 1;'); await approveRecipe(base);
  return { dir, base, name };
}
test('synchronous and asynchronous loaders have identical approval failures', async t => {
  const f = await fixture(t);
  assert.deepEqual(catalog.loadVerifiedRecipeSync(f.name, f.dir), await loadRecipe(f.name, f.dir));
  for (const lock of [null, '{', '[]', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, name: 'wrong' }), JSON.stringify({ version: 1, name: 'demo', sha256: { meta: 'X'.repeat(64), script: 'a'.repeat(64) } })]) {
    if (lock === null) await unlink(path.join(f.base, 'recipe.lock.json')); else await writeFile(path.join(f.base, 'recipe.lock.json'), lock);
    let syncError, asyncError;
    try { catalog.loadVerifiedRecipeSync(f.name, f.dir); } catch (e) { syncError = e.message; }
    try { await loadRecipe(f.name, f.dir); } catch (e) { asyncError = e.message; }
    assert.equal(syncError, asyncError); assert.ok(syncError);
  }
  await approveRecipe(f.base);
  for (const [file, text] of [['script.js', 'return 2;'], ['meta.json', JSON.stringify({ name: 'demo', description: 'edited' })], ['meta.json', '{'], ['meta.json', JSON.stringify({ name: 'wrong' })]]) {
    await writeFile(path.join(f.base, file), text);
    let syncError, asyncError;
    try { catalog.loadVerifiedRecipeSync(f.name, f.dir); } catch (e) { syncError = e.message; }
    try { await loadRecipe(f.name, f.dir); } catch (e) { asyncError = e.message; }
    assert.equal(syncError, asyncError); assert.ok(syncError);
  }
  await unlink(path.join(f.base, 'script.js'));
  assert.throws(() => catalog.loadVerifiedRecipeSync(f.name, f.dir), /not found/);
  await assert.rejects(loadRecipe(f.name, f.dir), /not found/);
});
test('sync integrity twin matches direct async verifier for every lock shape and isolated digest change', async t => {
  const f = await fixture(t);
  const lockPath = path.join(f.base, 'recipe.lock.json');
  const originalLock = await readFile(lockPath, 'utf8');
  const originalMeta = await readFile(path.join(f.base, 'meta.json'), 'utf8');
  const originalScript = await readFile(path.join(f.base, 'script.js'), 'utf8');
  const approvedLock = JSON.parse(originalLock);
  const errorOf = async fn => { try { await fn(); } catch (error) { return error.message; } };
  const compare = async expected => {
    const syncError = await errorOf(() => catalog.loadVerifiedRecipeSync(f.name, f.dir));
    const asyncError = await errorOf(() => verifyRecipeIntegrity(f.base));
    assert.equal(syncError, asyncError);
    if (expected) assert.match(syncError, expected);
    else assert.equal(syncError, undefined);
  };
  await compare();
  for (const raw of [null, '{', 'null', 'true', '1', '"lock"', '[]', '{}',
    JSON.stringify({ ...approvedLock, version: 2 }), JSON.stringify({ ...approvedLock, name: 'wrong' }),
    JSON.stringify({ ...approvedLock, sha256: undefined }),
    ...['meta', 'script'].flatMap(key => ['X'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), null].map(value =>
      JSON.stringify({ ...approvedLock, sha256: { ...approvedLock.sha256, [key]: value } })))]) {
    if (raw === null) await unlink(lockPath); else await writeFile(lockPath, raw);
    await compare(/not approved/);
  }
  await writeFile(lockPath, originalLock);
  await writeFile(path.join(f.base, 'script.js'), originalScript + '\n');
  await compare(/changed since approval \(script\.js\)/);
  await writeFile(path.join(f.base, 'script.js'), originalScript);
  await writeFile(path.join(f.base, 'meta.json'), originalMeta + '\n');
  await compare(/changed since approval \(meta\.json\)/);
  await writeFile(path.join(f.base, 'script.js'), originalScript + '\n');
  await compare(/changed since approval \(script\.js, meta\.json\)/);
});
test('catalog omits unapproved, tampered and contract-invalid entries, sorts, refreshes and tolerates unreadable dirs', async t => {
  const f = await fixture(t, 'zeta');
  for (const name of ['alpha', 'unapproved', 'invalid', 'tampered']) {
    const base = path.join(f.dir, name); await mkdir(base);
    await writeFile(path.join(base, 'meta.json'), JSON.stringify({ name, description: name, ...(name === 'invalid' ? { roles: { scout: { tier: 'bad' } } } : {}) }));
    await writeFile(path.join(base, 'script.js'), 'return 1;');
    if (name !== 'unapproved') await approveRecipe(base);
    if (name === 'tampered') await writeFile(path.join(base, 'script.js'), 'return 2;');
  }
  assert.deepEqual(catalog.listApprovedRecipesSync(f.dir), [{ name: 'alpha', description: 'alpha' }, { name: 'zeta', description: 'Description', whenToUse: 'When useful' }]);
  await unlink(path.join(f.base, 'recipe.lock.json'));
  assert.deepEqual(catalog.listApprovedRecipesSync(f.dir).map(x => x.name), ['alpha']);
  assert.deepEqual(catalog.listApprovedRecipesSync(path.join(f.dir, 'absent')), []);
});
test('renderers sanitize braces/control whitespace and cap fields and displayed entries only', () => {
  const text = catalog.sanitizeCatalogText(' {{bad}}\u0000\n\t x ', 500);
  assert.equal(text, '((bad)) x');
  const entries = Array.from({ length: 23 }, (_, i) => ({ name: 'recipe-' + i, description: '{' + 'x'.repeat(300), whenToUse: 'y'.repeat(400) }));
  const description = catalog.sanitizeCatalogText(entries[0].description, 200);
  assert.equal(description.length, 200); assert.ok(description.endsWith('…'));
  assert.equal(catalog.sanitizeCatalogText('x'.repeat(200), 200).length, 200);
  for (const render of [catalog.renderCatalogForTool, catalog.renderCatalogForCoordinator]) {
    const out = render(entries);
    assert.ok(out.includes('recipe-19')); assert.ok(!out.includes('recipe-20')); assert.match(out, /3 more/);
    assert.ok(!/[{}\u0000-\u001f\u007f]/.test(out)); assert.equal(entries.length, 23);
    assert.match(render([]), /no approved recipes/i);
  }
  assert.match(catalog.renderCatalogForTool([]), /cannot run until a recipe is approved/i);
  assert.ok(!catalog.renderCatalogForTool([{ name: 'a'.repeat(101), description: 'd' }]).includes('a'.repeat(101)));
  assert.match(catalog.renderCatalogForCoordinator([]), /ordinary subagents/i);
  assert.match(catalog.renderCatalogForCoordinator([]), /__keep__/);
});
test('tool catalog is synchronous registration-time text and execution still rechecks bytes', async t => {
  const f = await fixture(t, 'custom'); let tool;
  apply({ tools: { register: value => { tool = value; } } }, { recipesDir: f.dir });
  assert.match(tool.description, /custom/); assert.match(tool.description, /When useful/); assert.ok(!tool.description.includes('feature-pipeline'));
  const original = tool.description; await writeFile(path.join(f.base, 'script.js'), 'return 2;');
  assert.equal(tool.description, original);
  await assert.rejects(tool.execute({ recipe: f.name, task: 't', repo: f.dir }, { agent: {}, signal: new AbortController().signal }), /changed since approval/);
});
test('registration excludes unapproved recipes and empty catalog guidance is explicit', async t => {
  const f = await fixture(t); await unlink(path.join(f.base, 'recipe.lock.json')); let tool;
  apply({ tools: { register: value => { tool = value; } } }, { recipesDir: f.dir });
  assert.match(tool.description, /no approved recipes/i); assert.match(tool.description, /cannot run until a recipe is approved/i); assert.ok(!tool.description.includes('demo —'));
  await assert.rejects(tool.execute({ recipe: f.name, task: 't', repo: f.dir }, { agent: {} }), /not approved/);
  await rm(f.base, { recursive: true });
  apply({ tools: { register: value => { tool = value; } } }, { recipesDir: f.dir });
  assert.match(tool.description, /cannot run until a recipe is approved/i);
});
for (const invalid of [{ whenToUse: '' }, { whenToUse: 1 }, { roles: { scout: { tier: 'invalid' } } }]) test('approved invalid contract stops before cache/provider/engine/claims ' + JSON.stringify(invalid), async t => {
  const f = await fixture(t, 'bad', invalid); let tool, touches = 0;
  const ctx = { tools: { register: value => { tool = value; } } };
  for (const key of ['workflowEngine', 'subagents', 'subagentModelSelection', 'llm']) Object.defineProperty(ctx, key, { get() { touches++; throw new Error('must not touch runtime'); } });
  apply(ctx, { recipesDir: f.dir, setupCacheDir: path.join(f.dir, 'cache'), runsDir: path.join(f.dir, 'runs') });
  const agent = {}; Object.defineProperty(agent, 'session', { get() { touches++; throw new Error('must not touch claims/session'); } });
  await assert.rejects(tool.execute({ recipe: f.name, task: 't', repo: f.dir }, { agent }), /whenToUse|tier/);
  assert.equal(touches, 0);
});
test('approval integrity takes precedence over metadata contract errors', async t => {
  const f = await fixture(t); await writeFile(path.join(f.base, 'meta.json'), JSON.stringify({ name: f.name, whenToUse: '', roles: { x: { tier: 'bad' } } }));
  await assert.rejects(loadRecipe(f.name, f.dir), /changed since approval/);
  assert.throws(() => catalog.loadVerifiedRecipeSync(f.name, f.dir), /changed since approval/);
  await approveRecipe(f.base);
  await assert.rejects(loadRecipe(f.name, f.dir), /whenToUse|tier/);
  assert.deepEqual(catalog.listApprovedRecipesSync(f.dir), []);
});
