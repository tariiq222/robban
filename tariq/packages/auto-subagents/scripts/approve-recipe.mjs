#!/usr/bin/env node
// Approve (or check) a saved workflow recipe after human review.
//   node scripts/approve-recipe.mjs <name> [--recipes-dir DIR] [--check] [--yes] [--by WHO]
// --check   verify the lock against current files; exit 0 ok, 1 not approved/changed, 2 usage error.
// --yes     required to REPLACE an existing lock whose digests differ (re-approval after review).
// Tamper-evident only: see lib/recipe-integrity.mjs for the threat model.
import path from 'node:path';
import { RECIPES_DIR } from '../lib/dsh-paths.mjs';
import { approveRecipe, currentDigest, readLock, changedFiles, verifyRecipeIntegrity, LOCK_FILE } from '../lib/recipe-integrity.mjs';

const USAGE = 'usage: node scripts/approve-recipe.mjs <name> [--recipes-dir DIR] [--check] [--yes] [--by WHO]';
const NAME = /^[a-z0-9][a-z0-9-]*$/;

function parse(argv) {
  const opts = { dir: RECIPES_DIR, check: false, yes: false, by: undefined, name: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--recipes-dir' || arg === '--by') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--by') opts.by = value; else opts.dir = path.resolve(value);
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (opts.name === undefined) opts.name = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!opts.name || !NAME.test(opts.name)) throw new Error('a valid recipe name is required');
  return opts;
}

const short = hex => (hex ? hex.slice(0, 12) : '(none)');

export async function main(argv, out = console.log, err = console.error) {
  let opts;
  try { opts = parse(argv); } catch (error) { err(`${error.message}\n${USAGE}`); return 2; }
  const base = path.join(opts.dir, opts.name);
  try {
    if (opts.check) {
      const lock = await verifyRecipeIntegrity(base);
      out(`ok: recipe "${opts.name}" matches ${LOCK_FILE} (approved ${lock.approvedAt} by ${lock.approvedBy})`);
      return 0;
    }
    const next = await currentDigest(base);
    let previous;
    try { previous = await readLock(base); } catch (error) { out(`existing ${LOCK_FILE} is invalid and will be replaced: ${error.message}`); }
    if (previous) {
      const changed = changedFiles(previous, next);
      if (!changed.length) {
        out(`recipe "${opts.name}" already approved with identical digests (${previous.approvedAt} by ${previous.approvedBy}); nothing to do`);
        return 0;
      }
      out(`recipe "${opts.name}" differs from its approval (${changed.join(', ')}):`);
      for (const key of ['script', 'meta']) out(`  ${key.padEnd(6)} ${short(previous.sha256[key])} -> ${short(next[key])}`);
      if (!opts.yes) { err('refusing to replace an existing approval without --yes (review the changes first)'); return 1; }
    } else {
      out(`approving recipe "${opts.name}":`);
      for (const key of ['script', 'meta']) out(`  ${key.padEnd(6)} (none) -> ${short(next[key])}`);
    }
    const lock = await approveRecipe(base, { approvedBy: opts.by });
    out(`wrote ${path.join(base, LOCK_FILE)} (approvedBy: ${lock.approvedBy})`);
    return 0;
  } catch (error) {
    err(`error: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('approve-recipe.mjs')) {
  process.exitCode = await main(process.argv.slice(2));
}
