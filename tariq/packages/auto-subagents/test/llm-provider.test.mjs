import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
import AutoLlmRuntime from '../lib/llm-provider.mjs';
import * as Routing from '../lib/runtime.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { LlmAdapter, LlmError, createUserMessage } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { validateStoredEvents } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session-persistence'));
const services = await Promise.all(['session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop'].map(async name => (await import(runtimeModuleUrl(`@deepseek-ai/dsh-${name}`))).default));
const routes = [{ provider: 'one', model: 'a' }, { provider: 'two', model: 'b' }, { provider: 'three', model: 'c' }];
const textChunks = function* () { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Verified' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Verified' } }; yield { type: 'finish', reason: { kind: 'stop' } }; };
async function harness(t, adapter, options = {}) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose()); await ctx.plugin(AutoLlmRuntime);
  for (const service of services) await ctx.plugin(service, service === services.at(-1) ? { agents: [] } : undefined);
  ctx.llm.registerAdapter(['one', 'two', 'three'], adapter);
  ctx.provide('subagentModelSelection', { current: () => ({ enabled: true, allowedModels: options.routes ?? routes }) });
  ctx.provide('agentPresets', { composedPreset: () => 'auto-subagents' }); const routingFiber = ctx.plugin(Routing); await routingFiber;
  let corePrepareHooks = 0; if (!options.main) ctx.on('agent/request-prepare-error', () => { corePrepareHooks += 1; throw new Error('Auto must not depend on a preparation extension'); });
  const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: 'native-preparation', ...(options.main ? {} : { meta: { origin: 'subagent' } }), agentOptions: { provider: 'one', model: 'a', ...(options.agentOptions ?? {}) } });
  const agent = handle.agent, message = createUserMessage({ content: [{ type: 'text', text: 'Perform the task once' }], source: { kind: 'user' } });
  return { ctx, agent, message, routingFiber, corePrepareHooks: () => corePrepareHooks, run: async () => { agent.followup(message); await agent.whenIdle(); return agent.session.snapshotEvents(); } };
}

test('real agent loop recovers adapter preparation before admission and logs the native actual route', async t => {
  const prepared = [], streamed = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: model === 'a' ? 111 : 222 }; }
    async prepareCall(provider, model, signal) {
      prepared.push(model); signal.throwIfAborted(); if (model === 'a') throw new LlmError('Quota unavailable only during preparation', 'QUOTA');
      return super.prepareCall(provider, model, signal);
    }
    async *stream(request) { streamed.push(request); yield* textChunks(); }
  }
  const f = await harness(t, new Adapter(), { agentOptions: { maxTokens: 777 } }), events = await f.run();
  assert.deepEqual(prepared, ['a', 'b']); assert.deepEqual(streamed.map(request => request.model), ['b']); assert.equal(streamed[0].maxTokens, 777);
  assert.equal(f.corePrepareHooks(), 0); assert.equal(f.agent.session.requestHeader().config.model, 'b');
  assert.equal(events.filter(event => event.type === 'auto-subagent/route').length, 1);
  assert.equal(events.filter(event => event.type === 'user/message').length, 1);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === f.message.id).length, 1);
  assert.equal(events.filter(event => event.type === 'assistant/attempt').length, 0);
  assert.equal(events.filter(event => event.type === 'tool/call' || event.type === 'tool/result').length, 0);
  assert.equal(events.filter(event => event.type === 'request/header').length, 1);
});

test('preparation exhaustion terminates boundedly without header, user admission or provider dispatch', async t => {
  const calls = [];
  class Adapter extends LlmAdapter {
    async prepareCall(provider, model) { calls.push(model); throw new LlmError('Unavailable preparation', 'AUTH'); }
    async *stream() { throw new Error('Never dispatch'); }
  }
  const f = await harness(t, new Adapter()), events = await f.run();
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(events.filter(event => event.type === 'request/header' || event.type === 'user/message' || event.type === 'assistant/message').length, 0);
  assert.equal(events.filter(event => event.type === 'auto-subagent/exhausted').length, 1);
});

