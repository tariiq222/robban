// Turns one workflow run's engine events into durable `auto-recipe/*` session events on the
// parent (coordinator) session, so the web card is a pure replay of the session log.
//
// Inputs:
//   - workflow/agent-start, workflow/agent-end   (engine events, filtered by run id)
//   - workflow/phase                              (stage progress)
//   - workflow/log lines prefixed "@@auto-recipe " (structured verdict/summary signals from the recipe)
// The tracker never throws into the run: a failed append is logged once and tracking stops.
import { EVENT, roleOfLabel, roundOfLabel, compactFindings } from './events.mjs';

const SIGNAL = '@@auto-recipe ';

// Phase title → coarse card stage.
const PHASE_STAGE = { setup: 'analysis', analysis: 'analysis', requirements: 'design', 'design-loop': 'design', plan: 'design', 'code-loop': 'build', validate: 'validate' };

export function parseSignal(message) {
  if (typeof message !== 'string' || !message.startsWith(SIGNAL)) return undefined;
  try {
    const value = JSON.parse(message.slice(SIGNAL.length));
    return value && typeof value === 'object' && typeof value.kind === 'string' ? value : undefined;
  } catch { return undefined; }
}

export class RunTracker {
  /**
   * @param {{ session: { append(type: string, data: unknown, opts?: object): unknown } }} parent
   * @param {string} runId   our own durable id (stable across the card's lifetime)
   * @param {object} routes  role → {provider, model}; reviewers → [{label, provider, model}]
   * @param {(msg: string) => void} warn
   */
  constructor(parent, runId, routes, warn = () => {}) {
    this.parent = parent;
    this.runId = runId;
    this.routes = routes || {};
    this.warn = warn;
    this.engineRunId = undefined;
    this.broken = false;
    this.seqByLabel = new Map();
    // Latest resumable state emitted by the recipe (kind=checkpoint). Never written to the session log.
    this.checkpoint = undefined;
  }
  append(type, data) {
    if (this.broken) return;
    try { this.parent.session.append(type, { runId: this.runId, ...data }, { ignorable: true }); }
    catch (error) { this.broken = true; this.warn(`auto-recipe: stopped recording run ${this.runId}: ${String(error)}`); }
  }
  routeFor(role, label) {
    if (/^r\d+$/.test(role)) {
      const base = String(label).replace(/\s*#\d+$/, '');
      const reviewer = (this.routes.reviewers || []).find(r => r.label === base);
      return reviewer ? { provider: reviewer.provider, model: reviewer.model, tier: 'strong' } : undefined;
    }
    const key = role === 'draft' ? 'design' : role === 'dreview' ? 'designReview' : role === 'implement' ? 'implementer' : role;
    const route = this.routes[key];
    return route ? { provider: route.provider, model: route.model, tier: route.tier } : undefined;
  }
  bind(engineRunId) { this.engineRunId = engineRunId; }
  owns(info) { return this.engineRunId !== undefined && info?.id === this.engineRunId; }

  onPhase(info, title) {
    if (!this.owns(info)) return;
    if (typeof title !== 'string' || !title.trim()) return;
    const stage = Object.hasOwn(PHASE_STAGE, title) ? PHASE_STAGE[title] : title;
    this.append(EVENT.STATUS, { stage, state: 'active', phase: title });
  }
  onAgentStart(info, agent) {
    if (!this.owns(info)) return;
    const role = roleOfLabel(agent.label);
    this.seqByLabel.set(agent.label, agent.seq);
    const actual = this.actualRouteFor?.(String(agent.childId));
    const route = actual ? { provider: actual.provider, model: actual.model, tier: actual.tier } : this.routeFor(role, agent.label);
    this.append(EVENT.AGENT_START, {
      seq: agent.seq, label: String(agent.label), phase: agent.phase ?? null, childId: String(agent.childId),
      role, round: roundOfLabel(agent.label), ...(route || {}),
    });
  }
  onAgentEnd(info, agent) {
    if (!this.owns(info)) return;
    this.append(EVENT.AGENT_END, { seq: agent.seq, outcome: agent.outcome });
  }
  onLog(info, message) {
    if (!this.owns(info)) return;
    const sig = parseSignal(message);
    if (!sig) return;
    if (sig.kind === 'checkpoint') {
      if (sig.state && typeof sig.state === 'object' && !Array.isArray(sig.state)) this.checkpoint = sig.state;
      return;
    }
    const seq = this.seqByLabel.get(sig.label);
    if (sig.kind === 'verdict') {
      this.append(EVENT.AGENT_END, {
        seq: seq ?? null, label: String(sig.label), verdict: sig.verdict === 'APPROVED' ? 'ok' : sig.verdict === 'FAILED' ? 'failed' : 'no',
        findings: compactFindings(sig.findings), ...(sig.round ? { round: sig.round } : {}), annotate: true,
      });
    } else if (sig.kind === 'summary') {
      this.append(EVENT.AGENT_END, { seq: seq ?? null, label: String(sig.label), summary: String(sig.summary).slice(0, 300), annotate: true });
    }
  }
}
