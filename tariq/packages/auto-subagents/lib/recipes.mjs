// run_recipe: lets the Auto coordinator run a SAVED, approved workflow recipe by name, without
// being able to author arbitrary workflow scripts. Recipes live in <home>/recipes/<name>/
// {meta.json,script.js,recipe.lock.json}; a recipe whose files differ from its approval lock is refused.
//
// The tool owns what the recipe script cannot do itself:
//  1. Model routing from live Subagent settings: each child is routed by its role's tier at
//     admission (workflow-routing.mjs); reviewers avoid the current implementer's route.
//  2. Resume storage: a "needs_decision"/"ended" result carries a large `resume` object; the tool
//     keeps it on disk (RUNS_DIR) and hands the coordinator a short `resumeId` instead.
//  3. Human answers: on resume, answers are read ONLY from verified ask_user_question results in
//     the owning session (decision-receipt.mjs), never from the coordinator's own arguments.
//  4. Safety: test-only args (faultInjection) are never forwarded.
import { readFile, readdir, writeFile, mkdir, open, unlink, rename, stat, link, realpath } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { RECIPES_DIR, runtimeModuleUrl } from './dsh-paths.mjs';
import { automaticRouter } from './router.mjs';
import { RunTracker } from './run-tracker.mjs';
import { verifiedDecisions } from './decision-receipt.mjs';
import { registerWorkflowRouting, WORKFLOW_ROLE_TIERS } from './workflow-routing.mjs';
import { verifyRecipeIntegrity } from './recipe-integrity.mjs';
import { validateRecipeMeta } from './recipe-contract.mjs';
import { listApprovedRecipesSync, renderCatalogForTool } from './recipe-catalog.mjs';
export { listApprovedRecipesSync, loadVerifiedRecipeSync, renderCatalogForTool, renderCatalogForCoordinator } from './recipe-catalog.mjs';
import { EVENT, compactQuestions, compactDecided } from './events.mjs';
import { setupCacheKey, setupCacheDir, loadSetupCache, saveSetupCache } from './setup-cache.mjs';
// Same file URL as the host's dsh-tools → same ESM instance.
const { defineTool } = await import(runtimeModuleUrl('@deepseek-ai/dsh-tools'));

export { RECIPES_DIR };
export const RUNS_DIR = path.join(RECIPES_DIR, '.runs');
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const UUID = /^[0-9a-f-]{36}$/;
// Step role → tier: single source lives in workflow-routing.mjs (re-exported for compatibility).
export const ROLE_TIERS = WORKFLOW_ROLE_TIERS;
/** An UNKNOWN-owner claim (empty legacy file / malformed) older than this is abandoned. A live pid is never robbed. */
export const CLAIM_TTL_MS = 6 * 3600e3;
/** Resume records untouched for longer than this are garbage-collected on the next save. */
export const RUN_RECORD_MAX_AGE_MS = 14 * 24 * 3600e3;
// GC-only absolute cap for claims that name a pid (guards against pid reuse keeping a claim forever).
// Applied ONLY by pruneRuns and ONLY when the claim's record is expired or missing; claimResume never
// applies it, so a genuinely live run is never robbed.
export const CLAIM_ABSOLUTE_CAP_MS = 7 * 24 * 3600e3;
/** Whole-run wall-clock cap (per-step timeouts alone allow many hours across repair loops). */
export const DEFAULT_TOTAL_TIMEOUT_MS = 3 * 3600e3;
export const MAX_TOTAL_TIMEOUT_MS = 8 * 3600e3;

export async function listRecipes(dir = RECIPES_DIR) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(dir, entry.name, 'meta.json'), 'utf8'));
      names.push({ name: entry.name, description: String(meta.description ?? '') });
    } catch { /* not a recipe */ }
  }
  return names.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a recipe and verify it against its approval lock; the returned strings are what was verified. */
