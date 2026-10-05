import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runtimeModuleUrl } from '../../lib/dsh-paths.mjs';
const path = fileURLToPath(new URL('../../lib/router.mjs', import.meta.url));
const { AutoModelRouter, automaticRouter, isAvailabilityFailure, routeConfig, tierOfRoute } = await import(pathToFileURL(path)).catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== pathToFileURL(path).href) throw error;
  return {};
});
const a = { provider: 'one', model: 'a' }, b = { provider: 'two', model: 'b' }, c = { provider: 'three', model: 'c' };
function fixture(routes = [a, b, c], modelTiers = []) {
  let preference = { enabled: true, allowedModels: routes, modelTiers };
  let providers = ['one', 'two', 'three'];
  let fail = () => undefined;
  const resolved = [];
  const settings = { current: () => structuredClone(preference) };
  const llm = {
    listProviders: () => providers.map(id => ({ id })),
    async resolveCallConfig(config, signal) { signal.throwIfAborted(); resolved.push(config); const error = fail(config); if (error) throw error; return { ...config }; },
  };
  return { router: new AutoModelRouter(settings, llm), parent: {}, signal: new AbortController().signal, resolved, settings, llm,
    setPreference(value) { preference = value; }, setProviders(value) { providers = value; }, setFailure(value) { fail = value; } };
}
const unavailable = (code = 'RATE_LIMIT') => Object.assign(new Error('provider unavailable'), { failure: { code, message: 'provider unavailable' }, code });
const tiers = (...entries) => entries.map(([route, tier]) => ({ provider: route.provider, model: route.model, tier }));

test('tier selection picks the least-loaded model of the requested tier; a settled child frees its route', async () => {
  const f = fixture([a, b, c], tiers([a, 'medium'], [c, 'medium'], [b, 'light']));
  assert.deepEqual((await f.router.select(f.parent, { tier: 'medium' }, f.signal)), { route: a, tier: 'medium', requestedTier: 'medium', failures: [] });
  (await f.router.select(f.parent, { tier: 'medium' }, f.signal)).token.release(); // child settled
  f.setFailure(config => config.model === 'a' ? unavailable() : undefined);
  assert.deepEqual((await f.router.select(f.parent, { tier: 'medium' }, f.signal)).route, c);
});

test('a single task always goes to the first model; concurrent tasks spread by least load', async () => {
  const f = fixture([a, b, c], tiers([a, 'light'], [b, 'light']));
  // Sequential delegations with each child settled in between stay on the first model.
  for (let i = 0; i < 3; i += 1) {
    const picked = await f.router.select(f.parent, { tier: 'light' }, f.signal);
    assert.deepEqual(picked.route, a);
    picked.token.release();
  }
  // Concurrent delegations reserve synchronously before any await: 1st→a, 2nd→b, 3rd→a (tie, saved order).
  const picked = await Promise.all(Array.from({ length: 3 }, () => f.router.select(f.parent, { tier: 'light' }, f.signal)));
  assert.deepEqual(picked.map(p => p.route), [a, b, a]);
  for (const selection of picked) selection.token.release();
  assert.equal(f.router.activeCount(a), 0);
  assert.equal(f.router.activeCount(b), 0);
  f.setFailure(config => config.model === 'a' ? unavailable() : undefined);
  assert.deepEqual((await f.router.select(f.parent, { tier: 'light' }, f.signal)).route, b);
  assert.equal(f.resolved.filter(config => config.model === 'a').length, 6);
});

test('default tier is medium when tier is omitted', async () => {
  const f = fixture([a, b, c], tiers([a, 'light'], [b, 'strong']));
  const picked = await f.router.select(f.parent, {}, f.signal);
  assert.deepEqual(picked.route, c);
  assert.equal(picked.tier, 'medium');
  assert.equal(picked.requestedTier, 'medium');
});

