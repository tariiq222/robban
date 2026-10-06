import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledRoot = new URL('../skills/', import.meta.url);
const expected = Object.freeze({"behavior-evidence": "1b0031954402375fee1789a17a34c68bc525efb4932e85a1cdac6c137a25eaf9", "independent-review": "ed0f86282787d2334092597681cda3de804a5d484cd8f9bf991318a7419484b3", "design-dependencies": "a3ec4f3dfc8c39e5ed22ce79001fc691a761bd55c9e71dbe2772c41fcee740f8"});
const evidence = 'behavior-evidence', review = 'independent-review', design = 'design-dependencies';
const stages = {
  'feature-pipeline': { analysis: [evidence], requirements: [evidence], design: [design], designReview: [design, review], plan: [design], implementer: [evidence], reviewer: [evidence, review], validate: [evidence, review] },
  'bug-fix': { analysis: [evidence], implementer: [evidence], reviewer: [evidence, review], validate: [evidence, review] },
  refactor: { analysis: [evidence, design], baseline: [evidence], implementer: [evidence], reviewer: [evidence, review], validate: [evidence, review] },
  investigate: { 'investigator:gather': [evidence], 'investigation-checker:check': [evidence, review] },
  'code-audit': { 'audit-scanner:scan-security': [review], 'audit-scanner:scan-correctness': [review], 'audit-checker:verify': [evidence, review] },
  'qa-verify': { 'qa-verifier:analysis': [evidence], 'qa-verifier:verify': [evidence], 'qa-checker:check': [evidence, review] },
  'plan-to-packages': { 'plan-evidence:evidence': [evidence], 'planner:packages': [design], 'package-checker:check': [design, review] },
};

function readBundledSkill(name) {
  const directory = resolve(fileURLToPath(new URL(`${name}/`, bundledRoot)));
  const root = resolve(fileURLToPath(bundledRoot));
  const file = fileURLToPath(new URL(`${name}/SKILL.md`, bundledRoot));
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()
    || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()
    || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`Invalid bundled stage skill: ${name}`);
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected[name] || bytes.length > 2400) throw new Error(`Bundled stage skill integrity failed: ${name}`);
  const source = bytes.toString('utf8');
  if (!source.startsWith(`---\nname: ${name}\nversion: 1\n---\n`)) throw new Error(`Invalid bundled stage skill version: ${name}`);
  return { source, sha256 };
}

/**
 * Select trusted bundled method instructions for an authenticated recipe stage.
 * Phase permissions prevail; unknown stages have no added instructions and required files fail closed.
 * @param {{recipe?: string, role: string, label: string, enabled?: boolean}} input - Recipe identity, authenticated role/label and optional explicit disable.
 * @returns {{text: string, skills: Array<{name: string, sha256: string}>}} Bounded instructions and their content digests.
 */
export function stageInstructions({ recipe, role, label, enabled = true }) {
  if (typeof enabled !== 'boolean') throw new Error('Stage skills enabled must be boolean');
  if (!enabled || !Object.hasOwn(stages, recipe ?? '')) return { text: '', skills: [] };
  const table = stages[recipe];
  const base = typeof label === 'string' ? label.replace(/\s+#\d+$/, '') : '';
  const exactKey = `${role}:${base}`;
  const selected = Object.hasOwn(table, exactKey) ? table[exactKey] : Object.hasOwn(table, role) ? table[role] : [];
  if (selected.length > 2) throw new Error('Stage skills exceed per-child limit');
  const skills = [], parts = [];
  for (const name of selected) {
    const { source, sha256 } = readBundledSkill(name);
    skills.push({ name, sha256 });
    parts.push(`Trusted bundled method: ${name} (version 1, sha256 ${sha256})\n${source}`);
  }
  const text = parts.length ? `Stage methods supplement this task; phase scope, tool restrictions and output requirements prevail.\n\n${parts.join('\n\n')}` : '';
  if (text.length > 5200) throw new Error('Stage skill instructions exceed text limit');
  return { text, skills };
}
