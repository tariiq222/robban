// feature-pipeline recipe for the DSH `workflow` tool.
// Plain JS body (top-level await). Hooks provided by the runtime: agent, parallel, phase, log, args.
//
// Flow:
//   run 1:  setup → scoped analysis (only the area being changed) → decision brief
//           • brief has user decisions        → returns status "needs_decision" + resume
//           • analysis says nothing to do     → returns status "ended"
//           • nothing needs the user          → continues straight on
//   run 2+: (args.resume + args.decisions) skips setup and analysis, then
//           requirements → design loop → plan → code loop (parallel reviews) → validate
//   After the brief only HIGH-RISK decisions stop the run (security, deletion, a contract other
//   code depends on). One follow-up round is allowed for branches opened by the user's own choice.
//
// args:
//   task                 (required) the change request, in natural language
//   repo                 (required) absolute path of the repository
//   decisions            (optional) { "<decision id>": "<answer>" } answers to the brief
//   resume               (optional) the `resume` object returned by a previous needs_decision result
//   maxDesignIterations  (optional, default 3)
//   maxCodeIterations    (optional, default 3)
//   reviewers            (optional) [{ label, provider?, model? }] independent parallel code reviewers
//   implementer          (optional) { provider?, model? } route for the coder
//   routes               (set by run_recipe) { setup, analysis, requirements, design, designReview, plan,
//                        implementer, aggregate, validate: {provider, model}, reviewers: [{label, provider, model}] }
//   fastPath             (default true) 1..2 concrete scoped file paths (no directories, globs, . or ..),
//                        no needs_user/open/pending decisions
//   earlyValidate        (default true) validate beside reviewers; discard on rejection
//   useAggregator        (default false) optional agent merge, always safety-gated
//   stepTimeoutMs        (optional) positive milliseconds or role/label map, carried in private marker
//   cachedSetup          (internal) manifest-keyed, schema-validated setup cache
//   abortIfUnapproved    (optional, default true) stop when a loop hits its limit unapproved
//   faultInjection       (TEST ONLY, default off) { keepTestsGreen?: true } plant one bug after the
//                        first implementation to prove reviewers catch it and the repair loop fixes it

