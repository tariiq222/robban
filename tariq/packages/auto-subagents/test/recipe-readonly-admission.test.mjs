import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerWorkflowRouting } from '../lib/workflow-routing.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
// Live regression: the readOnly marker must be ACCEPTED by the real installed spawn driver and
// real scoped ToolRuntime. Earlier mocks pre-registered structured_output in the PARENT, hiding
// that the host only lets a filter name inherited tools (the child's own result tool is exempt).
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: ToolRuntime, defineTool } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));
const { default: SystemPrompt } = await import(runtimeModuleUrl('@deepseek-ai/dsh-system-prompt'));
const { createScope } = await import(runtimeModuleUrl('@deepseek-ai/dsh-scope'));
const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { snapshotSubagentDescriptor, foldSubagentDescriptor } = await import(runtimeModuleUrl('@deepseek-ai/dsh-subagent'));
const { apply: applySpawn } = await import(runtimeModuleUrl('@deepseek-ai/dsh-subagent-spawn-in-process'));
const STOP = 'probe-stop-after-setup';
const INHERITED = ['read', 'read_image', 'glob', 'grep'];

async function admitWithCallerFilter(toolFilter) { return admit({ readOnly: true, toolFilter }); }

async function admit({ readOnly, withOutputSchema = true, toolFilter }) {
  const root = new Context();
  root.plugin(SystemPrompt); root.plugin(ToolRuntime);
  await new Promise(resolve => setImmediate(resolve));
  const seen = { requests: [], setupError: undefined, visible: undefined, hidden: undefined };
  let done;
  root.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) {
    const tool = name => defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '' });
    for (const name of [...INHERITED, 'write', 'edit', 'bash', 'subagent', 'run_recipe']) ctx.tools.register(tool(name));
    const parentKey = { id: 'admission-parent' }, parentScope = createScope(ctx, parentKey);
    const parent = { options: {}, session: Session.create(parentKey.id), ctx: {
      get: name => parentScope.ctx.get(name),
      agents: { create: async spec => {
        const childKey = { id: spec.sessionId };
        const child = createScope(ctx, childKey, { parent: parentKey });
        try { spec.setup(child.ctx, { session: Session.create(spec.sessionId) }); }
        catch (error) { seen.setupError = error; throw error; }
        const names = child.ctx.tools.schemas(childKey).map(t => t.name);
        seen.visible = names;
        throw new Error(STOP);
      } },
    } };
    const providers = new Map();
    const subagents = { getProvider: name => providers.get(name), registerProvider(provider) { providers.set(provider.name, provider); return () => providers.delete(provider.name); } };
    applySpawn({ subagents }, { providerName: 'spawn' });
    const real = providers.get('spawn');
    const spy = Object.create(real);
    spy.start = request => { seen.requests.push(request); return real.start(request); };
    providers.set('spawn', spy);
    const router = { select: async () => ({ route: { provider: 'memory-only', model: 'never-called' }, tier: 'strong', requestedTier: 'strong', token: { release() {} } }), childRoute: () => undefined, childDisposed() {}, adoptChild() {}, markStructuredFailure() {} };
    const routing = registerWorkflowRouting({ subagents, router, parent, warn() {}, recipeRoles: { investigator: { tier: 'strong', readOnlyRetry: false } } });
    done = (async () => {
      try {
        const marker = '__AUTO_RECIPE_ROLE__' + JSON.stringify({ token: routing.markerToken, role: 'investigator', label: 'scope', ...(readOnly === undefined ? {} : { readOnly }) }) + '\nRead';
        await providers.get(routing.providerName).start({ parent, signal: new AbortController().signal, prompt: [{ type: 'text', text: marker }],
          ...(withOutputSchema ? { outputSchema: { type: 'object', properties: {} } } : {}),
          ...(toolFilter === undefined ? {} : { toolFilter }),
          descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: routing.providerName, label: 'scope' }) });
        seen.unexpected = true;
      } catch (error) { seen.error = error; }
      finally { await routing.dispose(); }
    })();
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(done, 'tool runtime harness initialized');
  await done;
  return seen;
}

test('readOnly child setup is accepted by the real installed ToolRuntime (no unknown structured_output)', async () => {
  const seen = await admit({ readOnly: true });
  assert.equal(seen.setupError, undefined, `setup rejected: ${seen.setupError?.message}`);
  assert.equal(seen.error?.message, STOP, 'reached child creation after setup');
});

test('readOnly filter names only inherited tools; own structured_output is never filtered', async () => {
  const seen = await admit({ readOnly: true });
  assert.deepEqual(seen.requests[0].toolFilter, { allow: INHERITED });
  assert.ok(!JSON.stringify(seen.requests[0].toolFilter).includes('structured_output'));
});

test('readOnly children see read tools plus their own result tool: no write, edit, bash, delegation or nested recipes', async () => {
  const seen = await admit({ readOnly: true });
  // The driver attaches structured_output AFTER the filter, so the child still can deliver its report.
  assert.deepEqual([...seen.visible].sort(), [...INHERITED, 'structured_output'].sort());
  for (const forbidden of ['write', 'edit', 'bash', 'subagent', 'run_recipe']) assert.ok(!seen.visible.includes(forbidden), forbidden);
});

test('persisted one-shot descriptor stays valid for the installed schema (no toolFilter field)', async () => {
  const seen = await admit({ readOnly: true });
  const descriptor = seen.requests[0].descriptor;
  assert.ok(!('toolFilter' in descriptor), 'one-shot descriptor must not carry toolFilter');
  assert.doesNotThrow(() => foldSubagentDescriptor([{ type: 'subagent/descriptor', data: descriptor }]));
});

test('readOnly without an output schema is accepted too', async () => {
  const seen = await admit({ readOnly: true, withOutputSchema: false });
  assert.equal(seen.error?.message, STOP);
});

test('unmarked children keep their full inherited tools', async () => {
  const seen = await admit({});
  assert.equal(seen.requests[0].toolFilter, undefined);
  assert.equal(seen.error?.message, STOP);
});

test('a caller allow that excludes every read tool still yields a valid (empty) narrowing', async () => {
  const root = await admitWithCallerFilter({ allow: ['bash'] });
  assert.deepEqual(root.requests[0].toolFilter, { allow: [] });
});
