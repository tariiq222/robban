/** Durable task work graph over the task memory store's private files and atomic writer lock. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { opendir, lstat } from 'node:fs/promises';
import { TaskMemoryStore } from './task-memory-store.mjs';

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECIPES = new Set(['feature-pipeline', 'bug-fix', 'refactor', 'qa-verify', 'investigate', 'code-audit', 'manual']);
const STATES = new Set(['pending', 'in_progress', 'blocked', 'completed']);
const OUTCOMES = new Set(['completed', 'completed_with_failures', 'needs_decision', 'ended', 'aborted', 'failed', 'error', 'cancelled', 'interrupted']);
const ADMISSION_LOCK = '00000000-0000-4000-8000-000000000000';
const ACTIVE = Symbol.for('dsh-auto-subagents.task-work-active-attempts');
const active = globalThis[ACTIVE] ??= new Set();
const PROCESS_TOKEN = Symbol.for('dsh-auto-subagents.task-work-process-token');
const processToken = globalThis[PROCESS_TOKEN] ??= randomUUID();
const fail = (code, message) => { throw Object.assign(new Error(message), { code: `TASK_WORK_${code}` }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID', 'Task work contains missing or unknown fields');
}
function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('INVALID', `${name} must be nonempty text of at most ${max} characters`);
}
function identifier(value, name = 'id') { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID', `${name} must use a lowercase letter then up to 31 lowercase letters, numbers or hyphens`); }
function taskIdentifier(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID', 'taskId must be a task memory UUID'); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID', 'expectedRevision must be a nonnegative safe integer'); }
function timestamp(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID', 'Invalid task work timestamp'); }
function strings(values, name, { min = 0, max = 20, length = 2000, ids = false } = {}) {
  if (!Array.isArray(values) || values.length < min || values.length > max || new Set(values).size !== values.length) fail('INVALID', `${name} must be a unique array of ${min}..${max} entries`);
  for (const value of values) { text(value, name, length); if (ids) identifier(value, name); }
}
function canonicalScope(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim().length > 0
    && !value.startsWith('/') && !/[\\:*?\[\]{}\x00-\x1f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}
function scope(value) {
  if (!canonicalScope(value)) fail('INVALID', 'Scopes must name canonical relative literal paths');
}
/**
 * Match a literal file or directory and its descendants, rejecting noncanonical paths.
 * @param declared - Saved relative write or read scope.
 * @param candidate - Reported or competing relative path.
 * @returns Whether the candidate is the scope itself or a segment descendant.
 */