// run_recipe's private provider resolves the model at EACH child admission, not up front.
const invokeAgent = (prompt, opts) => {
  const base = String(opts?.label || '').replace(/\s*#\d+$/, '');
  const role = base === 'quick-spec' ? 'requirements' : base === 'design-draft' ? 'design' : base === 'design-review' ? 'designReview' : base === 'implement' || base === 'fault-injector' ? 'implementer' : /^review(?:-|$)/.test(base) ? 'reviewer' : base;
  const defaults = { setup: 180000, analysis: 360000, requirements: 300000, plan: 300000, design: 360000, designReview: 360000, implementer: 1200000, reviewer: 600000, aggregate: 300000, validate: 480000 };
  const configured = typeof args.stepTimeoutMs === 'number' ? args.stepTimeoutMs : args.stepTimeoutMs?.[base] ?? args.stepTimeoutMs?.[role];
  const timeoutMs = Number.isSafeInteger(configured) && configured > 0 ? configured : defaults[role];
  // This engine rejects timeoutMs/signal in agent() opts. The authenticated marker bridges
  // the per-attempt timeout to the private routing provider without changing engine options.
  if (!args.routingToken) return agent(prompt, opts);
  return agent('__AUTO_RECIPE_ROLE__' + JSON.stringify({token: args.routingToken, role, label: opts.label, timeoutMs}) + '\n' + prompt, opts);
};

const task = typeof args?.task === 'string' ? args.task.trim() : '';
const repo = typeof args?.repo === 'string' ? args.repo.trim() : '';
if (!task) throw new Error('args.task is required');
if (!repo) throw new Error('args.repo is required (absolute repository path)');

const maxDesign = Number.isInteger(args.maxDesignIterations) && args.maxDesignIterations > 0 ? args.maxDesignIterations : 3;
const maxCode = Number.isInteger(args.maxCodeIterations) && args.maxCodeIterations > 0 ? args.maxCodeIterations : 3;
const abortIfUnapproved = args.abortIfUnapproved !== false;
// Per-role routes injected by run_recipe from saved Subagent settings (by tier). When absent
// (direct workflow use), explicit reviewers/implementer args or the parent route apply.
const routes = args.routes && typeof args.routes === 'object' ? args.routes : {};
const R = role => route(routes[role]);
const reviewers = Array.isArray(routes.reviewers) && routes.reviewers.length > 0
  ? routes.reviewers
  : Array.isArray(args.reviewers) && args.reviewers.length > 0
    ? args.reviewers
    : [{ label: 'review-a' }, { label: 'review-b' }];
const implementer = routes.implementer ?? (args.implementer && typeof args.implementer === 'object' ? args.implementer : {});
// TEST-ONLY: { keepTestsGreen?: boolean } plants one bug after implement #1 to exercise the repair loop.
const faultInjection = args.faultInjection && typeof args.faultInjection === 'object' ? args.faultInjection : null;
let injectedFault = null;
// A resume must belong to the same task/repo, otherwise its analysis would describe another change.
const resume = args.resume && typeof args.resume === 'object' ? args.resume : null;
if (resume && (resume.task !== task || resume.repo !== repo || !resume.setup || !resume.analysis)) {
  throw new Error('args.resume does not match this task/repo; start a fresh run without resume');
}
const round = resume && Number.isInteger(resume.round) ? resume.round : 0; // 0 = fresh run
const answerMap = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
// Explicit answers override persisted answers; invalid answers remain unresolved, never defaults.
const answers = { ...answerMap(resume?.confirmedDecisions), ...answerMap(args.decisions) };
const answered = id => Object.hasOwn(answers, id) && typeof answers[id] === 'string' && answers[id].trim().length > 0;
const decisionLedger = Array.isArray(resume?.decisionLedger) ? [...resume.decisionLedger] : [];
const rememberDecisions = (stage, list) => {
  for (const d of list || []) {
    const requiresAnswer = d.kind === 'needs_user' || d.kind === 'high_risk' || (d.kind === 'follow_up' && stage !== 'implement' && round <= 1);
    const entry = { ...d, stage, requiresAnswer };
    if (!decisionLedger.some(old => JSON.stringify(old) === JSON.stringify(entry))) decisionLedger.push(entry);
  }
};

const route = r => {
  const o = {};
  if (r && typeof r.provider === 'string' && r.provider) o.provider = r.provider;
  if (r && typeof r.model === 'string' && r.model) o.model = r.model;
  return o;
};

const COMMON = `Repository: ${repo}
Work only inside this repository. Do not commit, push, merge, deploy or delete branches.
Never fabricate evidence: if you did not run a command, say so.`;

// ── schemas ────────────────────────────────────────────────────────────────
const stringList = { type: 'array', items: { type: 'string' } };
const findingSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high', 'blocker'] },
    file: { type: 'string' },
    problem: { type: 'string' },
    requiredFix: { type: 'string' },
  },
  required: ['id', 'severity', 'problem', 'requiredFix'],
  additionalProperties: false,
};
const verdictSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'NEEDS_REVISION'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: findingSchema },
  },
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
};
const optionSchema = {
  type: 'object',
  properties: { label: { type: 'string' }, consequence: { type: 'string' } },
  required: ['label', 'consequence'],
  additionalProperties: false,
};
// Decision raised by the brief: what exists now, each option's consequence, a recommendation.
const briefDecisionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['needs_user', 'auto'] },
    question: { type: 'string' },
    current: { type: 'string' },
    options: { type: 'array', items: optionSchema },
    recommendation: { type: 'string' },
    why: { type: 'string' },
  },
  required: ['id', 'kind', 'question', 'current', 'options', 'recommendation', 'why'],
  additionalProperties: false,
};
// Decision raised after the brief. Only follow_up (first resume only) and high_risk stop the run.
const lateDecisionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['follow_up', 'high_risk', 'assumed'] },
    question: { type: 'string' },
    current: { type: 'string' },
    options: { type: 'array', items: optionSchema },
    recommendation: { type: 'string' },
    why: { type: 'string' },
  },
  required: ['id', 'kind', 'question', 'current', 'options', 'recommendation', 'why'],
  additionalProperties: false,
};
const designVerdictSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'NEEDS_REVISION'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: findingSchema },
    decisions: { type: 'array', items: lateDecisionSchema },
  },
  required: ['verdict', 'summary', 'findings', 'decisions'],
  additionalProperties: false,
};

// ── decision policies ──────────────────────────────────────────────────────
const BRIEF_POLICY = `Decision brief rules. Classify every open choice:
- "needs_user": the choice ADDS something new, CHANGES existing behavior/output, changes a contract
  that other code depends on, deletes something, touches security/permissions, adds a dependency,
  or widens/narrows scope.
- "auto": everything else, INCLUDING rare edge cases that no existing code depends on. Decide it
  yourself; it is still shown to the user, who may override it.
For each decision: a stable kebab-case id, the question, "current" (what the code does today, with
file:line evidence), options each with its concrete consequence, your recommendation and why.
Be exhaustive in this ONE pass: walk every input class, option combination, ordering and boundary
of the change now. The user answers once; anything you miss will be decided without them.`;

const LATE_POLICY = `The user already answered the decision brief. Do NOT reopen settled choices.
Classify any NEW choice you meet:
- "high_risk": security/permissions, deleting data or code, or changing a contract that OTHER code
  in this repository depends on. The run stops for these.
- "follow_up": a choice that exists only BECAUSE of an option the user picked and that changes
  visible behavior. ${round <= 1 ? 'Allowed in this round.' : 'Not allowed any more: use "assumed" instead.'}
- "assumed": everything else. Decide it yourself and record it.`;

const ANSWERS = Object.keys(answers).length
  ? `User-confirmed answers (binding):\n${Object.entries(answers).map(([k, v]) => `- [${k}] ${v}`).join('\n')}\n`
  : '';

// Structured progress signal for run_recipe's chat card (plain log line, prefixed; harmless elsewhere).
const signal = (kind, data) => log(`@@auto-recipe ${JSON.stringify({ kind, ...data })}`);

