#!/usr/bin/env node
// Check or re-apply the installed-runtime patches Auto Subagents still needs (core-patches/).
//
//   node scripts/reapply-core-patches.mjs --check   report applied/original/drifted/missing per target;
//                                                   exit 1 when any target is not applied
//   node scripts/reapply-core-patches.mjs --apply   validate EVERY target first; write only when each
//                                                   target is exactly the recorded original (or already
//                                                   patched); refuse on drift/missing; back up first
//
// The runtime directory comes from lib/dsh-paths.mjs (DSH_RUNTIME_DIR env overrides). Never restarts
// DSH: a running `dsh web` keeps old module bytes until a safe, user-chosen restart.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PATCH_DIR = path.join(PKG_ROOT, 'core-patches');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function loadManifest(patchDir = PATCH_DIR) {
  const manifest = JSON.parse(readFileSync(path.join(patchDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.targets)) throw new Error('unsupported core-patches manifest');
  return manifest;
}

/** One status per target: applied | original | drifted | missing. */
export function checkPatches({ runtimeDir, patchDir = PATCH_DIR } = {}) {
  const manifest = loadManifest(patchDir);
  return manifest.targets.map(target => {
    const file = path.join(runtimeDir, 'node_modules', target.target);
    if (!existsSync(file)) return { id: target.id, file, status: 'missing' };
    const current = sha(readFileSync(file));
    const status = current === target.patchedSha256 ? 'applied' : current === target.originalSha256 ? 'original' : 'drifted';
    return { id: target.id, file, status, sha256: current };
  });
}

/**
 * All-or-nothing:
 *  - refuses before writing anything if any target drifted or is missing, or a bundled patch file
 *    does not match the manifest;
 *  - backs up EVERY target first (a backup failure aborts before any runtime write);
 *  - writes targets one by one; if any write fails, every target already written (and the failing
 *    one) is restored from the backup and the error is rethrown with a rollback report.
 * `writeFile`/`copyFile` are injectable for fault-injection tests only.
 */
export function applyPatches({ runtimeDir, patchDir = PATCH_DIR, backupDir, now = new Date(), writeFile = writeFileSync, copyFile = copyFileSync } = {}) {
  const manifest = loadManifest(patchDir);
  const report = checkPatches({ runtimeDir, patchDir });
  const bad = report.filter(r => r.status === 'drifted' || r.status === 'missing');
  if (bad.length) throw new Error(`refusing to patch: ${bad.map(r => `${r.id} (${r.status}) ${r.file}`).join('; ')}. The runtime is not DSH ${manifest.dshVersion} as recorded; review and regenerate core-patches before applying.`);
  const todo = report.filter(r => r.status === 'original');
  // Verify bundled patch bytes match the manifest before touching the runtime.
  const payloads = new Map();
  for (const r of todo) {
    const target = manifest.targets.find(t => t.id === r.id);
    const bytes = readFileSync(path.join(patchDir, target.patched));
    if (sha(bytes) !== target.patchedSha256) throw new Error(`core-patches/${target.patched} does not match its manifest hash`);
    payloads.set(r.id, bytes);
  }
  if (!todo.length) return { applied: [], backupDir: null, report };
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const dir = backupDir ?? path.join(runtimeDir, '..', 'backups', `core-patches-${stamp}`);
  const backups = new Map();
  for (const r of todo) {
    const rel = path.relative(path.join(runtimeDir, 'node_modules'), r.file);
    const dest = path.join(dir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFile(r.file, dest);
    // Never trust a backup we cannot verify: it is the rollback source.
    const target = manifest.targets.find(t => t.id === r.id);
    if (sha(readFileSync(dest)) !== target.originalSha256) throw new Error(`backup of ${r.id} does not match the recorded original; nothing was written`);
    backups.set(r.id, dest);
  }
  const touched = [];
  try {
    for (const r of todo) {
      touched.push(r);
      writeFile(r.file, payloads.get(r.id));
    }
  } catch (error) {
    const restoreFailures = [];
    for (const r of touched) {
      try { writeFileSync(r.file, readFileSync(backups.get(r.id))); }
      catch (restoreError) { restoreFailures.push(`${r.id}: ${String(restoreError?.message ?? restoreError)}`); }
    }
    const detail = restoreFailures.length
      ? `rollback INCOMPLETE (${restoreFailures.join('; ')}); restore manually from ${dir}`
      : `rolled back ${touched.map(r => r.id).join(', ')} from ${dir}`;
    throw new Error(`core patch write failed (${String(error?.message ?? error)}); ${detail}`);
  }
  return { applied: todo.map(r => r.id), backupDir: dir, report: checkPatches({ runtimeDir, patchDir }) };
}

async function main() {
  throw new Error('Historical 0.1.5 patches cannot be applied by the 0.2.0 Auto package; use the source engine changes.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
}
