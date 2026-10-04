import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunTracker, parseSignal } from '../lib/run-tracker.mjs';
import { EVENT, roleOfLabel, roundOfLabel, compactFindings, compactQuestions } from '../lib/events.mjs';

const routes = {
  setup: { provider: 'p', model: 'L', tier: 'light' }, analysis: { provider: 'p', model: 'M', tier: 'medium' },
  design: { provider: 'p', model: 'M', tier: 'medium' }, designReview: { provider: 'p', model: 'S0', tier: 'strong' },
  implementer: { provider: 'a', model: 'SA', tier: 'strong' },
  reviewers: [{ label: 'review-1', provider: 'b', model: 'SB', tier: 'strong' }, { label: 'review-2', provider: 'c', model: 'SC', tier: 'strong' }],
};
const parentWith = (log, { failAt } = {}) => ({ session: { append(type, data, opts) { if (failAt !== undefined && log.length === failAt) throw new Error('disk full'); log.push({ type, data, opts }); } } });

test('labels map to graph roles and rounds', () => {
  assert.equal(roleOfLabel('setup'), 'setup');
  assert.equal(roleOfLabel('design-draft #2'), 'draft');
  assert.equal(roleOfLabel('design-review #1'), 'dreview');
  assert.equal(roleOfLabel('implement #3'), 'implement');
  assert.equal(roleOfLabel('review-2 #1'), 'r2');
  assert.equal(roleOfLabel('aggregate #2'), 'aggregate');
  assert.equal(roleOfLabel('something else'), 'other');
  assert.equal(roundOfLabel('implement #3'), 3);
  assert.equal(roundOfLabel('setup'), 1);
});

test('new recipe labels keep distinct graph roles and all phases produce durable progress', () => {
  for (const label of ['scope', 'gather', 'check', 'evidence', 'packages', 'verify', 'baseline', 'scan-security', 'scan-correctness']) {
    assert.equal(roleOfLabel(label + ' #2'), label);
  }
  const log = [], tracker = new RunTracker(parentWith(log), 'new-recipes', {});
  tracker.bind('eng');
  for (const phase of ['scope', 'scans', 'gather', 'check', 'evidence', 'packages', 'verify', 'baseline', 'custom-phase']) tracker.onPhase({ id: 'eng' }, phase);
  assert.deepEqual(log.map(e => e.data.stage), ['scope', 'scans', 'gather', 'check', 'evidence', 'packages', 'verify', 'baseline', 'custom-phase']);
});

test('prototype-named engine phases remain serializable durable phase strings', () => {
  const log = [], tracker = new RunTracker(parentWith(log), 'custom', {});
  tracker.bind('eng');
  for (const phase of ['constructor', '__proto__']) tracker.onPhase({id:'eng'}, phase);
  assert.deepEqual(log.map(e=>e.data.stage), ['constructor', '__proto__']);
});

test('every saved recipe replays its actual labels, phases and reviewer verdicts into truthful card stages', async () => {
  const { initialState, reduce, stagesOf, runningAgents } = await import('../lib/card-model.mjs');
  const cases = {
    'feature-pipeline': [['setup','setup'], ['analysis','analysis'], ['requirements','requirements'], ['design-draft #1','design-loop'], ['design-review #1','design-loop'], ['plan','plan'], ['implement #1','code-loop'], ['review-1 #1','code-loop'], ['validate','validate']],
    'bug-fix': [['setup','setup'], ['analysis','analysis'], ['implement #1','code-loop'], ['review-1 #1','code-loop'], ['validate','validate']],
    'code-audit': [['scope','scope'], ['scan-security','scans'], ['scan-correctness','scans'], ['verify','verify']],
    investigate: [['scope','scope'], ['gather','gather'], ['check','check']],
    'qa-verify': [['analysis','analysis'], ['verify','verify'], ['check','check']],
    'plan-to-packages': [['evidence','evidence'], ['packages','packages'], ['check','check']],
    refactor: [['setup','setup'], ['analysis','analysis'], ['baseline','baseline'], ['implement #1','code-loop'], ['review-1 #1','code-loop'], ['review-2 #1','code-loop'], ['validate','validate']],
  };
  for (const [recipe, steps] of Object.entries(cases)) {
    const log = [], tracker = new RunTracker(parentWith(log), recipe, {});
    tracker.bind('engine');
    for (const [index, [label, phase]] of steps.entries()) {
      tracker.onPhase({id:'engine'}, phase);
      tracker.onAgentStart({id:'engine'}, {seq:index+1,label,phase,childId:'child-'+index});
    }
    let state = log.reduce((s,e)=>reduce(s,e.type,e.data), initialState({recipe,runId:recipe}));
    assert.equal(runningAgents(state).length, steps.length, recipe);
    assert.equal(state.agents.every(a=>a.role!=='other'), true, recipe);
    const last = steps.at(-1)[1];
    assert.equal(stagesOf(state)[last].state, 'active', recipe);
    const reviewer = steps.findIndex(([label])=>label.startsWith('review-1'));
    if (reviewer >= 0) {
      tracker.onLog({id:'engine'}, '@@auto-recipe '+JSON.stringify({kind:'verdict',label:steps[reviewer][0],verdict:'NEEDS_REVISION',findings:[{severity:'high',problem:'regression'}]}));
      state = reduce(state, log.at(-1).type, log.at(-1).data);
      assert.equal(state.agents[reviewer].verdict, 'no', recipe);
      assert.equal(state.agents[reviewer].outcome, undefined, 'verdict annotations do not finish active children');
    }
  }
});

