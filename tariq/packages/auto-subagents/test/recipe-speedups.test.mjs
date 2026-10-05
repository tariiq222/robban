import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { apply } from '../lib/recipes.mjs';
import path from 'node:path';
import vm from 'node:vm';
import { RECIPES_DIR } from '../lib/dsh-paths.mjs';

// Real recipe, bounded VM and fake hooks only: never executes child prompts or writes .runs.
const source = await readFile(path.join(RECIPES_DIR, 'feature-pipeline', 'script.js'), 'utf8');
const acceptance = ['Criterion one', 'Criterion two'];
const compactSpec = files => ({ files, impact: 'local', acceptance, verifyCommands: ['node --test'], plan: 'Change only scoped files' });
const commandReceipts = [{ command: 'node --test', exitCode: 0, evidence: 'Executed node tests: all tests passed' }];
const setup = { stack: 'JS', testCommands: ['node --test'], lintCommands: [], conventions: [] };
const approved = { verdict: 'APPROVED', summary: 'ok', findings: [] };
const problem = { id: 'old', severity: 'high', problem: 'Old problem', requiredFix: 'Fix old problem' };
const decision = { id: 'choice', kind: 'needs_user', question: 'Choice?', current: 'now', options: [], recommendation: 'yes', why: 'why' };
async function run(overrides = {}, extra = {}) {
  const calls = [], logs = [], batches = [];
  const defaults = {
    setup,
    analysis: { scope: { files: ['one.js'], symbols: [], dependents: [], tests: [] }, compactSpec: compactSpec(['one.js']), currentState: 'current', gaps: [], outcome: 'proceed', outcomeReason: '', decisions: [] },
    'quick-spec': { acceptance, verifyCommands: ['node --test'], plan: 'Change one.js' },
    requirements: { goal: 'Goal', acceptance, nonGoals: [], decisions: [] },
    'design-draft': 'Design', 'design-review': { ...approved, decisions: [] },
    plan: { steps: [], inScope: ['one.js'], verifyCommands: ['node --test'] },
    implement: { changedPaths: ['one.js'], commands: [], notes: '', decisions: [] },
    'review-a': approved, 'review-b': approved, aggregate: approved,
    validate: { commands: commandReceipts, results: acceptance.map(criterion => ({ criterion, status: 'passed', evidence: 'Checked' })), summary: 'Validated' },
  };
  const context = vm.createContext({ args: { task: 'Change', repo: '/fake', maxCodeIterations: 2, ...extra },
    agent: async (prompt, opts) => {
      assert.ok(calls.length < 40);
      calls.push({ prompt, ...opts });
      const key = opts.label.replace(/ #\d+$/, '');
      assert.ok(Object.hasOwn(defaults, key), key);
      const value = Object.hasOwn(overrides, key) ? overrides[key] : defaults[key];
      return structuredClone(typeof value === 'function' ? await value(opts, prompt) : value);
    }, parallel: async hooks => {
      const before = calls.length;
      const result = await Promise.all(hooks.map(h => Promise.resolve().then(h).catch(() => null)));
      batches.push(calls.slice(before).map(c => c.label));
      return result;
    }, phase() {}, log: line => logs.push(line),
  });
  const result = await new vm.Script(`(async () => {${source}\n})()`).runInContext(context, { timeout: 1000 });
  return { result: JSON.parse(JSON.stringify(result)), calls, logs, batches };
}
const speedups = { fastPath: true, useAggregator: false, earlyValidate: true };

test('run_recipe cache plumbing stays isolated and forwards timeout config', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'recipe-cache-plumbing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), runsDir = path.join(root, '.runs'), setupCacheDir = path.join(root, 'cache');
  await mkdir(repo); await writeFile(path.join(repo, 'package.json'), '{}');
  let tool; const engineArgs = [];
  const provider = { capabilities: { agentOptions: true }, inheritsParentContext: false, start() {} };
  const ctx = {
    tools: { register: value => { tool = value; } }, on: () => () => {}, emit() {},
    subagents: { getProvider: () => provider, registerProvider: () => () => {} },
    subagentModelSelection: { current: () => ({ enabled: true, allowedModels: [], modelTiers: [] }) },
    llm: {}, workflowEngine: { start(request) {
      engineArgs.push(request.args);
      return { id: 'fake-run', result: Promise.resolve({ stopReason: 'completed', agentsStarted: 0, value: { status: 'completed', setup } }), dispose: async () => {}, cancel() {} };
    } },
  };
  apply(ctx, { runsDir, setupCacheDir });
  const exec = { agent: { session: { id: 'fake', header: { cwd: repo }, append() {}, snapshotEvents: () => [] } }, signal: new AbortController().signal };
  const request = { recipe: 'feature-pipeline', task: 'Change', repo, stepTimeoutMs: { setup: 123 } };
  await tool.execute(request, exec);
  await tool.execute(request, exec);
  assert.equal(engineArgs[0].cachedSetup, undefined);
  assert.deepEqual(engineArgs[1].cachedSetup, setup);
  assert.deepEqual(engineArgs[1].stepTimeoutMs, { setup: 123 });
  await writeFile(path.join(repo, 'package.json'), '{"changed":true}');
  await tool.execute(request, exec);
  assert.equal(engineArgs[2].cachedSetup, undefined);
});