export async function loadRecipe(name, dir = RECIPES_DIR) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`invalid recipe name "${name}"`);
  const base = path.join(dir, name);
  const [metaText, script] = await Promise.all([
    readFile(path.join(base, 'meta.json'), 'utf8'),
    readFile(path.join(base, 'script.js'), 'utf8'),
  ]).catch(() => { throw new Error(`recipe "${name}" not found in ${dir}`); });
  let meta;
  try { meta = JSON.parse(metaText); } catch { throw new Error(`recipe "${name}" meta.json is not valid JSON`); }
  if (meta?.name !== name) throw new Error(`recipe "${name}" meta.name is "${meta?.name}"`);
  await verifyRecipeIntegrity(base, { meta, script, metaText });
  const contract = validateRecipeMeta(meta, { name });
  return { meta, script, contract };
}

// Spawn children inherit the session cwd; a prompt's Repository line cannot change it.
// Reject a foreign workspace before cache/resume/routing admission. Canonical identity
// allows directory symlink aliases without rewriting the resume-bound repo argument.
async function assertRecipeWorkspace(repo, cwd) {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) {
    throw new Error('run_recipe requires an absolute session cwd; open a session in the requested repository workspace.');
  }
  const directory = async (value, label) => {
    try {
      const resolved = await realpath(value);
      if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
      return resolved;
    } catch {
      throw new Error(`run_recipe ${label} must be an existing directory workspace; open a session in the requested repository.`);
    }
  };
  const [repository, workspace] = await Promise.all([directory(repo, 'repository'), directory(cwd, 'session cwd')]);
  if (repository !== workspace) {
    throw new Error('run_recipe repository does not match the session workspace; open a session in the requested repository before running the recipe.');
  }
}

// ── resume records ──────────────────────────────────────────────────────────
const pidAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};
/** Read a claim file: { owner, raw, stat } or undefined when it is gone. `owner` is undefined when unknown. */
async function readClaim(file) {
  let info, raw;
  try { info = await stat(file); raw = await readFile(file, 'utf8'); } catch { return undefined; }
  let owner;
  try { owner = JSON.parse(raw); } catch { owner = undefined; }
  if (!owner || typeof owner !== 'object' || !Number.isSafeInteger(owner.pid)) owner = owner?.settled === true ? owner : undefined;
  return { owner, raw, info };
}
/**
 * F2 rule — a claim may be removed only when its owner can no longer be running it:
 *  - a `settled` claim (run finished but its record could not be marked consumed) is NEVER abandoned;
 *  - a known owner pid that is alive is NEVER abandoned, whatever its age;
 *  - a known owner pid that is dead is abandoned at once;
 *  - an unknown owner (empty legacy 0.1 claim, malformed content) is abandoned only after CLAIM_TTL_MS.
 */
function isAbandoned(claim, now = Date.now()) {
  if (!claim) return false;
  if (claim.owner?.settled === true) return false;
  if (claim.owner && Number.isSafeInteger(claim.owner.pid)) return !pidAlive(claim.owner.pid);
  return now - claim.info.mtimeMs > CLAIM_TTL_MS;
}
const RECLAIM_MUTEX_STALE_MS = 60e3;
/**
 * Race-safe removal of an abandoned claim.
 *  1. Reclaimers are serialized by a `<claim>.reclaim` mutex (created with 'wx'); contenders that
 *     cannot take it give up ("already being used") instead of waiting.
 *  2. Under the mutex the claim is re-read and must still be the very file that was judged stale
 *     (same inode, mtime and content) and still abandoned.
 *  3. It is renamed to a unique tombstone (atomic) and the tombstone is checked again; if it is not
 *     the judged file (a narrow legacy-owner race) it is linked back and removal fails.
 * Normal claimers only ever create the claim with 'wx', so after a successful removal at most one
 * contender can acquire it. Returns true only when the judged stale claim is gone.
 */