const history = [];
const record = (step, value) => { history.push({ step, value }); return value; };
const must = (value, step) => {
  if (value === null || value === undefined) throw new Error(`step "${step}" returned no structured output (the model may have ended without calling structured_output); one retry on another model is attempted when available; check Subagent settings tiers and the child failure details`);
  return value;
};
// Reviewer/validator failures (child start failure, timeout, missing output) are recorded as a
// missing result for the deterministic gates instead of ending the whole run.
const soft = async (step, run) => {
  try { return await run(); } catch (error) { log(`${step} failed: ${String(error?.message ?? error).slice(0, 300)}`); return null; }
};
const brief = d => ({ id: d.id, question: d.question, current: d.current, options: d.options, recommendation: d.recommendation, why: d.why });
const stopping = list => (list || []).filter(d => !answered(d.id) && (d.kind === 'high_risk' || (d.kind === 'follow_up' && round <= 1)));
const assumed = list => (list || []).filter(d => !answered(d.id) && !stopping([d]).length).map(d => ({ id: d.id, decision: d.recommendation }));
// Progress is saved only once requirements+design+plan are settled (savedProgress.plan). Earlier
// stops resume from the analysis so answers are folded into the spec; later stops resume from
// the last finished code iteration without redoing the spec.
let progress = resume?.progress && typeof resume.progress === 'object' && resume.progress.plan ? { ...resume.progress } : {};
const savedProgress = progress.plan ? progress : null;
const nextResume = (setup, analysis) => ({ task, repo, round: round + 1, setup, analysis, confirmedDecisions: { ...answers }, decisionLedger: [...decisionLedger], ...(progress.plan ? { progress: { ...progress } } : {}) });
// Durable checkpoint for run_recipe: lets it offer a resumeId if this run later errors, times out or is cancelled.
const checkpoint = () => signal('checkpoint', { state: nextResume(setup, analysis) });

// ── setup + scoped analysis (once; reused through resume) ──────────────────
let setup;
let analysis;
if (resume) {
  setup = resume.setup;
  analysis = resume.analysis;
  log(`resuming round ${round}: reusing setup and scoped analysis`);
} else if (args.cachedSetup && typeof args.cachedSetup.stack === 'string'
  && ['testCommands', 'lintCommands', 'conventions'].every(key => Array.isArray(args.cachedSetup[key]) && args.cachedSetup[key].every(item => typeof item === 'string'))
  && Object.keys(args.cachedSetup).every(key => ['stack', 'testCommands', 'lintCommands', 'conventions'].includes(key))) {
  setup = args.cachedSetup;
  log('setup reused from cache');
  record('setup', setup);
} else {
  phase('setup');
  setup = must(await invokeAgent(`${COMMON}

Inspect the repository read-only. Do not change any file.
Report: language/framework, package manager, exact test, lint and typecheck commands that exist
(read package.json / pyproject / Makefile etc. — never guess), and project conventions.

Task context: ${task}`, {
    label: 'setup', phase: 'setup', ...R('setup'),
    schema: {
      type: 'object',
      properties: { stack: { type: 'string' }, testCommands: stringList, lintCommands: stringList, conventions: stringList },
      required: ['stack', 'testCommands', 'lintCommands', 'conventions'],
      additionalProperties: false,
    },
  }), 'setup');
  record('setup', setup);
}

const CONTEXT = `${COMMON}
Stack: ${setup.stack}
Test commands: ${setup.testCommands.join(' ; ') || '(none found)'}
Lint/typecheck commands: ${setup.lintCommands.join(' ; ') || '(none found)'}
Conventions:
- ${setup.conventions.join('\n- ') || '(none)'}`;

if (!resume) {
  phase('analysis');
  analysis = must(await invokeAgent(`${CONTEXT}

Analyse ONLY the scope this request changes. Do not survey the rest of the repository.
Scope = the files/functions the request names or clearly implies, their DIRECT callers/importers
(one hop), and the tests that cover them. Change no files.

Report:
- scope: exactly which files, symbols, direct dependents and tests you inspected.
- currentState: what that code does today relative to the request (cite file:line).
- gaps: what the request needs that does not exist yet.
- outcome: "proceed"; "already_satisfied" if the code already does what is asked; or
  "not_recommended" if the change would break something or has no benefit (explain in outcomeReason).
- decisions: the decision brief.

${BRIEF_POLICY}
${ANSWERS}
Request: ${task}`, {
    label: 'analysis', phase: 'analysis', ...R('analysis'),
    schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'object',
          properties: { files: stringList, symbols: stringList, dependents: stringList, tests: stringList },
          required: ['files', 'symbols', 'dependents', 'tests'],
          additionalProperties: false,
        },
        currentState: { type: 'string' },
        gaps: stringList,
        outcome: { type: 'string', enum: ['proceed', 'already_satisfied', 'not_recommended'] },
        outcomeReason: { type: 'string' },
        decisions: { type: 'array', items: briefDecisionSchema },
      },
      required: ['scope', 'currentState', 'gaps', 'outcome', 'outcomeReason', 'decisions'],
      additionalProperties: false,
    },
  }), 'analysis');
  record('analysis', analysis);
  rememberDecisions('analysis', analysis.decisions);

  if (analysis.outcome !== 'proceed') {
    return {
      status: 'ended',
      outcome: analysis.outcome,
      reason: analysis.outcomeReason,
      currentState: analysis.currentState,
      scope: analysis.scope,
      note: 'Nothing was changed. To proceed anyway, re-run with args.resume and args.decisions.',
      resume: nextResume(setup, analysis),
    };
  }
}

