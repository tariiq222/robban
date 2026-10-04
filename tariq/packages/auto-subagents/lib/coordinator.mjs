// Auto Subagents coordinator policy: the top-level Auto session plans, scopes and verifies;
// its subagents execute. Enforcement is a per-agent tool allowlist; prompts only explain it.
import { runtimeModuleUrl, RECIPES_DIR } from './dsh-paths.mjs';
import { listApprovedRecipesSync, renderCatalogForCoordinator } from './recipe-catalog.mjs';
// Same file URL as the host's dsh-scope → same ESM instance.
const { scopeParentOf } = await import(runtimeModuleUrl('@deepseek-ai/dsh-scope'));

export const AUTO_PRESET = 'auto-subagents';
/** The preset an agent actually runs on (live scope chain, not its header). */
export const presetOf = agent => agent.ctx.get('agentPresets')?.composedPreset(agent.ctx);

// Allowlist (not denylist): any tool added later — including third-party plugin tools —
// stays unavailable to the coordinator until deliberately admitted here.
export const COORDINATOR_ALLOWED_TOOLS = Object.freeze([
  // understand the system without changing it
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
  // delegate, steer and observe subagents
  'subagent', 'subagent_fork', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents', 'job_output', 'job_list',
  // run a SAVED, reviewed recipe by name (never arbitrary workflow scripts)
  'run_recipe',
  // plan, track and communicate
  'todo_write', 'ask_user_question', 'exit_plan_mode', 'get_goal', 'create_goal', 'update_goal', 'present',
]);

/** 'coordinator' for the top-level Auto session, 'subagent' for Auto children, else null. */
export function roleOf(header, preset) {
  if (preset !== AUTO_PRESET) return null;
  return header?.origin === 'subagent' ? 'subagent' : 'coordinator';
}
export const isCoordinator = (header, preset) => roleOf(header, preset) === 'coordinator';

export const COORDINATOR_ROLE = `# Coordinator role (enforced)
You are the coordinator. You cannot edit files or run commands: those tools are removed from you in code. Subagents do all execution. Your value is the big picture.

1. Understand before scoping: read the relevant code, find existing modules, contracts and conventions. Reuse them; never ask a subagent to duplicate logic that already exists.
2. Define each task precisely: goal, exact files it may change, files it must not touch, the contract it must respect, acceptance criteria, and how to verify. Two subagents must never edit the same file concurrently.
3. Impact analysis first: before any change, list which other modules, callers, tests and configs depend on what will change. The change must rest on sound architecture: clear ownership, no duplication, no hidden coupling.
4. Independent regression verification: after implementation, assign a separate verification subagent (ideally a different model) to run the affected tests AND the tests of every dependent module you identified, and to report failures honestly. Do not accept an implementer's own claim as proof.
5. Integrate: compare reports, resolve conflicts, re-assign failed or incomplete work with a concrete fix, then answer the user.

Keep your own context small: request compact reports, and open detail only when a report shows a problem. Always pass an explicit \`tier\` on every delegation and leave provider/model unset unless the user names a model. Tier rules: implementation, repair, review and verification → \`tier: "strong"\`; research, analysis, planning reads and design comparison → \`tier: "medium"\`; simple file reading, listing, grep-style lookups and summarizing a known file → \`tier: "light"\`. The router picks the saved allowed model of that tier and escalates upward only when it is unavailable; it never downgrades. When delegating verification or review of a subagent's work, always pass \`verifies: "<that subagent's id>"\` along with \`tier: "strong"\` so the verifier runs on a different model than the executor. If delegation is unavailable, explain the limitation instead of working around it.`;

export const SUBAGENT_REPORT_CONTRACT = `# Report to your coordinator
Your final message is read by a coordinator that holds the whole plan and has limited context. Keep it under 150 words, in this exact shape:
Status: done | partial | blocked — one line why.
Changed: file paths with a one-line purpose each, or "none".
Verification: exact commands run and pass/fail counts; say "not run" when true.
Impact: other modules/callers touched or at risk, and whether their tests passed.
Risks: open issues, assumptions, or follow-up needed; "none" if none.
No narrative, no pasted diffs or logs; quote only the failing line when something failed. Stay inside the files you were assigned; report instead of widening scope.`;

export const roleSectionFor = (header, preset) => roleOf(header, preset) === 'coordinator' ? COORDINATOR_ROLE : '';
export const reportSectionFor = (header, preset) => roleOf(header, preset) === 'subagent' ? SUBAGENT_REPORT_CONTRACT : '';