export function taskWorkPathContains(declared, candidate) {
  if (!canonicalScope(declared) || !canonicalScope(candidate)) return false;
  if (process.platform === 'win32') { declared = declared.toLowerCase(); candidate = candidate.toLowerCase(); }
  return candidate === declared || candidate.startsWith(`${declared}/`);
}
const overlaps = (a, b) => taskWorkPathContains(a, b) || taskWorkPathContains(b, a);
/** True when declared scopes need serialization; readers may share paths with other readers. */
export function taskWorkScopesConflict(a, b, { includeUnknownReads = true } = {}) {
  if (includeUnknownReads && ((a.readPaths === undefined && b.writePaths.length > 0) || (b.readPaths === undefined && a.writePaths.length > 0))) return true;
  return a.writePaths.some(write => [...b.writePaths, ...(b.readPaths ?? [])].some(other => overlaps(write, other)))
    || b.writePaths.some(write => (a.readPaths ?? []).some(read => overlaps(write, read)));
}
function validateAttempt(attempt) {
  fields(attempt, ['id', 'recipe', 'runId', 'sessionId', 'startedAt', 'pid', 'processToken']);
  if (!UUID.test(attempt.processToken ?? '')) fail('INVALID', 'Invalid attempt process token');
  if (!UUID.test(attempt.id ?? '')) fail('INVALID', 'Invalid attempt id');
  if (!RECIPES.has(attempt.recipe) || attempt.recipe === 'manual') fail('INVALID', 'Invalid attempt recipe');
  text(attempt.runId, 'runId', 200); text(attempt.sessionId, 'sessionId', 200); timestamp(attempt.startedAt);
  if (!Number.isSafeInteger(attempt.pid) || attempt.pid < 1) fail('INVALID', 'Invalid attempt process id');
}
function validateOutcome(outcome) {
  fields(outcome, ['kind', 'status', 'summary', 'verification']);
  if (outcome.kind !== 'reported_recipe_result' || !OUTCOMES.has(outcome.status)) fail('INVALID', 'Outcome must be an explicitly reported recipe result');
  text(outcome.summary, 'outcome summary'); fields(outcome.verification, ['passed', 'summary', 'evidenceMode'], ['passed', 'summary']);
  if (outcome.verification.evidenceMode !== undefined && !['source_only', 'runtime'].includes(outcome.verification.evidenceMode)) fail('INVALID', 'Invalid verification evidenceMode');
  if (typeof outcome.verification.passed !== 'boolean') fail('INVALID', 'Verification passed must be boolean');
  text(outcome.verification.summary, 'verification summary');
}
const completedOutcome = outcome => outcome?.status === 'completed' && outcome.verification.passed === true;
function evidenceMode(item) { return ['code-audit', 'investigate', 'manual'].includes(item.recipe) || (item.recipe === 'qa-verify' && item.verifyCommands.length === 0) ? 'source_only' : 'runtime'; }
function validateItem(item, definition = false) {
  const base = ['id', 'title', 'description', 'goalIds', 'writePaths', 'readPaths', 'acceptance', 'verifyCommands', 'dependencies', 'recipe', 'evidenceMode'];
  if (object(item) && JSON.stringify(Object.fromEntries(base.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]))).length > 24000) fail('LIMIT', 'Work item definition exceeds the 24000-character execution context limit; split the scope into smaller work items');
  fields(item, definition ? base : [...base, 'status', 'blocker', 'attempt', 'lastOutcome'], [...base.filter(key => key !== 'readPaths' && (key !== 'evidenceMode' || !definition)), ...(definition ? [] : ['status'])]);
  identifier(item.id, 'item id'); text(item.title, 'item title', 200); text(item.description, 'item description', 4000);
  strings(item.goalIds, 'goalIds', { min: 1, ids: true }); strings(item.dependencies, 'dependencies', { ids: true });
  strings(item.writePaths, 'writePaths', { min: ['feature-pipeline', 'bug-fix', 'refactor'].includes(item.recipe) ? 1 : 0, length: 512 }); for (const value of item.writePaths) scope(value);
  if (item.readPaths !== undefined) { strings(item.readPaths, 'readPaths', { length: 512 }); for (const value of item.readPaths) scope(value); }
  strings(item.acceptance, 'acceptance', { min: 1 }); strings(item.verifyCommands, 'verifyCommands', { min: ['code-audit', 'investigate', 'qa-verify', 'manual'].includes(item.recipe) ? 0 : 1, length: 512 });
  if (!RECIPES.has(item.recipe)) fail('INVALID', 'Work recipe must be a supported recipe or manual; plan-to-packages is planning only');
  const mode = evidenceMode(item);
  if (item.evidenceMode !== undefined && item.evidenceMode !== mode) fail('INVALID', 'Evidence mode must match the recipe and verification commands');
  if (definition) return;
  if (!STATES.has(item.status)) fail('INVALID', 'Invalid work item status');
  if (item.blocker !== undefined) text(item.blocker, 'blocker');
  if (item.attempt !== undefined) { validateAttempt(item.attempt); if (item.attempt.recipe !== item.recipe) fail('INVALID', 'Attempt recipe does not match work item'); }
  if (item.lastOutcome !== undefined) { validateOutcome(item.lastOutcome); if (item.lastOutcome.verification.evidenceMode !== item.evidenceMode) fail('INVALID', 'Outcome evidence mode differs from the work item'); }
  if (item.status === 'in_progress' && item.attempt === undefined) fail('INVALID', 'In-progress item requires an owning attempt');
  if (item.status === 'blocked' && item.blocker === undefined) fail('INVALID', 'Blocked item requires a blocker');
  if (item.status !== 'blocked' && item.blocker !== undefined) fail('INVALID', 'Only blocked items carry a blocker');
  if (item.status === 'completed' && (!item.attempt || !completedOutcome(item.lastOutcome))) fail('INVALID', 'Completed work requires a verified recipe outcome and owning attempt');
  if (item.recipe === 'manual' && item.status !== 'blocked') fail('INVALID', 'Manual work remains blocked until redefined as an executable recipe');
}
function graph(goals, items, definition = false) {
  if (!Array.isArray(goals) || goals.length < 1 || goals.length > 20 || !Array.isArray(items) || items.length < 1 || items.length > 20) fail('INVALID', 'Work plans need 1..20 goals and 1..20 items');
  const goalIds = new Set(), itemMap = new Map();
  for (const goal of goals) { fields(goal, ['id', 'description']); identifier(goal.id, 'goal id'); text(goal.description, 'goal description', 4000); if (goalIds.has(goal.id)) fail('INVALID', 'Duplicate goal id'); goalIds.add(goal.id); }
  for (const item of items) { validateItem(item, definition); if (itemMap.has(item.id)) fail('INVALID', 'Duplicate item id'); itemMap.set(item.id, item); }
  const covered = new Set();
  for (const item of items) {
    for (const goal of item.goalIds) { if (!goalIds.has(goal)) fail('INVALID', 'Work item references an unknown goal'); covered.add(goal); }
    for (const dependency of item.dependencies) if (!itemMap.has(dependency) || dependency === item.id) fail('INVALID', 'Work item has an unknown or self dependency');
  }
  if (covered.size !== goalIds.size) fail('INVALID', 'Every goal must have at least one work item');
  const visiting = new Set(), visited = new Set();
  const visit = id => { if (visiting.has(id)) fail('INVALID', 'Work dependencies must be acyclic'); if (visited.has(id)) return; visiting.add(id); for (const dependency of itemMap.get(id).dependencies) visit(dependency); visiting.delete(id); visited.add(id); };
  for (const id of itemMap.keys()) visit(id);
  const dependsOn = (item, target) => item.dependencies.some(id => id === target || dependsOn(itemMap.get(id), target));
  for (let index = 0; index < items.length; index++) for (const other of items.slice(index + 1)) {
    if (taskWorkScopesConflict(items[index], other, { includeUnknownReads: false }) && !dependsOn(items[index], other.id) && !dependsOn(other, items[index].id)) fail('INVALID', 'Declared overlapping write/read scopes require a transitive dependency order');
  }
  if (!definition) {
    const attempts = new Set();
    for (const item of items) {
      if (item.attempt) { if (attempts.has(item.attempt.id)) fail('INVALID', 'Duplicate attempt id'); attempts.add(item.attempt.id); }
      if (['in_progress', 'completed'].includes(item.status) && item.dependencies.some(id => itemMap.get(id).status !== 'completed')) fail('INVALID', 'Started work requires completed dependencies');
    }
    const running = items.filter(item => item.status === 'in_progress');
    for (let n = 0; n < running.length; n++) for (const other of running.slice(n + 1)) if (taskWorkScopesConflict(running[n], other)) fail('INVALID', 'Active work items have conflicting declared scopes');
  }
}
/** Validate loaded plan fields and the complete dependency graph without trusting disk or model output. */
export function validateTaskWorkPlan(plan) {
  fields(plan, ['version', 'taskId', 'repo', 'revision', 'createdAt', 'updatedAt', 'goals', 'items']);
  if (plan.version !== 1) fail('INVALID', 'Unsupported work plan version'); taskIdentifier(plan.taskId); text(plan.repo, 'repo', 4096);
  if (!path.isAbsolute(plan.repo) || path.resolve(plan.repo) !== plan.repo) fail('INVALID', 'Work repo must be canonical absolute');
  revision(plan.revision); if (plan.revision < 1) fail('INVALID', 'Persisted work revision starts at one'); timestamp(plan.createdAt); timestamp(plan.updatedAt); graph(plan.goals, plan.items);
  return plan;
}
/** Project readiness and goal coverage from persisted states; these derived fields are never stored. */
export function projectTaskWork(plan) {
  validateTaskWorkPlan(plan);
  const items = plan.items.map(item => ({ ...structuredClone(item), readScopeDeclared: item.readPaths !== undefined, readiness: item.status !== 'pending' ? item.status : item.dependencies.every(id => plan.items.find(other => other.id === id).status === 'completed') ? 'ready' : 'waiting' }));
  const goals = plan.goals.map(goal => {
    const related = items.filter(item => item.goalIds.includes(goal.id)), completedCount = related.filter(item => item.status === 'completed').length;
    return { ...goal, totalCount: related.length, completedCount };
  });
  return { ...structuredClone(plan), items, goals };
}
/** Host-only cleanup hook; never exposed as a model tool or inferred from note text. */
export function releaseTaskAttempt(attemptId) { active.delete(attemptId); }