async function removeAbandonedClaim(file, judged, at = Date.now(), stillRemovable = isAbandoned) {
  if (!judged) return false;
  const mutex = `${file}.reclaim`;
  try { const fd = await open(mutex, 'wx', 0o600); try { await fd.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); } finally { await fd.close(); } }
  catch {
    // A crashed reclaimer must not wedge the token: clear its mutex, but still give up this attempt.
    try {
      const info = await stat(mutex);
      let holder; try { holder = JSON.parse(await readFile(mutex, 'utf8')); } catch { holder = undefined; }
      const dead = Number.isSafeInteger(holder?.pid) ? !pidAlive(holder.pid) : Date.now() - info.mtimeMs > RECLAIM_MUTEX_STALE_MS;
      if (dead) await unlink(mutex);
    } catch { /* best effort */ }
    return false;
  }
  try {
    const sameAsJudged = c => c !== undefined && c.info.ino === judged.info.ino && c.info.mtimeMs === judged.info.mtimeMs && c.raw === judged.raw;
    const current = await readClaim(file);
    if (!sameAsJudged(current) || !stillRemovable(current, at)) return false;
    const tomb = `${file}.${process.pid}.${randomUUID()}.tomb`;
    try { await rename(file, tomb); } catch { return false; }
    const moved = await readClaim(tomb);
    if (sameAsJudged(moved)) { await unlink(tomb).catch(() => {}); return true; }
    try { await link(tomb, file); } catch { /* a newer claim already exists */ }
    await unlink(tomb).catch(() => {});
    return false;
  } finally {
    await unlink(mutex).catch(() => {});
  }
}

/** Age of a claim: the older of its recorded createdAt and its mtime. */
const claimAge = (claim, now) => now - Math.min(claim.info.mtimeMs, Number.isFinite(claim.owner?.createdAt) ? claim.owner.createdAt : Infinity);
const TMP_RE = /^[0-9a-f-]{36}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/;

/**
 * Best-effort GC of RUNS_DIR. Never throws. Rules (R2-2):
 *  - `<id>.json` older than maxAgeMs is removed unless a claim still protects it;
 *  - `<id>.claim` is removed when abandoned (F2 rule: dead pid at once, unknown owner after CLAIM_TTL_MS);
 *  - a `settled` marker is removed with its expired record, or alone once its record is missing and the
 *    marker itself is older than maxAgeMs (the id then reads "not found", still never resumable);
 *  - a claim naming a pid older than CLAIM_ABSOLUTE_CAP_MS (7 days) is removed even if that pid is alive
 *    (pid reuse), but ONLY when its record is expired or missing — a run whose record is fresh is never
 *    pruned, and claimResume never applies this cap;
 *  - atomicWrite leftovers `<id>.json.<pid>.<uuid>.tmp` and reclaimer `.tomb`/`.reclaim` leftovers are
 *    removed once older than CLAIM_TTL_MS.
 */
export async function pruneRuns(dir = RUNS_DIR, { now = Date.now(), maxAgeMs = RUN_RECORD_MAX_AGE_MS } = {}) {
  let names;
  try { names = await readdir(dir); } catch { return; }
  const present = new Set(names);
  const recordExpired = async id => {
    if (!present.has(`${id}.json`)) return 'missing';
    try { return now - (await stat(path.join(dir, `${id}.json`))).mtimeMs > maxAgeMs ? 'expired' : 'fresh'; } catch { return 'missing'; }
  };
  // A claim may be pruned when abandoned, or (record expired/missing) when capped or an old settled marker.
  const prunable = (claim, state) => {
    if (!claim) return false;
    if (claim.owner?.settled === true) return state === 'expired' || (state === 'missing' && claimAge(claim, now) > maxAgeMs);
    if (isAbandoned(claim, now)) return true;
    return state !== 'fresh' && Number.isSafeInteger(claim.owner?.pid) && claimAge(claim, now) > CLAIM_ABSOLUTE_CAP_MS;
  };
  const pruneClaim = async (id, state) => {
    const file = path.join(dir, `${id}.claim`);
    const claim = await readClaim(file);
    if (!claim) return true; // already gone
    if (!prunable(claim, state)) return false;
    return removeAbandonedClaim(file, claim, now, current => prunable(current, state));
  };
  for (const entry of names) {
    const file = path.join(dir, entry);
    try {
      if (/\.(tomb|reclaim)$/.test(entry) || TMP_RE.test(entry)) {
        // Leftovers of a crashed reclaimer or of an interrupted atomicWrite: remove once clearly stale.
        if (now - (await stat(file)).mtimeMs > CLAIM_TTL_MS) await unlink(file);
        continue;
      }
      const match = /^(.{36})\.(json|claim)$/.exec(entry);
      if (!match || !UUID.test(match[1])) continue;
      const id = match[1];
      const state = await recordExpired(id);
      if (match[2] === 'claim') { await pruneClaim(id, state); continue; }
      if (state !== 'expired') continue;
      // Never delete a record a live run still protects.
      if (!(await pruneClaim(id, state))) continue;
      await unlink(file);
    } catch { /* best effort */ }
  }
}

