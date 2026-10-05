// Build lib/client.js: inline card-model.mjs (ESM → plain function declarations) and card.css into
// src/client.src.js, then wrap it in the DSH module-loader envelope. No bundler needed.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RECIPES_DIR } from './lib/dsh-paths.mjs';
import { listApprovedRecipesSync, loadVerifiedRecipeSync } from './lib/recipe-catalog.mjs';
import { recipeSettingsCatalog } from './lib/recipe-flows.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(here, rel), 'utf8');

const model = read('lib/card-model.mjs').replace(/^export\s+(const|function|let)\s/gm, '$1 ');
if (/\bexport\b|\bimport\b/.test(model.replace(/\/\/.*$/gm, ''))) throw new Error('card-model.mjs must only use top-level `export const|function` (no imports)');
const decisionModel = read('lib/decision-model.mjs').replace(/^export\s+(const|function|let)\s/gm, '$1 ');
const css = read('src/card.css');
// Settings canvas data: approved, intact recipes only (same filter as the run_recipe catalog).
const recipeCatalog = recipeSettingsCatalog(Object.fromEntries(listApprovedRecipesSync(RECIPES_DIR).map(({ name }) => [name, loadVerifiedRecipeSync(name, RECIPES_DIR).meta])));
let src = read('src/client.src.js');
if (!src.includes('/*@@CARD_MODEL@@*/') || !src.includes('/*@@CSS@@*/')) throw new Error('client.src.js placeholders missing');
src = src.replace('/*@@CARD_MODEL@@*/', `// ── inlined from lib/card-model.mjs ──\n${model}\n${decisionModel}\n// ── end card-model ──`)
  .replace('/*@@SETTINGS@@*/', read('src/settings.src.js'))
  .replace('/*@@RECIPE_CATALOG@@*/', () => `var RECIPE_CATALOG_DATA = ${JSON.stringify(recipeCatalog)};`)
  .replace('/*@@CSS@@*/', `var CARD_CSS = ${JSON.stringify(css)};`);

const pkg = JSON.parse(read('package.json'));
const out = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
${src}
return module.exports; } });
`;
writeFileSync(path.join(here, 'lib/client.js'), out);
console.log(`built lib/client.js (${out.length} bytes, ${recipeCatalog.length} recipes from ${RECIPES_DIR})`);

// Package the canonical agent composition as a declarative 0.2 preset.
const agentRows = read('../../presets/auto-subagents/agent.cordis.yml');
// Blank lines inside YAML block scalars are part of the model instructions.
const preset = '- insert:\n    - id: preset-auto-subagents\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: auto-subagents\n        name: Auto Subagents\n        description: Coordinate work with approved recipes and model tiers.\n        order: 5\n        plugins:\n' + agentRows.trimEnd().split('\n').map(line => line.length ? '          ' + line : '').join('\n') + '\n';
writeFileSync(path.join(here, 'preset.patch.yml'), preset);
