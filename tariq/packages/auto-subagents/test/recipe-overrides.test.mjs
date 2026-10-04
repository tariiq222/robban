import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecipeOverrides } from '../lib/recipe-overrides.mjs';

const meta = {
  name: 'feature-pipeline',
  args: { fastPath: 'boolean, default true; x', useAggregator: 'boolean, default false', stepTimeoutMs: 'positive integer' },
};

test('no saved override keeps recipe defaults', () => {
  assert.deepEqual(resolveRecipeOverrides({}, 'feature-pipeline', meta, {}), { disabled: false, roles: {}, timeouts: {}, args: {} });
});

test('disabled recipe is reported', () => {
  assert.equal(resolveRecipeOverrides({ 'feature-pipeline': { disabled: true } }, 'feature-pipeline', meta, {}).disabled, true);
});

test('tier and timeout overrides merge onto the recipe roles', () => {
  const saved = { 'feature-pipeline': { roles: { setup: { tier: 'medium', timeoutMinutes: 2 }, analysis: { timeoutMinutes: 9 } } } };
  const result = resolveRecipeOverrides(saved, 'feature-pipeline', meta, { planner: { tier: 'strong', readOnlyRetry: true } });
  assert.deepEqual(result.roles, { planner: { tier: 'strong', readOnlyRetry: true }, setup: { tier: 'medium' } });
  assert.deepEqual(result.timeouts, { setup: 120000, analysis: 540000 });
});

test('strong-only roles refuse a weaker tier', () => {
  assert.throws(() => resolveRecipeOverrides({ 'feature-pipeline': { roles: { implementer: { tier: 'light' } } } }, 'feature-pipeline', meta, {}), /implementer.*strong/);
});

test('unknown roles are refused instead of silently ignored', () => {
  assert.throws(() => resolveRecipeOverrides({ 'feature-pipeline': { roles: { ghost: { tier: 'light' } } } }, 'feature-pipeline', meta, {}), /unknown role "ghost"/);
});

test('only declared boolean options pass through as recipe args', () => {
  const result = resolveRecipeOverrides({ 'feature-pipeline': { args: { fastPath: false, useAggregator: true } } }, 'feature-pipeline', meta, {});
  assert.deepEqual(result.args, { fastPath: false, useAggregator: true });
  assert.throws(() => resolveRecipeOverrides({ 'feature-pipeline': { args: { stepTimeoutMs: true } } }, 'feature-pipeline', meta, {}), /option "stepTimeoutMs"/);
  assert.throws(() => resolveRecipeOverrides({ 'feature-pipeline': { args: { repo: true } } }, 'feature-pipeline', meta, {}), /option "repo"/);
});

test('timeouts outside one minute to four hours are refused', () => {
  assert.throws(() => resolveRecipeOverrides({ 'feature-pipeline': { roles: { setup: { timeoutMinutes: 0 } } } }, 'feature-pipeline', meta, {}), /timeout/);
  assert.throws(() => resolveRecipeOverrides({ 'feature-pipeline': { roles: { setup: { timeoutMinutes: 241 } } } }, 'feature-pipeline', meta, {}), /timeout/);
});
