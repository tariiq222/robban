/** Launch the isolated Auto profile from this source checkout, without provider credentials. */
import { mkdir, readFile, writeFile, symlink, lstat, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, JSON_SCHEMA } from 'js-yaml';
import { migrateLegacyModelSelection } from '../packages/auto-subagents/lib/settings-migration.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = [];
let instance;
const requestedArgs = process.argv.slice(2);
for (let index = 0; index < requestedArgs.length; index++) {
  const arg = requestedArgs[index];
  if (arg === '--instance' && instance === undefined && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(requestedArgs[index + 1] ?? '')) {
    instance = requestedArgs[++index];
    continue;
  }
  if (arg === '--no-open') { args.push(arg); continue; }
  if (arg === '--port' && /^\d+$/.test(requestedArgs[index + 1] ?? '') && Number(requestedArgs[index + 1]) >= 1 && Number(requestedArgs[index + 1]) <= 65535) {
    args.push(arg, requestedArgs[++index]);
    continue;
  }
  throw new Error('Offline preview accepts only --instance <safe-name>, --port <1-65535> and --no-open');
}
const home = path.join(root, '.artifacts', instance === undefined ? 'auto-home' : `auto-home-${instance}`);
const profile = path.join(home, 'profiles', 'auto-preview');
const plugin = path.join(root, 'tariq', 'packages', 'auto-subagents');
await mkdir(path.join(profile, 'node_modules'), { recursive: true });
const manifestPath = path.join(profile, 'package.json');
const manifest = {
  name: 'robban-auto-preview', private: true, type: 'module',
  dependencies: { 'dsh-auto-subagents': `link:${plugin}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-auto-subagents'] } },
};
try {
  const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isDeepStrictEqual(saved, manifest)) throw new Error(`Preview profile differs from the fixture manifest: ${manifestPath}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
}
const link = path.join(profile, 'node_modules', 'dsh-auto-subagents');
let linkStat;
try { linkStat = await lstat(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (linkStat) {
  if (!linkStat.isSymbolicLink() || await realpath(link) !== await realpath(plugin)) {
    throw new Error(`Preview plugin link does not point to the source checkout: ${link}`);
  }
} else {
  await symlink(plugin, link, 'dir');
}
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
env.DSH_HOME = home;
env.DSH_AUTO_RECIPES_DIR = path.join(root, 'tariq', 'recipes');
env.DSH_TELEMETRY_DISABLED = '1';
// Neither CLI dotenv layer may introduce credentials into this offline preview.
for (const file of [path.join(root, '.env'), path.join(home, '.env'), path.join(home, '.credentials.yaml'), path.join(home, 'cordis.patch.yml')]) {
  try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error(`Offline preview refuses a credential source at ${file}`);
}
// Saved tier preferences may persist; provider plugins and executable overlays may not.
const savedPatch = path.join(profile, 'cordis.patch.yml');
let savedPatchText;
try { savedPatchText = await readFile(savedPatch, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (savedPatchText !== undefined) {
  let rows;
  try { rows = load(savedPatchText, { schema: JSON_SCHEMA }); }
  catch (_error) { throw new Error('Offline preview settings must be valid YAML without executable tags'); }
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== 'auto-model-selection'
    || !isDeepStrictEqual(Object.keys(rows[0]).sort(), ['config', 'id'])) {
    throw new Error('Offline preview permits only the auto-model-selection settings patch');
  }
  const config = rows[0].config;
  if (config === null || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['enabled', 'allowedModels', 'modelTiers'].includes(key))) {
    throw new Error('Offline preview settings permit only enabled, allowedModels and modelTiers');
  }
  const validated = migrateLegacyModelSelection(config);
  if (!isDeepStrictEqual(validated.allowedModels, config.allowedModels)
    || (config.modelTiers !== undefined && !isDeepStrictEqual(validated.modelTiers, config.modelTiers))) {
    throw new Error('Offline preview model entries permit only provider, model and tier fields');
  }
}
const grouped = process.platform !== 'win32';
const child = spawn('pnpm', ['dsh', '--profile', 'auto-preview', ...(args.length ? args : ['--port', '3181', '--no-open'])], { cwd: root, env, stdio: 'inherit', detached: grouped });
const handlers = new Map();
let interrupted;
let launchFailed = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  const handler = () => {
    interrupted = signal;
    if (!child.pid) return;
    try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}
child.on('error', error => { launchFailed = true; console.error(error.message); process.exitCode = 1; });
child.on('close', (code, signal) => {
  for (const [name, handler] of handlers) process.off(name, handler);
  process.exitCode = launchFailed ? 1 : interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : code ?? (signal ? 1 : 0);
});
