import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../lib/recipes.mjs';
import { EVENT } from '../lib/events.mjs';

// Offline run_recipe harness: real recipes dir (read-only, approved feature-pipeline), private temp runs dir.
async function harness(valueFor, { stopReason = 'completed', beforeEnd } = {}) {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'ars-runs-'));
  const listeners = new Map();
  let tool; const appended = []; const sessionEvents = [];
  const emitCtx = (n, ...a) => (listeners.get(n) || []).forEach(f => f(...a));
  const providers = new Map([['spawn', { capabilities: {agentOptions:true}, inheritsParentContext:false, start: async req => ({id: req.prompt[0].text.includes('implement') ? 'child-1' : 'child-2',result:Promise.resolve({}),dispose:async()=>{}}) }]]);
  const engineArgs = [];
  const ctx = {
    emit: emitCtx,
    subagents: {getProvider:n=>providers.get(n),registerProvider:p=>{providers.set(p.name,p);return()=>providers.delete(p.name);}},
    tools: { register: t => { tool = t; } },
    on: (name, fn) => { listeners.set(name, [...(listeners.get(name) || []), fn]); return () => listeners.set(name, listeners.get(name).filter(f => f !== fn)); },
    subagentModelSelection: { current: () => ({ enabled: true, allowedModels: [{ provider: 'a', model: 'A' }, { provider: 'b', model: 'B' }, { provider: 'c', model: 'C' }], modelTiers: ['A', 'B', 'C'].map((m, i) => ({ provider: 'abc'[i], model: m, tier: 'strong' })) }) },
    llm: { listProviders: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }], resolveCallConfig: async c => c },
    workflowEngine: {
      start(req) {
        engineArgs.push(req.args);
        const id = 'eng-' + Math.random().toString(36).slice(2);
        const emit = (n, ...a) => (listeners.get(n) || []).forEach(f => f({ id }, ...a));
        const result = (async () => {
          await null;
          emit('workflow/phase', 'code-loop');
          const provider = providers.get(req.subagentProvider);
          await provider.start({parent:req.parent,signal:req.signal,prompt:[{type:'text',text:'__AUTO_RECIPE_ROLE__'+JSON.stringify({token:req.args.routingToken,role:'implementer',label:'implement #1'})+'\nimplement'}]});
          emit('workflow/agent-start', { seq: 1, label: 'implement #1', phase: 'code-loop', childId: 'child-1' });
          emit('workflow/agent-end', { seq: 1, outcome: 'completed' });
          await provider.start({parent:req.parent,signal:req.signal,prompt:[{type:'text',text:'__AUTO_RECIPE_ROLE__'+JSON.stringify({token:req.args.routingToken,role:'reviewer',label:'review-1 #1'})+'\nreview'}]});
          emit('workflow/agent-start', { seq: 2, label: 'review-1 #1', phase: 'code-loop', childId: 'child-2' });
          emit('workflow/log', '@@auto-recipe ' + JSON.stringify({ kind: 'verdict', label: 'review-1 #1', verdict: 'NEEDS_REVISION', findings: [{ severity: 'high', problem: 'bug' }] }));
          beforeEnd?.(emitCtx);
          emit('workflow/agent-end', { seq: 2, outcome: 'completed' });
          // an unrelated concurrent run must not leak into this card
          (listeners.get('workflow/agent-start') || []).forEach(f => f({ id: 'someone-else' }, { seq: 1, label: 'setup', childId: 'x' }));
          if (stopReason !== 'completed') return { stopReason, error: 'engine said no', agentsStarted: 2 };
          return { stopReason: 'completed', agentsStarted: 2, value: valueFor(req) };
        })();
        return { id, result, cancel() {}, async dispose() {} };
      },
    },
  };
  apply(ctx, { runsDir });
  const exec = { agent: { session: { id: 'sess-1', header: { cwd: runsDir }, append: (type, data, opts) => appended.push({ type, data, opts }), snapshotEvents: () => sessionEvents } }, signal: new AbortController().signal };
  const cleanup = () => rm(runsDir, { recursive: true, force: true });
  return { tool, exec, appended, listeners, runsDir, sessionEvents, engineArgs, ctx, cleanup };
}
const answerEvents = (runId, answers, callId = 'c-' + Math.random()) => [
  { type: 'tool/call', data: { name: 'ask_user_question', callId, arguments: JSON.stringify({ questions: Object.keys(answers).map(id => ({ id: `${runId}:${id}` })) }) } },
  { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ answers: Object.entries(answers).map(([id, custom]) => ({ id: `${runId}:${id}`, selected: [], custom })) }) }] } } },
];
const needsDecision = req => ({ status: 'needs_decision', stage: 'analysis', questions: [{ id: 'q1', question: 'Q?', current: 'now', recommendation: 'a', options: [{ label: 'a', consequence: 'x' }] }], decidedForYou: [{ id: 'd1', recommendation: 'r' }], resume: { task: req.args.task, repo: req.args.repo, round: 1, setup: { huge: 'x'.repeat(5000) }, analysis: {} } });
const record = async (h, id) => JSON.parse(await readFile(path.join(h.runsDir, `${id}.json`), 'utf8'));