// Re-check the original brief even on resume: unanswered choices must never use recommendations.
rememberDecisions('analysis', analysis.decisions);
const openBrief = analysis.decisions.filter(d => d.kind === 'needs_user' && !answered(d.id));
if (openBrief.length > 0) {
  return {
    status: 'needs_decision', stage: 'analysis', currentState: analysis.currentState,
    gaps: analysis.gaps, scope: analysis.scope, questions: openBrief.map(brief),
    decidedForYou: analysis.decisions.filter(d => d.kind === 'auto').map(brief),
    resume: nextResume(setup, analysis),
  };
}
// Older late questions remain binding if a later round no longer happens to report them.
const pendingDecisions = decisionLedger.filter(d => d.requiresAnswer && !answered(d.id));
if (pendingDecisions.length > 0) {
  return { status: 'needs_decision', stage: pendingDecisions[0].stage, questions: pendingDecisions.map(d => ({ ...brief(d), kind: d.kind })), resume: nextResume(setup, analysis) };
}

const BRIEF = `Scoped analysis (already done; do not repeat it):
Scope: files ${analysis.scope.files.join(', ')}; dependents ${analysis.scope.dependents.join(', ') || '(none)'}; tests ${analysis.scope.tests.join(', ') || '(none)'}
Current state: ${analysis.currentState}
Gaps:
- ${analysis.gaps.join('\n- ') || '(none)'}
Decisions:
${analysis.decisions.map(d => `- [${d.id}] ${d.question} → ${answers[d.id] ?? d.recommendation}`).join('\n') || '(none)'}`;

