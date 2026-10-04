import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { apply, loadRecipe } from '../lib/recipes.mjs';
import { approveRecipe } from '../lib/recipe-integrity.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
const { validateMeta } = await import(runtimeModuleUrl('@deepseek-ai/dsh-workflow-ptc'));
import { createPtcFixture } from './helpers/ptc-runtime.mjs';

async function fixture({ realPtc = false, invalidDescription = false, childStart } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ars-engine-meta-'));
  const recipesDir = path.join(root, 'recipes');
  const base = path.join(recipesDir, 'fixture');
  await mkdir(base, { recursive: true });
  const meta = { name: 'fixture', version: '0.3.0', args: { fastPath: 'default true' },
    description: invalidDescription ? 12 : 'A metadata boundary regression fixture', whenToUse: 'Test only',
    phases: [{ title: 'setup', detail: 'read only' }], roles: { setup: { tier: 'medium', readOnlyRetry: true } } };
  await writeFile(path.join(base, 'meta.json'), JSON.stringify(meta));
  await writeFile(path.join(base, 'script.js'), `
phase('setup');
const value = await agent('__AUTO_RECIPE_ROLE__' + JSON.stringify({token:args.routingToken,role:'setup',label:'setup'}) + '\\nRead only fixture', {label:'setup',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}});
return {status:'completed',verified:value.ok};
`);
  await approveRecipe(base, { approvedBy: 'test-fixture' });
  let tool, receivedMeta, starts = 0;
  const appended = [], warnings = [], listeners = new Map();
  const provider = { capabilities: { agentOptions: true }, inheritsParentContext: false,
    async start(request) { starts++; if (childStart) return childStart(request); return { id: 'fixture-child', result: Promise.resolve({ stopReason: 'completed', output: [], structured: { ok: true } }), async dispose() {} }; } };
  const providers = new Map([['spawn', provider]]);
  const ctx = {
    logger: { warn: message => warnings.push(message) },
    tools: { register: value => { tool = value; } },
    on(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); },
    emit(name, ...args) { for (const cb of listeners.get(name) ?? []) cb(...args); },
    events: { dispatch(_kind, [name, ...args]) { return [...(listeners.get(name) ?? [])].map(cb => () => cb(...args)); } },
    subagents: {
      getProvider: name => providers.get(name),
      registerProvider(value) { providers.set(value.name, value); return () => providers.delete(value.name); },
      async start(providerName, request) { return providers.get(providerName).start(request); },
    },
    subagentModelSelection: { current: () => ({ enabled: true, allowedModels: [{ provider: 'fixture', model: 'model' }], modelTiers: [{ provider: 'fixture', model: 'model', tier: 'medium' }] }) },
    llm: { listProviders: () => [{ id: 'fixture' }], resolveCallConfig: async value => value },
  };
  const runtime = realPtc ? await createPtcFixture({ cwd: root, provider, events: ctx, maxTotalAgents: 10 }) : undefined;
  if (runtime) ctx.subagents = runtime.subagents;
  ctx.workflowEngine = { start(request) {
    receivedMeta = request.meta;
    if (realPtc) return runtime.engine.start(request);
    validateMeta(request.meta); // Real validator, not an imitation of its whitelist.
    return { id: 'validated-engine', result: Promise.resolve({ stopReason: 'completed', agentsStarted: 0, value: { status: 'completed' } }), cancel() {}, async dispose() {} };
  } };
  apply(ctx, { recipesDir, runsDir: path.join(root, 'runs'), setupCacheDir: path.join(root, 'cache') });
  const exec = { agent: runtime?.createParent() ?? { session: { id: 'fixture-owner', header: { cwd: root }, append: (type, data) => appended.push({ type, data }), snapshotEvents: () => [] } }, signal: new AbortController().signal };
  return { root, recipesDir, meta, get receivedMeta() { return receivedMeta; }, get starts() { return starts; }, tool, exec, warnings, runtime,
    cleanup: async () => { try { await runtime?.dispose(); } finally { await rm(root, { recursive: true, force: true }); } } };
}

test('run_recipe passes only supported metadata to the real engine validator while retaining approved recipe extensions', async () => {
  const h = await fixture();
  try {
    const result = await h.tool.execute({ recipe: 'fixture', repo: h.root, task: 'Read-only metadata fixture' }, h.exec);
    assert.equal(result.result.status, 'completed');
    assert.deepEqual(h.receivedMeta, { name: h.meta.name, description: h.meta.description, whenToUse: h.meta.whenToUse, phases: h.meta.phases });
    const loaded = await loadRecipe('fixture', h.recipesDir);
    assert.equal(loaded.meta.version, '0.3.0');
    assert.deepEqual(loaded.meta.args, h.meta.args);
    assert.deepEqual(loaded.contract.roles.setup, { tier: 'medium', readOnlyRetry: true });
    assert.equal(h.receivedMeta.roles, undefined);
  } finally { await h.cleanup(); }
});

