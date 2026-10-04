import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchingQuestion, answerBatch, KEEP_DECISION } from '../lib/decision-model.mjs';
const qs=[{id:'q'}];
const pending={sessionId:'s',kind:'question',questions:[{id:'run:q'}],answer:async()=>{}};
test('historical cards cannot answer a newer or other-session question',()=>{
 assert.equal(matchingQuestion(pending,'s','run',qs),pending);
 for(const [sid,rid] of [['other','run'],['s','old-run']]) assert.equal(matchingQuestion(pending,sid,rid,qs),null);
 assert.equal(matchingQuestion(null,'s','run',qs),null);
});
test('all question answers required and sent via canonical answer batch',()=>{
 assert.throws(()=>answerBatch('run',qs,{}),/Missing answer/);
 assert.deepEqual(answerBatch('run',qs,{q:{choice:'__custom',custom:' yes '}}),{answers:[{id:'run:q',selected:[],custom:'yes'}]});
});

const decided=[{id:'d1',decision:'use utf-8'},{id:'d2',decision:'keep API'}];
const withExtras={...pending,questions:[{id:'run:q'},{id:'run:d1'}]};
test('pending batch may add optional override questions for decidedForYou ids only',()=>{
 assert.equal(matchingQuestion(withExtras,'s','run',qs,decided),withExtras);
 assert.equal(matchingQuestion(withExtras,'s','run',qs),null,'extras are rejected when the card knows no decidedForYou');
 assert.equal(matchingQuestion({...pending,questions:[{id:'run:q'},{id:'run:zzz'}]},'s','run',qs,decided),null,'unknown extra id');
 assert.equal(matchingQuestion({...pending,questions:[{id:'run:d1'}]},'s','run',qs,decided),null,'required id missing');
 assert.equal(matchingQuestion({...pending,questions:[{id:'run:q'},{id:'run:q'}]},'s','run',qs,decided),null,'duplicate ids');
 assert.equal(matchingQuestion({...pending,questions:[{id:'old:q'},{id:'run:q'}]},'s','run',qs,decided),null,'other-run ids');
});
test('answer batch answers every pending id; untouched overrides send the keep sentinel, never display text',()=>{
 const batch=answerBatch('run',qs,{q:{choice:'A'}},{pendingIds:['run:q','run:d1'],decidedForYou:decided});
 assert.deepEqual(batch,{answers:[{id:'run:q',selected:[],custom:'A'},{id:'run:d1',selected:[],custom:KEEP_DECISION}]});
 const overridden=answerBatch('run',qs,{q:{choice:'A'},d1:{choice:'__custom',custom:'latin-1'}},{pendingIds:['run:q','run:d1'],decidedForYou:decided});
 assert.equal(overridden.answers[1].custom,'latin-1');
 assert.throws(()=>answerBatch('run',qs,{q:{choice:'A'}},{pendingIds:['run:q','run:x'],decidedForYou:decided}),/Unexpected pending question/);
 assert.deepEqual(answerBatch('run',qs,{q:{choice:'A'}},{pendingIds:['run:q','run:d3'],decidedForYou:[{id:'d3',decision:''}]}).answers[1].custom,KEEP_DECISION);
 assert.throws(()=>answerBatch('run',qs,{q:{choice:KEEP_DECISION}}),/Missing answer/,'required question cannot be answered with the sentinel');
});
