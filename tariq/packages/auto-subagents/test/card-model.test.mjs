import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialState, reduce, stagesOf, headline, nodesOf, nodeState, runningAgents, codeRounds } from '../lib/card-model.mjs';

test('terminal errors stop orphan active agents; actual model updates survive replay', () => {
  let s = play([A(1,'implement #1','implement'), ['auto-recipe/agent-end',{seq:1,model:'fallback-model',annotate:true}], ['auto-recipe/run-end',{status:'error'}]]);
  assert.equal(nodesOf(s).latest.implement.model,'fallback-model');
  assert.equal(runningAgents(s).length,0);
  assert.equal(nodeState(nodesOf(s).latest.implement),'failed');
});

const start = { runId: 'r', recipe: 'feature-pipeline', title: 'T', task: 'task', repo: '/x', routes: {} };
const play = (events, s = initialState(start)) => events.reduce((acc, [type, data, at]) => reduce(acc, type, { runId: 'r', ...data }, at), s);
const A = (seq, label, role, round = 1) => ['auto-recipe/agent-start', { seq, label, role, round, childId: `c${seq}`, model: 'M' }];
const E = (seq, outcome = 'completed') => ['auto-recipe/agent-end', { seq, outcome }];
const V = (seq, verdict) => ['auto-recipe/agent-end', { seq, verdict, findings: verdict === 'no' ? [{ severity: 'high', problem: 'p' }] : [], annotate: true }];

test('all active agents are visible, including legacy other roles and concurrent custom labels', () => {
  const s = play([A(1, 'scope', 'other'), A(2, 'custom one', 'other'), A(3, 'custom two', 'other')]);
  assert.deepEqual(runningAgents(s).map(a => a.seq), [1, 2, 3]);
  assert.equal(Object.keys(nodesOf(s).latest).length, 3);
});

const recipeStages = {
  'bug-fix': ['analysis', 'decision', 'build', 'review', 'validate'],
  'code-audit': ['scope', 'scans', 'verify'],
  investigate: ['scope', 'gather', 'check'],
  'qa-verify': ['analysis', 'verify', 'check'],
  'plan-to-packages': ['evidence', 'packages', 'check'],
  refactor: ['analysis', 'baseline', 'build', 'review', 'validate'],
};
for (const [recipe, expected] of Object.entries(recipeStages)) {
  test(`${recipe}: strip represents real phases without fictional feature design`, () => {
    const s = initialState({ ...start, recipe });
    assert.deepEqual(Object.keys(stagesOf(s)), expected);
    const phase = expected.find(x => !['analysis', 'decision', 'build', 'review', 'validate'].includes(x)) || 'analysis';
    const active = play([['auto-recipe/status', { phase, stage: phase }]], s);
    assert.equal(stagesOf(active)[phase].state, 'active');
  });
}
test('generic stages preserve agent phase and aggregate all parallel agents, not just the latest other role', () => {
  const s = play([
    ['auto-recipe/agent-start', { seq: 1, label: 'scan-security', role: 'scan-security', phase: 'scans' }],
    ['auto-recipe/agent-start', { seq: 2, label: 'scan-correctness', role: 'scan-correctness', phase: 'scans' }], E(2),
  ], initialState({ ...start, recipe: 'code-audit' }));
  assert.equal(s.agents[0].phase, 'scans');
  assert.equal(stagesOf(s).scans.state, 'active');
});
test('unknown recipe uses observed phases, never the feature pipeline', () => {
  const s = play([['auto-recipe/status', { phase: 'custom-phase', stage: 'custom-phase' }]], initialState({ ...start, recipe: 'custom' }));
  assert.deepEqual(Object.keys(stagesOf(s)), ['custom-phase']);
  assert.equal(stagesOf(s)['custom-phase'].state, 'active');
});

test('prototype-named custom recipe uses observed phases safely', () => {
  const s = play([['auto-recipe/status', { phase: 'discover' }]], initialState({ ...start, recipe: 'constructor' }));
  assert.deepEqual(Object.keys(stagesOf(s)), ['discover']);
});

test('prototype-named phases and roles remain own data entries during replay', () => {
  for (const phase of ['constructor', '__proto__']) {
    const s = play([['auto-recipe/status', { phase }], A(1, phase, phase)], initialState({ ...start, recipe: 'custom' }));
    assert.deepEqual(Object.keys(stagesOf(s)), [phase]);
    assert.equal(stagesOf(s)[phase].state, 'active');
    assert.equal(nodesOf(s).latest[phase].label, phase);
  }
});

test('resumed run marks prior scoped analysis reused rather than pending',()=>{
 const s = {...initialState(start),resumed:true};
 assert.equal(stagesOf(s).analysis.state,'done');
});

test('decision stop: analysis done, decision waiting, nothing else started', () => {
  const s = play([A(1, 'setup', 'setup'), E(1), A(2, 'analysis', 'analysis'), E(2),
    ['auto-recipe/decision', { resumeId: 'id', questions: [{ id: 'q' }], decidedForYou: [] }], ['auto-recipe/run-end', { status: 'needs_decision' }]]);
  const st = stagesOf(s);
  assert.equal(st.analysis.state, 'done');
  assert.equal(st.decision.state, 'decision');
  assert.equal(st.design.state, 'pending');
  assert.equal(headline(s), 'decision');
});