test('a model with no tier entry counts as medium', async () => {
  const f = fixture([a, b], tiers([b, 'light']));
  assert.equal(tierOfRoute(a, f.settings.current().modelTiers), 'medium');
  assert.deepEqual((await f.router.select(f.parent, {}, f.signal)).route, a);
});

test('escalation is upward only: light may reach medium and strong', async () => {
  const f = fixture([a, b, c], tiers([a, 'light']));
  f.setFailure(config => config.model === 'a' ? unavailable() : undefined);
  const picked = await f.router.select(f.parent, { tier: 'light' }, f.signal);
  assert.equal(picked.tier, 'medium');
  assert.equal(picked.requestedTier, 'light');
  assert.deepEqual(picked.route, b);
  assert.deepEqual(picked.failures, [{ route: a, code: 'RATE_LIMIT' }]);
});

test('escalation skips empty tiers: light with no medium goes to strong', async () => {
  const f = fixture([a], tiers([a, 'strong']));
  const picked = await f.router.select(f.parent, { tier: 'light' }, f.signal);
  assert.deepEqual(picked.route, a);
  assert.equal(picked.tier, 'strong');
  assert.equal(picked.requestedTier, 'light');
});

test('a strong task never falls to medium or light and throws a clear tier error', async () => {
  const f = fixture([a, b, c], tiers([a, 'medium'], [b, 'light'], [c, 'medium']));
  await assert.rejects(f.router.select(f.parent, { tier: 'strong' }, f.signal),
    /no usable "strong".*saved Subagent settings/);
  assert.equal(f.resolved.length, 0);
  f.setPreference({ enabled: true, allowedModels: [a], modelTiers: tiers([a, 'strong']) });
  f.setFailure(() => unavailable('AUTH'));
  await assert.rejects(f.router.select(f.parent, { tier: 'strong' }, f.signal), /no usable "strong"/);
  assert.equal(f.resolved.length, 1);
});

test('a medium task may escalate to strong but never to light', async () => {
  const f = fixture([b, c], tiers([b, 'light'], [c, 'strong']));
  const picked = await f.router.select(f.parent, { tier: 'medium' }, f.signal);
  assert.deepEqual(picked.route, c);
  f.setFailure(config => config.model === 'c' ? unavailable() : undefined);
  f.setPreference({ enabled: true, allowedModels: [b], modelTiers: tiers([b, 'light']) });
  await assert.rejects(f.router.select(f.parent, { tier: 'medium' }, f.signal), /no usable "medium"/);
});

test('saved list and tier changes are immediately used by the next delegation', async () => {
  const f = fixture([a, b]);
  assert.deepEqual((await f.router.select(f.parent, {}, f.signal)).route, a);
  f.setPreference({ enabled: true, allowedModels: [a, b], modelTiers: tiers([a, 'light'], [b, 'strong']) });
  assert.deepEqual((await f.router.select(f.parent, {}, f.signal)).route, b);
  assert.equal((await f.router.select(f.parent, {}, f.signal)).tier, 'strong');
});

test('disabled or empty settings fail closed with no inherited model', async () => {
  const f = fixture();
  for (const preference of [{ enabled: false, allowedModels: [a], modelTiers: [] }, { enabled: true, allowedModels: [], modelTiers: [] }]) {
    f.setPreference(preference);
    await assert.rejects(f.router.select(f.parent, {}, f.signal), /disabled|empty/i);
  }
  assert.equal(f.resolved.length, 0);
});

test('disabled providers are excluded from selection and fallback', async () => {
  const f = fixture(); f.setProviders(['two']);
  assert.deepEqual((await f.router.select(f.parent, {}, f.signal)).route, b);
  assert.deepEqual(await f.router.fallback(a, new Set(), f.signal), b);
});

