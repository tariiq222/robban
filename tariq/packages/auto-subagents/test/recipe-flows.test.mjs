import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPE_FLOWS, recipeSettingsCatalog } from '../lib/recipe-flows.mjs';
import { effectiveRoleTable } from '../lib/recipe-contract.mjs';
import { WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES } from '../lib/workflow-routing.mjs';

const recipesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../recipes');
const names = fs.readdirSync(recipesDir).filter(name => !name.startsWith('.') && !name.startsWith('_') && fs.existsSync(path.join(recipesDir, name, 'meta.json')));
const metaOf = name => JSON.parse(fs.readFileSync(path.join(recipesDir, name, 'meta.json'), 'utf8'));

test('every shipped recipe has a flow and every flow names a shipped recipe', () => {
  assert.deepEqual(Object.keys(RECIPE_FLOWS).sort(), [...names].sort());
});

for (const name of names) {
  test(`${name}: flow stages are declared phases and flow roles are authorized and used by the script`, () => {
    const meta = metaOf(name);
    const script = fs.readFileSync(path.join(recipesDir, name, 'script.js'), 'utf8');
    const table = effectiveRoleTable(WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES, meta.roles || {});
    const phases = (meta.phases || []).map(p => p.title);
    for (const stage of RECIPE_FLOWS[name]) {
      assert.ok(phases.includes(stage.id), `${name}: stage ${stage.id} is not a meta phase`);
      for (const role of stage.roles) {
        assert.ok(Object.hasOwn(table, role), `${name}: role ${role} is not authorized`);
        assert.match(script, new RegExp(`['"\`]${role}['"\`]`), `${name}: role ${role} never appears in script.js`);
      }
    }
  });
}

test('settings catalog exposes effective tiers, strong locks, defaults and boolean options', () => {
  const catalog = recipeSettingsCatalog(Object.fromEntries(names.map(name => [name, metaOf(name)])));
  const feature = catalog.find(r => r.name === 'feature-pipeline');
  assert.deepEqual(feature.options.map(o => o.key), ['fastPath', 'earlyValidate', 'useAggregator']);
  assert.equal(feature.options.find(o => o.key === 'useAggregator').default, false);
  assert.equal(feature.options.find(o => o.key === 'fastPath').default, true);
  const implementer = feature.roles.find(r => r.role === 'implementer');
  assert.deepEqual({ tier: implementer.tier, locked: implementer.locked }, { tier: 'strong', locked: true });
  const setup = feature.roles.find(r => r.role === 'setup');
  assert.deepEqual({ tier: setup.tier, locked: setup.locked }, { tier: 'light', locked: false });
  const audit = catalog.find(r => r.name === 'code-audit');
  assert.deepEqual(audit.options, []);
  assert.deepEqual(audit.stages.map(s => s.id), ['scope', 'scans', 'verify']);
  assert.ok(catalog.every(r => r.roles.every(role => r.stages.some(s => s.roles.includes(role.role)))));
});
