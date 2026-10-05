import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutoModelRouter } from '../lib/router.mjs';
import { registerWorkflowRouting, markWorkflowPrompt, WORKFLOW_ROLE_TIERS } from '../lib/workflow-routing.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
const { SubagentRuntime, snapshotSubagentDescriptor } = await import(runtimeModuleUrl('@deepseek-ai/dsh-subagent'));
const { Session, SESSION_FORMAT_VERSION } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { apply: applyInstalledSpawn } = await import(runtimeModuleUrl('@deepseek-ai/dsh-subagent-spawn-in-process'));

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  let settings = { enabled: true, allowedModels: [{ provider: 'p', model: 'A' }, { provider: 'p', model: 'B' }], modelTiers: ['A', 'B'].map(model => ({ provider: 'p', model, tier: 'strong' })) };
  const router = new AutoModelRouter({ current: () => settings }, { listProviders: () => [{ id: 'p' }], resolveCallConfig: async c => c });
  const parent = { id: 'parent', session: { header: { id: 'parent' } } }, starts = [], runs = [], notices = [], providers = new Map();
  let rejectStart = false;
  const base = { name: 'spawn', capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false, async start(req) {
    starts.push(req); if (rejectStart) throw new Error('publication failed');
    const d = deferred(), run = { id: `c${runs.length + 1}`, result: d.promise, done: d, disposals: 0, async dispose() { this.disposals++; d.resolve({ stopReason: 'aborted', output: [] }); } };
    runs.push(run); return run;
  } };
  providers.set('spawn', base);
  const subagents = { getProvider: name => providers.get(name), registerProvider(p) { providers.set(p.name, p); return () => providers.delete(p.name); } };
  const routing = registerWorkflowRouting({ subagents, router, parent, onChild: info => notices.push(info), ...options });
  const start = (role, extra = {}) => providers.get(routing.providerName).start({ parent, signal: new AbortController().signal, prompt: [{ type: 'text', text: routing.markPrompt(role, 'Work', role) }], ...extra });
  return { routing, start, parent, router, starts, runs, notices, providers, subagents, setSettings: v => { settings = v; }, rejectStart: () => { rejectStart = true; } };
}

test('custom roles and builtin overrides are isolated per registration and use live saved tier settings', async t => {
  const f = fixture({ recipeRoles: { scout: { tier: 'light' }, analysis: { tier: 'strong' } } });
  const g = fixture(); t.after(() => Promise.all([f.routing.dispose(), g.routing.dispose()]));
  models(f, [['L', 'light'], ['M', 'medium'], ['S', 'strong']]);
  const scout = await f.start('scout'); assert.equal(f.starts.at(-1).agentOptions.model, 'L'); await scout.dispose();
  const analysis = await f.start('analysis'); assert.equal(f.starts.at(-1).agentOptions.model, 'S'); await analysis.dispose();
  models(f, [['NEW', 'light']]); const next = await f.start('scout'); assert.equal(f.starts.at(-1).agentOptions.model, 'NEW'); await next.dispose();
  assert.throws(() => g.routing.markPrompt('scout', 'x'), /role/);
  assert.equal(WORKFLOW_ROLE_TIERS.analysis, 'medium');
  await assert.rejects(g.start('setup', { prompt: [{ type: 'text', text: f.routing.markPrompt('scout', 'x') }] }), /marker/);
});
for (const [readOnlyRetry, expected] of [[undefined, 1], [false, 1], [true, 2]]) test('custom role retry flag ' + readOnlyRetry, async t => {
  const f = fixture({ recipeRoles: { scout: { tier: 'strong', ...(readOnlyRetry === undefined ? {} : { readOnlyRetry }) } } }); t.after(() => f.routing.dispose());
  const run = await f.start('scout', { outputSchema: { type: 'object' } });
  f.runs[0].done.resolve({ stopReason: 'completed' }); await tick();
  assert.equal(f.runs.length, expected);
  if (expected === 2) f.runs[1].done.resolve({ stopReason: 'completed', structured: {} });
  await run.result;
});
test('builtin retry overrides and strict role descriptors are validated before registration/admission', async t => {
  const f = fixture({ recipeRoles: { setup: { tier: 'strong', readOnlyRetry: false } } }); t.after(() => f.routing.dispose());
  const run = await f.start('setup', { outputSchema: { type: 'object' } }); f.runs[0].done.resolve({ stopReason: 'completed' }); await tick();
  assert.equal(f.starts.length, 1); await run.result;
  const before = f.providers.size;
  for (const recipeRoles of [{ x: { tier: 'invalid' } }, { reviewer: { tier: 'strong', readOnlyRetry: true } }, { implementer: { tier: 'strong', readOnlyRetry: false } }]) {
    assert.throws(() => registerWorkflowRouting({ subagents: f.subagents, router: f.router, parent: f.parent, recipeRoles }));
    assert.equal(f.providers.size, before);
  }
  assert.throws(() => markWorkflowPrompt('t', 'scout', 'x', 'x', undefined, { scout: { tier: 'bad', readOnlyRetry: false } }), /role|tier/);
  await assert.rejects(f.start('setup', { prompt: [{ type: 'text', text: '__AUTO_RECIPE_ROLE__' + JSON.stringify({ token: f.routing.markerToken, role: 'rogue', label: 'x', tier: 'light', roleTable: { rogue: { tier: 'light' } } }) + '\nWork' }] }), /marker/);
  assert.equal(f.starts.length, 1);
});

