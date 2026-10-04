import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { apply } from '../lib/recipes.mjs';
import { approveRecipe } from '../lib/recipe-integrity.mjs';
import { createPtcFixture } from './helpers/ptc-runtime.mjs';

// Journey: an approved recipe must never delegate against a different/missing workspace.
// Real PTC process and subagent registry; deterministic child output makes no model requests.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-workspace-'));
  let runtime;
  t.after(async () => { try { await runtime?.dispose(); } finally { await rm(root, { recursive: true, force: true }); } });
  const repo = path.join(root, 'repo'), other = path.join(root, 'other'), file = path.join(root, 'file');
  await mkdir(repo); await mkdir(other); await writeFile(file, 'not a directory');
  const alias = path.join(root, 'alias'); await symlink(repo, alias);
  const recipesDir = path.join(root, 'recipes'), base = path.join(recipesDir, 'fixture');
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'meta.json'), JSON.stringify({ name: 'fixture', description: 'Workspace regression' }));
  await writeFile(path.join(base, 'script.js'), `const value = await agent('__AUTO_RECIPE_ROLE__' + JSON.stringify({token:args.routingToken,role:'setup',label:'setup'}) + '\\nWorkspace probe', {label:'setup',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}); return {status:'completed',repo:args.repo,ok:value.ok};`);
  await approveRecipe(base, { approvedBy: 'offline-fixture-only' });
  const calls = { engine: 0, registration: 0, route: 0, child: 0 };
  let parent;
  const provider = { capabilities: { agentOptions: true }, inheritsParentContext: false, async start(request) {
    calls.child++; assert.equal(request.parent, parent);
    assert.equal(request.parent.session.header.cwd, parent.session.header.cwd);
    return { id: 'child', result: Promise.resolve({ stopReason: 'completed', structured: { ok: true }, output: [] }), async dispose() {} };
  } };
  const providers = new Map([['spawn', provider]]), listeners = new Map(); let tool;
  const ctx = { logger: { warn() {} }, tools: { register(value) { tool = value; } },
    on(n, fn) { const set = listeners.get(n) ?? new Set(); set.add(fn); listeners.set(n, set); return () => set.delete(fn); },
    emit(n, ...args) { for (const fn of listeners.get(n) ?? []) fn(...args); },
    events: { dispatch(_kind, [n, ...args]) { return [...(listeners.get(n) ?? [])].map(fn => () => fn(...args)); } },
    subagents: { getProvider: n => providers.get(n), registerProvider(p) { calls.registration++; providers.set(p.name, p); return () => providers.delete(p.name); }, start: (n, r) => providers.get(n).start(r) },
    subagentModelSelection: { current: () => ({ enabled: true, allowedModels: [{ provider: 'fixture', model: 'model' }], modelTiers: [{ provider: 'fixture', model: 'model', tier: 'light' }] }) },
    llm: { listProviders: () => [{ id: 'fixture' }], async resolveCallConfig(c) { calls.route++; return c; } },
  };
  runtime = await createPtcFixture({ cwd: repo, provider, events: ctx, maxTotalAgents: 10 });
  parent = runtime.createParent();
  ctx.subagents = { getProvider: name => runtime.subagents.getProvider(name),
    registerProvider(value) { calls.registration++; return runtime.subagents.registerProvider(value); } };
  ctx.workflowEngine = { start(request) { calls.engine++; return runtime.engine.start(request); } };
  apply(ctx, { recipesDir, runsDir: path.join(root, 'runs'), setupCacheDir: path.join(root, 'cache') });
  const execute = args => tool.execute({ recipe: 'fixture', task: 'Workspace probe', repo, ...args }, { agent: parent, signal: new AbortController().signal });
  return { root, repo, other, alias, file, base, parent, calls, execute, parentAt: cwd => runtime.createParent(cwd) };
}

for (const kind of ['mismatch', 'missing', 'empty', 'relative', 'nonexistent', 'file', 'numeric']) test('rejects ' + kind + ' session cwd before any workflow or model admission', async t => {
  const h = await fixture(t);
  h.parent.session = { ...h.parent.session, header: { ...h.parent.session.header, cwd: { mismatch: h.other, missing: undefined, empty: '', relative: 'repo', nonexistent: path.join(h.root, 'absent'), file: h.file, numeric: 42 }[kind] } };
  await assert.rejects(h.execute(), /workspace|session cwd/i);
  assert.deepEqual(h.calls, { engine: 0, registration: 0, route: 0, child: 0 });
  assert.ok(!(await readdir(h.root)).some(n => ['runs', 'cache'].includes(n)));
});
for (const kind of ['nonexistent', 'file']) test('rejects ' + kind + ' repository before admission', async t => {
  const h = await fixture(t); const repo = kind === 'file' ? h.file : path.join(h.root, 'absent');
  await assert.rejects(h.execute({ repo }), /workspace|repository/i);
  assert.deepEqual(h.calls, { engine: 0, registration: 0, route: 0, child: 0 });
});
test('mismatch wins before an invalid resume can be loaded or claimed', async t => {
  const h = await fixture(t); h.parent.session = { ...h.parent.session, header: { ...h.parent.session.header, cwd: h.other } };
  await assert.rejects(h.execute({ resumeId: 'invalid' }), /workspace|session cwd/i);
  assert.deepEqual(h.calls, { engine: 0, registration: 0, route: 0, child: 0 });
  assert.ok(!(await readdir(h.root)).includes('runs'));
});
test('approval integrity still wins before workspace checking', async t => {
  const h = await fixture(t); h.parent.session = { ...h.parent.session, header: { ...h.parent.session.header, cwd: undefined } };
  await writeFile(path.join(h.base, 'script.js'), 'return {};');
  await assert.rejects(h.execute(), /changed since approval/);
  assert.equal(h.calls.engine, 0);
});
test('invalid approved role contract still wins before workspace checking', async t => {
  const h = await fixture(t); h.parent.session = { ...h.parent.session, header: { ...h.parent.session.header, cwd: undefined } };
  await writeFile(path.join(h.base, 'meta.json'), JSON.stringify({ name: 'fixture', description: 'Invalid', roles: { setup: { tier: 'unknown' } } }));
  await approveRecipe(h.base, { approvedBy: 'offline-fixture-only' });
  await assert.rejects(h.execute(), /invalid recipe role tier/);
  assert.equal(h.calls.engine, 0);
});
for (const kind of ['same', 'repo-alias', 'cwd-alias']) test('real PTC process accepts ' + kind + ' actual directory identity and preserves supplied repo', { timeout: 60000 }, async t => {
  const h = await fixture(t); const repo = kind === 'repo-alias' ? h.alias : h.repo;
  if (kind === 'cwd-alias') h.parent.session = h.parentAt(h.alias).session;
  const result = await h.execute({ repo });
  assert.equal(result.result.status, 'completed'); assert.equal(result.result.ok, true);
  assert.equal(result.result.repo, repo, 'do not rewrite resume-bound repository argument');
  assert.deepEqual(h.calls, { engine: 1, registration: 1, route: 1, child: 1 });
});
