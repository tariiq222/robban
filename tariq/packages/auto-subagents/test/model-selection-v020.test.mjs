import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateLegacyModelSelection } from '../lib/settings-migration.mjs';

const route = { provider: 'provider', model: 'model' };
test('migration preserves priority, tiers outside the allowlist, and source ownership', () => {
  const old = { enabled: true, allowedModels: [route, { provider: 'other', model: 'next' }], modelTiers: [{ ...route, tier: 'strong' }, { provider: 'unused', model: 'saved', tier: 'light' }] };
  const next = migrateLegacyModelSelection(old);
  assert.deepEqual(next, old);
  next.allowedModels.reverse(); next.modelTiers[0].tier = 'light';
  assert.equal(old.allowedModels[0], route);
  assert.equal(old.modelTiers[0].tier, 'strong');
});
test('migration preserves disabled and empty preferences without enabling routes', () => {
  assert.deepEqual(migrateLegacyModelSelection({ enabled: false, allowedModels: [] }), { enabled: false, allowedModels: [], modelTiers: [] });
  assert.deepEqual(migrateLegacyModelSelection({ enabled: false, allowedModels: [route] }), { enabled: false, allowedModels: [route], modelTiers: [] });
  assert.deepEqual(migrateLegacyModelSelection({ enabled: true, allowedModels: [] }), { enabled: true, allowedModels: [], modelTiers: [] });
});
test('migration rejects invalid settings rather than silently broadening authorization', () => {
  for (const value of [null, [], {}, { enabled: 'false', allowedModels: [] }, { enabled: false, allowedModels: null }, { enabled: false, allowedModels: [route, route] }, { enabled: false, allowedModels: [{ provider: '', model: 'm' }] }, { enabled: false, allowedModels: [route], modelTiers: [{ ...route, tier: 'ultra' }] }, { enabled: false, allowedModels: [route], modelTiers: [{ ...route, tier: 'light' }, { ...route, tier: 'strong' }] }, { enabled: false, allowedModels: [], modelTiers: null }]) {
    assert.throws(() => migrateLegacyModelSelection(value));
  }
});
