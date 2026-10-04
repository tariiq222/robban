import { KEEP_DECISION } from './decision-model.mjs';
// Recover human answers only from successful canonical ask_user_question tool results.
// A coordinator-supplied decisions object is not a receipt. Question ids are runId:decisionId.
//
// Wanted ids = required `questions` (every one must be answered) plus `optionalIds`
// (decidedForYou overrides: accepted when answered, never required).
//
// Batch rule: an ask_user_question call counts as a receipt only when EVERY question id it asked
// is a wanted id of this run (no foreign ids). Answers may therefore arrive across several such
// calls; a later answer for the same id replaces an earlier one. Calls mixing in unrelated ids,
// error results and blank answers never count.
//
// KEEP_DECISION ('__keep__', from decision-model.mjs) means "keep what was decided for you": for an
// optional id it withdraws any earlier override (the id is absent from the result, so the recipe
// keeps its own decision and never sees the sentinel). For a REQUIRED id it is not an answer.
export function verifiedDecisions(events, runId, questions, optionalIds = []) {
  const calls = new Set();
  const found = {};
  const prefix = `${runId}:`;
  const wanted = new Set([...(questions || []).map(q => q.id), ...(Array.isArray(optionalIds) ? optionalIds : [])].map(id => `${prefix}${id}`));
  for (const event of events || []) {
    const d = event.data || {};
    if (event.type === 'tool/call' && d.name === 'ask_user_question') {
      const args = typeof d.arguments === 'string' ? (() => { try { return JSON.parse(d.arguments); } catch { return {}; } })() : d.arguments;
      const ids = Array.isArray(args?.questions) ? args.questions.map(q => q?.id) : [];
      if (ids.length > 0 && ids.every(id => typeof id === 'string' && wanted.has(id))) calls.add(d.callId);
    }
    const message = d.message;
    if (event.type !== 'tool/result' || message?.role !== 'tool' || message.source?.kind !== 'tool'
      || message.isError || message.toolCallId !== message.source.callId || !calls.has(message.source.callId)) continue;
    for (const content of message.content || []) {
        if (content.type !== 'text') continue;
        let body; try { body = JSON.parse(content.text); } catch { continue; }
        for (const answer of body?.answers || []) {
          if (typeof answer?.id !== 'string' || !wanted.has(answer.id)) continue;
          const text = typeof answer.custom === 'string' && answer.custom.trim() ? answer.custom.trim() : (Array.isArray(answer.selected) ? answer.selected : []).join('; ');
          const id = answer.id.slice(prefix.length);
          if (text.trim() === KEEP_DECISION) delete found[id];
          else if (text.trim()) found[id] = text.trim();
        }
    }
  }
  for (const q of questions || []) if (!found[q.id]) throw new Error(`No verified human answer for decision "${q.id}"; ask_user_question must use id ${runId}:${q.id}`);
  return found;
}
