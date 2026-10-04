import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listApprovedRecipesSync, loadVerifiedRecipeSync, renderCatalogForCoordinator } from '../lib/recipe-catalog.mjs';
import { runtimeModuleUrl } from '../lib/dsh-paths.mjs';
const { validateMeta } = await import(runtimeModuleUrl('@deepseek-ai/dsh-workflow-ptc'));
const names = ['bug-fix','code-audit','feature-pipeline','investigate','plan-to-packages','qa-verify','refactor'];
test('all seven saved recipes are intact approved discoverable and PTC metadata compatible',()=>{
 const catalog=listApprovedRecipesSync();assert.deepEqual(catalog.map(x=>x.name),names);
 for(const name of names){const {meta,script}=loadVerifiedRecipeSync(name);assert.ok(script.trim());assert.ok(meta.whenToUse?.trim());
 assert.doesNotThrow(()=>validateMeta({name:meta.name,description:meta.description,whenToUse:meta.whenToUse,phases:meta.phases}));}
 const guidance=renderCatalogForCoordinator(catalog);for(const name of names)assert.ok(guidance.includes(name));
});
