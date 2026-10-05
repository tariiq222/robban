import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';

// Resolve the official patch implementation through the declared Web bundle's boot dependency.
const webRequire = createRequire(runtimeModuleUrl('@deepseek-ai/dsh-web-app'));
const bootRequire = createRequire(webRequire.resolve('@deepseek-ai/dsh-app-boot'));
const { applyEntryPatches } = await import(pathToFileURL(bootRequire.resolve('@deepseek-ai/cordis-plugin-include')).href);
const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })]);
const parse = async url => yaml.load(await readFile(url, 'utf8'), { schema });
const base = await parse(new URL('../../../../packages/bundle/base/cordis.patch.yml', import.meta.url));
const web = await parse(new URL('../../../../packages/bundle/web-app/cordis.patch.yml', import.meta.url));
const auto = await parse(new URL('../cordis.patch.yml', import.meta.url));
const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])]);

test('official Web bundle composition activates one Auto LLM provider without changing original row configuration', () => {
  const warnings = [];
  const warn = message => warnings.push(message);
  const canonical = applyEntryPatches([], [...base, ...web], warn);
  const original = flatten(canonical).find(row => row.id === 'llm');
  assert.equal(original.name, '@deepseek-ai/dsh-llm');
  original.config = { fixture: { nested: ['preserve', 42] } };
  const expected = structuredClone(original);
  const composed = applyEntryPatches(canonical, auto, warn);
  const providerRows = flatten(composed).filter(row => row.id === 'llm');
  assert.equal(providerRows.length, 1);
  assert.deepEqual(providerRows[0], { ...expected, disabled: true });
  const active = flatten(composed).filter(row => !row.disabled && ['@deepseek-ai/dsh-llm', 'dsh-auto-subagents/llm-provider'].includes(row.name));
  assert.deepEqual(active, [{ id: 'auto-llm', name: 'dsh-auto-subagents/llm-provider' }]);
  assert.equal(warnings.length, 0);
  assert.equal(flatten(composed).find(row => row.id === 'subagent-model-selection-settings').disabled, true);
});

test('public replacement export mounts the real LLM service before adapter registration', async () => {
  const { default: Provider, AutoLlmRuntime } = await import('dsh-auto-subagents/llm-provider');
  const { Context } = await import(runtimeModuleUrl('@deepseek-ai/cordis'));
  const { LlmRuntime, LlmAdapter } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));
  const ctx = new Context();
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  }
  try {
    await ctx.plugin(Provider);
    assert.ok(ctx.llm instanceof AutoLlmRuntime);
    assert.ok(ctx.llm instanceof LlmRuntime);
    const dispose = ctx.llm.registerAdapter(['composition-fixture'], new FixtureAdapter());
    assert.equal((await ctx.llm.resolveCallConfig({ provider: 'composition-fixture', model: 'keyless' })).provider, 'composition-fixture');
    dispose();
  } finally { await ctx.fiber.dispose(); }
});

test('official Loader activates dependent adapters after the composed replacement provider', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'auto-llm-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { boot } = await import(pathToFileURL(webRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
  const { AutoLlmRuntime } = await import('dsh-auto-subagents/llm-provider');
  const adapter = path.join(root, 'adapter.mjs');
  await writeFile(adapter, `import { LlmAdapter } from ${JSON.stringify(runtimeModuleUrl('@deepseek-ai/dsh-llm'))};
export const inject = ['llm'];
class FixtureAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
}
export function apply(ctx) {
  if (ctx.llm.constructor.name !== 'AutoLlmRuntime') throw new Error('adapter received wrong LLM provider');
  ctx.effect(() => ctx.llm.registerAdapter(['loader-fixture'], new FixtureAdapter()));
  ctx.provide('compositionObserved', true);
}
`);
  const composed = flatten(applyEntryPatches([], [...base, ...web, ...auto], message => { throw new Error(message); }));
  const selected = composed.filter(row => row.id === 'llm' || row.id === 'auto-llm');
  // Deliberately list the adapter first: Cordis must wait for its real service dependency.
  const config = path.join(root, 'cordis.yml');
  await writeFile(config, yaml.dump([{ id: 'fixture-adapter', name: './adapter.mjs' }, ...selected]));
  const ctx = await boot('auto-llm-fixture', config, [], undefined, new URL('../package.json', import.meta.url).href);
  try {
    assert.ok(ctx.llm instanceof AutoLlmRuntime);
    assert.equal(ctx.compositionObserved, true);
    assert.equal((await ctx.llm.resolveCallConfig({ provider: 'loader-fixture', model: 'keyless' })).provider, 'loader-fixture');
  } finally { await ctx.fiber.dispose(); }
});
