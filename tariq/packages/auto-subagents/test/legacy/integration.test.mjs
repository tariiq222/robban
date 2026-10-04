import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeModuleUrl } from '../../lib/dsh-paths.mjs';
const { apply, Config } = await import('../../lib/delegation.mjs');
const { apply: stockApply } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tool-subagent'));
import { automaticRouter } from '../../lib/router.mjs';
const a = { provider: 'one', model: 'a' }, b = { provider: 'two', model: 'b' };
const childOptions = route => ({ ...route, reasoningEffort: undefined });
function fixture(automatic = true, discover = true) {
  let preference = { enabled: true, allowedModels: [a, b] };
  let childCount = 0;
  const definitions = new Map(), starts = [], warnings = [];
  const session = { firstLiveSeq: 0, header: {}, eventAt() {}, append() {} };
  const provider = { name: 'spawn', capabilities: { agentOptions: true, depthLimit: true }, prepareContinuable() {} };
  const forkProvider = { ...provider, name: 'fork', inheritsParentContext: true };
  const llm = { listProviders: () => ['one', 'two'].map(id => ({ id })), async resolveCallConfig(config) { return config; } };
  const ctx = { llm, agents: { get: id => ({ id, status: 'running' }) }, effect: callback => callback(), sessionProjections: { register() {}, stateOf() {} }, subagentModelSelection: { current: () => preference },
    tools: { register(definition) { if (definitions.has(definition.name)) throw new Error('duplicate tool'); definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } },
    subagents: { resolveMaxDepth: () => 3, getProvider: name => name === 'fork' ? forkProvider : provider, async startContinuable(input) { starts.push(input); childCount += 1; return { childId: `child-${childCount}` }; } },
    systemPrompt: { section() {}, getSectionOrder() {} }, logger: { info() {}, warn: value => warnings.push(value) }, on() { return () => {}; }, get(name) { return this[name]; } };
  const config = { provider: 'spawn', toolName: 'subagent', registerModelDiscovery: discover, backgroundMode: 'continuable' };
  if (automatic) apply(ctx, config);
  else stockApply(ctx, { ...config, modelSelectionSettings: false }, session);
  const parent = { options: { provider: 'main', model: 'expensive', reasoningEffort: 'xhigh' }, session: { requestHeader() {}, append() {} } };
  const execute = args => definitions.get('subagent').execute({ description: 'task', prompt: 'verify', ...args }, { agent: parent, signal: new AbortController().signal });
  return { ctx, config, session, definitions, starts, execute, parent, warnings, router: automaticRouter(ctx.subagentModelSelection, llm), setPreference(p) { preference = p; } };
}
test('Auto consumer routes every delegation through saved settings; concurrent children spread by least load', async () => {
  const f = fixture();
  await f.execute({});
  // The first child is still active on route a, so the second delegation spreads to b.
  await f.execute({});
  assert.deepEqual(f.starts.map(input => input.request.agentOptions), [childOptions(a), childOptions(b)]);
  assert.deepEqual([f.router.activeCount(a), f.router.activeCount(b)], [1, 1]);
  // A settled child frees its route: the next delegation returns to the first model.
  f.router.childTurnIdle('child-1');
  await f.execute({});
  assert.deepEqual(f.starts[2].request.agentOptions, childOptions(a));
});
test('Auto consumer requests the requested tier and never leaks the tier arg into the child request', async () => {
  const f = fixture(); f.setPreference({ enabled: true, allowedModels: [a, b], modelTiers: [{ provider: 'one', model: 'a', tier: 'strong' }] });
  await f.execute({ tier: 'strong' });
  assert.deepEqual(f.starts[0].request.agentOptions, childOptions(a));
  assert.equal('tier' in f.starts[0].request.agentOptions, false);
  await f.execute({});
  assert.deepEqual(f.starts[1].request.agentOptions, childOptions(b));
});
test('Auto consumer appends tier evidence to the auto-subagent/selected event', async () => {
  const appends = [];
  const f = fixture(); f.parent.session.append = (type, data) => appends.push({ type, data });
  await f.execute({ tier: 'light' });
  const event = appends.find(item => item.type === 'auto-subagent/selected');
  assert.equal(event.data.requestedTier, 'light');
  assert.equal(event.data.tier, 'medium');
});
test('Auto consumer uses changed settings without recreating parent session', async () => {
  const f = fixture(); f.setPreference({ enabled: true, allowedModels: [b] }); await f.execute({});
  assert.deepEqual(f.starts[0].request.agentOptions, childOptions(b));
});
test('disabled settings never dispatch a child; explicit unauthorized route cannot bypass', async () => {
  const f = fixture(); f.setPreference({ enabled: false, allowedModels: [a] }); await assert.rejects(f.execute({}), /disabled/);
  f.setPreference({ enabled: true, allowedModels: [a] }); await assert.rejects(f.execute({ provider: 'main', model: 'expensive' }), /allowed/);
  assert.equal(f.starts.length, 0);
});
test('spawn owns live discovery while fork uses same automatic policy without duplicate registration', () => {
  const f = fixture();
  apply(f.ctx, { ...f.config, provider: 'fork', toolName: 'subagent_fork', registerModelDiscovery: false }, f.session);
  assert.ok(f.definitions.has('subagent_fork')); assert.ok(f.definitions.has('list_subagent_models'));
});
test('spawn and fork share one least-loaded router: concurrent delegations spread', async () => {
  const f = fixture(); apply(f.ctx, { ...f.config, provider: 'fork', toolName: 'subagent_fork', registerModelDiscovery: false }, f.session);
  await Promise.all([f.execute({}), f.definitions.get('subagent_fork').execute({ description: 'fork', prompt: 'verify' }, { agent: f.parent, signal: new AbortController().signal })]);
  assert.deepEqual(f.starts.map(input => input.request.agentOptions), [childOptions(a), childOptions(b)]);
});
test('discovery reflects current saved model list rather than the session-start list', async () => {
  const f = fixture(); f.setPreference({ enabled: true, allowedModels: [b] });
  const output = await f.definitions.get('list_subagent_models').execute({}, { signal: new AbortController().signal });
  assert.match(output, /two/); assert.doesNotMatch(output, /one/);
});
test('ordinary non-Auto omitted route keeps existing inherited behavior', async () => {
  const f = fixture(false); await f.execute({}); assert.equal(f.starts[0].request.agentOptions, undefined);
});
test('Auto-owned configuration exposes single discovery owner without a stock policy switch', () => {
  assert.equal(Config.dict.automaticModelSelection, undefined); assert.ok(Config.dict.registerModelDiscovery);
});
test('Auto tool schema offers the tier and verifies arguments and documents tier routing', () => {
  const f = fixture();
  const properties = f.definitions.get('subagent').parameters.properties;
  const tier = properties.tier;
  assert.ok(tier, 'Auto subagent tool must expose a tier argument');
  assert.match(tier.description, /strong/); assert.match(tier.description, /medium/); assert.match(tier.description, /light/);
  assert.match(tier.description, /least-loaded/i);
  const verifies = properties.verifies;
  assert.ok(verifies, 'Auto subagent tool must expose a verifies argument');
  assert.match(verifies.description, /verifies or reviews/i);
  assert.match(f.definitions.get('subagent').description, /tier/i);
  assert.match(f.definitions.get('subagent').description, /verifies/);
});
test('settings validation rejects bad tiers and duplicate pairs; extra routes are allowed and ignored', async () => {
  const settingsModule = await import('../../lib/model-selection.mjs');
  const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
  const attempt = config => {
    const root = new Context();
    try { new settingsModule.AutoModelSelection(root, Object.fromEntries(Object.entries(config).map(([key, value]) => [key, { get: () => value }]))); return undefined; }
    catch (error) { return error; }
  };
  assert.match(attempt({ enabled: false, allowedModels: [a], modelTiers: [{ provider: 'one', model: 'a', tier: 'huge' }] })?.message ?? '', /tier must be/);
  assert.match(attempt({ enabled: false, allowedModels: [a], modelTiers: [{ provider: 'one', model: 'a', tier: 'light' }, { provider: 'one', model: 'a', tier: 'strong' }] })?.message ?? '', /repeats route/);
  assert.equal(attempt({ enabled: false, allowedModels: [a], modelTiers: [{ provider: 'elsewhere', model: 'z', tier: 'light' }] }), undefined);
});
test('current() returns detached tier copies with an empty default', async () => {
  const settingsModule = await import('../../lib/model-selection.mjs');
  const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
  const root = new Context();
  root.plugin(settingsModule.AutoModelSelection, { enabled: false, allowedModels: [a], modelTiers: [{ provider: 'one', model: 'a', tier: 'strong' }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  const settings = root.get('subagentModelSelection');
  const first = settings.current(), second = settings.current();
  assert.deepEqual(first.modelTiers, [{ provider: 'one', model: 'a', tier: 'strong' }]);
  assert.notEqual(first.modelTiers[0], second.modelTiers[0]);
  assert.deepEqual(first.allowedModels, second.allowedModels);
});
// Route sharing and verification through the Auto consumer.
test('verifies excludes the executor route, records evidence, and never leaks verifies/tier into the child request', async () => {
  const f = fixture();
  const appends = [];
  f.parent.session.append = (type, data) => appends.push({ type, data });
  await f.execute({ tier: 'medium' });
  assert.deepEqual(f.starts[0].request.agentOptions, childOptions(a));
  await f.execute({ tier: 'medium', verifies: 'child-1' });
  // the executor ran on a: the verifier must not, and neither routing arg reaches the child.
  assert.deepEqual(f.starts[1].request.agentOptions, childOptions(b));
  assert.equal('tier' in f.starts[1].request.agentOptions, false);
  assert.equal('verifies' in f.starts[1].request.agentOptions, false);
  const selected = appends.filter(item => item.type === 'auto-subagent/selected');
  assert.deepEqual(selected[1].data.verifies, 'child-1');
  assert.deepEqual(selected[1].data.excludedRoute, a);
  assert.equal(selected[1].data.sameModelAsExecutor, undefined);
});

test('fork tool also strips verifies and tier from the child request', async () => {
  const f = fixture(); apply(f.ctx, { ...f.config, provider: 'fork', toolName: 'subagent_fork', registerModelDiscovery: false }, f.session);
  const fork = f.definitions.get('subagent_fork');
  await fork.execute({ description: 'exec', prompt: 'work' }, { agent: f.parent, signal: new AbortController().signal });
  await fork.execute({ description: 'verify', prompt: 'check', tier: 'medium', verifies: 'child-1' }, { agent: f.parent, signal: new AbortController().signal });
  assert.deepEqual(f.starts.map(input => input.request.agentOptions), [childOptions(a), childOptions(b)]);
  assert.equal('verifies' in f.starts[1].request.agentOptions, false);
  assert.equal('tier' in f.starts[1].request.agentOptions, false);
});

test('unknown verifies id is ignored and recorded as verifiesUnknown', async () => {
  const f = fixture();
  const appends = [];
  f.parent.session.append = (type, data) => appends.push({ type, data });
  await f.execute({ verifies: 'no-such-child' });
  const event = appends.find(item => item.type === 'auto-subagent/selected');
  assert.equal(event.data.verifies, 'no-such-child');
  assert.equal(event.data.verifiesUnknown, true);
  assert.equal(event.data.excludedRoute, undefined);
});

test('a publication failure after reservation releases the load count with no leak', async () => {
  const f = fixture();
  f.ctx.subagents.startContinuable = async () => { throw new Error('publication failed'); };
  await assert.rejects(f.execute({}), /publication failed/);
  assert.equal(f.router.activeCount(a), 0);
  // and a successful retry works normally afterwards
  f.ctx.subagents.startContinuable = async input => { f.starts.push(input); return { childId: 'child-9' }; };
  await f.execute({});
  assert.deepEqual(f.starts[0].request.agentOptions, childOptions(a));
  assert.equal(f.router.activeCount(a), 1);
});

test('foreground calls release their reservation and preserve the public run id', async () => {
  const f = fixture();
  f.ctx.subagents.start = async (_provider, request) => {
    f.starts.push({ request });
    return { id: 'child-run', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }), async dispose() {} };
  };
  const result = await f.execute({ run_in_background: false });
  assert.equal(result.kind, 'foreground');
  assert.equal(result.runId, 'child-run');
  assert.equal(f.router.activeCount(a), 0);
});
test('Auto rejects one-shot background mode instead of creating a job outside continuation ownership', () => {
  const f = fixture();
  assert.throws(() => apply(f.ctx, { ...f.config, backgroundMode: 'one-shot', registerModelDiscovery: false }), /continuable/);
});

test('sameModelAsExecutor warns through the logger when no alternative route is usable', async () => {
  const f = fixture();
  f.setPreference({ enabled: true, allowedModels: [a], modelTiers: [] });
  await f.execute({});
  await f.execute({ verifies: 'child-1' });
  const same = f.starts[1].request.agentOptions;
  assert.deepEqual(same, childOptions(a)); // only one allowed route: never fail the verification delegation
  assert.ok(f.warnings.some(value => /executor's own route/.test(value)));
});
