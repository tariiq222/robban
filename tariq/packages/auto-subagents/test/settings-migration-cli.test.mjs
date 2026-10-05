import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, stat, rm, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { settingsOverlay, main } from '../scripts/migrate-settings.mjs';

const cli = fileURLToPath(new URL('../scripts/migrate-settings.mjs', import.meta.url));
const run = promisify(execFile);
const source = `providers:\n  unrelated-secret: do-not-export\nsubagent-model-selection:\n  enabled: true\n  allowedModels:\n    - provider: provider-a\n      model: model-a\n    - provider: provider-b\n      model: model-b\n  modelTiers:\n    - provider: provider-a\n      model: model-a\n      tier: strong\n    - provider: unavailable\n      model: saved-model\n      tier: light\n`;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'auto-settings-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'copied-settings.yaml');
  const output = path.join(dir, 'auto.patch.yml');
  await writeFile(input, source);
  return { dir, input, output };
}

test('migration CLI creates a private unapplied overlay, preserves source and excludes other sections', async t => {
  const { input, output } = await fixture(t);
  await run(process.execPath, [cli, input, output]);
  const text = await readFile(output, 'utf8');
  assert.deepEqual(load(text), settingsOverlay(source));
  assert.equal(load(text)[0].id, 'auto-model-selection');
  assert.deepEqual(load(text)[0].config.allowedModels.map(route => route.provider), ['provider-a', 'provider-b']);
  assert.equal(load(text)[0].config.modelTiers[1].tier, 'light');
  assert.ok(!text.includes('do-not-export'));
  assert.equal(await readFile(input, 'utf8'), source);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test('migration refuses existing output, source as output and a symlink output', async t => {
  const { input, output, dir } = await fixture(t);
  await writeFile(output, 'keep me');
  await assert.rejects(main([input, output]), { code: 'EEXIST' });
  await assert.rejects(main([input, input]), { code: 'EEXIST' });
  const link = path.join(dir, 'link.yml');
  await symlink(output, link);
  await assert.rejects(main([input, link]), { code: 'EEXIST' });
  assert.equal(await readFile(output, 'utf8'), 'keep me');
  assert.equal(await readFile(input, 'utf8'), source);
});

test('migration rejects invalid authorization and executable YAML before creating output', async t => {
  const { input, output } = await fixture(t);
  for (const text of ['[]', 'other: true', 'subagent-model-selection: {enabled: "false", allowedModels: []}', 'subagent-model-selection: {enabled: true, allowedModels: [{provider: a, model: m}, {provider: a, model: m}]}', 'subagent-model-selection: !!js process.env.PRIVATE_KEY']) {
    await writeFile(input, text);
    await assert.rejects(main([input, output]));
    await assert.rejects(access(output), { code: 'ENOENT' });
    assert.equal(await readFile(input, 'utf8'), text);
  }
});

test('migration keeps disabled or enabled empty authorization and treats ids as literal strings', () => {
  for (const enabled of [false, true]) {
    assert.deepEqual(settingsOverlay(JSON.stringify({ 'subagent-model-selection': { enabled, allowedModels: [] } }))[0].config,
      { enabled, allowedModels: [], modelTiers: [] });
  }
  const fields = { enabled: false, allowedModels: [{ provider: '!!js process.env.KEY', model: 'quoted: model' }] };
  assert.deepEqual(settingsOverlay(JSON.stringify({ 'subagent-model-selection': fields }))[0].config.allowedModels, fields.allowedModels);
});

test('migration CLI reports invalid YAML without echoing unrelated credential values', async t => {
  const { input, output } = await fixture(t);
  await writeFile(input, 'provider: !!js DO_NOT_PRINT_THIS_SECRET');
  await assert.rejects(run(process.execPath, [cli, input, output]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /valid YAML/);
    assert.ok(!error.stderr.includes('DO_NOT_PRINT_THIS_SECRET'));
    return true;
  });
  await assert.rejects(access(output), { code: 'ENOENT' });
});