test('running implement round 1: design done, build active, review pending; one running agent', () => {
  const s = play([['auto-recipe/run-start', {}], A(3, 'requirements', 'requirements'), E(3), A(4, 'design-draft #1', 'draft'), E(4), A(5, 'design-review #1', 'dreview'), V(5, 'ok'), E(5), A(6, 'plan', 'plan'), E(6), A(7, 'implement #1', 'implement')],
    { ...initialState(start), resumed: true });
  const st = stagesOf(s);
  assert.deepEqual([st.decision.state, st.design.state, st.build.state, st.review.state], ['done', 'done', 'active', 'pending']);
  assert.deepEqual(runningAgents(s).map(a => a.role), ['implement']);
  assert.equal(headline(s), 'running');
});

test('repair: reviewers rejected round 1, implement #2 running → review failed, build active, headline repair', () => {
  const s = play([A(7, 'implement #1', 'implement'), E(7), A(8, 'review-1 #1', 'r1'), A(9, 'review-2 #1', 'r2'), V(8, 'no'), V(9, 'no'), E(8), E(9),
    A(10, 'aggregate #1', 'aggregate', 1), V(10, 'no'), E(10), A(11, 'implement #2', 'implement', 2)], { ...initialState(start), resumed: true });
  const st = stagesOf(s);
  assert.equal(st.build.state, 'active');
  assert.equal(st.build.rounds, 2);
  assert.equal(st.review.state, 'failed');
  assert.equal(headline(s), 'repair');
  const { latest, history } = nodesOf(s);
  assert.equal(latest.implement.round, 2);
  assert.equal(history.implement.length, 2);
  assert.equal(nodeState(latest.r1), 'failed');
});

test('completed run: every started stage done, verdict ok after repair', () => {
  const s = play([A(7, 'implement #1', 'implement'), E(7), A(8, 'review-1 #1', 'r1'), V(8, 'no'), E(8), A(10, 'aggregate #1', 'aggregate'), V(10, 'no'), E(10),
    A(11, 'implement #2', 'implement', 2), E(11), A(12, 'review-1 #2', 'r1', 2), V(12, 'ok'), E(12), A(13, 'aggregate #2', 'aggregate', 2), V(13, 'ok'), E(13),
    A(14, 'validate', 'validate'), E(14), ['auto-recipe/run-end', { status: 'completed', passed: '13/13' }]], { ...initialState(start), resumed: true });
  const st = stagesOf(s);
  assert.deepEqual([st.build.state, st.review.state, st.validate.state], ['done', 'done', 'done']);
  assert.equal(codeRounds(s), 2);
  assert.equal(headline(s), 'done');
  assert.equal(s.result.passed, '13/13');
});

test('aborted run marks build and review failed; duplicate agent-start is idempotent', () => {
  let s = play([A(7, 'implement #3', 'implement', 3), A(7, 'implement #3', 'implement', 3), E(7), ['auto-recipe/run-end', { status: 'aborted' }]]);
  assert.equal(s.agents.length, 1);
  const st = stagesOf(s);
  assert.equal(st.build.state, 'failed');
  assert.equal(st.review.state, 'failed');
  assert.equal(headline(s), 'failed');
  s = reduce(s, 'something/else', {});
  assert.equal(s.agents.length, 1, 'unknown events are ignored');
});

test('a crashed agent (outcome failed) shows as failed even without a verdict', () => {
  const s = play([A(7, 'implement #1', 'implement'), E(7, 'failed')]);
  assert.equal(nodeState(nodesOf(s).latest.implement), 'failed');
});

import { fmtDuration, dirOfLocale, cardDir } from '../lib/card-model.mjs';
test('durations: m:ss under an hour, h:mm:ss from one hour; invalid is empty', () => {
  assert.equal(fmtDuration(0), '0:00');
  assert.equal(fmtDuration(65_000), '1:05');
  assert.equal(fmtDuration(3_599_999), '59:59');
  assert.equal(fmtDuration(3_600_000), '1:00:00');
  assert.equal(fmtDuration(75 * 60_000 + 7_000), '1:15:07');
  assert.equal(fmtDuration(-1), '');
  assert.equal(fmtDuration(NaN), '');
});
test('direction follows the locale; document is only a fallback; default ltr', () => {
  assert.equal(dirOfLocale('ar'), 'rtl');
  assert.equal(dirOfLocale('ar-SA'), 'rtl');
  assert.equal(dirOfLocale('en'), 'ltr');
  assert.equal(dirOfLocale('zh'), 'ltr');
  assert.equal(dirOfLocale(undefined), undefined);
  assert.equal(cardDir('en', { documentElement: { dir: 'rtl', lang: 'ar' } }), 'ltr', 'locale wins over document');
  assert.equal(cardDir(undefined, { documentElement: { dir: 'rtl', lang: 'en' } }), 'rtl');
  assert.equal(cardDir(undefined, { documentElement: { dir: '', lang: 'ar' } }), 'rtl');
  assert.equal(cardDir(undefined, undefined), 'ltr');
});
