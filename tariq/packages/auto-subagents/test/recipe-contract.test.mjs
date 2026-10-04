import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as contract from '../lib/recipe-contract.mjs';
import { WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES } from '../lib/workflow-routing.mjs';

const validate = meta => contract.validateRecipeMeta(meta, { name: 'demo' });
for (const role of ['implementer', 'reviewer', 'validate']) {
  for (const tier of ['light', 'medium']) test(`canonical ${role} rejects ${tier} recipe overrides`, () => {
    const roles = { [role]: { tier } };
    assert.throws(() => validate({ name: 'demo', roles }), /tier/);
    assert.throws(() => contract.effectiveRoleTable(WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES, roles), /tier/);
  });
}
test('canonical designReview accepts overlays without relaxing custom role names', () => {
  for (const readOnlyRetry of [undefined, false, true]) {
    const descriptor = { tier: 'strong', ...(readOnlyRetry === undefined ? {} : { readOnlyRetry }) };
    const roles = validate({ name: 'demo', roles: { designReview: descriptor } }).roles;
    const table = contract.effectiveRoleTable(WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES, roles);
    assert.deepEqual(table.designReview, { tier: 'strong', readOnlyRetry: readOnlyRetry ?? true });
  }
  assert.throws(() => validate({ name: 'demo', roles: { customReview: { tier: 'strong' } } }), /role name/);
});
test('strong canonical overlays preserve retry restrictions and unchanged default role tables', () => {
  const defaults = contract.effectiveRoleTable(WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES);
  const roles = { implementer: { tier: 'strong' }, reviewer: { tier: 'strong' }, validate: { tier: 'strong', readOnlyRetry: false } };
  const table = contract.effectiveRoleTable(WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES, roles);
  assert.deepEqual(table.implementer, defaults.implementer);
  assert.deepEqual(table.reviewer, defaults.reviewer);
  assert.deepEqual(table.validate, { tier: 'strong', readOnlyRetry: false });
  for (const role of ['implementer', 'reviewer']) for (const readOnlyRetry of [false, true]) {
    assert.throws(() => validate({ name: 'demo', roles: { [role]: { tier: 'strong', readOnlyRetry } } }), /readOnlyRetry/);
  }
  for (const [role, tier] of Object.entries(WORKFLOW_ROLE_TIERS)) {
    assert.deepEqual(defaults[role], { tier, readOnlyRetry: READ_ONLY_RETRY_ROLES.has(role) });
  }
});
test('contract validates metadata without discarding approved extensions', () => {
  const meta = { name: 'demo', description: 'd', version: '1', args: {}, phases: [], whenToUse: '  Useful  ', roles: { scout: { tier: 'light' }, analysis: { tier: 'strong', readOnlyRetry: false }, reviewer: { tier: 'strong' } } };
  const result = validate(meta);
  assert.equal(result.whenToUse, 'Useful');
  assert.deepEqual(result.roles.scout, { tier: 'light' });
  assert.equal(meta.whenToUse, '  Useful  ');
  assert.equal(contract.LIMITS.maxWhenToUse, 500); assert.equal(contract.LIMITS.maxRoles, 32);
  assert.deepEqual(contract.TIERS, ['light', 'medium', 'strong']); assert.ok(Object.isFrozen(contract.TIERS));
  assert.ok(contract.ROLE_NAME_PATTERN.test('a' + 'b'.repeat(31))); assert.ok(!contract.ROLE_NAME_PATTERN.test('a' + 'b'.repeat(32)));
});
for (const [name, meta] of [
  ['null', null], ['array', []], ['primitive', 4], ['nonstring name', { name: 4 }],
  ['long role', { name: 'demo', roles: { ['a'.repeat(33)]: { tier: 'light' } } }],
  ['readOnly property', { name: 'demo', roles: { x: { tier: 'light', readOnly: true } } }],
  ['enforcedReadOnly property', { name: 'demo', roles: { x: { tier: 'light', enforcedReadOnly: true } } }], ['wrong name', { name: 'other' }], ['blank name', { name: '' }],
  ['undefined whenToUse', { name: 'demo', whenToUse: undefined }], ['blank whenToUse', { name: 'demo', whenToUse: '  ' }], ['numeric whenToUse', { name: 'demo', whenToUse: 1 }], ['long whenToUse', { name: 'demo', whenToUse: 'x'.repeat(501) }],
  ['undefined roles', { name: 'demo', roles: undefined }], ['array roles', { name: 'demo', roles: [] }], ['null roles', { name: 'demo', roles: null }], ['primitive roles', { name: 'demo', roles: 1 }], ['string roles', { name: 'demo', roles: 'scout' }],
  ['uppercase role', { name: 'demo', roles: { Scout: { tier: 'light' } } }], ['custom camel-case role', { name: 'demo', roles: { customReview: { tier: 'strong' } } }],
  ['reserved role', { name: 'demo', roles: JSON.parse('{"__proto__":{"tier":"light"}}') }], ['constructor', { name: 'demo', roles: { constructor: { tier: 'light' } } }], ['prototype', { name: 'demo', roles: { prototype: { tier: 'light' } } }],
  ['missing tier', { name: 'demo', roles: { scout: {} } }], ['invalid tier', { name: 'demo', roles: { scout: { tier: 'low' } } }], ['undefined retry', { name: 'demo', roles: { scout: { tier: 'light', readOnlyRetry: undefined } } }],
  ['nonboolean retry', { name: 'demo', roles: { scout: { tier: 'light', readOnlyRetry: 1 } } }], ['extra property', { name: 'demo', roles: { scout: { tier: 'light', tools: [] } } }], ['array descriptor', { name: 'demo', roles: { scout: [] } }],
  ['reviewer retry', { name: 'demo', roles: { reviewer: { tier: 'strong', readOnlyRetry: true } } }], ['implementer retry false', { name: 'demo', roles: { implementer: { tier: 'strong', readOnlyRetry: false } } }],
  ['too many roles', { name: 'demo', roles: Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['role-' + i, { tier: 'light' }])) }],
]) test('contract rejects ' + name, () => assert.throws(() => validate(meta)));
test('contract accepts exact caps and plain null-prototype objects, rejects inherited objects', () => {
  assert.doesNotThrow(() => validate({ name: 'demo', whenToUse: 'x'.repeat(500), roles: Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['role-' + i, { tier: 'medium' }])) }));
  assert.doesNotThrow(() => validate(Object.assign(Object.create(null), { name: 'demo' })));
  assert.throws(() => validate(Object.create({ name: 'demo' })));
  assert.throws(() => validate({ name: 'demo', roles: Object.create({ scout: { tier: 'light' } }) }));
  assert.throws(() => validate({ name: 'demo', roles: { scout: Object.create({ tier: 'light' }) } }));
});
test('effective roles are fresh frozen null-prototype tables preserving legacy defaults and strict retry semantics', () => {
  const roles = contract.normalizeRoles({ scout: { tier: 'light' }, analysis: { tier: 'strong', readOnlyRetry: false }, setup: { tier: 'medium' }, reviewer: { tier: 'strong' } });
  const table = contract.effectiveRoleTable(WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES, roles);
  assert.equal(Object.getPrototypeOf(table), null); assert.ok(Object.isFrozen(table));
  assert.deepEqual(table.scout, { tier: 'light', readOnlyRetry: false });
  assert.deepEqual(table.setup, { tier: 'medium', readOnlyRetry: true });
  assert.deepEqual(table.analysis, { tier: 'strong', readOnlyRetry: false });
  assert.deepEqual(table.reviewer, { tier: 'strong', readOnlyRetry: true });
  assert.deepEqual(table.implementer, { tier: 'strong', readOnlyRetry: false });
  assert.equal(table.designReview.tier, 'strong');
  assert.ok(Object.values(table).every(Object.isFrozen));
  assert.notEqual(table, contract.effectiveRoleTable(WORKFLOW_ROLE_TIERS, READ_ONLY_RETRY_ROLES, roles));
  assert.equal(WORKFLOW_ROLE_TIERS.setup, 'light');
});
