import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDelegation } from '../lib/delegation-runtime.mjs';
import { automaticRouter } from '../lib/router.mjs';

const a = { provider: 'p', model: 'a' }, b = { provider: 'p', model: 'b' };
function fixture(config = {}) {
  let preference = { enabled: true, allowedModels: [a, b], modelTiers: [] };
  const tools = new Map(), listeners = new Map(), events = [], starts = [], agents = new Map(), effects = [];
  const provider = { name: config.provider ?? 'spawn', capabilities: { agentOptions: true, depthLimit: true }, inheritsParentContext: config.provider === 'fork', prepareContinuable() {} };
  let currentProvider = provider;
  const settings = { current: () => preference };
  const llm = { listProviders: () => [{ id: 'p', name: 'Provider' }], async resolveCallConfig(value) { return value; }, async listModels() { return [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]; }, async resolveModelInfo(_provider, model) { return { id: model, name: model, reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }; } };
  const subagents = { getProvider: () => currentProvider, resolveMaxDepth: value => value === 'provider-managed' ? undefined : value ?? 3,
    async startContinuable(spec) { starts.push(spec); agents.set('child', { id: 'child', status: 'running' }); return { childId: 'child' }; },
    async start(name, request) { starts.push({ provider: name, request }); return { id: 'child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }), async dispose() { events.push({ type: 'disposed' }); } }; } };
  const ctx = { tools: { register(tool) { if (tools.has(tool.name)) throw new Error('duplicate tool'); tools.set(tool.name, tool); return () => tools.delete(tool.name); }, get: name => tools.get(name) }, subagents, llm, subagentModelSelection: settings,
    get(name) { return name === 'agents' ? { get: id => agents.get(id) } : this[name]; },
    on(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); },
    effect(callback) { const dispose = callback(); effects.push(dispose); return dispose; },
    systemPrompt: { getSectionOrder: () => 1, section() {} }, logger: { warn() {}, info() {} } };
  const parent = { id: 'parent', session: { append(type, data) { events.push({ type, data }); } } };
  installDelegation(ctx, { provider: provider.name, toolName: config.provider === 'fork' ? 'subagent_fork' : 'subagent', backgroundMode: 'continuable', registerModelDiscovery: provider.name === 'spawn', ...config }, tool => tool);
  const router = automaticRouter(settings, llm);
  return { ctx, tools, events, starts, router, parent, agents, llm, subagents, provider,
    setPreference(value) { preference = value; }, setProvider(value) { currentProvider = value; },
    emit(name, value) { for (const callback of listeners.get(name) ?? []) callback(value); },
    dispose() { effects.forEach(dispose => dispose?.()); },
    execute(args = {}, signal = new AbortController().signal) { return tools.get(config.provider === 'fork' ? 'subagent_fork' : 'subagent').execute({ description: 'Focused task', prompt: 'Perform task', tier: 'medium', ...args }, { agent: parent, signal }); },
  };
}
for (const provider of ['spawn', 'fork']) {
  test(`${provider} starts through the public continuable API with parent, depth and selected route`, async () => {
    const f = fixture({ provider });
    assert.deepEqual(await f.execute(), { kind: 'continuable', subagentId: 'child' });
    assert.equal(f.starts[0].provider, provider);
    assert.equal(f.starts[0].request.parent, f.parent);
    assert.equal(f.starts[0].request.maxDepth, 3);
    assert.equal(f.starts[0].request.agentOptions.model, 'a');
    assert.equal(f.router.activeCount(a), 1);
    assert.deepEqual(f.router.childRoute('child'), a);
    assert.equal(f.tools.has('list_subagent_models'), provider === 'spawn');
    assert.equal(f.events[0].type, 'auto-subagent/selected');
  });
}
test('each delegation rechecks live disabled, empty and unauthorized routes', async () => {
  const f = fixture();
  f.setPreference({ enabled: false, allowedModels: [a] }); await assert.rejects(f.execute(), /disabled/);
  f.setPreference({ enabled: true, allowedModels: [] }); await assert.rejects(f.execute(), /empty/);
  f.setPreference({ enabled: true, allowedModels: [a] }); await assert.rejects(f.execute({ ...b }), /not allowed/);
  assert.equal(f.starts.length, 0);
  assert.equal(f.router.activeCount(a), 0);
});
test('settings revocation and provider replacement during preflight block publication and release load', async () => {
  const f = fixture();
  f.llm.resolveCallConfig = async value => { f.setPreference({ enabled: false, allowedModels: [a] }); return value; };
  await assert.rejects(f.execute(), /disabled/);
  assert.equal(f.router.activeCount(a), 0);
  f.setPreference({ enabled: true, allowedModels: [a] });
  f.llm.resolveCallConfig = async value => { f.setProvider({ ...f.provider }); return value; };
  await assert.rejects(f.execute(), /changed/);
  assert.equal(f.router.activeCount(a), 0);
  assert.equal(f.starts.length, 0);
});
test('verification excludes the executor route and explicit authorized pairs override the tier', async () => {
  const f = fixture();
  f.router.adoptChild('executor', a);
  await f.execute({ verifies: 'executor' });
  assert.equal(f.starts[0].request.agentOptions.model, 'b');
  assert.deepEqual(f.events[0].data.excludedRoute, a);
  const explicit = fixture();
  await explicit.execute({ ...b, tier: 'strong', verifies: 'unknown' });
  assert.equal(explicit.starts[0].request.agentOptions.model, 'b');
});
test('foreground settlement returns runId and releases the run and route', async () => {
  const f = fixture();
  assert.deepEqual(await f.execute({ run_in_background: false }), { kind: 'foreground', runId: 'child', output: [{ type: 'text', text: 'done' }] });
  assert.equal(f.router.activeCount(a), 0);
  assert.ok(f.events.some(event => event.type === 'disposed'));
});
test('foreground cancellation preserves partial output and disposal failure', async () => {
  const f = fixture();
  f.subagents.start = async () => ({ id: 'child', result: Promise.resolve({ stopReason: 'aborted', diagnostic: 'cancelled remotely', output: [{ type: 'text', text: 'partial' }] }), async dispose() { throw new Error('cleanup failed'); } });
  await assert.rejects(f.execute({ run_in_background: false }), error => error instanceof AggregateError && /partial/.test(error.message) && /cleanup failed/.test(error.message));
  assert.equal(f.router.activeCount(a), 0);
});
test('startup rejection and cancellation release unpublished reservations', async () => {
  const f = fixture();
  f.subagents.startContinuable = async () => { throw new Error('startup rejected'); };
  await assert.rejects(f.execute(), /startup rejected/);
  assert.equal(f.router.activeCount(a), 0);
  const controller = new AbortController();
  f.llm.resolveCallConfig = async () => { controller.abort(new Error('cancelled')); };
  await assert.rejects(f.execute({}, controller.signal), /cancelled/);
  assert.equal(f.router.activeCount(a), 0);
});
test('fast idle children release on adoption and continuation accounting remains reacquirable', async () => {
  const f = fixture();
  f.subagents.startContinuable = async () => { f.agents.set('child', { id: 'child', status: 'idle' }); return { childId: 'child' }; };
  await f.execute();
  assert.equal(f.router.activeCount(a), 0);
  f.router.childTurnActive('child'); assert.equal(f.router.activeCount(a), 1);
  f.router.childTurnIdle('child'); assert.equal(f.router.activeCount(a), 0);
  f.router.childTurnActive('child'); f.router.childDisposed('child'); assert.equal(f.router.activeCount(a), 0);
});
test('discovery reads live authorization and rejects revocation during exact-model lookup', async () => {
  const f = fixture();
  const list = request => f.tools.get('list_subagent_models').execute(request, { signal: new AbortController().signal });
  assert.match(await list({ provider: 'p', model: 'a' }), /high \(default\)/);
  f.llm.resolveModelInfo = async () => { f.setPreference({ enabled: false, allowedModels: [a] }); return { id: 'a', name: 'A' }; };
  await assert.rejects(list({ provider: 'p', model: 'a' }), /disabled/);
});
test('provider removal disposes its tool and replacement restores a single registration', () => {
  const f = fixture();
  f.setProvider(undefined); f.emit('subagent/provider-removed', 'spawn'); assert.equal(f.tools.has('subagent'), false);
  f.setProvider(f.provider); f.emit('subagent/provider-added', f.provider); assert.equal(f.tools.has('subagent'), true);
  f.dispose(); assert.equal(f.tools.has('subagent'), false); assert.equal(f.tools.has('list_subagent_models'), false);
});

test('a route switch before publication is adopted for load and later verification', async () => {
  const f = fixture();
  f.subagents.startContinuable = async () => {
    f.agents.set('child', { id: 'child', status: 'running' });
    f.emit('auto-subagents/route-changed', { childId: 'child', route: b });
    return { childId: 'child' };
  };
  await f.execute();
  assert.deepEqual(f.router.childRoute('child'), b);
  assert.equal(f.router.activeCount(a), 0);
  assert.equal(f.router.activeCount(b), 1);
});
test('foreground settlement releases a replacement route after runtime fallback', async () => {
  const f = fixture();
  let finish;
  f.subagents.start = async () => ({ id: 'child', result: new Promise(resolve => { finish = resolve; }), async dispose() {} });
  const pending = f.execute({ run_in_background: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.router.childRoute('child'), a);
  f.router.switchChildRoute('child', b);
  finish({ stopReason: 'completed', output: [] });
  await pending;
  assert.equal(f.router.activeCount(a), 0);
  assert.equal(f.router.activeCount(b), 0);
});

test('missing Host settings and unsupported providers fail activation', () => {
  const f = fixture();
  f.ctx.subagentModelSelection = undefined;
  assert.throws(() => installDelegation(f.ctx, { provider: 'spawn', toolName: 'subagent', backgroundMode: 'continuable' }, value => value), /Host entry/);
  assert.throws(() => installDelegation(f.ctx, { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable', registerModelDiscovery: true }, value => value), /only to the spawn/);
});
test('delegation reads the Host depth cap again at creation', async () => {
  const f = fixture();
  f.subagents.resolveMaxDepth = () => 0;
  await f.execute();
  assert.equal(f.starts[0].request.maxDepth, 0);
});
