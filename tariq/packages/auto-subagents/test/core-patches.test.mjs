import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync as writeFileSyncReal } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { checkPatches, applyPatches, loadManifest, PATCH_DIR } from '../scripts/reapply-core-patches.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');

// A small fake core-patches dir + fake runtime, so tests never touch the real runtime.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ars-core-'));
  const patchDir = path.join(root, 'patches');
  const runtimeDir = path.join(root, 'runtime');
  const targets = [];
  for (const id of ['a', 'b']) {
    await mkdir(path.join(patchDir, id), { recursive: true });
    const original = `original ${id}\n`, patched = `patched ${id}\n`;
    await writeFile(path.join(patchDir, id, 'original.js'), original);
    await writeFile(path.join(patchDir, id, 'patched.js'), patched);
    const target = `@x/pkg-${id}/lib/index.js`;
    await mkdir(path.dirname(path.join(runtimeDir, 'node_modules', target)), { recursive: true });
    await writeFile(path.join(runtimeDir, 'node_modules', target), original);
    targets.push({ id, target, original: `${id}/original.js`, patched: `${id}/patched.js`, originalSha256: sha(original), patchedSha256: sha(patched) });
  }
  await writeFile(path.join(patchDir, 'manifest.json'), JSON.stringify({ version: 1, dshVersion: 'test', targets }));
  const file = id => path.join(runtimeDir, 'node_modules', `@x/pkg-${id}/lib/index.js`);
  return { root, patchDir, runtimeDir, file, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('check classifies original, applied, drifted and missing targets', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(checkPatches(f).map(r => r.status), ['original', 'original']);
    await writeFile(f.file('a'), 'patched a\n');
    await writeFile(f.file('b'), 'someone else edited this\n');
    assert.deepEqual(checkPatches(f).map(r => r.status), ['applied', 'drifted']);
    await rm(f.file('b'));
    assert.deepEqual(checkPatches(f).map(r => r.status), ['applied', 'missing']);
  } finally { await f.cleanup(); }
});

test('apply backs up originals, writes patched bytes and is idempotent', async () => {
  const f = await fixture();
  try {
    const backupDir = path.join(f.root, 'bk');
    const out = applyPatches({ ...f, backupDir });
    assert.deepEqual(out.applied, ['a', 'b']);
    assert.equal(await readFile(f.file('a'), 'utf8'), 'patched a\n');
    assert.equal(await readFile(path.join(backupDir, '@x/pkg-a/lib/index.js'), 'utf8'), 'original a\n');
    assert.deepEqual(out.report.map(r => r.status), ['applied', 'applied']);
    const again = applyPatches({ ...f, backupDir: path.join(f.root, 'bk2') });
    assert.deepEqual(again.applied, []);
    assert.equal(existsSync(path.join(f.root, 'bk2')), false);
  } finally { await f.cleanup(); }
});

test('apply refuses on any drift before writing anything', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file('b'), 'upstream changed\n');
    assert.throws(() => applyPatches({ ...f, backupDir: path.join(f.root, 'bk') }), /refusing to patch: b \(drifted\)/);
    assert.equal(await readFile(f.file('a'), 'utf8'), 'original a\n', 'no partial application');
    assert.equal(existsSync(path.join(f.root, 'bk')), false);
  } finally { await f.cleanup(); }
});

test('apply refuses when a bundled patch file does not match its manifest hash', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.patchDir, 'a', 'patched.js'), 'tampered\n');
    assert.throws(() => applyPatches({ ...f, backupDir: path.join(f.root, 'bk') }), /does not match its manifest hash/);
    assert.equal(await readFile(f.file('a'), 'utf8'), 'original a\n');
  } finally { await f.cleanup(); }
});

test('shipped manifest is self-consistent with the bundled patch files', () => {
  const manifest = loadManifest();
  assert.equal(manifest.dshVersion, '0.1.5-rc.2');
  assert.ok(manifest.targets.length >= 1);
  for (const t of manifest.targets) {
    assert.equal(sha(readFileSync(path.join(PATCH_DIR, t.original))), t.originalSha256, `${t.id} original`);
    assert.equal(sha(readFileSync(path.join(PATCH_DIR, t.patched))), t.patchedSha256, `${t.id} patched`);
    assert.notEqual(t.originalSha256, t.patchedSha256, `${t.id} patch is a no-op`);
    assert.ok(!path.isAbsolute(t.target) && !t.target.includes('..'), `${t.id} target must be runtime-relative`);
  }
});

test('F6: apply is transactional — a write failure restores every file already written from the backup', async () => {
  const f = await fixture();
  try {
    const backupDir = path.join(f.root, 'bk');
    let writes = 0;
    const failingWrite = (file, bytes) => { writes += 1; if (writes === 2) throw Object.assign(new Error('ENOSPC injected'), { code: 'ENOSPC' }); writeFileSyncReal(file, bytes); };
    assert.throws(() => applyPatches({ ...f, backupDir, writeFile: failingWrite }), /ENOSPC injected[\s\S]*rolled back/);
    assert.equal(await readFile(f.file('a'), 'utf8'), 'original a\n', 'first target restored');
    assert.equal(await readFile(f.file('b'), 'utf8'), 'original b\n', 'second target untouched');
    assert.deepEqual(checkPatches(f).map(r => r.status), ['original', 'original']);
    assert.equal(await readFile(path.join(backupDir, '@x/pkg-a/lib/index.js'), 'utf8'), 'original a\n', 'backup kept for inspection');
  } finally { await f.cleanup(); }
});

test('F6: a failing backup aborts before any runtime file is written', async () => {
  const f = await fixture();
  try {
    let wrote = false;
    assert.throws(() => applyPatches({ ...f, backupDir: path.join(f.root, 'bk'), copyFile: () => { throw new Error('backup failed'); }, writeFile: () => { wrote = true; } }), /backup failed/);
    assert.equal(wrote, false);
    assert.deepEqual(checkPatches(f).map(r => r.status), ['original', 'original']);
  } finally { await f.cleanup(); }
});
