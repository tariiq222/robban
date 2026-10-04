// Best-effort manifest-keyed setup cache. No session reads or implicit filesystem writes.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, mkdir, chmod, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
export const SETUP_CACHE_TTL_MS = 7 * 24 * 3600e3;
const KEY = /^[a-f0-9]{64}$/;
const MANIFESTS = new Set(['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'pyproject.toml', 'Makefile', 'go.mod', 'Cargo.toml']);
export const validSetup = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && typeof value.stack === 'string'
  && ['testCommands', 'lintCommands', 'conventions'].every(key => Array.isArray(value[key]) && value[key].every(item => typeof item === 'string'))
  && Object.keys(value).every(key => ['stack', 'testCommands', 'lintCommands', 'conventions'].includes(key)));
export const setupCacheDir = runsDir => path.join(runsDir, '..', '.cache', 'setup');
export async function setupCacheKey(repo, recipeName) {
  try {
    const root = await realpath(repo);
    if (typeof recipeName !== 'string' || !recipeName) return null;
    const names = (await readdir(root)).filter(name => MANIFESTS.has(name) || /^requirements.*\.txt$/.test(name)).sort();
    const hash = createHash('sha256');
    // Length framing avoids ambiguous concatenations and includes filenames for additions/removals.
    const add = data => { const bytes = Buffer.from(data); hash.update(String(bytes.length) + ':').update(bytes); };
    add(root); add(recipeName);
    for (const name of names) { add(name); add(await readFile(path.join(root, name))); }
    return hash.digest('hex');
  } catch { return null; }
}
export async function loadSetupCache(key, { dir, now = Date.now(), ttlMs = SETUP_CACHE_TTL_MS } = {}) {
  try {
    if (!KEY.test(key) || typeof dir !== 'string') return null;
    const entry = JSON.parse(await readFile(path.join(dir, `${key}.json`), 'utf8'));
    if (entry.key !== key || !Number.isFinite(entry.createdAt) || entry.createdAt > now || now - entry.createdAt >= ttlMs || !validSetup(entry.setup)) return null;
    return entry.setup;
  } catch { return null; }
}
export async function saveSetupCache(key, setup, { dir, now = Date.now() } = {}) {
  let temporary;
  try {
    if (!KEY.test(key) || typeof dir !== 'string' || !validSetup(setup)) return false;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const target = path.join(dir, `${key}.json`);
    temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ key, createdAt: now, setup }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
    return true;
  } catch { return false; }
  finally { if (temporary) await unlink(temporary).catch(() => {}); }
}
