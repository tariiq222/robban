// Synchronous discovery for tool registration and SystemPrompt callbacks. Keep the integrity
// twin aligned with recipe-integrity.mjs; parity tests guard every approval failure mode.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { RECIPES_DIR } from './dsh-paths.mjs';
import { validateRecipeMeta } from './recipe-contract.mjs';
import { LOCK_FILE, LOCK_VERSION, recipeDigest, changedFiles } from './recipe-integrity.mjs';
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const approveHint = name => `run node scripts/approve-recipe.mjs ${name}`;

function readLockSync(base) {
  const name = path.basename(base);
  let text;
  try { text = readFileSync(path.join(base, LOCK_FILE), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  let lock;
  try { lock = JSON.parse(text); } catch { throw new Error(`recipe "${name}" is not approved: ${LOCK_FILE} is malformed JSON; ${approveHint(name)}`); }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error(`recipe "${name}" is not approved: ${LOCK_FILE} is malformed; ${approveHint(name)}`);
  if (lock.version !== LOCK_VERSION) throw new Error(`recipe "${name}" is not approved: unsupported ${LOCK_FILE} version ${JSON.stringify(lock.version)}; ${approveHint(name)}`);
  if (lock.name !== name) throw new Error(`recipe "${name}" is not approved: ${LOCK_FILE} names "${lock.name}"; ${approveHint(name)}`);
  if (!HEX64.test(lock.sha256?.meta ?? '') || !HEX64.test(lock.sha256?.script ?? '')) throw new Error(`recipe "${name}" is not approved: ${LOCK_FILE} has malformed digests; ${approveHint(name)}`);
  return lock;
}

export function loadVerifiedRecipeSync(name, dir = RECIPES_DIR) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`invalid recipe name "${name}"`);
  const base = path.join(dir, name);
  let metaText, script;
  try { metaText = readFileSync(path.join(base, 'meta.json'), 'utf8'); script = readFileSync(path.join(base, 'script.js'), 'utf8'); }
  catch { throw new Error(`recipe "${name}" not found in ${dir}`); }
  let meta;
  try { meta = JSON.parse(metaText); } catch { throw new Error(`recipe "${name}" meta.json is not valid JSON`); }
  if (meta?.name !== name) throw new Error(`recipe "${name}" meta.name is "${meta?.name}"`);
  const lock = readLockSync(base);
  if (!lock) throw new Error(`recipe "${name}" is not approved; ${approveHint(name)}`);
  const changed = changedFiles(lock, recipeDigest({ metaText, script }));
  if (changed.length) throw new Error(`recipe "${name}" changed since approval (${changed.join(', ')}); review and re-approve: ${approveHint(name)}`);
  const contract = validateRecipeMeta(meta, { name });
  return { meta, script, contract };
}

export function listApprovedRecipesSync(dir = RECIPES_DIR) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const catalog = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    try {
      const { meta, contract } = loadVerifiedRecipeSync(entry.name, dir);
      catalog.push({ name: entry.name, description: String(meta.description ?? ''), ...(contract.whenToUse === undefined ? {} : { whenToUse: contract.whenToUse }) });
    } catch { /* only approved, intact, contract-valid recipes are discoverable */ }
  }
  return catalog.sort((a, b) => a.name.localeCompare(b.name));
}

export const CATALOG_LIMITS = Object.freeze({ maxEntries: 20, maxName: 100, maxDescription: 200, maxWhenToUse: 300 });
/** Sanitize before truncation and also sanitize the final assembly to disable Host {{ interpolation. */
export function sanitizeCatalogText(value, maxLength = Infinity) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').replace(/\{/g, '(').replace(/\}/g, ')').trim();
  return text.length > maxLength ? text.slice(0, Math.max(0, maxLength - 1)) + '…' : text;
}
function renderEntries(catalog) {
  if (!catalog.length) return 'No approved recipes available; use ordinary subagents.';
  const displayed = catalog.slice(0, CATALOG_LIMITS.maxEntries).map(entry => {
    const name = sanitizeCatalogText(entry.name, CATALOG_LIMITS.maxName);
    const description = sanitizeCatalogText(entry.description, CATALOG_LIMITS.maxDescription);
    const when = entry.whenToUse === undefined ? '' : `; when to use: ${sanitizeCatalogText(entry.whenToUse, CATALOG_LIMITS.maxWhenToUse)}`;
    return `${name} — ${description}${when}`;
  });
  if (catalog.length > displayed.length) displayed.push(`${catalog.length - displayed.length} more not shown`);
  return displayed.join('; ');
}
const RESULT_GUIDANCE = 'Result statuses: "completed"/"completed_with_failures" (report to the user), "needs_decision" (ask the user ALL returned questions in ONE ask_user_question call with ids "<cardRunId>:<id>"; you may add one optional question per decidedForYou item with id "<cardRunId>:<decidedForYou.id>" so the user can override it; then call run_recipe again with the same recipe, task and repo plus resumeId — answers are read from that verified ask_user_question result), "ended" (analysis found nothing to do; tell the user why), "aborted" (a loop hit its limit; report the review trail; the result may carry a resumeId: offer to continue with a fresh round budget and resume ONLY if the user agrees). If a run fails, times out (total time limit) or is stopped, the error text may name a resumeId holding the last checkpoint: call run_recipe again with the same recipe, task, repo and that resumeId to continue instead of restarting. If a resumed run fails (error/cancel) the same resumeId stays valid and can be retried.';