test('explicit request must be a complete authorized route; effort does not authorize parent inheritance', async () => {
  const f = fixture();
  await assert.rejects(f.router.select(f.parent, { provider: 'one' }, f.signal), /together/);
  await assert.rejects(f.router.select(f.parent, { provider: 'main', model: 'expensive' }, f.signal), /allowed/);
  const picked = await f.router.select(f.parent, { reasoning_effort: 'high' }, f.signal);
  assert.deepEqual(picked.route, a);
  assert.equal(picked.reasoningEffort, 'high');
  assert.equal(picked.tier, 'medium');
});

test('explicit route ignores the requested tier but reports its own tier', async () => {
  const f = fixture([a, b], tiers([a, 'light']));
  const picked = await f.router.select(f.parent, { provider: 'one', model: 'a', tier: 'strong' }, f.signal);
  assert.deepEqual(picked.route, a);
  assert.equal(picked.tier, 'light');
  assert.equal(picked.requestedTier, 'light');
});

test('invalid tier values default to medium rather than failing a delegation', async () => {
  const f = fixture([a]);
  const picked = await f.router.select(f.parent, { tier: 'colossal' }, f.signal);
  assert.deepEqual(picked.route, a);
  assert.equal(picked.requestedTier, 'medium');
});

test('preflight provider failures try the next enabled route, not the parent', async () => {
  const f = fixture(); f.setFailure(config => config.model === 'a' ? unavailable() : undefined);
  assert.deepEqual((await f.router.select(f.parent, {}, f.signal)).route, b);
  assert.equal(f.resolved.length, 2);
});

test('invalid effort and task errors do not trigger fallback', async () => {
  const f = fixture(); f.setFailure(() => unavailable('INVALID_REASONING_EFFORT'));
  await assert.rejects(f.router.select(f.parent, { reasoning_effort: 'bad' }, f.signal), /provider unavailable/);
  assert.equal(f.resolved.length, 1);
  for (const code of ['ABORTED', 'CANCELLED', 'UNKNOWN', 'REFUSAL', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'TOOL_ERROR']) assert.equal(isAvailabilityFailure({ code }), false);
});

test('caller effort applies to the first attempted route and is cleared on escalation', async () => {
  const f = fixture([a, b], tiers([a, 'light'], [b, 'medium']));
  f.setFailure(config => config.model === 'a' ? unavailable() : undefined);
  const picked = await f.router.select(f.parent, { tier: 'light', reasoning_effort: 'high' }, f.signal);
  assert.deepEqual(picked.route, { provider: 'two', model: 'b' });
  assert.equal(picked.reasoningEffort, undefined);
  assert.equal(f.resolved[0].reasoningEffort, 'high');
  assert.equal(f.resolved[1].reasoningEffort, undefined);
});

test('mid-run fallback stays in the same tier or escalates upward, never downward', async () => {
  const f = fixture([a, b, c], tiers([b, 'light'], [a, 'strong'], [c, 'strong']));
  // current route is light: alternatives are light first (none untried), then medium, then strong.
  assert.deepEqual(await f.router.fallback(b, new Set(), f.signal), a);
  // current route is strong: no downward candidates remain.
  const f2 = fixture([a, b, c], tiers([a, 'strong'], [b, 'medium'], [c, 'light']));
  assert.equal(await f2.router.fallback(a, new Set(), f2.signal), undefined);
});

test('fallback skips unavailable same-tier candidates and escalates to a stronger tier', async () => {
  const f = fixture([a, b, c], tiers([a, 'light'], [b, 'light'], [c, 'medium']));
  f.setFailure(config => config.model === 'b' ? unavailable('AUTH') : undefined);
  assert.deepEqual(await f.router.fallback(a, new Set(), f.signal), c);
  f.setFailure(() => unavailable('INVALID_CONFIG'));
  await assert.rejects(f.router.fallback(a, new Set(), f.signal), /provider unavailable/);
});

