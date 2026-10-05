/** Auto routing with the native retry listener and durable compaction engine. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
import { AutoLlmRuntime } from '../lib/llm-provider.mjs';
import { apply } from '../lib/runtime.mjs';

const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { LlmAdapter, createUserMessage, createMessage, resolveRetryPolicy } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
const { default: Sessions, Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { default: Projections } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session-projection'));
const { default: TokenMeter } = await import(runtimeModuleUrl('@deepseek-ai/dsh-token-meter'));
const { default: BasicCompaction } = await import(runtimeModuleUrl('@deepseek-ai/dsh-compaction-basic'));
const { apply: applyRetry } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm-retry'));
const { validateStoredEvents } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session-persistence'));
const route = { provider: 'fixture', model: 'keyless' };
const overflow = 'CONTEXT_WINDOW_EXCEEDED';

async function fixture(t, { turns = 3, retryPolicy } = {}) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  new AutoLlmRuntime(ctx); new Projections(ctx); new Sessions(ctx); new TokenMeter(ctx);
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 10000 } }; }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new Adapter()));
  // Only the summary's model output is scripted; replacement and retry accounting stay native.
  class Summary extends BasicCompaction {
    async summarize() { return { summary: [{ type: 'text', text: 'Recorded task checkpoint.' }], ...route, maxTokens: 128 }; }
  }
  applyRetry(ctx);
  new Summary(ctx, { headroomTokens: 0, maxTokens: 128, maxOverflowRetries: 1 });
  ctx.provide('subagentModelSelection', { current: () => ({ enabled: true, allowedModels: [route] }) });
  ctx.provide('agentPresets', { composedPreset: () => 'auto-subagents' });
  apply(ctx);
  const session = ctx.sessions.create(undefined, { meta: { origin: 'subagent' } });
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn });
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Prior task evidence '.repeat(100) }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    session.append('step/start', { turn, step: 1 });
    if (turn === 1) session.append('request/header', { header: { config: route }, reason: 'initial' });
    session.append('assistant/message', { stream: [], turn, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'Observed task result '.repeat(100) }], source: { kind: 'model', ...route } }) }, { surfaceOp: 'append' });
    session.append('step/end', { turn, step: 1 });
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  session.append('turn/start', { turn: turns + 1 });
  if (turns === 0) session.append('request/header', { header: { config: route }, reason: 'initial' });
  const agent = { id: session.id, ctx, options: route, session };
  ctx.emit('agent/created', { agent, source: 'startup' });
  const fail = (code = overflow, signal = new AbortController().signal) => ctx.waterfall('agent/request-error', { agent, turn: turns + 1, step: 1, provider: route.provider, failure: { code, message: 'Scripted request failure' }, retryPolicy, signal }, async () => undefined);
  return { ctx, session, agent, fail };
}

for (const mode of ['absent', 'normal']) {
  test(`Auto permits native bounded overflow compaction with ${mode} retry policy`, async t => {
    const retryPolicy = mode === 'normal' ? resolveRetryPolicy({ mode: 'normal' }) : undefined;
    if (retryPolicy) assert.equal(retryPolicy.retryableCodes.includes(overflow), false);
    const h = await fixture(t, { retryPolicy });
    const before = h.session.surface.replaceGeneration;
    assert.deepEqual(await h.fail(), { kind: 'retry' });
    assert.equal(h.session.surface.replaceGeneration, before + 1);
    assert.equal(await h.fail(), undefined);
    assert.equal(h.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 1);
    assert.equal(h.session.snapshotEvents().some(event => ['llm/retry', 'auto-subagent/route'].includes(event.type)), false);
    if (mode === 'normal') {
      const file = new URL('./fixtures/auto-overflow-compaction.session.json', import.meta.url);
      if (process.env.RECORD_AUTO_OVERFLOW_SESSION === 'bounded') await writeFile(file, JSON.stringify({ header: h.session.header, events: h.session.snapshotEvents() }, null, 2) + '\n');
      const recorded = JSON.parse(await readFile(file, 'utf8'));
      validateStoredEvents(recorded.header, recorded.events);
      const restored = Session.fromRestore(recorded.header.id, recorded.events, recorded.header, 0, 'detached');
      assert.equal(recorded.events.filter(event => event.type === 'compaction/summary').length, 1);
      assert.deepEqual(restored.deriveMessages().map(message => ({ role: message.role, content: message.content })), h.session.deriveMessages().map(message => ({ role: message.role, content: message.content })));
    }
  });
}

for (const retryPolicy of [resolveRetryPolicy({ mode: 'always' }), resolveRetryPolicy({ mode: 'normal', retryableCodes: [overflow] })]) {
  test(`Auto stops overflow before an ${retryPolicy.mode} policy that permits generic overflow retries`, async t => {
    const h = await fixture(t, { retryPolicy });
    assert.equal(await h.fail(), undefined);
    assert.equal(h.session.snapshotEvents().some(event => ['compaction/start', 'llm/retry', 'auto-subagent/route'].includes(event.type)), false);
  });
}

test('Auto overflow without durable compaction progress declines retry', async t => {
  const h = await fixture(t, { turns: 0 });
  assert.equal(await h.fail(), undefined);
  assert.equal(h.session.surface.replaceGeneration, 0);
  assert.equal(h.session.snapshotEvents().some(event => event.type === 'llm/retry'), false);
});

test('Auto cancellation and exhausted availability routes bypass native generic retry', async t => {
  const h = await fixture(t, { retryPolicy: resolveRetryPolicy({ mode: 'normal' }) });
  assert.equal(await h.fail(overflow, AbortSignal.abort()), undefined);
  assert.equal(await h.fail('RATE_LIMIT'), undefined);
  assert.equal(h.session.snapshotEvents().some(event => ['compaction/start', 'llm/retry'].includes(event.type)), false);
});