// ── requirements / bounded fast path ───────────────────────────────────────
const scopedFiles = analysis.scope.files;
const boundedFileCount = scopedFiles.length >= 1 && scopedFiles.length <= 2;
const concreteFiles = scopedFiles.every(file => typeof file === 'string' && file.trim().length > 0
  && file !== '.' && file !== '..' && !file.endsWith('/') && !/[*?[{]/.test(file));
const fastPath = savedProgress ? savedProgress.fastPath === true : args.fastPath !== false && boundedFileCount && concreteFiles
  && !analysis.decisions.some(d => d.kind === 'needs_user') && openBrief.length === 0 && pendingDecisions.length === 0;
if (savedProgress) log('resuming from saved plan: requirements, design and plan are reused');
if (!fastPath && !savedProgress) {
  const reasons = [];
  if (args.fastPath === false) reasons.push('disabled by fastPath:false');
  if (!boundedFileCount) reasons.push(`scope must contain 1–2 files (got ${scopedFiles.length})`);
  if (!concreteFiles) reasons.push('scope entries must be concrete files, not directories, globs, . or ..');
  if (analysis.decisions.some(d => d.kind === 'needs_user') || openBrief.length || pendingDecisions.length) reasons.push('user or pending decisions require full review');
  log(`fast path ineligible: ${reasons.join('; ')}; using full path`);
}
let quickSpec = null;
let requirements;
if (!savedProgress) phase('requirements');
if (savedProgress) {
  requirements = savedProgress.requirements;
  quickSpec = savedProgress.quickSpec ?? null;
} else if (fastPath) {
  log('fast path: combined requirements and plan; design review skipped');
  signal('status', { fastPath: true });
  quickSpec = must(await invokeAgent(`${CONTEXT}\n\n${BRIEF}\n\n${ANSWERS}\nRequest: ${task}\nProduce precise, testable acceptance criteria, exact existing verify commands, and an ordered implementation plan for ONLY the scoped files. Change nothing. Do not invent or widen decisions.`, {
    label: 'quick-spec', phase: 'requirements', ...R('requirements'),
    schema: { type: 'object', properties: { acceptance: stringList, verifyCommands: stringList, plan: { type: 'string' } }, required: ['acceptance', 'verifyCommands', 'plan'], additionalProperties: false },
  }), 'quick-spec');
  requirements = { goal: task, acceptance: quickSpec.acceptance, nonGoals: [], decisions: [] };
  record('quick-spec', quickSpec);
} else {
requirements = must(await invokeAgent(`${CONTEXT}

${BRIEF}

Turn the request, the analysis and the decisions above into precise, testable requirements.
Each acceptance criterion must be checkable by a command or by reading specific code. Change nothing.

${LATE_POLICY}
${ANSWERS}
Request: ${task}`, {
  label: 'requirements', phase: 'requirements', ...R('requirements'),
  schema: {
    type: 'object',
    properties: {
      goal: { type: 'string' },
      acceptance: stringList,
      nonGoals: stringList,
      decisions: { type: 'array', items: lateDecisionSchema },
    },
    required: ['goal', 'acceptance', 'nonGoals', 'decisions'],
    additionalProperties: false,
  },
}), 'requirements');
}
record('requirements', requirements);
rememberDecisions('requirements', requirements.decisions);
signal('summary', { label: 'requirements', summary: `${requirements.acceptance.length} acceptance criteria` });

const stopReq = stopping(requirements.decisions);
if (stopReq.length > 0) {
  return { status: 'needs_decision', stage: 'requirements', questions: stopReq.map(d => ({ ...brief(d), kind: d.kind })), decidedForYou: assumed(requirements.decisions), resume: nextResume(setup, analysis) };
}

const REQS = `Goal: ${requirements.goal}
Acceptance criteria:
${requirements.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}
Non-goals:
- ${requirements.nonGoals.join('\n- ') || '(none)'}
Recorded decisions (including prior rounds):
${decisionLedger.map(d => `- [${d.id}] ${answered(d.id) ? answers[d.id] : d.recommendation}`).join('\n') || '(none)'}
${ANSWERS}`;

// ── design loop ────────────────────────────────────────────────────────────
let design = savedProgress ? savedProgress.design ?? null : null;
let designReview = savedProgress ? savedProgress.designReview ?? null : null;
if (!fastPath && !savedProgress) {
phase('design-loop');
for (let i = 1; i <= maxDesign; i++) {
  const feedback = designReview && designReview.verdict !== 'APPROVED'
    ? `\nThe previous design was rejected. Fix every finding:\n${JSON.stringify(designReview.findings, null, 2)}\nPrevious design:\n${design}`
    : '';
  design = must(await invokeAgent(`${CONTEXT}

${BRIEF}

${REQS}

Write a technical design (markdown) for these requirements. Change no files.
Reuse existing modules; name every file to create or change and every dependent affected.${feedback}`,
  { label: `design-draft #${i}`, phase: 'design-loop', ...R('design') }), `design-draft #${i}`);

  designReview = must(await invokeAgent(`${CONTEXT}

${REQS}

You are an independent design reviewer. You did not write this design. Read the referenced code
to check it. Approve only if it satisfies every acceptance criterion, respects non-goals and the
recorded decisions, and reuses existing code instead of duplicating it.

${LATE_POLICY}
List in "decisions" only NEW choices this design makes that are not already recorded.

Design:
${design}`, { label: `design-review #${i}`, phase: 'design-loop', ...R('designReview'), schema: designVerdictSchema }), `design-review #${i}`);
  record(`design-review #${i}`, designReview);
  rememberDecisions('design', designReview.decisions);
  signal('verdict', { label: `design-review #${i}`, verdict: designReview.verdict, findings: designReview.findings });
  log(`design iteration ${i}: ${designReview.verdict}`);
  // Gate each review before either another draft or approval can erase its open choices.
  const stopDesign = stopping(designReview.decisions);
  if (stopDesign.length > 0) {
    return { status: 'needs_decision', stage: 'design', questions: stopDesign.map(d => ({ ...brief(d), kind: d.kind })), decidedForYou: assumed(designReview.decisions), resume: nextResume(setup, analysis) };
  }
  if (designReview.verdict === 'APPROVED') break;
}
if (designReview.verdict !== 'APPROVED' && abortIfUnapproved) {
  return { status: 'aborted', setup, fastPath, stage: 'design-loop', reason: `design not approved after ${maxDesign} iterations`, lastFindings: designReview.findings, note: 'Only continue after the user agrees: resume re-runs the design loop with a fresh budget.', resume: nextResume(setup, analysis) };
}

}

// ── plan ───────────────────────────────────────────────────────────────────
let plan;
if (savedProgress) {
  plan = savedProgress.plan;
} else if (fastPath) {
  plan = { steps: [{ title: 'Quick plan', files: analysis.scope.files, detail: quickSpec.plan }], inScope: analysis.scope.files, verifyCommands: quickSpec.verifyCommands };
} else {
phase('plan');
plan = must(await invokeAgent(`${CONTEXT}

${REQS}

Approved design:
${design}

Produce an ordered implementation plan. Change no files.`, {
  label: 'plan', phase: 'plan', ...R('plan'),
  schema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, files: stringList, detail: { type: 'string' } },
          required: ['title', 'files', 'detail'],
          additionalProperties: false,
        },
      },
      inScope: stringList,
      verifyCommands: stringList,
    },
    required: ['steps', 'inScope', 'verifyCommands'],
    additionalProperties: false,
  },
}), 'plan');
}
record('plan', plan);
if (!savedProgress) {
  progress = { fastPath, requirements, quickSpec, design, designReview, plan, codeDone: 0, lastFindings: [], changedPaths: [] };
  checkpoint();
}
signal('summary', { label: 'plan', summary: `${plan.steps.length} steps · ${plan.inScope.length} paths in scope` });

const PLAN = `Plan:
${plan.steps.map((s, i) => `${i + 1}. ${s.title} [${s.files.join(', ')}]\n   ${s.detail}`).join('\n')}
In-scope paths (change nothing else): ${plan.inScope.join(', ')}
Verify commands: ${plan.verifyCommands.join(' ; ')}`;

// The aggregator can add/merge findings, but cannot remove source rejection evidence.
const isBlocking = f => f.severity === 'high' || f.severity === 'blocker';
const unionFindings = list => {
  const union = new Map();
  const severity = { low: 0, medium: 1, high: 2, blocker: 3 };
  for (const f of list) {
    // IDs are reviewer-local: distinct problems with the same ID must survive.
    const key = JSON.stringify([f.file || '', f.problem, f.requiredFix]);
    const old = union.get(key);
    if (!old || severity[f.severity] > severity[old.severity]) union.set(key, f);
  }
  return [...union.values()];
};