async function atomicWrite(target, value) {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, target); }
  catch (error) { await unlink(tmp).catch(() => {}); throw error; }
}
let recordWriter = (write, target, value) => write(target, value);
/** Test seam: intercept record writes (fault injection). Returns a restore function. */
export function setRecordWriterForTests(hook) {
  const previous = recordWriter;
  recordWriter = typeof hook === 'function' ? hook : (write, target, value) => write(target, value);
  return () => { recordWriter = previous; };
}
async function writeRecord(dir, id, value) {
  await recordWriter(atomicWrite, path.join(dir, `${id}.json`), value);
}

export async function saveResume(resume, dir = RUNS_DIR) {
  await mkdir(dir, { recursive: true });
  await pruneRuns(dir);
  const id = randomUUID();
  await writeRecord(dir, id, resume);
  return id;
}

export async function loadResume(id, dir = RUNS_DIR) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('invalid resumeId');
  try { return JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8')); }
  catch { throw new Error(`resumeId ${id} not found; start a fresh run without resumeId`); }
}

/** Re-read the persisted record and merge `patch` into it (caller must hold the claim). */
export async function markResume(id, patch, dir = RUNS_DIR) {
  const current = await loadResume(id, dir);
  await writeRecord(dir, id, { ...current, ...patch });
}

// Swap the bulky `resume` object for a short id the coordinator can pass back.
export async function compactResult(value, save = saveResume) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.resume === undefined) return value;
  const { resume, ...rest } = value;
  return { ...rest, resumeId: await save(resume) };
}

// Resume records are bound to the owning session and exact contract; never replace missing
// human answers with a recommendation or silently drop answers from previous rounds.
// `request.decisions` must be VERIFIED answers (required questions + optional overrides).
export function validateResume(record, request, ownerSessionId) {
  if (record?.version !== 1 || record.ownerSessionId !== ownerSessionId || record.recipe !== request.recipe || record.task !== request.task || record.repo !== request.repo) throw new Error('resumeId does not belong to this session/recipe/task/repository');
  if (record.consumed) throw new Error('resumeId was already used');
  const decisions = { ...(record.confirmedDecisions || {}), ...(request.decisions || {}) };
  for (const q of record.pendingQuestions || []) {
    if (typeof decisions[q.id] !== 'string' || !decisions[q.id].trim()) throw new Error(`A human answer is required for decision "${q.id}"`);
  }
  return { resume: record.resume, decisions, overridable: Array.isArray(record.overridable) ? record.overridable : [] };
}

export async function scopeSnapshot(repo, scope) {
  const files = [...new Set([...(scope?.files || []), ...(scope?.tests || [])])].filter(x => typeof x === 'string');
  const hashes = {};
  for (const item of files) {
    const file = path.resolve(repo, item);
    if (file !== repo && !file.startsWith(path.resolve(repo) + path.sep)) continue;
    try { hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex'); }
    catch { hashes[file] = null; }
  }
  return hashes;
}

/**
 * Atomically claim a resume token for one run. The returned release() removes the claim; its
 * `record` is the persisted state re-read while holding the claim. The claim file records
 * {pid, createdAt}; a claim whose owner is dead or that is older than CLAIM_TTL_MS is reclaimed once.
 */
export async function claimResume(id, record, repo, dir = RUNS_DIR) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('invalid resumeId');
  const lock = path.join(dir, `${id}.claim`);
  const acquire = async () => { const fd = await open(lock, 'wx', 0o600); try { await fd.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); } finally { await fd.close(); } };
  try { await acquire(); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('resumeId is already being used by another run');
    const claim = await readClaim(lock);
    if (claim?.owner?.settled === true) throw new Error('resumeId was already used');
    // Reclaim once, and only if THIS contender removed the exact stale claim it judged.
    if (!isAbandoned(claim) || !(await removeAbandonedClaim(lock, claim))) throw new Error('resumeId is already being used by another run');
    try { await acquire(); } catch { throw new Error('resumeId is already being used by another run'); }
  }
  const release = () => unlink(lock).catch(() => {});
  // F5: the run settled but its record could not be marked consumed. Rewrite the claim as a
  // permanent `settled` marker (never treated as abandoned) and keep it, so the token stays blocked.
  release.markSettled = () => writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), settled: true }), { mode: 0o600 });
  try {
    const fresh = await loadResume(id, dir);
    if (fresh.consumed) throw new Error('resumeId was already used');
    if (record.scopeHashes && JSON.stringify(await scopeSnapshot(repo, { files: Object.keys(record.scopeHashes) })) !== JSON.stringify(record.scopeHashes)) throw new Error('Scoped files changed since the decision brief; start a fresh scoped analysis without resumeId');
    release.record = fresh;
    return release;
  } catch (error) { await release(); throw error; }
}