/**
 * Keeps exactly one allowlist restriction on each live top-level Auto agent.
 * Reconciliation is idempotent and re-entrancy safe: applying a restriction emits
 * tools/change, which calls back into reconcile.
 */
export class CoordinatorPolicy {
  // knownNames(agent) must return the names the agent inherits BEFORE this policy's restriction
  // (its preset's standing scope), never the agent's own restricted view.
  constructor({ listAgents, knownNames, presetOf }) {
    this.listAgents = listAgents;
    this.knownNames = knownNames;
    this.presetOf = presetOf;
    this.applied = new Map(); // agent -> { allow signature, dispose }
    this.reconciling = false;
    this.pending = false;
  }
  allowFor(known) {
    return COORDINATOR_ALLOWED_TOOLS.filter(name => known.has(name));
  }
  // Fail closed: a coordinator is never left without a restriction. An empty allow list is valid
  // and hides every inherited tool; the new restriction is applied before the old one is lifted
  // (restrictions intersect), so a failure keeps the previous restriction in force.
  applyTo(agent) {
    const allow = this.allowFor(this.knownNames(agent));
    const signature = allow.join('\0');
    const current = this.applied.get(agent);
    if (current?.signature === signature) return;
    const dispose = agent.ctx.tools.restrict({ allow });
    this.applied.set(agent, { signature, dispose });
    current?.dispose();
  }
  reconcile() {
    if (this.reconciling) { this.pending = true; return; }
    this.reconciling = true;
    const failures = new Map(); // agent -> latest error; a pending re-pass must not duplicate it
    try {
      do {
        this.pending = false;
        const live = new Set();
        for (const agent of this.listAgents()) {
          if (!isCoordinator(agent.session.header, this.presetOf(agent))) continue;
          live.add(agent);
          // One agent's failure must not leave later agents unprocessed.
          try { this.applyTo(agent); failures.delete(agent); } catch (error) { failures.set(agent, error); }
        }
        for (const [agent, entry] of this.applied) {
          if (live.has(agent)) continue;
          this.applied.delete(agent);
          try { entry.dispose(); } catch (error) { failures.set(agent, error); }
        }
      } while (this.pending);
    } finally {
      this.reconciling = false;
    }
    const errors = [...failures.values()];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'coordinator policy failed for several agents');
  }
  appliedCount() {
    return this.applied.size;
  }
  dispose() {
    for (const entry of this.applied.values()) entry.dispose();
    this.applied.clear();
  }
}

// ── Cordis plugin: mounted as its own preset row, independent of model routing ──
export const name = 'auto-subagents-coordinator';
export const inject = ['agents', 'tools', 'systemPrompt'];
export function apply(ctx, config = {}) {
  const recipesDir = config.recipesDir || RECIPES_DIR;
  // Prompt assembly passes the agent; diagnostic assemblies without one get no role text.
  const sectionFrom = select => context => context.agent ? select(context.agent.session.header, presetOf(context.agent)) : '';
  const order = ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') - 1;
  ctx.systemPrompt.section({ name: 'auto-subagents:coordinator', order, text: sectionFrom(roleSectionFor) });
  ctx.systemPrompt.section({ name: 'auto-subagents:report', order, text: sectionFrom(reportSectionFor) });
  ctx.systemPrompt.section({ name: 'auto-subagents:recipes', order, text: context => {
    if (!context.agent || !isCoordinator(context.agent.session.header, presetOf(context.agent))) return '';
    return renderCatalogForCoordinator(listApprovedRecipesSync(recipesDir));
  } });
  const policy = new CoordinatorPolicy({
    listAgents: () => ctx.agents.list(),
    // The standing preset scope is the agent's parent: its view is what the agent inherits
    // before the coordinator restriction, which lives in the agent's own layer.
    knownNames: agent => new Set(ctx.tools.schemas(scopeParentOf(agent)).map(tool => tool.name)),
    presetOf,
  });
  const reconcile = () => {
    try { policy.reconcile(); } catch (error) { ctx.logger.warn(`Auto Subagents coordinator policy failed: ${String(error)}`); }
  };
  for (const event of ['agent/created', 'agent/disposed', 'tools/change', 'agent-preset/selected']) ctx.on(event, reconcile);
  ctx.effect(() => () => policy.dispose(), 'auto-subagents: coordinator policy');
  reconcile();
}
