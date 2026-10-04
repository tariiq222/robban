import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateResume } from '../lib/recipes.mjs';
const record = { version: 1, ownerSessionId: 's', recipe: 'feature-pipeline', task: 'T', repo: '/r', consumed: false, pendingQuestions: [{ id: 'q' }], confirmedDecisions: { old: 'kept' }, resume: { task: 'T', repo: '/r', round: 1 } };
const request = { recipe: 'feature-pipeline', task: 'T', repo: '/r', decisions: { q: 'yes' } };
test('resume requires same session, recipe, task and repository', () => {
 for (const change of [{ownerSessionId:'other'}, {recipe:'other'}, {task:'other'}, {repo:'/other'}]) assert.throws(() => validateResume({...record,...change},request,'s'), /does not belong/);
});
test('resume rejects unanswered, blank and non-string answers', () => {
 for (const decisions of [{}, {q:''}, {q:' '}, {q:42}]) assert.throws(() => validateResume(record,{...request,decisions},'s'), /answer/);
});
test('resume preserves prior answers and rejects replay', () => {
 const out = validateResume(record,request,'s');
 assert.deepEqual(out.decisions,{old:'kept',q:'yes'});
 assert.throws(()=>validateResume({...record,consumed:true},request,'s'), /already used/);
});
test('verified overrides of decidedForYou merge over earlier answers', () => {
 const out = validateResume({ ...record, overridable: ['d1'] }, { ...request, decisions: { q: 'yes', d1: 'B' } }, 's');
 assert.deepEqual(out.decisions, { old: 'kept', q: 'yes', d1: 'B' });
 assert.deepEqual(out.overridable, ['d1']);
});