export const name = 'auto-subagents-recipes';
export const inject = ['tools', 'workflowEngine', 'subagentModelSelection', 'llm', 'subagents'];

const firstLine = text => String(text ?? '').split('\n')[0].slice(0, 160);
// Statuses that mean the run itself executed to a recipe-level outcome (token is spent).
const SETTLED = new Set(['completed', 'completed_with_failures', 'needs_decision', 'ended', 'aborted']);

/**
 * @param {object} ctx
 * @param {{ recipesDir?: string, runsDir?: string, setupCacheDir?: string }} [config]  overrides for tests/alternate homes
 */
export function apply(ctx, config = {}) {
  const recipesDir = typeof config?.recipesDir === 'string' ? config.recipesDir : RECIPES_DIR;
  const runsDir = typeof config?.runsDir === 'string' ? config.runsDir : path.join(recipesDir, '.runs');
  const cacheDir = typeof config?.setupCacheDir === 'string' ? config.setupCacheDir : setupCacheDir(runsDir);
  ctx.tools.register(defineTool({
    name: 'run_recipe',
    description: renderCatalogForTool(listApprovedRecipesSync(recipesDir)),
    parameters: {
      recipe: { type: 'string', required: true, description: 'Approved recipe name from the catalog in this tool description.' },
      task: { type: 'string', required: true, description: 'The change request in natural language. Must be identical when resuming.' },
      repo: { type: 'string', required: true, description: 'Absolute path of the repository. Must be identical when resuming.' },
      resumeId: { type: 'string', description: 'The resumeId from a previous needs_decision/ended result, to continue without repeating setup and analysis.' },
      totalTimeoutMs: { type: 'integer', description: `Optional whole-run wall-clock limit in milliseconds (default ${DEFAULT_TOTAL_TIMEOUT_MS}, max ${MAX_TOTAL_TIMEOUT_MS}). On expiry the run is cancelled and, when possible, a resumeId is returned in the error so work can continue.` },
      stepTimeoutMs: { type: 'json', description: 'Positive per-step timeout in milliseconds, or an object keyed by role/label; supplied through the authenticated recipe marker.' },
      decisions: { type: 'object', additionalProperties: true, description: 'Ignored (kept for compatibility). Human answers and overrides are read only from the verified ask_user_question result whose question ids are "<cardRunId>:<decision id>".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          agentsStarted: { type: 'integer', required: true },
          result: { type: 'json', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `recipe "${args.recipe}" finished (${value.agentsStarted} agents).\nResult:\n${JSON.stringify(value.result, null, 2)}` }],
    },
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('run_recipe requires a calling agent');
      if (!path.isAbsolute(args.repo)) throw new Error('repo must be an absolute path');
      const { meta, script, contract } = await loadRecipe(args.recipe, recipesDir);
      // Recipes belong to the top-level Auto coordinator. A stage worker inherits this tool through
      // its preset, and live evidence showed a setup child launching nested recipes (with the whole
      // user request) instead of delivering its structured report. Refuse in code, not in prose.
      // Placed after approval/contract validation (their precedence is unchanged) and before any
      // workspace, cache, resume, routing or engine work.
      const header = parent.session?.header;
      if (header?.origin === 'subagent' || Number(header?.delegationDepth) > 0) {
        throw new Error('run_recipe is only available to the top-level Auto coordinator; a subagent must deliver its own result through structured_output instead of starting another recipe.');
      }
      await assertRecipeWorkspace(args.repo, parent.session.header?.cwd);
      const setupKey = await setupCacheKey(args.repo, args.recipe);
      const cachedSetup = await loadSetupCache(setupKey, { dir: cacheDir });
      const ownerSessionId = String(parent.session.id);
      const preliminary = args.resumeId === undefined ? undefined : await loadResume(args.resumeId, runsDir);
      // The claim is held for the WHOLE run; the token is consumed only once the run reaches a
      // recipe-level outcome, so an engine error/cancel leaves the same answers retryable.
      const releaseClaim = preliminary ? await claimResume(args.resumeId, preliminary, args.repo, runsDir) : async () => {};
      const record = releaseClaim.record;
      const markRecord = async patch => { if (record) await markResume(args.resumeId, patch, runsDir); };
      let restored;
      try {
        const receivedAnswers = record === undefined ? undefined : verifiedDecisions(parent.session.snapshotEvents(), record.cardRunId, record.pendingQuestions, record.overridable);
        restored = record === undefined ? undefined : validateResume(record, { ...args, decisions: receivedAnswers }, ownerSessionId);
        await markRecord({ attemptStartedAt: Date.now() });
      } catch (error) { await releaseClaim(); throw error; }
      const resume = restored?.resume;
      const decisions = restored?.decisions;
      let keepClaim = false;
      // Mark the token consumed; retry once; if both fail keep the claim as a permanent `settled`
      // marker (claimResume then reports "already used") and surface the error to the caller.
      let tokenConsumed = false;
      const consumeToken = async () => {
        if (!record || tokenConsumed) return;
        tokenConsumed = true;
        const patch = () => ({ consumed: true, consumedAt: Date.now() });
        try { await markRecord(patch()); return; } catch (first) {
          ctx.logger?.warn?.(`auto-recipe: marking resume ${args.resumeId} consumed failed, retrying: ${String(first)}`);
        }
        try { await markRecord(patch()); return; } catch (second) {
          keepClaim = true;
          try { await releaseClaim.markSettled?.(); } catch (error) { ctx.logger?.warn?.(`auto-recipe: cannot write settled marker for ${args.resumeId}: ${String(error)}`); }
          throw new Error(`recipe "${args.recipe}" finished but its resumeId could not be marked consumed (${String(second?.message ?? second)}); the resumeId stays blocked — start a fresh run if needed`);
        }
      };
      const failAttempt = async () => { try { await markRecord({ lastAttemptFailedAt: Date.now() }); } catch (error) { ctx.logger?.warn?.(`auto-recipe: cannot record failed attempt: ${String(error)}`); } };
      const router = automaticRouter(ctx.subagentModelSelection, ctx.llm);
      let routing;
      const startFailures = [];
      const stepFailures = [];
      try { routing = registerWorkflowRouting({ subagents: ctx.subagents, router, parent, recipeRoles: contract.roles, retryImplementer: true,
        onStepFailure: failure => { if (stepFailures.length < 8) stepFailures.push(failure.message); ctx.logger?.warn?.(`auto-recipe: ${failure.message}`); },
        onRouteChange: event => ctx.emit('auto-subagents/route-changed', event),
        onStartFailure: failure => { if (startFailures.length < 8) startFailures.push(failure.message); ctx.logger?.warn?.(`auto-recipe: ${failure.message}`); } }); }
      catch (error) { await failAttempt(); await releaseClaim(); throw error; }
      const recipeArgs = {
        task: args.task,
        repo: args.repo,
        routingToken: routing.markerToken,
        reviewers: [{ label: 'review-1' }, { label: 'review-2' }],
        ...(cachedSetup ? { cachedSetup } : {}),
        ...(args.stepTimeoutMs !== undefined ? { stepTimeoutMs: args.stepTimeoutMs } : {}),
        ...(decisions !== undefined ? { decisions } : {}),
        ...(resume !== undefined ? { resume } : {}),
      };
      const runId = randomUUID();
      // Routes are chosen per child at admission; the card reads each agent's actual route.
      const tracker = new RunTracker(parent, runId, {}, msg => ctx.logger?.warn?.(msg));
      tracker.actualRouteFor = id => routing.childInfo(id);
      const childSeq = new Map();
      tracker.append(EVENT.RUN_START, {
        recipe: args.recipe, title: meta.title || meta.description || args.recipe, task: firstLine(args.task), repo: args.repo,
        resumed: resume !== undefined, round: resume?.round ?? 0,
      });
      // Engine events for THIS run only; subscriptions are disposed when the run settles.
      const disposers = [
        ctx.on('workflow/phase', (info, title) => tracker.onPhase(info, title)),
        ctx.on('workflow/agent-start', (info, agent) => { if (tracker.owns(info)) childSeq.set(String(agent.childId), agent.seq); tracker.onAgentStart(info, agent); }),
        ctx.on('auto-subagents/route-changed', ({ childId, route, reason, replacedChildId }) => {
          const seq = childSeq.get(String(childId)) ?? childSeq.get(String(replacedChildId));
          if (seq !== undefined) {
            childSeq.set(String(childId), seq);
            tracker.append(EVENT.AGENT_END, { seq, provider: route.provider, model: route.model, annotate: true,
              ...(reason ? { reason } : {}), ...(replacedChildId ? { childId, replacedChildId } : {}) });
          }
        }),
        ctx.on('workflow/agent-end', (info, agent) => tracker.onAgentEnd(info, agent)),
        ctx.on('workflow/log', (info, message) => tracker.onLog(info, message)),
      ];
      let run;
      try {
        // Recipe metadata includes approved plugin-only documentation (version/args). The
        // engine's WorkflowMeta contract is intentionally narrower; pass only its fields,
        // preserving their values so the real engine still rejects invalid known fields.
        const engineMeta = { name: meta.name, description: meta.description,
          ...(Object.hasOwn(meta, 'whenToUse') ? { whenToUse: meta.whenToUse } : {}),
          ...(Object.hasOwn(meta, 'phases') ? { phases: meta.phases } : {}) };
        run = ctx.workflowEngine.start({ script, meta: engineMeta, args: recipeArgs, parent, signal: exec.signal, subagentProvider: routing.providerName });
      } catch (error) {
        for (const d of disposers) d();
        tracker.append(EVENT.RUN_END, { status: 'error', error: String(error?.message ?? error).slice(0, 300) });
        try { await routing.dispose(); } finally { await failAttempt(); await releaseClaim(); }
        throw error;
      }
      tracker.bind(run.id);
      const totalMs = Number.isSafeInteger(args.totalTimeoutMs) && args.totalTimeoutMs > 0 ? Math.min(args.totalTimeoutMs, MAX_TOTAL_TIMEOUT_MS) : DEFAULT_TOTAL_TIMEOUT_MS;
      let deadlineHit = false;
      const deadline = setTimeout(() => { deadlineHit = true; run.cancel(`recipe exceeded its total time limit (${Math.round(totalMs / 60000)} min)`); }, totalMs);
      deadline.unref?.();
      // A failed/cancelled/timed-out run keeps its last checkpoint as a NEW resume record (the one just used,
      // if any, stays valid and unconsumed). Best effort: never masks the original failure.
      const saveCheckpointResume = async () => {
        const state = tracker.checkpoint;
        if (!state || state.task !== args.task || state.repo !== args.repo) return undefined;
        try {
          return await saveResume({
            version: 1, ownerSessionId, cardRunId: runId, recipe: args.recipe, task: args.task, repo: args.repo,
            confirmedDecisions: decisions || {}, pendingQuestions: [], overridable: [],
            // No scopeHashes: the interrupted run legitimately edited the scoped files.
            consumed: false, resume: state,
          }, runsDir);
        } catch (error) { ctx.logger?.warn?.(`auto-recipe: cannot save checkpoint resume: ${String(error)}`); return undefined; }
      };
      const failureNote = async () => {
        const resumeId = await saveCheckpointResume();
        const parts = [];
        if (stepFailures.length) parts.push(`step failures: ${stepFailures.join(' | ')}`);
        if (startFailures.length) parts.push(`start failures: ${startFailures.join(' | ')}`);
        if (resumeId) parts.push(`partial work is saved: call run_recipe again with the SAME recipe, task and repo plus resumeId "${resumeId}" to continue from the last checkpoint (inspect git status/diff first; do not restart from scratch)`);
        else if (resume !== undefined && args.resumeId) parts.push(`the previous resumeId "${args.resumeId}" is still valid and can be retried`);
        return parts.length ? ` [${parts.join('; ')}]` : '';
      };
      const onAbort = () => run.cancel('parent step aborted');
      exec.signal.addEventListener('abort', onAbort, { once: true });
      let endRecorded = false;
      let settled = false;
      try {
        const result = await run.result;
        if (result.stopReason !== 'completed') {
          const note = await failureNote();
          const why = deadlineHit ? 'stopped: total time limit reached' : result.stopReason;
          tracker.append(EVENT.RUN_END, { status: result.stopReason === 'cancelled' && !deadlineHit ? 'cancelled' : 'error', error: String(`${result.error ?? why}${note}`).slice(0, 600) });
          endRecorded = true;
          throw new Error(`recipe "${args.recipe}" ${why}${result.error ? `: ${result.error}` : ''}${note}`);
        }
        const raw = result.value;
        // Cache only fresh setup; hits and resume reuse must not extend the seven-day TTL.
        if (!cachedSetup && !resume) await saveSetupCache(setupKey, raw?.setup ?? raw?.resume?.setup, { dir: cacheDir });
        const rawStatus = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.status : 'completed';
        // R2-1: the run reached a recipe-level outcome BEFORE its result is persisted. From here on it
        // must never be treated as a failed, retryable attempt (F5), even if saving the result fails.
        if (SETTLED.has(rawStatus)) settled = true;
        let value;
        try {
          value = await compactResult(raw, async next => saveResume({
          version: 1, ownerSessionId, cardRunId: runId, recipe: args.recipe, task: args.task, repo: args.repo,
          confirmedDecisions: decisions || {}, pendingQuestions: raw.questions || [],
          // decidedForYou ids the human may override through a verified answer on resume.
          overridable: Array.isArray(raw.decidedForYou) ? raw.decidedForYou.map(d => String(d?.id)).filter(id => id && id !== 'undefined') : [],
          scopeHashes: await scopeSnapshot(args.repo, next.analysis?.scope),
          consumed: false, resume: next,
        }, runsDir));
        } catch (saveError) {
          if (!settled) throw saveError;
          try { await consumeToken(); }
          catch (consumeError) { throw new Error(`recipe "${args.recipe}" finished but its result could not be saved (${String(saveError?.message ?? saveError)}); ${String(consumeError?.message ?? consumeError)}`, { cause: saveError }); }
          throw new Error(`recipe "${args.recipe}" finished but its result could not be saved (${String(saveError?.message ?? saveError)}); the resumeId was consumed — start a fresh run`, { cause: saveError });
        }
        const plain = value && typeof value === 'object' && !Array.isArray(value) ? value : { status: 'completed' };
        if (SETTLED.has(plain.status)) {
          settled = true;
          await consumeToken();
        }
        if (plain.status === 'needs_decision') {
          tracker.append(EVENT.DECISION, {
            resumeId: plain.resumeId, stage: plain.stage ?? 'analysis', questions: compactQuestions(plain.questions),
            decidedForYou: compactDecided(plain.decidedForYou), currentState: String(plain.currentState ?? '').slice(0, 600),
          });
        }
        tracker.append(EVENT.RUN_END, {
          status: plain.status, stage: plain.stage ?? null,
          changedPaths: Array.isArray(plain.changedPaths) ? plain.changedPaths.slice(0, 30) : [],
          passed: plain.passed ?? null, iterations: plain.iterations ?? null,
          ...(plain.status === 'ended' ? { reason: String(plain.reason ?? '').slice(0, 400) } : {}),
        });
        endRecorded = true;
        // `agentsStarted` counts attempted starts; startFailures explains starts that never admitted a child.
        return { runId: run.id, agentsStarted: result.agentsStarted, result: { ...plain, cardRunId: runId, ...(startFailures.length ? { startFailures } : {}), ...(stepFailures.length ? { stepFailures } : {}) } };
      } catch (error) {
        if (!endRecorded) tracker.append(EVENT.RUN_END, { status: 'error', error: String(error?.message ?? error).slice(0, 600) });
        throw error;
      } finally {
        clearTimeout(deadline);
        for (const d of disposers) d();
        exec.signal.removeEventListener('abort', onAbort);
        try { await run.dispose(); } finally {
          try { await routing.dispose(); } finally {
            try { if (!settled) await failAttempt(); } finally { if (!keepClaim) await releaseClaim(); }
          }
        }
      }
    },
  }));
}
