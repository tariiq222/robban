// Durable run-event contract shared by the server (writer) and the web client (reader).
//
// Every event is appended to the PARENT (coordinator) session with { ignorable: true }, so older
// DSH builds and other clients skip it safely, and the chat card is a pure replay of the log:
// history paging, live follow and a page reload all rebuild the same card.
//
// All payloads are plain JSON, small, and carry `runId`. Event types are namespaced.

export const EVENT = Object.freeze({
  RUN_START: 'auto-recipe/run-start',   // { runId, recipe, title, task, repo, resumed, round, routes }
  AGENT_START: 'auto-recipe/agent-start', // { runId, seq, label, phase, childId, role, round, provider, model, tier }
  AGENT_END: 'auto-recipe/agent-end',   // { runId, seq, outcome, verdict?, findings?, summary? }
  STATUS: 'auto-recipe/status',         // { runId, stage, state, note? }   coarse stage progress
  DECISION: 'auto-recipe/decision',     // { runId, resumeId, questions[], decidedForYou[], currentState? }
  RUN_END: 'auto-recipe/run-end',       // { runId, status, stage?, changedPaths?, passed?, reviewTrail?, error? }
});
export const EVENT_TYPES = Object.freeze(Object.values(EVENT));

// Recipe phase → stage shown on the card's strip.
export const STAGES = Object.freeze([
  { id: 'analysis', phases: ['setup', 'analysis'] },
  { id: 'decision', phases: [] },
  { id: 'design', phases: ['requirements', 'design-loop', 'plan'] },
  { id: 'build', phases: [] },
  { id: 'review', phases: [] },
  { id: 'validate', phases: ['validate'] },
]);

// Agent label (as passed to agent({label})) → node role in the card graph.
// Labels look like "setup", "design-draft #2", "implement #1", "review-1 #2", "aggregate #1".
export function roleOfLabel(label) {
  const base = String(label ?? '').replace(/\s*#\d+$/, '');
  if (['setup', 'analysis', 'requirements', 'plan', 'validate', 'scope', 'gather', 'check', 'evidence', 'packages', 'verify', 'baseline', 'scan-security', 'scan-correctness', 'quick-spec'].includes(base)) return base;
  if (base === 'design-draft') return 'draft';
  if (base === 'design-review') return 'dreview';
  if (base === 'implement' || base === 'fault-injector') return 'implement';
  if (base === 'aggregate') return 'aggregate';
  const reviewer = /^review-(\d+)$/.exec(base);
  if (reviewer) return `r${reviewer[1]}`;
  return 'other';
}
export function roundOfLabel(label) {
  const m = /#(\d+)$/.exec(String(label ?? ''));
  return m ? Number(m[1]) : 1;
}

// Keep payloads small: findings are summarized, long strings clipped.
const clip = (value, max) => (typeof value === 'string' && value.length > max ? `${value.slice(0, max - 1)}…` : value);
export function compactFindings(findings, max = 6) {
  if (!Array.isArray(findings)) return [];
  return findings.slice(0, max).map(f => ({ severity: String(f?.severity ?? 'medium'), problem: clip(String(f?.problem ?? ''), 240) }));
}
export function compactQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map(q => ({
    id: String(q.id),
    question: clip(String(q.question ?? ''), 400),
    current: clip(String(q.current ?? ''), 400),
    recommendation: clip(String(q.recommendation ?? ''), 300),
    options: Array.isArray(q.options) ? q.options.map(o => ({ label: String(o?.label ?? o ?? ''), consequence: String(o?.consequence ?? '') })) : [], // answer values must never be truncated
  }));
}
export function compactDecided(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map(d => ({ id: String(d.id), decision: clip(String(d.recommendation ?? d.decision ?? ''), 200) }));
}