test('completed run records start → status → agents → verdict → end, and unsubscribes', async () => {
  const h = await harness(() => ({ status: 'completed', changedPaths: ['src/x.js'], passed: '3/3', iterations: { design: 1, code: 1 } }));
  try {
    const out = await h.tool.execute({ recipe: 'feature-pipeline', task: 'Add X\nmore detail', repo: h.runsDir }, h.exec);
    const types = h.appended.map(e => e.type);
    assert.deepEqual(types, [EVENT.RUN_START, EVENT.STATUS, EVENT.AGENT_START, EVENT.AGENT_END, EVENT.AGENT_START, EVENT.AGENT_END, EVENT.AGENT_END, EVENT.RUN_END]);
    const runIds = new Set(h.appended.map(e => e.data.runId));
    assert.equal(runIds.size, 1, 'every event carries the same card runId');
    assert.equal(out.result.cardRunId, [...runIds][0]);
    assert.equal(h.appended[0].data.task, 'Add X', 'only the first line of the task is stored');
    assert.equal(h.appended[0].data.routes, undefined, 'no always-empty planned routes on run-start');
    assert.equal(out.result.routes, undefined, 'no always-empty planned routes in the result');
    assert.equal(h.appended[2].data.childId, 'child-1');
    assert.ok(h.appended[2].data.model, 'agent-start carries its actual model');
    assert.equal(h.appended[5].data.verdict, 'no');
    assert.equal(h.appended.at(-1).data.status, 'completed');
    assert.deepEqual(h.appended.at(-1).data.changedPaths, ['src/x.js']);
    for (const name of ['workflow/phase', 'workflow/agent-start', 'workflow/agent-end', 'workflow/log', 'auto-subagents/route-changed']) assert.equal(h.listeners.get(name).length, 0, `${name} listener disposed`);
  } finally { await h.cleanup(); }
});

test('a mid-run route change of a recipe child annotates its agent with the new provider/model', async () => {
  const h = await harness(() => ({ status: 'completed' }), { beforeEnd: emit => {
    emit('auto-subagents/route-changed', { childId: 'child-2', route: { provider: 'c', model: 'C' } });
    emit('auto-subagents/route-changed', { childId: 'unrelated', route: { provider: 'a', model: 'A' } });
  } });
  try {
    await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    const annotations = h.appended.filter(e => e.type === EVENT.AGENT_END && e.data.model === 'C' && e.data.annotate === true);
    assert.equal(annotations.length, 1);
    assert.deepEqual({ seq: annotations[0].data.seq, provider: annotations[0].data.provider }, { seq: 2, provider: 'c' });
    assert.ok(!h.appended.some(e => e.data.model === 'A' && e.data.annotate), 'children of other runs are ignored');
  } finally { await h.cleanup(); }
});