test('fallback derives the tier of the current route from live settings; untiered counts as medium', async () => {
  const f = fixture([a, b], tiers([b, 'light']));
  f.setPreference({ enabled: true, allowedModels: [a, b], modelTiers: [] });
  assert.deepEqual(await f.router.fallback(a, new Set(), f.signal), b);
  f.setPreference({ enabled: true, allowedModels: [a, b], modelTiers: tiers([a, 'strong']) });
  assert.equal(await f.router.fallback(a, new Set(['two\0b']), f.signal), undefined);
});

test('fallback tries each route once, re-reads settings, and terminates on exhaustion', async () => {
  const f = fixture(), tried = new Set();
  assert.deepEqual(await f.router.fallback(a, tried, f.signal), b);
  f.setPreference({ enabled: true, allowedModels: [a, c], modelTiers: [] });
  assert.deepEqual(await f.router.fallback(b, tried, f.signal), c);
  assert.equal(await f.router.fallback(c, tried, f.signal), undefined);
  assert.equal(tried.size, 3);
});

test('saving disabled settings during preflight prevents publication of the chosen route', async () => {
  const f = fixture(); f.setFailure(() => { f.setPreference({ enabled: false, allowedModels: [a, b], modelTiers: [] }); return undefined; });
  await assert.rejects(f.router.select(f.parent, {}, f.signal), /disabled/);
});

test('all failing preflights give a bounded failure without starting any child', async () => {
  const f = fixture(); f.setFailure(() => unavailable('AUTH'));
  await assert.rejects(f.router.select(f.parent, {}, f.signal), /no usable "medium"/i);
  assert.equal(f.resolved.length, 3);
});

test('aborted selection and fallback never advance to a second provider', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.router.select(f.parent, {}, controller.signal));
  await assert.rejects(f.router.fallback(a, new Set(), controller.signal));
  assert.equal(f.resolved.length, 0);
});

test('the shared router still survives Cordis fresh service wrappers and stays deterministic', async () => {
  const { Context, Service } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
  class Settings extends Service {
    constructor(ctx) { super(ctx, 'subagentModelSelection'); }
    current() { return { enabled: true, allowedModels: [a, b, c], modelTiers: [] }; }
  }
  const root = new Context();
  root.plugin(Settings);
  await new Promise(resolve => setTimeout(resolve, 20));
  const llm = { listProviders: () => ['one', 'two', 'three'].map(id => ({ id })), resolveCallConfig: async config => config };
  const parent = {}, signal = new AbortController().signal;
  assert.notEqual(root.get('subagentModelSelection'), root.get('subagentModelSelection'), 'precondition: wrappers differ');
  const routerA = automaticRouter(root.get('subagentModelSelection'), llm);
  assert.equal(automaticRouter(root.get('subagentModelSelection'), llm), routerA);
  const picked = [];
  for (let i = 0; i < 2; i += 1) {
    // Each child settles before the next delegation, so both go to the first model
    // through the SAME shared router instance.
    const selection = await routerA.select(parent, {}, signal);
    picked.push(selection.route);
    selection.token.release();
  }
  assert.deepEqual(picked, [a, a]);
  // Instance-level load counts are global across parents by construction: the shared
  // router is keyed by the settings service, not by the calling parent.
  const selection = await routerA.select({}, {}, signal);
  assert.deepEqual(selection.route, a);
  selection.token.release();
});

test('route switch clears route-owned effort while preserving deliberate output limits and sampling', () => {
  assert.deepEqual(routeConfig({ provider: 'main', model: 'parent', reasoningEffort: 'xhigh', maxTokens: 60000, temperature: .2, topP: .5 }, b), { ...b, maxTokens: 60000, temperature: .2, topP: .5 });
});

