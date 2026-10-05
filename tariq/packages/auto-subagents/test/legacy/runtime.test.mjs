import assert from 'node:assert/strict';
import { test } from 'node:test';
const moduleUrl = new URL('../../lib/runtime.mjs', import.meta.url);
const { apply } = await import(moduleUrl).catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href) return {}; throw error; });
const { automaticRouter } = await import(new URL('../../lib/router.mjs', import.meta.url)).catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') throw error; return {}; });
const a = { provider: 'one', model: 'a' }, b = { provider: 'two', model: 'b' }, c = { provider: 'three', model: 'c' };
function fixture() {
  let pref = { enabled: true, allowedModels: [a, b, c] };
  const listeners = new Map(), logs = [], warnings = [], preparations = new WeakMap();
  const ctx = { subagentModelSelection: { current: () => pref }, llm: { listProviders: () => ['one', 'two', 'three'].map(id => ({ id })), async resolveCallConfig(config) { return config; }, bindAutoPreparation(config, recover) { preparations.set(config, recover); } },
    on(name, callback, options) { listeners.set(name, { callback, options }); }, logger: { warn: value => warnings.push(value), info() {} } };
  apply(ctx);
  const agent = { id: 'same-child', options: { ...a }, ctx: { get: () => ({ composedPreset: () => 'auto-subagents' }) }, session: { header: { origin: 'subagent', agentPreset: 'auto-subagents' }, requestHeader: () => ({ config: { ...a } }), append(type, data) { logs.push({ type, data }); } } };
  const created = target => listeners.get('agent/created').callback({ agent: target, source: 'startup' });
  const signal = new AbortController().signal;
  const request = (target = agent, step = 1) => listeners.get('agent/request').callback({ agent: target, turn: 1, step, signal }, async () => ({ ...a, reasoningEffort: 'xhigh', maxTokens: 64000 }));
  const error = (code = 'RATE_LIMIT', target = agent, step = 1, next = async () => { throw new Error('generic retry must not run'); }) => listeners.get('agent/request-error').callback({ agent: target, turn: 1, step, provider: 'one', failure: { code, message: 'provider error' }, signal }, next);
  return { ctx, agent, created, request, error, listeners, logs, warnings, preparations, setPref(value) { pref = value; } };
}
test('only newly created Auto subagents are managed; existing/main/other preset requests are untouched', async () => {
  const f = fixture();
  assert.equal((await f.request()).reasoningEffort, 'xhigh');
  for (const [origin, preset] of [[undefined, 'auto-subagents'], ['subagent', 'standard']]) {
    const other = { ...f.agent, ctx: { get: () => ({ composedPreset: () => preset }) }, session: { ...f.agent.session, header: { origin, agentPreset: preset } } };
    f.created(other); assert.equal((await f.request(other)).reasoningEffort, 'xhigh');
  }
});
test('provider fallback retries the same agent/step with history intact, not a new child/task', async () => {
  const f = fixture(); f.created(f.agent); await f.request();
  assert.deepEqual(await f.error(), { kind: 'retry' });
  const config = await f.request();
  assert.equal(config.model, 'b'); assert.equal(config.provider, 'two');
  assert.equal(config.reasoningEffort, undefined); assert.equal(config.maxTokens, 64000);
  assert.equal(f.agent.id, 'same-child');
  assert.ok(f.logs.some(event => event.type === 'auto-subagent/route' && event.data.reason === 'RATE_LIMIT'));
  assert.ok(f.logs.some(event => event.type === 'user/message'));
});
test('real pi-ai model-not-found stream failure switches the same Auto child until routes genuinely exhaust', async () => {
  const f = fixture(); f.created(f.agent); await f.request();
  const failure = { code: 'PI_AI_ERROR', message: '404: {"message":"Model \\"deepseek/deepseek-v4.1-flash:free\\" does not exist.","type":"not_found_error","code":"not_found"}' };
  const fail = () => f.listeners.get('agent/request-error').callback({ agent: f.agent, turn: 1, step: 1, failure, signal: new AbortController().signal }, async () => { throw new Error('must not enter generic retries'); });
  assert.deepEqual(await fail(), { kind: 'retry' });
  assert.equal((await f.request()).model, 'b');
  assert.deepEqual(await fail(), { kind: 'retry' });
  assert.equal((await f.request()).model, 'c');
  assert.equal(await fail(), undefined);
  assert.equal(f.logs.filter(event => event.type === 'auto-subagent/route').length, 2);
  assert.equal(f.logs.filter(event => event.type === 'auto-subagent/exhausted').length, 1);
  assert.equal(f.agent.id, 'same-child');
});
test('each alternative is tried at most once per failing step; exhaustion bypasses built-in retries', async () => {
  const f = fixture(); f.created(f.agent); await f.request();
  await f.error(); await f.request(); await f.error(); await f.request();
  assert.equal(await f.error(), undefined);
  assert.ok(f.warnings.some(value => /exhausted/i.test(value)));
});
test('fallback reads live settings, ignores removed models, and fail-closes disabled selection', async () => {
  const f = fixture(); f.created(f.agent); await f.request(); f.setPref({ enabled: true, allowedModels: [c] });
  await f.error(); assert.equal((await f.request()).model, 'c');
  f.setPref({ enabled: false, allowedModels: [a, b] });
  await assert.rejects(f.error(), /disabled/);
});
test('healthy active child is not silently reassigned when settings change', async () => {
  const f = fixture(); f.created(f.agent); await f.request(); f.setPref({ enabled: true, allowedModels: [c] });
  assert.equal((await f.request(f.agent, 2)).model, 'a');
});
test('task, refusal and cancellation failures never switch models; nonmanaged errors delegate', async () => {
  const f = fixture(); f.created(f.agent); await f.request();
  for (const code of ['TOOL_ERROR', 'REFUSAL', 'ABORTED', 'INVALID_REQUEST']) assert.equal(await f.error(code), undefined);
  const other = { ...f.agent }; assert.equal(await f.error('RATE_LIMIT', other, 1, async () => 'downstream'), 'downstream');
});
test('cold-resumed children are not mistaken for new delegations', async () => {
  const f = fixture(); f.listeners.get('agent/created').callback({ agent: f.agent, source: 'resume' });
  assert.equal((await f.request()).reasoningEffort, 'xhigh');
});
test('future prompt assembly follows the fallback route rather than initial options', async () => {
  const f = fixture(); f.created(f.agent); await f.request(); await f.error();
  const assembled = await f.listeners.get('system-prompt/assemble').callback({}, { agent: f.agent }, async () => ({ variables: { ...a, cwd: '/workspace' } }));
  assert.deepEqual(assembled.variables, { ...b, cwd: '/workspace' });
});
test('prepare failures use bounded recovery without committing model-facing notices before admission', async () => {
  const f = fixture(); f.created(f.agent); const config = await f.request();
  const next = await f.preparations.get(config)({ code: 'AUTH' }, config);
  assert.equal(next.model, 'b'); assert.equal(next.provider, 'two');
  assert.equal((await f.request()).model, 'b');
  assert.ok(!f.logs.some(event => event.type === 'user/message'));
});
test('NO_ADAPTER preparation exhaustion returns no alternative to the owning provider', async () => {
  const f = fixture(); f.created(f.agent); const config = await f.request(); f.setPref({ enabled: true, allowedModels: [a] });
  assert.equal(await f.preparations.get(config)({ code: 'NO_ADAPTER', message: 'unavailable' }, config), undefined);
  assert.equal(f.listeners.has('agent/request-prepare-error'), false);
});
test('removed current model does not consume the sole newly allowed alternative budget', async () => {
  const f = fixture(); f.created(f.agent); await f.request(); f.setPref({ enabled: true, allowedModels: [b] });
  await f.request(f.agent, 2); assert.deepEqual(await f.error('QUOTA', f.agent, 2), { kind: 'retry' });
  assert.equal((await f.request(f.agent, 2)).model, 'b');
});
test('context overflow cannot enter an always-retry chain or trigger alternate models', async () => {
  const f = fixture(); f.created(f.agent); await f.request();
  assert.equal(await f.error('CONTEXT_WINDOW_EXCEEDED'), undefined);
});
test('a failing step stays bounded even if settings continuously add routes', async () => {
  const f = fixture(); f.setPref({ enabled: true, allowedModels: [a] }); f.created(f.agent); await f.request();
  f.setPref({ enabled: true, allowedModels: [a, b, c] });
  assert.equal(await f.error(), undefined);
});
test('request preflight availability errors recover before user admission', async () => {
  const f = fixture(); f.created(f.agent);
  f.ctx.llm.resolveCallConfig = async config => { if (config.model === 'a') throw Object.assign(new Error('unavailable'), { code: 'QUOTA' }); return config; };
  assert.equal((await f.request()).model, 'b');
  assert.ok(!f.logs.some(event => event.type === 'user/message'));
});
test('routing hooks prepend ahead of generic provider retries and downstream model selection', () => {
  const f = fixture();
  assert.equal(f.listeners.get('agent/request').options.prepend, true);
  assert.equal(f.listeners.get('agent/request-error').options.prepend, true);
});
test('mid-run fallback is upward-only by tier, derived from live settings', async () => {
  const f = fixture();
  f.setPref({ enabled: true, allowedModels: [a, b, c], modelTiers: [{ provider: 'one', model: 'a', tier: 'strong' }] });
  f.created(f.agent); await f.request();
  // a is strong: medium alternatives b/c must not be used, so the step is exhausted.
  assert.equal(await f.error(), undefined);
  // Live settings demote a to light: the same failing child may now escalate to medium.
  f.setPref({ enabled: true, allowedModels: [a, b, c], modelTiers: [{ provider: 'one', model: 'a', tier: 'light' }] });
  await f.request(f.agent, 2);
  assert.deepEqual(await f.error('QUOTA', f.agent, 2), { kind: 'retry' });
  assert.equal((await f.request(f.agent, 2)).model, 'b');
});
test('a light current route never falls back to an even weaker nonexistent tier', async () => {
  const f = fixture();
  f.setPref({ enabled: true, allowedModels: [a], modelTiers: [{ provider: 'one', model: 'a', tier: 'light' }] });
  f.created(f.agent); await f.request();
  assert.equal(await f.error(), undefined);
  assert.ok(f.warnings.some(value => /exhausted/i.test(value)));
});

