import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }),
]);

test('built preset preserves the canonical plugins and multiline model instructions', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'auto-preset-build-'));
  try {
    const fixture = path.join(temporary, 'packages', 'auto-subagents');
    const presetDirectory = path.join(temporary, 'presets', 'auto-subagents');
    await Promise.all([
      mkdir(path.join(fixture, 'lib'), { recursive: true }),
      mkdir(path.join(fixture, 'src'), { recursive: true }),
      mkdir(presetDirectory, { recursive: true }),
    ]);
    const inputs = ['build.mjs', 'package.json', 'lib/card-model.mjs', 'lib/decision-model.mjs', 'src/card.css', 'src/client.src.js', 'src/settings.src.js'];
    await Promise.all(inputs.map(relative => copyFile(path.join(packageRoot, relative), path.join(fixture, relative))));
    const canonical = await readFile(path.resolve(packageRoot, '../../presets/auto-subagents/agent.cordis.yml'), 'utf8');
    await copyFile(path.resolve(packageRoot, '../../presets/auto-subagents/agent.cordis.yml'), path.join(presetDirectory, 'agent.cordis.yml'));
    await import(pathToFileURL(path.join(fixture, 'build.mjs')).href);
    const built = yaml.load(await readFile(path.join(fixture, 'preset.patch.yml'), 'utf8'), { schema });
    const plugins = yaml.load(canonical, { schema });
    assert.deepEqual(built[0].insert[0].config.plugins, plugins);
    assert.match(plugins.find(plugin => plugin.id === 'persona').config.prefix, /\n\n/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
