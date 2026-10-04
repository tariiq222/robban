// The ONE value meaning "keep the decision made for you" for an optional override question.
// It is a protocol token, never display text: receipts drop it, so the recipe never sees it.
export const KEEP_DECISION = '__keep__';
// Client-safe: bind a card to the exact live ask_user_question batch, not a stale card or draft.
// A pending batch must contain every required `<runId>:<question.id>`. It MAY also carry optional
// override questions `<runId>:<decidedForYou.id>`; any other extra (or duplicate) id rejects the match.
export function matchingQuestion(pending, sessionId, runId, questions, decidedForYou) {
  if (!pending || pending.sessionId !== sessionId || pending.kind !== 'question' || typeof pending.answer !== 'function') return null;
  const required = (questions || []).map(q => `${runId}:${q.id}`);
  const optional = new Set((decidedForYou || []).map(d => `${runId}:${d.id}`));
  const actual = (pending.questions || []).map(q => q.id);
  if (!required.length || new Set(actual).size !== actual.length) return null;
  if (!required.every(id => actual.includes(id))) return null;
  return actual.every(id => required.includes(id) || optional.has(id)) ? pending : null;
}
// Answers every pending id. Required questions need an explicit human answer. Optional override
// ids (decidedForYou) send KEEP_DECISION unless the human typed/chose a replacement. Display text
// (compacted decidedForYou.decision) is never sent as an answer.
export function answerBatch(runId, questions, answers, options = {}) {
  const textOf = id => {
    const a = answers[id] || {};
    const text = a.choice === '__custom' ? a.custom : a.choice;
    return typeof text === 'string' && text.trim() ? text.trim() : undefined;
  };
  const out = questions.map(q => {
    const text = textOf(q.id);
    if (text === undefined || text === KEEP_DECISION) throw new Error(`Missing answer for ${q.id}`);
    return { id: `${runId}:${q.id}`, selected: [], custom: text };
  });
  const prefix = `${runId}:`;
  const covered = new Set(out.map(a => a.id));
  for (const pendingId of options.pendingIds || []) {
    if (covered.has(pendingId)) continue;
    const decided = pendingId.startsWith(prefix) ? (options.decidedForYou || []).find(d => d.id === pendingId.slice(prefix.length)) : undefined;
    if (!decided) throw new Error(`Unexpected pending question ${pendingId}`);
    out.push({ id: pendingId, selected: [], custom: textOf(decided.id) ?? KEEP_DECISION });
    covered.add(pendingId);
  }
  return { answers: out };
}
