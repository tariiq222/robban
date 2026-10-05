/** Executed inside the captured upstream archive; never against root build artifacts. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
const root = path.dirname(fileURLToPath(import.meta.url));
const sourceResolutions = new Set();
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (specifier.startsWith('@deepseek-ai/')) {
    const file = fileURLToPath(result.url);
    assert.ok(file.startsWith(root + path.sep) && (file.includes('/src/') || file.endsWith('/package.json')), `every workspace import must resolve to pristine archive source: ${specifier} -> ${file}`);
    sourceResolutions.add(specifier);
  }
  return result;
} });
const proof = JSON.parse(await readFile(path.join(root, 'upstream-proof.json'), 'utf8'));
for (const [file, expected] of Object.entries(proof.sourceHashes)) {
  const bytes = await readFile(path.join(root, file));
  assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), expected, `unchanged upstream source: ${file}`);
}
const modules = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-session-persistence'];
for (const name of modules) {
  const resolved = fileURLToPath(import.meta.resolve(name));
  assert.ok(resolved.startsWith(root + path.sep) && resolved.includes('/src/'), `${name} must load archive source: ${resolved}`);
}
const { Context } = await import('@deepseek-ai/cordis');
const { default: Sessions, Session } = await import('@deepseek-ai/dsh-session');
const { validateStoredEvents } = await import('@deepseek-ai/dsh-session-persistence');
const { assertAutoSessionSupport } = await import('./tariq/packages/auto-subagents/lib/compatibility.mjs');
assert.throws(() => assertAutoSessionSupport(Session), /cannot safely restore Auto events/);
const Host = await import('dsh-auto-subagents');
const ctx = new Context();
try {
  await ctx.plugin(Sessions);
  await assert.rejects(async () => { await ctx.plugin(Host); }, /cannot safely restore Auto events/);
  const session = ctx.sessions.create('upstream-ignorable-probe', { meta: { isSeeded: false } });
  const unsupported = session.append('auto-recipe/run-start', { runId: 'probe' }, { ignorable: true });
  assert.equal(unsupported.ignorable, undefined, 'upstream append ignores the extra option');
  assert.throws(() => validateStoredEvents(session.header, structuredClone(session.snapshotEvents())), /unknown|Unknown|unsupported|Unsupported/);
  const event = { type: 'auto-recipe/run-start', seq: 0, time: 0, data: { runId: 'probe' }, ignorable: true };
  validateStoredEvents(session.header, [event]);
  const replay = Session.fromRestore(session.id, [event], session.header, 0, 'detached');
  assert.deepEqual(replay.snapshotEvents()[0], event);
  validateStoredEvents(replay.header, structuredClone(replay.snapshotEvents()));
  assert.deepEqual(replay.deriveMessages(), []);
} finally { await ctx.fiber.dispose(); }
const { default: AutoLlmRuntime } = await import('dsh-auto-subagents/llm-provider');
const Routing = await import('dsh-auto-subagents/runtime');
const { LlmAdapter, LlmError, createUserMessage } = await import('@deepseek-ai/dsh-llm');
const services = await Promise.all(['session','session-projection','system-prompt','tools','agent','agent-loop'].map(async name => (await import(`@deepseek-ai/dsh-${name}`)).default));
const preparation = [];
for (const scenario of ['managed', 'unmanaged', 'exhausted', 'nonavailability', 'missing-adapter', 'unmanaged-middleware']) {
  const native = new Context(), prepared = [], streamed = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: model === 'a' ? 111 : 222 }; }
    async prepareCall(provider, model, signal) {
      prepared.push(model);
      signal.throwIfAborted();
      if (scenario === 'exhausted' || scenario === 'missing-adapter' || model === 'a') {
        throw new LlmError('Keyless adapter failed only during native preparation', scenario === 'nonavailability' ? 'INVALID_REQUEST' : scenario === 'missing-adapter' || scenario === 'unmanaged-middleware' ? 'NO_ADAPTER' : 'QUOTA');
      }
      return super.prepareCall(provider, model, signal);
    }
    async *stream(request) {
      streamed.push(request);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Prepared once without replay.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Prepared once without replay.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  try {
    await native.plugin(AutoLlmRuntime);
    for (const service of services) await native.plugin(service, service === services.at(-1) ? { agents: [] } : undefined);
    native.llm.registerAdapter(['one','two'], new Adapter());
    native.provide('subagentModelSelection', { current: () => ({ enabled: true, allowedModels: [{ provider: 'one', model: 'a' }, { provider: 'two', model: 'b' }] }) });
    native.provide('agentPresets', { composedPreset: () => 'auto-subagents' });
    // This probes preparation alone. Full Auto host was rejected above on stock Session.
    await native.plugin(Routing);
    let middlewareDispatches = 0;
    if (scenario === 'unmanaged-middleware') native.on('llm/stream', async function* () {
      middlewareDispatches++;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Unmanaged native middleware response.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Unmanaged native middleware response.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const handle = await native.agentLoop.createAgent(native, { sessionId: `pristine-${scenario}`, ...(['unmanaged','unmanaged-middleware'].includes(scenario) ? {} : { meta: { origin: 'subagent' } }), agentOptions: { provider: 'one', model: 'a', maxTokens: 777 } });
    const message = createUserMessage({ content: [{ type: 'text', text: 'Admit this task exactly once' }], source: { kind: 'user' } });
    handle.agent.followup(message);
    await handle.agent.whenIdle();
    const events = handle.agent.session.snapshotEvents();
    if (scenario === 'managed') {
      assert.deepEqual(prepared, ['a','b']);
      assert.deepEqual(streamed.map(request => [request.provider, request.model]), [['two','b']]);
      assert.equal(streamed[0].maxTokens, 777);
      assert.equal(handle.agent.session.requestHeader().config.provider, 'two');
      assert.equal(handle.agent.session.requestHeader().config.model, 'b');
      assert.equal(events.filter(event => event.type === 'request/header').length, 1);
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === message.id).length, 1);
      assert.equal(events.filter(event => event.type === 'assistant/attempt' || event.type === 'tool/call' || event.type === 'tool/result').length, 0);
      assert.equal(events.at(-1).data.reason.kind, 'completed');
      assert.throws(() => validateStoredEvents(handle.agent.session.header, structuredClone(events)), /unknown|Unknown/);
    } else if (scenario === 'unmanaged-middleware') {
      assert.deepEqual(prepared, ['a']);
      assert.equal(streamed.length, 0);
      assert.equal(middlewareDispatches, 1);
      assert.equal(handle.agent.session.requestHeader().config.model, 'a');
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === message.id).length, 1);
      assert.equal(events.filter(event => event.type.startsWith('auto-subagent/')).length, 0);
      assert.equal(events.at(-1).data.reason.kind, 'completed');
      validateStoredEvents(handle.agent.session.header, structuredClone(events));
      const restored = Session.fromRestore(handle.agent.session.id, events, handle.agent.session.header, 0, 'detached');
      assert.equal(restored.requestHeader().config.model, 'a');
      assert.equal(restored.deriveMessages().filter(message => message.role === 'user').length, 1);
    } else {
      assert.deepEqual(prepared, scenario === 'exhausted' || scenario === 'missing-adapter' ? ['a','b'] : ['a']);
      assert.equal(streamed.length, 0);
      assert.equal(events.filter(event => event.type === 'request/header' || event.type === 'user/message').length, 0);
      assert.notEqual(events.at(-1).data.reason.kind, 'completed');
      if (scenario === 'unmanaged' || scenario === 'nonavailability') validateStoredEvents(handle.agent.session.header, structuredClone(events));
    }
    preparation.push({ scenario, prepared, middlewareDispatches, streamed: streamed.map(request => ({ provider: request.provider, model: request.model })) });
  } finally { await native.fiber.dispose(); }
}
console.log(JSON.stringify({ reference: proof.reference, revision: proof.revision, pristineSource: true, sourceModules: modules.length, resolvedWorkspaceModules: [...sourceResolutions].sort(), nativeRestore: true, stockSessionSupported: false, fullAutoHostRejected: true, preparation }));
