// Pure fold: durable `auto-recipe/*` events → the card's view model. No DOM, no React, no clock.
// The browser bundle inlines this module verbatim (see build.mjs); tests import it directly.
//
// State is immutable-by-convention: every reducer returns a new object.

export const STAGE_ORDER = ['analysis', 'decision', 'design', 'build', 'review', 'validate'];
export const STAGE_NODES = {
  analysis: ['setup', 'analysis'],
  decision: ['decision'],
  design: ['requirements', 'draft', 'dreview', 'plan'],
  build: ['implement'],
  review: ['r1', 'r2', 'aggregate'],
  validate: ['validate'],
};
const NODE_STAGE = Object.fromEntries(Object.entries(STAGE_NODES).flatMap(([s, ns]) => ns.map(n => [n, s])));
export const stageOfNode = role => (Object.hasOwn(NODE_STAGE, role) ? NODE_STAGE[role] : undefined) ?? (/^r\d+$/.test(role) ? 'review' : ['scan-security', 'scan-correctness'].includes(role) ? 'scans' : role === 'quick-spec' ? 'design' : role);

// Non-feature recipes intentionally use ordered stage groups, not invented dependency graphs.
// Unknown recipes only show phases actually observed in their durable events.
export const RECIPE_STAGE_ORDER = {
  'feature-pipeline': STAGE_ORDER,
  'bug-fix': ['analysis', 'decision', 'build', 'review', 'validate'],
  'code-audit': ['scope', 'scans', 'verify'],
  investigate: ['scope', 'gather', 'check'],
  'qa-verify': ['analysis', 'verify', 'check'],
  'plan-to-packages': ['evidence', 'packages', 'check'],
  refactor: ['analysis', 'baseline', 'build', 'review', 'validate'],
};
export function isFeatureRecipe(state) { return !state.recipe || state.recipe === 'feature-pipeline'; }
export function nodeKey(agent) { return agent.role && agent.role !== 'other' ? agent.role : 'agent:' + agent.seq; }
export function agentStage(state, agent) {
  if (isFeatureRecipe(state)) return stageOfNode(agent.role);
  const roleStage = stageOfNode(agent.role);
  // code-loop contains both implementation and review; labels distinguish them.
  if (agent.phase === 'code-loop') return roleStage === 'review' ? 'review' : 'build';
  if (agent.phase === 'setup') return 'analysis';
  return agent.phase || (agent.role === 'other' ? 'agents' : roleStage);
}
export function stageOrderOf(state) {
  if (isFeatureRecipe(state)) return STAGE_ORDER;
  const order = [...(Object.hasOwn(RECIPE_STAGE_ORDER, state.recipe) ? RECIPE_STAGE_ORDER[state.recipe] : [])];
  const observed = [...(state.phases || []), ...state.agents.map(a => agentStage(state, a))];
  for (let id of observed) {
    if (id === 'setup') id = 'analysis';
    if (id === 'code-loop') id = 'build';
    if (id && !order.includes(id)) order.push(id);
  }
  if (state.decision && !order.includes('decision')) order.push('decision');
  return order;
}
export function nodeKeysForStage(state, stage) {
  const { latest } = nodesOf(state);
  if (isFeatureRecipe(state)) return [...new Set([...(STAGE_NODES[stage] || []), ...Object.keys(latest).filter(key => stageOfNode(latest[key].role) === stage)])];
  return Object.keys(latest).filter(key => agentStage(state, latest[key]) === stage);
}

export function initialState(start) {
  return {
    runId: start.runId,
    recipe: start.recipe,
    title: start.title || start.recipe,
    task: start.task || '',
    repo: start.repo || '',
    resumed: !!start.resumed,
    round: start.round ?? 0,
    routes: start.routes || {},
    notes: start.notes || [],
    startedAt: start.at ?? null,
    endedAt: null,
    status: 'running',          // running | needs_decision | completed | completed_with_failures | ended | aborted | error | cancelled
    agents: [],                 // { seq, label, role, round, childId, provider, model, tier, outcome?, verdict?, findings?, summary?, startedAt?, endedAt? }
    phase: null,
    phases: [],                 // observed phase history, for forward-compatible generic cards
    decision: null,             // { resumeId, stage, questions, decidedForYou, currentState }
    result: null,               // run-end payload
  };
}