test('abort during native preparation stops before recovery or user admission', async t => {
  let entered; const began = new Promise(resolve => { entered = resolve; }); const calls = [];
  class Adapter extends LlmAdapter {
    async prepareCall(provider, model, signal) {
      calls.push(model); entered();
      await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new LlmError('Aborted preparation', 'AUTH')), { once: true }); });
      throw new Error('Unreachable');
    }
    async *stream() { throw new Error('Never dispatch'); }
  }
  const f = await harness(t, new Adapter()); f.agent.followup(f.message); await began; f.agent.cancel({ kind: 'user' }); await f.agent.whenIdle();
  assert.deepEqual(calls, ['a']); assert.equal(f.corePrepareHooks(), 0);
  assert.equal(f.agent.session.snapshotEvents().filter(event => ['auto-subagent/route', 'user/message', 'request/header'].includes(event.type)).length, 0);
});

test('provider consumes only the exact bound request and delegates every unbound call unchanged', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose()); await ctx.plugin(AutoLlmRuntime); const calls = [];
  class Adapter extends LlmAdapter {
    async prepareCall(provider, model) { calls.push(model); if (model === 'a') throw new LlmError('Unavailable', 'QUOTA'); return super.prepareCall(provider, model); }
    async *stream() { yield* textChunks(); }
  }
  ctx.llm.registerAdapter(['one', 'two'], new Adapter()); const original = { ...routes[0], maxTokens: 100 };
  let recovered = 0; ctx.llm.bindAutoPreparation(original, async () => { recovered += 1; return { ...routes[1], maxTokens: 100 }; });
  await assert.rejects(ctx.llm.prepareCall({ ...original }), { code: 'QUOTA' }); assert.equal(recovered, 0);
  const prepared = await ctx.llm.prepareCall(original); assert.equal(prepared.config.model, 'b'); assert.equal(prepared.config.maxTokens, 100); assert.equal(recovered, 1);
  await assert.rejects(ctx.llm.prepareCall(original), { code: 'QUOTA' }); assert.equal(recovered, 1);
  assert.deepEqual(calls, ['a', 'a', 'b', 'a']);
});

test('native adapter metadata defaults and prepared-call one-shot dispatch remain upstream owned', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose()); await ctx.plugin(AutoLlmRuntime);
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: 1234, context: { contextWindow: 9000 } }; }
    async *stream() { yield* textChunks(); }
  }
  ctx.llm.registerAdapter(['one'], new Adapter()); const prepared = await ctx.llm.prepareCall(routes[0]);
  assert.equal(prepared.config.maxTokens, 1234); assert.deepEqual(prepared.adapterDefaults, { maxTokens: true }); assert.deepEqual(prepared.context, { contextWindow: 9000 }); assert.ok(Object.isFrozen(prepared.config));
  const request = { ...prepared.config, messages: [], signal: new AbortController().signal };
  const chunks = []; for await (const chunk of prepared.stream(request)) chunks.push(chunk); assert.ok(chunks.some(chunk => chunk.type === 'finish'));
  assert.throws(() => prepared.stream(request), { code: 'INVALID_PREPARED_CALL' });
});


test('managed NO_ADAPTER exhaustion is terminal before admission instead of upstream middleware compatibility', async t => {
  const calls = [];
  class Adapter extends LlmAdapter {
    async prepareCall(provider, model) { calls.push(model); throw new LlmError('Adapter registration disappeared', 'NO_ADAPTER'); }
    async *stream() { throw new Error('Never dispatch'); }
  }
  const f = await harness(t, new Adapter()), events = await f.run();
  assert.deepEqual(calls, ['a', 'b', 'c']); assert.equal(f.corePrepareHooks(), 0);
  assert.equal(events.filter(event => ['request/header', 'user/message', 'assistant/message', 'assistant/attempt'].includes(event.type)).length, 0);
  assert.equal(events.filter(event => event.type === 'auto-subagent/exhausted').length, 1);
});


test('native keyless successor session replays actual preparation fallback with resolved header and unchanged visible task', async t => {
  class Adapter extends LlmAdapter {
    async prepareCall(provider, model, signal) { if (model === 'a') throw new LlmError('Preparation route quota exhausted', 'QUOTA'); return super.prepareCall(provider, model, signal); }
    async *stream() { yield* textChunks(); }
  }
  const f = await harness(t, new Adapter()), events = await f.run(), recorded = { header: f.agent.session.header, events };
  const file = new URL('./fixtures/auto-llm-prepare-successor.session.json', import.meta.url);
  if (process.env.RECORD_AUTO_LLM_SESSION === '1') await writeFile(file, JSON.stringify(recorded, null, 2) + '\n');
  const fixture = JSON.parse(await readFile(file, 'utf8')); validateStoredEvents(fixture.header, fixture.events);
  const projection = value => Session.fromRestore(value.header.id, value.events, value.header, 0, 'detached').deriveMessages().map(({ role, content }) => ({ role, content }));
  assert.deepEqual(projection(recorded), projection(fixture));
  const restored = Session.fromRestore(fixture.header.id, fixture.events, fixture.header, 0, 'detached');
  assert.equal(restored.requestHeader().config.model, 'b');
  assert.equal(fixture.events.filter(event => event.type === 'auto-subagent/route').length, 1);
  assert.equal(fixture.events.filter(event => event.type === 'user/message').length, 1);
  assert.equal(fixture.events.at(-1).data.reason.kind, 'completed');
});