const validate = () => soft('validate', () => invokeAgent(`${CONTEXT}\n\n${REQS}\n\nFinal validation. Do not edit files. For each acceptance criterion, check the current repository state\n(read code, run the relevant commands) and report pass/fail with concrete evidence.\nCopy each requirements acceptance string EXACTLY into "criterion", once each: no omitted, duplicate,\nrenamed or additional criteria.`, {
  label: 'validate', phase: 'validate', ...R('validate'),
  schema: {
    type: 'object', properties: {
      results: { type: 'array', items: { type: 'object', properties: {
        criterion: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed'] }, evidence: { type: 'string' },
      }, required: ['criterion', 'status', 'evidence'], additionalProperties: false } },
      summary: { type: 'string' },
    }, required: ['results', 'summary'], additionalProperties: false,
  },
}));
let earlyValidation = null;

// ── code loop ──────────────────────────────────────────────────────────────
phase('code-loop');
let impl = null;
const startIter = (progress.codeDone ?? 0) + 1;
const resumedFromRound = savedProgress ? startIter - 1 : null;
// A checkpoint taken after unanimous approval resumes straight at final validation.
const resumeApproved = progress.approved === true;
let codeVerdict = resumeApproved ? { verdict: 'APPROVED', summary: 'approved before interruption', findings: [] }
  : startIter > 1 ? { verdict: 'NEEDS_REVISION', summary: 'resumed', findings: progress.lastFindings || [] } : null;
