/** Run Auto probes against archived upstream source, without modifying the working checkout. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, symlink, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const checkout = fileURLToPath(new URL('../../../../../', import.meta.url));
const plugin = fileURLToPath(new URL('../../', import.meta.url));
export const PRISTINE_UPSTREAM_REFERENCE = 'upstream/master';

async function linkExternalDependencies(destination, installed) {
  let entries;
  try { entries = await readdir(installed, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (entry.name === '@deepseek-ai' || entry.name === 'dsh-auto-subagents' || entry.name === '.bin') continue;
    await symlink(path.join(installed, entry.name), path.join(destination, entry.name), 'dir');
  }
}

async function linkWorkspaces(root, nodeModules) {
  const candidates = [];
  for (const top of ['vendor','apps']) {
    for (const entry of await readdir(path.join(root, top), { withFileTypes: true })) if (entry.isDirectory()) candidates.push(path.join(root, top, entry.name));
  }
  for (const group of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const entry of await readdir(path.join(root, 'packages', group.name), { withFileTypes: true })) if (entry.isDirectory()) candidates.push(path.join(root, 'packages', group.name, entry.name));
  }
  for (const directory of candidates) {
    let manifest;
    try { manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!manifest.name) continue;
    const destination = path.join(nodeModules, manifest.name);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(directory, destination, 'dir');
    await linkExternalDependencies(path.join(directory, 'node_modules'), path.join(checkout, path.relative(root, directory), 'node_modules'));
  }
}

/**
 * Capture the maintained upstream reference, archive that immutable commit and run a keyless Auto probe.
 * External npm dependencies may use the installed cache; workspace package links and tsconfig paths
 * point exclusively into the archive. The child's own probe must assert source identity before tests.
 * @param {{probe:URL,timeoutMs?:number}} options Probe module and bounded process timeout.
 * @returns {Promise<{stdout:string,stderr:string,reference:string,revision:string}>} Successful probe output and captured upstream revision.
 */
export async function runPristineUpstream({ probe, timeoutMs = 120000 }) {
  const revision = (await execute('git', ['rev-parse', '--verify', '--end-of-options', `${PRISTINE_UPSTREAM_REFERENCE}^{commit}`], { cwd: checkout })).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('Upstream reference did not resolve to an immutable commit');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'auto-pristine-upstream-'));
  try {
    const root = path.join(temp, 'upstream'), nodeModules = path.join(root, 'node_modules');
    await mkdir(root);
    const archive = path.join(temp, 'upstream.tar');
    await execute('git', ['archive', '--output', archive, revision], { cwd: checkout });
    await execute('tar', ['-xf', archive, '-C', root]);
    await mkdir(nodeModules);
    // Scoped DSH workspace packages receive archive-owned links below; no root workspace link survives.
    await linkExternalDependencies(nodeModules, path.join(checkout, 'node_modules'));
    await linkWorkspaces(root, nodeModules);
    const copy = path.join(root, 'tariq/packages/auto-subagents');
    await mkdir(copy, { recursive: true });
    for (const entry of ['lib', 'skills', 'package.json', 'cordis.patch.yml', 'preset.patch.yml']) {
      await cp(path.join(plugin, entry), path.join(copy, entry), { recursive: true });
    }
    await symlink(copy, path.join(nodeModules, 'dsh-auto-subagents'), 'dir');
    await cp(fileURLToPath(probe), path.join(root, 'pristine-probe.mjs'));
    const sourceFiles = ['packages/core/session/src/index.ts', 'packages/core/agent-loop/src/agent.ts', 'packages/core/agent/src/index.ts', 'packages/llm/llm/src/index.ts', 'vendor/cordis/src/index.ts'];
    const sourceHashes = {};
    for (const file of sourceFiles) sourceHashes[file] = (await execute('git', ['rev-parse', `${revision}:${file}`], { cwd: checkout })).stdout.trim();
    await writeFile(path.join(root, 'upstream-proof.json'), JSON.stringify({ reference: PRISTINE_UPSTREAM_REFERENCE, revision, sourceHashes }));
    const home = path.join(temp, 'home');
    await mkdir(home);
    const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: path.join(temp, 'data'), TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json'), DSH_TELEMETRY_DISABLED: '1' };
    const result = await execute(process.execPath, ['--import', import.meta.resolve('tsx/esm'), path.join(root, 'pristine-probe.mjs')], { cwd: root, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { ...result, reference: PRISTINE_UPSTREAM_REFERENCE, revision };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
