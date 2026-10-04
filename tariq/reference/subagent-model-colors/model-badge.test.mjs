import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const bundlePath = '/Users/tariq/.local/share/deepseek-harness/runtime/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js';
const source = readFileSync(bundlePath, 'utf8');
let factory;
vm.runInNewContext(source.replace('return module.exports;', `module.exports.testHooks = { CatalogRows, subagentModelIdentity: typeof subagentModelIdentity === 'function' ? subagentModelIdentity : undefined, subagentModelTone: typeof subagentModelTone === 'function' ? subagentModelTone : undefined }; return module.exports;`), {
  window: { __ModuleLoader__: { load(value) { factory = value.factory; } } },
}, { filename: bundlePath });
const jsx = (type, props) => ({ type, props });
const hooks = factory((name) => name === 'react/jsx-runtime' ? { jsx, jsxs: jsx, Fragment: 'fragment' } : {}).testHooks;
const summary = (lastUsed, next = lastUsed) => ({ projectionValues: { modelSelection: { lastUsed, next } } });
const route = (model, provider = 'subscriptions') => ({ provider, model });

test('shows the used model, never an unconsumed pending selection', () => {
  const identity = hooks.subagentModelIdentity(summary(route('gpt-6.1-sol'), route('gemini-3.1-pro')));
  assert.equal(identity.model, 'gpt-6.1-sol');
  assert.equal(identity.provider, 'subscriptions');
});
test('does not invent a model for missing, malformed or never-used data', () => {
  for (const value of [undefined, {}, summary(null, route('gemini-3.1-pro')), summary({ model: '', provider: 'p' }), summary({ model: 12, provider: 'p' })]) {
    assert.equal(hooks.subagentModelIdentity(value), undefined);
  }
});
test('color is stable across order, provider, activity and reasoning effort', () => {
  const first = hooks.subagentModelTone('gpt-6.1-sol');
  hooks.subagentModelTone('unfamiliar-custom-model');
  assert.deepEqual(hooks.subagentModelTone('gpt-6.1-sol'), first);
  assert.match(first.light, /^#[0-9a-f]{6}$/i);
  assert.match(first.dark, /^#[0-9a-f]{6}$/i);
});
test('representative models receive distinguishable colors', () => {
  const colors = ['gpt-6.1-sol', 'gemini-3.1-pro', 'claude-opus-4.6', 'deepseek-v4-pro', 'grok-4.20'].map(model => hooks.subagentModelTone(model).light);
  assert.equal(new Set(colors).size, colors.length);
});
const luminance = (hex) => {
  const channels = hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
};
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
test('badge text meets 4.5:1 against its explicit backgrounds in both themes', () => {
  for (let n = 0; n < 100; n++) {
    const tone = hooks.subagentModelTone(`custom-${n}`);
    assert.ok(contrast(tone.light, '#ffffff') >= 4.5);
    assert.ok(contrast(tone.dark, '#202020') >= 4.5);
  }
});
function renderRow(model = 'gpt-6.1-sol') {
  return hooks.CatalogRows({ parentSessionId: 'parent', currentSessionId: 'other', catalog: { state: 'ready', entries: [{ kind: 'child', id: 'child', label: 'Payment check', mode: 'continuable', activity: 'running', hasChildren: false }] }, catalogs: {}, summaries: { child: summary(route(model)) }, expanded: new Set(), level: 1, now: 0, t: key => key });
}
function elements(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}
test('catalog row renders readable model name, provider tooltip and existing status indicator', () => {
  const nodes = elements(renderRow());
  const badge = nodes.find(n => n.props?.['data-subagent-model'] === 'gpt-6.1-sol');
  assert.ok(badge);
  assert.equal(badge.props.dir, 'ltr');
  assert.match(badge.props.title, /subscriptions/);
  assert.ok(JSON.stringify(badge).includes('gpt-6.1-sol'));
  const row = nodes.find(n => n.props?.role === 'treeitem');
  assert.match(row.props['aria-label'], /gpt-6.1-sol/);
  assert.ok(nodes.some(n => n.props?.state === 'ongoing'));
});
test('live projection updates change the displayed badge rather than caching it', () => {
  assert.ok(elements(renderRow('gemini-3.1-pro')).some(n => n.props?.['data-subagent-model'] === 'gemini-3.1-pro'));
});
test('missing model hides the badge without removing the navigable row', () => {
  const nodes = elements(renderRow(''));
  assert.ok(nodes.some(n => n.props?.role === 'treeitem' && n.props.tabIndex === 0));
  assert.ok(!nodes.some(n => n.props?.['data-subagent-model']));
});