test('the currently installed extended recipe metadata reaches the engine through the same projection', async () => {
  const { meta } = await loadRecipe('feature-pipeline');
  assert.ok(meta.version && meta.args, 'fixture must exercise the actual extended recipe metadata');
  const h = await fixture();
  try {
    // Preserve the approved production bytes: use the loaded metadata in an isolated approved fixture.
    await writeFile(path.join(h.recipesDir, 'fixture', 'meta.json'), JSON.stringify({ ...meta, name: 'fixture' }));
    await approveRecipe(path.join(h.recipesDir, 'fixture'));
    await h.tool.execute({ recipe: 'fixture', repo: h.root, task: 'Check installed metadata shape' }, h.exec);
    assert.doesNotThrow(() => validateMeta(h.receivedMeta));
    assert.equal(h.receivedMeta.version, undefined);
    assert.equal(h.receivedMeta.args, undefined);
  } finally { await h.cleanup(); }
});

test('metadata projection does not hide invalid values in supported engine fields', async () => {
  const h = await fixture({ invalidDescription: true });
  try {
    await assert.rejects(h.tool.execute({ recipe: 'fixture', repo: h.root, task: 'Invalid supported field' }, h.exec), /meta.description must be a non-empty string/);
    assert.equal(h.starts, 0);
  } finally { await h.cleanup(); }
});

test('run_recipe starts a real PTC process and completes one schema child with extended approved metadata', { timeout: 60000 }, async () => {
  const h = await fixture({ realPtc: true });
  try {
    const result = await h.tool.execute({ recipe: 'fixture', repo: h.root, task: 'Read-only PTC fixture' }, h.exec);
    assert.equal(result.result.status, 'completed');
    assert.equal(result.result.verified, true);
    assert.equal(result.agentsStarted, 1);
    assert.equal(h.starts, 1);
    assert.deepEqual(h.warnings, []);
  } finally { await h.cleanup(); }
});


test('PTC cancellation disposes the routed child and preserves a checkpoint that resumes once', { timeout: 60000 }, async () => {
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  let disposed = 0;
  const h = await fixture({ realPtc: true, childStart(request) {
    const result = Promise.withResolvers();
    const abort = () => result.resolve({ stopReason: 'aborted', output: [] });
    request.signal.addEventListener('abort', abort, { once: true });
    started.resolve();
    return { id: 'cancel-child', result: result.promise, async dispose() {
      disposed++;
      request.signal.removeEventListener('abort', abort);
      abort();
      stopped.resolve();
    } };
  } });
  try {
    const base = path.join(h.recipesDir, 'fixture');
    await writeFile(path.join(base, 'script.js'), `
if (args.resume) return {status:'completed',resumed:true,step:args.resume.progress.step};
log('@@auto-recipe ' + JSON.stringify({kind:'checkpoint',state:{task:args.task,repo:args.repo,round:1,setup:{},analysis:{},progress:{plan:{},step:1}}}));
await agent('__AUTO_RECIPE_ROLE__' + JSON.stringify({token:args.routingToken,role:'setup',label:'setup'}) + '\\nWait until cancellation');
return {status:'completed'};
`);
    await approveRecipe(base, { approvedBy: 'offline-cancellation-fixture' });
    const controller = new AbortController();
    const args = { recipe: 'fixture', repo: h.root, task: 'PTC cancellation fixture' };
    const execution = h.tool.execute(args, { ...h.exec, signal: controller.signal });
    let resumeId;
    const rejected = assert.rejects(execution, error => {
      assert.match(error.message, /cancelled/);
      resumeId = /resumeId "([0-9a-f-]{36})"/.exec(error.message)?.[1];
      assert.ok(resumeId, 'checkpoint survived PTC cancellation');
      return true;
    });
    await Promise.race([started.promise, execution]);
    controller.abort('fixture cancellation');
    await rejected;
    await stopped.promise;
    assert.equal(disposed, 1);
    assert.deepEqual(h.runtime.subagents.list(), ['spawn']);
    const resumed = await h.tool.execute({ ...args, resumeId }, h.exec);
    const runStarts = h.exec.agent.session.snapshotEvents().filter(event => event.type === 'auto-recipe/run-start');
    assert.equal(runStarts.length, 2);
    assert.deepEqual(resumed.result, { status: 'completed', resumed: true, step: 1, cardRunId: runStarts[1].data.runId });
    assert.notEqual(resumed.result.cardRunId, runStarts[0].data.runId, 'resume publishes a distinct run card');
    assert.equal(h.starts, 1, 'resume does not repeat the interrupted child');
    const saved = JSON.parse(await readFile(path.join(h.root, 'runs', resumeId + '.json'), 'utf8'));
    assert.equal(saved.consumed, true);
    assert.equal(saved.cardRunId, runStarts[0].data.runId, 'the consumed checkpoint belongs to the cancelled run');
    await assert.rejects(h.tool.execute({ ...args, resumeId }, h.exec), /already used/);
  } finally { await h.cleanup(); }
});