test('private provider replacement emits route change into parent audit on the original node', async () => {
  const h = await harness(() => ({ status: 'completed' }));
  h.ctx.subagents.getProvider('spawn').start = async req => {
    const replacement = req.agentOptions.model !== 'A';
    return { id: replacement ? 'fresh-child' : 'original-child', result: Promise.resolve({ stopReason: 'completed', ...(replacement ? { structured: { ok: true } } : {}) }), dispose: async () => {} };
  };
  h.ctx.workflowEngine.start = req => {
    const id = 'structured-engine';
    const result = (async () => {
      await null;
      const run = await h.ctx.subagents.getProvider(req.subagentProvider).start({ parent: req.parent, signal: req.signal, outputSchema: { type: 'object' }, prompt: [{ type: 'text', text: '__AUTO_RECIPE_ROLE__' + JSON.stringify({ token: req.args.routingToken, role: 'setup', label: 'setup' }) + '\nsetup' }] });
      h.ctx.emit('workflow/agent-start', { id }, { seq: 1, label: 'setup', childId: run.id });
      assert.deepEqual((await run.result).structured, { ok: true });
      return { stopReason: 'completed', agentsStarted: 1, value: { status: 'completed' } };
    })();
    return { id, result, cancel() {}, dispose: async () => {} };
  };
  try {
    await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    const annotation = h.appended.find(e => e.type === EVENT.AGENT_END && e.data.reason === 'NO_STRUCTURED_OUTPUT');
    assert.ok(annotation);
    assert.equal(annotation.data.seq, 1); assert.equal(annotation.data.model, 'B');
    assert.equal(annotation.data.replacedChildId, 'original-child');
    assert.equal(annotation.data.childId, 'fresh-child');
  } finally { await h.cleanup(); }
});

test('replacement route changes annotate the original workflow seq and retain replacement mapping', async () => {
  const h = await harness(() => ({ status: 'completed' }), { beforeEnd: emit => {
    emit('auto-subagents/route-changed', { childId: 'replacement', replacedChildId: 'child-2', route: { provider: 'c', model: 'C' }, reason: 'NO_STRUCTURED_OUTPUT' });
    emit('auto-subagents/route-changed', { childId: 'replacement', route: { provider: 'b', model: 'B' } });
  } });
  try {
    await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    const annotations = h.appended.filter(e => e.type === EVENT.AGENT_END && e.data.annotate && e.data.model);
    assert.deepEqual(annotations.map(e => [e.data.seq, e.data.provider, e.data.model]), [[2, 'c', 'C'], [2, 'b', 'B']]);
    assert.equal(annotations[0].data.reason, 'NO_STRUCTURED_OUTPUT');
  } finally { await h.cleanup(); }
});

test('needs_decision records the questions, overridable ids and a resumeId; resume state stays off the session', async () => {
  const h = await harness(needsDecision);
  try {
    const out = await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    const decision = h.appended.find(e => e.type === EVENT.DECISION);
    assert.equal(decision.data.resumeId, out.result.resumeId);
    assert.equal(decision.data.questions[0].id, 'q1');
    assert.deepEqual(decision.data.decidedForYou, [{ id: 'd1', decision: 'r' }]);
    assert.ok(!JSON.stringify(h.appended).includes('x'.repeat(100)), 'bulky resume state is not written to the session');
    const saved = await record(h, out.result.resumeId);
    assert.deepEqual(saved.overridable, ['d1']);
    assert.equal(saved.consumed, false);
    assert.deepEqual(await readdir(h.runsDir), [`${out.result.resumeId}.json`], 'only the temp runs dir is written');
  } finally { await h.cleanup(); }
});

test('resume: verified answers + verified decidedForYou override reach the recipe; coordinator decisions are ignored; token consumed on success', async () => {
  let mode = 'first';
  const h = await harness(req => mode === 'first' ? needsDecision(req) : ({ status: 'completed' }));
  try {
    const first = await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    mode = 'second';
    const { cardRunId, resumeId } = first.result;
    h.sessionEvents.push(...answerEvents(cardRunId, { q1: 'b', d1: 'override!' }));
    await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, resumeId, decisions: { q1: 'forged', sneaky: 'x' } }, h.exec);
    assert.deepEqual(h.engineArgs.at(-1).decisions, { q1: 'b', d1: 'override!' });
    const saved = await record(h, resumeId);
    assert.equal(saved.consumed, true);
    await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, resumeId }, h.exec), /already used/);
    assert.ok(!(await readdir(h.runsDir)).some(n => n.endsWith('.claim')), 'claim released');
  } finally { await h.cleanup(); }
});