if (resumeApproved) impl = { changedPaths: progress.changedPaths || [], commands: [], notes: 'resumed after approval', decisions: [] };
const RESUME_NOTE = savedProgress ? `\nThis run RESUMES earlier work that was interrupted or stopped. The working tree may already contain partial or complete edits for this plan: FIRST inspect \`git status\` and \`git diff\` of the in-scope paths and continue from that state or reconcile it. Do not redo work that is already correct and do not duplicate changes.` : '';
for (let i = startIter; i < startIter + maxCode && !resumeApproved; i++) {
  const fixes = codeVerdict && codeVerdict.verdict !== 'APPROVED'
    ? `\nThis is iteration ${i}. The previous implementation was rejected. Fix every finding below, then re-run verification:\n${JSON.stringify(codeVerdict.findings, null, 2)}`
    : '';
  impl = must(await invokeAgent(`${CONTEXT}

${REQS}

Approved design:
${design}

${PLAN}

Implement the plan. Change only in-scope paths. Run every verify command and report real results.
${LATE_POLICY}
If a NEW "high_risk" choice comes up, do not guess: leave it unimplemented and report it.${fixes}${i === startIter ? RESUME_NOTE : ''}`, {
    label: `implement #${i}`, phase: 'code-loop', ...route(implementer),
    schema: {
      type: 'object',
      properties: {
        changedPaths: stringList,
        commands: {
          type: 'array',
          items: {
            type: 'object',
            properties: { command: { type: 'string' }, passed: { type: 'boolean' }, evidence: { type: 'string' } },
            required: ['command', 'passed', 'evidence'],
            additionalProperties: false,
          },
        },
        notes: { type: 'string' },
        decisions: { type: 'array', items: lateDecisionSchema },
      },
      required: ['changedPaths', 'commands', 'notes', 'decisions'],
      additionalProperties: false,
    },
  }), `implement #${i}`);
  record(`implement #${i}`, impl);
  rememberDecisions('implement', impl.decisions);
  // Only high_risk stops the implementer; a follow_up here is downgraded to an assumption.
  const stopImpl = (impl.decisions || []).filter(d => d.kind === 'high_risk' && !answered(d.id));
  if (stopImpl.length > 0) {
    progress = { ...progress, codeDone: i - 1, lastFindings: codeVerdict?.findings || [], changedPaths: [...new Set([...(progress.changedPaths || []), ...impl.changedPaths])] };
    return { status: 'needs_decision', stage: 'implement', questions: stopImpl.map(d => ({ ...brief(d), kind: d.kind })), changedPaths: impl.changedPaths, note: 'Partial changes are in the working tree; the resumed implementer will inspect git status/diff first.', resume: nextResume(setup, analysis) };
  }
  // Implementation finished: checkpoint BEFORE reviews so a later failure resumes at review/repair, not from scratch.
  progress = { ...progress, codeDone: i - 1, approved: false, lastFindings: codeVerdict?.findings || [], changedPaths: [...new Set([...(progress.changedPaths || []), ...impl.changedPaths])] };
  checkpoint();

  // TEST-ONLY hook (off by default): plant one subtle bug after the FIRST implementation so the
  // review → repair loop is exercised. Reviewers are not told; the report is returned at the end.
  if (faultInjection && i === 1) {
    injectedFault = must(await invokeAgent(`${CONTEXT}

${REQS}

You are a fault injector used to test code reviewers. Edit ONLY ${impl.changedPaths.filter(p => !/test/i.test(p)).join(', ') || 'the source files'}
(never test files). Introduce exactly ONE subtle, realistic bug that violates one acceptance criterion
above${faultInjection.keepTestsGreen === false ? '' : ' but that the existing test suite does NOT catch (run the verify commands to confirm they still pass; if every bug you try is caught, keep the subtlest one)'}.
Do not add comments that reveal it. Report exactly what you changed.`, {
      label: 'fault-injector', phase: 'code-loop', ...route(implementer),
      schema: {
        type: 'object',
        properties: { file: { type: 'string' }, change: { type: 'string' }, violatedCriterion: { type: 'string' }, testsStillPass: { type: 'boolean' } },
        required: ['file', 'change', 'violatedCriterion', 'testsStillPass'],
        additionalProperties: false,
      },
    }), 'fault-injector');
    log(`fault injected in ${injectedFault.file}`);
  }

  const repairReview = i >= 2 ? `\nReview the changes since the previous iteration (git diff of the changed paths) and verify every previous finding below is fixed; also flag any new problem you notice in touched code.\nPrevious findings:\n${JSON.stringify(codeVerdict.findings, null, 2)}\nChanged paths: ${impl.changedPaths.join(', ')}` : '';
  const reviewTasks = reviewers.map(r => () => soft(`${r.label || 'review'} #${i}`, () => invokeAgent(`${CONTEXT}

${REQS}

${PLAN}

You are an independent code reviewer. You did not write this code; do not trust its author's report.
Inspect the actual changes (e.g. git diff) in: ${impl.changedPaths.join(', ')}
Re-run the verify commands yourself. Check correctness, every acceptance criterion, the recorded
decisions, scope (no changes outside in-scope paths), regressions in the dependents
(${analysis.scope.dependents.join(', ') || 'none'}), and tests. Do not edit files.
Severity: anything that violates an acceptance criterion or a recorded decision is at least "high",
even if the current tests pass. Return NEEDS_REVISION if you report any such finding.${repairReview}`, {
    label: `${r.label || 'review'} #${i}`, phase: 'code-loop', ...route(r), schema: verdictSchema,
  })));
  const parallelResults = await parallel([...reviewTasks, ...(args.earlyValidate !== false ? [validate] : [])]);
  const reviews = parallelResults.slice(0, reviewers.length);
  const candidateValidation = args.earlyValidate !== false ? parallelResults[reviewers.length] : null;
  const okReviews = reviews.filter(Boolean);
  reviews.forEach((v, idx) => signal('verdict', { label: `${reviewers[idx].label || `review-${idx + 1}`} #${i}`, verdict: v ? v.verdict : 'FAILED', findings: v ? v.findings : [] }));
  record(`reviews #${i}`, reviews.map((v, idx) => ({ reviewer: reviewers[idx].label || `review-${idx + 1}`, verdict: v ? v.verdict : 'FAILED', findings: v ? v.findings.map(f => `${f.severity}: ${f.problem}`) : [] })));
  const missingFindings = reviewers.flatMap((r, idx) => reviews[idx] ? [] : [{
    id: `missing-review-${idx + 1}`,
    severity: 'high',
    problem: `${r.label || `review-${idx + 1}`} did not return a review in iteration ${i}.`,
    requiredFix: `Re-run ${r.label || `review-${idx + 1}`} independently against the current changes and verify commands; obtain a complete review before approval.`,
  }]);

  const allFindings = unionFindings([...okReviews.flatMap(v => v.findings), ...missingFindings]);
  const unanimous = reviews.length === reviewers.length && okReviews.length === reviewers.length
    && okReviews.every(v => v.verdict === 'APPROVED') && !allFindings.some(isBlocking);
  codeVerdict = args.useAggregator !== true || okReviews.length === 0
    ? { verdict: unanimous ? 'APPROVED' : 'NEEDS_REVISION', summary: unanimous ? 'unanimous approval' : 'deterministic merge', findings: allFindings }
    : must(await invokeAgent(`You aggregate independent code reviews for ${repo}. Change no files.
Merge duplicate findings and keep the highest severity. Never drop a finding that a reviewer used to
justify NEEDS_REVISION. Verdict is APPROVED only if EVERY reviewer returned APPROVED, no remaining finding
is high or blocker, and no reviewer reported a failing verify command.
${reviews.length !== okReviews.length ? `Note: ${reviews.length - okReviews.length} reviewer(s) failed to report; be conservative.` : ''}

Reviews:
${JSON.stringify(okReviews, null, 2)}`, { label: `aggregate #${i}`, phase: 'code-loop', ...R('aggregate'), schema: verdictSchema }), `aggregate #${i}`);
  // Deterministic gate: missing/rejecting reviews and high/blocker findings are not votes.
  const rejectingReviews = okReviews.filter(v => v.verdict !== 'APPROVED');
  const preservedFindings = okReviews.flatMap(v => v.verdict !== 'APPROVED' ? v.findings : v.findings.filter(isBlocking));
  codeVerdict = { ...codeVerdict, findings: unionFindings([...preservedFindings, ...codeVerdict.findings, ...missingFindings]) };
  if (missingFindings.length > 0 || rejectingReviews.length > 0 || codeVerdict.findings.some(isBlocking)) {
    if (codeVerdict.verdict === 'APPROVED') log('aggregator approved without unanimous safe reviews: forcing NEEDS_REVISION');
    codeVerdict = { ...codeVerdict, verdict: 'NEEDS_REVISION', summary: `Safety gate: ${missingFindings.length} missing and ${rejectingReviews.length} rejecting reviewer(s); blocking findings cannot be overruled. ${codeVerdict.summary}` };
  }
  record(`aggregate #${i}`, codeVerdict);
  progress = { ...progress, codeDone: i, approved: codeVerdict.verdict === 'APPROVED', lastFindings: codeVerdict.verdict === 'APPROVED' ? [] : codeVerdict.findings };
  checkpoint();
  signal('verdict', { label: `aggregate #${i}`, verdict: codeVerdict.verdict, findings: codeVerdict.findings, round: i });
  log(`code iteration ${i}: ${codeVerdict.verdict} (${codeVerdict.findings.length} findings)`);
  if (codeVerdict.verdict === 'APPROVED') {
    earlyValidation = candidateValidation;
    break;
  }
  if (args.earlyValidate !== false) log('early validation discarded');
}