test('production defaults take one-file fast path, merge without agent and validate early', async () => {
  const { result, calls, batches, logs } = await run();
  assert.equal(result.status, 'completed');
  assert.equal(result.fastPath, true);
  assert.equal(result.designReview, 'skipped (fast path)');
  assert.equal(calls.filter(c => c.label === 'quick-spec').length, 0);
  assert.ok(!calls.some(c => /requirements|design|plan|aggregate/.test(c.label)));
  assert.ok(batches[0].includes('validate'));
  assert.ok(logs.some(l => /fast path/.test(l)));
});
test('fast path can be disabled and does not run for three files', async () => {
  for (const extra of [{ ...speedups, fastPath: false }, speedups]) {
    const overrides = extra.fastPath ? { analysis: { scope: { files: ['1', '2', '3'], symbols: [], dependents: [], tests: [] }, currentState: '', gaps: [], outcome: 'proceed', outcomeReason: '', decisions: [] } } : {};
    const { result, calls } = await run(overrides, extra);
    assert.equal(result.fastPath, false);
    assert.ok(calls.some(c => c.label === 'requirements'));
    assert.ok(!calls.some(c => c.label === 'quick-spec'));
  }
});
test('two files qualify while persisted pending decisions stop before quick-spec', async () => {
  const analysis = { scope: { files: ['one.js', 'two.js'], symbols: [], dependents: [], tests: [] }, compactSpec: compactSpec(['one.js', 'two.js']), currentState: '', gaps: [], outcome: 'proceed', outcomeReason: '', decisions: [] };
  const two = await run({ analysis }, speedups);
  assert.equal(two.result.fastPath, true);
  const pending = await run({}, { ...speedups, resume: { task: 'Change', repo: '/fake', round: 2, setup, analysis, decisionLedger: [{ ...decision, kind: 'high_risk', stage: 'design', requiresAnswer: true }] } });
  assert.equal(pending.result.status, 'needs_decision');
  assert.equal(pending.calls.length, 0);
});

for (const [name, files, eligible] of [
  ['zero files', [], false],
  ['directory entry', ['src/'], false],
  ['glob entry', ['src/*.js'], false],
  ['two concrete files', ['one.js', 'two.js'], true],
]) test(`fast path eligibility: ${name}`, async () => {
  const analysis = { scope: { files, symbols: [], dependents: [], tests: [] }, compactSpec: compactSpec(files), currentState: '', gaps: [], outcome: 'proceed', outcomeReason: '', decisions: [] };
  const { result, calls, logs } = await run({ analysis }, speedups);
  assert.equal(result.status, 'completed');
  assert.equal(result.fastPath, eligible);
  assert.equal(calls.some(c => c.label === 'quick-spec'), false);
  assert.equal(calls.some(c => c.label === 'requirements'), !eligible);
  if (!eligible) assert.ok(logs.some(l => /fast path ineligible:/.test(l)), 'full path explains the invalid scope');
});

