import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../lib/recipes.mjs';
import { RECIPES_DIR } from '../lib/dsh-paths.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = await readFile(path.join(RECIPES_DIR, 'feature-pipeline', 'script.js'), 'utf8');
const fp = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', source);
const acceptance = ['A1', 'A2'];
const approved = () => ({ verdict: 'APPROVED', summary: 'ok', findings: [] });
const high = { id: 'h', severity: 'high', problem: 'bad', requiredFix: 'fix' };
const setup = { stack: 'JS', testCommands: [], lintCommands: [], conventions: [] };
const analysis = { scope: { files: ['f.js'], symbols: [], dependents: [], tests: [] }, currentState: 'c', gaps: ['g'], outcome: 'proceed', outcomeReason: '', decisions: [] };
const passing = () => ({ results: acceptance.map(criterion => ({ criterion, status: 'passed', evidence: 'e' })), summary: 'v' });
async function run(overrides = {}, args = {}) {
  const calls = [], logs = [];
  const defaults = { setup, analysis, requirements: { goal: 'g', acceptance, nonGoals: [], decisions: [] }, 'design-draft': 'D', 'design-review': { ...approved(), decisions: [] },
    plan: { steps: [], inScope: ['f.js'], verifyCommands: [] }, implement: { changedPaths: ['f.js'], commands: [], notes: '', decisions: [] },
    'review-a': approved(), 'review-b': approved(), validate: passing() };
  const agent = async (prompt, opts) => {
    assert.ok(calls.length < 40);
    calls.push({ prompt, ...opts });
    const key = opts.label.replace(/ #\d+$/, '');
    const v = Object.hasOwn(overrides, key) ? overrides[key] : defaults[key];
    return structuredClone(typeof v === 'function' ? await v(opts, prompt, calls) : v);
  };
  const result = await fp(agent, hooks => Promise.all(hooks.map(h => Promise.resolve().then(h).catch(() => null))), () => {}, l => logs.push(l),
    { task: 'T', repo: '/r', maxDesignIterations: 1, maxCodeIterations: 2, fastPath: false, earlyValidate: false, ...args });
  const signals = logs.filter(l => l.startsWith('@@auto-recipe ')).map(l => JSON.parse(l.slice(14)));
  return { result, calls, signals };
}
const labels = calls => calls.map(c => c.label);

test('checkpoints are emitted after the plan, after implementation and after each verdict', async () => {
  const { signals } = await run();
  const cps = signals.filter(s => s.kind === 'checkpoint');
  assert.ok(cps.length >= 3);
  assert.ok(cps.every(c => c.state.task === 'T' && c.state.repo === '/r' && c.state.progress?.plan));
  assert.equal(cps.at(-1).state.progress.approved, true);
});

test('code not approved → aborted result is resumable and resume skips spec, design and plan', async () => {
  const first = await run({ 'review-a': { verdict: 'NEEDS_REVISION', summary: 'no', findings: [high] } }, { maxCodeIterations: 1 });
  assert.equal(first.result.status, 'aborted');
  assert.ok(first.result.resume?.progress?.plan, 'aborted result carries a resume with saved progress');
  assert.equal(first.result.resume.progress.codeDone, 1);
  const second = await run({}, { resume: first.result.resume });
  assert.equal(second.result.status, 'completed');
  const l = labels(second.calls);
  for (const skipped of ['setup', 'analysis', 'quick-spec', 'requirements', 'plan']) assert.ok(!l.includes(skipped), `${skipped} must not rerun`);
  assert.ok(!l.some(x => x.startsWith('design-')), 'design must not rerun');
  assert.equal(l.find(x => x.startsWith('implement')), 'implement #2', 'iteration numbering continues');
  const impl = second.calls.find(c => c.label === 'implement #2');
  assert.match(impl.prompt, /git status[\s\S]*git diff/);
  assert.match(impl.prompt, /Problem|bad|"id": "h"/, 'previous findings are fed to the implementer');
  assert.equal(second.result.iterations.resumedFromRound, 1);
});

test('resume from a checkpoint taken after unanimous approval goes straight to validation', async () => {
  const first = await run();
  const approvedCheckpoint = first.signals.filter(s => s.kind === 'checkpoint').at(-1).state;
  const second = await run({}, { resume: approvedCheckpoint });
  assert.equal(second.result.status, 'completed');
  assert.deepEqual(labels(second.calls), ['validate']);
});

test('resume after a mid-implementation stop (checkpoint before reviews) re-enters review/repair, not the spec', async () => {
  const first = await run();
  const cp = first.signals.filter(s => s.kind === 'checkpoint').find(s => s.state.progress.codeDone === 0 && s.state.progress.plan && !s.state.progress.approved && s.state.progress.changedPaths.length).state;
  const second = await run({}, { resume: cp });
  assert.equal(second.calls.find(c => c.label.startsWith('implement')).label, 'implement #1');
  assert.match(second.calls.find(c => c.label.startsWith('implement')).prompt, /git status/);
  assert.ok(!labels(second.calls).includes('requirements'));
});

test('design not approved is resumable with a fresh design budget', async () => {
  const { result } = await run({ 'design-review': { verdict: 'NEEDS_REVISION', summary: 'n', findings: [high], decisions: [] } });
  assert.equal(result.status, 'aborted');
  assert.equal(result.stage, 'design-loop');
  assert.ok(result.resume && result.resume.task === 'T');
  assert.equal(result.resume.progress, undefined, 'no saved plan: design reruns on resume');
});

// ── run_recipe level: failure/cancel/timeout keep partial work resumable ──────────────────────
async function harness(engine) {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ars-stop-'));
  const listeners = new Map();
  let tool; const appended = [];
  const providers = new Map([['spawn', { capabilities: { agentOptions: true }, inheritsParentContext: false, start: async () => ({ id: 'c', result: Promise.resolve({ stopReason: 'completed', structured: {} }), dispose: async () => {} }) }]]);
  const ctx = {
    emit: (n, ...a) => (listeners.get(n) || []).forEach(f => f(...a)),
    subagents: { getProvider: n => providers.get(n), registerProvider: p => { providers.set(p.name, p); return () => providers.delete(p.name); } },
    tools: { register: t => { tool = t; } },
    on: (name, fn) => { listeners.set(name, [...(listeners.get(name) || []), fn]); return () => listeners.set(name, listeners.get(name).filter(f => f !== fn)); },
    subagentModelSelection: { current: () => ({ enabled: true, allowedModels: [{ provider: 'a', model: 'A' }], modelTiers: [{ provider: 'a', model: 'A', tier: 'strong' }] }) },
    llm: { listProviders: () => [{ id: 'a' }], resolveCallConfig: async c => c },
    workflowEngine: { start: req => engine(req, (n, id, ...a) => (listeners.get(n) || []).forEach(f => f({ id }, ...a)), providers) },
  };
  apply(ctx, { runsDir });
  const ac = new AbortController();
  const exec = { agent: { session: { id: 's', header: { cwd: runsDir }, append: (type, data) => appended.push({ type, data }), snapshotEvents: () => [] } }, signal: ac.signal };
  return { tool, exec, appended, runsDir, ac, cleanup: () => rm(runsDir, { recursive: true, force: true }) };
}
const cpLog = repo => '@@auto-recipe ' + JSON.stringify({ kind: 'checkpoint', state: { task: 'T', repo, round: 1, setup, analysis, progress: { plan: {}, codeDone: 1 } } });

test('engine error after a checkpoint offers a resumeId and the saved record resumes later; checkpoint never hits the session log', async () => {
  let repoDir;
  const h = await harness((req, emit) => {
    const id = 'e1';
    const result = (async () => { await null; emit('workflow/log', id, cpLog(repoDir)); return { stopReason: 'error', error: 'child timed out', agentsStarted: 1 }; })();
    return { id, result, cancel() {}, dispose: async () => {} };
  });
  repoDir = h.runsDir;
  try {
    await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec), err => {
      assert.match(err.message, /child timed out/);
      const m = /resumeId "([0-9a-f-]{36})"/.exec(err.message);
      assert.ok(m, 'error names a resumeId');
      return true;
    });
    const files = (await readdir(h.runsDir)).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const rec = JSON.parse(await readFile(path.join(h.runsDir, files[0]), 'utf8'));
    assert.equal(rec.consumed, false);
    assert.equal(rec.resume.progress.codeDone, 1);
    assert.equal(rec.scopeHashes, undefined);
    assert.ok(!JSON.stringify(h.appended).includes('"checkpoint"'), 'checkpoint state is not written to the session');
  } finally { await h.cleanup(); }
});