test('provider-neutral availability taxonomy is explicit, never inferred from messages or status alone', () => {
  for (const code of ['AUTH', 'RATE_LIMIT', 'TRANSPORT', 'SERVER', 'TIMEOUT', 'NO_ADAPTER', 'MISSING_CREDENTIAL', 'QUOTA', 'QUOTA_EXCEEDED', 'UNKNOWN_MODEL']) assert.equal(isAvailabilityFailure({ code }), true);
  assert.equal(isAvailabilityFailure({ code: 'INVALID_CONFIG', status: 503 }), false);
  assert.equal(isAvailabilityFailure({ code: 'BAD_INPUT', status: 400 }), false);
  assert.equal(isAvailabilityFailure(new Error('rate limit timeout quota')), false);
});

test('pi-ai structured 404 model-not-found errors are availability failures, not arbitrary PI_AI_ERROR text', () => {
  const message = '404: {"message":"Model \\"deepseek/deepseek-v4.1-flash:free\\" does not exist.","type":"not_found_error","code":"not_found"}';
  assert.equal(isAvailabilityFailure({ code: 'PI_AI_ERROR', message }), true);
  assert.equal(isAvailabilityFailure({ failure: { code: 'PI_AI_ERROR', message } }), true);
  for (const text of [
    '404: route not found',
    '404: {"message":"File does not exist.","type":"not_found_error","code":"not_found"}',
    '400: {"message":"Model \\"a\\" does not exist.","type":"not_found_error","code":"not_found"}',
    '404: {"message":"Model \\"a\\" does not exist.","type":"invalid_request_error","code":"not_found"}',
    'pi-ai deferred response is not supported',
    '404: {broken json}',
  ]) assert.equal(isAvailabilityFailure({ code: 'PI_AI_ERROR', message: text }), false);
  for (const code of ['INVALID_REQUEST', 'TOOL_ERROR', 'ABORTED', 'UNKNOWN']) assert.equal(isAvailabilityFailure({ code, message }), false);
});

// ── load spreading and verifies (executor on a different model) ──────────────
test('three concurrent strong delegations spread to three distinct routes in saved order', async () => {
  const f = fixture([a, b, c], tiers([a, 'strong'], [b, 'strong'], [c, 'strong']));
  const picked = await Promise.all(Array.from({ length: 3 }, () => f.router.select(f.parent, { tier: 'strong' }, f.signal)));
  assert.deepEqual(picked.map(p => p.route), [a, b, c]);
  assert.deepEqual([f.router.activeCount(a), f.router.activeCount(b), f.router.activeCount(c)], [1, 1, 1]);
  for (const selection of picked) selection.token.release();
  assert.deepEqual([f.router.activeCount(a), f.router.activeCount(b), f.router.activeCount(c)], [0, 0, 0]);
});

test('availability failure, hard error and abort during preflight all release the reservation', async () => {
  const f = fixture([a, b]);
  // availability failure: attempt releases and escalates
  f.setFailure(config => config.model === 'a' ? unavailable() : undefined);
  const first = await f.router.select(f.parent, {}, f.signal);
  assert.deepEqual(first.route, b);
  assert.equal(f.router.activeCount(a), 0);
  first.token.release();
  // hard (non-availability) error: attempt throws AND releases
  f.setFailure(() => Object.assign(new Error('bad effort'), { failure: { code: 'INVALID_REASONING_EFFORT' }, code: 'INVALID_REASONING_EFFORT' }));
  await assert.rejects(f.router.select(f.parent, {}, f.signal), /bad effort/);
  assert.equal(f.router.activeCount(a), 0);
  // cancellation mid-preflight: released through the same finally
  const gate = [];
  f.setFailure(() => undefined);
  f.llm.resolveCallConfig = (config, signal) => new Promise((resolve, reject) => { gate.push({ resolve, reject }); signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { failure: { code: 'ABORTED' }, code: 'ABORTED' })), { once: true }); });
  const controller = new AbortController();
  const pending = f.router.select(f.parent, {}, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending);
  assert.equal(f.router.activeCount(a), 0);
});