test('only events of the bound engine run are recorded, all ignorable, all with runId', () => {
  const log = [];
  const t = new RunTracker(parentWith(log), 'card-1', routes);
  t.onAgentStart({ id: 'eng-1' }, { seq: 1, label: 'setup', childId: 'c1' }); // before bind: ignored
  t.bind('eng-1');
  t.onAgentStart({ id: 'eng-OTHER' }, { seq: 1, label: 'setup', childId: 'x' }); // other run: ignored
  t.onPhase({ id: 'eng-1' }, 'code-loop');
  t.onAgentStart({ id: 'eng-1' }, { seq: 7, label: 'implement #1', phase: 'code-loop', childId: 'c7' });
  t.onAgentStart({ id: 'eng-1' }, { seq: 8, label: 'review-2 #1', phase: 'code-loop', childId: 'c8' });
  t.onAgentEnd({ id: 'eng-1' }, { seq: 7, outcome: 'completed' });
  assert.deepEqual(log.map(e => e.type), [EVENT.STATUS, EVENT.AGENT_START, EVENT.AGENT_START, EVENT.AGENT_END]);
  assert.ok(log.every(e => e.opts?.ignorable === true && e.data.runId === 'card-1'));
  assert.deepEqual(log[0].data, { runId: 'card-1', stage: 'build', state: 'active', phase: 'code-loop' });
  assert.equal(log[1].data.model, 'SA'); assert.equal(log[1].data.tier, 'strong'); assert.equal(log[1].data.role, 'implement');
  assert.equal(log[2].data.model, 'SC'); assert.equal(log[2].data.role, 'r2'); assert.equal(log[2].data.childId, 'c8');
});

test('recipe signals become verdict/summary annotations linked to the agent seq', () => {
  const log = [];
  const t = new RunTracker(parentWith(log), 'card-2', routes);
  t.bind('eng-2');
  t.onAgentStart({ id: 'eng-2' }, { seq: 9, label: 'review-1 #1', childId: 'c9' });
  t.onLog({ id: 'eng-2' }, '@@auto-recipe ' + JSON.stringify({ kind: 'verdict', label: 'review-1 #1', verdict: 'NEEDS_REVISION', findings: [{ severity: 'high', problem: 'x'.repeat(500) }] }));
  t.onLog({ id: 'eng-2' }, 'plain narration, not a signal');
  t.onLog({ id: 'eng-2' }, '@@auto-recipe {broken json');
  const verdict = log.at(-1);
  assert.equal(log.length, 2);
  assert.equal(verdict.type, EVENT.AGENT_END);
  assert.equal(verdict.data.seq, 9); assert.equal(verdict.data.verdict, 'no'); assert.equal(verdict.data.annotate, true);
  assert.equal(verdict.data.findings[0].severity, 'high');
  assert.ok(verdict.data.findings[0].problem.length <= 240, 'findings are clipped');
});

test('an append failure stops tracking quietly and never throws into the run', () => {
  const log = []; const warnings = [];
  const t = new RunTracker(parentWith(log, { failAt: 1 }), 'card-3', routes, w => warnings.push(w));
  t.bind('eng-3');
  t.onPhase({ id: 'eng-3' }, 'setup');
  assert.doesNotThrow(() => t.onAgentStart({ id: 'eng-3' }, { seq: 1, label: 'setup', childId: 'c' }));
  t.onAgentEnd({ id: 'eng-3' }, { seq: 1, outcome: 'completed' });
  assert.equal(log.length, 1);
  assert.equal(warnings.length, 1);
});

test('parseSignal and compaction helpers are defensive', () => {
  assert.equal(parseSignal('nope'), undefined);
  assert.equal(parseSignal('@@auto-recipe 5'), undefined);
  assert.deepEqual(parseSignal('@@auto-recipe {"kind":"summary","label":"plan"}'), { kind: 'summary', label: 'plan' });
  assert.deepEqual(compactFindings(null), []);
  assert.equal(compactFindings(Array.from({ length: 20 }, () => ({ severity: 'low', problem: 'p' }))).length, 6);
  const q = compactQuestions([{ id: 'a', question: 'Q', current: 'C', recommendation: 'R', options: [{ label: 'x', consequence: 'y' }] }]);
  assert.deepEqual(q[0].options, [{ label: 'x', consequence: 'y' }]);
});