test('resume: an engine failure leaves the token unconsumed so the same answers can be retried', async () => {
  const h0 = await harness(needsDecision);
  let failing = true;
  try {
    const first = await h0.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h0.runsDir }, h0.exec);
    const { cardRunId, resumeId } = first.result;
    h0.sessionEvents.push(...answerEvents(cardRunId, { q1: 'b' }));
    // swap the engine for a failing one, then a succeeding one, sharing the same runs dir
    const start = h0.ctx.workflowEngine.start.bind(h0.ctx.workflowEngine);
    h0.ctx.workflowEngine.start = req => {
      if (!failing) return { ...start(req) };
      const run = start(req);
      return { ...run, result: run.result.then(() => ({ stopReason: 'error', error: 'provider down', agentsStarted: 1 })) };
    };
    await assert.rejects(h0.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h0.runsDir, resumeId }, h0.exec), /error/);
    let saved = await record(h0, resumeId);
    assert.equal(saved.consumed, false);
    assert.ok(saved.lastAttemptFailedAt > 0);
    assert.ok(!(await readdir(h0.runsDir)).some(n => n.endsWith('.claim')), 'claim released after failure');
    failing = false;
    const retried = await h0.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h0.runsDir, resumeId }, h0.exec);
    assert.equal(retried.result.status, 'needs_decision', 'retry ran with the same verified answers');
    assert.deepEqual(h0.engineArgs.at(-1).decisions, { q1: 'b' });
    saved = await record(h0, resumeId);
    assert.equal(saved.consumed, true);
  } finally { await h0.cleanup(); }
});

test('a failed run still records run-end with an error', async () => {
  const h = await harness(() => { throw new Error('boom'); });
  try {
    await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec));
    assert.equal(h.appended.at(-1).type, EVENT.RUN_END);
    assert.equal(h.appended.at(-1).data.status, 'error');
  } finally { await h.cleanup(); }
});

test('run_recipe describes decisions as ignored and points to verified ask_user_question answers', async () => {
  const h = await harness(() => ({ status: 'completed' }));
  try {
    const params = h.tool.parameters ?? h.tool.definition?.parameters;
    const text = JSON.stringify(params ?? h.tool);
    assert.match(text, /Ignored/);
    assert.match(text, /ask_user_question/);
  } finally { await h.cleanup(); }
});

test('F5: a settled run whose consumed-marking fails keeps the token blocked (never retryable) and surfaces the error', async () => {
  let mode = 'first';
  const h = await harness(req => mode === 'first' ? needsDecision(req) : ({ status: 'completed' }));
  try {
    const first = await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    mode = 'second';
    const { cardRunId, resumeId } = first.result;
    h.sessionEvents.push(...answerEvents(cardRunId, { q1: 'b' }));
    // Inject: every write of the record after the run settles fails (disk full / EROFS).
    const { setRecordWriterForTests } = await import('../lib/recipes.mjs');
    let failWrites = false;
    const restore = setRecordWriterForTests(async (write, target, value) => { if (failWrites && value?.consumed === true) throw Object.assign(new Error('EIO injected'), { code: 'EIO' }); return write(target, value); });
    const engine = h.ctx.workflowEngine.start.bind(h.ctx.workflowEngine);
    h.ctx.workflowEngine.start = req => { const run = engine(req); return { ...run, result: run.result.then(r => { failWrites = true; return r; }) }; };
    try {
      await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, resumeId }, h.exec), /EIO injected|consumed/);
    } finally { restore(); }
    const saved = await record(h, resumeId);
    assert.equal(saved.lastAttemptFailedAt, undefined, 'a settled run is not recorded as a failed attempt');
    // The token must stay blocked: a retry must not re-run the recipe with the same answers.
    const runsBefore = h.engineArgs.length;
    await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, resumeId }, h.exec), /already used/);
    assert.equal(h.engineArgs.length, runsBefore, 'recipe was not executed again');
  } finally { await h.cleanup(); }
});

