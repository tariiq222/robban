import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = new URL('../../packages/auto-subagents/package.json', import.meta.url);
const coordinatorUrl = new URL('../../packages/auto-subagents/lib/coordinator.mjs', import.meta.url).href;
const require = createRequire(pluginRoot);
const yaml = require('js-yaml');
const jsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value });
const schema = yaml.DEFAULT_SCHEMA.extend([jsTag]);
const load = (file) => yaml.load(readFileSync(file, 'utf8'), { schema });
const standard = load(require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml'))[0].insert[0].config.plugins;
const auto = load(path.join(here, 'agent.cordis.yml'));
const flatten = (rows) => rows.flatMap((row) => row.group ? [row, ...flatten(row.config)] : [row]);

test('automatic preset retains Standard capabilities except its intentional routing extension', () => {
  const normalized = structuredClone(auto).filter(row => !['auto-subagent-routing', 'auto-subagents-coordinator', 'auto-task-memory'].includes(row.id));
  // run_recipe is an intentional Auto-only extension inside the delegation group.
  for (const row of normalized) if (row.group) row.config = row.config.filter(child => child.id !== 'auto-subagents-recipes');
  for (const row of flatten(normalized)) {
    if (row.id === 'tool-subagent' || row.id === 'tool-subagent-fork') {
      row.name = '@deepseek-ai/dsh-tool-subagent';
      delete row.config.registerModelDiscovery;
      if (row.id === 'tool-subagent') row.config.modelSelectionSettings = true;
    }
  }
  assert.deepEqual(normalized.slice(1), standard.slice(1));
  assert.equal(auto[0].id, 'persona');
  assert.equal(auto[0].name, standard[0].name);
});

test('persona carries shared routing and dependency facts only; role rules live once in the plugin', async () => {
  const prompt = auto[0].config.prefix;
  assert.match(prompt, /parallel/i);
  assert.match(prompt, /depends on/i);
  assert.match(prompt, /settings/i);
  assert.match(prompt, /provider\/model/i);
  assert.match(prompt, /disabled or empty/i);
  assert.doesNotMatch(prompt, /gpt-|claude-|gemini|qwen|deepseek-v/i);
  // no duplication: coordinator/report rules are defined in coordinator.mjs, not repeated here
  const { COORDINATOR_ROLE, SUBAGENT_REPORT_CONTRACT } = await import(coordinatorUrl);
  for (const rule of [COORDINATOR_ROLE, SUBAGENT_REPORT_CONTRACT]) {
    const firstRuleLine = rule.split('\n').find(line => /^\d\.|^Status:/.test(line));
    assert.ok(!prompt.includes(firstRuleLine), 'role rule duplicated in persona');
  }
  const rows = flatten(auto);
  assert.equal(rows.find((row) => row.id === 'tool-subagent')?.name, 'dsh-auto-subagents/delegation');
  assert.ok(rows.some((row) => row.id === 'auto-subagent-routing'));
  assert.ok(rows.some((row) => row.id === 'auto-subagents-coordinator'));
});

test('preset is discoverable with descriptive metadata', () => {
  const metadata = load(path.join(here, 'preset.yml'));
  assert.match(metadata.name, /Auto/i);
  assert.match(metadata.description, /subagent/i);
});

test('recipes plugin is mounted inside the workflowEngine realm and the coordinator may call only run_recipe', async () => {
  const delegation = auto.find((row) => row.id === 'delegation');
  assert.equal(delegation.isolate.workflowEngine, true);
  assert.ok(delegation.config.some((row) => row.id === 'auto-subagents-recipes'));
  const { COORDINATOR_ALLOWED_TOOLS } = await import(coordinatorUrl);
  assert.ok(COORDINATOR_ALLOWED_TOOLS.includes('run_recipe'));
  assert.ok(COORDINATOR_ALLOWED_TOOLS.includes('task_memory'));
  assert.equal(auto.find(row => row.id === 'auto-task-memory')?.name, 'dsh-auto-subagents/task-memory');
  assert.ok(!COORDINATOR_ALLOWED_TOOLS.includes('workflow'), 'coordinator must not author arbitrary workflow scripts');
});