for (const missingSecond of [false, true]) test(`validation belongs to approved iteration: ${missingSecond ? 'missing early result runs fresh' : 'distinct second result'}`, async () => {
  let validations = 0;
  const validation = summary => ({ commands: commandReceipts, results: acceptance.map(criterion => ({ criterion, status: 'passed', evidence: summary })), summary });
  const { result, calls, logs } = await run({
    'review-a': opts => opts.label.endsWith('#1') ? { ...approved, verdict: 'NEEDS_REVISION', findings: [problem] } : approved,
    validate: () => {
      validations++;
      if (validations === 1) return validation('REJECTED iteration 1 validation');
      if (validations === 2) return missingSecond ? null : validation('APPROVED iteration 2 validation');
      return validation('FRESH approved validation');
    },
  }, speedups);
  assert.equal(result.status, 'completed');
  assert.equal(result.iterations.code, 2);
  assert.equal(result.validationSummary, missingSecond ? 'FRESH approved validation' : 'APPROVED iteration 2 validation');
  assert.equal(calls.filter(c => c.label === 'validate').length, missingSecond ? 3 : 2);
  assert.ok(logs.includes('early validation discarded'));
});

test('unapproved early validation is never stored even when continuation is allowed', async () => {
  let validations = 0;
  const { result } = await run({
    'review-a': { ...approved, verdict: 'NEEDS_REVISION', findings: [problem] },
    validate: () => ({ commands: commandReceipts, results: acceptance.map(criterion => ({ criterion, status: 'passed', evidence: 'Checked' })), summary: ++validations === 1 ? 'REJECTED early result' : 'FRESH unapproved result' }),
  }, { ...speedups, maxCodeIterations: 1, abortIfUnapproved: false });
  assert.equal(result.status, 'completed_with_failures');
  assert.equal(result.validationSummary, 'FRESH unapproved result');
  assert.equal(validations, 2, 'rejected early validation cannot satisfy the final validate stage');
});

test('fast path optional aggregate cannot erase rejecting reviewer evidence', async () => {
  const { result, calls } = await run({ 'review-a': { ...approved, verdict: 'NEEDS_REVISION', findings: [problem] } }, { ...speedups, useAggregator: true, maxCodeIterations: 1 });
  assert.equal(result.status, 'aborted');
  assert.ok(calls.some(c => c.label === 'aggregate #1'));
  assert.ok(result.reviewTrail.find(t => t.step === 'aggregate #1').findings.some(f => f.includes(problem.problem)));
});