test('without any checkpoint a failure stays a plain error (no fake resumeId)', async () => {
  const h = await harness(() => ({ id: 'e2', result: Promise.resolve({ stopReason: 'error', error: 'boom', agentsStarted: 0 }), cancel() {}, dispose: async () => {} }));
  try {
    await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec), err => !/resumeId/.test(err.message) && /boom/.test(err.message));
    assert.equal((await readdir(h.runsDir)).filter(f => f.endsWith('.json')).length, 0);
  } finally { await h.cleanup(); }
});

test('user stop (abort signal) cancels the run, reports cancelled, keeps the checkpoint resumable and releases listeners', async () => {
  let repoDir, cancelled;
  const h = await harness((req, emit) => {
    const id = 'e3';
    let done; const result = new Promise(r => { done = r; });
    (async () => { await null; emit('workflow/log', id, cpLog(repoDir)); })();
    return { id, result, cancel: reason => { cancelled = reason; done({ stopReason: 'cancelled', agentsStarted: 1 }); }, dispose: async () => {} };
  });
  repoDir = h.runsDir;
  try {
    const p = h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    await new Promise(r => setTimeout(r, 20));
    h.ac.abort();
    await assert.rejects(p, /cancelled[\s\S]*resumeId "/);
    assert.match(cancelled, /parent step aborted/);
    assert.equal(h.appended.at(-1).data.status, 'cancelled');
  } finally { await h.cleanup(); }
});

test('total run time limit cancels a hung run with a clear message and a resumeId', async () => {
  let repoDir;
  const h = await harness((req, emit) => {
    const id = 'e4';
    let done; const result = new Promise(r => { done = r; });
    (async () => { await null; emit('workflow/log', id, cpLog(repoDir)); })();
    return { id, result, cancel: () => done({ stopReason: 'cancelled', agentsStarted: 1 }), dispose: async () => {} };
  });
  repoDir = h.runsDir;
  try {
    await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, totalTimeoutMs: 40 }, h.exec), /total time limit[\s\S]*resumeId "/);
    assert.equal(h.appended.at(-1).data.status, 'error');
  } finally { await h.cleanup(); }
});

test('a child that ends without structured output reports its real reason in stepFailures instead of vanishing', async () => {
  const h = await harness((req, emit, providers) => {
    const id = 'e5';
    providers.get('spawn').start = async () => ({ id: 'bad', result: Promise.resolve({ stopReason: 'error', output: [{ type: 'text', text: 'step timed out after 5 ms on a/A' }] }), dispose: async () => {} });
    const result = (async () => {
      await null;
      const run = await providers.get(req.subagentProvider).start({ parent: req.parent, signal: req.signal, outputSchema: { type: 'object' }, prompt: [{ type: 'text', text: '__AUTO_RECIPE_ROLE__' + JSON.stringify({ token: req.args.routingToken, role: 'implementer', label: 'implement #1' }) + '\nx' }] });
      await run.result.catch(() => {});
      return { stopReason: 'completed', agentsStarted: 1, value: { status: 'aborted', reason: 'Implementer returned no structured result' } };
    })();
    return { id, result, cancel() {}, dispose: async () => {} };
  });
  try {
    const out = await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    assert.match(out.result.stepFailures.join(' '), /implement #1[\s\S]*timed out/);
  } finally { await h.cleanup(); }
});
