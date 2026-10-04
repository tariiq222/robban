import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RECIPES_DIR } from '../lib/dsh-paths.mjs';

// Execute the actual recipe body with bounded, deterministic hooks: no LLMs or filesystem writes.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// The installed recipe is found through RECIPES_DIR (DSH_HOME/recipes or DSH_AUTO_RECIPES_DIR), never a
// path relative to this package, so the suite also runs from a copied package.
const source = await readFile(path.join(RECIPES_DIR, 'feature-pipeline', 'script.js'), 'utf8');
const runRecipe = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', source);
const acceptance = ['First acceptance criterion', 'Second acceptance criterion'];
const approved = () => ({ verdict: 'APPROVED', summary: 'approved', findings: [] });
const finding = (id = 'reject-a', severity = 'medium') => ({ id, severity, problem: `Problem ${id}`, requiredFix: `Fix ${id}` });
const decision = (id, kind) => ({ id, kind, question: `Choose ${id}`, current: 'Current behavior', options: [{ label: 'yes', consequence: 'Enable it' }], recommendation: 'yes', why: 'Reason' });
const setup = () => ({ stack: 'JS', testCommands: [], lintCommands: [], conventions: [] });
const analysis = (decisions = []) => ({ scope: { files: ['file.js'], symbols: [], dependents: [], tests: [] }, currentState: 'Current', gaps: ['Gap'], outcome: 'proceed', outcomeReason: '', decisions });
const resume = (decisions = [], extra = {}) => ({ task: 'Safety test', repo: '/fake-repo', round: 1, setup: setup(), analysis: analysis(decisions), ...extra });
const passing = () => ({ results: acceptance.map(criterion => ({ criterion, status: 'passed', evidence: 'Checked' })), summary: 'Validated' });