test('registration snapshots descriptors and markers cannot override its tier', async t => {
  const roles = { scout: { tier: 'strong' } }, f = fixture({ recipeRoles: roles }); t.after(() => f.routing.dispose());
  roles.scout.tier = 'light'; roles.scout.readOnlyRetry = true;
  models(f, [['L', 'light'], ['S', 'strong']]);
  const run = await rawStart(f, { token: f.routing.markerToken, role: 'scout', label: 'scout', tier: 'light', roleTable: { scout: { tier: 'light' } } });
  assert.equal(f.starts[0].agentOptions.model, 'S'); await run.dispose();
  let selections = 0; f.router.select = async () => { selections++; throw new Error('unexpected select'); };
  for (const metadata of [{ token: 'foreign', role: 'scout', label: 'x' }, { token: f.routing.markerToken, role: '__proto__', label: 'x' }, { token: f.routing.markerToken, role: 'unknown', label: 'x' }]) await assert.rejects(rawStart(f, metadata), /marker/);
  assert.equal(selections, 0); assert.equal(f.starts.length, 1);
});
for (const retryImplementer of [false, true]) test('strict builtin tier overrides retain implementer retry and reviewer exclusions ' + retryImplementer, async t => {
  const f = fixture({ recipeRoles: { implementer: { tier: 'strong' }, reviewer: { tier: 'strong' } }, retryImplementer }); t.after(() => f.routing.dispose());
  models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  const impl = await f.start('implementer', { outputSchema: { type: 'object' } }); f.runs[0].done.resolve({ stopReason: 'completed' }); await tick();
  assert.equal(f.runs.length, retryImplementer ? 2 : 1);
  if (retryImplementer) { assert.match(f.starts[1].prompt[0].text, /partial edits/); f.runs[1].done.resolve({ stopReason: 'completed', structured: {} }); }
  await impl.result;
  const review = await f.start('reviewer'); assert.equal(f.notices.at(-1).verifies, impl.currentChildId);
  assert.equal(f.starts.at(-1).agentOptions.model, retryImplementer ? 'C' : 'B'); await review.dispose();
});

const schema = { type: 'object', properties: {} };
const missing = { stopReason: 'completed', output: [] };
const tick = () => new Promise(resolve => setImmediate(resolve));
function models(f, entries) {
  f.setSettings({ enabled: true, allowedModels: entries.map(([model]) => ({ provider: 'p', model })), modelTiers: entries.map(([model, tier]) => ({ provider: 'p', model, tier })) });
}

test('assigned acceptance and historical notes stay in authenticated read-only replacement prompts', async t => {
  const workContext = JSON.stringify({ id: 'repair', writePaths: ['src.js'], acceptance: ['Preserve exact inputs'], verifyCommands: ['node test.js'] });
  const f = fixture({ recipeName: 'bug-fix', workContext, taskContext: 'Earlier observation remains unverified.' });
  t.after(() => f.routing.dispose());
  const marker = '__AUTO_RECIPE_ROLE__' + JSON.stringify({ token: f.routing.markerToken, role: 'analysis', label: 'analysis', readOnly: true });
  const run = await f.start('analysis', { outputSchema: schema, prompt: [{ type: 'text', text: marker + '\nInspect the assigned work.' }] });
  f.runs[0].done.resolve(missing);
  await tick();
  assert.equal(f.starts.length, 2);
  for (const request of f.starts) {
    const text = request.prompt.map(block => block.text ?? '').join('\n');
    assert.equal(text.split(workContext).length, 2);
    assert.match(text, /Phase permissions and output requirements prevail/);
    assert.match(text, /Earlier observation remains unverified/);
    assert.match(text, /behavior-evidence/);
    assert.doesNotMatch(text, /__AUTO_RECIPE_ROLE__/);
    assert.deepEqual(request.toolFilter, { allow: ['read', 'read_image', 'glob', 'grep'] });
  }
  f.runs[1].done.resolve({ stopReason: 'completed', structured: { ok: true } });
  await run.result;
});

test('invalid assigned context is rejected before provider registration or route selection', async t => {
  const f = fixture();
  t.after(() => f.routing.dispose());
  const count = f.providers.size;
  for (const workContext of [null, {}, 'x'.repeat(32001)]) assert.throws(() => registerWorkflowRouting({ subagents: f.subagents, router: f.router, parent: f.parent, workContext }), /assigned work context/);
  assert.equal(f.providers.size, count);
  assert.equal(f.starts.length, 0);
});

