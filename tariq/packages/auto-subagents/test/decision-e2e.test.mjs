// End to end: card answerBatch → canonical ask_user_question tool/call + tool/result events →
// verifiedDecisions → the decisions object run_recipe passes to the recipe.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerBatch, KEEP_DECISION, matchingQuestion } from '../lib/decision-model.mjs';
import { verifiedDecisions } from '../lib/decision-receipt.mjs';
import { validateResume } from '../lib/recipes.mjs';

const runId = 'run-1';
const questions = [{ id: 'q1' }, { id: 'q2' }];
// Card-side decidedForYou entries carry COMPACTED display text (events.mjs clips to 200 chars).
const longDecision = `use the existing adapter ${'x'.repeat(300)}`;
const decidedForYou = [{ id: 'd1', decision: `${longDecision.slice(0, 199)}…` }, { id: 'd2', decision: 'keep API' }];
const pendingIds = ['run-1:q1', 'run-1:q2', 'run-1:d1', 'run-1:d2'];

function hostEvents(batch, callId = 'call-1') {
  return [
    { type: 'tool/call', data: { name: 'ask_user_question', callId, arguments: JSON.stringify({ questions: pendingIds.map(id => ({ id, question: id })) }) } },
    { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify(batch) }] } } },
  ];
}
const record = { version: 1, ownerSessionId: 's', recipe: 'feature-pipeline', task: 'T', repo: '/r', consumed: false, cardRunId: runId,
  pendingQuestions: questions, confirmedDecisions: {}, overridable: ['d1', 'd2'], resume: {} };

test('card → host events → receipt → recipe decisions: untouched override absent, changed override full text, required intact', () => {
  const pending = { sessionId: 's', kind: 'question', questions: pendingIds.map(id => ({ id })), answer: async () => {} };
  assert.equal(matchingQuestion(pending, 's', runId, questions, decidedForYou), pending);
  const changed = `switch to the new adapter and migrate callers ${'y'.repeat(250)}`;
  const batch = answerBatch(runId, questions, {
    q1: { choice: 'A' }, q2: { choice: '__custom', custom: ' my own answer ' }, d2: { choice: '__custom', custom: changed },
  }, { pendingIds, decidedForYou });
  // the card never sends compacted display text or a literal "keep" for an untouched override
  const d1 = batch.answers.find(a => a.id === 'run-1:d1');
  assert.equal(d1.custom, KEEP_DECISION);
  for (const a of batch.answers) assert.ok(!a.custom.endsWith('…') && a.custom !== 'keep');
  const decisions = verifiedDecisions(hostEvents(batch), runId, questions, record.overridable);
  assert.deepEqual(decisions, { q1: 'A', q2: 'my own answer', d2: changed });
  assert.ok(!Object.hasOwn(decisions, 'd1'), 'untouched override must not become a replacement decision');
  const { decisions: recipeDecisions } = validateResume(record, { recipe: 'feature-pipeline', task: 'T', repo: '/r', decisions }, 's');
  assert.deepEqual(recipeDecisions, { q1: 'A', q2: 'my own answer', d2: changed });
  assert.ok(!Object.values(recipeDecisions).includes(KEEP_DECISION), 'the recipe never receives the sentinel');
});

test('an explicit keep option selected in the host dialog is honored as keep', () => {
  const batch = { answers: [
    { id: 'run-1:q1', selected: ['A'] }, { id: 'run-1:q2', selected: ['B'] },
    { id: 'run-1:d1', selected: [KEEP_DECISION] }, { id: 'run-1:d2', selected: [], custom: ` ${KEEP_DECISION} ` },
  ] };
  assert.deepEqual(verifiedDecisions(hostEvents(batch), runId, questions, record.overridable), { q1: 'A', q2: 'B' });
});

test('a required answer equal to the sentinel is rejected as missing', () => {
  const batch = { answers: [{ id: 'run-1:q1', selected: [], custom: KEEP_DECISION }, { id: 'run-1:q2', selected: ['B'] }] };
  assert.throws(() => verifiedDecisions(hostEvents(batch), runId, questions, record.overridable), /decision "q1"/);
});

test('a later keep withdraws an earlier override; a later override replaces keep', () => {
  const first = { answers: [{ id: 'run-1:q1', selected: ['A'] }, { id: 'run-1:q2', selected: ['B'] }, { id: 'run-1:d1', selected: [], custom: 'override' }] };
  const second = { answers: [{ id: 'run-1:d1', selected: [KEEP_DECISION] }] };
  const events = [...hostEvents(first, 'c1'), ...hostEvents(second, 'c2')];
  assert.deepEqual(verifiedDecisions(events, runId, questions, record.overridable), { q1: 'A', q2: 'B' });
  const third = { answers: [{ id: 'run-1:d1', selected: [], custom: 'final' }] };
  assert.equal(verifiedDecisions([...events, ...hostEvents(third, 'c3')], runId, questions, record.overridable).d1, 'final');
});

test('a sentinel answer to a required question also cannot be smuggled through an earlier real answer', () => {
  const first = { answers: [{ id: 'run-1:q1', selected: ['A'] }, { id: 'run-1:q2', selected: ['B'] }] };
  const second = { answers: [{ id: 'run-1:q1', selected: [KEEP_DECISION] }] };
  assert.throws(() => verifiedDecisions([...hostEvents(first, 'c1'), ...hostEvents(second, 'c2')], runId, questions, record.overridable), /decision "q1"/);
});

test('the coordinator prompt names the exact keep sentinel the receipt understands', async () => {
  const { renderCatalogForCoordinator } = await import('../lib/recipe-catalog.mjs');
  const guidance = renderCatalogForCoordinator([]);
  assert.ok(guidance.includes(`\`${KEEP_DECISION}\``));
  assert.match(guidance, /never offer or pass truncated/);
});
