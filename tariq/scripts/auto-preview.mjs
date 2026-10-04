/** Launch the isolated Auto profile from this source checkout, without provider credentials. */
import { mkdir, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const home = path.join(root, '.artifacts', 'auto-home');
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
  if (JSON.stringify(saved) !== JSON.stringify(manifest)) throw new Error(`Preview profile differs from the fixture manifest: ${manifestPath}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
}
const link = path.join(profile, 'node_modules', 'dsh-auto-subagents');
try { await lstat(link); } catch (error) { if (error.code !== 'ENOENT') throw error; await symlink(plugin, link, 'dir'); }
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
env.DSH_HOME = home;
env.DSH_AUTO_RECIPES_DIR = path.join(root, 'tariq', 'recipes');
env.DSH_TELEMETRY_MODE = 'DISABLED';
// Neither CLI dotenv layer may introduce credentials into this offline preview.
for (const file of [path.join(root, '.env'), path.join(home, '.env'), path.join(home, '.credentials.yaml')]) {
  try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error(`Offline preview refuses a credential source at ${file}`);
}
const args = process.argv.slice(2);
const child = spawn('pnpm', ['dsh', '--profile', 'auto-preview', ...(args.length ? args : ['--port', '3181', '--no-open'])], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