/** Same-task work plans share the note store's writer lock but keep notes' released v1 JSON unchanged. */
export class TaskWorkStore extends TaskMemoryStore {
  constructor(options = {}) { super(options); this.memory = new TaskMemoryStore(options); }
  filename(taskId, repo) { taskIdentifier(taskId); return path.join(this.namespace(repo), `${taskId}.work.json`); }
  validate(plan) { return validateTaskWorkPlan(plan); }
  async existing(repo, taskId) {
    try { const plan = await this.read(taskId, repo); if (plan.repo !== repo) fail('REPO_MISMATCH', 'Work plan belongs to another repository'); return plan; }
    catch (error) { if (error.code === 'TASK_MEMORY_NOT_FOUND') return null; throw error; }
  }
  async root(repo, taskId) { const memory = await this.memory.get({ repo, taskId }); return memory.repo; }
  /** Read a plan only after checking its root task memory; undefined plans return null. */
  async get({ repo, taskId }) { const canonical = await this.root(repo, taskId); return this.existing(canonical, taskId); }
  async mutate({ repo, taskId }, operation) {
    const canonical = await this.root(repo, taskId);
    return this.locked(ADMISSION_LOCK, canonical, () => this.locked(taskId, canonical, async () => {
      // Recheck the root under the common lock before publishing linked work.
      await this.memory.get({ repo: canonical, taskId });
      const plan = await this.existing(canonical, taskId), result = await operation(plan, canonical);
      const value = result.plan ?? result; value.updatedAt = new Date().toISOString(); await this.write(value); return result;
    }));
  }
  checkRevision(plan, expectedRevision) { revision(expectedRevision); if ((plan?.revision ?? 0) !== expectedRevision) fail('CONFLICT', `Work revision changed: expected ${expectedRevision}, current ${plan?.revision ?? 0}; reload first`); }
  item(plan, itemId) { identifier(itemId, 'itemId'); if (!plan) fail('NOT_FOUND', 'No work plan is defined for this task'); const item = plan.items.find(value => value.id === itemId); if (!item) fail('NOT_FOUND', 'Work item does not exist'); return item; }
  async checkScopePaths(repo, items) {
    for (const item of items) for (const relative of [...item.writePaths, ...(item.readPaths ?? [])]) {
      let current = repo;
      for (const part of relative.split('/')) {
        current = path.join(current, part);
        try { if ((await lstat(current)).isSymbolicLink()) fail('UNSAFE', 'Declared work paths cannot traverse repository symbolic links'); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      }
    }
  }
  async checkOtherPlans(plan, item) {
    let scanned = 0;
    for await (const file of await opendir(this.namespace(plan.repo))) {
      if (++scanned > 1000) fail('LIMIT', 'Repository task data exceeds the 1000-file admission scan limit; archive finished work before claiming');
      if (!file.name.endsWith('.work.json')) continue;
      const otherTask = file.name.slice(0, -10);
      if (!UUID.test(otherTask) || otherTask === plan.taskId) continue;
      const otherPlan = await this.read(otherTask, plan.repo);
      if (otherPlan.repo !== plan.repo) fail('REPO_MISMATCH', 'Repository work namespace contains a foreign plan');
      if (otherPlan.items.some(other => (other.status === 'in_progress' || (other.attempt && active.has(other.attempt.id))) && taskWorkScopesConflict(item, other))) fail('SCOPE', 'Work scopes overlap an active writer or reader in another task plan');
    }
  }
  /** Define a checked DAG only before any item has been attempted. */
  async define({ repo, taskId, sessionId, expectedRevision, goals, items }) {
    text(sessionId, 'sessionId', 200); revision(expectedRevision); graph(goals, items, true); const definition = structuredClone({ goals, items });
    return this.mutate({ repo, taskId }, async (plan, canonical) => {
      await this.checkScopePaths(canonical, definition.items);
      this.checkRevision(plan, expectedRevision);
      if (plan && plan.items.some(item => item.status !== 'pending' || item.attempt || item.lastOutcome)) fail('STATE', 'A work plan can only be redefined while every item is pending and unattempted');
      const now = new Date().toISOString();
      return { version: 1, taskId, repo: canonical, revision: (plan?.revision ?? 0) + 1, createdAt: plan?.createdAt ?? now, updatedAt: now, goals: definition.goals,
        items: definition.items.map(item => ({ ...item, evidenceMode: evidenceMode(item), status: item.recipe === 'manual' ? 'blocked' : 'pending', ...(item.recipe === 'manual' ? { blocker: 'Manual work is not executable; resolve its intent in a successor work plan' } : {}) })) };
    });
  }
  /** Atomically reserve a ready item and declared write/read scopes before starting its recipe. */
  async claim({ repo, taskId, itemId, sessionId, recipe, runId, expectedRevision }) {
    text(sessionId, 'sessionId', 200); text(runId, 'runId', 200); if (!RECIPES.has(recipe) || recipe === 'manual') fail('INVALID', 'Claim requires a supported executable recipe'); if (expectedRevision !== undefined) revision(expectedRevision);
    const attempt = { id: randomUUID(), recipe, runId, sessionId, startedAt: new Date().toISOString(), pid: process.pid, processToken };
    try {
      return await this.mutate({ repo, taskId }, async plan => {
        if (expectedRevision !== undefined) this.checkRevision(plan, expectedRevision);
        const item = this.item(plan, itemId);
        if (item.recipe !== recipe) fail('RECIPE', 'Recipe does not match the saved work item');
        if (item.status !== 'pending') fail('STATE', 'Only pending work can be claimed');
        if (item.attempt && active.has(item.attempt.id)) fail('BUSY', 'Previous work attempt is still being disposed');
        if (!item.dependencies.every(id => plan.items.find(other => other.id === id).status === 'completed')) fail('DEPENDENCY', 'Work dependencies are not completed');
        if (plan.items.some(other => other.id !== item.id && (other.status === 'in_progress' || (other.attempt && active.has(other.attempt.id))) && taskWorkScopesConflict(item, other))) fail('SCOPE', 'Work scopes overlap an active writer or reader; wait for its disposal');
        await this.checkScopePaths(plan.repo, [item]);
        await this.checkOtherPlans(plan, item);
        if (plan.items.some(other => other.attempt?.runId === runId)) fail('STATE', 'Run id is already assigned to work in this plan');
        item.status = 'in_progress'; item.attempt = attempt; delete item.blocker; plan.revision += 1; active.add(attempt.id); return { plan, attempt };
      });
    } catch (error) { active.delete(attempt.id); throw error; }
  }
  /** Settle exactly the owning attempt using the recipe adapter's bounded verification report. */
  async settle({ repo, taskId, itemId, attemptId, sessionId, outcome }) {
    text(sessionId, 'sessionId', 200); if (!UUID.test(attemptId ?? '')) fail('INVALID', 'Invalid attemptId'); validateOutcome(outcome); const report = structuredClone(outcome);
    return this.mutate({ repo, taskId }, plan => {
      const item = this.item(plan, itemId);
      if (item.status !== 'in_progress' || item.attempt?.id !== attemptId || item.attempt.sessionId !== sessionId) fail('OWNERSHIP', 'Only the exact owning live attempt may settle work');
      if (report.verification.evidenceMode !== undefined && report.verification.evidenceMode !== item.evidenceMode) fail('INVALID', 'Recipe result evidence mode differs from the saved item');
      report.verification.evidenceMode = item.evidenceMode;
      item.lastOutcome = report; item.status = completedOutcome(report) ? 'completed' : 'blocked';
      if (item.status === 'blocked') item.blocker = `${report.status}: ${report.summary}`.slice(0, 2000);
      plan.revision += 1; return plan;
    });
  }
  /** Record a blocker for idle work; notes cannot alter live or completed attempts. */
  async block({ repo, taskId, itemId, sessionId, expectedRevision, reason }) {
    text(sessionId, 'sessionId', 200); revision(expectedRevision); text(reason, 'blocker reason');
    return this.mutate({ repo, taskId }, plan => { this.checkRevision(plan, expectedRevision); const item = this.item(plan, itemId); if (!['pending', 'blocked'].includes(item.status) || (item.attempt && active.has(item.attempt.id))) fail('STATE', 'Only idle pending or blocked work can be blocked'); item.status = 'blocked'; item.blocker = reason; plan.revision += 1; return plan; });
  }
  canRecover(attempt) {
    if (attempt.pid === process.pid && attempt.processToken === processToken) return !active.has(attempt.id);
    try { process.kill(attempt.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; return false; }
  }
  /** Reopen blocked or provably interrupted work; live, unknown or completed runs stay protected. */
  async reopen({ repo, taskId, itemId, sessionId, expectedRevision, reason }) {
    text(sessionId, 'sessionId', 200); revision(expectedRevision); text(reason, 'reopen reason');
    return this.mutate({ repo, taskId }, plan => {
      this.checkRevision(plan, expectedRevision); const item = this.item(plan, itemId);
      if (item.recipe === 'manual' || !['blocked', 'in_progress'].includes(item.status)) fail('STATE', 'Only executable blocked or interrupted work may be reopened');
      if (item.attempt && !this.canRecover(item.attempt)) fail('BUSY', 'Owning process or local recipe attempt is still active; recovery is refused');
      if (item.status === 'in_progress') item.lastOutcome = { kind: 'reported_recipe_result', status: 'interrupted', summary: reason, verification: { passed: false, evidenceMode: item.evidenceMode, summary: 'Owning run ended without settlement; inspect the current diff and rerun verification before retrying' } };
      item.status = 'pending'; delete item.blocker; plan.revision += 1; return plan;
    });
  }
}
