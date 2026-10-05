/** Keyless native Session recordings of preparation prompts emitted by saved recipes through PTC. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runtimeModuleUrl, RECIPES_DIR } from '../lib/dsh-paths.mjs';
import { createPtcFixture } from './helpers/ptc-runtime.mjs';
const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
const { default: Llm, LlmAdapter, createUserMessage } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
const { Session } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session'));
const { validateStoredEvents } = await import(runtimeModuleUrl('@deepseek-ai/dsh-session-persistence'));
const { defineContentToolFixture } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));
const services = await Promise.all(['session','session-projection','system-prompt','tools','agent','agent-loop'].map(async name => (await import(runtimeModuleUrl(`@deepseek-ai/dsh-${name}`))).default));
const scope = { files: ['src.js','test.js'], tests: ['test.js'], symbols: ['sum'], dependents: [] };
const setup = { stack: 'JavaScript', verifyCommands: ['node --test test.js'], conventions: ['Preserve callers'] };
const bugDiagnosis = { setup, analysis: { scope, outcome: 'reproducible', reason: 'src.js:1 subtracts instead of adding; no runtime reproduction claimed', currentState: 'sum subtracts', expectedBehavior: 'sum adds', acceptance: ['Regression demonstrates correct addition'], decisions: [] } };
const refactorDiagnosis = { verifyCommands: setup.verifyCommands, files: scope.files, tests: scope.tests, invariants: ['Addition result remains unchanged'], acceptance: ['Extract named arithmetic helper'], clear: true, questions: [], evidence: 'src.js:1 and test.js:1 inspected; package.json:1 defines verification' };
const featureSetup = { stack: 'JavaScript', testCommands: setup.verifyCommands, lintCommands: [], conventions: setup.conventions };
const featureAnalysis = { scope, currentState: 'src.js:1 only adds', gaps: ['Need requested optional behavior'], outcome: 'proceed', outcomeReason: 'Small scoped extension', decisions: [], compactSpec: { files: scope.files, impact: 'local', acceptance: ['Requested optional behavior covered'], verifyCommands: setup.verifyCommands, plan: 'Update src.js; extend test.js; run existing local test' } };
const investigateScope = { files: ['src.js'], summary: 'Source arithmetic only', complete: true, limitations: [] };
const investigateGather = { hypotheses: [{ id: 'local', cause: 'Wrong operator', file: 'src.js', line: 1, evidence: 'src.js:1 subtracts', confidence: 0.8 }], coverage: ['src.js'], complete: true, limitations: [] };
const investigateCheck = { resolutions: [{ id: 'H1', status: 'confirmed', reason: 'Operator source evidence supports explanation; runtime remains unverified', evidence: 'src.js:1 subtracts', confidence: 0.8 }], coverage: ['src.js'], complete: true, limitations: [], next_actions: ['Use bug-fix to obtain runtime regression before repair'] };
const planEvidence = { goals: [{ id: 'inspect-cause', description: 'Inspect arithmetic source cause' }], files: ['src.js'], commands: [], complete: true, questions: [] };
const planPackages = { packages: [{ id: 'source-investigation', title: 'Inspect cause', description: 'Read arithmetic source', writePaths: [], acceptance: ['Source proposition checked'], verifyCommands: [], dependencies: [], goalIds: ['inspect-cause'], recipe: 'investigate', serializationReason: '', evidence: 'src.js:1 inspected' }], complete: true, questions: [] };
// Later stages are scripted to reach validation; these receipts are not executed commands.
const featureImplementation = { changedPaths: ['src.js'], commands: [{ command: setup.verifyCommands[0], passed: true, evidence: 'Scripted traversal receipt; fixture does not execute this command' }], notes: 'Scripted stage only; no edit performed', decisions: [] };
const featureReview = { verdict: 'APPROVED', summary: 'Scripted traversal review only', findings: [] };
const featureValidation = { results: [{ criterion: featureAnalysis.compactSpec.acceptance[0], status: 'passed', evidence: 'Scripted output verifies transcript plumbing only' }], commands: [{ command: setup.verifyCommands[0], exitCode: 0, evidence: 'Scripted receipt; no verification command executed by this fixture' }], summary: 'Fixture transcript, not runtime feature proof' };
const scenarios = [
  { name: 'bug-fix', stage: 'analysis', outputs: { analysis: bugDiagnosis }, pattern: /No bash\/command execution or edits/ },
  { name: 'refactor', stage: 'analysis', outputs: { analysis: refactorDiagnosis }, pattern: /No commands or edits/ },
  { name: 'feature-pipeline', stage: 'analysis', outputs: { setup: featureSetup, analysis: featureAnalysis }, pattern: /compactSpec: ONLY/ },
  { name: 'investigate', stage: 'check', outputs: { scope: investigateScope, gather: investigateGather, check: investigateCheck }, pattern: /never establishes the cause of an observed runtime incident/ },
  { name: 'plan-to-packages', stage: 'packages', outputs: { evidence: planEvidence, packages: planPackages }, pattern: /disjoint writePaths prove only write conflicts/ },
  { name: 'feature-pipeline', stage: 'validate', fixture: 'feature-validation', outputs: { setup: featureSetup, analysis: featureAnalysis, implement: featureImplementation, 'review-a': featureReview, 'review-b': featureReview, validate: featureValidation }, pattern: /Run every planned verify command NOW/ },
];
const messages = session => session.deriveMessages().map(({ role, content }) => ({ role, content }));
function parameter(schema, required = false) {
  const { required: requiredFields, properties, items, ...rest } = schema;
  return { ...rest, ...(required ? { required: true } : {}),
    ...(properties ? { properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, parameter(value, requiredFields?.includes(key))])) } : {}),
    ...(items ? { items: parameter(items) } : {}) };
}

async function recordNative(request, result, sourceDir, id) {
  const ctx = new Context();
  const requests = [];
  let step = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(request) {
      requests.push(request.messages.map(({ role, content }) => ({ role, content })));
      if (++step <= 2) {
        const call = step === 1 ? { name: 'read', args: { path: 'src.js' } } : { name: 'structured_output', args: { result } };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `${id}-call-${step}`, name: call.name, arguments: JSON.stringify(call.args) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Preparation complete; repository unchanged.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Preparation complete; repository unchanged.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  try {
    await ctx.plugin(Llm);
    for (const service of services) await ctx.plugin(service, service === services.at(-1) ? { agents: [] } : undefined);
    ctx.llm.registerAdapter(['fixture'], new Adapter());
    ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'Read fixed fixture source only', parameters: { path: { type: 'string', required: true } }, async execute(args) {
      assert.equal(args.path, 'src.js');
      return [{ type: 'text', text: await readFile(path.join(sourceDir, 'src.js'), 'utf8') }];
    } }));
    ctx.tools.register(defineContentToolFixture({ name: 'structured_output', description: 'Return preparation fields', parameters: { result: parameter(request.outputSchema, true) }, async execute(args) {
      assert.deepEqual(args.result, result);
      return [{ type: 'text', text: JSON.stringify(args.result) }];
    } }));
    const handle = await ctx.agentLoop.createAgent(ctx, { sessionId: id, agentOptions: { provider: 'fixture', model: 'keyless' } });
    handle.agent.followup(createUserMessage({ content: request.prompt, source: { kind: 'user' } }));
    await handle.agent.whenIdle();
    const session = handle.agent.session;
    assert.equal(requests.length, 3);
    const events = session.snapshotEvents();
    assert.equal(events.at(-1).data.reason.kind, 'completed');
    return { header: session.header, events, requests };
  } finally { await ctx.fiber.dispose(); }
}

for (const scenario of scenarios) test(`recorded ${scenario.name} ${scenario.stage} prompt survives native Session replay`, { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recipe-preparation-session-'));
  let runtime, recorded, failure;
  const labels = [];
  try {
    await writeFile(path.join(root, 'src.js'), 'export const sum = (a, b) => a - b;\n');
    await writeFile(path.join(root, 'test.js'), '/* Regression intentionally not executed during source-only preparation. */\n');
    const provider = { capabilities: { outputSchema: true }, async start(request) {
      try {
      const prompt = request.prompt.map(block => block.text ?? '').join('\n');
      const marker = /^__AUTO_RECIPE_ROLE__([^\n]+)\n/.exec(prompt);
      assert.ok(marker, 'actual engine preserves authenticated fixture routing marker');
      const routing = JSON.parse(marker[1]);
      const label = routing.label.replace(/ #\d+$/, '');
      labels.push(label);
      const output = scenario.outputs[label];
      if (!output) throw new Error('Fixture stops at unscripted stage ' + label);
      if (label === scenario.stage) {
        assert.match(prompt, scenario.pattern);
        if (scenario.stage !== 'validate') assert.equal(routing.readOnly, true, 'preparation stages use read-only routing');
        recorded = await recordNative(request, output, root, `preparation-${scenario.fixture ?? scenario.name}`);
      }
      return { id: `fixture-${labels.length}`, result: Promise.resolve({ stopReason: 'completed', output: [], structured: output }), async dispose() {} };
      } catch (error) { failure = error; throw error; }
    } };
    runtime = await createPtcFixture({ cwd: root, provider });
    const script = await readFile(path.join(RECIPES_DIR, scenario.name, 'script.js'), 'utf8');
    const meta = JSON.parse(await readFile(path.join(RECIPES_DIR, scenario.name, 'meta.json'), 'utf8'));
    const run = runtime.engine.start({ script, meta: { name: meta.name, description: meta.description, phases: meta.phases }, args: { task: 'Inspect the requested scoped arithmetic change', repo: '/fixture/repository', routingToken: 'fixture-routing-token', earlyValidate: false }, parent: runtime.createParent(), signal: new AbortController().signal });
    await run.result;
    assert.ok(recorded, 'actual saved recipe reached selected preparation stage: ' + (failure?.stack ?? labels.join(',')));
    if (scenario.name === 'feature-pipeline') assert.ok(!labels.includes('quick-spec'), 'compactSpec eliminates quick-spec child');
    const file = new URL(`./fixtures/recipe-preparation-${scenario.fixture ?? scenario.name}.session.json`, import.meta.url);
    if (process.env.RECORD_RECIPE_PREPARATION === '1') await writeFile(file, JSON.stringify(recorded, null, 2) + '\n');
    const fixture = JSON.parse(await readFile(file, 'utf8'));
    validateStoredEvents(fixture.header, fixture.events);
    const restore = value => Session.fromRestore(value.header.id, value.events, value.header, 0, 'detached');
    assert.deepEqual(recorded.requests, fixture.requests, 'model request transcript matches recorded preparation');
    assert.deepEqual(recorded.events.filter(event => event.type === 'request/header').map(event => event.data.header),
      fixture.events.filter(event => event.type === 'request/header').map(event => event.data.header), 'model-visible structured-output schemas match recording');
    assert.deepEqual(messages(restore(recorded)), messages(restore(fixture)), 'native projection preserves generated prompt, real source read and structured reply');
    const calls = fixture.events.filter(event => event.type === 'tool/call');
    assert.deepEqual(calls.map(event => event.data.name), ['read', 'structured_output']);
    assert.equal(await readFile(path.join(root, 'src.js'), 'utf8'), 'export const sum = (a, b) => a - b;\n');
  } finally { try { await runtime?.dispose(); } finally { await rm(root, { recursive: true, force: true }); } }
});