test('mid-run route switch moves the child count from the old route to the new one', async () => {
  const f = fixture([a, b, c]);
  const selection = await f.router.select(f.parent, {}, f.signal);
  assert.deepEqual(selection.route, a);
  f.router.adoptChild('child-1', selection.route, selection.token);
  assert.equal(f.router.activeCount(a), 1);
  f.router.switchChildRoute('child-1', b);
  assert.equal(f.router.activeCount(a), 0);
  assert.equal(f.router.activeCount(b), 1);
  assert.deepEqual(f.router.childRoute('child-1'), b);
  f.router.childDisposed('child-1');
  assert.equal(f.router.activeCount(b), 0);
  // the route record survives disposal for later `verifies`
  assert.deepEqual(f.router.childRoute('child-1'), b);
});

test('least-loaded applies inside an escalated tier too', async () => {
  const f = fixture([a, b, c], tiers([a, 'light'], [b, 'medium'], [c, 'medium']));
  f.setFailure(config => config.model === 'a' ? unavailable() : undefined); // light tier unusable
  // pretend b already carries an active child: the escalated medium pick avoids b
  const held = f.router.reserve(b);
  const picked = await f.router.select(f.parent, { tier: 'light' }, f.signal);
  assert.deepEqual(picked.route, c);
  picked.token.release();
  held.release();
  assert.equal(f.router.activeCount(b), 0);
});

test('verifies excludes the executor route within the tier and records excludedRoute', async () => {
  const f = fixture([a, b, c], tiers([a, 'strong'], [b, 'strong'], [c, 'strong']));
  const executor = await f.router.select(f.parent, { tier: 'strong' }, f.signal);
  f.router.adoptChild('exec-1', executor.route, executor.token);
  const verifier = await f.router.select(f.parent, { tier: 'strong', verifies: 'exec-1' }, f.signal);
  assert.deepEqual(verifier.route, b);
  assert.equal(verifier.verifies, 'exec-1');
  assert.deepEqual(verifier.excludedRoute, a);
  assert.equal(verifier.sameModelAsExecutor, undefined);
  verifier.token.release();
  f.router.childDisposed('exec-1');
});

test('verifies escalates to a stronger tier before ever reusing the executor route', async () => {
  const f = fixture([a, b], tiers([a, 'medium'], [b, 'strong']));
  const executor = await f.router.select(f.parent, { tier: 'medium' }, f.signal);
  f.router.adoptChild('exec-2', executor.route, executor.token);
  // executor a is the only medium model: the verifier escalates to strong (b), not back to a.
  const verifier = await f.router.select(f.parent, { tier: 'medium', verifies: 'exec-2' }, f.signal);
  assert.deepEqual(verifier.route, b);
  assert.deepEqual(verifier.excludedRoute, a);
  verifier.token.release();
  f.router.childDisposed('exec-2');
});

test('verifies follows the executor CURRENT route after a mid-run switch', async () => {
  const f = fixture([a, b, c]);
  const executor = await f.router.select(f.parent, {}, f.signal);
  f.router.adoptChild('exec-3', executor.route, executor.token);
  f.router.switchChildRoute('exec-3', b);
  const verifier = await f.router.select(f.parent, { verifies: 'exec-3' }, f.signal);
  // b is excluded; least-loaded remaining are a (0) and c (0): saved order picks a.
  assert.deepEqual(verifier.route, a);
  assert.deepEqual(verifier.excludedRoute, b);
  verifier.token.release();
  f.router.childDisposed('exec-3');
});

