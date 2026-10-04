import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCatalogForCoordinator } from '../lib/recipe-catalog.mjs';

const entries = ['investigate', 'qa-verify', 'plan-to-packages', 'code-audit', 'refactor', 'bug-fix', 'feature-pipeline'].map(name => ({ name, description: name, whenToUse: `Use ${name} for its stated intent` }));

test('Auto chooses approved recipes by intent, including non-writing workflows', () => {
  const prompt = renderCatalogForCoordinator(entries);
  assert.match(prompt, /Match the request intent to an approved recipe/i);
  assert.match(prompt, /investigation, acceptance verification, package planning, source audit/i);
  assert.doesNotMatch(prompt, /Keep ordinary subagents for research, questions, audits/);
  assert.doesNotMatch(prompt, /anything that is not a code change|Research, audits and pure reading still use ordinary subagents/);
  assert.match(prompt, /read-only request must stay read-only/i);
  assert.match(prompt, /never substitute a writing recipe/i);
});

test('Broad requests can use a planning recipe without authorizing implementation', () => {
  const prompt = renderCatalogForCoordinator(entries);
  assert.match(prompt, /use an approved package-planning recipe/i);
  assert.match(prompt, /planning alone never authorizes implementation/i);
  assert.match(prompt, /dependency order/);
  assert.match(prompt, /non-overlapping file scopes/);
});

test('Intent guidance only selects available names and preserves human decision controls', () => {
  const prompt = renderCatalogForCoordinator([{ name: 'custom-reader', description: 'Read only', whenToUse: 'Investigation' }]);
  assert.match(prompt, /Only select names from the current approved catalog/i);
  assert.match(prompt, /ordinary subagents/);
  assert.match(prompt, /session workspace/i);
  assert.match(prompt, /__keep__/);
  assert.match(prompt, /verified ask_user_question/);
  assert.match(prompt, /do not claim success/i);
});