test('F5: when the second consumed-marking attempt succeeds the run completes normally', async () => {
  let mode = 'first';
  const h = await harness(req => mode === 'first' ? needsDecision(req) : ({ status: 'completed' }));
  try {
    const first = await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    mode = 'second';
    const { cardRunId, resumeId } = first.result;
    h.sessionEvents.push(...answerEvents(cardRunId, { q1: 'b' }));
    const { setRecordWriterForTests } = await import('../lib/recipes.mjs');
    let failures = 1;
    const restore = setRecordWriterForTests(async (write, target, value) => { if (value?.consumed === true && failures-- > 0) throw new Error('transient'); return write(target, value); });
    try {
      const out = await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, resumeId }, h.exec);
      assert.equal(out.result.status, 'completed');
    } finally { restore(); }
    assert.equal((await record(h, resumeId)).consumed, true);
    assert.ok(!(await readdir(h.runsDir)).some(n => n.endsWith('.claim')), 'claim released after a successful second marking');
  } finally { await h.cleanup(); }
});

test('R2-1: a settled run whose result cannot be saved (saveResume throws after needs_decision) consumes the token and never retries', async () => {
  let mode = 'first';
  const h = await harness(req => needsDecision(req));
  try {
    const first = await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    mode = 'second';
    const { cardRunId, resumeId } = first.result;
    h.sessionEvents.push(...answerEvents(cardRunId, { q1: 'b' }));
    const { setRecordWriterForTests } = await import('../lib/recipes.mjs');
    // Inject: writing the NEW resume record (saveResume of the second needs_decision) fails.
    const restore = setRecordWriterForTests(async (write, target, value) => {
      if (mode === 'second' && value?.version === 1 && value?.consumed === false && !target.includes(resumeId)) throw Object.assign(new Error('ENOSPC injected'), { code: 'ENOSPC' });
      return write(target, value);
    });
    try {
      await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, resumeId }, h.exec), /ENOSPC injected/);
    } finally { restore(); }
    const saved = await record(h, resumeId);
    assert.equal(saved.lastAttemptFailedAt, undefined, 'a settled run is not recorded as a failed attempt');
    assert.equal(saved.consumed, true, 'the token is consumed even though the new record could not be saved');
    const runsBefore = h.engineArgs.length;
    await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, resumeId }, h.exec), /already used/);
    assert.equal(h.engineArgs.length, runsBefore, 'recipe was not executed again');
    assert.ok(!(await readdir(h.runsDir)).some(n => n.endsWith('.claim')), 'claim released once consumed');
  } finally { await h.cleanup(); }
});

test('R2-1: if saving the result AND marking consumed both fail, the settled marker keeps the token blocked', async () => {
  let mode = 'first';
  const h = await harness(req => needsDecision(req));
  try {
    const first = await h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir }, h.exec);
    mode = 'second';
    const { cardRunId, resumeId } = first.result;
    h.sessionEvents.push(...answerEvents(cardRunId, { q1: 'b' }));
    const { setRecordWriterForTests } = await import('../lib/recipes.mjs');
    let runStarted = false;
    const engine = h.ctx.workflowEngine.start.bind(h.ctx.workflowEngine);
    h.ctx.workflowEngine.start = req => { const run = engine(req); return { ...run, result: run.result.then(r => { runStarted = true; return r; }) }; };
    const restore = setRecordWriterForTests(async (write, target, value) => {
      if (runStarted) throw Object.assign(new Error('EROFS injected'), { code: 'EROFS' });
      return write(target, value);
    });
    try {
      await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, resumeId }, h.exec), /EROFS injected|consumed/);
    } finally { restore(); }
    const saved = await record(h, resumeId);
    assert.equal(saved.lastAttemptFailedAt, undefined);
    const claim = JSON.parse(await readFile(path.join(h.runsDir, `${resumeId}.claim`), 'utf8'));
    assert.equal(claim.settled, true, 'permanent settled marker written');
    const runsBefore = h.engineArgs.length;
    await assert.rejects(h.tool.execute({ recipe: 'feature-pipeline', task: 'T', repo: h.runsDir, resumeId }, h.exec), /already used/);
    assert.equal(h.engineArgs.length, runsBefore);
  } finally { await h.cleanup(); }
});
