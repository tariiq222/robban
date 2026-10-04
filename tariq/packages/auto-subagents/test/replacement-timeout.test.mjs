import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutoModelRouter } from '../lib/router.mjs';
import { registerWorkflowRouting } from '../lib/workflow-routing.mjs';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const schema = { type: 'object', properties: {} };
const missing = { stopReason: 'completed', output: [] };
const settings = { enabled: true, allowedModels: ['A', 'B', 'C'].map(model => ({ provider: 'p', model })), modelTiers: ['A', 'B', 'C'].map(model => ({ provider: 'p', model, tier: 'strong' })) };

// Provider whose SECOND start ignores its AbortSignal and hangs until released by the test.
function fixture(options = {}) {
  const router = new AutoModelRouter({ current: () => settings }, { listProviders: () => [{ id: 'p' }], resolveCallConfig: async c => c });
  const parent = { id: 'parent', session: { header: { id: 'parent' } } }, starts = [], runs = [], providers = new Map(), warnings = [];
  const gate = deferred();
  const base = { name: 'spawn', capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false, async start(req) {
    starts.push(req);
    const hang = starts.length === 2;
    if (hang) await gate.promise; // deliberately ignores req.signal
    const d = deferred(), run = { id: `c${runs.length + 1}`, result: d.promise, done: d, disposals: 0, async dispose() { this.disposals++; d.resolve({ stopReason: 'aborted', output: [] }); } };
    runs.push(run); return run;
  } };
  providers.set('spawn', base);
  const subagents = { getProvider: n => providers.get(n), registerProvider(p) { providers.set(p.name, p); return () => providers.delete(p.name); } };
  const timers = new Map(); let next = 0;
  const routing = registerWorkflowRouting({ subagents, router, parent, warn: m => warnings.push(m),
    scheduleTimeout: fn => { const id = ++next; timers.set(id, fn); return { id }; }, cancelTimeout: h => timers.delete(h?.id), ...options });
  const start = (timeoutMs, extra = {}) => providers.get(routing.providerName).start({ parent, signal: new AbortController().signal, outputSchema: schema,
    prompt: [{ type: 'text', text: routing.markPrompt('setup', 'Work', 'setup', timeoutMs) }], ...extra });
  const fireLast = () => { const entries = [...timers.entries()]; const [id, fn] = entries.at(-1); timers.delete(id); fn(); };
  return { routing, router, start, starts, runs, warnings, gate, timers, fireLast };
}
const settle = async p => Promise.race([p.then(v => ({ v }), e => ({ e })), new Promise(r => setTimeout(() => r('HUNG'), 50))]);

test('replacement timeout fires even when the provider ignores the signal; late child is disposed', async () => {
  const f = fixture();
  const run = await f.start(20);
  f.runs[0].done.resolve(missing); await tick();
  assert.equal(f.starts.length, 2, 'replacement launch is in flight');
  assert.equal(f.router.activeCounts.get('p\u0000B') ?? [...f.router.activeCounts.values()].reduce((a, b) => a + b, 0), 1, 'replacement reservation held');
  f.fireLast(); // replacement attempt timer
  const out = await settle(run.result);
  assert.notEqual(out, 'HUNG', 'step must not hang behind a provider that ignores the signal');
  assert.equal(out.v, missing, 'original result kept when the replacement cannot start');
  assert.equal(f.warnings.length, 1);
  assert.equal(f.router.activeCounts.size, 0, 'reservation released at expiry, before late publication');
  f.gate.resolve(); await tick(); await tick();
  assert.equal(f.runs.length, 1 + 1, 'late child published');
  assert.equal(f.runs[1].disposals, 1, 'late child disposed exactly once');
  assert.equal(f.router.activeCounts.size, 0);
  assert.equal(f.timers.size, 0);
  await run.dispose(); await f.routing.dispose();
});

test('replacement launch after a timed-out attempt returns the synthetic timeout error when launch hangs', async () => {
  const f = fixture();
  const run = await f.start(20);
  f.fireLast(); await tick(); // original attempt times out -> replacement launch begins and hangs
  assert.equal(f.starts.length, 2);
  f.fireLast();
  const out = await settle(run.result);
  assert.notEqual(out, 'HUNG');
  assert.equal(out.v.stopReason, 'error');
  assert.match(out.v.output[0].text, /step timed out after 20 ms on p\/A/);
  f.gate.resolve(); await tick(); await tick();
  assert.equal(f.runs[1].disposals, 1);
  assert.equal(f.router.activeCounts.size, 0);
  await f.routing.dispose();
});

test('dispose during a signal-ignoring replacement launch waits for it and disposes the late child', async () => {
  const f = fixture();
  const run = await f.start(undefined);
  f.runs[0].done.resolve(missing); await tick();
  assert.equal(f.starts.length, 2);
  let disposed = false;
  const disposing = run.dispose().then(() => { disposed = true; }); await tick();
  assert.equal(disposed, false, 'dispose owns late-child cleanup, so it waits for the launch');
  f.gate.resolve(); await disposing; await run.result.catch(() => {});
  assert.equal(f.runs[1].disposals, 1, 'late child disposed');
  assert.equal(f.router.activeCounts.size, 0);
  await f.routing.dispose();
});