test('disposed routing owner cannot perform late recovery from a pending adapter preparation', async t => {
  let enter, reject; const entered = new Promise(resolve => { enter = resolve; }); const pending = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }); const calls = [];
  class Adapter extends LlmAdapter {
    async prepareCall(provider, model) { calls.push(model); enter(); await pending; throw new Error('Unreachable'); }
    async *stream() { throw new Error('Never dispatch'); }
  }
  const f = await harness(t, new Adapter()); f.agent.followup(f.message); await entered;
  await f.routingFiber.dispose(); reject(new LlmError('Late quota failure', 'QUOTA')); await f.agent.whenIdle();
  assert.deepEqual(calls, ['a']);
  assert.equal(f.agent.session.snapshotEvents().filter(event => ['auto-subagent/route', 'user/message', 'request/header'].includes(event.type)).length, 0);
});

test('unmanaged NO_ADAPTER remains native middleware compatibility and never receives Auto policy', async t => {
  class Adapter extends LlmAdapter {
    async prepareCall() { throw new LlmError('Middleware-owned route', 'NO_ADAPTER'); }
    async *stream() { throw new Error('Middleware must own dispatch'); }
  }
  const f = await harness(t, new Adapter(), { main: true }); let dispatched = 0;
  f.ctx.on('llm/stream', async function* () { dispatched += 1; yield* textChunks(); });
  const events = await f.run(); assert.equal(dispatched, 1);
  assert.equal(events.filter(event => event.type === 'auto-subagent/route').length, 0);
  assert.equal(events.at(-1).data.reason.kind, 'completed'); assert.equal(f.agent.session.requestHeader().config.model, 'a');
});

test('arbitrary null or undefined adapter failures are preserved rather than replaced by wrapper TypeError', async t => {
  for (const failure of [null, undefined]) {
    const ctx = new Context(); t.after(() => ctx.fiber.dispose()); await ctx.plugin(AutoLlmRuntime);
    class Adapter extends LlmAdapter { async prepareCall() { throw failure; } async *stream() { throw new Error('Never dispatch'); } }
    ctx.llm.registerAdapter(['one'], new Adapter()); const config = { ...routes[0] }; ctx.llm.bindAutoPreparation(config, async () => undefined);
    let thrown = false; try { await ctx.llm.prepareCall(config); } catch (error) { thrown = true; assert.equal(error, failure); } assert.equal(thrown, true);
  }
});

test('simultaneous native children bind recovery to their own config without changing a healthy sibling', async t => {
  let entered, reject; const began = new Promise(resolve => { entered = resolve; }), pending = new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }); const streams = [];
  class Adapter extends LlmAdapter {
    async prepareCall(provider, model, signal) { if (model === 'a') { entered(); await pending; } return super.prepareCall(provider, model, signal); }
    async *stream(request) { streams.push({ id: request.sessionId, model: request.model }); yield* textChunks(); }
  }
  const f = await harness(t, new Adapter()), failed = f.run(); await began;
  const sibling = await f.ctx.agentLoop.createAgent(f.ctx, { sessionId: 'healthy-sibling', meta: { origin: 'subagent' }, agentOptions: { provider: 'three', model: 'c' } });
  sibling.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Independent task' }], source: { kind: 'user' } })); await sibling.agent.whenIdle();
  reject(new LlmError('First child preparation quota failed', 'QUOTA')); await failed;
  assert.deepEqual(streams, [{ id: 'healthy-sibling', model: 'c' }, { id: 'native-preparation', model: 'b' }]);
  assert.equal(sibling.agent.session.snapshotEvents().filter(event => event.type === 'auto-subagent/route').length, 0);
  assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'auto-subagent/route').length, 1);
});