async function run(overrides = {}, args = {}) {
  const calls = [];
  const logs = [];
  const phases = [];
  const defaults = {
    setup: setup(), analysis: analysis(),
    requirements: { goal: 'Safety', acceptance, nonGoals: [], decisions: [] },
    'design-draft': 'Design', 'design-review': { ...approved(), decisions: [] },
    plan: { steps: [], inScope: ['file.js'], verifyCommands: [] },
    implement: { changedPaths: ['file.js'], commands: [], notes: '', decisions: [] },
    'review-a': approved(), 'review-b': approved(), aggregate: approved(), validate: passing(),
  };
  const agent = async (prompt, opts) => {
    assert.ok(calls.length < 40, 'fake agent call budget exceeded');
    calls.push({ prompt, ...opts });
    const key = opts.label.replace(/ #\d+$/, '');
    assert.ok(Object.hasOwn(defaults, key), `unexpected live/fault hook: ${opts.label}`);
    const value = Object.hasOwn(overrides, key) ? overrides[key] : defaults[key];
    return structuredClone(typeof value === 'function' ? await value(opts, prompt, calls) : value);
  };
  const result = await runRecipe(agent, hooks => Promise.all(hooks.map(hook => Promise.resolve().then(hook).catch(() => null))), name => phases.push(name), line => logs.push(line), {
    task: 'Safety test', repo: '/fake-repo', maxDesignIterations: 2, maxCodeIterations: 1,
    // Keep legacy gate tests on their original full-path semantics; speedup tests opt in.
    fastPath: false, useAggregator: true, earlyValidate: false, ...args,
  });
  return { result, calls, logs, phases };
}

test('missing setup output explains structured_output and retry/settings recovery', async () => {
  await assert.rejects(run({ setup: null }), /step "setup" returned no structured output[\s\S]*structured_output[\s\S]*retry[\s\S]*Subagent settings tiers/);
});

function aggregateSignal(logs) {
  return logs.filter(line => line.startsWith('@@auto-recipe ')).map(line => JSON.parse(line.slice('@@auto-recipe '.length))).find(event => event.label === 'aggregate #1');
}

test('one missing reviewer fails closed with an actionable synthetic finding', async () => {
  const { result, logs } = await run({ 'review-b': null });
  assert.equal(result.status, 'aborted');
  const event = aggregateSignal(logs);
  assert.equal(event.verdict, 'NEEDS_REVISION');
  assert.ok(event.findings.some(f => /review-b/.test(f.problem) && f.requiredFix.trim()));
});

test('all missing reviewers produce repair findings rather than losing the gate', async () => {
  const { result, logs } = await run({ 'review-a': null, 'review-b': null });
  assert.equal(result.status, 'aborted');
  assert.equal(aggregateSignal(logs).findings.length, 2);
});

test('aggregator cannot erase the union of rejecting reviewers findings', async () => {
  const a = finding('reject-a');
  const b = finding('reject-b', 'low');
  const { result, logs } = await run({ 'review-a': { ...approved(), verdict: 'NEEDS_REVISION', findings: [a] }, 'review-b': { ...approved(), verdict: 'NEEDS_REVISION', findings: [b] } });
  assert.equal(result.status, 'aborted');
  assert.deepEqual(aggregateSignal(logs).findings, [a, b]);
});

for (const severity of ['high', 'blocker']) {
  test(`APPROVED reviewer with ${severity} finding cannot be overruled by aggregator`, async () => {
    const f = finding('unsafe', severity);
    const { result, logs } = await run({ 'review-a': { ...approved(), findings: [f] } });
    assert.equal(result.status, 'aborted');
    assert.ok(aggregateSignal(logs).findings.some(item => item.id === f.id));
  });
  test(`aggregator's own ${severity} finding prevents approval`, async () => {
    const { result } = await run({ aggregate: { ...approved(), findings: [finding('unsafe', severity)] } });
    assert.equal(result.status, 'aborted');
  });
}

test('repair iteration receives findings that aggregator attempted to discard', async () => {
  const f = finding();
  const { result, calls } = await run({ 'review-a': opts => opts.label.endsWith('#1') ? { ...approved(), verdict: 'NEEDS_REVISION', findings: [f] } : approved() }, { maxCodeIterations: 2 });
  assert.equal(result.status, 'completed');
  assert.ok(calls.find(call => call.label === 'implement #2').prompt.includes(f.requiredFix));
});

for (const [name, criteria] of [
  ['nonempty subset', [acceptance[0]]],
  ['unknown criterion', [acceptance[0], 'Unknown']],
  ['duplicate criterion', [acceptance[0], acceptance[0], acceptance[1]]],
  ['empty results', []],
]) {
  test(`validation fails closed for ${name}`, async () => {
    const { result } = await run({ validate: { results: criteria.map(criterion => ({ criterion, status: 'passed', evidence: 'Checked' })), summary: 'Claims pass' } });
    assert.equal(result.status, 'completed_with_failures');
    assert.ok(result.failedCriteria.length > 0, 'coverage failure must have actionable output');
  });
}

test('exact duplicate-free validation coverage can be unordered and complete', async () => {
  const { result } = await run({ validate: { ...passing(), results: passing().results.reverse() } });
  assert.equal(result.status, 'completed');
});

test('a failed criterion prevents completion', async () => {
  const validation = passing();
  validation.results[1].status = 'failed';
  const { result } = await run({ validate: validation });
  assert.equal(result.status, 'completed_with_failures');
});

for (const stage of ['design', 'code']) {
  test(`abortIfUnapproved=false cannot certify an unapproved ${stage}`, async () => {
    const overrides = stage === 'design' ? { 'design-review': { verdict: 'NEEDS_REVISION', summary: 'Rejected', findings: [finding()], decisions: [] } } : { 'review-a': { verdict: 'NEEDS_REVISION', summary: 'Rejected', findings: [finding()] } };
    const { result } = await run(overrides, { abortIfUnapproved: false });
    assert.notEqual(result.status, 'completed');
  });
}

for (const kind of ['high_risk', 'follow_up']) {
  test(`first rejected design review with ${kind} stops before a later review can erase it`, async () => {
    const d = decision('dangerous-choice', kind);
    const { result, calls } = await run({ 'design-review': opts => opts.label.endsWith('#1') ? { verdict: 'NEEDS_REVISION', summary: 'Rejected', findings: [], decisions: [d] } : { ...approved(), decisions: [] } });
    assert.equal(result.status, 'needs_decision');
    assert.equal(result.stage, 'design');
    assert.deepEqual(result.questions.map(q => q.id), [d.id]);
    assert.ok(!calls.some(call => call.label === 'design-draft #2' || call.label === 'plan'));
  });
}

test('disallowed follow_up after round one is recorded without blocking', async () => {
  const { result } = await run({ 'design-review': { ...approved(), decisions: [decision('late-choice', 'follow_up')] } }, { resume: resume([], { round: 2 }) });
  assert.equal(result.status, 'completed');
  assert.ok(result.assumptions.some(item => item.id === 'late-choice'));
});

for (const value of [undefined, '', ' ', 42]) {
  test(`resume refuses missing or invalid original needs_user answer (${String(value)})`, async () => {
    const { result, calls } = await run({}, { resume: resume([decision('original', 'needs_user')]), decisions: value === undefined ? {} : { original: value } });
    assert.equal(result.status, 'needs_decision');
    assert.equal(result.stage, 'analysis');
    assert.equal(calls.length, 0);
  });
}

test('multi-stop resume merges confirmed answers, overrides explicitly, and accumulates decision ledger', async () => {
  const original = decision('original', 'needs_user');
  const late = decision('requirements-choice', 'high_risk');
  const later = decision('design-choice', 'high_risk');
  const first = await run({ analysis: analysis([original]) });
  assert.equal(first.result.status, 'needs_decision');
  const second = await run({ requirements: { goal: 'Safety', acceptance, nonGoals: [], decisions: [late] } }, { resume: first.result.resume, decisions: { original: 'confirmed' } });
  assert.deepEqual(second.result.resume.confirmedDecisions, { original: 'confirmed' });
  const third = await run({ 'design-review': { ...approved(), decisions: [later] } }, { resume: second.result.resume, decisions: { 'requirements-choice': 'confirmed-late' } });
  assert.equal(third.result.stage, 'design');
  assert.deepEqual(third.result.resume.confirmedDecisions, { original: 'confirmed', 'requirements-choice': 'confirmed-late' });
  assert.ok(third.result.resume.decisionLedger.some(item => item.id === late.id));
  assert.ok(third.result.resume.decisionLedger.some(item => item.id === later.id));
  const final = await run({}, { resume: third.result.resume, decisions: { original: 'override', 'design-choice': 'confirmed-design' } });
  assert.equal(final.result.status, 'completed');
  assert.deepEqual(final.result.confirmedDecisions, { original: 'override', 'requirements-choice': 'confirmed-late', 'design-choice': 'confirmed-design' });
  const prompt = final.calls.find(call => call.label === 'requirements').prompt;
  assert.ok(prompt.includes('[original] override'));
  assert.ok(prompt.includes('[requirements-choice] confirmed-late'));
  const implementPrompt = final.calls.find(call => call.label === 'implement #1').prompt;
  assert.ok(implementPrompt.includes('[design-choice] confirmed-design'), 'saved late answers must bind downstream implementation even if requirements omit them');
});

test('review failure exceptions are treated as missing, not approvals', async () => {
  const { result } = await run({ 'review-b': () => { throw new Error('review failed'); } });
  assert.equal(result.status, 'aborted');
});

test('same local finding id does not erase distinct reviewer problems', async () => {
  const a = finding('same-id');
  const b = { ...finding('same-id', 'high'), problem: 'A different problem', requiredFix: 'A different repair' };
  const { logs } = await run({ 'review-a': { ...approved(), verdict: 'NEEDS_REVISION', findings: [a] }, 'review-b': { ...approved(), verdict: 'NEEDS_REVISION', findings: [b] } });
  assert.deepEqual(aggregateSignal(logs).findings, [a, b]);
});

test('duplicate source findings preserve highest severity against aggregator downgrade', async () => {
  const a = finding('source', 'blocker');
  const b = { ...a, id: 'aggregated', severity: 'low' };
  const { logs } = await run({ 'review-a': { ...approved(), findings: [a] }, aggregate: { ...approved(), findings: [b] } });
  assert.deepEqual(aggregateSignal(logs).findings, [a]);
});

test('decision on the last rejected design takes precedence over iteration-limit abort', async () => {
  const { result } = await run({ 'design-review': { verdict: 'NEEDS_REVISION', summary: 'Rejected', findings: [], decisions: [decision('last', 'high_risk')] } }, { maxDesignIterations: 1 });
  assert.equal(result.status, 'needs_decision');
});

test('a later design review also stops immediately on high risk', async () => {
  const { result, calls } = await run({ 'design-review': opts => opts.label.endsWith('#1') ? { verdict: 'NEEDS_REVISION', summary: 'Rejected', findings: [finding()], decisions: [] } : { ...approved(), decisions: [decision('second', 'high_risk')] } });
  assert.equal(result.status, 'needs_decision');
  assert.ok(!calls.some(call => call.label === 'plan'));
});

test('unanswered persisted follow_up cannot disappear when resuming beyond its reporting window', async () => {
  const first = await run({ requirements: { goal: 'Safety', acceptance, nonGoals: [], decisions: [decision('follow', 'follow_up')] } });
  const second = await run({}, { resume: { ...first.result.resume, round: 2 } });
  assert.equal(second.result.status, 'needs_decision');
  assert.deepEqual(second.result.questions.map(q => q.id), ['follow']);
  assert.equal(second.calls.length, 0);
});

for (const criteria of [[], [acceptance[0], acceptance[0]]]) {
  test(`invalid requirements acceptance cannot certify validation (${criteria.length} criteria)`, async () => {
    const { result } = await run({ requirements: { goal: 'Safety', acceptance: criteria, nonGoals: [], decisions: [] }, validate: { results: criteria.map(criterion => ({ criterion, status: 'passed', evidence: 'Checked' })), summary: 'Claims pass' } });
    assert.equal(result.status, 'completed_with_failures');
  });
}

test('deterministic merge retains legacy verdict signal and trail without aggregate agent', async () => {
  const { result, calls, logs } = await run({}, { useAggregator: false, earlyValidate: true });
  assert.equal(result.status, 'completed');
  assert.ok(!calls.some(call => call.label.startsWith('aggregate')));
  assert.equal(aggregateSignal(logs).verdict, 'APPROVED');
  assert.ok(result.reviewTrail.some(entry => entry.step === 'aggregate #1' && entry.verdict === 'APPROVED'));
  assert.equal(calls.filter(call => call.label === 'validate').length, 1);
});

test('deterministic merge keeps rejecting findings when aggregate agent is disabled', async () => {
  const f = finding('deterministic', 'blocker');
  const { result, calls, logs } = await run({ 'review-a': { ...approved(), verdict: 'NEEDS_REVISION', findings: [f] } }, { useAggregator: false, earlyValidate: true });
  assert.equal(result.status, 'aborted');
  assert.deepEqual(aggregateSignal(logs).findings, [f]);
  assert.ok(!calls.some(call => call.label.startsWith('aggregate')));
  assert.ok(logs.includes('early validation discarded'));
});

test('routes and structured verdict logs remain compatible', async () => {
  const { result, calls, logs } = await run({}, { routes: { requirements: { provider: 'fake', model: 'requirements-model' }, reviewers: [{ label: 'review-a', provider: 'fake-review', model: 'review-model' }] } });
  assert.equal(result.status, 'completed');
  assert.equal(calls.find(call => call.label === 'requirements').model, 'requirements-model');
  assert.equal(calls.find(call => call.label === 'review-a #1').provider, 'fake-review');
  assert.equal(aggregateSignal(logs).verdict, 'APPROVED');
});
