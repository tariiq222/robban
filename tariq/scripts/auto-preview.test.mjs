/** Provider-free subprocess checks for the isolated preview launcher. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-preview-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'tariq/scripts/auto-preview.mjs');
  const plugin = path.join(root, 'tariq/packages/auto-subagents');
  const home = path.join(root, '.artifacts/auto-home');
  const profile = path.join(home, 'profiles/auto-preview');
  const bin = path.join(root, 'bin');
  await Promise.all([mkdir(path.dirname(script), { recursive: true }), mkdir(plugin, { recursive: true }), mkdir(bin)]);
  await copyFile(new URL('./auto-preview.mjs', import.meta.url), script);
  await mkdir(path.join(plugin, 'lib'));
  await Promise.all(['settings-migration.mjs', 'router.mjs'].map(file => copyFile(new URL('../packages/auto-subagents/lib/' + file, import.meta.url), path.join(plugin, 'lib', file))));
  await symlink(new URL('../../node_modules', import.meta.url).pathname, path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(bin, 'pnpm'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.DSH_HOME + '/capture.json', JSON.stringify({ env: process.env, args: process.argv.slice(2) }));\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, DEEPSEEK_API_KEY: 'must-not-reach-child', NODE_OPTIONS: '--trace-warnings', DSH_HOME: '/personal-home' };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  return { root, script, plugin, home, profile, bin, env, run };
}

test('launch scrubs credentials and pins offline home, bundles and telemetry', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const capture = JSON.parse(await readFile(path.join(f.home, 'capture.json'), 'utf8'));
  assert.equal(capture.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(capture.env.NODE_OPTIONS, undefined);
  assert.equal(capture.env.DSH_HOME, f.home);
  assert.equal(capture.env.DSH_TELEMETRY_DISABLED, '1');
  assert.deepEqual(capture.args, ['dsh', '--profile', 'auto-preview', '--port', '3181', '--no-open']);
  const manifestPath = path.join(f.profile, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify(Object.fromEntries(Object.entries(manifest).reverse())));
  assert.equal(f.run('--port', '3191', '--no-open').status, 0);
});

for (const kind of ['directory', 'wrong-link', 'dangling-link']) {
  test(`rejects an existing ${kind} at the plugin path`, async t => {
    const f = await fixture(t);
    const link = path.join(f.profile, 'node_modules/dsh-auto-subagents');
    await mkdir(path.dirname(link), { recursive: true });
    if (kind === 'directory') await mkdir(link);
    else await symlink(kind === 'wrong-link' ? f.bin : path.join(f.root, 'missing'), link, 'dir');
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Preview plugin link|ENOENT/);
  });
}

test('refuses changed profile bundles instead of overwriting the manifest', async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const manifestPath = path.join(f.profile, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dsh.profile.bundles.push('unexpected-provider');
  const saved = JSON.stringify(manifest);
  await writeFile(manifestPath, saved);
  assert.match(f.run().stderr, /Preview profile differs/);
  assert.equal(await readFile(manifestPath, 'utf8'), saved);
});

test('reports launch failure when pnpm is unavailable', async t => {
  const f = await fixture(t);
  await unlink(path.join(f.bin, 'pnpm'));
  const result = spawnSync(process.execPath, [f.script], { env: { ...f.env, PATH: f.bin }, encoding: 'utf8' });
  assert.equal(result.status, 1);
});

for (const file of ['.env', '.artifacts/auto-home/.env', '.artifacts/auto-home/.credentials.yaml', '.artifacts/auto-home/cordis.patch.yml']) {
  test(`refuses ambient configuration at ${file}`, async t => {
    const f = await fixture(t);
    const target = path.join(f.root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'fixture');
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Offline preview refuses/);
  });
}

test('preserves saved Auto tier preferences across repeated preview launches', async t => {
  const f = await fixture(t);
  await mkdir(f.profile, { recursive: true });
  const patch = '- id: auto-model-selection\n  config:\n    enabled: true\n    allowedModels:\n      - provider: fixture\n        model: example\n    modelTiers:\n      - provider: fixture\n        model: example\n        tier: strong\n';
  const file = path.join(f.profile, 'cordis.patch.yml');
  await writeFile(file, patch);
  assert.equal(f.run().status, 0);
  assert.equal(f.run().status, 0);
  assert.equal(await readFile(file, 'utf8'), patch);
});

for (const patch of [
  [{ id: 'provider', config: { apiKey: 'fixture' } }],
  [{ id: 'auto-model-selection', name: 'provider', config: { enabled: true, allowedModels: [] } }],
  [{ id: 'auto-model-selection', disabled: false, config: { enabled: true, allowedModels: [] } }],
  [{ id: 'auto-model-selection', insert: {}, config: { enabled: true, allowedModels: [] } }],
  [{ id: 'auto-model-selection', config: { enabled: true, allowedModels: [], apiKey: 'fixture' } }],
  [{ id: 'auto-model-selection', config: { enabled: true, allowedModels: [{ provider: 'fixture', model: 'example', token: 'fixture' }] } }],
  [{ id: 'auto-model-selection', config: { enabled: true, allowedModels: [], modelTiers: [{ provider: 'fixture', model: 'example', tier: 'invalid' }] } }],
  [{ id: 'auto-model-selection', config: { enabled: true, allowedModels: [] } }, { id: 'provider' }],
  '- id: auto-model-selection\n  config: !!js/function >\n    function () { return {}; }\n',
]) {
  test(`rejects unsafe or invalid saved settings ${JSON.stringify(patch)}`, async t => {
    const f = await fixture(t);
    await mkdir(f.profile, { recursive: true });
    await writeFile(path.join(f.profile, 'cordis.patch.yml'), typeof patch === 'string' ? patch : JSON.stringify(patch));
    assert.equal(f.run().status, 1);
  });
}

test('a named isolated instance leaves existing credential files untouched', async t => {
  const f = await fixture(t);
  await mkdir(f.home, { recursive: true });
  const credential = path.join(f.home, '.credentials.yaml');
  await writeFile(credential, 'synthetic credential fixture');
  const result = f.run('--instance', 'fresh-check', '--port', '3192', '--no-open');
  assert.equal(result.status, 0, result.stderr);
  const freshHome = path.join(f.root, '.artifacts/auto-home-fresh-check');
  const capture = JSON.parse(await readFile(path.join(freshHome, 'capture.json'), 'utf8'));
  assert.equal(capture.env.DSH_HOME, freshHome);
  assert.deepEqual(capture.args, ['dsh', '--profile', 'auto-preview', '--port', '3192', '--no-open']);
  assert.equal(await readFile(credential, 'utf8'), 'synthetic credential fixture');
  await writeFile(path.join(freshHome, '.credentials.yaml'), '');
  assert.equal(f.run('--instance', 'fresh-check').status, 1);
});

for (const args of [['--patch', 'external.yml'], ['--profile', 'personal'], ['task'], ['--port', '0'], ['--port', '65536'], ['--instance', '../escape'], ['--instance', '/tmp/external'], ['--instance', ''], ['--instance', 'one', '--instance', 'two']]) {
  test(`rejects unsupported launch arguments ${args.join(' ')}`, async t => {
    const f = await fixture(t);
    assert.match(f.run(...args).stderr, /Offline preview accepts only/);
  });
}

test('forwards termination to pnpm descendants and reports interrupted exit', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.bin, 'pnpm'), `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.env.DSH_HOME + '/terminated', 'yes'); process.exit(0); }); require('node:fs').writeFileSync(process.env.DSH_HOME + '/ready', 'yes'); setInterval(() => {}, 1000);"], { stdio: 'inherit' });\nprocess.on('SIGTERM', () => {});\nchild.on('exit', () => process.exit(0));\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [f.script], { env: f.env, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const closed = once(child, 'close');
  for (let attempt = 0; ; attempt++) {
    try { await readFile(path.join(f.home, 'ready')); break; }
    catch (error) { if (error.code !== 'ENOENT' || attempt > 200) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.equal(code, 143);
  assert.equal(await readFile(path.join(f.home, 'terminated'), 'utf8'), 'yes');
});
