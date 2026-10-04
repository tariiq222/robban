// Settings is the sole route directory. No provider/model IDs are embedded here.
export const routeKey = route => `${route.provider}\0${route.model}`;
const availabilityCodes = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'RATE_LIMIT', 'QUOTA', 'QUOTA_EXCEEDED', 'INSUFFICIENT_QUOTA', 'NO_ADAPTER', 'REGISTRATION_DISPOSED', 'UNKNOWN_MODEL', 'MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE', 'TIMEOUT', 'TRANSPORT', 'NETWORK', 'SERVER', 'EMPTY_RESPONSE', 'HTTP_402', 'HTTP_404']);
const neverRetryCodes = new Set(['ABORTED', 'CANCELLED', 'REFUSAL', 'INVALID_REQUEST', 'INVALID_REASONING_EFFORT', 'CONTEXT_WINDOW_EXCEEDED', 'TOOL_ERROR']);
export function isAvailabilityFailure(error) {
  const failure = error?.failure ?? error;
  if (!failure || typeof failure.code !== 'string' || neverRetryCodes.has(failure.code)) return false;
  if (availabilityCodes.has(failure.code)) return true;
  // pi-ai currently collapses model-not-found HTTP responses into PI_AI_ERROR.
  // Recognize only its structured 404 model error, not arbitrary task/tool text,
  // missing endpoints, invalid requests, or every generic pi-ai terminal failure.
  if (failure.code !== 'PI_AI_ERROR' || typeof failure.message !== 'string') return false;
  const response = /^404:\s*(\{.*\})\s*$/s.exec(failure.message);
  if (!response) return false;
  try {
    const body = JSON.parse(response[1]);
    return body?.type === 'not_found_error' && body?.code === 'not_found'
      && typeof body.message === 'string' && /^Model "[^"]+" does not exist\.$/.test(body.message);
  } catch { return false; }
}
export function routeConfig(config, route, reasoningEffort) {
  const { provider, model, reasoningEffort: oldEffort, ...rest } = config;
  return { ...rest, ...route, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}
// Tiers ordered weakest → strongest; selection escalates upward only.
export const MODEL_TIERS = ['light', 'medium', 'strong'];
const DEFAULT_TIER = 'medium';
export function tierOfRoute(route, modelTiers) {
  const entry = modelTiers?.find(tier => tier.provider === route.provider && tier.model === route.model);
  return MODEL_TIERS.includes(entry?.tier) ? entry.tier : DEFAULT_TIER;
}
export class AutoModelRouter {
  constructor(settings, llm, { now = Date.now, structuredFailureTtlMs = 30 * 60e3 } = {}) {
    this.now = now;
    this.structuredFailureTtlMs = structuredFailureTtlMs;
    // Bounded by the number of distinct routes (one entry per route key) and pruned on read
    // in byStructuredReliability, so it cannot grow without limit.
    this.structuredFailures = new Map();
    this.settings = settings;
    this.llm = llm;
    // Load-spreading counts and the executor-route registry live on the shared router
    // instance (automaticRouter keys it by the underlying settings service), so they are
    // global across every parent and every delegation in this process.
    //
    // Registry entries deliberately outlive a finished executor: a later `verifies`
    // delegation may name a child whose run already settled, so its last route must stay
    // known. The registry is therefore bounded only by the process/router lifetime, which
    // is the documented bound; it holds one small record per delegation this router made.
    this.activeCounts = new Map(); // routeKey -> number of active Auto children
    this.children = new Map();     // child id -> { route, token, statusDriven }
    this.childAliases = new Map(); // alias id (e.g. background job id) -> child id
  }
  routes() {
    const preference = this.settings.current();
    if (!preference.enabled) throw new Error('Auto Subagents model selection is disabled in saved Subagent settings; no inherited route is permitted.');
    if (!preference.allowedModels.length) throw new Error('Auto Subagents model list is empty; select and save at least one model.');
    const providers = new Set(this.llm.listProviders().map(provider => provider.id));
    const routes = preference.allowedModels.filter(route => providers.has(route.provider));
    if (!routes.length) throw new Error('Auto Subagents has no enabled provider for the saved model list.');
    return routes;
  }
  // Candidates of one tier, in saved allowedModels order (= priority when equally loaded).
  tierCandidates(routes, modelTiers, tier) {
    return routes.filter(route => tierOfRoute(route, modelTiers) === tier);
  }
  // ── load spreading ─────────────────────────────────────────────────────────
  activeCount(route) {
    return this.activeCounts.get(routeKey(route)) ?? 0;
  }
  // One load reservation on a route. Release is idempotent: several release points may
  // legitimately fire for the same reservation (tool settle path AND agent lifecycle
  // events), and exactly the first one counts — no leaks, no double decrements.
  reserve(route) {
    const key = routeKey(route);
    this.activeCounts.set(key, (this.activeCounts.get(key) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const count = this.activeCounts.get(key);
        if (count === undefined || count <= 1) this.activeCounts.delete(key);
        else this.activeCounts.set(key, count - 1);
      },
    };
  }
  // Least-loaded first. Array#sort is stable, so equal load keeps saved allowedModels
  // order: a single task always goes to the first model, concurrent tasks spread.
  byLeastLoaded(candidates) {
    return [...candidates].sort((x, y) => this.activeCount(x) - this.activeCount(y));
  }
  // Recipe-only reliability preference: never exclude a route or cross tier boundaries.
  markStructuredFailure(route) {
    this.structuredFailures.set(routeKey(route), this.now() + this.structuredFailureTtlMs);
  }
  byStructuredReliability(candidates) {
    const now = this.now();
    for (const [key, expires] of this.structuredFailures) if (expires <= now) this.structuredFailures.delete(key);
    return this.byLeastLoaded(candidates).sort((a, b) => Number(this.structuredFailures.has(routeKey(a))) - Number(this.structuredFailures.has(routeKey(b))));
  }
  // ── executor registry (agentId → current route) ────────────────────────────
  entryOf(id) {
    const canonical = this.children.has(id) ? id : this.childAliases.get(id);
    return canonical === undefined ? undefined : this.children.get(canonical);
  }
  // The delegation tool adopts its child here, handing over the selection's reservation.
  // `statusDriven` marks continuable children whose turns are released/reacquired by
  // agent status events; one-shot children are released by their own tool settle path.
  adoptChild(id, route, token, statusDriven = false) {
    this.children.set(id, { route: { ...route }, token: token ?? undefined, statusDriven });
  }
  aliasChild(alias, id) {
    if (this.children.has(id)) this.childAliases.set(alias, id);
  }
  // The executor's CURRENT route (after any mid-run switch), used by `verifies`.
  childRoute(id) {
    const entry = this.entryOf(id);
    return entry === undefined ? undefined : { ...entry.route };
  }
  // Mid-run route switch: move the child's reservation from the old route to the new one.
  switchChildRoute(id, route) {
    const entry = this.entryOf(id);
    if (entry === undefined) return;
    entry.token?.release();
    entry.token = this.reserve(route);
    entry.route = { ...route };
  }
  // A status-driven (continuable) child started or resumed a turn: count it again on its
  // current route. Children of other kinds and unknown ids are ignored.
  childTurnActive(id) {
    const entry = this.entryOf(id);
    if (entry?.statusDriven !== true || entry.token !== undefined) return;
    entry.token = this.reserve(entry.route);
  }
  // A status-driven child's turn settled (idle): stop counting it; the route record stays.
  childTurnIdle(id) {
    const entry = this.entryOf(id);
    if (entry?.statusDriven !== true) return;
    entry.token?.release();
    entry.token = undefined;
  }
  // Final safety net for every adopted child, continuable or one-shot. Releases the
  // reservation only; the route record deliberately survives for later `verifies`.
  childDisposed(id) {
    const canonical = this.children.has(id) ? id : this.childAliases.get(id);
    if (canonical === undefined) return;
    const entry = this.children.get(canonical);
    if (entry === undefined) return;
    entry.token?.release();
    entry.token = undefined;
  }
  async select(parent, request, signal) {
    signal.throwIfAborted();
    if ((request.provider === undefined) !== (request.model === undefined)) throw new Error('provider and model must be supplied together');
    const excluded = new Set((request.excludeRoutes ?? []).map(routeKey));
    const routes = this.routes().filter(route => !excluded.has(routeKey(route)));
    if (request.provider !== undefined) {
      const route = routes.find(candidate => candidate.provider === request.provider && candidate.model === request.model);
      if (!route) throw new Error('Explicit child model is not allowed by the current saved Subagent settings.');
      // Tier (and `verifies`) are ignored for an explicit route; the effective tier is the
      // route's own. The child still counts against its route for load spreading.
      const outcome = await this.attempt(route, tierOfRoute(route, this.settings.current().modelTiers), request.reasoning_effort, signal);
      if (outcome) return outcome;
      throw new Error('The explicit child model stopped being allowed while its availability was checked; retry the delegation.');
    }
    const requestedTier = MODEL_TIERS.includes(request.tier) ? request.tier : DEFAULT_TIER;
    const modelTiers = this.settings.current().modelTiers;
    const verifies = typeof request.verifies === 'string' && request.verifies.length > 0 ? request.verifies : undefined;
    const executorRoute = verifies === undefined ? undefined : this.childRoute(verifies);
    const verifiesKnown = executorRoute !== undefined;
    const executorKey = verifiesKnown ? routeKey(executorRoute) : undefined;
    // Upward-only escalation with least-loaded spreading inside each tier: start at the
    // requested tier and try each stronger tier; a request never degrades to a weaker
    // model. A caller's explicit reasoning effort applies only to the first attempted
    // route; escalation routes use the model's own default.
    let firstAttempt = true;
    const failures = [];
    for (let index = MODEL_TIERS.indexOf(requestedTier); index < MODEL_TIERS.length; index += 1) {
      const candidates = this.tierCandidates(routes, modelTiers, MODEL_TIERS[index]);
      const spreadable = verifiesKnown ? candidates.filter(route => routeKey(route) !== executorKey) : candidates;
      for (const route of request.preferStructured ? this.byStructuredReliability(spreadable) : this.byLeastLoaded(spreadable)) {
        const outcome = await this.attempt(route, requestedTier, firstAttempt ? request.reasoning_effort : undefined, signal, failures);
        firstAttempt = false;
        if (outcome) return this.withVerifies(outcome, verifies, verifiesKnown, executorRoute, false);
      }
    }
    // Last resort for `verifies`: the executor's own route. A verification delegation is
    // never failed merely because every other route was unusable, but the never-downgrade
    // rule still holds — the executor's route is used only within the requested-or-higher
    // tier ladder.
    if (verifiesKnown) {
      for (let index = MODEL_TIERS.indexOf(requestedTier); index < MODEL_TIERS.length; index += 1) {
        if (MODEL_TIERS[index] !== tierOfRoute(executorRoute, modelTiers)) continue;
        if (!routes.some(current => routeKey(current) === executorKey)) continue;
        const outcome = await this.attempt(executorRoute, requestedTier, firstAttempt ? request.reasoning_effort : undefined, signal, failures);
        firstAttempt = false;
        if (outcome) return this.withVerifies(outcome, verifies, verifiesKnown, executorRoute, true);
      }
    }
    throw new Error(`Auto Subagents found no usable "${requestedTier}" (or stronger) model in the saved Subagent settings.`);
  }
  // Decorate one selection with the `verifies` evidence the caller asked for.
  withVerifies(outcome, verifies, verifiesKnown, executorRoute, sameModelAsExecutor) {
    if (verifies === undefined) return outcome;
    const extras = { verifies };
    if (!verifiesKnown) extras.verifiesUnknown = true;
    else if (sameModelAsExecutor) extras.sameModelAsExecutor = true;
    else extras.excludedRoute = { ...executorRoute };
    return Object.assign(outcome, extras);
  }
  // Preflight one route and hold its load reservation. The reservation is made BEFORE the
  // first await, so concurrent delegations see each other's counts and spread correctly.
  // Availability failures (and settings changes mid-preflight) release the reservation
  // and continue escalation; any other error fails loudly, also releasing. The surviving
  // selection carries the reservation as a NON-ENUMERABLE `token` property, so session
  // events, logs and structural comparisons see only data.
  async attempt(route, requestedTier, reasoningEffort, signal, failures = []) {
    signal.throwIfAborted();
    const token = this.reserve(route);
    let keep = false;
    try {
      // Settings/provider state may change during asynchronous resolution.
      if (!this.routes().some(current => routeKey(current) === routeKey(route))) return undefined;
      const effort = reasoningEffort;
      try {
        await this.llm.resolveCallConfig({ ...route, ...(effort === undefined ? {} : { reasoningEffort: effort }) }, signal);
        signal.throwIfAborted();
        if (!this.routes().some(current => routeKey(current) === routeKey(route))) return undefined;
        const selection = { route: { ...route }, tier: tierOfRoute(route, this.settings.current().modelTiers), requestedTier, ...(effort === undefined ? {} : { reasoningEffort: effort }), failures };
        Object.defineProperty(selection, 'token', { value: token });
        keep = true;
        return selection;
      } catch (error) {
        signal.throwIfAborted();
        if (!isAvailabilityFailure(error)) throw error;
        failures.push({ route: { ...route }, code: (error.failure ?? error).code });
        return undefined;
      }
    } finally {
      if (!keep) token.release();
    }
  }
  async fallback(current, tried, signal, maxAttempts = Infinity) {
    signal.throwIfAborted();
    tried.add(routeKey(current));
    // The current route's tier is derived from live settings on every failure; a route that
    // is no longer tiered counts as medium. Alternatives are least-loaded first; the
    // caller moves the child's own reservation via switchChildRoute when it adopts the new
    // route, so this selection must not keep one.
    const preference = this.settings.current();
    const currentTier = tierOfRoute(current, preference.modelTiers);
    const startIndex = MODEL_TIERS.indexOf(currentTier);
    for (let index = Math.max(0, startIndex); index < MODEL_TIERS.length; index += 1) {
      const candidates = this.tierCandidates(this.routes(), preference.modelTiers, MODEL_TIERS[index]);
      for (const route of this.byLeastLoaded(candidates)) {
        signal.throwIfAborted();
        const key = routeKey(route);
        if (tried.has(key)) continue;
        if (tried.size >= maxAttempts) return undefined;
        tried.add(key);
        const selected = await this.attempt(route, currentTier, undefined, signal);
        if (selected) {
          selected.token?.release();
          return selected.route;
        }
      }
    }
    return undefined;
  }
}
// Cordis returns a fresh tracking proxy on every service access, so key the shared router by the
// underlying service object; keying by the proxy gave each delegation a new router.
//
// The registry is PROCESS-GLOBAL (a Symbol.for key on globalThis), not module-local: the installed
// dsh-tool-subagent patch imports router.mjs through home/local-plugins by absolute path, while the
// preset rows and recipes import the package's own copy. Whenever those resolve to different module
// instances (relocated/copied package, symlinked path, ...), they must still share ONE router per
// settings service, or load spreading and `verifies` break silently. The first instance to create a
// router owns its class; later instances use it duck-typed — never rely on `instanceof AutoModelRouter`.
const ORIGINAL = Symbol.for('cordis.original');
const REGISTRY = Symbol.for('dsh-auto-subagents.routers');
const routers = globalThis[REGISTRY] ??= new WeakMap();
export function automaticRouter(settings, llm) {
  const key = settings?.[ORIGINAL] ?? settings;
  let router = routers.get(key);
  if (!router) { router = new AutoModelRouter(settings, llm); routers.set(key, router); }
  else { router.settings = settings; router.llm = llm; }
  return router;
}