// ── load spreading wiring: switches and agent lifecycle events ───────────────
test('mid-run fallback moves the child load reservation to the new route and updates the executor registry', async () => {
  const f = fixture();
  const router = automaticRouter(f.ctx.subagentModelSelection, f.ctx.llm);
  const token = router.reserve(a);
  router.adoptChild(f.agent.id, a, token, true);
  f.created(f.agent);
  await f.request();
  assert.deepEqual(await f.error(), { kind: 'retry' });
  assert.equal(router.activeCount(a), 0);
  assert.equal(router.activeCount(b), 1);
  assert.deepEqual(router.childRoute(f.agent.id), b);
  router.childDisposed(f.agent.id);
  assert.equal(router.activeCount(b), 0);
  assert.deepEqual(router.childRoute(f.agent.id), b); // route record survives for later verifies
});

test('agent status events release a continuable child at idle and count it again on a later turn', async () => {
  const f = fixture();
  const router = automaticRouter(f.ctx.subagentModelSelection, f.ctx.llm);
  router.adoptChild('kid', a, router.reserve(a), true);
  const status = (value, id = 'kid') => f.listeners.get('agent/status').callback({ agent: { id }, status: value });
  assert.equal(router.activeCount(a), 1);
  status('running'); // already counted: no double reservation
  assert.equal(router.activeCount(a), 1);
  status('idle'); // turn settled: released, route kept
  assert.equal(router.activeCount(a), 0);
  assert.deepEqual(router.childRoute('kid'), a);
  status('running'); // send_message turn: counted again on the CURRENT route
  assert.equal(router.activeCount(a), 1);
  status('idle');
  assert.equal(router.activeCount(a), 0);
  f.listeners.get('agent/disposed').callback({ agent: { id: 'kid' } }); // final safety net
  assert.equal(router.activeCount(a), 0);
});

test('status and disposal events for unregistered agents never touch the counts', () => {
  const f = fixture();
  const router = automaticRouter(f.ctx.subagentModelSelection, f.ctx.llm);
  f.listeners.get('agent/status').callback({ agent: { id: 'stranger' }, status: 'idle' });
  f.listeners.get('agent/status').callback({ agent: { id: 'stranger' }, status: 'running' });
  f.listeners.get('agent/disposed').callback({ agent: { id: 'stranger' } });
  assert.equal(router.activeCount(a), 0);
});

test('one-shot children ignore status transitions; only disposal is their safety net', () => {
  const f = fixture();
  const router = automaticRouter(f.ctx.subagentModelSelection, f.ctx.llm);
  router.adoptChild('oneshot', a, router.reserve(a), false);
  f.listeners.get('agent/status').callback({ agent: { id: 'oneshot' }, status: 'idle' });
  assert.equal(router.activeCount(a), 1); // tool settle path owns the release
  f.listeners.get('agent/disposed').callback({ agent: { id: 'oneshot' } });
  assert.equal(router.activeCount(a), 0);
});
