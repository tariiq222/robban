import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageInstructions } from '../lib/stage-skills.mjs';

const mapping = [
  ['feature-pipeline', 'analysis', 'analysis', ['behavior-evidence']],
  ['feature-pipeline', 'designReview', 'design-review #1', ['design-dependencies', 'independent-review']],
  ['bug-fix', 'reviewer', 'review-1 #2', ['behavior-evidence', 'independent-review']],
  ['refactor', 'baseline', 'baseline', ['behavior-evidence']],
  ['investigate', 'investigation-scope', 'scope', []],
  ['investigate', 'investigator', 'gather', ['behavior-evidence']],
  ['investigate', 'investigation-checker', 'check', ['behavior-evidence', 'independent-review']],
  ['code-audit', 'audit-scope', 'scope', []],
  ['code-audit', 'audit-scanner', 'scan-security', ['independent-review']],
  ['code-audit', 'audit-scanner', 'scan-correctness', ['independent-review']],
  ['code-audit', 'audit-checker', 'verify', ['behavior-evidence', 'independent-review']],
  ['qa-verify', 'qa-verifier', 'analysis', ['behavior-evidence']],
  ['qa-verify', 'qa-verifier', 'verify', ['behavior-evidence']],
  ['qa-verify', 'qa-checker', 'check', ['behavior-evidence', 'independent-review']],
  ['plan-to-packages', 'plan-evidence', 'evidence', ['behavior-evidence']],
  ['plan-to-packages', 'planner', 'packages', ['design-dependencies']],
  ['plan-to-packages', 'package-checker', 'check', ['design-dependencies', 'independent-review']],
];
for (const [recipe, role, label, names] of mapping) test(`bounded methods for ${recipe}/${label}`, () => {
  const result = stageInstructions({ recipe, role, label });
  assert.deepEqual(result.skills.map(skill => skill.name), names);
  assert.ok(result.text.length <= 5200);
  assert.ok(result.skills.every(skill => /^[a-f0-9]{64}$/.test(skill.sha256)));
  for (const skill of result.skills) assert.equal(result.text.split(`Trusted bundled method: ${skill.name}`).length, 2);
  assert.deepEqual(stageInstructions({ recipe, role, label }), result);
});

test('unknown identities, disabled stages and unselected preparation receive no instructions', () => {
  for (const input of [
    { recipe: '../custom', role: 'reviewer', label: 'review #1' },
    { recipe: 'toString', role: 'reviewer', label: 'review #1' },
    { recipe: 'feature-pipeline', role: 'toString', label: 'review #1' },
    { recipe: 'feature-pipeline', role: 'setup', label: 'setup' },
    { recipe: 'feature-pipeline', role: 'reviewer', label: 'review #1', enabled: false },
  ]) assert.deepEqual(stageInstructions(input), { text: '', skills: [] });
  assert.throws(() => stageInstructions({ recipe: 'feature-pipeline', role: 'reviewer', label: 'review', enabled: 'false' }), /boolean/);
});

for (const mode of ['missing', 'modified', 'symlink', 'root symlink']) test(`required trusted files fail closed: ${mode}`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'stage-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'lib'));
  await copyFile(new URL('../lib/stage-skills.mjs', import.meta.url), path.join(root, 'lib/stage-skills.mjs'));
  await cp(new URL('../skills/', import.meta.url), path.join(root, 'skills'), { recursive: true });
  const file = path.join(root, 'skills/behavior-evidence/SKILL.md');
  const source = await readFile(file, 'utf8');
  if (mode === 'modified') await writeFile(file, `${source}\nInjected override.`);
  else if (mode === 'root symlink') {
    await cp(path.join(root, 'skills'), path.join(root, 'shadow'), { recursive: true });
    await rm(path.join(root, 'skills'), { recursive: true });
    await symlink(path.join(root, 'shadow'), path.join(root, 'skills'), 'dir');
  } else {
    await rm(file);
    if (mode === 'symlink') {
      await writeFile(path.join(root, 'shadow.md'), source);
      await symlink(path.join(root, 'shadow.md'), file);
    }
  }
  const isolated = await import(pathToFileURL(path.join(root, 'lib/stage-skills.mjs')).href);
  assert.throws(() => isolated.stageInstructions({ recipe: 'feature-pipeline', role: 'analysis', label: 'analysis' }));
  assert.deepEqual(isolated.stageInstructions({ recipe: 'feature-pipeline', role: 'analysis', label: 'analysis', enabled: false }), { text: '', skills: [] });
});