test('needs_user decision blocks fast path even after answer on resume', async () => {
  const resumed = { task: 'Change', repo: '/fake', round: 1, setup, analysis: { scope: { files: ['1'], symbols: [], dependents: [], tests: [] }, currentState: '', gaps: [], outcome: 'proceed', outcomeReason: '', decisions: [decision] } };
  const first = await run({}, { ...speedups, resume: resumed });
  assert.equal(first.result.status, 'needs_decision');
  const answered = await run({}, { ...speedups, resume: resumed, decisions: { choice: 'yes' } });
  assert.equal(answered.result.fastPath, false);
  assert.ok(!answered.calls.some(c => c.label === 'quick-spec'));
});
test('cached setup skips setup agent and invalid cached shape does not', async () => {
  const cached = await run({}, { ...speedups, cachedSetup: setup });
  assert.ok(!cached.calls.some(c => c.label === 'setup'));
  assert.ok(cached.logs.includes('setup reused from cache'));
  assert.deepEqual(cached.result.setup, setup);
  const invalid = await run({}, { ...speedups, cachedSetup: { stack: 'JS' } });
  assert.ok(invalid.calls.some(c => c.label === 'setup'));
});
test('unanimous approval skips aggregate and validates once in parallel', async () => {
  const { result, calls, batches } = await run({}, speedups);
  assert.equal(result.status, 'completed');
  assert.equal(calls.filter(c => c.label === 'validate').length, 1);
  assert.ok(batches[0].includes('validate'));
  assert.ok(!calls.some(c => c.label.startsWith('aggregate')));
  assert.equal(result.reviewTrail.find(t => t.step === 'aggregate #1').verdict, 'APPROVED');
});
test('rejection merges without aggregate, discards early validation and repairs with delta prompt', async () => {
  const { result, calls, logs } = await run({ 'review-a': opts => opts.label.endsWith('#1') ? { ...approved, verdict: 'NEEDS_REVISION', findings: [problem] } : approved }, speedups);
  assert.equal(result.status, 'completed');
  assert.ok(!calls.some(c => c.label.startsWith('aggregate')));
  assert.equal(calls.filter(c => c.label === 'validate').length, 2);
  assert.ok(logs.includes('early validation discarded'));
  const prompt = calls.find(c => c.label === 'review-a #2').prompt;
  assert.ok(prompt.includes('Review the changes since the previous iteration (git diff of the changed paths)'));
  assert.ok(prompt.includes(problem.problem) && prompt.includes(problem.requiredFix));
});
test('earlyValidate false runs validation only after review', async () => {
  const { calls, batches } = await run({}, { ...speedups, earlyValidate: false });
  assert.equal(calls.at(-1).label, 'validate');
  assert.ok(batches.every(b => !b.includes('validate')));
});
for (const review of [null, { ...approved, verdict: 'NEEDS_REVISION' }, { ...approved, findings: [problem] }]) {
  test(`fast path still fails closed for unsafe review ${JSON.stringify(review)}`, async () => {
    const { result, calls } = await run({ 'review-a': review }, { ...speedups, maxCodeIterations: 1 });
    assert.equal(result.status, 'aborted');
    assert.ok(!calls.some(c => c.label.startsWith('aggregate')));
  });
}
test('fast path keeps exact acceptance coverage mandatory', async () => {
  const { result } = await run({ validate: { commands: commandReceipts, results: [], summary: '' } }, speedups);
  assert.equal(result.status, 'completed_with_failures');
  assert.equal(result.failedCriteria.length, 2);
});
test('authenticated role marker carries timeout defaults and overrides without unsupported opts', async () => {
  const { calls } = await run({}, { ...speedups, routingToken: 'secret', stepTimeoutMs: { reviewer: 1234 } });
  const metadata = c => JSON.parse(c.prompt.split('\n')[0].slice('__AUTO_RECIPE_ROLE__'.length));
  assert.equal(metadata(calls.find(c => c.label === 'setup')).timeoutMs, 180000);
  assert.equal(metadata(calls.find(c => c.label === 'analysis')).role, 'analysis');
  assert.equal(metadata(calls.find(c => c.label === 'analysis')).timeoutMs, 360000);
  assert.equal(metadata(calls.find(c => c.label === 'implement #1')).timeoutMs, 1200000);
  assert.equal(metadata(calls.find(c => c.label === 'review-a #1')).timeoutMs, 1234);
  assert.ok(calls.every(c => !Object.hasOwn(c, 'timeoutMs')));
});

for (const [name, specification] of [
  ['security impact', { ...compactSpec(['one.js']), impact: 'security' }],
  ['api impact', { ...compactSpec(['one.js']), impact: 'api' }],
  ['data impact', { ...compactSpec(['one.js']), impact: 'data' }],
  ['architecture impact', { ...compactSpec(['one.js']), impact: 'architecture' }],
  ['missing', undefined], ['null', null], ['empty object', {}],
  ['wrong scope', { ...compactSpec(['other.js']) }],
  ['empty acceptance', { ...compactSpec(['one.js']), acceptance: [] }],
  ['duplicate acceptance', { ...compactSpec(['one.js']), acceptance: ['same', 'same'] }],
  ['blank acceptance', { ...compactSpec(['one.js']), acceptance: [' '] }],
  ['missing commands', { ...compactSpec(['one.js']), verifyCommands: [] }],
  ['malformed commands', { ...compactSpec(['one.js']), verifyCommands: [42] }],
  ['blank plan', { ...compactSpec(['one.js']), plan: ' ' }],
  ['extra field', { ...compactSpec(['one.js']), surprise: true }],
]) test(`invalid analysis specification uses independently approved full path: ${name}`, async () => {
  const analysis = { scope: { files: ['one.js'], symbols: [], dependents: [], tests: [] }, currentState: '', gaps: [], outcome: 'proceed', outcomeReason: '', decisions: [], compactSpec: specification };
  const { result, calls } = await run({ analysis, 'design-review': { ...approved, verdict: 'NEEDS_REVISION', decisions: [] } }, { maxDesignIterations: 1 });
  assert.equal(result.fastPath, false);
  assert.equal(result.status, 'aborted');
  assert.ok(calls.some(call => call.label === 'requirements'));
  assert.ok(!calls.some(call => call.label.startsWith('implement')));
});