test('schema output failure replaces a fresh same-tier child, updates implementer and emits telemetry', async () => {
  const changes = [], f = fixture({ onRouteChange: event => changes.push(event), retryImplementer: true }); models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  const run = await f.start('implementer', { outputSchema: schema, toolFilter: { allow: ['read'] } });
  f.runs[0].done.resolve(missing); await tick();
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs[0].disposals, 1);
  assert.equal(f.starts[1].agentOptions.model, 'B');
  assert.match(f.starts[1].prompt.map(p => p.text).join(''), /^A previous attempt[\s\S]*Work[\s\S]*MUST[\s\S]*structured_output/);
  assert.deepEqual(f.starts[1].outputSchema, schema);
  assert.deepEqual(f.starts[1].toolFilter, { allow: ['read'] });
  assert.equal(f.routing.childInfo('c2').model, 'B');
  assert.deepEqual(changes, [{ childId: 'c2', route: { provider: 'p', model: 'B' }, reason: 'NO_STRUCTURED_OUTPUT', replacedChildId: 'c1' }]);
  const value = { stopReason: 'completed', structured: { ok: true }, output: [] };
  f.runs[1].done.resolve(value); assert.deepEqual(await run.result, value);
  const reviewer = await f.start('reviewer');
  assert.equal(f.notices.at(-1).verifies, 'c2');
  assert.equal(f.starts.at(-1).agentOptions.model, 'C');
  await reviewer.dispose(); await run.dispose();
  assert.equal(f.runs[1].disposals, 1);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('without an alternative the original schema result is returned unchanged', async () => {
  const f = fixture(); models(f, [['A', 'strong']]);
  const run = await f.start('setup', { outputSchema: schema });
  f.runs[0].done.resolve(missing);
  assert.equal(await run.result, missing); assert.equal(f.starts.length, 1);
  assert.equal(f.runs[0].disposals, 1);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('replacement cannot downgrade and reviewer keeps strict implementer exclusion', async () => {
  const f = fixture(); models(f, [['A', 'strong'], ['B', 'strong'], ['L', 'light']]);
  const impl = await f.start('implementer', { outputSchema: schema }); f.runs[0].done.resolve(missing); await impl.result;
  const review = await f.start('reviewer', { outputSchema: schema });
  f.runs[1].done.resolve(missing);
  assert.equal(await review.result, missing);
  assert.deepEqual(f.starts.map(s => s.agentOptions.model), ['A', 'B']);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
  const g = fixture(); models(g, [['A', 'medium'], ['L', 'light'], ['S', 'strong']]);
  const step = await g.start('analysis', { outputSchema: schema }); g.runs[0].done.resolve(missing); await tick();
  assert.equal(g.starts[1].agentOptions.model, 'S');
  g.runs[1].done.resolve(missing); await step.result;
  assert.equal(g.router.activeCounts.size, 0); await g.routing.dispose();
});

for (const [name, options, extra, count] of [
  ['default budget', {}, { outputSchema: schema }, 2],
  ['disabled retries', { structuredRetries: 0 }, { outputSchema: schema }, 1],
  ['no schema', {}, {}, 1],
  ['custom budget', { structuredRetries: 2 }, { outputSchema: schema }, 3],
]) test(`structured retries are bounded: ${name}`, async () => {
  const f = fixture(options); models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong'], ['D', 'strong']]);
  const run = await f.start('setup', extra);
  for (let i = 0; i < count; i++) { f.runs[i].done.resolve(missing); await tick(); }
  assert.equal(await run.result, missing); assert.equal(f.runs.length, count);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

for (const action of ['dispose', 'routing dispose', 'abort', 'reject']) test(`replacement reservation released on ${action}`, async () => {
  const f = fixture(), c = new AbortController();
  const run = await f.start('setup', { outputSchema: schema, signal: c.signal });
  f.runs[0].done.resolve(missing); await tick(); assert.equal(f.runs.length, 2);
  if (action === 'dispose') await run.dispose();
  else if (action === 'routing dispose') await f.routing.dispose();
  else if (action === 'abort') { c.abort(); await tick(); }
  else f.runs[1].done.reject(new Error('replacement failed'));
  if (action === 'reject') await assert.rejects(run.result, /replacement failed/);
  else { await run.result.catch(() => {}); assert.equal(f.runs[1].disposals, 1); }
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('routing dispose cancels a replacement pending publication', async () => {
  const f = fixture(), d = deferred(), base = f.providers.get('spawn'), old = base.start;
  base.start = async req => { const run = await old(req); if (f.runs.length === 2) await d.promise; return run; };
  const run = await f.start('setup', { outputSchema: schema });
  f.runs[0].done.resolve(missing); await tick(); assert.equal(f.runs.length, 2);
  const closing = f.routing.dispose(); d.resolve(); await closing; await run.result.catch(() => {});
  assert.equal(f.runs[1].disposals, 1); assert.equal(f.router.activeCounts.size, 0);
});

test('dispose waits for replacement preflight and releases its held reservation', async () => {
  const f = fixture(), d = deferred();
  const run = await f.start('setup', { outputSchema: schema });
  f.router.llm.resolveCallConfig = async () => { await d.promise; };
  f.runs[0].done.resolve(missing); await tick();
  assert.equal(f.router.activeCount({ provider: 'p', model: 'B' }), 1);
  let disposed = false;
  const closing = run.dispose().then(() => { disposed = true; }); await tick();
  assert.equal(disposed, false, 'dispose must await held preflight reservation');
  d.resolve(); await closing; await run.result.catch(() => {});
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('reviewer replacement uses another strong route and retains verifies evidence', async () => {
  const f = fixture(); models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  const impl = await f.start('implementer'); f.runs[0].done.resolve({ stopReason: 'completed' }); await impl.result;
  const review = await f.start('reviewer', { outputSchema: schema });
  f.runs[1].done.resolve(missing); await tick();
  assert.deepEqual(f.starts.map(s => s.agentOptions.model), ['A', 'B', 'C']);
  assert.equal(f.notices.at(-1).verifies, impl.id);
  assert.deepEqual(f.notices.at(-1).excludedRoute, { provider: 'p', model: 'A' });
  f.runs[2].done.resolve({ stopReason: 'completed', structured: {} }); await review.result;
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('replacement publication failure releases all reservations', async () => {
  const f = fixture(); const run = await f.start('setup', { outputSchema: schema });
  f.rejectStart(); f.runs[0].done.resolve(missing);
  assert.equal(await run.result, missing);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

for (const value of [{ stopReason: 'failed' }, { stopReason: 'aborted' }, { stopReason: 'completed', structured: null }]) test(`no replacement for ${JSON.stringify(value)}`, async () => {
  const f = fixture(); const run = await f.start('setup', { outputSchema: schema });
  f.runs[0].done.resolve(value); assert.equal(await run.result, value);
  assert.equal(f.runs.length, 1); assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('structured failure memory is opt-in, tier-local, least-loaded within reliability and expires', async () => {
  let now = 0;
  const entries = [['A', 'medium'], ['B', 'medium'], ['C', 'strong']];
  const settings = { enabled: true, allowedModels: entries.map(([model]) => ({ provider: 'p', model })), modelTiers: entries.map(([model, tier]) => ({ provider: 'p', model, tier })) };
  const router = new AutoModelRouter({ current: () => settings }, { listProviders: () => [{ id: 'p' }], resolveCallConfig: async c => c }, { now: () => now, structuredFailureTtlMs: 100 });
  const a = { provider: 'p', model: 'A' }, b = { provider: 'p', model: 'B' };
  router.markStructuredFailure(a);
  const select = async opt => { const s = await router.select({}, { tier: 'medium', ...opt }, new AbortController().signal); s.token.release(); return s.route.model; };
  assert.equal(await select({}), 'A');
  const token = router.reserve(b);
  assert.equal(await select({ preferStructured: true }), 'B'); token.release();
  now = 99;
  assert.equal(await select({ preferStructured: true }), 'B');
  now = 100;
  assert.equal(await select({ preferStructured: true }), 'A', 'failure expires at TTL boundary');
  router.markStructuredFailure(a); router.markStructuredFailure(b);
  assert.equal(await select({ preferStructured: true }), 'A', 'unreliable routes remain available before stronger tier');
  router.markStructuredFailure(a); now = 201;
  assert.equal(await select({ preferStructured: true }), 'A');
  assert.equal(router.activeCounts.size, 0);
});

test('recipe selections opt into shared structured failure memory', async () => {
  const f = fixture(); f.router.markStructuredFailure({ provider: 'p', model: 'A' });
  const run = await f.start('setup'); assert.equal(f.starts[0].agentOptions.model, 'B');
  await run.dispose(); assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('routes on actual startup, strips marker and ignores stale model-owned settings', async () => {
  const f = fixture();
  const run = await f.start('implementer', { agentOptions: { provider: 'old', model: 'old', reasoningEffort: 'xhigh', maxTokens: 100 } });
  assert.equal(f.starts[0].prompt[0].text, 'Work');
  assert.deepEqual(f.starts[0].agentOptions, { provider: 'p', model: 'A', reasoningEffort: undefined, maxTokens: 100 });
  assert.equal(f.router.activeCount({ provider: 'p', model: 'A' }), 1);
  assert.deepEqual(f.router.childRoute(run.id), { provider: 'p', model: 'A' });
  assert.equal(f.notices[0].childId, run.id);
  f.runs[0].done.resolve({ stopReason: 'completed' }); await run.result;
  assert.equal(f.router.activeCounts.size, 0);
  f.setSettings({ enabled: false, allowedModels: [], modelTiers: [] });
  await assert.rejects(f.start('analysis'), /disabled/);
  assert.equal(f.starts.length, 1); await f.routing.dispose();
});

test('live new settings authorize each child and concurrent children spread', async () => {
  const f = fixture();
  const runs = await Promise.all([f.start('analysis'), f.start('plan')]);
  assert.deepEqual(f.starts.map(s => s.agentOptions.model), ['A', 'B']);
  for (const r of runs) await r.dispose();
  f.setSettings({ enabled: true, allowedModels: [{ provider: 'p', model: 'B' }], modelTiers: [{ provider: 'p', model: 'B', tier: 'strong' }] });
  const r = await f.start('setup'); assert.equal(f.starts.at(-1).agentOptions.model, 'B'); await r.dispose(); await f.routing.dispose();
});

test('reviewers exclude current executor route after fallback, release switched reservation', async () => {
  const f = fixture(); const impl = await f.start('implementer');
  f.router.switchChildRoute(impl.id, { provider: 'p', model: 'B' });
  f.runs[0].done.resolve({ stopReason: 'completed' }); await impl.result;
  const reviewer = await f.start('reviewer');
  assert.equal(f.starts[1].agentOptions.model, 'A');
  assert.equal(f.notices[1].verifies, impl.id);
  assert.deepEqual(f.notices[1].excludedRoute, { provider: 'p', model: 'B' });
  await reviewer.dispose(); assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('unrelated, forged and malformed calls fail closed before preflight or spawn', async () => {
  const f = fixture();
  await assert.rejects(f.start('setup', { parent: { id: f.parent.id } }), /parent/);
  await assert.rejects(f.start('setup', { prompt: [{ type: 'text', text: 'unrelated workflow' }] }), /marker/);
  await assert.rejects(f.start('setup', { prompt: [{ type: 'text', text: '__AUTO_RECIPE_ROLE__not-json\nWork' }] }), /marker/);
  await assert.rejects(f.start('setup', { prompt: [{ type: 'text', text: '__AUTO_RECIPE_ROLE__' + JSON.stringify({ token: 'wrong', role: 'setup' }) + '\nWork' }] }), /marker/);
  assert.throws(() => f.routing.markPrompt('unknown', 'Work'), /role/);
  await assert.rejects(f.start('reviewer'), /implementer/);
  assert.equal(f.starts.length, 0); assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('publication errors and rejected results release once; disposal unregisters provider', async () => {
  const f = fixture(); f.rejectStart(); await assert.rejects(f.start('setup'), /publication failed/);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
  const g = fixture(); const run = await g.start('setup'); g.runs[0].done.reject(new Error('child failed'));
  await assert.rejects(run.result, /child failed/); assert.equal(g.router.activeCounts.size, 0);
  await g.routing.dispose(); await g.routing.dispose(); assert.equal(g.providers.has(g.routing.providerName), false);
  await assert.rejects(run.dispose().then(() => g.start('setup')), /undefined|closed/);
});

test('startup abort releases reservation and disposes late published child', async () => {
  const f = fixture(); const d = deferred(); const base = f.providers.get('spawn'); const old = base.start;
  base.start = async req => { const r = await old(req); await d.promise; return r; };
  const c = new AbortController(); const pending = f.start('setup', { signal: c.signal }); await Promise.resolve(); await Promise.resolve();
  c.abort(); d.resolve(); await assert.rejects(pending, /abort/i);
  assert.equal(f.router.activeCounts.size, 0); if (f.runs.length) assert.equal(f.runs[0].disposals, 1);
  await f.routing.dispose();
});

test('publication reconciles an early fallback from local request header and childInfo stays live', async () => {
  const f = fixture(); const base = f.providers.get('spawn'), old = base.start;
  base.start = async req => { const r = await old(req); r.localAgent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'B' } }) } }; return r; };
  const run = await f.start('implementer');
  assert.equal(f.routing.childInfo(run.id).model, 'B');
  assert.equal(f.routing.childInfo('unknown'), undefined);
  assert.equal(f.router.activeCount({ provider: 'p', model: 'A' }), 0);
  assert.equal(f.router.activeCount({ provider: 'p', model: 'B' }), 1);
  await run.dispose(); await f.routing.dispose(); assert.equal(f.router.activeCounts.size, 0);
});

test('run disposal cancels active and pending work, releases even when child disposal fails', async () => {
  const f = fixture(); const run = await f.start('setup');
  f.runs[0].dispose = async () => { throw new Error('dispose failed'); };
  await assert.rejects(f.routing.dispose(), /disposal failed/);
  assert.equal(f.router.activeCounts.size, 0);
  const g = fixture(); const base = g.providers.get('spawn'), old = base.start, d = deferred();
  base.start = async req => { const r = await old(req); await d.promise; return r; };
  const starting = g.start('setup'); starting.catch(() => {});
  await Promise.resolve(); await Promise.resolve();
  const closing = g.routing.dispose(); d.resolve(); await closing;
  await assert.rejects(starting, /closed|abort/i); assert.equal(g.router.activeCounts.size, 0);
  await assert.rejects(run.dispose(), /dispose failed/);
});

test('invalid marker role/label, aborted selection and invalid provider cannot publish', async () => {
  const f = fixture();
  assert.throws(() => registerWorkflowRouting({ subagents: f.subagents, router: f.router, parent: f.parent, baseProvider: 'missing' }), /fresh-child/);
  assert.throws(() => f.routing.markPrompt('setup', 1), /marker input/);
  for (const metadata of [{ token: f.routing.markerToken, role: 'unknown', label: 'x' }, { token: f.routing.markerToken, role: 'setup' }]) {
    await assert.rejects(f.start('setup', { prompt: [{ type: 'text', text: '__AUTO_RECIPE_ROLE__' + JSON.stringify(metadata) + '\nWork' }] }), /marker/);
  }
  const c = new AbortController(); c.abort(); await assert.rejects(f.start('setup', { signal: c.signal }), /abort/i);
  assert.equal(f.starts.length, 0); await f.routing.dispose();
});

test('real SubagentRuntime.start seam publishes proxy once, preserving schema and restrictions', async () => {
  const f = fixture();
  // Real registry dispatch and capability checks; lifecycle emission is isolated, no agent/model starts.
  const registry = Object.create(SubagentRuntime.prototype);
  registry.providers = f.providers; registry.emitLifecycle = () => {};
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  const run = await registry.start(f.routing.providerName, { parent: f.parent, signal: new AbortController().signal,
    prompt: [{ type: 'text', text: f.routing.markPrompt('validate', 'Validate') }], outputSchema: schema, toolFilter: { allow: ['read'] } });
  assert.deepEqual(f.starts[0].outputSchema, schema); assert.deepEqual(f.starts[0].toolFilter, { allow: ['read'] });
  assert.equal(f.starts[0].descriptor.provider, f.routing.providerName);
  await run.dispose(); assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('implementer is not retried by default: original result, no replacement, no telemetry', async () => {
  const changes = [], f = fixture({ onRouteChange: e => changes.push(e) });
  const run = await f.start('implementer', { outputSchema: schema });
  f.runs[0].done.resolve(missing);
  assert.equal(await run.result, missing); assert.equal(f.runs.length, 1); assert.deepEqual(changes, []);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('retryImplementer warns about partial edits and reviewers avoid both implementer routes', async () => {
  const f = fixture({ retryImplementer: true }); models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  const impl = await f.start('implementer', { outputSchema: schema });
  f.runs[0].done.resolve(missing); await tick();
  const text = f.starts[1].prompt.map(p => p.text).join('');
  assert.ok(text.startsWith('A previous attempt on this step may have left partial edits in the working tree. First inspect `git status` and `git diff`, then continue from that state or reconcile it; do not blindly redo work.'));
  f.runs[1].done.resolve({ stopReason: 'completed', structured: {} }); await impl.result;
  const review = await f.start('reviewer');
  assert.equal(f.starts.at(-1).agentOptions.model, 'C');
  await review.dispose(); await impl.dispose(); assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('reviewers exclude every implementer attempt after failure memory expires', async t => {
  const f = fixture({ retryImplementer: true });
  t.after(() => f.routing.dispose());
  models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  let now = 0;
  f.router.now = () => now;
  const impl = await f.start('implementer', { outputSchema: schema });
  f.runs[0].done.resolve(missing); await tick();
  assert.deepEqual(f.starts.map(s => s.agentOptions.model), ['A', 'B']);
  f.runs[1].done.resolve({ stopReason: 'completed', structured: {} });
  await impl.result;
  // Reliability is only a preference with a TTL, not a substitute for exclusion.
  now = f.router.structuredFailureTtlMs;
  const review = await f.start('reviewer');
  assert.equal(f.starts.at(-1).agentOptions.model, 'C', 'neither failed A nor replacement B may review this round');
  assert.equal(f.notices.at(-1).verifies, impl.currentChildId);
  await review.dispose(); await impl.dispose();
  assert.equal(f.router.activeCounts.size, 0);
});

test('wrapper delegates methods to the current child, keeps original id, exposes currentChildId', async () => {
  const f = fixture(); const base = f.providers.get('spawn'), old = base.start;
  const calls = [];
  base.start = async req => { const r = await old(req); const n = r.id; r.interrupt = () => calls.push(['interrupt', n]); r.steer = m => calls.push(['steer', n, m]); return r; };
  const run = await f.start('setup', { outputSchema: schema });
  assert.equal(run.currentChildId, 'c1'); run.steer('x');
  f.runs[0].done.resolve(missing); await tick();
  assert.equal(run.id, 'c1'); assert.equal(run.currentChildId, 'c2');
  run.interrupt(); run.steer('y');
  assert.deepEqual(calls, [['steer', 'c1', 'x'], ['interrupt', 'c2'], ['steer', 'c2', 'y']]);
  assert.throws(() => { 'use strict'; run.currentChildId = 'z'; }, TypeError);
  await run.dispose(); await f.routing.dispose();
});

test('replacement startup failure keeps original result and warns; abort still propagates', async () => {
  const warnings = [], f = fixture({ warn: m => warnings.push(m) });
  const run = await f.start('setup', { outputSchema: schema });
  f.setSettings({ enabled: false, allowedModels: [], modelTiers: [] });
  f.runs[0].done.resolve(missing);
  assert.equal(await run.result, missing); assert.equal(warnings.length, 1); assert.match(warnings[0], /disabled/);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
  const g = fixture({ warn: () => {} }), c = new AbortController(), d = deferred();
  const r2 = await g.start('setup', { outputSchema: schema, signal: c.signal });
  g.router.llm.resolveCallConfig = async () => { await d.promise; };
  g.runs[0].done.resolve(missing); await tick(); c.abort(); d.resolve();
  await r2.result.then(v => assert.ok(v), e => assert.match(String(e?.message ?? e), /abort/i));
  assert.equal(g.runs.length, 1); assert.equal(g.router.activeCounts.size, 0); await g.routing.dispose();
});

test('chained replacements report the ORIGINAL child id on every event', async () => {
  const changes = [], f = fixture({ structuredRetries: 2, onRouteChange: e => changes.push(e) });
  models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  const run = await f.start('setup', { outputSchema: schema });
  f.runs[0].done.resolve(missing); await tick(); f.runs[1].done.resolve(missing); await tick();
  const ok = { stopReason: 'completed', structured: {} }; f.runs[2].done.resolve(ok);
  assert.equal(await run.result, ok);
  assert.deepEqual(changes.map(e => [e.childId, e.replacedChildId]), [['c2', 'c1'], ['c3', 'c1']]);
  assert.equal(run.currentChildId, 'c3'); await f.routing.dispose();
});

// Real installed spawn -> startInProcessRun -> real Session/foldConsumedWork. Only the
// child agent loop is faked; no provider result or structured capture is fabricated.
async function driverFixture(options = {}, scenario = 'owned') {
  const f = fixture(options);
  await f.routing.dispose();
  f.parent.session = Session.create('parent');
  f.parent.options = {};
  f.parent.ctx = { get: () => undefined, agents: { async create(spec) {
    const n = f.runs.length, gate = deferred(), hooks = new Map(), tools = new Map();
    const session = Session.create(spec.sessionId, undefined, { version: SESSION_FORMAT_VERSION, id: spec.sessionId, createdAt: Date.now(), ...spec.meta });
    const childCtx = {
      get: () => undefined,
      on(name, fn) { hooks.set(name, fn); },
      tools: { register(tool) { tools.set(tool.name, tool); }, restrict() {}, guard() {} },
      systemPrompt: { context() {}, section() {}, getContextOrder: () => 0, getSectionOrder: () => 0 },
    };
    let input, cancelled = false, disposals = 0;
    const child = { session, followup(message) {
      input = message;
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
    }, cancel() { cancelled = true; gate.resolve(); }, async whenIdle() {
      await gate.promise;
      session.append('turn/start', { turn: 1 });
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
      await hooks.get('agent/pre-step')({ agent: child }, async () => ({ kind: 'enter' }));
      session.append('step/start', { turn: 1, step: 1 });
      session.append('user/message', input, { surfaceOp: 'append' });
      if (n === 0 && scenario === 'foreign-input') session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ ...input, content: [{ type: 'text', text: 'foreign work' }] }] });
      if (n === 0 && scenario === 'captured' || n > 0 && scenario === 'recover-capture') {
        const exec = { name: 'structured_output', concludeTurn() {} };
        await tools.get('structured_output').execute({}, exec);
        hooks.get('tools/result')(exec, { isError: false });
      }
      const kind = cancelled ? 'aborted' : n === 0 && ['error', 'blocked', 'max-tokens', 'aborted'].includes(scenario) ? scenario : 'completed';
      session.append('turn/end', { turn: 1, reason: { kind } });
      if (n === 0 && scenario === 'multiple-turns') {
        session.append('turn/start', { turn: 2 }); session.append('step/start', { turn: 2, step: 1 });
        session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
      }
      if (n === 0 && scenario === 'dropped-input') session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' });
    } };
    spec.setup(childCtx, child);
    const handle = { agent: child, async dispose() { disposals++; child.cancel(); } };
    f.runs.push({ child, gate, get disposals() { return disposals; } });
    return handle;
  } } };
  applyInstalledSpawn({ subagents: f.subagents }, { providerName: 'spawn' });
  const installed = f.providers.get('spawn');
  // Record requests without wrapping/mutating the proven provider's start method.
  const create = f.parent.ctx.agents.create;
  f.parent.ctx.agents.create = spec => { f.starts.push(spec); return create(spec); };
  f.routing = registerWorkflowRouting({ subagents: f.subagents, router: f.router, parent: f.parent, ...options });
  f.start = (role, extra = {}) => f.providers.get(f.routing.providerName).start({ parent: f.parent,
    signal: new AbortController().signal, prompt: [{ type: 'text', text: f.routing.markPrompt(role, 'Work', role) }],
    descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: f.routing.providerName }), ...extra });
  f.installed = installed;
  return f;
}

async function settleDriver(f, index = 0) { f.runs[index].gate.resolve(); await tick(); }

test('installed driver fidelity: owned completed missing capture retries once and preserves schema/filter', async t => {
  const changes = [], f = await driverFixture({ onRouteChange: e => changes.push(e) });
  t.after(() => f.routing.dispose());
  models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  const run = await f.start('setup', { outputSchema: schema, toolFilter: { allow: ['read'] } });
  await settleDriver(f);
  assert.equal(f.runs.length, 2, 'actual driver maps missing capture to error; safe replacement must still start');
  assert.equal(f.runs[0].disposals, 1);
  assert.deepEqual(f.starts.map(s => s.agentOptions.model), ['A', 'B']);
  await settleDriver(f, 1);
  const result = await run.result;
  assert.equal(result.stopReason, 'error', 'both actual driver attempts have missing captures');
  assert.equal(f.runs.length, 2, 'default budget never starts a third child');
  assert.equal(changes[0].reason, 'NO_STRUCTURED_OUTPUT');
  assert.equal(f.router.activeCounts.size, 0);
});

for (const scenario of ['error', 'blocked', 'max-tokens', 'aborted', 'multiple-turns', 'foreign-input', 'dropped-input', 'captured']) {
  test('installed driver fidelity: no missing-capture retry for ' + scenario, async t => {
    const f = await driverFixture({}, scenario); t.after(() => f.routing.dispose());
    const run = await f.start('setup', { outputSchema: schema });
    await settleDriver(f);
    const result = await run.result;
    assert.equal(f.runs.length, 1);
    if (scenario === 'captured') assert.deepEqual(result.structured, {});
    assert.equal(f.router.activeCounts.size, 0);
  });
}

for (const scenario of ['foreign-session', 'restored-session', 'seeded-session', 'missing-descriptor', 'foreign-descriptor', 'no-local-agent', 'unproven-provider', 'missing-input']) {
  test('installed driver fidelity: fail closed without ownership proof ' + scenario, async t => {
    const f = await driverFixture(); t.after(() => f.routing.dispose());
    if (scenario === 'unproven-provider') {
      const original = f.installed.start;
      f.installed.start = function(req) { return original.call(this, req); };
    }
    const run = await f.start('setup', { outputSchema: schema });
    const s = f.runs[0].child.session;
    if (scenario === 'foreign-session') f.runs[0].child.session = Session.create('foreign');
    if (scenario === 'restored-session') s.firstLiveSeq = 1;
    if (scenario === 'seeded-session') s.header = { ...s.header, isSeeded: true };
    // Mutate the observed snapshot only (the real driver's own internal result remains error).
    if (['missing-descriptor', 'foreign-descriptor', 'missing-input'].includes(scenario)) {
      const snapshot = s.snapshotEvents.bind(s);
      s.snapshotEvents = (...args) => snapshot(...args).filter(e => scenario !== 'missing-descriptor' || e.type !== 'subagent/descriptor')
        .map(e => scenario === 'foreign-descriptor' && e.type === 'subagent/descriptor' ? { ...e, data: { ...e.data, provider: 'foreign' } } : e)
        .filter(e => scenario !== 'missing-input' || e.type !== 'agent/inbox/spliced' && e.type !== 'user/message');
    }
    if (scenario === 'no-local-agent') {
      const snapshot = s.snapshotEvents.bind(s);
      // Driver reads its authoritative result first; remove local proof before
      // plugin classification, without changing the actual provider method.
      s.snapshotEvents = (...args) => { const events = snapshot(...args); f.runs[0].child.session = undefined; return events; };
    }
    await settleDriver(f);
    await run.result;
    assert.equal(f.runs.length, 1);
  });
}

test('installed driver fidelity: replacement capture succeeds and opt-in implementer reviewers stay independent', async t => {
  const f = await driverFixture({ retryImplementer: true }, 'recover-capture'); t.after(() => f.routing.dispose());
  models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  const restrictions = { allow: ['read'] };
  const impl = await f.start('implementer', { outputSchema: schema, toolFilter: restrictions });
  await settleDriver(f); assert.equal(f.runs.length, 2);
  const events = f.runs[1].child.session.snapshotEvents();
  assert.match(events.find(e => e.type === 'agent/inbox/spliced').data.inserted[0].content[0].text, /partial edits/);
  await settleDriver(f, 1); assert.deepEqual((await impl.result).structured, {});
  assert.equal(f.router.activeCounts.size, 0);
  const review = await f.start('reviewer', { outputSchema: schema });
  assert.equal(f.starts.at(-1).agentOptions.model, 'C');
  assert.equal(f.routing.childInfo(review.id).verifies, impl.currentChildId);
  await settleDriver(f, 2); assert.deepEqual((await review.result).structured, {});
});

test('installed driver fidelity: cancellation at settlement never starts a replacement', async t => {
  const f = await driverFixture(); t.after(() => f.routing.dispose());
  const ac = new AbortController(); const run = await f.start('setup', { outputSchema: schema, signal: ac.signal });
  const s = f.runs[0].child.session, snapshot = s.snapshotEvents.bind(s);
  s.snapshotEvents = (...args) => { const events = snapshot(...args); ac.abort(); return events; };
  await settleDriver(f); await run.result.catch(() => {}); assert.equal(f.runs.length, 1);
  assert.equal(f.router.activeCounts.size, 0);
});

for (const role of ['implementer', 'setup']) test('installed driver fidelity: no retry for ' + (role === 'setup' ? 'no schema' : 'default implementer'), async t => {
  const f = await driverFixture(); t.after(() => f.routing.dispose());
  const run = await f.start(role, role === 'setup' ? {} : { outputSchema: schema });
  await settleDriver(f); await run.result; assert.equal(f.runs.length, 1);
});

// ── per-attempt step timeouts (0.3.0 seam) ───────────────────────────────────
function timerTracker() {
  const live = new Map();
  let next = 0;
  return {
    live,
    get size() { return live.size; },
    schedule(fn) { const id = ++next; live.set(id, fn); return { id }; },
    cancel(handle) { live.delete(handle?.id); },
    fireFirst() {
      const entry = live.entries().next().value;
      if (!entry) throw new Error('no timer pending');
      live.delete(entry[0]);
      entry[1]();
    },
  };
}
const startTimed = (f, role, timeoutMs, extra = {}) => f.providers.get(f.routing.providerName).start({ parent: f.parent, signal: new AbortController().signal,
  prompt: [{ type: 'text', text: f.routing.markPrompt(role, 'Work', role, timeoutMs) }], ...extra });
const rawStart = (f, metadata, extra = {}) => f.providers.get(f.routing.providerName).start({ parent: f.parent, signal: new AbortController().signal,
  prompt: [{ type: 'text', text: '__AUTO_RECIPE_ROLE__' + JSON.stringify(metadata) + '\nWork' }], ...extra });

test('read-only timeout retries on another route and returns the replacement value', async () => {
  const t = timerTracker(), changes = [];
  const f = fixture({ onRouteChange: e => changes.push(e), scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
  models(f, [['A', 'strong'], ['B', 'strong']]);
  const run = await startTimed(f, 'setup', 20, { outputSchema: schema });
  assert.equal(t.size, 1, 'attempt timer armed');
  t.fireFirst(); await tick();
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs[0].disposals, 1);
  assert.equal(f.starts[1].agentOptions.model, 'B');
  assert.equal(f.starts[1].prompt[0].text, 'Work');
  assert.match(f.starts[1].prompt.at(-1).text, /structured_output/);
  assert.deepEqual(changes, [{ childId: 'c2', route: { provider: 'p', model: 'B' }, reason: 'TIMEOUT', replacedChildId: 'c1', timeoutMs: 20 }]);
  const value = { stopReason: 'completed', structured: { ok: true }, output: [] };
  f.runs[1].done.resolve(value);
  assert.deepEqual(await run.result, value);
  assert.equal(t.size, 0, 'replacement timer cleared on settle');
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('implementer timeout without retryImplementer returns a synthetic error and disposes the child', async () => {
  const t = timerTracker(), changes = [], warnings = [];
  const f = fixture({ onRouteChange: e => changes.push(e), warn: m => warnings.push(m), scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
  models(f, [['A', 'strong'], ['B', 'strong']]);
  const run = await startTimed(f, 'implementer', 20, { outputSchema: schema });
  assert.equal(t.size, 1);
  t.fireFirst();
  const value = await run.result;
  assert.equal(f.runs.length, 1, 'no second start by default');
  assert.equal(f.runs[0].disposals, 1, 'timed-out child disposed');
  assert.deepEqual(changes, []);
  assert.deepEqual(warnings, []);
  assert.equal(value.stopReason, 'error');
  assert.deepEqual(value.output, [{ type: 'text', text: 'step timed out after 20 ms on p/A' }]);
  assert.equal(t.size, 0);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('implementer timeout with retryImplementer warns and reviewers avoid both routes', async () => {
  const t = timerTracker();
  const f = fixture({ retryImplementer: true, scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
  models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  const run = await startTimed(f, 'implementer', 20, { outputSchema: schema });
  assert.equal(t.size, 1);
  t.fireFirst(); await tick();
  assert.equal(f.runs.length, 2);
  const text = f.starts[1].prompt.map(p => p.text).join('');
  assert.ok(text.startsWith('A previous attempt on this step may have left partial edits in the working tree.'));
  f.runs[1].done.resolve({ stopReason: 'completed', structured: {} });
  await run.result;
  const review = await f.start('reviewer');
  assert.equal(f.starts.at(-1).agentOptions.model, 'C');
  await review.dispose(); await run.dispose();
  assert.equal(t.size, 0);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('timeout with no alternative route returns the synthetic error result', async () => {
  const t = timerTracker(), warnings = [];
  const f = fixture({ warn: m => warnings.push(m), scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
  models(f, [['A', 'strong']]);
  const run = await startTimed(f, 'setup', 20, { outputSchema: schema });
  assert.equal(t.size, 1);
  t.fireFirst();
  const value = await run.result;
  assert.equal(f.runs.length, 1);
  assert.equal(value.stopReason, 'error');
  assert.deepEqual(value.output, [{ type: 'text', text: 'step timed out after 20 ms on p/A' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not start/);
  assert.equal(t.size, 0);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('timeout and structured failure share one budget', async () => {
  const t1 = timerTracker();
  const a = fixture({ structuredRetries: 1, scheduleTimeout: t1.schedule, cancelTimeout: t1.cancel });
  models(a, [['A', 'strong'], ['B', 'strong']]);
  const first = await startTimed(a, 'setup', 20, { outputSchema: schema });
  t1.fireFirst(); await tick();
  assert.equal(a.runs.length, 2);
  a.runs[1].done.resolve(missing);
  assert.equal(await first.result, missing, 'budget exhausted: original c2 result, no third child');
  assert.equal(a.runs.length, 2);
  assert.equal(t1.size, 0);
  assert.equal(a.router.activeCounts.size, 0); await a.routing.dispose();
  const t2 = timerTracker();
  const b = fixture({ structuredRetries: 1, scheduleTimeout: t2.schedule, cancelTimeout: t2.cancel });
  models(b, [['A', 'strong'], ['B', 'strong']]);
  const second = await startTimed(b, 'setup', 20, { outputSchema: schema });
  b.runs[0].done.resolve(missing); await tick();
  assert.equal(b.runs.length, 2);
  t2.fireFirst();
  const value = await second.result;
  assert.equal(value.stopReason, 'error');
  assert.deepEqual(value.output, [{ type: 'text', text: 'step timed out after 20 ms on p/B' }]);
  assert.equal(b.runs.length, 2, 'no third child after structured retry then timeout');
  assert.equal(t2.size, 0);
  assert.equal(b.router.activeCounts.size, 0); await b.routing.dispose();
});

test('reservations and timers clear after timeout, success, dispose and run abort', async () => {
  {
    const t = timerTracker();
    const f = fixture({ scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
    const run = await startTimed(f, 'setup', 20);
    assert.equal(t.size, 1, 'timer armed');
    f.runs[0].done.resolve({ stopReason: 'completed' });
    await run.result;
    assert.equal(t.size, 0, 'success clears the timer');
    assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
  }
  {
    const t = timerTracker();
    const f = fixture({ scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
    const run = await startTimed(f, 'setup', 20);
    assert.equal(t.size, 1, 'timer armed');
    await run.dispose();
    await run.result.catch(() => {});
    assert.equal(t.size, 0, 'dispose clears the timer');
    assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
  }
  {
    const t = timerTracker();
    const f = fixture({ scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
    const c = new AbortController();
    const run = await f.providers.get(f.routing.providerName).start({ parent: f.parent, signal: c.signal,
      prompt: [{ type: 'text', text: f.routing.markPrompt('setup', 'Work', 'setup', 20) }] });
    assert.equal(t.size, 1, 'timer armed');
    c.abort();
    await run.result.catch(() => {});
    assert.equal(t.size, 0, 'run abort clears the timer');
    assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
  }
});

test('invalid timeoutMs values are ignored and forged markers still rejected', async () => {
  const t = timerTracker();
  const f = fixture({ scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
  for (const bad of [0, -20, 1.5, 4 * 60 * 60 * 1000 + 1, '20', null, Number.NaN, 2 ** 53]) {
    const run = await rawStart(f, { token: f.routing.markerToken, role: 'setup', label: 'setup', timeoutMs: bad });
    assert.equal(t.size, 0, `no timer for ${JSON.stringify(bad)}`);
    f.runs.at(-1).done.resolve({ stopReason: 'completed' });
    await run.result;
    await run.dispose();
  }
  assert.throws(() => f.routing.markPrompt('setup', 'Work', 'setup', 0), /timeout/);
  const edge = await startTimed(f, 'setup', 4 * 60 * 60 * 1000);
  assert.equal(t.size, 1, 'four hours exactly is accepted');
  await edge.dispose();
  assert.equal(t.size, 0);
  for (const metadata of [
    { token: 'wrong', role: 'setup', label: 'x', timeoutMs: 20 },
    { token: f.routing.markerToken, role: 'setup', timeoutMs: 20 },
    { token: f.routing.markerToken, role: 'unknown', label: 'x', timeoutMs: 20 },
  ]) {
    await assert.rejects(rawStart(f, metadata), /marker/);
  }
  assert.equal(f.starts.length, 9, 'eight ignored timeouts plus one boundary start');
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('timeout telemetry reports TIMEOUT with the original child id across chained retries', async () => {
  const t = timerTracker(), changes = [];
  const f = fixture({ structuredRetries: 2, onRouteChange: e => changes.push(e), scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
  models(f, [['A', 'strong'], ['B', 'strong'], ['C', 'strong']]);
  const run = await startTimed(f, 'setup', 20, { outputSchema: schema });
  t.fireFirst(); await tick();
  t.fireFirst(); await tick();
  assert.equal(f.runs.length, 3);
  assert.deepEqual(changes.map(e => [e.childId, e.replacedChildId, e.reason, e.timeoutMs]),
    [['c2', 'c1', 'TIMEOUT', 20], ['c3', 'c1', 'TIMEOUT', 20]]);
  const value = { stopReason: 'completed', structured: {}, output: [] };
  f.runs[2].done.resolve(value);
  assert.deepEqual(await run.result, value);
  assert.equal(t.size, 0);
  assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});

test('timeout during original route selection fails the step without spawning', async () => {
  const t = timerTracker();
  const f = fixture({ scheduleTimeout: t.schedule, cancelTimeout: t.cancel });
  f.router.llm.resolveCallConfig = (config, signal) => new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(wait); reject(signal.reason); };
    if (signal.aborted) return reject(signal.reason);
    const wait = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(config); }, 50);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const pending = startTimed(f, 'setup', 20);
  await tick();
  assert.equal(t.size, 1, 'timer covers route selection');
  t.fireFirst();
  await assert.rejects(pending, /step timed out after 20 ms/);
  await tick(); await tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.router.activeCounts.size, 0);
  assert.equal(t.size, 0);
  await f.routing.dispose();
});

test('dispose landing between child failure and replacement launch starts no replacement', async () => {
  const f = fixture(), d = deferred();
  const run = await f.start('setup', { outputSchema: schema });
  const orig = f.router.select.bind(f.router);
  f.router.select = async (...a) => { await d.promise; return orig(...a); };
  f.runs[0].done.resolve(missing); await tick();
  const closing = run.dispose(); d.resolve(); await closing; await run.result.catch(() => {});
  assert.equal(f.runs.length, 1); assert.equal(f.router.activeCounts.size, 0); await f.routing.dispose();
});