// Plain-JSON review trail (never undefined): survives into every result.
const reviewTrail = history
  .filter(h => h.step.startsWith('design-review') || h.step.startsWith('reviews') || h.step.startsWith('aggregate'))
  .map(h => Array.isArray(h.value)
    ? { step: h.step, reviewers: h.value }
    : { step: h.step, verdict: h.value.verdict, findings: h.value.findings.map(f => `${f.severity}: ${f.problem}`) });

if (codeVerdict.verdict !== 'APPROVED' && abortIfUnapproved) {
  return { status: 'aborted', setup, fastPath, ...(fastPath ? { designReview: 'skipped (fast path)' } : {}), stage: 'code-loop', reason: `code not approved after ${maxCode} iterations`, changedPaths: [...new Set([...(progress.changedPaths || []), ...impl.changedPaths])], reviewTrail, note: 'Changes remain uncommitted. Only continue after the user agrees: resume gives the repair loop a fresh round budget from the last findings.', resume: nextResume(setup, analysis), ...(injectedFault ? { injectedFault } : {}) };
}

// ── validate ───────────────────────────────────────────────────────────────
phase('validate');
const validation = earlyValidation ?? await validate();
const validationResults = validation?.results ?? [];

// Exact, duplicate-free coverage of the original strings is required, not a passing subset.
const expectedCriteria = new Set(requirements.acceptance);
const seenCriteria = new Set();
const coverageFailures = [];
const validationFailure = (criterion, evidence) => ({ criterion, status: 'failed', evidence });
if (requirements.acceptance.length === 0 || expectedCriteria.size !== requirements.acceptance.length) {
  coverageFailures.push(validationFailure('(requirements acceptance)', 'Requirements must contain nonempty, duplicate-free acceptance criteria.'));
}
for (const result of validationResults) {
  if (!expectedCriteria.has(result.criterion)) coverageFailures.push(validationFailure(result.criterion, 'Unknown criterion: validate only the exact requirements acceptance strings.'));
  if (seenCriteria.has(result.criterion)) coverageFailures.push(validationFailure(result.criterion, 'Duplicate criterion: report each acceptance string exactly once.'));
  seenCriteria.add(result.criterion);
}
for (const criterion of expectedCriteria) {
  if (!seenCriteria.has(criterion)) coverageFailures.push(validationFailure(criterion, 'Missing validation: check this acceptance criterion and report concrete evidence.'));
}
const approvalFailures = [];
if (!validation) approvalFailures.push(validationFailure('(validation)', 'The validator returned no structured result; rerun final validation before certification.'));
if (!fastPath && designReview.verdict !== 'APPROVED') approvalFailures.push(validationFailure('(design approval)', 'Obtain independent design approval; abortIfUnapproved=false permits continuation, not certification.'));
if (codeVerdict.verdict !== 'APPROVED') approvalFailures.push(validationFailure('(code approval)', 'Obtain unanimous safe independent code reviews before certification.'));
const failedCriteria = [...validationResults.filter(r => r.status !== 'passed'), ...coverageFailures, ...approvalFailures];
const allPassed = failedCriteria.length === 0;
const passedCount = requirements.acceptance.filter(criterion => {
  const matches = validationResults.filter(r => r.criterion === criterion);
  return matches.length === 1 && matches[0].status === 'passed';
}).length;
return {
  status: allPassed ? 'completed' : 'completed_with_failures',
  setup,
  fastPath,
  ...(fastPath ? { designReview: 'skipped (fast path)' } : {}),
  changedPaths: [...new Set([...(progress.changedPaths || []), ...impl.changedPaths])],
  passed: `${passedCount}/${requirements.acceptance.length}`,
  failedCriteria,
  validationSummary: validation?.summary ?? 'validation did not report',
  iterations: { design: history.filter(h => h.step.startsWith('design-review')).length, code: history.filter(h => h.step.startsWith('aggregate')).length, ...(savedProgress ? { resumedFromRound } : {}) },
  reviewTrail,
  ...(injectedFault ? { injectedFault } : {}),
  confirmedDecisions: answers,
  decisionLedger,
  assumptions: [
    ...analysis.decisions.filter(d => d.kind === 'auto' && !answered(d.id)).map(d => ({ id: d.id, decision: d.recommendation })),
    ...assumed(requirements.decisions),
    ...assumed(designReview?.decisions),
    // The implementer never stops for follow_up, so every non-high_risk choice is an assumption.
    ...(impl.decisions || []).filter(d => d.kind !== 'high_risk' && !answered(d.id)).map(d => ({ id: d.id, decision: d.recommendation })),
  ],
};