const withAgent = (state, seq, label, patch) => {
  let found = false;
  const agents = state.agents.map(a => {
    if ((seq != null && a.seq === seq) || (seq == null && label && a.label === label)) { found = true; return { ...a, ...patch }; }
    return a;
  });
  return found ? { ...state, agents } : state;
};

/** Apply one durable event (type, data, at?) to the state. Unknown types are ignored. */
export function reduce(state, type, data, at) {
  switch (type) {
    case 'auto-recipe/status':
      return { ...state, phase: data.phase ?? data.stage ?? state.phase,
        phases: [...new Set([...(state.phases || []), data.phase ?? data.stage].filter(Boolean))] };
    case 'auto-recipe/agent-start':
      if (state.agents.some(a => a.seq === data.seq)) return state;
      return { ...state, agents: [...state.agents, {
        seq: data.seq, label: data.label, role: data.role, phase: data.phase ?? null, round: data.round ?? 1, childId: data.childId,
        provider: data.provider, model: data.model, tier: data.tier, startedAt: at ?? null,
      }] };
    case 'auto-recipe/agent-end': {
      const patch = {};
      if (!data.annotate) { patch.outcome = data.outcome; patch.endedAt = at ?? null; }
      if (data.verdict) patch.verdict = data.verdict;
      if (data.findings) patch.findings = data.findings;
      if (data.summary) patch.summary = data.summary;
      if (data.provider) patch.provider = data.provider;
      if (data.model) patch.model = data.model;
      return withAgent(state, data.seq ?? null, data.label, patch);
    }
    case 'auto-recipe/decision':
      return { ...state, decision: { resumeId: data.resumeId, stage: data.stage, questions: data.questions || [], decidedForYou: data.decidedForYou || [], currentState: data.currentState || '' } };
    case 'auto-recipe/run-end':
      return { ...state, status: data.status || 'completed', result: data, endedAt: at ?? null,
        agents: state.agents.map(a => a.outcome === undefined ? { ...a, outcome: data.status === 'cancelled' ? 'cancelled' : 'failed', endedAt: at ?? null } : a),
      };
    default:
      return state;
  }
}

// ── derived view ────────────────────────────────────────────────────────────

/** Latest attempt of each graph node (highest round wins), plus the full history per node. */
export function nodesOf(state) {
  const latest = Object.create(null);
  const history = Object.create(null);
  for (const a of state.agents) {
    const key = nodeKey(a);
    (history[key] ||= []).push(a);
    if (!latest[key] || a.round >= latest[key].round) latest[key] = a;
  }
  return { latest, history };
}

export function nodeState(agent) {
  if (!agent) return 'pending';
  if (agent.outcome === undefined) return 'active';
  if (agent.outcome !== 'completed') return 'failed';
  if (agent.verdict === 'no' || agent.verdict === 'failed') return 'failed';
  return 'done';
}

export function codeRounds(state) {
  return state.agents.filter(a => a.role === 'implement').reduce((m, a) => Math.max(m, a.round), 0);
}