test('verifies with no alternative falls back to the executor route with sameModelAsExecutor and no failure', async () => {
  const f = fixture([a, b], tiers([a, 'strong'], [b, 'light']));
  const executor = await f.router.select(f.parent, { tier: 'strong' }, f.signal);
  f.router.adoptChild('exec-4', executor.route, executor.token);
  f.setFailure(config => config.model === 'b' ? unavailable() : undefined); // the only other route fails
  // b is light (below strong) so it is not even tried; a is the last resort.
  const verifier = await f.router.select(f.parent, { tier: 'strong', verifies: 'exec-4' }, f.signal);
  assert.deepEqual(verifier.route, a);
  assert.equal(verifier.sameModelAsExecutor, true);
  assert.equal(verifier.excludedRoute, undefined);
  verifier.token.release();
  // The same-model fallback still participates in load spreading like any selection.
  assert.equal(f.router.activeCount(a), 1); // the executor's reservation is still held
});

test('unknown verifies id ignores the rule and records verifiesUnknown', async () => {
  const f = fixture();
  const picked = await f.router.select(f.parent, { verifies: 'no-such-child' }, f.signal);
  assert.deepEqual(picked.route, a);
  assert.equal(picked.verifies, 'no-such-child');
  assert.equal(picked.verifiesUnknown, true);
  assert.equal(picked.excludedRoute, undefined);
  picked.token.release();
});

test('explicit provider/model overrides the verifies rule entirely', async () => {
  const f = fixture([a, b]);
  const executor = await f.router.select(f.parent, {}, f.signal);
  f.router.adoptChild('exec-6', executor.route, executor.token);
  const picked = await f.router.select(f.parent, { provider: 'one', model: 'a', verifies: 'exec-6' }, f.signal);
  assert.deepEqual(picked.route, a);
  assert.equal(picked.verifies, undefined);
  assert.equal(picked.sameModelAsExecutor, undefined);
  picked.token.release();
  f.router.childDisposed('exec-6');
});

test('alias ids (background job ids) resolve to the executor route', async () => {
  const f = fixture();
  const executor = await f.router.select(f.parent, {}, f.signal);
  f.router.adoptChild('session-1', executor.route, executor.token);
  f.router.aliasChild('subagent-7', 'session-1');
  const verifier = await f.router.select(f.parent, { verifies: 'subagent-7' }, f.signal);
  assert.deepEqual(verifier.route, b);
  assert.deepEqual(verifier.excludedRoute, a);
  verifier.token.release();
  f.router.childDisposed('subagent-7');
  assert.equal(f.router.activeCount(a), 0);
});

for (const mode of ['selection', 'verification fallback', 'recovery']) {
  test(`${mode} rejects a route downgraded while its availability is checked`, async () => {
    const f = fixture([a, b], tiers([a, 'strong'], [b, 'strong']));
    if (mode === 'verification fallback') f.router.adoptChild('executor', a);
    f.setFailure(config => {
      if (mode === 'verification fallback' && config.model === b.model) return unavailable();
      f.setPreference({ enabled: true, allowedModels: [a, b], modelTiers: tiers([a, 'light'], [b, 'strong']) });
    });
    if (mode === 'verification fallback') {
      await assert.rejects(f.router.select(f.parent, { tier: 'strong', verifies: 'executor' }, f.signal), /no usable/);
    } else {
      const picked = mode === 'recovery'
        ? await f.router.fallback(b, new Set(), f.signal)
        : await f.router.select(f.parent, { tier: 'strong' }, f.signal);
      if (mode === 'recovery') assert.equal(picked, undefined);
      else { assert.deepEqual(picked.route, b); picked.token.release(); }
    }
    assert.equal(f.router.activeCount(a), 0);
    assert.equal(f.router.activeCount(b), 0);
  });
}

test('explicit route remains usable when its tier changes during preflight', async () => {
  const f = fixture([a], tiers([a, 'strong']));
  f.setFailure(() => f.setPreference({ enabled: true, allowedModels: [a], modelTiers: tiers([a, 'light']) }));
  const picked = await f.router.select(f.parent, { provider: a.provider, model: a.model, tier: 'strong' }, f.signal);
  assert.deepEqual(picked.route, a);
  assert.equal(picked.tier, 'light');
  picked.token.release();
});
