// Recipe approval lock: <recipes>/<name>/recipe.lock.json records the sha256 of meta.json and
// script.js at the moment a human reviewed and approved the recipe. run_recipe refuses to execute a
// recipe whose files no longer match.
//
// Threat model (honest framing): this is TAMPER-EVIDENT, not a cryptographic signature. It catches
// unreviewed or accidental edits and other tooling silently changing a recipe. Anyone who can write
// both script.js and recipe.lock.json can re-approve; protection against that requires keeping the
// lock outside the writer's reach (or real signing), which this module does not provide.
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';

export const LOCK_FILE = 'recipe.lock.json';
export const LOCK_VERSION = 1;

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

export function recipeDigest({ metaText, script }) {
  if (typeof metaText !== 'string' || typeof script !== 'string') throw new TypeError('recipeDigest needs metaText and script strings');
  return { meta: sha256(metaText), script: sha256(script) };
}

const approveHint = name => `run node scripts/approve-recipe.mjs ${name}`;

/** Read and structurally validate a lock; returns undefined when the file is absent. */
export async function readLock(base) {
  const name = path.basename(base);
  let text;
  try { text = await readFile(path.join(base, LOCK_FILE), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  let lock;
  try { lock = JSON.parse(text); } catch { throw new Error(`recipe "${name}" is not approved: ${LOCK_FILE} is malformed JSON; ${approveHint(name)}`); }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error(`recipe "${name}" is not approved: ${LOCK_FILE} is malformed; ${approveHint(name)}`);
  if (lock.version !== LOCK_VERSION) throw new Error(`recipe "${name}" is not approved: unsupported ${LOCK_FILE} version ${JSON.stringify(lock.version)}; ${approveHint(name)}`);
  if (lock.name !== name) throw new Error(`recipe "${name}" is not approved: ${LOCK_FILE} names "${lock.name}"; ${approveHint(name)}`);
  if (!HEX64.test(lock.sha256?.meta ?? '') || !HEX64.test(lock.sha256?.script ?? '')) throw new Error(`recipe "${name}" is not approved: ${LOCK_FILE} has malformed digests; ${approveHint(name)}`);
  return lock;
}

/** Changed file names ('script.js', 'meta.json') between a lock and current digests. */
export function changedFiles(lock, digest) {
  const changed = [];
  if (lock.sha256.script !== digest.script) changed.push('script.js');
  if (lock.sha256.meta !== digest.meta) changed.push('meta.json');
  return changed;
}

export async function verifyRecipeIntegrity(base, { meta, script, metaText } = {}) {
  const name = path.basename(base);
  const lock = await readLock(base);
  if (!lock) throw new Error(`recipe "${name}" is not approved; ${approveHint(name)}`);
  if (meta !== undefined && meta?.name !== name) throw new Error(`recipe "${name}" meta.name is "${meta?.name}"`);
  const text = typeof metaText === 'string' ? metaText : await readFile(path.join(base, 'meta.json'), 'utf8');
  const body = typeof script === 'string' ? script : await readFile(path.join(base, 'script.js'), 'utf8');
  const changed = changedFiles(lock, recipeDigest({ metaText: text, script: body }));
  if (changed.length) throw new Error(`recipe "${name}" changed since approval (${changed.join(', ')}); review and re-approve: ${approveHint(name)}`);
  return lock;
}

/** Current digests of the files on disk, after validating meta.name. */
export async function currentDigest(base) {
  const name = path.basename(base);
  const [metaText, script] = await Promise.all([
    readFile(path.join(base, 'meta.json'), 'utf8'),
    readFile(path.join(base, 'script.js'), 'utf8'),
  ]).catch(() => { throw new Error(`recipe "${name}" not found in ${path.dirname(base)} (needs meta.json and script.js)`); });
  let meta;
  try { meta = JSON.parse(metaText); } catch { throw new Error(`recipe "${name}" meta.json is not valid JSON`); }
  if (meta?.name !== name) throw new Error(`recipe "${name}" meta.name is "${meta?.name}"`);
  return recipeDigest({ metaText, script });
}

export async function approveRecipe(base, { approvedBy } = {}) {
  const name = path.basename(base);
  const sha = await currentDigest(base);
  const lock = { version: LOCK_VERSION, name, sha256: sha, approvedAt: new Date().toISOString(), approvedBy: String(approvedBy ?? process.env.USER ?? 'unknown') };
  const target = path.join(base, LOCK_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
  await chmod(target, 0o600);
  return lock;
}