/** Stage strip: one of done | active | pending | failed | decision per stage, plus a short sub-label. */
export function stagesOf(state) {
  if (!isFeatureRecipe(state)) return genericStagesOf(state);
  const { latest } = nodesOf(state);
  const st = role => nodeState(latest[role]);
  const anyOf = roles => roles.map(st);
  const reviewerRoles = Object.keys(latest).filter(r => /^r\d+$/.test(r));
  const finished = ['completed', 'completed_with_failures', 'ended', 'aborted'].includes(state.status);
  const out = {};
  const fold = list => list.includes('active') ? 'active' : list.includes('failed') ? 'failed' : list.every(s => s === 'pending') ? 'pending' : list.every(s => s === 'done' || s === 'pending') && list.includes('done') ? (list.includes('pending') ? 'active' : 'done') : 'active';

  out.analysis = { state: state.resumed ? 'done' : fold(anyOf(['setup', 'analysis'])) };
  if (state.decision && state.status === 'needs_decision') out.decision = { state: 'decision', sub: state.decision.questions.length };
  else if (state.resumed || latest.requirements) out.decision = { state: 'done' };
  else out.decision = { state: out.analysis.state === 'done' && !finished ? 'pending' : out.analysis.state === 'done' ? 'done' : 'pending' };

  out.design = { state: fold(anyOf(['requirements', 'draft', 'dreview', 'plan'])) };
  // after the design is done, any later stage starting means design is fully done
  if (latest.implement && out.design.state !== 'failed') out.design.state = 'done';

  const rounds = codeRounds(state);
  out.build = { state: st('implement'), rounds };
  const reviewStates = [...reviewerRoles.map(st), st('aggregate')];
  out.review = { state: reviewStates.every(s => s === 'pending') ? 'pending' : fold(reviewStates), rounds };
  // a newer implement round means the previous review round already ended (in repair)
  if (out.build.state === 'active' && rounds > 1 && latest.aggregate && latest.aggregate.round < rounds) out.review.state = 'failed';
  out.validate = { state: st('validate') };

  if (finished && state.status !== 'aborted') {
    for (const k of STAGE_ORDER) if (out[k].state === 'active') out[k].state = 'done';
  }
  if (state.status === 'aborted') { out.build.state = 'failed'; out.review.state = 'failed'; }
  return out;
}

function genericStagesOf(state) {
  const { latest } = nodesOf(state), out = Object.create(null);
  const running = state.status === 'running';
  const phase = state.phase === 'setup' ? 'analysis' : state.phase === 'code-loop' ? 'build' : state.phase;
  for (const id of stageOrderOf(state)) {
    const agents = nodeKeysForStage(state, id).map(key => latest[key]);
    const states = agents.map(nodeState);
    let status = states.includes('active') ? 'active' : states.includes('failed') ? 'failed' : states.length ? 'done' : running && phase === id ? 'active' : 'pending';
    if (id === 'analysis' && state.resumed && !agents.length) status = 'done';
    if (id === 'decision') status = state.status === 'needs_decision' ? 'decision' : state.resumed || codeRounds(state) ? 'done' : 'pending';
    out[id] = { state: status, ...(id === 'decision' ? { sub: state.decision?.questions.length || 0 } : {}), ...(['build', 'review'].includes(id) ? { rounds: codeRounds(state) } : {}) };
  }
  return out;
}

export function headline(state) {
  switch (state.status) {
    case 'needs_decision': return 'decision';
    case 'completed': return 'done';
    case 'ended': return 'done';
    case 'completed_with_failures':
    case 'aborted':
    case 'error': return 'failed';
    case 'cancelled': return 'failed';
    default: {
      const { latest } = nodesOf(state);
      return codeRounds(state) > 1 && nodeState(latest.implement) === 'active' ? 'repair' : 'running';
    }
  }
}

/** Duration label: m:ss under an hour, h:mm:ss from one hour on; '' for invalid input. */
export function fmtDuration(ms) {
  if (!(ms >= 0)) return '';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const RTL_LANGS = ['ar', 'he', 'fa', 'ur', 'ps', 'ku', 'yi', 'dv'];
/** 'rtl' | 'ltr' for a BCP 47 locale id; undefined when no locale is known. */
export function dirOfLocale(locale) {
  if (typeof locale !== 'string' || !locale) return undefined;
  return RTL_LANGS.includes(locale.toLowerCase().split(/[-_]/)[0]) ? 'rtl' : 'ltr';
}
/** Card direction: active DSH locale first, then the document's dir/lang, else ltr. */
export function cardDir(locale, doc) {
  const fromLocale = dirOfLocale(locale);
  if (fromLocale) return fromLocale;
  const root = doc && doc.documentElement;
  if (root && (root.dir === 'rtl' || root.dir === 'ltr')) return root.dir;
  return (root && dirOfLocale(root.lang)) || 'ltr';
}

export function runningAgents(state) {
  return state.agents.filter(a => a.outcome === undefined);
}