test('saved fast and full plans resume without preparation and retain review approval', async () => {
  for (const fastPath of [true, false]) {
    const first = await run({ 'review-a': { ...approved, verdict: 'NEEDS_REVISION', findings: [problem] } }, { fastPath, maxCodeIterations: 1 });
    assert.equal(first.result.status, 'aborted');
    const resumed = await run({ 'review-b': { ...approved, verdict: 'NEEDS_REVISION', findings: [problem] } }, { resume: first.result.resume, maxCodeIterations: 1 });
    assert.equal(resumed.result.status, 'aborted');
    assert.equal(resumed.result.fastPath, fastPath);
    assert.ok(!resumed.calls.some(call => /^(setup|analysis|requirements|quick-spec|plan|design)/.test(call.label)));
    assert.ok(resumed.calls.some(call => call.label.startsWith('review-a')));
    assert.ok(resumed.calls.some(call => call.label.startsWith('review-b')));
  }
});

for (const [name, commands] of [
  ['missing', undefined], ['empty', []], ['failed', [{ ...commandReceipts[0], exitCode: 1 }]],
  ['renamed', [{ ...commandReceipts[0], command: 'npm test' }]],
  ['duplicate', [...commandReceipts, ...commandReceipts]],
  ['vague', [{ ...commandReceipts[0], evidence: 'ok' }]],
]) test(`final command receipts prevent completion: ${name}`, async () => {
  const { result } = await run({ validate: { results: acceptance.map(criterion => ({ criterion, status: 'passed', evidence: 'Checked' })), commands, summary: 'Claims pass' } });
  assert.equal(result.status, 'completed_with_failures');
  assert.ok(result.failedCriteria.some(failure => /receipt/.test(failure.evidence)));
});

for (const file of ['/absolute.js', '../outside.js', 'a/../b.js', './one.js', 'a/./b.js', 'a//b.js', 'a\\b.js', 'C:one.js', 'a\u0000.js', 'a\u007f.js', ' one.js ']) {
  test(`compact specification rejects nonliteral relative file ${JSON.stringify(file)}`, async () => {
    const analysis = { scope: { files: [file], symbols: [], dependents: [], tests: [] }, currentState: '', gaps: [], outcome: 'proceed', outcomeReason: '', decisions: [], compactSpec: compactSpec([file]) };
    const { result, calls } = await run({ analysis });
    assert.equal(result.fastPath, false);
    assert.ok(calls.some(call => call.label === 'requirements'));
  });
}

test('authenticated preparation roles carry enforced read-only marker while execution roles retain tools', async () => {
  const { calls } = await run({}, { fastPath: false, routingToken: 'secret' });
  const metadata = call => JSON.parse(call.prompt.split('\n')[0].slice('__AUTO_RECIPE_ROLE__'.length));
  for (const role of ['setup', 'analysis', 'requirements', 'design', 'designReview', 'plan']) {
    const call = calls.find(call => metadata(call).role === role);
    assert.ok(call, role);
    assert.equal(metadata(call).readOnly, true, role);
  }
  for (const role of ['implementer', 'reviewer', 'validate']) {
    assert.ok(calls.some(call => metadata(call).role === role));
    assert.ok(calls.filter(call => metadata(call).role === role).every(call => metadata(call).readOnly === false));
  }
  const validation = calls.find(call => metadata(call).role === 'validate');
  assert.match(validation.prompt, /Run every planned verify command NOW/);
});