export function renderCatalogForTool(catalog) {
  return sanitizeCatalogText('Run a saved, approved workflow recipe by name (you cannot write workflow scripts yourself). Approved recipes: '
    + renderEntries(catalog) + (catalog.length ? '' : ' run_recipe cannot run until a recipe is approved.') + ' Models are chosen from saved Subagent settings by tier; do not pass models. ' + RESULT_GUIDANCE);
}

const COORDINATOR_GUIDANCE = `Match the request intent to an approved recipe using its description and when-to-use guidance, not whether it edits code. This includes investigation, acceptance verification, package planning, source audit, behavior-preserving refactoring, defect repair and feature implementation. Only select names from the current approved catalog. Use a fitting approved recipe through \`run_recipe\` rather than recreating its steps with ordinary subagents. A read-only request must stay read-only: never substitute a writing recipe for investigation, verification, audit or planning. If no approved recipe fits, use ordinary subagents; keep them for unrelated research, conversational questions and simple lookups that do not need a recipe.
- LARGE requests (a whole plan, many features, "implement the product end to end"): first use an approved package-planning recipe when it fits, or read enough to split the request into independent, reviewable work packages (one feature or one cohesive change each, with its own scope and acceptance). Show the package list to the user. Planning alone never authorizes implementation: only execute packages when the user's request authorizes it. Recheck each suggested recipe against the current approved catalog; unresolved manual choices require clarification. Then run \`run_recipe\` once per authorized package, in dependency order. Packages with non-overlapping file scopes and no dependency may run in parallel (separate run_recipe calls in the same round).
- Pass the user's request as \`task\` (verbatim intent, in English if needed for precision) and the absolute \`repo\` path matching the session workspace. If the repository differs, ask the user to open a session in that repository; do not attempt to bypass the workspace check. Never pass models: the tool routes each step by tier from saved settings. Canonical reviewers exclude the implementer's route when an alternative is available; do not assume a custom checker necessarily uses a different model.
- \`needs_decision\`: ask the user ALL returned questions in ONE ask_user_question call. Set each question id EXACTLY to \`<cardRunId>:<decision.id>\` (the result provides cardRunId). This binds the visual card's answer button to the live Host question. Never invent or default a missing answer. For each, show the current state, every option with its consequence, and mark the recommendation. To let the user override a \`decidedForYou\` item, add it to the SAME batch as an optional question with id EXACTLY \`<cardRunId>:<decidedForYou.id>\` whose FIRST option is the explicit keep option: its \`label\` must be exactly \`__keep__\` (ask_user_question returns option labels as answers; put the human-readable "keep the current decision: <full decision>" in that option's \`description\`), plus alternatives whose labels are written in full; never offer or pass truncated/compacted decision text (e.g. ending in "…") as an answer value. \`__keep__\` keeps the decision made for the user and is never a valid answer to a required question; never add ids that are neither a returned question nor a decidedForYou id, or the whole batch is rejected. Then call run_recipe again with the same recipe, task and repo and the returned \`resumeId\`. Do not pass \`decisions\`: run_recipe ignores it and reads answers and overrides only from that verified ask_user_question result. If a resumed run fails with an error or is cancelled, the same \`resumeId\` stays valid: retry it without asking again.
- \`ended\`: explain why nothing was changed; offer to proceed anyway only if the user wants.
- Failure, timeout or user stop: if the error names a resumeId, tell the user partial work is saved (changes remain uncommitted) and offer to continue with it; never silently restart from scratch and never claim the run succeeded. \`aborted\` with a resumeId: report the findings and ask before continuing.
- \`completed\`: report changed files, validation, the review trail (any rejection and repair), confirmed decisions and assumptions. \`completed_with_failures\` or \`aborted\`: report exactly what failed; do not claim success.
- You may still delegate a follow-up subagent (e.g. an extra verification) after a recipe run.`;
export function renderCatalogForCoordinator(catalog) {
  return sanitizeCatalogText('## Recipes (run_recipe) Approved recipes: ' + renderEntries(catalog) + ' ' + COORDINATOR_GUIDANCE);
}
